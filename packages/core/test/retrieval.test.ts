import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tokenize,
  lexicalMatch,
  graphExpand,
  assembleContext,
  buildLinkGraph,
  type PageDoc,
} from '../src/retrieval.ts'

const PAGES: PageDoc[] = [
  {
    path: 'wiki/entities/karpathy.md',
    title: 'Karpathy',
    aliases: ['Andrej Karpathy'],
    tags: ['ai'],
    body: 'Karpathy 提出用 LLM 维护个人 wiki 的工作流，人负责策展，LLM 负责维护。见 [[LLM Wiki]] 与 [[知识复利]]。',
  },
  {
    path: 'wiki/concepts/llm-wiki.md',
    title: 'LLM Wiki',
    aliases: [],
    tags: ['ai', 'knowledge-graph'],
    body: 'LLM Wiki 是由 LLM 维护的 Markdown wiki 系统，由 [[Karpathy]] 构想。实现见 [[两段式 CoT Ingest]]。',
  },
  {
    path: 'wiki/concepts/知识复利.md',
    title: '知识复利',
    aliases: ['knowledge compounding'],
    tags: [],
    body: '知识复利指新知识与已有知识持续整合沉淀。相关：[[LLM Wiki]]。',
  },
  {
    path: 'wiki/concepts/两段式-cot-ingest.md',
    title: '两段式 CoT Ingest',
    aliases: ['two-stage ingest'],
    tags: ['engineering'],
    body: '两段式 CoT ingest 是先分析后生成的知识摄入机制，nashsu/llm_wiki 项目采用。',
  },
  {
    path: 'wiki/entities/lancedb.md',
    title: 'LanceDB',
    aliases: [],
    tags: [],
    body: 'LanceDB 是向量数据库，与上面主题无链接关系（孤立页）。',
  },
]

test('tokenize 中英混排：英文词 + 中文 bigram', () => {
  const t = tokenize('LLM Wiki 知识复利')
  assert.ok(t.includes('llm'))
  assert.ok(t.includes('wiki'))
  assert.ok(t.includes('知识')) // 2-gram
  assert.ok(t.includes('识复'))
})

test('L1 词法：整名命中权重最高', () => {
  const hits = lexicalMatch('什么是知识复利？', PAGES)
  assert.equal(hits[0]?.path, 'wiki/concepts/知识复利.md')
})

test('L1 词法：别名可命中', () => {
  const hits = lexicalMatch('Andrej Karpathy 是谁', PAGES)
  assert.ok(hits.some((h) => h.path === 'wiki/entities/karpathy.md'))
})

test('L1 词法：正文命中也能召回（低分）', () => {
  const hits = lexicalMatch('向量数据库', PAGES)
  assert.ok(hits.some((h) => h.path === 'wiki/entities/lancedb.md'))
})

test('L2 图扩展：从命中页沿链接找到邻居，孤立页不进结果', () => {
  const seeds = lexicalMatch('LLM Wiki', PAGES, { limit: 3 })
  const expanded = graphExpand(seeds, buildLinkGraph(PAGES))
  const paths = expanded.map((h) => h.path)
  assert.ok(paths.includes('wiki/entities/karpathy.md'))     // LLM Wiki → Karpathy
  assert.ok(paths.includes('wiki/concepts/知识复利.md'))     // Karpathy → 知识复利
  assert.ok(paths.includes('wiki/concepts/两段式-cot-ingest.md')) // LLM Wiki → 两段式（1跳）
  assert.ok(!paths.includes('wiki/entities/lancedb.md'))     // 孤立页且词法零分
})

test('L2 图扩展：种子分优先于邻居分', () => {
  const seeds = lexicalMatch('LLM Wiki', PAGES, { limit: 1 })
  const expanded = graphExpand(seeds, buildLinkGraph(PAGES))
  assert.equal(expanded[0]?.path, 'wiki/concepts/llm-wiki.md') // 种子永远第一
})

test('assembleContext：预算内整页填充，超出预算的记录 dropped', () => {
  const hits = graphExpand(lexicalMatch('LLM Wiki', PAGES), buildLinkGraph(PAGES))
  const asm = assembleContext(hits, PAGES, { charBudget: 10_000 })
  assert.ok(asm.pages.length >= 3)
  assert.ok(asm.pages.every((p) => p.body.length > 0))
  // 极小预算：全部裁掉
  const tiny = assembleContext(hits, PAGES, { charBudget: 10 })
  assert.equal(tiny.pages.length, 0)
  assert.ok(tiny.dropped.length > 0)
})

test('assembleContext：预算从高到低塞满为止', () => {
  const hits = [
    { path: 'wiki/entities/karpathy.md', score: 100 },
    { path: 'wiki/concepts/llm-wiki.md', score: 90 },
    { path: 'wiki/concepts/知识复利.md', score: 80 },
  ]
  const asm = assembleContext(hits, PAGES, { charBudget: 120 })
  assert.equal(asm.pages.length, 1) // 第一页就快占满
  assert.ok(asm.dropped.length >= 2)
})
