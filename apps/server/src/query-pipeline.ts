/**
 * F5 Query 管道（D5，ARCHITECTURE §6.5/§6.6 的 MVP 子集）：
 *   级联检索（L1 词法 + L2 图扩展，MVP 无 LLM 关键词/PPR）
 *   → 上下文组装（预算内整页）
 *   → 强模型（query 路由）生成带引用回答
 *   → 无依据时明说"无依据"，不编造（SPEC F5 验收核心）
 *   → 归档为 query 页（wiki/queries/，可回跳）
 */
import { appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import process from 'node:process'

import {
  scanKb,
  parsePage,
  lexicalMatch,
  graphExpand,
  assembleContext,
  buildLinkGraph,
  renderLogEntry,
  serializePage,
  type PageDoc,
  type LexHit,
} from '@ke/core'

export interface QueryDeps {
  kbRoot: string
  routing: {
    stream(kind: 'ingest' | 'query', systemPrompt: string | undefined, messages: Array<{ role: 'user' | 'system'; text: string }>): AsyncIterable<{ type: string; delta?: string; message?: { usage?: { input?: number; output?: number } } }>
  }
  events?: EventEmitter
}

export interface QueryOutcome {
  answer: string
  /** 答案引用的页面（检索选中的页，含分） */
  citedPages: Array<{ path: string; title: string; score: number }>
  /** 库内无依据（检索零命中或模型明确表示无依据） */
  noEvidence: boolean
  /** query 归档页路径 */
  archivePath: string | null
  tokens: { input: number; output: number }
}

const ANSWER_PROMPT = `你是知识库问答助手。回答规则（必须严格遵守）：
1. 只依据给定的"参考资料"回答问题，禁止使用资料之外的知识
2. 回答中的关键主张后用 [[页面名]] 标注出处（页面名用资料给出的标题原样）
3. 如果参考资料不足以回答问题，必须明确说"库内无依据"，并简述库里有什么相关内容。禁止编造
4. 回答用与问题相同的语言，简洁直接，Markdown 格式`

/** query 归档页的有效期（天）：到期自动失效遗忘，避免一次性问答沉淀为永久知识 */
const QUERY_TTL_DAYS = 30

/** 对库提问。archive=true 时把 Q&A 归档为 query 页 */
export async function answerQuery(
  deps: QueryDeps,
  question: string,
  opts: { archive?: boolean } = {},
): Promise<QueryOutcome> {
  const { kbRoot, routing } = deps
  const events = deps.events ?? new EventEmitter()

  // 流式问答：问答开始/增量 token 经 bus 广播（SSE → 前端悬浮球实时渲染回答）。
  // 本地单用户场景，不做多路并发隔离；前端在同一时刻只发起一次提问。
  events.emit('query:start', { question })

  // ---------- 检索 ----------
  const pages = await loadPageDocs(kbRoot)
  const seeds = lexicalMatch(question, pages)
  const graph = buildLinkGraph(pages)
  const hits: LexHit[] = seeds.length > 0 ? graphExpand(seeds, graph) : []
  const asm = assembleContext(hits, pages)

  events.emit('retrieve:done', { seeds: seeds.length, expanded: hits.length, used: asm.pages.length })

  // ---------- 无依据快路径 ----------
  if (asm.pages.length === 0) {
    const outcome: QueryOutcome = {
      answer: '库内无依据：当前知识库中没有检索到与该问题相关的内容。',
      citedPages: [],
      noEvidence: true,
      archivePath: null,
      tokens: { input: 0, output: 0 },
    }
    if (opts.archive) {
      outcome.archivePath = await archiveQuery(kbRoot, question, outcome.answer, [], pages)
    }
    return outcome
  }

  // ---------- 生成 ----------
  const refsBlock = asm.pages
    .map((p, i) => `### 资料页 ${i + 1}：${p.title}（path: ${p.path}）\n${p.body}`)
    .join('\n\n---\n\n')
  const userMsg = `# 问题\n${question}\n\n# 参考资料\n${refsBlock}\n\n（若资料页 ${asm.pages.length} 页仍不足以回答，请明确说明库内无依据）`
  const chunks: string[] = []
  let tokens = { input: 0, output: 0 }
  for await (const ev of routing.stream('query', ANSWER_PROMPT, [{ role: 'user', text: userMsg }])) {
    if (ev.type === 'text_delta' && ev.delta) {
      chunks.push(ev.delta)
      events.emit('query:delta', { delta: ev.delta })
    }
    if (ev.type === 'done' && ev.message?.usage) {
      tokens = { input: ev.message.usage.input ?? 0, output: ev.message.usage.output ?? 0 }
    }
  }
  let answer = chunks.join('').trim()
  answer = answer.replace(/^<summation>[\s\S]*?<\/summation>\s*/i, '').trim() // 推理模型包裹

  // ---------- 无依据检测 ----------
  const noEvidence = /库内无依据|无法基于|资料不足|没有足够/.test(answer.slice(0, 120))

  // ---------- 引用归一化：[[页面名]] 补 path；[[sources/…]] 路径式改写为 [[标题]](path) ----------
  // 模型不一定严格遵守"用页面名"的指令（e2e 实测 glm-53 会用路径式引用，甚至自带 (path)），这里统一为 [[标题]](path)
  const citeToPage = new Map<string, { path: string; title: string }>()
  for (const p of asm.pages) {
    const addKey = (k: string) => {
      if (k && !citeToPage.has(k)) citeToPage.set(k, p)
    }
    addKey(p.title)
    for (const a of p.aliases) addKey(a)
    const pathVariants = [p.path, p.path.replace(/\.md$/, ''), p.path.replace(/^wiki\//, ''), p.path.replace(/^wiki\//, '').replace(/\.md$/, '')]
    for (const v of pathVariants) addKey(v)
    const base = p.path.split('/').pop() ?? ''
    addKey(base)
    addKey(base.replace(/\.md$/, ''))
  }
  // 先处理长 key，避免短 key 抢先替换长 key 的一部分
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const k of [...citeToPage.keys()].sort((a, b) => b.length - a.length)) {
    const p = citeToPage.get(k)!
    const canon = `[[${p.title}]](${p.path})`
    // (?!\() 排除模型已自带 ([[..]](path)) 的完整形式，避免双重补 path
    answer = answer.replace(new RegExp(`\\[\\[${esc(k)}\\]\\](?!\\()`, 'g'), canon)
  }

  // ---------- 归档 ----------
  let archivePath: string | null = null
  if (opts.archive) {
    archivePath = await archiveQuery(
      kbRoot,
      question,
      answer,
      asm.pages.map((p) => p.path),
      pages,
    )
  }

  await appendFile(path.join(kbRoot, 'log.md'), renderLogEntry('query', question.slice(0, 60)), 'utf8')
  events.emit('query:done', { noEvidence, pages: asm.pages.length })

  return {
    answer,
    citedPages: asm.pages.map((p) => ({ path: p.path, title: p.title, score: p.score })),
    noEvidence,
    archivePath,
    tokens,
  }
}

// ---------- 辅助 ----------

async function loadPageDocs(kbRoot: string): Promise<PageDoc[]> {
  const snap = await scanKb(kbRoot)
  const now = Date.now()
  const out: PageDoc[] = []
  for (const p of snap.pages) {
    const text = await readFile(path.join(kbRoot, p), 'utf8')
    const { fm, body } = parsePage(text)
    // 已过期（未及 GC）的 query 页不再参与检索
    if (fm['type'] === 'query' && isExpired(fm, now)) continue
    out.push({
      path: p,
      title: (fm['title'] as string) ?? p,
      aliases: (fm['aliases'] as string[]) ?? [],
      tags: (fm['tags'] as string[]) ?? [],
      body,
    })
  }
  return out
}

async function archiveQuery(
  kbRoot: string,
  question: string,
  answer: string,
  sourcePaths: string[],
  pages: readonly PageDoc[],
): Promise<string> {
  const slug = `q-${Date.now().toString(36)}-${slugify(question.slice(0, 24))}`
  const rel = `wiki/queries/${slug}.md`
  const now = new Date()
  const fm = {
    type: 'query' as const,
    question,
    sources: sourcePaths.length > 0 ? sourcePaths : ['sources/none.md'],
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + QUERY_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  }
  // 闸门语义：sources 必须存在；零引用的"无依据"归档用占位（MVP 简化，Phase 2 改 schema）
  if (sourcePaths.length === 0) {
    await mkdir(path.join(kbRoot, 'sources'), { recursive: true })
    try {
      await readFile(path.join(kbRoot, 'sources/none.md'), 'utf8')
    } catch {
      await writeFile(path.join(kbRoot, 'sources/none.md'), '# 占位来源（无依据归档）\n', 'utf8')
    }
  }
  await mkdir(path.dirname(path.join(kbRoot, rel)), { recursive: true })
  await writeFile(path.join(kbRoot, rel), serializePage({ ...fm }, `\n## Q\n\n${question}\n\n## A\n\n${answer}\n`), 'utf8')
  void pages
  return rel
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[\s/\\]+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').slice(0, 40)
}

/** query 页是否已过期：有 expires_at 且已到期的才过期（老数据无该字段视为永久，不追溯清理） */
function isExpired(fm: Record<string, unknown>, now: number): boolean {
  const exp = fm['expires_at']
  if (typeof exp !== 'string') return false
  const t = Date.parse(exp)
  return Number.isFinite(t) && t <= now
}

/**
 * 过期 query 遗忘（GC）：删除 expires_at 已到期的 wiki/queries/ 页并 git 提交。
 * 服务启动时 + 每小时周期执行；返回删除的路径列表。
 */
export async function gcExpiredQueries(kbRoot: string): Promise<string[]> {
  const snap = await scanKb(kbRoot)
  const now = Date.now()
  const expired: string[] = []
  let migrated = 0
  for (const p of snap.pages) {
    if (!p.startsWith('wiki/queries/')) continue
    const text = await readFile(path.join(kbRoot, p), 'utf8')
    const { fm, body } = parsePage(text)
    if (typeof fm['expires_at'] !== 'string') {
      // 存量迁移：无 expires_at 的老 query 页按 created_at + TTL 回填，同样会自然过期
      const created = Date.parse(String(fm['created_at'] ?? '')) || now
      fm['expires_at'] = new Date(created + QUERY_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
      await writeFile(path.join(kbRoot, p), serializePage({ ...fm }, body), 'utf8')
      migrated++
    }
    if (isExpired(fm, now)) expired.push(p)
  }
  if (expired.length === 0) {
    if (migrated > 0) {
      const { gitCommitAll } = await import('./ingest-pipeline.ts')
      await gitCommitAll(kbRoot, `query: backfill expires_at for ${migrated} legacy queries`)
    }
    return []
  }
  for (const p of expired) {
    await unlink(path.join(kbRoot, p)).catch(() => {})
  }
  const { gitCommitAll } = await import('./ingest-pipeline.ts')
  await appendFile(path.join(kbRoot, 'log.md'), renderLogEntry('query', `遗忘 ${expired.length} 条过期问答`), 'utf8')
  await gitCommitAll(kbRoot, `query: forget ${expired.length} expired queries`)
  return expired
}

/** 图谱数据（GET /api/v1/graph）：节点=页面，边=wikilink（给 F7 前端直接用）。
 *  query 归档页不入图（一次性问答不是知识节点，入图会扭曲布局）；keepSeeds 用于局部子图保留种子本身。 */
export async function buildGraphData(
  kbRoot: string,
  opts: { keepSeeds?: string[] } = {},
): Promise<{ nodes: Array<{ id: string; title: string; kind: string }>; edges: Array<{ source: string; target: string }> }> {
  const pages = await loadPageDocs(kbRoot)
  const keepSeeds = new Set(opts.keepSeeds ?? [])
  const inGraph = (p: { path: string }) => !p.path.startsWith('wiki/queries/') || keepSeeds.has(p.path)
  const graphPages = pages.filter(inGraph)
  const graph = buildLinkGraph(graphPages)
  const nodes = graphPages.map((p) => ({
    id: p.path,
    title: p.title,
    kind: p.path.startsWith('wiki/entities/') ? 'entity' : p.path.startsWith('wiki/concepts/') ? 'concept' : p.path.startsWith('wiki/sources/') ? 'source' : p.path.startsWith('wiki/queries/') ? 'query' : 'other',
  }))
  const edges: Array<{ source: string; target: string }> = []
  for (const [from, outs] of graph) {
    for (const to of outs) edges.push({ source: from, target: to })
  }
  // D12-13 修复：笔记节点入图（SPEC 第 8 步：图谱里看到笔记与 wiki 的连接）
  // title/alias → 页面路径 索引（notes 的 [[链接]] 落到 wiki 页上）
  const snap = await scanKb(kbRoot)
  const titleIndex = new Map<string, string>()
  for (const p of pages) {
    titleIndex.set(p.title.toLowerCase(), p.path)
    for (const a of p.aliases) titleIndex.set(a.toLowerCase(), p.path)
  }
  for (const noteRel of snap.notes) {
    const text = await readFile(path.join(kbRoot, noteRel), 'utf8')
    const { fm, body } = parsePage(text)
    nodes.push({ id: noteRel, title: (fm['title'] as string) ?? noteRel.replace(/^notes\//, '').replace(/\.md$/, ''), kind: 'note' })
    for (const m of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      const target = titleIndex.get(m[1]!.trim().toLowerCase())
      if (target) edges.push({ source: noteRel, target })
    }
  }
  return { nodes, edges }
}

export { process }
