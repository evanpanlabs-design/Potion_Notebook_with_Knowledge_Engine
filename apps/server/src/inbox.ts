/**
 * 收件箱（ADR-003 §3.2）：inbox/ 目录的读取、消化进图谱。
 *
 * inbox/ 不在 scanKb 的 KB_DIRS 集合内——收件箱内容天然不进检索/图谱；
 * 「消化进图谱」= 把该日报引用的证据页（sources/inbox-*.md）走既有 ingest
 * 管线，消化完成后在 frontmatter 记 digested/digestOutcome 留痕（幂等可查）。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { parsePage, serializePage } from '@ke/core'
import { ingestSource } from './ingest-pipeline.ts'

export interface InboxItem {
  path: string // inbox/xxx.md
  title: string
  topic: string
  taskTitle: string
  generatedAt: string
  mode: string
  sources: string[]
  evidence: string | null
  digested: boolean
  digestOutcome: string
  summary: string // 正文首段预览
}

/** 列收件箱（新在前，按文件名日期倒序——文件名即 <date>-<slug>.md） */
export async function listInbox(kbRoot: string): Promise<InboxItem[]> {
  const dir = path.join(kbRoot, 'inbox')
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const items: InboxItem[] = []
  for (const name of names.filter((n) => n.endsWith('.md')).sort().reverse()) {
    const rel = `inbox/${name}`
    const { fm, body } = parsePage(await readFile(path.join(dir, name), 'utf8'))
    items.push({
      path: rel,
      title: (fm['title'] as string) ?? name.replace(/\.md$/, ''),
      topic: (fm['topic'] as string) ?? '',
      taskTitle: (fm['taskTitle'] as string) ?? '',
      generatedAt: (fm['generatedAt'] as string) ?? '',
      mode: (fm['mode'] as string) ?? 'scheduled',
      sources: Array.isArray(fm['sources']) ? (fm['sources'] as string[]) : [],
      evidence: (fm['evidence'] as string) ?? null,
      digested: fm['digested'] === true,
      digestOutcome: (fm['digestOutcome'] as string) ?? '',
      summary: firstParagraph(body),
    })
  }
  return items
}

/** 读单封（收件箱正文预览用；内容太大时前端分页/折叠） */
export async function readInboxItem(kbRoot: string, rel: string): Promise<{ content: string } | null> {
  if (!rel.startsWith('inbox/') || !rel.endsWith('.md') || rel.includes('..')) return null
  try {
    return { content: await readFile(path.join(kbRoot, rel), 'utf8') }
  } catch {
    return null
  }
}

export interface DigestOutcome {
  ok: boolean
  alreadyDigested?: boolean
  skipped?: boolean
  writtenPages: string[]
  sourceSummaryPage?: string
  rejections: string[]
  digestOutcome: string
}

/** 消化进图谱：把证据页喂给既有 ingest 管线，结果写回首件的 frontmatter */
export async function digestInboxItem(deps: { kbRoot: string; routing: unknown }, rel: string): Promise<DigestOutcome> {
  const { kbRoot } = deps
  if (!rel.startsWith('inbox/') || !rel.endsWith('.md') || rel.includes('..')) {
    throw new Error('非法收件箱路径')
  }
  const inboxPath = path.join(kbRoot, rel)
  const { fm, body } = parsePage(await readFile(inboxPath, 'utf8'))

  // 幂等：已消化过直接返回
  if (fm['digested'] === true) {
    return {
      ok: true,
      alreadyDigested: true,
      writtenPages: [],
      rejections: [],
      digestOutcome: (fm['digestOutcome'] as string) || '已消化',
    }
  }

  // 证据页优先（D4-5 版日报都带）；老版本/无证据页时降级为不消化并明说原因
  const evidence = (fm['evidence'] as string) ?? null
  if (!evidence || !evidence.startsWith('sources/')) {
    const outcome = '无证据页（evidence frontmatter 缺失），不消化：请手动把相关素材放入 sources/ 后走「素材」页 ingest'
    await markDigested(kbRoot, rel, false, outcome)
    return { ok: false, writtenPages: [], rejections: [], digestOutcome: outcome }
  }
  await readFile(path.join(kbRoot, evidence), 'utf8').catch(() => {
    throw new Error(`证据页不存在：${evidence}`)
  })

  // 走既有 ingest 管线（闸门/幂等/review queue 全部沿用）
  const outcome = await ingestSource({ kbRoot, routing: deps.routing as never }, evidence)
  const ok = outcome.rejections.length === 0
  const digestOutcome = outcome.skipped
    ? `已消化（幂等命中：同内容此前已 ingest）`
    : ok
      ? `已消化：写入 ${outcome.writtenPages.length} 页（待审核）`
      : `部分消化：${outcome.rejections.length} 条提案被闸门拒绝`

  await markDigested(kbRoot, rel, true, digestOutcome)
  void body
  return {
    ok,
    skipped: outcome.skipped,
    writtenPages: outcome.writtenPages,
    sourceSummaryPage: outcome.sourceSummaryPage,
    rejections: outcome.rejections,
    digestOutcome,
  }
}

async function markDigested(kbRoot: string, rel: string, digested: boolean, outcomeText: string): Promise<void> {
  const abs = path.join(kbRoot, rel)
  const { fm, body } = parsePage(await readFile(abs, 'utf8'))
  const next = { ...fm, digested, digestOutcome: outcomeText }
  await writeFile(abs, serializePage(next, body), 'utf8')
}

/** 正文首段预览（跳过标题/引用行，取首个非空段落截断 120 字） */
function firstParagraph(body: string): string {
  for (const para of body.split(/\n\s*\n/)) {
    const lines = para.split('\n').filter((l) => {
      const t = l.trim()
      return t && !t.startsWith('#') && !t.startsWith('>')
    })
    const t = lines.join(' ').trim()
    if (t) return t.length > 120 ? `${t.slice(0, 120)}…` : t
  }
  return ''
}
