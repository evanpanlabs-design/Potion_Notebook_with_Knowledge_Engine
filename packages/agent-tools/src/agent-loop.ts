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
  const emit = (ev: AgentLoopEvent) => opts.onEvent?.(ev)

  const byName = new Map(tools.map((t) => [t.name, t]))
  const toolDecls = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))

  const transcript: unknown[] = [{ role: 'user', content: userPrompt, timestamp: Date.now() }]
  const trace: AgentLoopTraceStep[] = []
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

  const result: AgentLoopResult = { answer: answer.trim(), turns, steps, truncated, tokens, trace }
  emit({ type: 'agent:done', turns, steps, truncated, tokens })
  return result
}
