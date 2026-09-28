import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { initKb, readTagVocabulary, scanKb, KB_DIRS } from '../src/kb.ts'

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ke-kb-'))
}

test('initKb 创建目录骨架与三个根文件', async () => {
  const root = await tempRoot()
  try {
    const { created } = await initKb(root)
    assert.deepEqual(created, [...KB_DIRS])
    for (const f of ['AGENTS.md', 'index.md', 'log.md']) {
      const text = await readFile(path.join(root, f), 'utf8')
      assert.ok(text.length > 0, `${f} 应有内容`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('initKb 幂等：二次执行不覆盖已有 AGENTS.md', async () => {
  const root = await tempRoot()
  try {
    await initKb(root)
    const custom = '# 我的自定义 AGENTS'
    await writeFile(path.join(root, 'AGENTS.md'), custom, 'utf8')
    await initKb(root)
    assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), custom)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readTagVocabulary 解析词表段', async () => {
  const root = await tempRoot()
  try {
    await initKb(root)
    const vocab = await readTagVocabulary(path.join(root, 'AGENTS.md'))
    assert.ok(vocab.includes('ai'))
    assert.ok(vocab.includes('retrieval'))
    assert.ok(!vocab.includes('Agent'), '词表不应包含非列表行')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readTagVocabulary 文件不存在返回空数组', async () => {
  assert.deepEqual(await readTagVocabulary('/nonexistent/AGENTS.md'), [])
})

test('scanKb 扫描 pages/sources/reviewed', async () => {
  const root = await tempRoot()
  try {
    await initKb(root)
    await writeFile(path.join(root, 'sources', 'doc-a.md'), '# A', 'utf8')
    await writeFile(path.join(root, 'sources', 'doc-b.txt'), 'B', 'utf8')
    await mkdir(path.join(root, 'wiki', 'entities'), { recursive: true })
    await writeFile(
      path.join(root, 'wiki', 'entities', 'foo.md'),
      '---\ntype: entity\ntitle: Foo\nsources: [sources/doc-a.md]\nreviewed: true\n---\n\nFoo',
      'utf8',
    )
    await writeFile(
      path.join(root, 'wiki', 'entities', 'bar.md'),
      '---\ntype: entity\ntitle: Bar\nsources: [sources/doc-a.md]\n---\n\nBar',
      'utf8',
    )
    const snap = await scanKb(root)
    assert.ok(snap.sources.has('sources/doc-a.md'))
    assert.ok(!snap.sources.has('sources/doc-b.txt'), '只收 .md')
    assert.ok(snap.pages.has('wiki/entities/foo.md'))
    assert.ok(snap.pages.has('wiki/entities/bar.md'))
    assert.deepEqual([...snap.reviewedPages], ['wiki/entities/foo.md'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
