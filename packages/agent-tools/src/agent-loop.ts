/**
 * 通用 agent loop（ADR-003 D1，ARCHITECTURE「阶段 A · ToolCall 检索工具化」）。
 *
 * 设计立场：
 * - 轻量自研循环，不引 pi-agent-core 的 Agent 类——我们已有 RPM 门控、双路由与
 *   SimpleMessage 适配层（pi-adapter.ts），套 Agent 会重复一半状态管理；
 *   compaction 等能力按 ADR-003 D13 再评估接入点
 * - 工具用 TypeBox 定义参数 schema（与闸门校验链同一体系），结构上兼容 pi-ai 的 Tool
 * - 围栏（ADR-002 阶段 A）：步数上限 + 工具白名单（只传声明的工具）+ 全程 trace 留痕
 * - execute 不 throw：错误以 isError 结果回给模型，让模型自行决定重试或换路
 */
import { Value } from '@sinclair/typebox/value'
import type { Static, TSchema } from '@sinclair/typebox'

// pi-agent-core compaction 纯函数复用（ADR-003 D6/D13）：阈值决策与文本序列化。
// 摘要生成不走 pi 的 Models/Context 重依赖，而是走我们自己的 routing 边界
// （compactWithRequest 的 caller-owned request 思想）。
import {
  shouldCompact,
  estimateTokens,
  serializeConversation,
  DEFAULT_COMPACTION_SETTINGS,
} from '@earendil-works/pi-agent-core'

/** 工具执行结果（回给模型的内容） */
export interface AgentToolOutput {
  content: string
  isError?: boolean
}

/** 工具规格：name/description/parameters 兼容 pi-ai Tool，execute 是我们的扩展。
 *  默认参 TParams = any：声明侧经 defineAgentTool 拿到具体 Static<TParams> 强类型，
 *  数组/接口位置（AgentToolSpec[]）退化为 any 参数双变兼容——TSchema 在参数位逆变，
 *  单签名无法同时满足两处 */
export interface AgentToolSpec<TParams extends TSchema = any> {
  name: string
  description: string
  /** JSON Schema 参数定义（TypeBox） */
  parameters: TParams
  execute: (params: Static<TParams>) => Promise<AgentToolOutput>
}

/** 定义工具（泛型在此固化，声明侧拿到具体参数类型） */
export function defineAgentTool<TParams extends TSchema>(
  spec: AgentToolSpec<TParams>,
): AgentToolSpec<TParams> {
  return spec
}

/** 事件流（server 侧转发到 bus → SSE；也用于 e2e 断言） */
export type AgentLoopEvent =
  | { type: 'agent:start'; question: string; toolCount: number }
  | { type: 'agent:text_delta'; delta: string }
  | { type: 'agent:turn_start'; turn: number }
  | { type: 'agent:tool_start'; name: string; args: Record<string, unknown> }
  | { type: 'agent:tool_end'; name: string; ms: number; isError: boolean; preview: string }
  | { type: 'agent:compacted'; tokensBefore: number; tokensAfter: number; keptMessages: number }
  | { type: 'agent:done'; turns: number; steps: number; truncated: boolean; tokens: { input: number; output: number } }
  | { type: 'agent:error'; message: string }

export interface AgentLoopTraceStep {
  tool: string
  args: Record<string, unknown>
  /** 结果预览（截断，用于 workbench / log 留痕，不进上下文） */
  resultPreview: string
  isError: boolean
  ms: number
}

/** 一次上下文压缩的留痕 */
export interface AgentCompactionRecord {
  tokensBefore: number
  tokensAfter: number
}

export interface AgentLoopResult {
  answer: string
  /** LLM 轮数（每轮 = 一次流式调用，可能含多个工具调用） */
  turns: number
  /** 工具执行总次数 */
  steps: number
  /** 达到轮次上限被截断（结果不可信，UI 应提示） */
  truncated: boolean
  tokens: { input: number; output: number }
  trace: AgentLoopTraceStep[]
  /** 上下文压缩记录（ADR-003 §3.5；空 = 从未触发） */
  compactions: AgentCompactionRecord[]
}

/** loop 依赖的最小 routing 接口（pi-adapter 的 streamRaw 满足；测试用 fake） */
export interface AgentLoopRouting {
  streamRaw(
    kind: 'ingest' | 'query',
    context: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] },
  ): AsyncIterable<{ type: string; delta?: string; message?: unknown }>
}

export interface AgentLoopOptions {
  systemPrompt: string
  userPrompt: string
  tools: AgentToolSpec[]
  routing: AgentLoopRouting
  /** 轮次上限（围栏），默认 8 */
  maxTurns?: number
  /** 模型上下文窗口（token）——压缩阈值判定用；默认 128k（保守值，不知道实际窗口时） */
  contextWindow?: number
  /** 压缩设置（ADR-003 §3.5；缺省用 pi DEFAULT_COMPACTION_SETTINGS） */
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number }
  onEvent?: (ev: AgentLoopEvent) => void
}

const PREVIEW_LEN = 200

function preview(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > PREVIEW_LEN ? `${t.slice(0, PREVIEW_LEN)}…` : t
}

/** 从 done 事件的 message 里取权威内容（文本与工具调用），比流式累积更可靠 */
function extractContent(message: unknown): {
  text: string
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  usage: { input: number; output: number } | null
} {
  const m = message as
    | { content?: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>; usage?: { input?: number; output?: number } }
    | undefined
  const text: string[] = []
  const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []
  for (const c of m?.content ?? []) {
    if (c.type === 'text' && typeof c.text === 'string') text.push(c.text)
    if (c.type === 'toolCall' && typeof c.id === 'string' && typeof c.name === 'string') {
      toolCalls.push({ id: c.id, name: c.name, arguments: (c.arguments ?? {}) as Record<string, unknown> })
    }
  }
  const u = m?.usage
  return {
    text: text.join(''),
    toolCalls,
    usage: u ? { input: u.input ?? 0, output: u.output ?? 0 } : null,
  }
}

/** 跑一轮 agent loop：检索-工具-综合，直到模型不再调工具或达上限 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const { systemPrompt, userPrompt, tools, routing } = opts
  const maxTurns = opts.maxTurns ?? 8
  const contextWindow = opts.contextWindow ?? 128_000
  const compactionSettings = {
    ...DEFAULT_COMPACTION_SETTINGS,
    ...(opts.compaction ?? {}),
  }
  const emit = (ev: AgentLoopEvent) => opts.onEvent?.(ev)

  const byName = new Map(tools.map((t) => [t.name, t]))
  const toolDecls = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))

  const transcript: unknown[] = [{ role: 'user', content: userPrompt, timestamp: Date.now() }]
  const trace: AgentLoopTraceStep[] = []
  const compactions: AgentCompactionRecord[] = []
  const tokens = { input: 0, output: 0 }
  let answer = ''
  let turns = 0
  let steps = 0
  let truncated = false

  emit({ type: 'agent:start', question: userPrompt.slice(0, 120), toolCount: tools.length })

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      turns = turn + 1
      emit({ type: 'agent:turn_start', turn })

      let text = ''
      let toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []
      let assistantMessage: unknown = null
      for await (const ev of routing.streamRaw('query', { systemPrompt, messages: transcript, tools: toolDecls })) {
        if (ev.type === 'text_delta' && typeof ev.delta === 'string') {
          emit({ type: 'agent:text_delta', delta: ev.delta })
        }
        if (ev.type === 'done') {
          assistantMessage = ev.message
          const c = extractContent(ev.message)
          text = c.text
          toolCalls = c.toolCalls
          if (c.usage) {
            tokens.input += c.usage.input
            tokens.output += c.usage.output
          }
        }
      }

      // 无工具调用 → 本轮文本即最终答案
      if (toolCalls.length === 0) {
        answer = text
        break
      }

      // 中间轮的文本（如「我先查一下…」）保留进 transcript；assistant 消息必须是
      // 完整运行时对象（pi Message 判别联合），直接复用 done 的 message
      transcript.push(assistantMessage)
      if (text.trim()) answer = text

      for (const tc of toolCalls) {
        steps++
        emit({ type: 'agent:tool_start', name: tc.name, args: tc.arguments })
        const t0 = Date.now()
        const tool = byName.get(tc.name)
        let out: AgentToolOutput
        if (!tool) {
          out = { content: `未知工具：${tc.name}（可用：${[...byName.keys()].join(', ')}）`, isError: true }
        } else if (!Value.Check(tool.parameters, tc.arguments)) {
          const firstErr = [...Value.Errors(tool.parameters, tc.arguments)][0]
          out = { content: `参数校验失败：${tc.name} ${firstErr?.path ?? ''} ${firstErr?.message ?? 'schema 不匹配'}`, isError: true }
        } else {
          try {
            out = await tool.execute(tc.arguments)
          } catch (e) {
            out = { content: `工具执行异常：${(e as Error).message}`, isError: true }
          }
        }
        const ms = Date.now() - t0
        const step: AgentLoopTraceStep = {
          tool: tc.name,
          args: tc.arguments,
          resultPreview: preview(out.content),
          isError: out.isError ?? false,
          ms,
        }
        trace.push(step)
        emit({ type: 'agent:tool_end', name: tc.name, ms, isError: step.isError, preview: step.resultPreview })

        // toolResult 消息（pi 结构：content 数组 + isError 标记）
        transcript.push({
          role: 'toolResult',
          toolCallId: tc.id,
          toolName: tc.name,
          content: [{ type: 'text', text: out.content }],
          isError: out.isError ?? false,
          timestamp: Date.now(),
        })
      }

      // 每轮工具调用后检查上下文预算（ADR-003 §3.5）：超阈值 → 压缩旧史为摘要 + 保留近期原文
      if (compactionSettings.enabled) {
        const contextTokens = estimateContext(transcript)
        if (shouldCompact(contextTokens, contextWindow, compactionSettings)) {
          const before = contextTokens
          const done = await compactTranscript(transcript, routing, compactionSettings.keepRecentTokens)
          const after = estimateContext(transcript)
          compactions.push({ tokensBefore: before, tokensAfter: after })
          emit({ type: 'agent:compacted', tokensBefore: before, tokensAfter: after, keptMessages: done })
        }
      }

      // 轮次用尽仍有工具调用 → 截断（围栏生效）
      if (turn === maxTurns - 1) {
        truncated = true
        answer = `${answer.trim() ? `${answer.trim()}\n\n` : ''}（已达工具轮次上限 ${maxTurns}，回答可能不完整）`
      }
    }
  } catch (e) {
    const message = (e as Error).message
    emit({ type: 'agent:error', message })
    throw e
  }

  const result: AgentLoopResult = { answer: answer.trim(), turns, steps, truncated, tokens, trace, compactions }
  emit({ type: 'agent:done', turns, steps, truncated, tokens })
  return result
}

// ---------------------------------------------------------------------------
// 上下文压缩（ADR-003 §3.5）：复用 pi-agent-core 纯函数 + 自有 routing 摘要边界
// ---------------------------------------------------------------------------

/** transcript 全量 token 估算（pi 启发式：字符/4，assistant 按 content 分块计） */
function estimateContext(messages: unknown[]): number {
  let total = 0
  for (const m of messages) total += estimateTokens(m as never)
  return total
}

const COMPACTION_SYSTEM_PROMPT =
  'You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary. Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.'

const COMPACTION_USER_PROMPT = `以下是一段需要压缩的 agent 对话史（问题、检索与工具调用）。生成结构化检查点摘要，供下一个 LLM 继续工作。必须保留：
1. 用户的原始问题与已确认的约束
2. 已完成的检索步骤及其关键命中（结论，不是原文）
3. 尚未完成的方向与下一步计划
只输出摘要本身。`

/** 压缩 transcript：旧史 → LLM 摘要消息 + 近期原文。返回保留的消息数。失败时原样不动（围栏：压缩不能杀死任务） */
async function compactTranscript(
  transcript: unknown[],
  routing: AgentLoopRouting,
  keepRecentTokens: number,
): Promise<number> {
  // 从尾部保留消息直到近期预算用完（至少保留最后一条 toolResult，避免破坏在途轮次）
  const kept: unknown[] = []
  let keptTokens = 0
  let cut = transcript.length
  while (cut > 0 && (kept.length === 0 || keptTokens < keepRecentTokens)) {
    cut--
    const m = transcript[cut]!
    kept.unshift(m)
    keptTokens += estimateTokens(m as never)
  }
  const oldPart = transcript.slice(0, cut)
  if (oldPart.length === 0) return transcript.length

  // 旧史序列化（复用 pi serializeConversation）→ 走 routing 生成摘要
  const serialized = serializeConversation(oldPart as never)
  let summary = ''
  try {
    for await (const ev of routing.streamRaw('query', {
      systemPrompt: COMPACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `${COMPACTION_USER_PROMPT}\n\n---\n${serialized}` }],
    })) {
      if (ev.type === 'text_delta' && typeof ev.delta === 'string') summary += ev.delta
    }
  } catch {
    return transcript.length // 摘要失败：不压缩比压坏强
  }
  if (!summary.trim()) return transcript.length

  const summaryMsg = {
    role: 'user',
    content: `[上下文压缩] 以下是此前对话的结构化摘要（原文已折叠，请基于摘要与后续原文继续任务）：\n\n${summary.trim()}`,
    timestamp: Date.now(),
  }
  transcript.length = 0
  transcript.push(summaryMsg, ...kept)
  return kept.length
}
