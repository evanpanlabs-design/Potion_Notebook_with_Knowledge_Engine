import Fastify from 'fastify'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import process from 'node:process'

import { initKb, scanKb } from '@ke/core'
import { createRouting } from '@ke/agent-tools'
import { ingestSource } from './ingest-pipeline.ts'

/**
 * server 入口（D2-4e）。本地单用户，绑 127.0.0.1，无鉴权。
 * API 契约 = ARCHITECTURE §8（MVP 子集）：
 *   POST /api/v1/kb            建库（幂等）
 *   POST /api/v1/sources       摄入素材（写 sources/，不触发 ingest）
 *   POST /api/v1/ingest        对一个 source 跑两段式 ingest
 *   GET  /api/v1/health
 *   GET  /api/v1/pages/*path   只读页面
 */

const KB_ROOT = process.env.KNOWLEDGE_BASE ?? path.resolve('data/my-wiki')
const PORT = Number(process.env.PORT ?? 3100)

const app = Fastify({ logger: false })
/** 全局事件总线：SSE 层（后续接入 web）与缓存失效逻辑订阅 */
export const bus = new EventEmitter()

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

/** 库状态快照（前端建库后首页用） */
app.get('/api/v1/kb/status', async () => {
  const snap = await scanKb(KB_ROOT)
  return {
    pages: snap.pages.size,
    sources: snap.sources.size,
    reviewed: snap.reviewedPages.size,
  }
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

app.listen({ port: PORT, host: '127.0.0.1' }).then(() => {
  console.log(`knowledge-engine server listening on http://127.0.0.1:${PORT} (KB: ${KB_ROOT})`)
})
