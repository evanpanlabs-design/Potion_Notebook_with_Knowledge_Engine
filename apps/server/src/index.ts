import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { readFile, writeFile, appendFile, mkdir, unlink, access, stat } from 'node:fs/promises'
import { accessSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import process from 'node:process'

import { initKb, scanKb, parsePage, renderLogEntry, serializePage } from '@ke/core'
import { normalizeSchedule, describeSchedule, describeRelative, type ScheduledTask } from '@ke/core'
import { parseLlmJson } from '@ke/core'
import { createRouting, collectText } from '@ke/agent-tools'
import { ingestSource, gitCommitAll } from './ingest-pipeline.ts'
import { answerQuery, buildGraphData } from './query-pipeline.ts'
import { answerWithAgent } from './agent-query.ts'
import { resolveTavilyConfig, saveTavilyConfig, TAVILY_MONTHLY_LIMIT, type TavilyConfig } from './agent-tools.ts'
import { createTavilyClient } from '@ke/agent-tools'
import { resolveLlmConfig, saveLlmConfig, maskApiKey, mergeApiKey, type LlmConfigFile, type LlmRoleConfig } from './llm-config.ts'
import { syncPage, runReworkBatch, getReworkState } from './maintain-pipeline.ts'
import { startScheduler, type SchedulerHandle } from './scheduler.ts'
import { createDigestRunner } from './digest-runner.ts'
import { listInbox, readInboxItem, digestInboxItem } from './inbox.ts'
import { runAudit, getAuditState } from './audit-pipeline.ts'
import { addUserSuggestion, removeSuggestion, readSuggestions } from './suggest.ts'
import { listBulletins, createBulletin, setBulletinStatus, replyBulletin } from './bulletin.ts'
import {
  readMineruKey, writeMineruKey, maskMineruKey, checkUploadQuota,
  testMineruConnectivity, uploadFilesToMineru, pollBatchResults, fetchMarkdownFromZip,
  readTasks, writeTasks, type MineruTask,
} from './mineru.ts'

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
/** data/ 根（mineru-config.json、mineru-tasks.json 存这里，与 KB git 仓库隔离） */
const DATA_ROOT = path.resolve(KB_ROOT, '..')
const PORT = Number(process.env.PORT ?? 3100)

const app = Fastify({ logger: false })
/** MinerU PDF 上传（≤200MB/文件，官方上限） */
app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 20 } })
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

/** LLM 路由：设置页文件配置 > 环境变量；都没有则报错提示去设置页配置 */
async function llmRouting() {
  const { config } = await resolveLlmConfig()
  if (!config) {
    throw new Error('尚未配置 LLM：请打开「设置」页填写并保存，或设置 LLM_BASE_URL/LLM_API_KEY 环境变量')
  }
  return createRouting(config)
}

app.get('/api/v1/llm-config', async () => {
  const { config, source } = await resolveLlmConfig()
  if (!config) return { source, hasConfig: false }
  const view = (r: LlmRoleConfig) => ({
    protocol: r.protocol,
    baseUrl: r.baseUrl,
    apiKey: maskApiKey(r.apiKey),
    model: r.model,
  })
  return { source, hasConfig: true, ingest: view(config.ingest), query: view(config.query) }
})

interface LlmConfigBody {
  ingest: LlmRoleConfig
  query: LlmRoleConfig
}

app.post('/api/v1/llm-config', async (req, reply) => {
  const body = req.body as LlmConfigBody
  const roles = ['ingest', 'query'] as const
  for (const role of roles) {
    const r = body?.[role]
    if (!r || typeof r.baseUrl !== 'string' || !r.baseUrl.trim() || typeof r.model !== 'string' || !r.model.trim()) {
      return reply.code(400).send({ error: `${role}：baseUrl 与 model 必填` })
    }
    if (r.protocol !== 'openai' && r.protocol !== 'anthropic') {
      return reply.code(400).send({ error: `${role}：protocol 仅支持 openai / anthropic` })
    }
  }
  const { config: existing } = await resolveLlmConfig()
  const next: LlmConfigFile = {
    ingest: {
      protocol: body.ingest.protocol,
      baseUrl: body.ingest.baseUrl.trim(),
      apiKey: mergeApiKey(body.ingest.apiKey, existing?.ingest.apiKey),
      model: body.ingest.model.trim(),
    },
    query: {
      protocol: body.query.protocol,
      baseUrl: body.query.baseUrl.trim(),
      apiKey: mergeApiKey(body.query.apiKey, existing?.query.apiKey),
      model: body.query.model.trim(),
    },
  }
  for (const role of roles) {
    if (!next[role].apiKey) return reply.code(400).send({ error: `${role}：apiKey 必填（首次配置）` })
  }
  await saveLlmConfig(next)
  return { ok: true, note: '已保存到 data/llm-config.json，立即生效（无需重启）' }
})

interface LlmTestBody {
  role: 'ingest' | 'query'
  /** 可选：测试未保存的草稿配置；缺省则测试当前生效配置 */
  config?: LlmRoleConfig
}

app.post('/api/v1/llm-config/test', async (req, reply) => {
  const body = req.body as LlmTestBody
  const role = body?.role
  if (role !== 'ingest' && role !== 'query') return reply.code(400).send({ error: 'role 必须是 ingest 或 query' })
  let target: LlmRoleConfig | undefined = body.config
  if (target && (!target.apiKey || target.apiKey.includes('••'))) {
    // 草稿里 apiKey 被打码/留空：与已存配置合并后再测
    const { config } = await resolveLlmConfig()
    target = config ? { ...target, apiKey: mergeApiKey(target.apiKey, config[role].apiKey) } : target
  }
  if (!target) {
    const { config } = await resolveLlmConfig()
    target = config?.[role]
    if (!target) return reply.code(400).send({ error: '当前无已保存配置，请在表单里填写完整后再测' })
  }
  if (!target.baseUrl?.trim() || !target.model?.trim() || !target.apiKey?.trim()) {
    return reply.code(400).send({ error: '测试需要完整配置：baseUrl / apiKey / model' })
  }
  const started = Date.now()
  try {
    const routing = createRouting({ ingest: target, query: target })
    const stream = routing.stream(role, undefined, [{ role: 'user', text: '连通性测试：请只回复两个字母 pong' }])
    const { text, usage } = await collectText(stream)
    return {
      ok: true,
      latencyMs: Date.now() - started,
      model: target.model,
      protocol: target.protocol,
      sample: text.slice(0, 120),
      usage,
    }
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: String((e as Error).message ?? e).slice(0, 500),
    }
  }
})

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
  if (!/^[\w\u4e00-\u9fff.-]+(\.md|\.txt)$/.test(body.filename)) {
    return reply.code(400).send({ error: 'filename 仅允许 .md/.txt（支持中文名）' })
  }
  await mkdir(path.join(KB_ROOT, 'sources'), { recursive: true })
  await writeFile(path.join(KB_ROOT, 'sources', body.filename), body.content, 'utf8')
  bus.emit('source:added', body.filename)
  return { ok: true, path: `sources/${body.filename}` }
})

interface IngestBody {
  source: string // sources/xxx.md
}

/** 原始素材列表（v0.2.5 素材页）：文件名 + 大小 + 更新时间 */
app.get('/api/v1/sources', async () => {
  const snap = await scanKb(KB_ROOT)
  const out = []
  for (const rel of snap.sources) {
    const abs = path.join(KB_ROOT, rel)
    const st = await stat(abs).catch(() => null)
    out.push({
      path: rel,
      name: rel.replace(/^sources\//, ''),
      size: st?.size ?? 0,
      updatedAt: st?.mtime.toISOString() ?? '',
    })
  }
  return { sources: out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }
})

// ---------------------------------------------------------------------------
// MinerU PDF 解析（v0.2.5）：上传 PDF → MinerU 结构化解析 → full.md 落盘 sources/ → 自动 ingest
// ---------------------------------------------------------------------------

const MINERU_ACTIVE_STATES = new Set(['pending', 'waiting-file', 'pending-file', 'running', 'converting'])
/** 正在后台跑 ingest 的 source（防重复触发） */
const mineruIngestInFlight = new Set<string>()

/** source 名清洗 + 落盘冲突时加时间戳后缀 */
function mineruSourcePath(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[^\w一-鿿.-]+/g, '-').slice(0, 80) || 'converted'
  const candidate = `sources/${base}.md`
  try {
    accessSync(path.join(KB_ROOT, candidate))
    return `sources/${base}-${Date.now()}.md`
  } catch {
    return candidate
  }
}

app.get('/api/v1/mineru/config', async () => {
  const key = await readMineruKey(DATA_ROOT)
  return { hasKey: Boolean(key), masked: key ? maskMineruKey(key) : null }
})

app.post('/api/v1/mineru/config', async (req, reply) => {
  const body = req.body as { apiKey?: string }
  const next = body?.apiKey?.trim() ?? ''
  const existing = await readMineruKey(DATA_ROOT)
  // 打码/留空 = 保留已存 Key（与 LLM 配置同一交互）
  if (!next || next.includes('••')) {
    if (!existing) return reply.code(400).send({ error: 'apiKey 不能为空' })
    return { ok: true, masked: maskMineruKey(existing) }
  }
  await writeMineruKey(DATA_ROOT, next)
  return { ok: true, masked: maskMineruKey(next) }
})

interface MineruTestBody { apiKey?: string }

app.post('/api/v1/mineru/config/test', async (req, reply) => {
  const body = req.body as MineruTestBody
  let key = body?.apiKey?.trim() ?? ''
  if (!key || key.includes('••')) key = (await readMineruKey(DATA_ROOT)) ?? ''
  if (!key) return reply.code(400).send({ ok: false, message: '尚未配置 API Key' })
  return testMineruConnectivity(key)
})

// ---------------------------------------------------------------------------
// Tavily 联网检索配置（ADR-003 D1）：key + 开关 + 月度用量
// ---------------------------------------------------------------------------

function maskTavilyKey(key: string): string {
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 6)}••••${key.slice(-4)}`
}

app.get('/api/v1/tavily/config', async () => {
  const cfg = await resolveTavilyConfig(DATA_ROOT)
  const month = new Date().toISOString().slice(0, 7)
  return {
    hasKey: Boolean(cfg.apiKey),
    masked: cfg.apiKey ? maskTavilyKey(cfg.apiKey) : null,
    enabled: cfg.enabled,
    usedCount: cfg.usedMonth === month ? cfg.usedCount : 0,
    limit: TAVILY_MONTHLY_LIMIT,
  }
})

app.post('/api/v1/tavily/config', async (req, reply) => {
  const body = req.body as { apiKey?: string; enabled?: boolean }
  const cur = await resolveTavilyConfig(DATA_ROOT)
  const patch: Partial<TavilyConfig> = {}
  const next = body?.apiKey?.trim() ?? ''
  if (next && !next.includes('••')) patch.apiKey = next // 留空/打码 = 沿用
  if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled
  if (!next && !cur.apiKey) {
    if (body?.enabled) return reply.code(400).send({ error: '启用联网检索前需先配置 API Key' })
  }
  const saved = await saveTavilyConfig(DATA_ROOT, patch)
  return { ok: true, masked: saved.apiKey ? maskTavilyKey(saved.apiKey) : null, enabled: saved.enabled }
})

app.post('/api/v1/tavily/config/test', async (req, reply) => {
  const body = req.body as { apiKey?: string }
  let key = body?.apiKey?.trim() ?? ''
  if (!key || key.includes('••')) key = (await resolveTavilyConfig(DATA_ROOT)).apiKey
  if (!key) return reply.code(400).send({ ok: false, message: '尚未配置 API Key' })
  const started = Date.now()
  try {
    const client = createTavilyClient(key)
    const r = await client.search('hello world', { maxResults: 1 })
    return { ok: true, latencyMs: Date.now() - started, hits: r.hits.length, sample: r.hits[0]?.title?.slice(0, 80) ?? '' }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
})

/** PDF/图片 → MinerU 结构化解析任务。multipart 字段名 files（可多文件）。 */
app.post('/api/v1/mineru/convert', async (req, reply) => {
  const apiKey = await readMineruKey(DATA_ROOT)
  if (!apiKey) return reply.code(400).send({ error: '尚未配置 MinerU API Key，请到「设置」页填写' })
  const files: Array<{ name: string; bytes: Buffer }> = []
  try {
    // @fastify/multipart：file part 的流必须在迭代内同步消费完，否则迭代器挂起
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue
      const bytes = await part.toBuffer()
      const name = part.filename ?? 'file'
      if (!/\.(pdf|png|jpe?g|jp2|webp|gif|bmp|docx?|pptx?|xlsx?)$/i.test(name)) {
        return reply.code(400).send({ error: `不支持的文件类型：${name}（支持 PDF/图片/Office 文档）` })
      }
      files.push({ name, bytes })
    }
  } catch {
    return reply.code(400).send({ error: '请求不是 multipart 表单' })
  }
  if (files.length === 0) return reply.code(400).send({ error: '未选择文件' })
  try {
    checkUploadQuota(files.length)
  } catch (e) {
    return reply.code(429).send({ error: e instanceof Error ? e.message : String(e) })
  }
  // dataId 唯一化（MinerU 限制：字母数字_- 和点，≤128）
  const stamp = Date.now().toString(36)
  const enriched = files.map((f, i) => ({
    ...f,
    dataId: `${f.name.replace(/[^\w.-]+/g, '-').slice(0, 80)}-${stamp}-${i}`.replace(/^[^A-Za-z0-9_]+/, 'f'),
  }))
  try {
    const batchId = await uploadFilesToMineru(apiKey, enriched)
    const now = new Date().toISOString()
    const tasks = await readTasks(DATA_ROOT)
    for (const f of enriched) {
      tasks.push({
        batchId,
        fileName: f.name,
        dataId: f.dataId,
        state: 'pending',
        createdAt: now,
        updatedAt: now,
      })
    }
    await writeTasks(DATA_ROOT, tasks)
    return { ok: true, batchId, count: enriched.length }
  } catch (e) {
    req.log.error(e)
    return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) })
  }
})

/** 任务列表 + 惰性轮询：GET 时顺带查 MinerU 更新状态；done 的下载 zip 抽 full.md
 *  落盘 sources/ 并后台自动 ingest（结果经 SSE 引擎浮层可见）。 */
app.get('/api/v1/mineru/tasks', async (req, reply) => {
  const apiKey = await readMineruKey(DATA_ROOT)
  if (!apiKey) return { tasks: [] }
  const tasks = await readTasks(DATA_ROOT)
  // 按 batchId 分组出未完成任务，一次 extract-results/batch 查一批（省配额）
  const activeBatches = new Set(tasks.filter((t) => MINERU_ACTIVE_STATES.has(t.state)).map((t) => t.batchId))
  for (const batchId of activeBatches) {
    let results: Awaited<ReturnType<typeof pollBatchResults>> = []
    try {
      results = await pollBatchResults(apiKey, batchId)
    } catch (e) {
      req.log.warn(`MinerU 轮询失败：${e instanceof Error ? e.message : e}`)
      continue
    }
    for (const t of tasks.filter((x) => x.batchId === batchId && MINERU_ACTIVE_STATES.has(x.state))) {
      const r = results.find((x) => (x.dataId && x.dataId === t.dataId) || x.fileName === t.fileName)
      if (!r || r.state === t.state) continue
      t.state = r.state
      t.errMsg = r.errMsg
      t.updatedAt = new Date().toISOString()
      if (r.state === 'done' && r.fullZipUrl && !t.sourcePath) {
        try {
          const md = await fetchMarkdownFromZip(r.fullZipUrl)
          const rel = mineruSourcePath(t.fileName)
          await writeFile(path.join(KB_ROOT, rel), md, 'utf8')
          t.sourcePath = rel
          await gitCommitAll(KB_ROOT, `mineru: convert ${t.fileName} -> ${rel}`)
          bus.emit('source:added', rel)
          // 后台自动 ingest（衔接两段式管线；进度走 SSE 引擎浮层）
          const src = rel
          if (!mineruIngestInFlight.has(src)) {
            mineruIngestInFlight.add(src)
            ingestSource({ kbRoot: KB_ROOT, routing: await llmRouting(), events: bus }, src)
              .then(() => {
                t.ingested = true
                t.updatedAt = new Date().toISOString()
                return writeTasks(DATA_ROOT, tasks)
              })
              .catch((err) => req.log.warn(`MinerU 自动 ingest 失败（${src}）：${err instanceof Error ? err.message : err}`))
              .finally(() => mineruIngestInFlight.delete(src))
          }
        } catch (e) {
          t.state = 'failed'
          t.errMsg = `解析结果落盘失败：${e instanceof Error ? e.message : e}`
        }
      }
    }
    await writeTasks(DATA_ROOT, tasks)
  }
  // 补偿：已落盘但未消化的任务（服务重启中断了后台 ingest），轮询时续接
  for (const t of tasks) {
    if (!t.sourcePath || t.ingested || mineruIngestInFlight.has(t.sourcePath)) continue
    const src = t.sourcePath
    try {
      const routing = await llmRouting()
      mineruIngestInFlight.add(src)
      ingestSource({ kbRoot: KB_ROOT, routing, events: bus }, src)
        .then(() => {
          t.ingested = true
          t.updatedAt = new Date().toISOString()
          return writeTasks(DATA_ROOT, tasks)
        })
        .catch((err) => req.log.warn(`MinerU 补偿 ingest 失败（${src}）：${err instanceof Error ? err.message : err}`))
        .finally(() => mineruIngestInFlight.delete(src))
    } catch (e) {
      req.log.warn(`MinerU 补偿 ingest 跳过（LLM 未配置？）：${e instanceof Error ? e.message : e}`)
    }
  }
  return { tasks: tasks.slice().reverse() } // 新任务在前
})

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
    const outcome = await ingestSource({ kbRoot: KB_ROOT, routing: await llmRouting(), events: bus }, body.source)
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
    const outcome = await answerQuery({ kbRoot: KB_ROOT, routing: await llmRouting(), events: bus }, body.question, { archive: body.archive })
    return outcome
  } catch (e) {
    req.log.error(e)
    return reply.code(500).send({ error: String((e as Error).message ?? e) })
  }
})

/** Agent 多步问答（ADR-003 D1）：工具调用式研究管道；事件经 bus 广播（agent:*） */
app.post('/api/v1/agent-query', async (req, reply) => {
  const body = req.body as { question?: string }
  if (!body?.question?.trim()) {
    return reply.code(400).send({ error: '需要 question' })
  }
  try {
    const routing = await llmRouting()
    const outcome = await answerWithAgent({ kbRoot: KB_ROOT, dataRoot: DATA_ROOT, routing, events: bus }, body.question)
    return outcome
  } catch (e) {
    req.log.error(e)
    return reply.code(500).send({ error: String((e as Error).message ?? e) })
  }
})

// ---------------------------------------------------------------------------
// 定时任务（ADR-003 D2-3）：意图解析 + CRUD + 手动触发；调度器在 listen 后启动
// ---------------------------------------------------------------------------

let scheduler: SchedulerHandle | null = null

const PARSE_PROMPT = `你是任务意图解析器。判断用户输入是否是「定时任务请求」（让 AI 周期性自动执行的事，如每天搜资讯生成日报），并提取结构化字段。

只输出一个 JSON 对象（不要多余文本）：
{
  "isSchedule": true,
  "kind": "digest",
  "title": "简短任务名（12字内）",
  "topic": "搜索主题（如：AI 资讯）",
  "query": "可选：具体搜索词，用户没给就省略该字段",
  "schedule": { "type": "daily", "at": "07:00" }
}

schedule 只有两种形状：每天定时 { "type": "daily", "at": "HH:MM" }（24小时制）；固定间隔 { "type": "interval", "hours": N }。

判断规则：
- 「每天早上7点搜AI资讯」「每晚十点给我份日报」→ isSchedule=true
- 「每小时」「每6小时」→ interval；小时数取用户说的，没说默认 1
- 「每天」但没给时刻 → at 默认 "08:00"
- 只是一次性提问（哪怕提到“最新资讯”，但没有周期性词）→ isSchedule=false，其余字段省略
- kind 目前只有 "digest"（搜索/资讯/日报/快报类）；非搜索类也先置 digest 并在 topic 里描述`

interface TaskParseBody { text?: string }

/** 意图解析：文本 → 结构化任务定义（便宜模型，ingest 路由） */
app.post('/api/v1/tasks/parse', async (req, reply) => {
  const body = req.body as TaskParseBody
  const text = body?.text?.trim()
  if (!text) return reply.code(400).send({ error: '需要 text' })
  try {
    const routing = await llmRouting()
    const { text: raw } = await collectText(
      routing.stream('ingest', PARSE_PROMPT, [{ role: 'user', text: `用户输入：${text}` }]),
    )
    const parsed = parseLlmJson<{
      isSchedule?: boolean
      kind?: string
      title?: string
      topic?: string
      query?: string
      schedule?: unknown
    }>(raw)
    if (!parsed?.isSchedule) return { isSchedule: false }
    const schedule = normalizeSchedule(parsed.schedule)
    if (!schedule) {
      return { isSchedule: false, note: '未能解析出有效的排程时刻，请直接向知识库提问' }
    }
    return {
      isSchedule: true,
      kind: 'digest' as const,
      title: (parsed.title ?? text.slice(0, 12)).slice(0, 60),
      topic: (parsed.topic ?? text.slice(0, 40)).slice(0, 120),
      query: parsed.query?.slice(0, 200),
      schedule,
      scheduleDesc: describeSchedule(schedule),
    }
  } catch (e) {
    // 解析失败不拦截提问：降级为普通问答
    return { isSchedule: false, note: `意图解析失败：${(e as Error).message.slice(0, 120)}` }
  }
})

interface TaskCreateBody {
  title?: string
  topic?: string
  query?: string
  schedule?: unknown
  enabled?: boolean
}

function taskView(t: ScheduledTask) {
  return {
    ...t,
    scheduleDesc: describeSchedule(t.schedule),
    nextDueIn: t.nextDue ? describeRelative(t.nextDue) : null,
    lastRunAgo: t.lastRunAt ? describeRelative(t.lastRunAt) : null,
    lastOutcome: t.history[0]?.outcome ?? null,
    lastNote: t.history[0]?.note ?? null,
    lastArtifact: t.history[0]?.artifact ?? null,
  }
}

app.get('/api/v1/tasks', async () => {
  if (!scheduler) return { tasks: [] }
  const tasks = await scheduler.store.list()
  return { tasks: tasks.map(taskView) }
})

app.post('/api/v1/tasks', async (req, reply) => {
  if (!scheduler) return reply.code(503).send({ error: '调度器未就绪' })
  const body = req.body as TaskCreateBody
  const schedule = normalizeSchedule(body?.schedule)
  if (!schedule) return reply.code(400).send({ error: 'schedule 无效：需要 { type: daily, at: HH:MM } 或 { type: interval, hours: N }' })
  if (!body?.topic?.trim()) return reply.code(400).send({ error: '需要 topic' })
  const task = await scheduler.store.create({
    kind: 'digest',
    title: body.title?.trim() || body.topic.trim().slice(0, 12),
    topic: body.topic.trim(),
    query: body.query?.trim() || undefined,
    schedule,
    enabled: body.enabled ?? true,
  })
  return { task: taskView(task) }
})

app.delete('/api/v1/tasks/:id', async (req, reply) => {
  if (!scheduler) return reply.code(503).send({ error: '调度器未就绪' })
  const ok = await scheduler.store.remove((req.params as { id: string }).id)
  if (!ok) return reply.code(404).send({ error: '任务不存在' })
  return { ok: true }
})

app.post('/api/v1/tasks/:id', async (req, reply) => {
  if (!scheduler) return reply.code(503).send({ error: '调度器未就绪' })
  const body = req.body as { enabled?: boolean }
  if (typeof body?.enabled !== 'boolean') return reply.code(400).send({ error: '需要 enabled 布尔值' })
  const t = await scheduler.store.setEnabled((req.params as { id: string }).id, body.enabled)
  if (!t) return reply.code(404).send({ error: '任务不存在' })
  return { task: taskView(t) }
})

app.post('/api/v1/tasks/:id/run', async (req, reply) => {
  if (!scheduler) return reply.code(503).send({ error: '调度器未就绪' })
  try {
    const rec = await scheduler.runNow((req.params as { id: string }).id)
    const t = await scheduler.store.get((req.params as { id: string }).id)
    return { record: rec, task: t ? taskView(t) : null }
  } catch (e) {
    return reply.code(500).send({ error: (e as Error).message })
  }
})

// ---------- D4-5：收件箱（inbox/ 只读 + 消化进图谱） ----------

app.get('/api/v1/inbox', async () => {
  return { items: await listInbox(KB_ROOT) }
})

app.get('/api/v1/inbox/*', async (req, reply) => {
  const rel = (req.params as { '*': string })['*']
  const item = await readInboxItem(KB_ROOT, `inbox/${rel}`)
  if (!item) return reply.code(404).send({ error: '收件项不存在' })
  return item
})

/** 消化进图谱：证据页走既有 ingest 管线（闸门/幂等/待审全部沿用） */
app.post('/api/v1/inbox/*/digest', async (req, reply) => {
  const rel = `inbox/${(req.params as { '*': string })['*']}`
  try {
    const routing = await llmRouting()
    const outcome = await digestInboxItem({ kbRoot: KB_ROOT, routing }, rel)
    if (outcome.writtenPages.length > 0 || outcome.alreadyDigested) {
      await appendFile(path.join(KB_ROOT, 'log.md'), renderLogEntry('digest', `${rel} → ${outcome.digestOutcome}`.slice(0, 80)), 'utf8')
    }
    return outcome
  } catch (e) {
    return reply.code(500).send({ error: String((e as Error).message ?? e) })
  }
})

// ---------- D6-7：graph audit（体检 → LLM 判定 → 建议写 suggestions） ----------

/** 从库快照读页面语料（audit 用；query 归档页过期的不算知识节点） */
async function loadPageDocsFrom(snap: { pages: Set<string> }): Promise<import('@ke/core').PageDoc[]> {
  const out: import('@ke/core').PageDoc[] = []
  const now = Date.now()
  for (const rel of snap.pages) {
    const { fm, body } = parsePage(await readFile(path.join(KB_ROOT, rel), 'utf8'))
    const expires = fm['expires_at'] as string | undefined
    if (fm['type'] === 'query' && expires && Date.parse(expires) < now) continue
    out.push({
      path: rel,
      title: (fm['title'] as string) ?? rel,
      aliases: (fm['aliases'] as string[]) ?? [],
      tags: (fm['tags'] as string[]) ?? [],
      body,
    })
  }
  return out
}

/** 手动触发图谱自检（异步跑，状态走 GET audit/status 轮询） */
app.post('/api/v1/graph/audit', async (req, reply) => {
  try {
    const routing = await llmRouting()
    // 重新扫库（audit 期间库可能已变）
    const snap = await scanKb(KB_ROOT)
    const pages = await loadPageDocsFrom(snap)
    void runAudit({ kbRoot: KB_ROOT, dataRoot: DATA_ROOT, routing }, pages)
      .then(async (outcome) => {
        await appendFile(path.join(KB_ROOT, 'log.md'), renderLogEntry('audit', `自检：${outcome.health.findings} 嫌疑 → ${outcome.proposals} 建议 → ${outcome.suggestionsWritten.length} 页落盘`), 'utf8')
      })
      .catch(() => {})
    return { started: true }
  } catch (e) {
    return reply.code(500).send({ error: String((e as Error).message ?? e) })
  }
})

app.get('/api/v1/graph/audit/status', async () => {
  const s = getAuditState()
  return { running: s.running, startedAt: s.startedAt, lastOutcome: s.lastOutcome }
})

/** 页面 suggestions 读取（审核视角：带 audit 建议的页面清单） */
app.get('/api/v1/graph/suggestions', async () => {
  const snap = await scanKb(KB_ROOT)
  const out: Array<{ path: string; title: string; suggestions: unknown[] }> = []
  for (const rel of snap.pages) {
    const { fm } = parsePage(await readFile(path.join(KB_ROOT, rel), 'utf8'))
    const sug = Array.isArray(fm['suggestions']) ? (fm['suggestions'] as unknown[]) : []
    if (sug.length > 0) out.push({ path: rel, title: (fm['title'] as string) ?? rel, suggestions: sug })
  }
  return { pages: out }
})

// ---------- D8-9：人工维护建议（suggestions 泛化：用户可留，与 audit 同池） ----------

interface UserSuggestionBody {
  note?: string
}

app.get('/api/v1/pages/*/suggestions', async (req, reply) => {
  const rel = (req.params as { '*': string })['*']
  try {
    return { suggestions: await readSuggestions(KB_ROOT, rel) }
  } catch (e) {
    return reply.code(400).send({ error: String((e as Error).message ?? e) })
  }
})

app.post('/api/v1/pages/*/suggestions', async (req, reply) => {
  const rel = (req.params as { '*': string })['*']
  const body = req.body as UserSuggestionBody
  try {
    const suggestions = await addUserSuggestion(KB_ROOT, rel, String(body?.note ?? ''))
    const title = rel.split('/').pop()?.replace(/\.md$/, '') ?? rel
    await appendFile(path.join(KB_ROOT, 'log.md'), renderLogEntry('review', `留建议 ${title}`), 'utf8')
    return { suggestions }
  } catch (e) {
    const msg = String((e as Error).message ?? e)
    return reply.code(msg.includes('ENOENT') ? 404 : 400).send({ error: msg })
  }
})

app.delete('/api/v1/pages/*/suggestions/:index', async (req, reply) => {
  const rel = (req.params as { '*': string; index: string })['*']
  const index = Number((req.params as { index: string }).index)
  try {
    const suggestions = await removeSuggestion(KB_ROOT, rel, index)
    return { suggestions }
  } catch (e) {
    return reply.code(400).send({ error: String((e as Error).message ?? e) })
  }
})

// ---------- D10-11：bulletin board（用户与 AI 异步交互便利贴） ----------

app.get('/api/v1/bulletins', async () => {
  return { bulletins: await listBulletins(KB_ROOT) }
})

interface BulletinBody {
  text?: string
  kind?: 'directive' | 'todo' | 'request' | 'note'
  ttlDays?: number
}

app.post('/api/v1/bulletins', async (req, reply) => {
  const body = req.body as BulletinBody
  try {
    const b = await createBulletin(KB_ROOT, {
      author: 'user',
      kind: body?.kind ?? 'note',
      text: String(body?.text ?? ''),
      ttlDays: typeof body?.ttlDays === 'number' ? body.ttlDays : 7,
    })
    const title = b.text.slice(0, 40)
    await appendFile(path.join(KB_ROOT, 'log.md'), renderLogEntry('bulletin', `留言 ${title}`), 'utf8')
    bus.emit('bulletin:created', { id: b.id, title })
    return { bulletin: b }
  } catch (e) {
    return reply.code(400).send({ error: String((e as Error).message ?? e) })
  }
})

app.post('/api/v1/bulletins/:id/status', async (req, reply) => {
  const body = req.body as { status?: 'open' | 'done' | 'dropped' | 'replied' }
  if (!body?.status) return reply.code(400).send({ error: '需要 status' })
  try {
    const b = await setBulletinStatus(KB_ROOT, (req.params as { id: string }).id, body.status)
    return { bulletin: b }
  } catch (e) {
    const msg = String((e as Error).message ?? e)
    return reply.code(msg.includes('ENOENT') ? 404 : 400).send({ error: msg })
  }
})

app.post('/api/v1/bulletins/:id/reply', async (req, reply) => {
  const body = req.body as { text?: string }
  try {
    const b = await replyBulletin(KB_ROOT, (req.params as { id: string }).id, 'user', String(body?.text ?? ''))
    return { bulletin: b }
  } catch (e) {
    const msg = String((e as Error).message ?? e)
    return reply.code(msg.includes('ENOENT') ? 404 : 400).send({ error: msg })
  }
})

/** 图谱数据（F7 前端直接消费） */
app.get('/api/v1/graph', async () => buildGraphData(KB_ROOT))

/** 问答历史：wiki/queries/ 归档列表（新在前，排除已过期未及 GC 的）。
 *  v0.2.2：提问入口改为全局悬浮球，本页只做历史陈列。 */
app.get('/api/v1/queries', async () => {
  const snap = await scanKb(KB_ROOT)
  const now = Date.now()
  const out: Array<{ path: string; question: string; createdAt: string; expiresAt: string | null }> = []
  for (const rel of snap.pages) {
    if (!rel.startsWith('wiki/queries/')) continue
    const text = await readFile(path.join(KB_ROOT, rel), 'utf8')
    const { fm } = parsePage(text)
    const exp = typeof fm['expires_at'] === 'string' ? fm['expires_at'] : null
    if (exp && Date.parse(exp) <= now) continue
    out.push({
      path: rel,
      question: String(fm['question'] ?? rel.split('/').pop()?.replace(/\.md$/, '') ?? ''),
      createdAt: String(fm['created_at'] ?? ''),
      expiresAt: exp,
    })
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { queries: out }
})

/** 笔记列表（v0.2）：含项目分层、ingest 同步状态、归档标记。
 *  同步状态：ingested_sha256 与当前内容 hash 比对 → dirty（有改动未消化）/ never（从未消化） */
app.get('/api/v1/notes', async () => {
  const snap = await scanKb(KB_ROOT)
  const { createHash } = await import('node:crypto')
  const out: Array<{
    path: string
    title: string
    updatedAt: string
    project: string
    archived: boolean
    lastIngestedAt: string | null
    syncState: 'synced' | 'dirty' | 'never'
  }> = []
  for (const rel of [...snap.notes].sort()) {
    const text = await readFile(path.join(KB_ROOT, rel), 'utf8')
    const { fm } = parsePage(text)
    const relNoPrefix = rel.replace(/^notes\//, '')
    const dir = relNoPrefix.includes('/') ? (relNoPrefix.split('/')[0] ?? '') : ''
    const ingestedSha = (fm['ingested_sha256'] as string) ?? null
    // 与 syncNote 写入对齐：hash 对正文 body 取（不含 frontmatter），fm 变化不算 dirty
    const curSha = ingestedSha ? createHash('sha256').update(parsePage(text).body.trim()).digest('hex') : null
    out.push({
      path: rel,
      title: (fm['title'] as string) ?? (relNoPrefix.replace(/\.md$/, '').split('/').pop() ?? rel),
      updatedAt: (fm['updated_at'] as string) ?? '',
      project: dir,
      archived: fm['archived'] === true,
      lastIngestedAt: (fm['last_ingested_at'] as string) ?? null,
      syncState: !ingestedSha ? 'never' : curSha === ingestedSha ? 'synced' : 'dirty',
    })
  }
  return { notes: out }
})

/** 笔记读写（F4 server 侧）：notes/ 由人所有，不走闸门（用户直接写）。
 * 保存时补 frontmatter（type: note）+ log 追加 + git 提交（架构规范：`note: <标题>`） */
app.post('/api/v1/notes', async (req, reply) => {
  const body = req.body as { filename?: string; content?: string; title?: string; project?: string }
  if (!body?.filename || typeof body.content !== 'string') {
    return reply.code(400).send({ error: '需要 filename 与 content' })
  }
  if (!/^[\w\u4e00-\u9fff.-]+\.md$/.test(body.filename)) {
    return reply.code(400).send({ error: 'filename 仅允许 .md' })
  }
  // 项目分层（v0.2）：project 非空 → notes/<project>/<name>.md，仅允许一层目录
  const project = (body.project ?? '').trim().replace(/^\/|\/$/g, '')
  if (project && !/^[\w\u4e00-\u9fff-]{1,40}$/.test(project)) {
    return reply.code(400).send({ error: 'project 仅允许中英文/数字/连字符，≤40 字符，不允许嵌套' })
  }
  await mkdir(path.join(KB_ROOT, 'notes', project), { recursive: true })
  const rel = project ? `notes/${project}/${body.filename}` : `notes/${body.filename}`
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

// ---------- v0.2 · 文档工作台 / 同步 / 返修池 / 子图 ----------

/** 笔记归档/取消归档：fm.archived 标记（local-first，不移动文件） */
app.post('/api/v1/notes/archive', async (req, reply) => {
  const body = req.body as { path?: string; archived?: boolean }
  const rel = body?.path ?? ''
  if (!rel.startsWith('notes/') || !rel.endsWith('.md') || rel.includes('..')) {
    return reply.code(400).send({ error: 'path 必须是 notes/ 下的 .md 文件' })
  }
  const abs = path.join(KB_ROOT, rel)
  let text: string
  try {
    text = await readFile(abs, 'utf8')
  } catch {
    return reply.code(404).send({ error: '笔记不存在' })
  }
  const { fm, body: pageBody } = parsePage(text)
  if (body.archived === false) delete fm['archived']
  else fm['archived'] = true
  fm['updated_at'] = new Date().toISOString()
  await writeFile(abs, serializePage(fm, pageBody), 'utf8')
  const commitSha = await gitCommitAll(KB_ROOT, `note: ${body.archived === false ? 'unarchive' : 'archive'} ${rel}`)
  return { ok: true, path: rel, archived: fm['archived'] === true, commitSha }
})

/** 笔记删除：物理 unlink + git 留痕（可从 git 历史恢复） */
app.delete('/api/v1/notes', async (req, reply) => {
  const rel = (req.query as { path?: string }).path ?? ''
  if (!rel.startsWith('notes/') || !rel.endsWith('.md') || rel.includes('..')) {
    return reply.code(400).send({ error: 'path 必须是 notes/ 下的 .md 文件' })
  }
  const abs = path.join(KB_ROOT, rel)
  try {
    await unlink(abs)
  } catch {
    return reply.code(404).send({ error: '笔记不存在' })
  }
  const title = rel.split('/').pop()?.replace(/\.md$/, '') ?? rel
  await appendFile(path.join(KB_ROOT, 'log.md'), renderLogEntry('note', `删除 ${title}`), 'utf8')
  const commitSha = await gitCommitAll(KB_ROOT, `note: delete ${rel}`)
  return { ok: true, path: rel, commitSha }
})

/** 笔记重命名：同目录内改文件名（分组不变）；若 frontmatter title 就是旧文件名则一并同步。
 *  实现 = 新路径写入（带更新后的 frontmatter）+ 旧文件 unlink + git 留痕。 */
app.post('/api/v1/notes/rename', async (req, reply) => {
  const body = req.body as { path?: string; filename?: string }
  const rel = body?.path ?? ''
  if (!rel.startsWith('notes/') || !rel.endsWith('.md') || rel.includes('..')) {
    return reply.code(400).send({ error: 'path 必须是 notes/ 下的 .md 文件' })
  }
  const filename = body?.filename ?? ''
  if (!/^[\w\u4e00-\u9fff.-]+\.md$/.test(filename)) {
    return reply.code(400).send({ error: 'filename 仅允许中英文/数字/连字符/点，且以 .md 结尾' })
  }
  const abs = path.join(KB_ROOT, rel)
  let text: string
  try {
    text = await readFile(abs, 'utf8')
  } catch {
    return reply.code(404).send({ error: '笔记不存在' })
  }
  const dirParts = rel.split('/').slice(0, -1)
  const newRel = [...dirParts, filename].join('/')
  if (newRel === rel) return { ok: true, path: rel, unchanged: true }
  const newAbs = path.join(KB_ROOT, newRel)
  try {
    await readFile(newAbs, 'utf8')
    return reply.code(400).send({ error: '同名笔记已存在' })
  } catch { /* 目标名可用 */ }

  const oldBase = rel.split('/').pop()!.replace(/\.md$/, '')
  const newBase = filename.replace(/\.md$/, '')
  const { fm, body: pageBody } = parsePage(text)
  // title 是默认值（=旧文件名）时跟随改名；用户自定义过的 title 不动
  if (fm['title'] === undefined || fm['title'] === oldBase) fm['title'] = newBase
  fm['updated_at'] = new Date().toISOString()
  await writeFile(newAbs, serializePage(fm, pageBody), 'utf8')
  await unlink(abs)
  await appendFile(path.join(KB_ROOT, 'log.md'), renderLogEntry('note', `重命名 ${oldBase} → ${newBase}`), 'utf8')
  const commitSha = await gitCommitAll(KB_ROOT, `note: rename ${rel} -> ${newRel}`)
  bus.emit('note:saved', newRel)
  return { ok: true, path: newRel, commitSha }
})

/** 全库文件树（文档工作台左栏）：wiki 页 + sources，按目录分组返回扁平列表。
 *  query 归档页与根目录元文件（index/log/AGENTS）是系统内部产物，不向用户展示（query 有过期 GC，看它没意义） */
app.get('/api/v1/files', async () => {
const snap = await scanKb(KB_ROOT)
const entries: Array<{ path: string; kind: string; reviewed?: boolean }> = []
for (const p of snap.pages) {
if (p.startsWith('wiki/queries/')) continue
entries.push({ path: p, kind: p.startsWith('wiki/entities/') ? 'entity' : p.startsWith('wiki/concepts/') ? 'concept' : p.startsWith('wiki/sources/') ? 'source' : 'wiki', reviewed: snap.reviewedPages.has(p) })
}
for (const s of snap.sources) entries.push({ path: s, kind: 'raw-source' })
return { files: entries.sort((a, b) => a.path.localeCompare(b.path)) }
})

/** 页面编辑（v0.2 第 1 条）：wiki/ 与 sources/ 下任意 md 可改。
 *  notes/ 走 POST /notes（人写通道）。编辑后记录 fm.prev_sha256（编辑前整页 hash），
 *  供「同步到知识库」感知 diff；log op=edit + git 提交。 */
app.put('/api/v1/pages/*', async (req, reply) => {
  const rel = (req.params as { '*': string })['*']
  if (!rel.endsWith('.md') || rel.includes('..')) {
    return reply.code(400).send({ error: '只允许编辑 .md 页面' })
  }
  if (!rel.startsWith('wiki/') && !rel.startsWith('sources/')) {
    return reply.code(400).send({ error: '仅允许编辑 wiki/ 与 sources/ 下的页面（笔记走笔记通道）' })
  }
  const body = req.body as { content?: string }
  if (typeof body?.content !== 'string') return reply.code(400).send({ error: '需要 content' })
  const abs = path.join(KB_ROOT, rel)
  let prevText: string | null = null
  try {
    prevText = await readFile(abs, 'utf8')
  } catch {
    return reply.code(404).send({ error: '页面不存在' })
  }
  const { fm: prevFm, body: prevBody } = parsePage(prevText)
  const { fm: nextFm, body: nextBody } = parsePage(body.content)
  // 编辑保留原 frontmatter（溯源链不因编辑丢失），只更新 updated_at + prev_sha256
  const { createHash } = await import('node:crypto')
  const mergedFm = { ...prevFm, ...nextFm }
  mergedFm['updated_at'] = new Date().toISOString()
  mergedFm['prev_sha256'] = createHash('sha256').update(prevText).digest('hex')
  delete mergedFm['prev_sha256_none']
  await writeFile(abs, serializePage(mergedFm, `\n${nextBody.trim()}\n`), 'utf8')
  const title = rel.split('/').pop()?.replace(/\.md$/, '') ?? rel
  await appendFile(path.join(KB_ROOT, 'log.md'), renderLogEntry('edit', `编辑 ${title}`), 'utf8')
  const commitSha = await gitCommitAll(KB_ROOT, `edit: ${rel}`)
  return { ok: true, path: rel, commitSha, prevSha256: mergedFm['prev_sha256'] }
})

/** 同步到知识库（v0.2 第 1/2 条统一入口）：
 *  notes/* → 快照 + 两段式 ingest + 回写元数据；sources/* → 重新 ingest（幂等）；
 *  wiki/* → LLM 局部维护（diff + 邻居页联动更新）。全程经 SSE 可见。 */
app.post('/api/v1/sync', async (req, reply) => {
  const body = req.body as { path?: string }
  const rel = body?.path ?? ''
  if (!rel.endsWith('.md') || rel.includes('..')) {
    return reply.code(400).send({ error: '需要 path（notes/ sources/ 或 wiki/ 下的 .md）' })
  }
  try {
    const routing = await llmRouting()
    const outcome = await syncPage({ kbRoot: KB_ROOT, routing, events: bus }, rel)
    return outcome
  } catch (e) {
    req.log.error(e)
    return reply.code(500).send({ error: String((e as Error).message ?? e) })
  }
})

/** 问答局部子图（v0.2 第 5 条）：种子页 + 一跳邻居 + 相关连线 */
app.get('/api/v1/graph/sub', async (req, reply) => {
  const seedsRaw = (req.query as { seeds?: string }).seeds ?? ''
  // 问答归档页（wiki/queries/）不是知识节点，即使被命中引用也不入图（与 buildGraphData 的全局过滤一致）
  const seeds = seedsRaw.split(',').map((s) => s.trim()).filter(Boolean).filter((s) => !s.startsWith('wiki/queries/'))
  if (seeds.length === 0) return reply.code(400).send({ error: '需要 seeds（逗号分隔的页面路径）' })
  const full = await buildGraphData(KB_ROOT, { keepSeeds: seeds })
  const seedSet = new Set(seeds)
  const keep = new Set<string>(seeds)
  for (const e of full.edges) {
    if (seedSet.has(e.source)) keep.add(e.target)
    if (seedSet.has(e.target)) keep.add(e.source)
  }
  return {
    nodes: full.nodes.filter((n) => keep.has(n.id)),
    edges: full.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    seeds,
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

// ---------- D10-11: Review Queue（AI 生成页默认待审，人把关） ----------

/** wiki 页清单（含 reviewed 状态），供队列筛选 */
async function listWikiPages() {
  const snap = await scanKb(KB_ROOT)
  const out: Array<{
    path: string
    title: string
    type: string
    updatedAt: string
    reviewed: boolean
    rework?: { note: string; at: string; status: string }
  }> = []
  for (const rel of [...snap.pages].sort()) {
    const { fm } = parsePage(await readFile(path.join(KB_ROOT, rel), 'utf8'))
    const rework = fm['rework'] as { note: string; at: string; status: string } | undefined
    out.push({
      path: rel,
      title: (fm['title'] as string) ?? rel,
      type: (fm['type'] as string) ?? 'page',
      updatedAt: (fm['updated_at'] as string) ?? (fm['ingested_at'] as string) ?? '',
      reviewed: fm['reviewed'] === true,
      rework,
    })
  }
  return out
}

/** 审核队列：reviewed !== true 的 AI 生成页（wiki/ 全部机生，notes/ 不在内）。
 *  v0.2：queue 内含 rework 字段；另回传 maintenanceRunning 供前端暂停进池提示。 */
app.get('/api/v1/review-queue', async () => {
  const all = await listWikiPages()
  return {
    queue: all.filter((p) => !p.reviewed),
    reviewedCount: all.length - all.filter((p) => !p.reviewed).length,
    maintenanceRunning: getReworkState().running,
  }
})

interface ReviewBody {
  path: string // wiki/xxx/yyy.md
  action: 'approve' | 'reject' | 'rework'
  note?: string // rework 时的修改意见
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
  if (body.action === 'rework') {
    // 返修：不删除页面、不改 reviewed；fm.rework 记录意见进入返修池。
    // 批量修复运行期间（reworkState.running）新返修不进池（status=deferred，等维护结束再处理）。
    const note = (body.note ?? '').trim()
    if (!note) return reply.code(400).send({ error: 'rework 需要修改意见 note' })
    let text: string
    try {
      text = await readFile(abs, 'utf8')
    } catch {
      return reply.code(404).send({ error: `页面不存在：${rel}` })
    }
    const { fm, body: pageBody } = parsePage(text)
    const maintenance = getReworkState().running
    fm['rework'] = { note, at: new Date().toISOString(), status: maintenance ? 'deferred' : 'pending' }
    fm['updated_at'] = new Date().toISOString()
    await writeFile(abs, serializePage(fm, pageBody), 'utf8')
    await appendFile(path.join(KB_ROOT, 'log.md'), renderLogEntry('review', `返修意见 ${title}`), 'utf8')
    const commitSha = await gitCommitAll(KB_ROOT, `review: rework ${rel}`)
    bus.emit('review:done', rel)
    return {
      ok: true,
      action: 'rework',
      path: rel,
      commitSha,
      queued: !maintenance,
      message: maintenance ? '批量修复进行中，本条已记录但暂不进返修池，维护结束后可重新提交' : '已进入返修池',
    }
  }
  return reply.code(400).send({ error: 'action 仅允许 approve/reject/rework' })
})

/** 审核队列（v0.2）：附带返修信息，前端分「待审 / 返修池」两组 */
app.get('/api/v1/review/rework-status', async () => ({ ...getReworkState() }))

interface ReworkRunBody {
  items?: Array<{ path: string; note?: string }> // 缺省 = 池中全部 pending
}

app.post('/api/v1/review/rework-run', async (req, reply) => {
  const body = req.body as ReworkRunBody & { includeSuggestions?: boolean }
  const all = await listWikiPages()
  const pool = body?.items?.length
    ? body.items
    : all
        .filter((p) => !p.reviewed && (p as unknown as { rework?: { status?: string } }).rework?.status === 'pending')
        .map((p) => ({ path: p.path, note: '' }))
  // note 需要从页面 fm 里取（列表项没有 rework 全文时）；
  // D8-9：includeSuggestions=true 时把 suggestions[]（audit + user 建议）也并入本轮执行
  const items: Array<{ path: string; note: string }> = []
  for (const it of pool) {
    let note = it.note ?? ''
    if (!note) {
      try {
        const { fm } = parsePage(await readFile(path.join(KB_ROOT, it.path), 'utf8'))
        note = ((fm['rework'] as { note?: string } | undefined)?.note ?? '').trim()
      } catch { /* 页面已删则跳过 */ }
    }
    if (note) items.push({ path: it.path, note })
  }
  // suggestions 并入（同页多建议合并为一条 note；audit 建议附 action 说明）
  if (body?.includeSuggestions) {
    for (const p of all) {
      if (items.some((i) => i.path === p.path)) continue
      const sug = await readSuggestions(KB_ROOT, p.path)
      if (sug.length === 0) continue
      const note = sug
        .map((s) => (s.action ? `[${s.action}${s.peer ? ` ${s.peer}` : ''}] ${s.note}` : s.note))
        .join('\n')
      items.push({ path: p.path, note })
    }
  }
  if (items.length === 0) return reply.code(400).send({ error: '返修池为空（或全部缺修改意见）' })
  if (getReworkState().running) return reply.code(409).send({ error: '已有批量修复在运行中' })
  // 异步执行：立即返回，前端轮询 rework-status；结束 emit review:done
  void runReworkBatch({ kbRoot: KB_ROOT, routing: await llmRouting(), events: bus }, items)
    .then(() => bus.emit('review:done', 'rework-batch'))
    .catch(() => {})
  return { ok: true, started: items.length, items: items.map((i) => i.path) }
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

/** SSE 事件流：把 bus 上的管道事件实时推给 web，消除“黑盒等待”。
 *  web 经 vite 代理调 /api/events → 此处（代理会把 /api 重写为 /api/v1）。
 *  连接期间挂已知事件 + 25s 心跳注释行（防代理空闲断连）；客户端断开时移除监听。 */
const SSE_EVENTS = [
  'source:added',
  'llm:start',
  'llm:delta',
  'llm:done',
  'analyze:start',
  'analyze:done',
  'generate:start',
  'generate:done',
  'gate:rejected',
  'commit',
  'note:saved',
  'review:done',
  'retrieve:done',
  'query:start',
  'query:delta',
  'query:done',
  'task:started',
  'task:done',
  'task:error',
  'task:skipped',
  'bulletin:created',
] as const

app.get('/api/v1/events', (req, reply) => {
  reply.hijack()
  const raw = reply.raw
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  raw.write('retry: 3000\n\n') // 客户端断线后 3s 自动重连
  const send = (name: string, data: unknown) => {
    try {
      raw.write(`event: ${name}\ndata: ${JSON.stringify(data ?? null)}\n\n`)
    } catch { /* 连接已断，等 close 清理 */ }
  }
  const listeners = SSE_EVENTS.map((name) => {
    const fn = (...args: unknown[]) => send(name, args.length <= 1 ? args[0] : args)
    bus.on(name, fn)
    return [name, fn] as const
  })
  const heartbeat = setInterval(() => {
    try { raw.write(': ping\n\n') } catch { /* ignore */ }
  }, 25_000)
  req.raw.on('close', () => {
    clearInterval(heartbeat)
    for (const [name, fn] of listeners) bus.off(name, fn)
  })
})

app.listen({ port: PORT, host: '127.0.0.1' }).then(async () => {
await mkdir(KB_ROOT, { recursive: true })
await ensureKbGit(KB_ROOT)
// 定时任务调度器（ADR-003 D2-3）：启动即扫一轮（错过补偿在此生效）
const runners = new Map()
runners.set(
  'digest',
  createDigestRunner({
    kbRoot: KB_ROOT,
    dataRoot: DATA_ROOT,
    // LLM 路由懒解析：未配置时 runner 自行降级为原始快报（不 fail 任务）
    routing: await llmRouting().catch(() => undefined),
  }),
)
scheduler = startScheduler({ dataRoot: DATA_ROOT, kbRoot: KB_ROOT, runners, events: bus })
// 过期 query 遗忘（GC）：启动即清理一次，之后每小时巡检
const { gcExpiredQueries } = await import('./query-pipeline.ts')
gcExpiredQueries(KB_ROOT).then((n) => n.length > 0 && console.log(`[gc] 遗忘 ${n.length} 条过期 query：${n.join(', ')}`)).catch(() => {})
setInterval(() => gcExpiredQueries(KB_ROOT).catch(() => {}), 60 * 60 * 1000).unref()
console.log(`knowledge-engine server listening on http://127.0.0.1:${PORT} (KB: ${KB_ROOT})`)
})
