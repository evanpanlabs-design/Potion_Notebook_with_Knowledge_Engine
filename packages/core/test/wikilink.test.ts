import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractWikiLinks, normalizePageName } from '../src/wikilink.ts'

test('提取裸 wikilink', () => {
  const links = extractWikiLinks('参见 [[Karpathy]] 的文章')
  assert.equal(links.length, 1)
  assert.equal(links[0]?.target, 'Karpathy')
  assert.equal(links[0]?.alias, null)
  assert.equal(links[0]?.heading, null)
})

test('提取带 alias 与 heading 的 wikilink', () => {
  const links = extractWikiLinks('[[Karpathy#llm-wiki|原帖]]')
  assert.equal(links[0]?.target, 'Karpathy')
  assert.equal(links[0]?.heading, 'llm-wiki')
  assert.equal(links[0]?.alias, '原帖')
})

test('代码块外的多个链接全部提取且 offset 正确', () => {
  const links = extractWikiLinks('[[A]] 中间 [[B]] 结尾')
  assert.deepEqual(links.map((l) => l.target), ['A', 'B'])
  assert.equal(links[1]?.offset, 9)
})

test('不匹配空链接与普通文本', () => {
  assert.deepEqual(extractWikiLinks(' [[]] [普通] [[ ]（内部空白）'), [])
})

test('normalizePageName 去扩展名并小写', () => {
  assert.equal(normalizePageName('Karpathy.MD'), 'karpathy')
  assert.equal(normalizePageName(' RAG '), 'rag')
})
