/**
 * Agent 问答管道（ADR-003 D1）：提问球的多步检索-综合模式。
 *
 * 与 answerQuery（确定性单轮管道）并存：本管道让 query 模型按需调用只读工具
 * （search_kb / read_page / list_neighbors / web_search），多步探索后综合回答。
 * 围栏：工具白名单 + 轮次上限 + 全程 trace 留痕（log.md + 返回体）。
 */
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import { scanKb, parsePage, renderLogEntry } from '@ke/core'
import { runAgentLoop, type AgentLoopResult, type AgentToolSpec } from '@ke/agent-tools'
import { buildKbTools, loadSkillHints, renderSkillHints } from './agent-tools.ts'
import { beginTask, finishTask } from './workbench.ts'

export interface AgentQueryDeps {
  kbRoot: string
  dataRoot: string
  routing: {
    streamRaw(
      kind: 'ingest' | 'query',
      context: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] },
    ): AsyncIterable<{ type: string; delta?: string; message?: unknown }>
  }
  events?: EventEmitter
}

export interface AgentQueryOutcome extends AgentLoopResult {
  question: string
}

const AGENT_PROMPT = `你是知识库研究助手，可以调用工具多步检索后回答问题。工作规则：

1. 先用 search_kb 检索库内相关页面；命中不足时可用 list_neighbors 顺藤摸瓜，或用 read_page 读整页细看
2. 库内资料不足以回答且 web_search 可用时，可以联网搜索补充（明确标注哪些信息来自库外）
3. 回答中的库内主张用 [[页面名]] 标注出处；库外信息标注来源 URL
4. 库内与联网都无依据时必须明说，禁止编造
5. 工具调用要有节制：通常 2-6 步足够；信息够了就直接作答，不要为调而调
6. 回答用与问题相同的语言，简洁直接，Markdown 格式`

/** Agent 多步问答主入口：轨迹同步序列化到 data/tasks/<taskId>.md（ADR-003 §3.4 workbench） */
export async function answerWithAgent(deps: AgentQueryDeps, question: string): Promise<AgentQueryOutcome> {
  const { kbRoot, dataRoot, routing } = deps
  const events = deps.events ?? new EventEmitter()
  const tools: AgentToolSpec[] = await buildKbTools({ kbRoot, dataRoot })
  const startedAt = new Date().toISOString()
  // skills/ 只读扫描（D13 stretch）：启动级 name/description 注入 system prompt
  const skillSuffix = renderSkillHints(await loadSkillHints(kbRoot))
  // 任务开始即落 running 态（崩溃留痕）；结束后覆写终态
  const taskId = await beginTask(dataRoot, { question, toolCount: tools.length })

  let result: AgentLoopResult
  try {
    result = await runAgentLoop({
      systemPrompt: AGENT_PROMPT + skillSuffix,
      userPrompt: question,
      tools,
      routing,
      maxTurns: 8,
      onEvent: (ev) => events.emit(ev.type, ev),
    })
  } catch (e) {
    // 失败也留完整轨迹（探索到哪一步、错误是什么）
    await finishTask(dataRoot, taskId, {
      status: 'error',
      question,
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

  // 引用归一化：agent 产出的 [[页面名]] 补 path（复用 query 管线同款策略）
  const answer = await normalizeCitations(kbRoot, question, result.answer)

  // log 留痕（围栏要求：每次 agent 任务留操作流水）
  const toolSummary = result.trace.map((s) => `${s.tool}${s.isError ? '!' : ''}`).join(' → ') || '（无工具调用）'
  await appendFile(
    path.join(kbRoot, 'log.md'),
    renderLogEntry('query', `${question.slice(0, 40)} [agent ${result.turns}轮${result.steps}步: ${toolSummary.slice(0, 80)}]`),
    'utf8',
  )

  // workbench 终态落盘（失败不阻塞回答返回）
  await finishTask(dataRoot, taskId, {
    status: 'done',
    question,
    toolCount: tools.length,
    startedAt,
    trace: result.trace,
    answer,
    turns: result.turns,
    steps: result.steps,
    truncated: result.truncated,
    tokens: result.tokens,
  }).catch(() => {})

  return { question, ...result, answer }
}

/** [[页面名]] → [[页面名]](path)（标题索引建一次；模型不带 path 时补上，与 query 管线行为一致） */
async function normalizeCitations(kbRoot: string, question: string, answer: string): Promise<string> {
  if (!answer.includes('[[')) return answer
  const snap = await scanKb(kbRoot)
  const titleToPath = new Map<string, string>()
  for (const p of snap.pages) {
    try {
      const { fm } = parsePage(await readFile(path.join(kbRoot, p), 'utf8'))
      const title = (fm['title'] as string) ?? p
      if (!titleToPath.has(title)) titleToPath.set(title, p)
    } catch { /* 跳过读不了的页 */ }
  }
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let out = answer
  for (const title of [...titleToPath.keys()].sort((a, b) => b.length - a.length)) {
    const canon = `[[${title}]](${titleToPath.get(title)})`
    out = out.replace(new RegExp(`\\[\\[${esc(title)}\\]\\](?!\\()`, 'g'), canon)
  }
  void question
  return out
}
