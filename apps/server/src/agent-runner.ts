/**
 * agent 任务运行器（定时唤醒子 Agent）。
 *
 * 与 digest（专用管线：Tavily → 证据页 → LLM 综合）不同：kind=agent 的任务把
 * 自由目标 prompt 交给完整 Agent loop——工具白名单（search_kb / read_page /
 * list_neighbors / web_search）+ 轮次围栏 + 上下文压缩 + workbench 全轨迹。
 *
 * 「搜不到内容换个 query 继续搜，直到达成目的」这类自适应行为不再针对日报
 * 硬编码，而是 loop 内模型 own 的策略：工具报错不 throw（isError 回给模型），
 * 模型自行换路重试。
 *
 * 围栏不变（ADR-002）：agent 只读库 + 联网；无人值守执行唯一的"写"出口是
 * 产物落 inbox/（bulletin）——要进 wiki 必须人工「消化进图谱」，不绕过人审闸门。
 * 便利贴 directive 照常注入（「周报重点写XX」由此生效）。
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import { renderLogEntry, serializePage } from '@ke/core'
import { runAgentLoop, type AgentLoopResult } from '@ke/agent-tools'
import { buildKbTools, loadSkillHints, renderSkillHints } from './agent-tools.ts'
import { beginTask, finishTask } from './workbench.ts'
import { activeDirectives, renderDirectives } from './bulletin.ts'
import { gitCommitAll } from './ingest-pipeline.ts'
import type { ScheduledTask } from '@ke/core'
import type { TaskRunner } from './scheduler.ts'

const AGENT_TASK_PROMPT = `你是知识引擎的定时值守 Agent，被调度器唤醒执行一项任务。你可以多步调用工具（库内检索/读页/图谱扩展/联网搜索）直到完成任务。

工作规则：
1. 这是无人值守运行，没有用户可以追问。工具报错或结果不佳时自行换路径重试（换检索词、换语言、放宽或缩小范围），尽力达成目标
2. 信息不足时如实说明缺什么，禁止编造
3. 最终交付一份结构化 Markdown 报告：开头一段综述，主体分节展开；库内主张用 [[页面名]] 标注出处，库外信息标注来源 URL
4. 若产出内容值得沉淀进知识库，在报告末尾给一条「建议消化」说明
5. 默认用中文（任务目标另行要求语言时除外）`

export interface AgentRunnerDeps {
  kbRoot: string
  dataRoot: string
  /** LLM 路由；未配置时任务报可读错误（agent 任务硬依赖 LLM，不像 digest 可降级快报） */
  routing?: {
    streamRaw(
      kind: 'ingest' | 'query',
      context: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] },
    ): AsyncIterable<{ type: string; delta?: string; message?: unknown }>
  }
  events?: EventEmitter
  /** 轮次上限（围栏；默认 12——无人值守可比问答的 8 轮更宽裕） */
  maxTurns?: number
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[\s/\\]+/g, '-')
      .replace(/[^\p{L}\p{N}-]/gu, '')
      .slice(0, 40) || 'agent'
  )
}

export function createAgentRunner(deps: AgentRunnerDeps): TaskRunner {
  const { kbRoot, dataRoot } = deps
  return async (task: ScheduledTask, ctx) => {
    if (!deps.routing) throw new Error('LLM 未配置：agent 任务需要完整模型能力，请到「设置」页配置后再运行')
    const routing = deps.routing
    const prompt = task.prompt?.trim()
    if (!prompt) throw new Error('agent 任务缺少 prompt（任务目标）——请删除重建并填写目标')

    const events = deps.events ?? new EventEmitter()
    const tools = await buildKbTools({ kbRoot, dataRoot })
    const skillSuffix = renderSkillHints(await loadSkillHints(kbRoot))
    // D10-11：任务前注入 open 未过期 directive（「周报重点写 XX」由此生效）
    const directiveText = renderDirectives(await activeDirectives(kbRoot))

    const userPrompt = [
      `任务标题：${task.title}`,
      `任务目标：${prompt}`,
      directiveText ? `\n用户指令（优先服从）：\n${directiveText}` : '',
      ctx.manual ? '（本次为手动触发）' : `（定时唤醒 ${new Date().toISOString()}）`,
    ]
      .filter(Boolean)
      .join('\n')

    // workbench 轨迹（复用问答 agent 的落盘机制；崩溃留 running 态，结束覆写终态）
    const startedAt = new Date().toISOString()
    const taskId = await beginTask(dataRoot, { question: `[定时] ${task.title}`, toolCount: tools.length })

    let result: AgentLoopResult
    try {
      result = await runAgentLoop({
        systemPrompt: AGENT_TASK_PROMPT + skillSuffix,
        userPrompt,
        tools,
        routing,
        maxTurns: deps.maxTurns ?? 12,
        onEvent: (ev) => events.emit(ev.type, ev),
      })
    } catch (e) {
      await finishTask(dataRoot, taskId, {
        status: 'error',
        question: `[定时] ${task.title}`,
        toolCount: tools.length,
        startedAt,
        trace: [],
        answer: '',
        turns: 0,
        steps: 0,
        truncated: false,
        tokens: null,
        error: (e as Error).message,
      }).catch(() => {})
      throw e
    }

    // ---------- 产物：inbox/agent-<date>-<slug>.md（收件箱视图消费；幂等覆盖） ----------
    const date = new Date().toISOString().slice(0, 10)
    const rel = `inbox/agent-${date}-${slugify(task.title)}.md`
    const fm = {
      type: 'bulletin' as const,
      task: task.id,
      taskTitle: task.title,
      topic: task.topic,
      generatedAt: new Date().toISOString(),
      mode: ctx.manual ? 'manual' : 'scheduled',
      runner: 'agent' as const,
      turns: result.turns,
      steps: result.steps,
      truncated: result.truncated,
      digested: false,
      digestOutcome: 'agent 报告无独立证据页，如需入库请把内容存为素材后导入',
    }
    const toolSummary =
      result.trace.map((s) => `${s.tool}${s.isError ? '!' : ''}`).join(' → ') || '（无工具调用）'
    const body = [
      `# ${task.title} · ${date}`,
      '',
      ctx.manual ? '> 手动触发 · Agent 值守执行' : '> 定时唤醒 · Agent 值守执行',
      '',
      result.answer || '（Agent 未产出正文——见工作台轨迹排查）',
      '',
      '---',
      '',
      `执行轨迹：${result.turns} 轮 / ${result.steps} 步 · 工具链 \`${toolSummary.slice(0, 200)}\` · tokens ${result.tokens.input}+${result.tokens.output}`,
      '',
    ].join('\n')
    await mkdir(path.join(kbRoot, 'inbox'), { recursive: true })
    await writeFile(path.join(kbRoot, rel), serializePage(fm, `\n${body}\n`), 'utf8')

    // workbench 终态 + log 流水 + git 留痕
    await finishTask(dataRoot, taskId, {
      status: 'done',
      question: `[定时] ${task.title}`,
      toolCount: tools.length,
      startedAt,
      trace: result.trace,
      answer: result.answer,
      turns: result.turns,
      steps: result.steps,
      truncated: result.truncated,
      tokens: result.tokens,
    }).catch(() => {})
    await appendFile(
      path.join(kbRoot, 'log.md'),
      renderLogEntry('task', `${task.title} [agent ${result.turns}轮${result.steps}步${result.truncated ? ' 截断' : ''}: ${toolSummary.slice(0, 80)}]`),
      'utf8',
    ).catch(() => {})
    await gitCommitAll(kbRoot, `task(agent): ${task.title} ${date}${ctx.manual ? '（手动）' : ''}`)

    return {
      note: `agent ${result.turns} 轮 ${result.steps} 步${result.truncated ? '（轮次截断）' : ''}`,
      artifact: rel,
    }
  }
}
