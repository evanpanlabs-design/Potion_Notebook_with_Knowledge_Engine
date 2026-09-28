/**
 * 同步/维护管线（v0.2 · ADR-002）：
 *  1) notes/ 笔记 → 快照到 sources/note-*.md → 复用两段式 ingest（幂等按 sha256）→ 回写笔记 ingest 元数据
 *  2) sources/ 来源（被编辑过）→ 直接重新 ingestSource（sha256 变了自动重跑）
 *  3) wiki/ 页面（被编辑过）→ 局部维护：把页面最新版 + git 上一版 + 邻居页交给 LLM，
 *     输出对邻居页的更新提案 → 闸门校验 → 落盘 + git 提交
 *  4) rework：审核返修批量修复（池子 + 维护锁）
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { parsePage, serializePage } from '@ke/core'
import { validateProposal } from '@ke/core'
import { ingestSource, gitCommitAll } from './ingest-pipeline.ts'
import type { IngestDeps } from './ingest-pipeline.ts'
import { scanKb } from '@ke/core'

const execFileP = promisify(execFile)

export type SyncOutcome =
  | { kind: 'note-ingest'; writtenPages: string[]; commitSha: string | null; skipped: boolean; snapshotPath: string; rejections: string[] }
  | { kind: 'source-reingest'; writtenPages: string[]; commitSha: string | null; skipped: boolean; rejections: string[] }
  | { kind: 'wiki-maintain'; updatedPages: string[]; summary: string; commitSha: string | null; rejections: string[] }

function stripFm(text: string): string {
  return parsePage(text).body
}

function sha256Sync(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** git show HEAD:<path>（无提交/文件不在 HEAD 时返回 null） */
async function gitShowHead(kbRoot: string, rel: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', kbRoot, 'show', `HEAD:${rel}`], { maxBuffer: 10 * 1024 * 1024 })
    return stdout
  } catch {
    return null
  }
}

// ---------- 1) 笔记 → ingest ----------

/** 笔记内容快照落盘位置：sources/note-<name>.md（可变原件的不可变快照，复用幂等判重） */
export function noteSnapshotPath(noteRel: string): string {
  const name = noteRel.replace(/^notes\//, '').replace(/\.md$/, '').split('/').pop() ?? 'note'
  return `sources/note-${name}.md`
}

export async function syncNote(deps: IngestDeps, noteRel: string): Promise<SyncOutcome> {
  const { kbRoot } = deps
  const events = deps.events ?? new EventEmitter()
  const noteText = await readFile(path.join(kbRoot, noteRel), 'utf8')
  const body = stripFm(noteText).trim()
  if (!body) throw new Error('笔记正文为空，无可消化内容')

  // 快照写盘（幂等判重以该快照 sha256 为准：笔记没改过 → 重复 sync 直接 skipped）
  const snapshotRel = noteSnapshotPath(noteRel)
  await mkdir(path.dirname(path.join(kbRoot, snapshotRel)), { recursive: true })
  await writeFile(path.join(kbRoot, snapshotRel), `# 快照来源：${noteRel}\n\n${body}\n`, 'utf8')

  const outcome = await ingestSource(deps, snapshotRel)

  // 回写笔记 ingest 元数据（成功即视为已同步；skipped 也刷新时间戳）。
  // hash 对正文 body 取（不含 frontmatter）：fm 里 updated_at/ingested_sha256 本身会变，整页 hash 会永远 dirty。
  const { fm, body: noteBody } = parsePage(noteText)
  fm['ingested_sha256'] = sha256Sync(body)
  fm['last_ingested_at'] = new Date().toISOString()
  await writeFile(path.join(kbRoot, noteRel), serializePage(fm, noteBody), 'utf8')
  await gitCommitAll(kbRoot, `sync: mark ingested ${noteRel}`)

  return {
    kind: 'note-ingest',
    writtenPages: outcome.writtenPages,
    commitSha: outcome.commitSha,
    skipped: outcome.skipped,
    snapshotPath: snapshotRel,
    rejections: outcome.rejections,
  }
}

// ---------- 2) sources/ 来源重新 ingest ----------

export async function syncSource(deps: IngestDeps, sourceRel: string): Promise<SyncOutcome> {
  const outcome = await ingestSource(deps, sourceRel)
  return {
    kind: 'source-reingest',
    writtenPages: outcome.writtenPages,
    commitSha: outcome.commitSha,
    skipped: outcome.skipped,
    rejections: outcome.rejections,
  }
}

// ---------- 3) wiki 页编辑 → 局部维护 ----------

const MAINTAIN_PROMPT = `你是知识库的"维护器"。一个由 AI 生成、经人工编辑过的 wiki 页面发生了变更，你的任务是让知识库的相关页面与它保持一致。
输入：变更页的完整最新内容、它的 git 上一版本（可能为 null）、以及周边页面（引用它的/它引用的）。
要求：
1. 对照最新版与上一版，找出事实、表述、链接上的不一致
2. 只更新确实因这次变更而过时/矛盾/需要补充链接的周边页面；无关页面不要动
3. 每个更新输出完整新 body（Markdown，200-400 字），保持页面原有 title 不变
4. 严格保留 wikilink 语法 [[页面名]]；新增引用必须真实存在于输入材料
5. 没有任何页面需要更新时，updates 返回空数组
6. 输出 JSON：{"summary":"变更维护摘要（≤60字）","updates":[{"path":"wiki/.../x.md","title":"x","body":"...","sources":["sources/..."]}]}`

interface MaintainUpdate {
  path: string
  title: string
  body: string
  sources?: string[]
}

/** 收集邻居页：backlinks（引用本页的）+ outlinks（本页引用的），各截前 6 页、每页截 1500 字 */
async function collectNeighbors(kbRoot: string, rel: string): Promise<Map<string, string>> {
  const { extractWikiLinks, normalizePageName } = await import('@ke/core')
  const snap = await scanKb(kbRoot)
  const neighbors = new Map<string, string>()
  const texts = new Map<string, { title: string; body: string; fm: Record<string, unknown> }>()
  const nameIndex = new Map<string, string>()
  for (const p of snap.pages) {
    const text = await readFile(path.join(kbRoot, p), 'utf8')
    const { fm, body } = parsePage(text)
    const title = (fm['title'] as string) ?? p.split('/').pop()!.replace(/\.md$/, '')
    texts.set(p, { title, body, fm })
    nameIndex.set(title.toLowerCase(), p)
    nameIndex.set(normalizePageName(title).toLowerCase(), p)
  }
  const self = texts.get(rel)
  const selfName = (self?.title ?? rel.split('/').pop()!.replace(/\.md$/, '')).toLowerCase()
  const out: string[] = []
  const back: string[] = []
  for (const [p, t] of texts) {
    if (p === rel) continue
    const links = extractWikiLinks(t.body).map((l) => normalizePageName(l.target).toLowerCase())
    if (links.includes(selfName)) back.push(p)
  }
  for (const l of self ? extractWikiLinks(self.body) : []) {
    const target = nameIndex.get(l.target.toLowerCase()) ?? nameIndex.get(normalizePageName(l.target).toLowerCase())
    if (target && target !== rel) out.push(target)
  }
  for (const p of [...new Set([...back, ...out])].slice(0, 6)) {
    const t = texts.get(p)!
    neighbors.set(p, `--- ${p}（title: ${t.title}）---\n${t.body.slice(0, 1500)}`)
  }
  return neighbors
}

export async function maintainWikiPage(
  deps: IngestDeps,
  rel: string,
  routingHint?: unknown,
): Promise<SyncOutcome> {
  const { kbRoot, routing, events: bus } = deps
  const events = deps.events ?? new EventEmitter()
  const currentText = await readFile(path.join(kbRoot, rel), 'utf8')
  const prevText = await gitShowHead(kbRoot, rel)
  const neighbors = await collectNeighbors(kbRoot, rel)

  events.emit('analyze:start', rel)
  const userPayload = JSON.stringify(
    {
      changedPage: { path: rel, latestContent: currentText, previousContent: prevText },
      neighborPages: Object.fromEntries(neighbors),
    },
    null,
    2,
  )
  const { callLlmJson } = await import('./ingest-pipeline.ts')
  const { Value } = await import('@sinclair/typebox/value')
  const { Type } = await import('@sinclair/typebox')
  const MaintainReport = Type.Object({
    summary: Type.String(),
    updates: Type.Array(Type.Object({ path: Type.String(), title: Type.String(), body: Type.String(), sources: Type.Optional(Type.Array(Type.String())) })),
  })
  const phase1 = await callLlmJson<{ summary: string; updates: MaintainUpdate[] }>(
    routing,
    'ingest',
    MAINTAIN_PROMPT,
    [{ role: 'user', text: userPayload }],
    MaintainReport,
    { events, phase: 'generate' },
  )
  if (!Value.Check(MaintainReport, phase1.report)) throw new Error('maintain: 输出不合 schema')
  events.emit('analyze:done', phase1.report)

  // 闸门校验 + 落盘
  const snap = await scanKb(kbRoot)
  const gateCtx = { existingPages: snap.pages, existingSources: snap.sources, reviewedPages: snap.reviewedPages, tagVocabulary: [] }
  const written: string[] = []
  const rejections: string[] = []
  for (const u of phase1.report.updates) {
    if (!u.path.startsWith('wiki/') || u.path === rel) continue
    const existing = await readFile(path.join(kbRoot, u.path), 'utf8').catch(() => null)
    if (!existing) {
      rejections.push(`gate:页面不存在 ${u.path}，维护器不能新建页`)
      continue
    }
    const { fm } = parsePage(existing)
    fm['updated_at'] = new Date().toISOString()
    fm['maintained_from'] = rel
    const result = validateProposal({ path: u.path, fm, body: u.body, operation: 'update' }, gateCtx)
    if (!result.ok) {
      rejections.push(...result.errors)
      continue
    }
    await writeFile(path.join(kbRoot, u.path), serializePage(result.sanitized!.fm, `\n${result.sanitized!.body}\n`), 'utf8')
    written.push(u.path)
  }

  const { appendFile } = await import('node:fs/promises')
  const { renderLogEntry } = await import('@ke/core')
  const title = rel.split('/').pop()?.replace(/\.md$/, '') ?? rel
  await appendFile(path.join(kbRoot, 'log.md'), renderLogEntry('sync', `维护 ${title}（联动 ${written.length} 页）`), 'utf8')
  const commitSha = await gitCommitAll(kbRoot, `maintain: ${rel} (${written.length} pages updated)`)
  events.emit('commit', commitSha ?? 'no-git')

  return { kind: 'wiki-maintain', updatedPages: written, summary: phase1.report.summary, commitSha, rejections }
}

// ---------- 统一入口 ----------

export async function syncPage(deps: IngestDeps, rel: string): Promise<SyncOutcome> {
  if (rel.startsWith('notes/')) return syncNote(deps, rel)
  if (rel.startsWith('sources/')) return syncSource(deps, rel)
  if (rel.startsWith('wiki/')) return maintainWikiPage(deps, rel)
  throw new Error(`不支持同步的路径：${rel}`)
}

// ---------- 4) 返修池（审核） ----------

export interface ReworkState {
  running: boolean
  startedAt: string | null
  processing: string | null
  done: Array<{ path: string; ok: boolean; error?: string }>
}

const reworkState: ReworkState = { running: false, startedAt: null, processing: null, done: [] }

export function getReworkState(): ReworkState {
  return { ...reworkState, done: [...reworkState.done] }
}

/** 批量修复返修池：逐页 LLM 按意见修订 → 闸门落盘 → 清 rework 标记（回到待审）。运行期间 reworkState.running=true（前端/进池逻辑据此暂停） */
export async function runReworkBatch(deps: IngestDeps, items: Array<{ path: string; note: string }>): Promise<ReworkState> {
  if (reworkState.running) throw new Error('已有批量修复在运行中')
  reworkState.running = true
  reworkState.startedAt = new Date().toISOString()
  reworkState.done = []
  const { kbRoot } = deps
  const { appendFile } = await import('node:fs/promises')
  const { renderLogEntry } = await import('@ke/core')
  try {
    for (const item of items) {
      reworkState.processing = item.path
      try {
        const abs = path.join(kbRoot, item.path)
        const text = await readFile(abs, 'utf8')
        const { fm, body } = parsePage(text)
        const { callLlmJson } = await import('./ingest-pipeline.ts')
        const phase = await callLlmJson<{ body: string }>(
          deps.routing,
          'ingest',
          `你是知识库的"返修执行器"。审核人对一个 AI 生成页面给出了修改意见，请按意见修订页面正文。
要求：
1. 只修改与意见相关的内容，其余原样保留
2. 保持 wikilink [[页面名]] 语法与原有链接（除非意见要求删除）
3. 不编造事实；输出 JSON：{"body":"修订后的完整 Markdown 正文"}`,
          [{ role: 'user', text: JSON.stringify({ page: { path: item.path, title: fm['title'] ?? '', body }, reviewNote: item.note }, null, 2) }],
          undefined,
          { events: deps.events, phase: 'generate' },
        )
        const newBody = phase.report.body?.trim()
        if (!newBody) throw new Error('返修输出为空')
        delete fm['rework']
        fm['reworked_at'] = new Date().toISOString()
        fm['updated_at'] = fm['reworked_at']
        await writeFile(abs, serializePage(fm, `\n${newBody}\n`), 'utf8')
        const title = item.path.split('/').pop()?.replace(/\.md$/, '') ?? item.path
        await appendFile(path.join(kbRoot, 'log.md'), renderLogEntry('rework', `返修完成 ${title}`), 'utf8')
        reworkState.done.push({ path: item.path, ok: true })
      } catch (e) {
        reworkState.done.push({ path: item.path, ok: false, error: String((e as Error).message ?? e) })
      } finally {
        reworkState.processing = null
      }
    }
  } finally {
    reworkState.running = false
    reworkState.startedAt = null
    await gitCommitAll(kbRoot, `review: rework batch (${reworkState.done.filter((d) => d.ok).length} pages)`)
  }
  return getReworkState()
}
