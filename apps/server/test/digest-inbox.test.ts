import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDigestRunner } from '../src/digest-runner.ts'
import { listInbox, readInboxItem, digestInboxItem } from '../src/inbox.ts'
import { parsePage, serializePage } from '@ke/core'

const here = path.dirname(fileURLToPath(import.meta.url))

/** fake Tavily 网络层：拦截全局 fetch（digest-runner 直接用 createTavilyClient 默认 fetch） */
function fakeTavily(hits) {
  const orig = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        results: hits.map((h) => ({ title: h.title, url: h.url, content: h.content })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  return () => {
    globalThis.fetch = orig
  }
}

const HITS = [
  { title: 'OpenAI 发布新模型', url: 'https://example.com/1', content: '今天 OpenAI 发布了新模型，性能提升 30%。' },
  { title: 'Anthropic 融资', url: 'https://example.com/2', content: 'Anthropic 完成新一轮融资，估值翻倍。' },
]

/** fake LLM 路由：不调用真模型，digest runner 的 callLlmJson 会走 stream */
function fakeRouting(report) {
  const text = JSON.stringify(report)
  return {
    stream: async function* () {
      yield { type: 'text_delta', delta: text }
      yield { type: 'done', message: { usage: { input: 10, output: 10 } } }
    },
  }
}

async function makeEnv({ routing } = {}) {
  const kbRoot = await mkdtemp(path.join(tmpdir(), 'ke-kb-'))
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'ke-data-'))
  // 无 .git → gitCommitAll 返回 null，不干扰测试
  await mkdir(path.join(kbRoot, 'inbox'), { recursive: true })
  await mkdir(path.join(dataRoot), { recursive: true })
  // Tavily 配置：启用 + 假 key（网络已被 fake）
  await writeFile(
    path.join(dataRoot, 'tavily-config.json'),
    JSON.stringify({ apiKey: 'tvly-test', enabled: true, usedMonth: new Date().toISOString().slice(0, 7), usedCount: 0 }),
  )
  const task = {
    id: 't-1', kind: 'digest', title: 'AI 资讯', topic: 'AI',
    query: undefined, schedule: { type: 'daily', at: '07:00' }, enabled: true,
    createdAt: new Date().toISOString(), lastRunAt: null, nextDue: new Date().toISOString(),
    history: [],
  }
  return { kbRoot, dataRoot, task, runner: createDigestRunner({ kbRoot, dataRoot, routing }) }
}

test('digest：LLM 综合版日报 + 证据页物化 + 用量记账', async () => {
  const restore = fakeTavily(HITS)
  try {
    const report = {
      summary: '今天 AI 圈两件大事。',
      highlights: [
        { title: 'OpenAI 发布新模型', point: '性能提升 30%，值得跟踪评测。', url: 'https://example.com/1' },
        { title: 'Anthropic 融资', point: '估值翻倍，竞争加剧。', url: 'https://example.com/2' },
      ],
      suggestion: '新模型发布与库内 LLM 相关，建议消化。',
    }
    const { kbRoot, dataRoot, task, runner } = await makeEnv({ routing: fakeRouting(report) })
    const r = await runner(task, { manual: true })

    assert.ok(r.artifact?.startsWith('inbox/'))
    // 证据页物化到 sources/（wiki 可引用的合法依据）
    const evidence = path.join(kbRoot, 'sources', path.basename(r.artifact).replace(/^/, 'inbox-'))
    const evidenceText = await readFile(evidence, 'utf8')
    assert.ok(evidenceText.includes('https://example.com/1'))
    assert.ok(evidenceText.includes('检索证据'))

    // 日报 frontmatter
    const raw = await readFile(path.join(kbRoot, r.artifact), 'utf8')
    const { fm, body } = parsePage(raw)
    assert.equal(fm['type'], 'bulletin')
    assert.equal(fm['mode'], 'manual')
    assert.equal(fm['digested'], false)
    assert.ok(String(fm['evidence']).startsWith('sources/inbox-'))
    assert.deepEqual(fm['sources'], HITS.map((h) => h.url))
    // LLM 综合正文
    assert.ok(body.includes('今天 AI 圈两件大事'))
    assert.ok(body.includes('消化建议'))

    // 用量记账：+1 credit
    const cfg = JSON.parse(await readFile(path.join(dataRoot, 'tavily-config.json'), 'utf8'))
    assert.equal(cfg.usedCount, 1)
  } finally {
    restore()
  }
})

test('digest：LLM 未配置降级原始快报（任务不 fail）', async () => {
  const restore = fakeTavily(HITS)
  try {
    const { kbRoot, task, runner } = await makeEnv() // 无 routing
    const r = await runner(task, { manual: false })
    assert.ok(r.artifact?.startsWith('inbox/'))
    assert.ok(r.note?.includes('LLM 未配置'))
    const { body } = parsePage(await readFile(path.join(kbRoot, r.artifact), 'utf8'))
    assert.ok(body.includes('LLM 未配置'))
    assert.ok(body.includes('https://example.com/1')) // 原始结果仍在
  } finally {
    restore()
  }
})

test('digest：LLM 失败降级原始快报', async () => {
  const restore = fakeTavily(HITS)
  try {
    const badRouting = {
      stream: async function* () {
        throw new Error('LLM down')
      },
    }
    const { kbRoot, task, runner } = await makeEnv({ routing: badRouting })
    const r = await runner(task, { manual: false })
    assert.ok(r.note?.includes('LLM 综合失败'))
    const { body } = parsePage(await readFile(path.join(kbRoot, r.artifact), 'utf8'))
    assert.ok(body.includes('降级为原始搜索结果'))
  } finally {
    restore()
  }
})

test('digest：Tavily 未启用抛错（任务记 error）', async () => {
  const { kbRoot, dataRoot, task, runner } = await makeEnv()
  await writeFile(path.join(dataRoot, 'tavily-config.json'), JSON.stringify({ apiKey: '', enabled: false }))
  await assert.rejects(runner(task, { manual: false }), /联网检索未启用/)
  void kbRoot
})

// ---------- 收件箱 API（listInbox / readInboxItem / digestInboxItem） ----------

test('listInbox：空目录返回空，非 md 忽略', async () => {
  const kbRoot = await mkdtemp(path.join(tmpdir(), 'ke-kb-'))
  assert.deepEqual(await listInbox(kbRoot), [])
  await mkdir(path.join(kbRoot, 'inbox'), { recursive: true })
  await writeFile(path.join(kbRoot, 'inbox', 'note.txt'), 'x')
  assert.deepEqual(await listInbox(kbRoot), [])
})

test('listInbox：解析 frontmatter 与预览（新在前）', async () => {
  const kbRoot = await mkdtemp(path.join(tmpdir(), 'ke-kb-'))
  await mkdir(path.join(kbRoot, 'inbox'), { recursive: true })
  const fm = {
    type: 'bulletin', taskTitle: 'AI 资讯', topic: 'AI',
    generatedAt: '2026-09-30T07:00:00Z', mode: 'scheduled',
    sources: ['https://a.com', 'https://b.com'],
    evidence: 'sources/inbox-2026-09-30-ai.md', digested: false, digestOutcome: '',
  }
  await writeFile(path.join(kbRoot, 'inbox', '2026-09-30-ai.md'), serializePage(fm, '\n# 标题\n\n这是预览段落。\n'))
  const items = await listInbox(kbRoot)
  assert.equal(items.length, 1)
  assert.equal(items[0].taskTitle, 'AI 资讯')
  assert.equal(items[0].sources.length, 2)
  assert.equal(items[0].summary, '这是预览段落。')
})

test('readInboxItem：路径校验', async () => {
  const kbRoot = await mkdtemp(path.join(tmpdir(), 'ke-kb-'))
  await mkdir(path.join(kbRoot, 'inbox'), { recursive: true })
  await writeFile(path.join(kbRoot, 'inbox', 'a.md'), 'x')
  assert.ok(await readInboxItem(kbRoot, 'inbox/a.md'))
  assert.equal(await readInboxItem(kbRoot, 'wiki/../secret.md'), null)
  assert.equal(await readInboxItem(kbRoot, 'inbox/missing.md'), null)
})

test('digestInboxItem：无证据页 → ok:false 并写明原因', async () => {
  const kbRoot = await mkdtemp(path.join(tmpdir(), 'ke-kb-'))
  await mkdir(path.join(kbRoot, 'inbox'), { recursive: true })
  const fm = { type: 'bulletin', taskTitle: 'X', topic: 'x', generatedAt: '', mode: 'manual', sources: [] }
  await writeFile(path.join(kbRoot, 'inbox', 'old.md'), serializePage(fm, '\n正文\n'))
  const r = await digestInboxItem({ kbRoot, routing: {} }, 'inbox/old.md')
  assert.equal(r.ok, false)
  assert.ok(r.digestOutcome.includes('无证据页'))
  // 留痕写回
  const { fm: fm2 } = parsePage(await readFile(path.join(kbRoot, 'inbox', 'old.md'), 'utf8'))
  assert.equal(fm2['digested'], false)
  assert.ok(String(fm2['digestOutcome']).includes('无证据页'))
})

test('digestInboxItem：幂等——已消化直接返回', async () => {
  const kbRoot = await mkdtemp(path.join(tmpdir(), 'ke-kb-'))
  await mkdir(path.join(kbRoot, 'inbox'), { recursive: true })
  const fm = { type: 'bulletin', digested: true, digestOutcome: '已消化：写入 2 页' }
  await writeFile(path.join(kbRoot, 'inbox', 'done.md'), serializePage(fm, '\n正文\n'))
  const r = await digestInboxItem({ kbRoot, routing: {} }, 'inbox/done.md')
  assert.equal(r.alreadyDigested, true)
  assert.equal(r.digestOutcome, '已消化：写入 2 页')
})

test('digestInboxItem：走 ingest 管线消化证据页（fake routing + 不动真 LLM）', async () => {
  const kbRoot = await mkdtemp(path.join(tmpdir(), 'ke-kb-'))
  await mkdir(path.join(kbRoot, 'inbox'), { recursive: true })
  await mkdir(path.join(kbRoot, 'sources'), { recursive: true })
  // 最小 KB 结构（ingest 需要 wiki/ 与 AGENTS.md 吗？ingestSource 只读 source 文件与写 wiki/）
  await writeFile(path.join(kbRoot, 'sources', 'inbox-2026-09-30-ai.md'), '# 证据\n\nOpenAI 发布新模型，性能提升 30%。')
  const fm = {
    type: 'bulletin', taskTitle: 'AI 资讯', topic: 'AI', generatedAt: '', mode: 'scheduled',
    sources: [], evidence: 'sources/inbox-2026-09-30-ai.md', digested: false, digestOutcome: '',
  }
  await writeFile(path.join(kbRoot, 'inbox', '2026-09-30-ai.md'), serializePage(fm, '\n# 日报\n\n综述。\n'))

  // ingest 会真的调 callLlmJson → 需要 fake stream；这里用一个直接抛错的 routing 验证失败路径标记
  const badRouting = { stream: async function* () { throw new Error('no llm') } }
  await assert.rejects(digestInboxItem({ kbRoot, routing: badRouting }, 'inbox/2026-09-30-ai.md'), /no llm|LLM/)
  // 失败时不标记 digested（下次可重试）
  const { fm: fm2 } = parsePage(await readFile(path.join(kbRoot, 'inbox', '2026-09-30-ai.md'), 'utf8'))
  assert.notEqual(fm2['digested'], true)
})
