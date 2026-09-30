/**
 * agent loop 单测（ADR-003 D1）：用 fake routing 驱动，零网络零 LLM。
 * 覆盖：多轮工具调用链路、无工具直答、轮次上限截断、工具异常不炸 loop、
 * 未知工具与参数校验失败回 isError、trace 与事件流完整性。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Type } from '@sinclair/typebox'

import { runAgentLoop, defineAgentTool, type AgentLoopEvent, type AgentToolSpec } from '../src/agent-loop.ts'

// ---------------------------------------------------------------------------
// fake routing：脚本化每轮 LLM 返回（文本 + 工具调用），记录收到的上下文
// ---------------------------------------------------------------------------

interface FakeTurn {
  /** 本轮 assistant 文本 */
  text?: string
  /** 本轮要发起的工具调用 */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
}

function fakeRouting(script: FakeTurn[]) {
  const seenContexts: Array<{ systemPrompt?: string; messages: unknown[]; tools?: unknown[] }> = []
  let calls = 0
  return {
    seenContexts,
    streamRaw(_kind: 'ingest' | 'query', context: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] }) {
      const idx = calls++
      const turn = script[idx] ?? { text: '（脚本耗尽）' }
      async function* gen(): AsyncGenerator<{ type: string; delta?: string; message?: unknown }> {
        yield { type: 'text_delta', delta: turn.text ?? '' }
        yield {
          type: 'done',
          message: {
            role: 'assistant',
            content: [
              ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
              ...(turn.toolCalls ?? []).map((tc) => ({ type: 'toolCall', id: tc.id, name: tc.name, arguments: tc.arguments })),
            ],
            usage: { input: 10, output: 5 },
          },
        }
      }
      seenContexts.push({ ...context, messages: [...context.messages] })
      return gen()
    },
  }
}

const echoTool = defineAgentTool({
  name: 'echo',
  description: '回显输入',
  parameters: Type.Object({ word: Type.String() }),
  async execute({ word }) {
    return { content: `echo:${word}` }
  },
})

test('多轮工具调用：第 1 轮调工具，第 2 轮综合作答', async () => {
  const routing = fakeRouting([
    { text: '我先查一下', toolCalls: [{ id: 'c1', name: 'echo', arguments: { word: 'hello' } }] },
    { text: '工具返回了 echo:hello，这就是答案。' },
  ])
  const events: AgentLoopEvent[] = []
  const result = await runAgentLoop({
    systemPrompt: 'sys',
    userPrompt: '问题',
    tools: [echoTool],
    routing: routing as never,
    onEvent: (ev) => events.push(ev),
  })
  assert.equal(result.answer, '工具返回了 echo:hello，这就是答案。')
  assert.equal(result.turns, 2)
  assert.equal(result.steps, 1)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.tokens, { input: 20, output: 10 })
  assert.equal(result.trace[0]!.tool, 'echo')
  assert.equal(result.trace[0]!.resultPreview, 'echo:hello')

  // transcript：第 2 轮收到 user + assistant + toolResult 三条
  const ctx2 = routing.seenContexts[1]!
  assert.equal(ctx2.messages.length, 3)
  assert.equal((ctx2.messages[1] as { role: string }).role, 'assistant')
  assert.equal((ctx2.messages[2] as { role: string; toolCallId: string }).toolCallId, 'c1')
  // 工具声明传给了 LLM
  assert.equal((ctx2.tools as Array<{ name: string }>)[0]!.name, 'echo')

  // 事件流完整
  assert.ok(events.some((e) => e.type === 'agent:start'))
  assert.ok(events.some((e) => e.type === 'agent:tool_start' && e.name === 'echo'))
  assert.ok(events.some((e) => e.type === 'agent:tool_end' && !e.isError))
  assert.ok(events.some((e) => e.type === 'agent:done'))
})

test('无工具直答：单轮即结束', async () => {
  const routing = fakeRouting([{ text: '直接回答' }])
  const result = await runAgentLoop({ systemPrompt: 's', userPrompt: 'q', tools: [echoTool], routing: routing as never })
  assert.equal(result.answer, '直接回答')
  assert.equal(result.turns, 1)
  assert.equal(result.steps, 0)
  assert.equal(result.truncated, false)
})

test('轮次上限截断（围栏）', async () => {
  // 每轮都要求调工具，永远不给终答
  const script = Array.from({ length: 10 }, (_, i) => ({
    toolCalls: [{ id: `c${i}`, name: 'echo', arguments: { word: 'x' } }],
  }))
  const routing = fakeRouting(script)
  const result = await runAgentLoop({
    systemPrompt: 's',
    userPrompt: 'q',
    tools: [echoTool],
    routing: routing as never,
    maxTurns: 3,
  })
  assert.equal(result.truncated, true)
  assert.equal(result.turns, 3)
  assert.equal(result.steps, 3)
  assert.match(result.answer, /轮次上限/)
})

test('工具执行异常回 isError，loop 继续收敛', async () => {
  const badTool: AgentToolSpec = {
    name: 'bad',
    description: '炸',
    parameters: Type.Object({}),
    async execute() {
      throw new Error('boom')
    },
  }
  const routing = fakeRouting([
    { toolCalls: [{ id: 'c1', name: 'bad', arguments: {} }] },
    { text: '工具坏了，但我知道答案。' },
  ])
  const result = await runAgentLoop({ systemPrompt: 's', userPrompt: 'q', tools: [badTool], routing: routing as never })
  assert.equal(result.answer, '工具坏了，但我知道答案。')
  assert.equal(result.trace[0]!.isError, true)
  assert.match(result.trace[0]!.resultPreview, /boom/)
})

test('未知工具与参数校验失败都以 isError 回给模型', async () => {
  const routing = fakeRouting([
    {
      toolCalls: [
        { id: 'c1', name: 'nope', arguments: {} },
        { id: 'c2', name: 'echo', arguments: { wrong: 1 } },
      ],
    },
    { text: '两个都失败了' },
  ])
  const result = await runAgentLoop({ systemPrompt: 's', userPrompt: 'q', tools: [echoTool], routing: routing as never })
  assert.equal(result.steps, 2)
  assert.match(result.trace[0]!.resultPreview, /未知工具/)
  assert.match(result.trace[1]!.resultPreview, /参数校验失败/)
  // 模型第 2 轮收到了两条 isError 的 toolResult
  const ctx2 = routing.seenContexts[1]!
  const toolResults = ctx2.messages.filter((m) => (m as { role: string }).role === 'toolResult')
  assert.equal(toolResults.length, 2)
  assert.equal(toolResults.every((m) => (m as { isError: boolean }).isError === true), true)
})

test('一轮多个工具调用全部执行并回填', async () => {
  const routing = fakeRouting([
    {
      text: '两个都查',
      toolCalls: [
        { id: 'c1', name: 'echo', arguments: { word: 'a' } },
        { id: 'c2', name: 'echo', arguments: { word: 'b' } },
      ],
    },
    { text: 'a 和 b 都拿到了' },
  ])
  const result = await runAgentLoop({ systemPrompt: 's', userPrompt: 'q', tools: [echoTool], routing: routing as never })
  assert.equal(result.steps, 2)
  assert.equal(result.trace[1]!.resultPreview, 'echo:b')
  assert.equal(result.turns, 2)
})
