import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { addUserSuggestion, removeSuggestion, readSuggestions } from '../src/suggest.ts'
import { parsePage } from '@ke/core'

async function makeKb() {
  const kbRoot = await mkdtemp(path.join(tmpdir(), 'ke-kb-'))
  await mkdir(path.join(kbRoot, 'wiki/entities'), { recursive: true })
  await writeFile(path.join(kbRoot, 'wiki/entities/a.md'), '---\ntitle: A\n---\n正文A\n')
  return kbRoot
}

test('addUserSuggestion：写入 origin:user 且幂等（同 note 不重复）', async () => {
  const kbRoot = await makeKb()
  const s1 = await addUserSuggestion(kbRoot, 'wiki/entities/a.md', '补充与[[卡片盒]]的关联')
  assert.equal(s1.length, 1)
  assert.equal(s1[0].origin, 'user')
  assert.ok(s1[0].at)

  // 幂等
  const s2 = await addUserSuggestion(kbRoot, 'wiki/entities/a.md', '补充与[[卡片盒]]的关联')
  assert.equal(s2.length, 1)

  // 追加第二条不同 note
  const s3 = await addUserSuggestion(kbRoot, 'wiki/entities/a.md', '这段过时了')
  assert.equal(s3.length, 2)

  // 落盘格式可被 parsePage 读回
  const { fm, body } = parsePage(await readFile(path.join(kbRoot, 'wiki/entities/a.md'), 'utf8'))
  const sug = fm['suggestions']
  assert.equal(Array.isArray(sug) && sug.length, 2)
  assert.equal(body.trim(), '正文A') // 正文不被破坏
})

test('addUserSuggestion：与 audit 建议共存同池', async () => {
  const kbRoot = await makeKb()
  // 预置一条 audit 建议（模拟 D6-7 写入）
  const raw = await readFile(path.join(kbRoot, 'wiki/entities/a.md'), 'utf8')
  const { fm, body } = parsePage(raw)
  const { serializePage } = await import('@ke/core')
  await writeFile(
    path.join(kbRoot, 'wiki/entities/a.md'),
    serializePage({ ...fm, suggestions: [{ origin: 'audit', note: '两页都讲 X', at: '2026-09-30T00:00:00Z', action: 'merge' }] }, body),
    'utf8',
  )
  const s = await addUserSuggestion(kbRoot, 'wiki/entities/a.md', '用户意见')
  assert.equal(s.length, 2)
  assert.equal(s[0].origin, 'audit')
  assert.equal(s[1].origin, 'user')
})

test('addUserSuggestion：路径守卫与空 note 拒绝', async () => {
  const kbRoot = await makeKb()
  await assert.rejects(addUserSuggestion(kbRoot, 'notes/x.md', 'y'), /只允许 wiki/)
  await assert.rejects(addUserSuggestion(kbRoot, 'wiki/../etc/passwd', 'y'), /只允许 wiki/)
  await assert.rejects(addUserSuggestion(kbRoot, 'wiki/entities/a.md', '   '), /不能为空/)
  await assert.rejects(addUserSuggestion(kbRoot, 'wiki/entities/missing.md', 'y'), /ENOENT/)
})

test('removeSuggestion：按序号移除，清空后 suggestions 键删除', async () => {
  const kbRoot = await makeKb()
  await addUserSuggestion(kbRoot, 'wiki/entities/a.md', '第一条')
  await addUserSuggestion(kbRoot, 'wiki/entities/a.md', '第二条')
  const s = await removeSuggestion(kbRoot, 'wiki/entities/a.md', 0)
  assert.equal(s.length, 1)
  assert.equal(s[0].note, '第二条')

  // 清空：suggestions 键整体移除
  await removeSuggestion(kbRoot, 'wiki/entities/a.md', 0)
  const { fm } = parsePage(await readFile(path.join(kbRoot, 'wiki/entities/a.md'), 'utf8'))
  assert.equal(fm['suggestions'], undefined)

  await assert.rejects(removeSuggestion(kbRoot, 'wiki/entities/a.md', 0), /越界/)
})

test('readSuggestions：不存在页面返回空数组', async () => {
  const kbRoot = await makeKb()
  assert.deepEqual(await readSuggestions(kbRoot, 'wiki/entities/none.md'), [])
  assert.deepEqual(await readSuggestions(kbRoot, 'wiki/entities/a.md'), [])
})
