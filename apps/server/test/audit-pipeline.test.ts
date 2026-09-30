import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { healthCheck, writeSuggestions, runAudit, getAuditState } from '../src/audit-pipeline.ts'
import { buildLinkGraph, type PageDoc } from '@ke/core'

const here = path.dirname(fileURLToPath(import.meta.url))

function page(path, title, body, extra = {}) {
  return { path, title, aliases: [], tags: [], body, ...extra }
}

// ---------- healthCheck：纯计算体检 ----------

test('healthCheck：孤立节点检出（queries 归档页除外）', () => {
  const pages = [
    page('wiki/entities/a.md', '实体A', '内容甲 [[实体B]]'),
    page('wiki/entities/b.md', '实体B', '内容乙'),
    page('wiki/entities/c.md', '孤立C', '无链接内容'),
    page('wiki/queries/q1.md', 'query', '问题 [[实体A]]'),
  ]
  const g = buildLinkGraph(pages)
  const r = healthCheck(pages, g)
  // c 无出边无入边 = 孤立；b 有入边不算；query 页即使无出边也不算
  assert.deepEqual(r.orphans.map((o) => o.paths[0]), ['wiki/entities/c.md'])
  assert.equal(r.totalPages, 4)
  assert.equal(r.edges, 2) // a→b 与 q→a（图里 query 出边也计入 edges）
})

test('healthCheck：疑似重复实体（标题几乎相同）', () => {
  const pages = [
    page('wiki/entities/zettelkasten.md', 'Zettelkasten 笔记法', '内容一'),
    page('wiki/concepts/zettelkasten-note.md', 'Zettelkasten 笔记法', '内容二'),
    page('wiki/entities/rag.md', 'RAG', '内容三'),
  ]
  const r = healthCheck(pages, buildLinkGraph(pages))
  assert.equal(r.duplicates.length, 1)
  assert.ok(r.duplicates[0].evidence.includes('Jaccard'))
})

test('healthCheck：超枢纽检出（度数超阈值）', () => {
  // 中心页连 15 页
  const pages = [page('wiki/entities/hub.md', '枢纽', '中心')]
  for (let i = 0; i < 15; i++) pages.push(page(`wiki/entities/n${i}.md`, `N${i}`, `提到 [[枢纽]]`))
  const r = healthCheck(pages, buildLinkGraph(pages))
  assert.ok(r.hubs.length >= 1)
  assert.ok(r.hubs[0].paths[0] === 'wiki/entities/hub.md')
})

test('healthCheck：桥接冗余初筛（两端正文零重叠但互联）', () => {
  // 正文足够长（token 数 > 30）但内容毫不相干，仅靠一条 wikilink 相连
  const bodyA = '哲学与伦理学的漫长讨论涉及苏格拉底柏拉图亚里士多德康德黑格尔现象学存在主义 [[乙页面]]'
  const bodyB = '酵母发酵工艺参数表温控菌群繁殖麦芽汁糖化啤酒酿造蒸馏提纯工艺流程设备清洗'
  const pages = [
    page('wiki/entities/x.md', '甲页面', bodyA),
    page('wiki/entities/y.md', '乙页面', bodyB),
  ]
  const r = healthCheck(pages, buildLinkGraph(pages))
  assert.ok(r.bridges.some((b) => b.paths.includes('wiki/entities/x.md')), JSON.stringify(r.bridges))
})

// ---------- writeSuggestions：落盘与幂等 ----------

test('writeSuggestions：写入目标页 frontmatter 且幂等', async () => {
  const kbRoot = await mkdtemp(path.join(tmpdir(), 'ke-kb-'))
  await mkdir(path.join(kbRoot, 'wiki/entities'), { recursive: true })
  await writeFile(path.join(kbRoot, 'wiki/entities/a.md'), '---\ntitle: A\n---\n正文A\n')
  await writeFile(path.join(kbRoot, 'wiki/entities/b.md'), '---\ntitle: B\n---\n正文B\n')

  const proposals = [
    { action: 'merge', target: 'wiki/entities/a.md', peer: 'wiki/entities/b.md', reason: '两页都讲 Zettelkasten 编号', confidence: 0.8 },
    { action: 'addLink', target: 'wiki/entities/a.md', peer: 'wiki/entities/b.md', reason: '应互链' },
  ]
  const written = await writeSuggestions(kbRoot, proposals)
  assert.deepEqual(written, ['wiki/entities/a.md']) // 只写目标页

  const raw = await readFile(path.join(kbRoot, 'wiki/entities/a.md'), 'utf8')
  assert.ok(raw.includes('suggestions:'))
  assert.ok(raw.includes('origin: audit'))
  assert.ok(raw.includes('两页都讲 Zettelkasten 编号'))

  // 幂等：重跑不重复
  const written2 = await writeSuggestions(kbRoot, proposals)
  assert.deepEqual(written2, [])
  const raw2 = await readFile(path.join(kbRoot, 'wiki/entities/a.md'), 'utf8')
  assert.equal((raw2.match(/origin: audit/g) ?? []).length, 2)

  // b 页不受影响（建议只写 target）
  const rawB = await readFile(path.join(kbRoot, 'wiki/entities/b.md'), 'utf8')
  assert.ok(!rawB.includes('suggestions:'))
})

// ---------- runAudit：集成（fake LLM routing） ----------

function fakeRouting(report) {
  const text = JSON.stringify(report)
  return {
    stream: async function* () {
      yield { type: 'text_delta', delta: text }
      yield { type: 'done', message: { usage: { input: 10, output: 10 } } }
    },
  }
}

test('runAudit：体检 → LLM 判定 → 建议落盘（fake routing）', async () => {
  const kbRoot = await mkdtemp(path.join(tmpdir(), 'ke-kb-'))
  await mkdir(path.join(kbRoot, 'wiki/entities'), { recursive: true })
  await mkdir(path.join(kbRoot, 'sources'), { recursive: true })
  // 一个孤立节点 + 一个孤立节点（保证有 findings 可判定）
  await writeFile(path.join(kbRoot, 'wiki/entities/orphan.md'), '---\ntitle: 孤儿页\n---\n孤立内容\n')
  await writeFile(path.join(kbRoot, 'wiki/entities/another.md'), '---\ntitle: 另一页\n---\n另一内容\n')

  const report = {
    proposals: [
      { action: 'annotate', target: 'wiki/entities/orphan.md', reason: '孤立节点：建议补充与「另一页」的关联', confidence: 0.7 },
    ],
  }
  const pages = [
    page('wiki/entities/orphan.md', '孤儿页', '孤立内容'),
    page('wiki/entities/another.md', '另一页', '另一内容'),
  ]
  const outcome = await runAudit({ kbRoot, dataRoot: here, routing: fakeRouting(report) }, pages)
  assert.ok(outcome.health.findings >= 2) // 两个孤立节点
  assert.equal(outcome.judged, true)
  assert.equal(outcome.proposals, 1)
  assert.deepEqual(outcome.suggestionsWritten, ['wiki/entities/orphan.md'])
  // 状态可查
  assert.equal(getAuditState().running, false)
  assert.ok(getAuditState().lastOutcome)

  const raw = await readFile(path.join(kbRoot, 'wiki/entities/orphan.md'), 'utf8')
  assert.ok(raw.includes('suggestions:'))
  assert.ok(raw.includes('孤立节点：建议补充'))
})

test('runAudit：LLM 失败 → judged:false，零建议，不落盘', async () => {
  const kbRoot = await mkdtemp(path.join(tmpdir(), 'ke-kb-'))
  await mkdir(path.join(kbRoot, 'wiki/entities'), { recursive: true })
  await writeFile(path.join(kbRoot, 'wiki/entities/x.md'), '---\ntitle: X\n---\n孤立\n')
  const badRouting = { stream: async function* () { throw new Error('llm down') } }
  const pages = [page('wiki/entities/x.md', 'X', '孤立')]
  const outcome = await runAudit({ kbRoot, dataRoot: here, routing: badRouting }, pages)
  assert.equal(outcome.judged, false)
  assert.equal(outcome.proposals, 0)
  const raw = await readFile(path.join(kbRoot, 'wiki/entities/x.md'), 'utf8')
  assert.ok(!raw.includes('suggestions:'))
})

test('runAudit：并发互斥（running 时再跑抛错）', async () => {
  // 用慢 routing 占住 running
  const slowRouting = {
    stream: async function* () {
      await new Promise((r) => setTimeout(r, 80))
      yield { type: 'text_delta', delta: JSON.stringify({ proposals: [] }) }
      yield { type: 'done', message: { usage: { input: 1, output: 1 } } }
    },
  }
  const kbRoot = await mkdtemp(path.join(tmpdir(), 'ke-kb-'))
  await mkdir(path.join(kbRoot, 'wiki/entities'), { recursive: true })
  await writeFile(path.join(kbRoot, 'wiki/entities/x.md'), '---\ntitle: X\n---\n孤立\n')
  const pages = [page('wiki/entities/x.md', 'X', '孤立')]
  const p = runAudit({ kbRoot, dataRoot: here, routing: slowRouting }, pages)
  await assert.rejects(runAudit({ kbRoot, dataRoot: here, routing: slowRouting }, pages), /已有 audit/)
  await p
})
