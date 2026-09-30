/**
 * workbench 任务追踪最小版（ADR-003 §3.4 / D12）。
 *
 * agent 任务（本期 agent-query）的轨迹序列化为 data/tasks/<taskId>.md：
 * frontmatter（taskId / kind / status / startedAt / finishedAt / question /
 * turns / steps / truncated / tokens），正文按四节结构化落盘——
 *   1. 背景与目标：任务输入与可用工具
 *   2. 探索链路：只读检索的每一步（工具、参数、命中预览、耗时）
 *   3. 执行链路：写操作与闸门结果（agent 围栏只读，本期占位说明）
 *   4. 结果与迭代：最终回答与迭代统计
 * 落盘即留痕（running 中间态也写——进程崩溃后能看到死在哪一步）；
 * 未来这些记录可作为「项目经验」被 ingest 消化（ADR-003 设想 #7/#8 远期）。
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { parsePage, serializePage } from '@ke/core'
import type { AgentLoopTraceStep } from '@ke/agent-tools'

export interface WorkbenchTaskMeta {
  taskId: string
  kind: 'agent-query'
  /** running（进行中留痕）| done | error */
  status: 'running' | 'done' | 'error'
  question: string
  startedAt: string
  finishedAt: string | null
  turns: number
  steps: number
  truncated: boolean
  tokens: { input: number; output: number } | null
  toolCount: number
}

export interface WorkbenchTask extends WorkbenchTaskMeta {
  /** 四节正文（Markdown） */
  body: string
}

function tasksDir(dataRoot: string): string {
  return path.join(dataRoot, 'tasks')
}

function taskFile(dataRoot: string, taskId: string): string {
  return path.join(tasksDir(dataRoot), `${taskId}.md`)
}

/** 只读探索工具（进「探索链路」节）；其余视为执行类（进「执行链路」节） */
const READ_ONLY_TOOLS = new Set(['search_kb', 'read_page', 'list_neighbors', 'web_search'])

function fmToMeta(fm: Record<string, unknown>, body: string, taskId: string): WorkbenchTask | null {
  const kind = fm['kind']
  if (kind !== 'agent-query') return null
  const status = fm['status']
  return {
    taskId,
    kind,
    status: status === 'done' || status === 'error' || status === 'running' ? status : 'running',
    question: (fm['question'] as string) ?? '',
    startedAt: (fm['started_at'] as string) ?? '',
    finishedAt: (fm['finished_at'] as string) ?? null,
    turns: Number(fm['turns'] ?? 0) || 0,
    steps: Number(fm['steps'] ?? 0) || 0,
    truncated: fm['truncated'] === true,
    tokens: (fm['tokens'] as { input: number; output: number } | undefined) ?? null,
    toolCount: Number(fm['tool_count'] ?? 0) || 0,
    body,
  }
}

/** 任务开始：写 running 态（崩溃留痕——看板能看到卡在哪） */
export async function beginTask(
  dataRoot: string,
  input: { question: string; toolCount: number },
): Promise<string> {
  const taskId = `tq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
  const fm: Record<string, unknown> = {
    task_id: taskId,
    kind: 'agent-query',
    status: 'running',
    question: input.question.slice(0, 200),
    started_at: new Date().toISOString(),
    tool_count: input.toolCount,
  }
  await mkdir(tasksDir(dataRoot), { recursive: true })
  await writeFile(taskFile(dataRoot, taskId), serializePage(fm, renderBody(input.question, input.toolCount, [], '', null)), 'utf8')
  return taskId
}

/** 任务结束：写完整四节 + 终态 */
export async function finishTask(
  dataRoot: string,
  taskId: string,
  result: {
    status: 'done' | 'error'
    question: string
    toolCount: number
    startedAt: string
    trace: AgentLoopTraceStep[]
    answer: string
    turns: number
    steps: number
    truncated: boolean
    tokens: { input: number; output: number } | null
    error?: string
  },
): Promise<WorkbenchTask> {
  const fm: Record<string, unknown> = {
    task_id: taskId,
    kind: 'agent-query',
    status: result.status,
    question: result.question.slice(0, 200),
    started_at: result.startedAt,
    finished_at: new Date().toISOString(),
    tool_count: result.toolCount,
    turns: result.turns,
    steps: result.steps,
    truncated: result.truncated,
  }
  if (result.tokens) fm['tokens'] = result.tokens
  const body = renderBody(result.question, result.toolCount, result.trace, result.answer, result.tokens, result.error)
  await mkdir(tasksDir(dataRoot), { recursive: true })
  await writeFile(taskFile(dataRoot, taskId), serializePage(fm, body), 'utf8')
  return { taskId, kind: 'agent-query', status: result.status, question: result.question, startedAt: result.startedAt, finishedAt: (fm['finished_at'] as string), turns: result.turns, steps: result.steps, truncated: result.truncated, tokens: result.tokens, toolCount: result.toolCount, body }
}

/** 列表（新在前）：只读 frontmatter（body 不返回，列表轻量） */
export async function listTasks(dataRoot: string): Promise<WorkbenchTaskMeta[]> {
  let names: string[] = []
  try {
    names = await readdir(tasksDir(dataRoot))
  } catch {
    return []
  }
  const out: WorkbenchTaskMeta[] = []
  for (const name of names.filter((n) => n.endsWith('.md')).sort().reverse()) {
    try {
      const { fm, body } = parsePage(await readFile(taskFile(dataRoot, name.replace(/\.md$/, '')), 'utf8'))
      const t = fmToMeta(fm, body, name.replace(/\.md$/, ''))
      if (t) out.push(t)
    } catch { /* 跳过读不了的文件 */ }
  }
  return out
}

/** 详情（含四节正文） */
export async function readTask(dataRoot: string, taskId: string): Promise<WorkbenchTask | null> {
  if (!/^[a-zA-Z0-9-]+$/.test(taskId)) throw new Error('非法任务 ID')
  try {
    const { fm, body } = parsePage(await readFile(taskFile(dataRoot, taskId), 'utf8'))
    return fmToMeta(fm, body, taskId)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 四节正文渲染
// ---------------------------------------------------------------------------

function renderBody(
  question: string,
  toolCount: number,
  trace: AgentLoopTraceStep[],
  answer: string,
  tokens: { input: number; output: number } | null,
  error?: string,
): string {
  const explore = trace.filter((s) => READ_ONLY_TOOLS.has(s.tool))
  const exec = trace.filter((s) => !READ_ONLY_TOOLS.has(s.tool))

  const lines: string[] = []
  lines.push('## 背景与目标', '', `任务类型：agent 多步问答 · 可用工具 ${toolCount} 个`, '', `> ${question}`, '')

  lines.push('## 探索链路', '')
  if (explore.length === 0) {
    lines.push('（无只读检索步骤——模型直接作答）', '')
  } else {
    explore.forEach((s, i) => {
      lines.push(
        `${i + 1}. \`${s.tool}\`${s.isError ? ' ⚠️' : ''} · ${s.ms}ms`,
        `   - 参数：\`${JSON.stringify(s.args)}\``,
        `   - ${s.isError ? '失败' : '命中'}：${s.resultPreview}`,
      )
    })
    lines.push('')
  }

  lines.push('## 执行链路', '')
  if (exec.length === 0) {
    lines.push('（本任务未产生写操作——agent 围栏阶段 A：工具白名单全部只读，写操作一律走审核闸门）', '')
  } else {
    exec.forEach((s, i) => {
      lines.push(`${i + 1}. \`${s.tool}\`${s.isError ? ' ⚠️ 失败' : ' ✅'} · ${s.ms}ms — ${s.resultPreview}`)
    })
    lines.push('')
  }

  lines.push('## 结果与迭代', '')
  if (error) {
    lines.push(`❌ 任务失败：${error}`, '')
  }
  if (answer.trim()) {
    lines.push(answer.trim(), '')
  }
  const stats = [
    `轮数 ${explore.length + exec.length > 0 ? '见上' : '1'}（trace 步数 ${trace.length}）`,
    tokens ? `token in/out ${tokens.input}/${tokens.output}` : null,
  ].filter(Boolean)
  lines.push('---', '', stats.join(' · '), '')
  return `\n${lines.join('\n')}\n`
}
