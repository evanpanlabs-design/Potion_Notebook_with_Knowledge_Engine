import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateProposal, type GateContext, type PageProposal } from '../src/validate.ts'

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  existingPages: new Set(['wiki/entities/karpathy.md']),
  existingSources: new Set(['sources/karpathy-wiki.md', 'sources/llm-wiki.md']),
  reviewedPages: new Set<string>(),
  tagVocabulary: ['ai', 'agent', 'knowledge-graph'],
  ...over,
})

const entityProposal = (over: Partial<PageProposal> = {}): PageProposal => ({
  path: 'wiki/entities/karpathy.md',
  fm: {
    type: 'entity',
    title: 'Karpathy',
    sources: ['sources/karpathy-wiki.md'],
    tags: ['ai'],
    updated_at: '2026-09-28T14:00:00+08:00',
  },
  body: 'Andrej Karpathy，[[LLM Wiki]] 模式提出者。',
  operation: 'create',
  ...over,
})

test('合规提案通过全链', () => {
  const r = validateProposal(entityProposal(), ctx())
  assert.equal(r.ok, true)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.warnings, [])
  assert.equal(r.sanitized?.fm['title'], 'Karpathy')
})

test('对抗：无 sources 落盘必须被拒', () => {
  const r = validateProposal(
    entityProposal({ fm: { type: 'entity', title: 'X', sources: [], updated_at: '2026-09-28T00:00:00Z' } }),
    ctx(),
  )
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.startsWith('gate:schema')))
})

test('对抗：引用不存在的来源必须被拒', () => {
  const r = validateProposal(
    entityProposal({ fm: { type: 'entity', title: 'X', sources: ['sources/不存在.md'], updated_at: '2026-09-28T00:00:00Z' } }),
    ctx(),
  )
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('引用的来源不存在')))
})

test('对抗：词表外 tag 被丢弃并警告，但提案仍通过', () => {
  const r = validateProposal(
    entityProposal({ fm: { type: 'entity', title: 'X', sources: ['sources/karpathy-wiki.md'], tags: ['ai', 'pvp', 'ml'], updated_at: '2026-09-28T00:00:00Z' } }),
    ctx(),
  )
  assert.equal(r.ok, true)
  assert.ok(r.warnings.some((e) => e.includes('pvp')))
  assert.deepEqual(r.sanitized?.fm['tags'], ['ai'])
})

test('对抗：词表外 tag 全部丢弃时 tags 字段整体移除', () => {
  const r = validateProposal(
    entityProposal({ fm: { type: 'entity', title: 'X', sources: ['sources/karpathy-wiki.md'], tags: ['pvp'], updated_at: '2026-09-28T00:00:00Z' } }),
    ctx(),
  )
  assert.equal(r.ok, true)
  assert.equal(r.sanitized?.fm['tags'], undefined)
})

test('对抗：reviewed:true 页面被覆盖必须被拒', () => {
  const c = ctx({ reviewedPages: new Set(['wiki/entities/karpathy.md']) })
  const r = validateProposal(entityProposal({ operation: 'update' }), c)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.startsWith('gate:reviewed')))
})

test('reviewed:true 页面允许 append（带警告）', () => {
  const c = ctx({ reviewedPages: new Set(['wiki/entities/karpathy.md']) })
  const r = validateProposal(entityProposal({ operation: 'append' }), c)
  assert.equal(r.ok, true)
  assert.ok(r.warnings.some((e) => e.startsWith('gate:reviewed')))
})

test('对抗：notes/ 写入必须被拒（Note 神圣性）', () => {
  const r = validateProposal(
    entityProposal({
      path: 'notes/my-thought.md',
      fm: { type: 'note', title: '随想', created_at: '2026-09-28T00:00:00Z', updated_at: '2026-09-28T00:00:00Z', provenance: 'manual' },
    }),
    ctx(),
  )
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.startsWith('gate:note-protected')))
})

test('notes/ 写入在显式豁免（pull_wiki_to_note）时放行', () => {
  const r = validateProposal(
    entityProposal({
      path: 'notes/my-thought.md',
      fm: { type: 'note', title: '随想', created_at: '2026-09-28T00:00:00Z', updated_at: '2026-09-28T00:00:00Z', provenance: 'pulled-from-wiki' },
    }),
    ctx({ allowNoteWrite: true }),
  )
  assert.equal(r.ok, true)
})

test('未知 type 直接被拒', () => {
  const r = validateProposal(entityProposal({ fm: { type: 'virus', title: 'X' } }), ctx())
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.startsWith('gate:schema')))
})

test('note 页 provenance 必须是枚举值', () => {
  const r = validateProposal(
    entityProposal({
      path: 'notes/bad.md',
      fm: { type: 'note', title: 't', created_at: 'x', updated_at: 'x', provenance: 'hacked' },
    }),
    ctx({ allowNoteWrite: true }),
  )
  assert.equal(r.ok, false)
})

test('source 摘要页：source 字段指向真实文件时通过', () => {
  const r = validateProposal(
    entityProposal({
      path: 'wiki/sources/karpathy-wiki.md',
      fm: { type: 'source', title: 'LLM Wiki 设想', source: 'sources/karpathy-wiki.md', sha256: 'abc', ingested_at: '2026-09-28T00:00:00Z', tokens: { analysis: 100, generation: 200 } },
    }),
    ctx(),
  )
  assert.equal(r.ok, true)
})

test('source 摘要页：url 来源直接放行', () => {
  const r = validateProposal(
    entityProposal({
      path: 'wiki/sources/web.md',
      fm: { type: 'source', title: '网页', source: 'https://example.com/a', sha256: 'abc', ingested_at: '2026-09-28T00:00:00Z', tokens: { analysis: 1, generation: 2 } },
    }),
    ctx(),
  )
  assert.equal(r.ok, true)
})
