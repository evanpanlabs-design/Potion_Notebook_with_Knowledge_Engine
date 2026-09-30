import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Type } from '@sinclair/typebox'

import { runAgentLoop, defineAgentTool, type AgentLoopEvent } from '../src/agent-loop.ts'

// ---------------------------------------------------------------------------
// fake routing：脚本化每轮返回 + 记录请求上下文（压缩摘要请求也走 streamRaw，
// 用 systemPrompt 区分主对话与压缩请求）
// ---------------------------------------------------------------------------

interface FakeTurn {
  text?: string
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
}

function fakeRouting(script: FakeTurn[], summaryText = '【摘要】用户问 X；已检索 A/B；下一步综合。') {
  const seenContexts: Array<{ systemPrompt?: string; messages: unknown[]; tools?: unknown[] }> = []
  let calls = 0
  return {
    seenContexts,
    streamRaw(_kind: 'ingest' | 'query', context: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] }) {
      const isSummaryReq = /summarization assistant/.test(context.systemPrompt ?? '')
      const turn = isSummaryReq
        ? { text: summaryText } // 摘要请求不消耗主对话脚本索引
        : (script[calls++] ?? { text: '（脚本耗尽）' })
      seenContexts.push(context)
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
            usage: { input: 100, output: 20 },
          },
        }
      }
      return gen()
    },
  }
}

const bigTool = defineAgentTool({
  name: 'big',
  description: '返回大结果',
  parameters: Type.Object({}),
  // ~4000 token 的工具结果（字符/4 估算）
  execute: async () => ({ content: 'x'.repeat(16_000) }),
})

const echoTool = defineAgentTool({
  name: 'echo',
  description: '回显',
  parameters: Type.Object({ v: Type.String() }),
  execute: async (p) => ({ content: `echo:${p.v}` }),
})

test('compaction：超阈值触发——旧史折叠为摘要 + 近期原文保留 + 事件留痕', async () => {
  // 脚本：每轮调一次 big（每次 +4000 token），第 3 轮后总量超阈值触发压缩；第 4 轮直答
  const routing = fakeRouting([
    { toolCalls: [{ id: 'c1', name: 'big', arguments: {} }] },
    { toolCalls: [{ id: 'c2', name: 'big', arguments: {} }] },
    { toolCalls: [{ id: 'c3', name: 'big', arguments: {} }] },
    { toolCalls: [{ id: 'c4', name: 'big', arguments: {} }] },
    { text: '最终答案（基于压缩后上下文）' },
  ])
  const events: AgentLoopEvent[] = []
  const result = await runAgentLoop({
    systemPrompt: 'sys',
    userPrompt: '问题',
    tools: [bigTool],
    routing: routing as never,
    maxTurns: 6,
    // 阈值：tokens > 6000 - 0 → 第一轮后约 4k 不触发，第二轮后约 8k 触发
    contextWindow: 6_000,
    compaction: { reserveTokens: 0, keepRecentTokens: 900 },
    onEvent: (ev) => events.push(ev),
  })

  assert.equal(result.answer, '最终答案（基于压缩后上下文）')
  assert.ok(result.compactions.length >= 1, '至少触发一次压缩')
  const c = result.compactions[0]!
  assert.ok(c.tokensAfter < c.tokensBefore, '压缩后 token 减少')

  // agent:compacted 事件已发出
  const compacted = events.find((e) => e.type === 'agent:compacted')
  assert.ok(compacted, 'agent:compacted 事件存在')
  assert.ok((compacted as { tokensBefore: number }).tokensBefore > 0)

  // 压缩后 transcript 首条是摘要消息（user 角色带「上下文压缩」标记）
  // 压缩请求走了 routing（systemPrompt 含 summarization）
  assert.ok(routing.seenContexts.some((ctx) => /summarization assistant/.test(ctx.systemPrompt ?? '')))
  // 压缩后的主对话请求：transcript 不再包含全部旧 toolResult 原文
  const afterCompactCtx = routing.seenContexts.filter((ctx) => !/summarization/.test(ctx.systemPrompt ?? ''))
  const lastCtx = afterCompactCtx[afterCompactCtx.length - 1]!
  const hasAllOldRaw = (lastCtx.messages as Array<{ content?: unknown }>).every((m) =>
    JSON.stringify(m).includes('x'.repeat(100)),
  )
  assert.ok(!hasAllOldRaw, '旧工具结果原文不应全量保留')
})

test('compaction：未超阈值不触发（记录为空，不额外发请求）', async () => {
  const routing = fakeRouting([
    { toolCalls: [{ id: 'c1', name: 'echo', arguments: { v: 'hi' } }] },
    { text: '答案' },
  ])
  const result = await runAgentLoop({
    systemPrompt: 'sys',
    userPrompt: '问题',
    tools: [echoTool],
    routing: routing as never,
    contextWindow: 1_000_000,
    onEvent: () => {},
  })
  assert.equal(result.compactions.length, 0)
  assert.ok(!routing.seenContexts.some((ctx) => /summarization/.test(ctx.systemPrompt ?? '')))
  assert.equal(result.answer, '答案')
})

test('compaction：enabled:false 关闭（即使超阈值也不压）', async () => {
  const routing = fakeRouting([
    { toolCalls: [{ id: 'c1', name: 'big', arguments: {} }] },
    { toolCalls: [{ id: 'c2', name: 'big', arguments: {} }] },
    { text: '答案' },
  ])
  const result = await runAgentLoop({
    systemPrompt: 'sys',
    userPrompt: '问题',
    tools: [bigTool],
    routing: routing as never,
    contextWindow: 1_000,
    compaction: { enabled: false },
    onEvent: () => {},
  })
  assert.equal(result.compactions.length, 0)
  assert.ok(!routing.seenContexts.some((ctx) => /summarization/.test(ctx.systemPrompt ?? '')))
})

test('compaction：摘要失败（空文本）→ transcript 原样不动，任务继续', async () => {
  // 摘要返回空串
  const routing = fakeRouting(
    [
      { toolCalls: [{ id: 'c1', name: 'big', arguments: {} }] },
      { toolCalls: [{ id: 'c2', name: 'big', arguments: {} }] },
      { text: '降级后的答案' },
    ],
    '   ', // 空 summary
  )
  const result = await runAgentLoop({
    systemPrompt: 'sys',
    userPrompt: '问题',
    tools: [bigTool],
    routing: routing as never,
    contextWindow: 2_000,
    compaction: { reserveTokens: 0, keepRecentTokens: 500 },
    onEvent: () => {},
  })
  // 压缩失败未折叠，但任务没有死：照常作答
  assert.equal(result.answer, '降级后的答案')
  assert.ok(result.compactions.length === 0 || result.compactions[0]!.tokensAfter === result.compactions[0]!.tokensBefore)
})
