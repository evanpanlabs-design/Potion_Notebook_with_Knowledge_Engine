/**
 * bulletin board（ADR-003 §3.3）：用户与 AI 的异步交互便利贴面板。
 *
 * 存储：bulletins/*.md + frontmatter——
 *   author: user | ai
 *   kind:   directive（指令，任务前注入）| todo | request（AI 向用户要东西）| note
 *   status: open | done | dropped | replied
 *   expiresAt（保质期，默认 7 天；过期自动转 dropped 归档不删除）
 *   thread[]（回复跟帖）
 * 库即记忆 + git 留痕，与 rework 同哲学。
 *
 * AI 侧接入（灵魂）：
 *   - scheduler 触发任务前：status=open 且未过期的 directive 注入任务上下文
 *   - 任务缺数据/缺能力：AI 发 request 型便利贴向用户提要求
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { parsePage, serializePage } from '@ke/core'

export interface BulletinThreadItem {
  author: 'user' | 'ai'
  text: string
  at: string
}

export interface Bulletin {
  id: string // 文件名去 .md
  path: string
  author: 'user' | 'ai'
  kind: 'directive' | 'todo' | 'request' | 'note'
  status: 'open' | 'done' | 'dropped' | 'replied'
  text: string // 正文（便利贴内容）
  createdAt: string
  expiresAt: string | null
  thread: BulletinThreadItem[]
}

export const BULLETIN_TTL_DAYS = 7

function bulletinsDir(kbRoot: string): string {
  return path.join(kbRoot, 'bulletins')
}

function isExpired(b: Bulletin, now: number): boolean {
  return b.expiresAt !== null && Date.parse(b.expiresAt) < now
}

/** 列全部便利贴（过期标 dropped——展示层直接看到已归档状态，落盘惰性转换） */
export async function listBulletins(kbRoot: string): Promise<Bulletin[]> {
  let names: string[] = []
  try {
    names = await readdir(bulletinsDir(kbRoot))
  } catch {
    return []
  }
  const now = Date.now()
  const out: Bulletin[] = []
  for (const name of names.filter((n) => n.endsWith('.md')).sort().reverse()) {
    const b = readOne(await readFile(path.join(bulletinsDir(kbRoot), name), 'utf8'), name.replace(/\.md$/, ''))
    if (!b) continue
    // 过期自动转 dropped（归档不删除；只在读时呈现，写回由状态变更时机统一做）
    if (b.status === 'open' && isExpired(b, now)) b.status = 'dropped'
    out.push(b)
  }
  return out
}

function readOne(text: string, id: string): Bulletin | null {
  const { fm, body } = parsePage(text)
  const author = fm['author']
  const kind = fm['kind']
  if (author !== 'user' && author !== 'ai') return null
  return {
    id,
    path: `bulletins/${id}.md`,
    author,
    kind: (['directive', 'todo', 'request', 'note'] as const).includes(kind as never) ? (kind as Bulletin['kind']) : 'note',
    status: (['open', 'done', 'dropped', 'replied'] as const).includes(fm['status'] as never)
      ? (fm['status'] as Bulletin['status'])
      : 'open',
    text: body.trim(),
    createdAt: (fm['created_at'] as string) ?? '',
    expiresAt: (fm['expires_at'] as string) ?? null,
    thread: Array.isArray(fm['thread'])
      ? (fm['thread'] as BulletinThreadItem[]).filter((t) => t && typeof t.text === 'string')
      : [],
  }
}

export interface CreateBulletinInput {
  author: 'user' | 'ai'
  kind: Bulletin['kind']
  text: string
  /** 保质期天数；0 = 永不过期 */
  ttlDays?: number
}

export async function createBulletin(kbRoot: string, input: CreateBulletinInput): Promise<Bulletin> {
  const text = input.text.trim()
  if (!text) throw new Error('便利贴内容不能为空')
  const id = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
  const now = new Date()
  // 保质期：缺省 7 天；显式 0 = 永不过期
  const ttlDays = input.ttlDays ?? BULLETIN_TTL_DAYS
  const expiresAt =
    ttlDays > 0 ? new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString() : null
  const fm: Record<string, unknown> = {
    author: input.author,
    kind: input.kind,
    status: 'open',
    created_at: now.toISOString(),
  }
  if (expiresAt) fm['expires_at'] = expiresAt
  await mkdir(bulletinsDir(kbRoot), { recursive: true })
  await writeFile(path.join(bulletinsDir(kbRoot), `${id}.md`), serializePage(fm, `\n${text}\n`), 'utf8')
  return {
    id,
    path: `bulletins/${id}.md`,
    author: input.author,
    kind: input.kind,
    status: 'open',
    text,
    createdAt: now.toISOString(),
    expiresAt,
    thread: [],
  }
}

export async function setBulletinStatus(kbRoot: string, id: string, status: Bulletin['status']): Promise<Bulletin> {
  const file = path.join(bulletinsDir(kbRoot), `${id}.md`)
  const raw = await readFile(file, 'utf8') // 不存在则抛
  const { fm, body } = parsePage(raw)
  const b = readOne(raw, id)
  if (!b) throw new Error('便利贴格式非法')
  if (!['open', 'done', 'dropped', 'replied'].includes(status)) throw new Error(`非法状态：${status}`)
  await writeFile(file, serializePage({ ...fm, status }, body), 'utf8')
  return { ...b, status }
}

export async function replyBulletin(kbRoot: string, id: string, author: 'user' | 'ai', text: string): Promise<Bulletin> {
  const file = path.join(bulletinsDir(kbRoot), `${id}.md`)
  const raw = await readFile(file, 'utf8')
  const { fm, body } = parsePage(raw)
  const b = readOne(raw, id)
  if (!b) throw new Error('便利贴格式非法')
  const trimmed = text.trim()
  if (!trimmed) throw new Error('回复内容不能为空')
  const thread = [...b.thread, { author, text: trimmed, at: new Date().toISOString() }]
  // 首次回复把 open → replied（有回应了）；已 done/dropped 不动
  const status = b.status === 'open' ? 'replied' : b.status
  await writeFile(file, serializePage({ ...fm, status, thread }, body), 'utf8')
  return { ...b, thread, status }
}

/** 任务前注入：status=open 且未过期的 directive（「明天日报主题改成财经」由此生效） */
export async function activeDirectives(kbRoot: string, now: number = Date.now()): Promise<Bulletin[]> {
  const all = await listBulletins(kbRoot)
  return all.filter((b) => b.kind === 'directive' && b.status === 'open' && !isExpired(b, now))
}

/** directive 注入为任务上下文文本（digest runner 等消费） */
export function renderDirectives(items: Bulletin[]): string {
  if (items.length === 0) return ''
  return items.map((b, i) => `【指令${i + 1}】${b.text}`).join('\n')
}
