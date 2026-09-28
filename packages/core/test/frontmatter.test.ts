import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePage, serializePage } from '../src/frontmatter.ts'

test('parsePage 解析标准 frontmatter + 正文', () => {
  const text = `---
type: entity
title: Karpathy
sources:
  - sources/karpathy-wiki.md
---

正文第一行
第二行`
  const { fm, body } = parsePage(text)
  assert.equal(fm['type'], 'entity')
  assert.equal(fm['title'], 'Karpathy')
  assert.deepEqual(fm['sources'], ['sources/karpathy-wiki.md'])
  assert.equal(body, '\n正文第一行\n第二行')
})

test('parsePage 无 frontmatter 时 fm 为空对象且 body 为原文', () => {
  const { fm, body } = parsePage('就是一段普通文本')
  assert.deepEqual(fm, {})
  assert.equal(body, '就是一段普通文本')
})

test('parsePage frontmatter 块后紧跟正文（无空行）', () => {
  const { fm, body } = parsePage('---\ntype: note\n---\n正文')
  assert.equal(fm['type'], 'note')
  assert.equal(body, '正文')
})

test('serializePage 与 parsePage 往返一致', () => {
  const fm = { type: 'concept', title: 'RAG', sources: ['sources/a.md'] }
  const text = serializePage(fm, '正文内容')
  const back = parsePage(text)
  assert.equal(back.fm['type'], 'concept')
  assert.equal(back.fm['title'], 'RAG')
  assert.deepEqual(back.fm['sources'], ['sources/a.md'])
  assert.equal(back.body, '正文内容')
})

test('parsePage 容忍空 YAML frontmatter', () => {
  const { fm } = parsePage('---\n---\n正文')
  assert.deepEqual(fm, {})
})
