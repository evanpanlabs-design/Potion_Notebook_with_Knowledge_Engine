import Fastify from 'fastify'
import { readFile, writeFile, appendFile, mkdir, unlink, access } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import process from 'node:process'

import { initKb, scanKb, parsePage, renderLogEntry, serializePage } from '@ke/core'
import { createRouting } from '@ke/agent-tools'
import { ingestSource, gitCommitAll } from './ingest-pipeline.ts'
import { answerQuery, buildGraphData } from './query-pipeline.ts'

/**
 * server 入口（D2-4e）。本地单用户，绑 127.0.0.1，无鉴权。
 * API 契约 = ARCHITECTURE §8（MVP 子集）：
 *   POST /api/v1/kb            建库（幂等）
 *   POST /api/v1/sources       摄入素材（写 sources/，不触发 ingest）
 *   POST /api/v1/ingest        对一个 source 跑两段式 ingest
 *   GET  /api/v1/health
 *   GET  /api/v1/pages/*path   只读页面
 */

const KB_ROOT = process.env.KNOWLEDGE_BASE ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', 'data/my-wiki')
const PORT = Number(process.env.PORT ?? 3100)

const app = Fastify({ logger: false })
/** 全局事件总线：SSE 层（后续接入 web）与缓存失效逻辑订阅 */
export const bus = new EventEmitter()

/** D12-13 修复：KB 必须自持 git 仓库（回滚是核心卖点，不能依赖用户手动 init）。
 *  启动时若无 .git：git init → 补 local user（避免全局没配导致 commit 失败）→ initial commit */
async function ensureKbGit(root: string): Promise<void> {
  const run = (args: string[]) =>
    new Promise<number>((resolve) => {
      const p = spawn('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
      p.on('close', (code) => resolve(code ?? 1))
    })
  try {
    await access(path.join(root, '.git'))
    return
  } catch { /* 无仓库，继续初始化 */ }
  await run(['init', '-b', 'main'])
  const { userName, userEmail } = { userName: process.env.GIT_AUTHOR_NAME, userEmail: process.env.GIT_AUTHOR_EMAIL }
  if (userName && userEmail) {
    await run(['config', 'user.name', userName])
    await run(['config', 'user.email', userEmail])
  } else {
    // 全局通常已配置；为保险起见仅在该仓库缺 local config 且全局缺失时兜底
    const hasGlobal = await new Promise<number>((resolve) => {
      const p = spawn('git', ['config', '--global', 'user.email'], { stdio: ['ignore', 'pipe', 'pipe'] })
      p.on('close', (code) => resolve(code ?? 1))
    })
    if (hasGlobal !== 0) {
      await run(['config', 'user.name', 'Potion'])
      await run(['config', 'user.email', 'potion@local'])
    }
  }
  await run(['add', '-A'])
  await run(['commit', '-m', 'chore: init knowledge base', '--allow-empty'])
  console.log(`knowledge base git repo initialized at ${root}`)
}

function llmRouting() {
  const baseUrl = process.env.LLM_BASE_URL
  const apiKey = process.env.LLM_API_KEY
  if (!baseUrl || !apiKey) throw new Error('缺少 LLM_BASE_URL/LLM_API_KEY 环境变量')
  const defaultModel = process.env.LLM_MODEL_INGEST ?? 'gpt-4o-mini'
  return createRouting({
    ingest: { baseUrl, apiKey, model: defaultModel },
    query: { baseUrl, apiKey, model: process.env.LLM_MODEL_QUERY ?? defaultModel },
  })
}

app.get('/api/v1/health', async () => ({ ok: true, kb: KB_ROOT }))

app.post('/api/v1/kb', async () => {
  const r = await initKb(KB_ROOT)
  return { ok: true, root: KB_ROOT, dirs: r.created }
})

interface SourceBody {
  filename: string
  content: string
}

app.post('/api/v1/sources', async (req, reply) => {
  const body = req.body as SourceBody
  if (!body?.filename || !body?.content) {
    return reply.code(400).send({ error: '需要 filename 与 content' })
  }
  if (!/^[\w.-]+(\.md|\.txt)$/.test(body.filename)) {
    return reply.code(400).send({ error: 'filename 仅允许 .md/.txt' })
  }
  await mkdir(path.join(KB_ROOT, 'sources'), { recursive: true })
  await writeFile(path.join(KB_ROOT, 'sources', body.filename), body.content, 'utf8')
  bus.emit('source:added', body.filename)
  return { ok: true, path: `sources/${body.filename}` }
})

interface IngestBody {
  source: string // sources/xxx.md
}

app.post('/api/v1/ingest', async (req, reply) => {
  const body = req.body as IngestBody
  if (!body?.source?.startsWith('sources/')) {
    return reply.code(400).send({ error: 'source 必须以 sources/ 开头' })
  }
  try {
    await readFile(path.join(KB_ROOT, body.source), 'utf8')
  } catch {
    return reply.code(404).send({ error: `来源不存在：${body.source}` })
  }
  try {
    const outcome = await ingestSource({ kbRoot: KB_ROOT, routing: llmRouting(), events: bus }, body.source)
    return outcome
  } catch (e) {
    req.log.error(e)
    return reply.code(500).send({ error: String((e as Error).message ?? e) })
  }
})

interface QueryBody {
  question: string
  archive?: boolean
}

app.post('/api/v1/query', async (req, reply) => {
  const body = req.body as QueryBody
  if (!body?.question?.trim()) {
    return reply.code(400).send({ error: '需要 question' })
  }
  try {
    const outcome = await answerQuery({ kbRoot: KB_ROOT, routing: llmRouting(), events: bus }, body.question, { archive: body.archive })
    return outcome
  } catch (e) {
    req.log.error(e)
    return reply.code(500).send({ error: String((e as Error).message ?? e) })
  }
})

/** 图谱数据（F7 前端直接消费） */
app.get('/api/v1/graph', async () => buildGraphData(KB_ROOT))

/** 笔记列表（F4）：notes/ 由人所有，只读元信息（标题+路径+更新时间） */
app.get('/api/v1/notes', async () => {
  const snap = await scanKb(KB_ROOT)
  const out: Array<{ path: string; title: string; updatedAt: string }> = []
  for (const rel of [...snap.notes].sort()) {
    const { fm } = parsePage(await readFile(path.join(KB_ROOT, rel), 'utf8'))
    out.push({
      path: rel,
      title: (fm['title'] as string) ?? rel.replace(/^notes\//, '').replace(/\.md$/, ''),
      updatedAt: (fm['updated_at'] as string) ?? '',
    })
  }
  return { notes: out }
})

/** 笔记读写（F4 server 侧）：notes/ 由人所有，不走闸门（用户直接写）。
 * 保存时补 frontmatter（type: note）+ log 追加 + git 提交（架构规范：`note: <标题>`） */
app.post('/api/v1/notes', async (req, reply) => {
  const body = req.body as { filename?: string; content?: string; title?: string }
  if (!body?.filename || typeof body.content !== 'string') {
    return reply.code(400).send({ error: '需要 filename 与 content' })
  }
  if (!/^[\w\u4e00-\u9fff.-]+\.md$/.test(body.filename)) {
    return reply.code(400).send({ error: 'filename 仅允许 .md' })
  }
  await mkdir(path.join(KB_ROOT, 'notes'), { recursive: true })
  const rel = `notes/${body.filename}`
  const abs = path.join(KB_ROOT, rel)
  // 已有页保留原 frontmatter（人可自由编辑），新页补 type: note 元信息
  let fm: Record<string, unknown> = { type: 'note', title: body.title ?? body.filename.replace(/\.md$/, ''), created_at: new Date().toISOString() }
  try {
    const prev = await readFile(abs, 'utf8')
    const parsed = parsePage(prev)
    if (parsed.fm && Object.keys(parsed.fm).length > 0) fm = { ...parsed.fm, title: body.title ?? parsed.fm['title'] }
  } catch { /* 新文件 */ }
  fm['updated_at'] = new Date().toISOString()
  const { fm: curFm, body: curBody } = parsePage(body.content)
  const merged = { ...curFm, ...fm }
  await writeFile(abs, serializePage(merged, `\n${curBody.trim()}\n`), 'utf8')
  const title = (merged['title'] as string) ?? body.filename
  await appendFile(path.join(KB_ROOT, 'log.md'), renderLogEntry('note', title.slice(0, 60)), 'utf8')
  const commitSha = await gitCommitAll(KB_ROOT, `note: ${title}`)
  bus.emit('note:saved', rel)
  return { ok: true, path: rel, commitSha }
})

/** 库状态快照（前端建库后首页用） */
app.get('/api/v1/kb/status', async () => {
  const snap = await scanKb(KB_ROOT)
  return {
    pages: snap.pages.size,
    sources: snap.sources.size,
    reviewed: snap.reviewedPages.size,
  }
})

// ---------- D10-11: Review Queue（AI 生成页默认待审，人把关） ----------

/** wiki 页清单（含 reviewed 状态），供队列筛选 */
async function listWikiPages() {
  const snap = await scanKb(KB_ROOT)
  const out: Array<{ path: string; title: string; type: string; updatedAt: string; reviewed: boolean }> = []
  for (const rel of [...snap.pages].sort()) {
    const { fm } = parsePage(await readFile(path.join(KB_ROOT, rel), 'utf8'))
    out.push({
      path: rel,
      title: (fm['title'] as string) ?? rel,
      type: (fm['type'] as string) ?? 'page',
      updatedAt: (fm['updated_at'] as string) ?? (fm['ingested_at'] as string) ?? '',
      reviewed: fm['reviewed'] === true,
    })
  }
  return out
}

/** 审核队列：reviewed !== true 的 AI 生成页（wiki/ 全部机生，notes/ 不在内） */
app.get('/api/v1/review-queue', async () => {
  const all = await listWikiPages()
  return {
    queue: all.filter((p) => !p.reviewed),
    reviewedCount: all.length - all.filter((p) => !p.reviewed).length,
  }
})

interface ReviewBody {
  path: string // wiki/xxx/yyy.md
  action: 'approve' | 'reject'
}

app.post('/api/v1/review', async (req, reply) => {
  const body = req.body as ReviewBody
  const rel = body?.path ?? ''
  if (!rel.startsWith('wiki/') || !rel.endsWith('.md') || rel.includes('..')) {
    return reply.code(400).send({ error: 'path 必须是 wiki/ 下的 .md 页面' })
  }
  const abs = path.join(KB_ROOT, rel)
  const title = rel.split('/').pop()?.replace(/\.md$/, '') ?? rel
  if (body.action === 'approve') {
    let text: string
    try {
      text = await readFile(abs, 'utf8')
    } catch {
      return reply.code(404).send({ error: `页面不存在：${rel}` })
    }
    const { fm, body: pageBody } = parsePage(text)
    fm['reviewed'] = true
    fm['updated_at'] = new Date().toISOString()
    await writeFile(abs, serializePage(fm, pageBody), 'utf8')
    await appendFile(path.join(KB_ROOT, 'log.md'), renderLogEntry('review', `通过 ${title}`), 'utf8')
    const commitSha = await gitCommitAll(KB_ROOT, `review: approve ${rel}`)
    bus.emit('review:done', rel)
    return { ok: true, action: 'approve', path: rel, commitSha }
  }
  if (body.action === 'reject') {
    // 驳回 = 删除该 AI 生成页（闸门外的人工纠错），log 留痕可追溯
    try {
      await unlink(abs)
    } catch {
      return reply.code(404).send({ error: `页面不存在：${rel}` })
    }
    await appendFile(path.join(KB_ROOT, 'log.md'), renderLogEntry('review', `驳回并删除 ${title}`), 'utf8')
    const commitSha = await gitCommitAll(KB_ROOT, `review: reject ${rel}`)
    bus.emit('review:done', rel)
    return { ok: true, action: 'reject', path: rel, commitSha }
  }
  return reply.code(400).send({ error: 'action 仅允许 approve/reject' })
})

/** 操作流水（log.md）解析为结构化时间线，新在前 */
app.get('/api/v1/log', async () => {
  const text = await readFile(path.join(KB_ROOT, 'log.md'), 'utf8').catch(() => '')
  const entries: Array<{ ts: string; op: string; title: string }> = []
  for (const m of text.matchAll(/^## \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] (\w+) \| (.+)$/gm)) {
    const [ts, op, title] = m.slice(1)
    if (ts && op && title) entries.push({ ts, op, title })
  }
  return { entries: entries.reverse().slice(0, 100) }
})

app.get('/api/v1/pages/*', async (req, reply) => {
  const rel = (req.params as { '*': string })['*']
  if (!rel.endsWith('.md')) {
    return reply.code(400).send({ error: '只允许读取 .md 页面' })
  }
  const abs = path.normalize(path.join(KB_ROOT, rel))
  if (!abs.startsWith(path.resolve(KB_ROOT) + path.sep)) {
    return reply.code(403).send({ error: '路径越界' })
  }
  try {
    const text = await readFile(abs, 'utf8')
    return { path: rel, content: text }
  } catch {
    return reply.code(404).send({ error: '页面不存在' })
  }
})

app.listen({ port: PORT, host: '127.0.0.1' }).then(async () => {
  await mkdir(KB_ROOT, { recursive: true })
  await ensureKbGit(KB_ROOT)
  console.log(`knowledge-engine server listening on http://127.0.0.1:${PORT} (KB: ${KB_ROOT})`)
})
