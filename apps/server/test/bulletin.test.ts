import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  createBulletin,
  listBulletins,
  setBulletinStatus,
  replyBulletin,
  activeDirectives,
  renderDirectives,
  BULLETIN_TTL_DAYS,
} from '../src/bulletin.ts'

async function makeKb() {
  const kbRoot = await mkdtemp(path.join(tmpdir(), 'ke-kb-'))
  await mkdir(path.join(kbRoot, 'wiki/entities'), { recursive: true })
  return kbRoot
}

test('createBulletin：落盘 bulletins/*.md，frontmatter 完整，默认 7 天保质期', async () => {
  const kbRoot = await makeKb()
  const b = await createBulletin(kbRoot, { author: 'user', kind: 'directive', text: '明天日报主题改成财经' })
  assert.equal(b.status, 'open')
  assert.equal(b.author, 'user')
  assert.equal(b.kind, 'directive')
  assert.equal(b.text, '明天日报主题改成财经')
  assert.ok(b.expiresAt)
  // 默认 TTL ≈ 7 天
  const ttlMs = Date.parse(b.expiresAt!) - Date.parse(b.createdAt)
  assert.ok(Math.abs(ttlMs - BULLETIN_TTL_DAYS * 24 * 3600_000) < 60_000, `TTL ${ttlMs}ms 偏差过大`)

  const raw = await readFile(path.join(kbRoot, 'bulletins', `${b.id}.md`), 'utf8')
  assert.ok(raw.includes('author: user'))
  assert.ok(raw.includes('kind: directive'))
  assert.ok(raw.includes('明天日报主题改成财经'))

  // ttlDays: 0 = 永不过期
  const b2 = await createBulletin(kbRoot, { author: 'user', kind: 'note', text: '备忘', ttlDays: 0 })
  assert.equal(b2.expiresAt, null)
})

test('createBulletin：空内容拒绝', async () => {
  const kbRoot = await makeKb()
  await assert.rejects(createBulletin(kbRoot, { author: 'ai', kind: 'request', text: '   ' }), /不能为空/)
})

test('listBulletins：过期 open 贴读时呈现为 dropped（归档不删除）', async () => {
  const kbRoot = await makeKb()
  // 手工种一张已过期的 open 贴
  await mkdir(path.join(kbRoot, 'bulletins'), { recursive: true })
  const expiredAt = new Date(Date.now() - 3600_000).toISOString()
  await writeFile(
    path.join(kbRoot, 'bulletins', 'b-old.md'),
    `---\nauthor: user\nkind: directive\nstatus: open\ncreated_at: ${new Date(Date.now() - 8 * 86400_000).toISOString()}\nexpires_at: ${expiredAt}\n---\n过期指令\n`,
    'utf8',
  )
  const fresh = await createBulletin(kbRoot, { author: 'ai', kind: 'note', text: '新鲜贴' })

  const all = await listBulletins(kbRoot)
  assert.equal(all.length, 2)
  const old = all.find((x) => x.id === 'b-old')!
  assert.equal(old.status, 'dropped') // 读时转换
  assert.equal(old.text, '过期指令')
  // 落盘仍是 open（惰性，状态变更时机统一写回）
  const raw = await readFile(path.join(kbRoot, 'bulletins', 'b-old.md'), 'utf8')
  assert.ok(raw.includes('status: open'))
  // 新鲜贴不受影响
  assert.equal(all.find((x) => x.id === fresh.id)!.status, 'open')
})

test('replyBulletin：open → replied，thread 追加；再回复保持 replied', async () => {
  const kbRoot = await makeKb()
  const b = await createBulletin(kbRoot, { author: 'ai', kind: 'request', text: 'Tavily key 失效了，请更新' })
  const r1 = await replyBulletin(kbRoot, b.id, 'user', '已换新 key')
  assert.equal(r1.status, 'replied')
  assert.equal(r1.thread.length, 1)
  assert.equal(r1.thread[0]!.author, 'user')
  assert.equal(r1.thread[0]!.text, '已换新 key')

  const r2 = await replyBulletin(kbRoot, b.id, 'ai', '收到，恢复搜索')
  assert.equal(r2.status, 'replied')
  assert.equal(r2.thread.length, 2)

  await assert.rejects(replyBulletin(kbRoot, b.id, 'user', '  '), /不能为空/)
})

test('setBulletinStatus：流转与非法值拒绝；dropped 可重新激活为 open', async () => {
  const kbRoot = await makeKb()
  const b = await createBulletin(kbRoot, { author: 'user', kind: 'todo', text: '整理收件箱' })
  const done = await setBulletinStatus(kbRoot, b.id, 'done')
  assert.equal(done.status, 'done')
  const again = await setBulletinStatus(kbRoot, b.id, 'open')
  assert.equal(again.status, 'open')

  await assert.rejects(setBulletinStatus(kbRoot, b.id, 'zzz' as never), /非法状态/)
  await assert.rejects(setBulletinStatus(kbRoot, 'b-nope', 'done'), /ENOENT/)
})

test('activeDirectives：只返回 open 未过期的 directive（todo/note/replied/过期均不注入）', async () => {
  const kbRoot = await makeKb()
  await createBulletin(kbRoot, { author: 'user', kind: 'directive', text: '日报主题改成财经' })
  await createBulletin(kbRoot, { author: 'user', kind: 'todo', text: '待办不该注入' })
  await createBulletin(kbRoot, { author: 'ai', kind: 'note', text: '留言不该注入' })
  const replied = await createBulletin(kbRoot, { author: 'user', kind: 'directive', text: '已回复的指令' })
  await replyBulletin(kbRoot, replied.id, 'ai', '好的')
  // 过期 directive：backdate 一张
  await mkdir(path.join(kbRoot, 'bulletins'), { recursive: true })
  await writeFile(
    path.join(kbRoot, 'bulletins', 'b-exp.md'),
    `---\nauthor: user\nkind: directive\nstatus: open\ncreated_at: x\nexpires_at: ${new Date(Date.now() - 1000).toISOString()}\n---\n过期指令\n`,
    'utf8',
  )

  const dirs = await activeDirectives(kbRoot)
  assert.equal(dirs.length, 1)
  assert.equal(dirs[0]!.text, '日报主题改成财经')
})

test('renderDirectives：编号拼接，空数组返回空串', () => {
  assert.equal(renderDirectives([]), '')
  assert.equal(
    renderDirectives([
      { id: 'a', path: 'bulletins/a.md', author: 'user', kind: 'directive', status: 'open', text: '主题改成财经', createdAt: '', expiresAt: null, thread: [] },
      { id: 'b', path: 'bulletins/b.md', author: 'user', kind: 'directive', status: 'open', text: '加上 OpenAI 动态', createdAt: '', expiresAt: null, thread: [] },
    ]),
    '【指令1】主题改成财经\n【指令2】加上 OpenAI 动态',
  )
})

test('空 KB：listBulletins 返回空数组', async () => {
  const kbRoot = await makeKb()
  assert.deepEqual(await listBulletins(kbRoot), [])
})
