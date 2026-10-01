/**
 * D14 端到端地狱测试：v0.3 全链路串联（零网络 fake）。
 *
 * 场景：
 * 1. 断电补做：服务停机 < 24h 重启 → 错过任务 caught-up 补跑，日报落收件箱
 * 2. 错过放弃：停机 ≥ 24h → skipped + AI 便利贴通知 + nextDue 推进不补做
 * 3. directive 注入：便利贴指令改写日报生成上下文（LLM 收到「用户指令优先服从」段）
 * 4. 日报消化：收件箱「消化进图谱」→ 证据页走 ingest 闸门 → 幂等 + digested 标记
 * 5. AI 便利贴全生命周期：directive 到期转 dropped 呈现 → 不再注入
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { startScheduler } from '../src/scheduler.ts'
import { createDigestRunner } from '../src/digest-runner.ts'
import { listInbox, digestInboxItem } from '../src/inbox.ts'
import { listBulletins, createBulletin, activeDirectives } from '../src/bulletin.ts'
import { parsePage } from '@ke/core'

// ---------------------------------------------------------------------------
// fake 层：Tavily 拦截全局 fetch；LLM routing 记录调用并返回脚本化报告
// ---------------------------------------------------------------------------

const HITS = [
  { title: 'OpenAI 发布新模型', url: 'https://example.com/1', content: '今天 OpenAI 发布了新模型，性能提升 30%。' },
]

function fakeTavily() {
  const orig = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ results: HITS.map((h) => ({ title: h.title, url: h.url, content: h.content })) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  return () => {
    globalThis.fetch = orig
  }
}

/** 记录每次 LLM 调用的 fake routing：digest 调用（systemPrompt 含 DIGEST_PROMPT 标志）返回日报报告；
 *  ingest 两阶段（analyze → generate）返回合法 JSON。digest runner 的 callLlmJson 也传
 *  kind='ingest'，故用 systemPrompt 特征区分而非 kind */
function spyRouting(report) {
  const seenPayloads: string[] = []
  const digestText = JSON.stringify(report)
  const analysis = {
    summary: 'OpenAI 发布新模型。',
    language: 'zh',
    entities: [{ name: 'OpenAI', definition: 'AI 公司', aliases: [], claims: [{ statement: '发布新模型', locus: '全文' }] }],
    concepts: [],
  }
  const generation = {
    pages: [{ name: 'OpenAI', body: 'OpenAI 发布新模型，性能提升 30%。', sources: [`sources/inbox-${localToday()}-ai.md`] }],
  }
  let ingestCall = 0
  return {
    seenPayloads,
    stream: async function* (kind, systemPrompt, messages) {
      const payload = JSON.stringify(messages)
      seenPayloads.push(payload)
      const isDigest = /搜索结果|用户指令/.test(payload)
      const text = isDigest ? digestText : ingestCall++ === 0 ? JSON.stringify(analysis) : JSON.stringify(generation)
      yield { type: 'text_delta', delta: text }
      yield { type: 'done', message: { usage: { input: 10, output: 10 } } }
    },
  }
}

/** 本地“今天”YYYY-MM-DD（fixture 与 digest-runner 证据页命名对齐；勿硬编码——UTC 跨日 flake 教训） */
function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const REPORT = {
  summary: '今天 AI 圈一件大事。',
  highlights: [{ title: 'OpenAI 发布新模型', point: '性能提升 30%。', url: 'https://example.com/1' }],
  suggestion: '与库内 LLM 页相关，建议消化。',
}

/** 场景环境：临时 KB + data + 启用的 Tavily（网络已 fake） */
async function makeEnv(routing) {
  const kbRoot = await mkdtemp(path.join(tmpdir(), 'ke-e2e-kb-'))
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'ke-e2e-data-'))
  await mkdir(path.join(kbRoot, 'inbox'), { recursive: true })
  await writeFile(
    path.join(dataRoot, 'tavily-config.json'),
    JSON.stringify({ apiKey: 'tvly-test', enabled: true, usedMonth: new Date().toISOString().slice(0, 7), usedCount: 0 }),
  )
  const runner = createDigestRunner({ kbRoot, dataRoot, routing })
  const scheduler = startScheduler({
    dataRoot,
    kbRoot,
    runners: new Map([['digest', runner]]),
    scanMs: 60 * 60 * 1000, // 1h：测试期间 interval 不自触发，全靠 sweepOnce 手动
  })
  return { kbRoot, dataRoot, scheduler }
}

/** 直接种一条任务到 tasks.json（模拟历史状态） */
async function seedTask(dataRoot, patch) {
  const task = {
    id: 't-e2e', kind: 'digest', title: 'AI 资讯', topic: 'AI',
    query: undefined, schedule: { type: 'daily', at: '07:00' }, enabled: true,
    createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
    lastRunAt: null, nextDue: null, history: [],
    ...patch,
  }
  await writeFile(path.join(dataRoot, 'tasks.json'), JSON.stringify({ tasks: [task] }, null, 2))
  return task
}

const waitFor = async (fn, timeout = 5000) => {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('e2e 断电补做：停机 5h 重启 → caught-up 补跑，日报落收件箱，directive 注入生效', async () => {
  const restore = fakeTavily()
  const routing = spyRouting(REPORT)
  try {
    const { kbRoot, dataRoot, scheduler } = await makeEnv(routing)
    // 种子：nextDue 5 小时前（停机 5h < 24h → 补做）
    await seedTask(dataRoot, { nextDue: new Date(Date.now() - 5 * 3600_000).toISOString() })

    // 用户提前贴了一张 directive
    await createBulletin(kbRoot, { author: 'user', kind: 'directive', text: '日报聚焦 OpenAI，忽略其它' })

    await scheduler.sweepOnce()
    // 补跑是异步 execute —— 等 history 记录落盘
    await waitFor(async () => {
      const ts = await scheduler.store.list()
      return ts[0]!.history.some((h) => h.outcome === 'caught-up')
    })

    // ① caught-up 记录 + 产物
    const ts = await scheduler.store.list()
    const rec = ts[0]!.history[0]!
    assert.equal(rec.outcome, 'caught-up')
    assert.ok(rec.artifact?.startsWith('inbox/'))

    // ② directive 注入了 LLM 上下文（用户指令优先服从段）
    assert.ok(routing.seenPayloads.length >= 1)
    assert.ok(routing.seenPayloads.some((p) => p.includes('用户指令') && p.includes('日报聚焦 OpenAI')))

    // ③ 收件箱有日报 + 证据页物化
    const inbox = await listInbox(kbRoot)
    assert.ok(inbox.length >= 1)
    const sources = await readdir(path.join(kbRoot, 'sources'))
    assert.ok(sources.some((s) => s.startsWith('inbox-')), '证据页已物化')

    // ④ 下一次 nextDue 已推进到未来（不会立刻再跑）
    assert.ok(Date.parse(ts[0]!.nextDue!) > Date.now())
    scheduler.stop()
  } finally {
    restore()
  }
})

test('e2e 错过放弃：停机 30h → skipped + AI 便利贴通知 + 不执行 runner', async () => {
  const restore = fakeTavily()
  const routing = spyRouting(REPORT)
  try {
    const { kbRoot, dataRoot, scheduler } = await makeEnv(routing)
    let runnerCalled = 0
    // 包一层计数 runner
    const base = createDigestRunner({ kbRoot, dataRoot, routing })
    scheduler.stop()
    const scheduler2 = startScheduler({
      dataRoot,
      kbRoot,
      runners: new Map([['digest', async (t, ctx) => { runnerCalled++; return base(t, ctx) }]]),
      scanMs: 60 * 60 * 1000,
    })
    await seedTask(dataRoot, { nextDue: new Date(Date.now() - 30 * 3600_000).toISOString() })

    await scheduler2.sweepOnce()
    await waitFor(async () => {
      const ts = await scheduler2.store.list()
      return ts[0]!.history.some((h) => h.outcome === 'skipped')
    })

    // ① skipped 记录，runner 从未执行
    const ts = await scheduler2.store.list()
    assert.equal(ts[0]!.history[0]!.outcome, 'skipped')
    assert.equal(runnerCalled, 0)
    // ② 日报没有产出
    assert.equal((await listInbox(kbRoot)).length, 0)
    // ③ AI 便利贴已发（跳过通知）
    const bulletins = await listBulletins(kbRoot)
    assert.ok(bulletins.some((b) => b.author === 'ai' && b.text.includes('本轮已跳过')), 'AI 跳过通知贴存在')
    // ④ nextDue 推进到未来
    assert.ok(Date.parse(ts[0]!.nextDue!) > Date.now())
    scheduler2.stop()
  } finally {
    restore()
  }
})

test('e2e 日报消化闭环：收件箱 digest → 证据页 ingest → 幂等 + digested 留痕', async () => {
  const restore = fakeTavily()
  const routing = spyRouting(REPORT)
  try {
    const { kbRoot, dataRoot, scheduler } = await makeEnv(routing)
    await seedTask(dataRoot, { nextDue: new Date(Date.now() - 5 * 3600_000).toISOString() })
    await scheduler.sweepOnce()
    await waitFor(async () => (await listInbox(kbRoot)).length >= 1)

    const inbox = await listInbox(kbRoot)
    const item = inbox[0]!
    assert.equal(item.digested, false)

    // 消化：证据页走 ingest 管线（fake routing 的 callLlmJson 也会 stream——ingest 需要）
    const result = await digestInboxItem({ kbRoot, routing }, item.path)
    assert.ok(result.ok, `消化成功：${result.digestOutcome ?? ''} ${JSON.stringify(result.rejections)}`)

    // digested 标记写回 frontmatter
    const raw = await readFile(path.join(kbRoot, item.path), 'utf8')
    const { fm } = parsePage(raw)
    assert.equal(fm['digested'], true)

    // 二次消化：幂等直返（alreadyDigested 标记，不再走 ingest）
    const before = routing.seenPayloads.length
    const again = await digestInboxItem({ kbRoot, routing }, item.path)
    assert.equal(again.ok, true)
    assert.equal(again.alreadyDigested, true)
    assert.equal(routing.seenPayloads.length, before) // 零 LLM 调用

    scheduler.stop()
  } finally {
    restore()
  }
})

test('e2e directive 保质期：到期 open 贴呈现为 dropped → activeDirectives 不再注入', async () => {
  const kbRoot = await mkdtemp(path.join(tmpdir(), 'ke-e2e-kb2-'))
  await mkdir(path.join(kbRoot, 'bulletins'), { recursive: true })

  // 种一张已过期 open directive
  await writeFile(
    path.join(kbRoot, 'bulletins', 'b-d1.md'),
    `---\nauthor: user\nkind: directive\nstatus: open\ncreated_at: ${new Date(Date.now() - 9 * 86400_000).toISOString()}\nexpires_at: ${new Date(Date.now() - 86400_000).toISOString()}\n---\n过期的指令\n`,
    'utf8',
  )
  // 一张新鲜 directive
  const fresh = await createBulletin(kbRoot, { author: 'user', kind: 'directive', text: '有效指令' })

  const all = await listBulletins(kbRoot)
  assert.equal(all.find((b) => b.id === 'b-d1')!.status, 'dropped') // 读时呈现

  const dirs = await activeDirectives(kbRoot)
  assert.equal(dirs.length, 1)
  assert.equal(dirs[0]!.text, '有效指令')
  assert.equal(dirs[0]!.id, fresh.id)
})
