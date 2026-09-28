/**
 * 两段式 ingest 管道（D2-4d，ARCHITECTURE §6.2）：
 *   Phase1 analyze ：LLM 结构化分析来源 → AnalysisReport
 *   Phase2 generate ：LLM 按 AnalysisReport 逐页生成正文 → GenerationResult
 *   → 组装 frontmatter → 闸门校验链（@ke/core validateProposal）→ gate executor 落盘
 *   → git 提交（一次 ingest 一次提交，可整体回滚）→ index/log 更新
 *
 * 全程事件经 EventEmitter 广播（ADR-001 D3：post-analyze/post-generate/post-commit）。
 * LLM 调用经 RPM 门控（agent-tools 适配层），RPM=5 下整管道 2+2 次调用 ≈ 36s+。
 */
import { EventEmitter } from 'node:events'
import { appendFile, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

import {
  AnalysisReport,
  GenerationResult,
  renderIndex,
  rebuildIndexSection,
  renderLogEntry,
  parseLlmJson,
  scanKb,
  readTagVocabulary,
  serializePage,
  validateProposal,
  type PageProposal,
  type GateContext,
  type AnalysisReportT,
  type GenerationResultT,
} from '@ke/core'
import type { RoutingConfig, SimpleMessage } from '@ke/agent-tools'

// ---------- 事件与配置 ----------

export interface IngestEvents extends EventEmitter {
  on(ev: 'analyze:start', fn: (src: string) => void): this
  on(ev: 'analyze:done', fn: (r: AnalysisReportT) => void): this
  on(ev: 'generate:start', fn: (pages: number) => void): this
  on(ev: 'generate:done', fn: (r: GenerationResultT) => void): this
  on(ev: 'gate:rejected', fn: (errors: string[]) => void): this
  on(ev: 'commit', fn: (sha: string) => void): this
}

export interface IngestDeps {
  /** 库根目录（git 仓库根） */
  kbRoot: string
  /** LLM 路由（pi-ai 适配层，含 RPM 门控） */
  routing: {
    stream(kind: 'ingest' | 'query', systemPrompt: string | undefined, messages: SimpleMessage[]): AsyncIterable<{ type: string; delta?: string; message?: { usage?: { input?: number; output?: number } } }>
  }
  /** 事件总线（server 的 SSE 层订阅；默认空总线） */
  events?: EventEmitter
}

// ---------- Prompt ----------

const ANALYZE_PROMPT = `你是知识库的"分析器"。阅读给定材料，产出结构化 JSON（只输出 JSON，不要解释）。
要求：
1. summary：一句话概括材料
2. language：材料语言（zh/en/…）
3. source_title：给本来源起一个短标题（≤12 字，名词短语，不用完整句子；如 "Karpathy LLM Wiki 工作流"）
4. entities：材料中出现的、值得建"实体页"的核心实体（人/组织/产品/项目），每实体 3-8 条 claims（有依据的具体主张，标注 locus 出处位置）
5. concepts：值得建"概念页"的核心概念，每概念 2-6 条 claims
6. 命名约束：entities/concepts 的 name 必须是简短名词（中文 ≤10 字 / 英文 ≤3 个词），禁止用完整句子或长描述作 name
7. 宁缺毋滥：只收录理解材料所必需的条目，总量 entities+concepts 不超过 12 个
8. 去重：对照「知识库现有目录」，若材料中的实体/概念与已有条目同义（如 LLM Wiki 与 llm_wiki、卡片盒笔记法与 Zettelkasten 指同一事物），必须沿用已有条目的 name，不要另立新名；确属新事物才建新页
JSON schema：
{"summary":"...","language":"zh","source_title":"...","entities":[{"name":"...","definition":"...","aliases":["..."],"claims":[{"statement":"...","locus":"..."}],"tags":["..."]}],"concepts":[同 entities 结构]}`

const GENERATE_PROMPT = `你是知识库的"写作器"。基于给定的分析结果，为每个实体/概念写 wiki 页正文。
要求：
1. body：Markdown 正文，200-400 字；第一段给定义/一句话概括
2. 引用规则（严格）：主张出处用行内标注 [[页面名]]，页面名用其他实体/概念的 title 原样（如 [[Karpathy]]、[[知识复利]]）；不要用 [[sources/...]] 路径形式；信息确实无对应页面可链时，用普通文本标注 (来源: 来源名) 即可
3. sources：本页用到的来源引用（形如 sources/xxx.md，与 frontmatter 对应）
4. 不要编造分析结果之外的事实
5. 输出 JSON：{"pages":[{"name":"...","body":"...","sources":["..."]}]}，pages 顺序与输入条目一致`

// ---------- 管道 ----------

export interface IngestOutcome {
  /** 本次 ingest 的 wiki 落盘页面路径（幂等跳过时为空） */
  writtenPages: string[]
  /** 来源摘要页路径 */
  sourceSummaryPage: string
  /** 被闸门拒绝的提案（错误信息） */
  rejections: string[]
  /** git commit sha（无 git 时为 null；幂等跳过时为 null） */
  commitSha: string | null
  /** 幂等命中：同 sha256 的 source 已 ingest 过，本次未做任何事 */
  skipped: boolean
  analysisTokens: { input: number; output: number }
  generationTokens: { input: number; output: number }
}

/** 对单个 source 执行完整 ingest。sourceRel 形如 sources/foo.md */
export async function ingestSource(
  deps: IngestDeps,
  sourceRel: string,
): Promise<IngestOutcome> {
  const { kbRoot, routing } = deps
  const events = deps.events ?? new EventEmitter()
  const sourceText = await readFile(path.join(kbRoot, sourceRel), 'utf8')
  const sourceSlug = slugify(sourceRel.replace(/^sources\//, '').replace(/\.md$/, ''))
  const summaryPath = `wiki/sources/${sourceSlug}.md`

  // ---------- 幂等判重：同 sha256 的 source 已 ingest 过 → 直接跳过 ----------
  const sourceHash = await sha256(sourceText)
  const existingSummary = await readFile(path.join(kbRoot, summaryPath), 'utf8').catch(() => null)
  const existingHash = existingSummary?.match(/^sha256:\s*([a-f0-9]{64})\s*$/m)?.[1]
  if (existingHash !== undefined && existingHash === sourceHash) {
    events.emit('analyze:start', sourceRel)
    events.emit('commit', 'skipped-idempotent')
    return {
      writtenPages: [],
      sourceSummaryPage: summaryPath,
      rejections: [],
      commitSha: null,
      skipped: true,
      analysisTokens: { input: 0, output: 0 },
      generationTokens: { input: 0, output: 0 },
    }
  }

  // ---------- Phase 1: analyze ----------
  events.emit('analyze:start', sourceRel)
  const { Value } = await import('@sinclair/typebox/value')
  const analyzeCtx = await buildContextMessages(deps, sourceText)
  const phase1 = await callLlmJson<AnalysisReportT>(routing, 'ingest', ANALYZE_PROMPT, analyzeCtx, AnalysisReport, { events, phase: 'analyze' })
  if (!Value.Check(AnalysisReport, phase1.report)) {
    const errs = [...Value.Errors(AnalysisReport, phase1.report)].map((e) => `${e.path}: ${e.message}`)
    throw new Error(`ingest: Phase1 分析输出不合 schema：\n${errs.join('\n')}`)
  }
  events.emit('analyze:done', phase1.report)
  const analysisTokens = phase1.tokens

  // ---------- Phase 2: generate ----------
  const entries = [...phase1.report.entities.map((e) => ({ ...e, kind: 'entity' as const })), ...phase1.report.concepts.map((c) => ({ ...c, kind: 'concept' as const }))]
  events.emit('generate:start', entries.length)
  const phase2 = await callLlmJson<GenerationResultT>(
    routing,
    'ingest',
    GENERATE_PROMPT,
    [{ role: 'user', text: JSON.stringify({ source: sourceRel, entries }, null, 2) }],
    GenerationResult,
    { events, phase: 'generate' },
  )
  if (!Value.Check(GenerationResult, phase2.report)) {
    const errs = [...Value.Errors(GenerationResult, phase2.report)].map((e) => `${e.path}: ${e.message}`)
    throw new Error(`ingest: Phase2 生成输出不合 schema：\n${errs.join('\n')}`)
  }
  events.emit('generate:done', phase2.report)

  // ---------- 组装提案 + 闸门 ----------
  const snap = await scanKb(kbRoot)
  const tagVocab = await readTagVocabulary(path.join(kbRoot, 'AGENTS.md'))
  const gateCtx: GateContext = {
    existingPages: snap.pages,
    existingSources: snap.sources,
    reviewedPages: snap.reviewedPages,
    tagVocabulary: tagVocab,
  }
  const now = new Date().toISOString()
  const proposals: PageProposal[] = []
  const rejections: string[] = []
  const writtenPages: string[] = []

  const genByName = new Map(phase2.report.pages.map((p) => [p.name, p]))
  for (const entry of entries) {
    const gen = genByName.get(entry.name)
    if (!gen) {
      rejections.push(`gate:missing-generation 分析条目 ${entry.name} 无对应生成结果，跳过`)
      continue
    }
    const slug = slugify(entry.name)
    const dir = entry.kind === 'entity' ? 'wiki/entities' : 'wiki/concepts'
    const pagePath = `${dir}/${slug}.md`
    const fm: Record<string, unknown> = {
      type: entry.kind,
      title: entry.name,
      sources: gen.sources,
      updated_at: now,
    }
    if (entry.kind === 'entity' && (entry as { aliases?: string[] }).aliases?.length) {
      fm['aliases'] = (entry as { aliases?: string[] }).aliases
    }
    const vocabSet = new Set(tagVocab)
    const keptTags = ((entry as { tags?: string[] }).tags ?? []).filter((t) => vocabSet.has(t))
    if (keptTags.length > 0) fm['tags'] = keptTags
    const result = validateProposal({ path: pagePath, fm, body: gen.body, operation: snap.pages.has(pagePath) ? 'update' : 'create' }, gateCtx)
    if (!result.ok) {
      rejections.push(...result.errors)
      continue
    }
    proposals.push(result.sanitized!)
  }

  // 来源摘要页提案（source 摘要页）：title 用短名（LLM 的 source_title 优先，退回文件名），
  // 完整 summary 放正文，避免超长标题污染页面名/图谱节点/引用 chip
  const llmSourceTitle = (phase1.report as { source_title?: unknown }).source_title
  const summaryTitle =
    typeof llmSourceTitle === 'string' && llmSourceTitle.trim().length > 0 && llmSourceTitle.trim().length <= 24
      ? llmSourceTitle.trim()
      : sourceRel.replace(/^sources\//, '').replace(/\.md$/, '')
  const summaryFm = {
    type: 'source',
    title: summaryTitle,
    source: sourceRel,
    sha256: sourceHash,
    ingested_at: now,
    tokens: { analysis: phase1.tokens.input + phase1.tokens.output, generation: phase2.tokens.input + phase2.tokens.output },
  }
  const summaryResult = validateProposal({ path: summaryPath, fm: summaryFm, body: phase1.report.summary, operation: 'create' }, gateCtx)
  if (summaryResult.ok) proposals.push(summaryResult.sanitized!)
  else rejections.push(...summaryResult.errors)
  if (rejections.length > 0) events.emit('gate:rejected', rejections)

  // ---------- gate executor：唯一写通道落盘 ----------
  for (const p of proposals) {
    const abs = path.join(kbRoot, p.path)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, serializePage(p.fm, `\n${p.body}\n`), 'utf8')
    writtenPages.push(p.path)
  }

  // ---------- index.md / log.md 更新 ----------
  const indexAbs = path.join(kbRoot, 'index.md')
  const indexText = await readFile(indexAbs, 'utf8').catch(() => '# 内容目录\n')
  const entityEntries = proposals
    .filter((p) => p.path.startsWith('wiki/entities/'))
    .map((p) => ({ page: (p.fm['title'] as string) ?? p.path, summary: firstSentence(p.body), section: 'entities' as const }))
  const conceptEntries = proposals
    .filter((p) => p.path.startsWith('wiki/concepts/'))
    .map((p) => ({ page: (p.fm['title'] as string) ?? p.path, summary: firstSentence(p.body), section: 'concepts' as const }))
  let newIndex = indexText
  if (entityEntries.length) newIndex = rebuildIndexSection(newIndex, 'entities', entityEntries)
  if (conceptEntries.length) newIndex = rebuildIndexSection(newIndex, 'concepts', conceptEntries)
  await writeFile(indexAbs, newIndex, 'utf8')
  await appendFile(path.join(kbRoot, 'log.md'), renderLogEntry('ingest', `${sourceRel}（${writtenPages.length} 页落盘）`), 'utf8')

  // ---------- git 提交（一次 ingest 一次提交） ----------
  const commitSha = await gitCommitAll(kbRoot, `ingest: ${sourceRel} (${writtenPages.length} pages)`)

  events.emit('commit', commitSha ?? 'no-git')
  return {
    writtenPages,
    sourceSummaryPage: summaryPath,
    rejections,
    commitSha,
    skipped: false,
    analysisTokens: phase1.tokens,
    generationTokens: phase2.tokens,
  }
}

// ---------- 工具函数 ----------

async function buildContextMessages(deps: IngestDeps, sourceText: string): Promise<SimpleMessage[]> {
  // 上下文：来源全文 + index.md（记忆索引）
  const indexText = await readFile(path.join(deps.kbRoot, 'index.md'), 'utf8').catch(() => '')
  return [
    { role: 'user', text: `# 知识库现有目录（供参考，避免重复建页）\n${indexText}\n\n# 待分析材料\n${sourceText}` },
  ]
}

interface LlmCallResult<T> {
  report: T
  tokens: { input: number; output: number }
}

/** 流式调用选项：maxRepair 自动修复轮数；events/phase 用于把 LLM 增量转发到事件总线
 *  （llm:start / llm:delta / llm:done），供 SSE 层把“引擎正在逐字生成”显化到前端。 */
interface StreamOpts {
  maxRepair?: number
  events?: EventEmitter
  phase?: 'analyze' | 'generate'
}

async function callLlmJson<T>(
  routing: IngestDeps['routing'],
  kind: 'ingest' | 'query',
  systemPrompt: string,
  messages: SimpleMessage[],
  schema?: import('@sinclair/typebox').TSchema,
  opts: StreamOpts = {},
): Promise<LlmCallResult<T>> {
  const { Value } = await import('@sinclair/typebox/value')
  const maxRepair = opts.maxRepair ?? 1
  let currentMessages = [...messages]
  let lastReport: unknown = undefined
  for (let attempt = 0; attempt <= maxRepair; attempt++) {
    const { text, usage } = await (async () => {
      const chunks: string[] = []
      let usage: { input: number; output: number } = { input: 0, output: 0 }
      // 429/限流退避重试：与 RPM 队列互补（队列管请求发起节奏，这里管被拒后的等待重试）
      const backoffs = [3000, 8000, 15000]
      for (let tryN = 0; ; tryN++) {
        try {
          chunks.length = 0
          usage = { input: 0, output: 0 }
          const startedAt = Date.now()
          let firstByteAt = 0
          opts.events?.emit('llm:start', { phase: opts.phase })
          for await (const ev of routing.stream(kind, systemPrompt, currentMessages)) {
            if (ev.type === 'text_delta' && ev.delta) {
              if (!firstByteAt) firstByteAt = Date.now()
              chunks.push(ev.delta)
              opts.events?.emit('llm:delta', { phase: opts.phase, delta: ev.delta })
            }
            if (ev.type === 'done' && ev.message?.usage) usage = { input: ev.message.usage.input ?? 0, output: ev.message.usage.output ?? 0 }
          }
          opts.events?.emit('llm:done', { phase: opts.phase, firstByteMs: firstByteAt ? firstByteAt - startedAt : null, totalMs: Date.now() - startedAt })
          break
        } catch (err) {
          const msg = String((err as Error)?.message ?? err)
          const rateLimited = /429|rate.?limit|too many requests/i.test(msg)
          if (!rateLimited || tryN >= backoffs.length) throw err
          await new Promise((r) => setTimeout(r, backoffs[tryN]))
        }
      }
      return { text: chunks.join(''), usage }
    })()
    // 解析失败（非法 JSON）不再直接 throw 穿透修复循环：与 schema 失败同等回喂修复
    let report: unknown
    let parseErrMsg: string | null = null
    try {
      report = parseLlmJson<T>(text)
    } catch (e) {
      parseErrMsg = String((e as Error)?.message ?? e)
    }
    lastReport = report
    if (parseErrMsg === null && (!schema || Value.Check(schema, report))) {
      return { report: report as T, tokens: usage }
    }
    if (attempt >= maxRepair) {
      if (parseErrMsg) throw new Error(`LLM 输出无法解析为 JSON（已重试 ${maxRepair} 轮）：${parseErrMsg}`)
      break
    }
    // 自修复：把解析/schema 错误清单回喂
    const errs = parseErrMsg
      ? [parseErrMsg]
      : [...Value.Errors(schema!, report!)].slice(0, 10).map((e) => `${e.path}: ${e.message}`)
    currentMessages = [
      ...currentMessages,
      { role: 'user', text: `你上一轮输出${parseErrMsg ? '不是合法 JSON' : '未通过 schema 校验'}，错误如下：\n${errs.join('\n')}\n\n请输出修正后的完整 JSON（仍然只输出 JSON）。` },
    ]
  }
  // 走到这说明重试后仍不合规（或 maxRepair=0）：由调用方决定是否抛错
  return { report: lastReport as T, tokens: { input: 0, output: 0 }, }
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[\s/\\]+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '')
}

async function sha256(text: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(text).digest('hex')
}

function firstSentence(body: string): string {
  const t = body.trim().replace(/^(#+.*\n)+/, '').replace(/\s+/g, ' ').trim()
  // 硬窗口 100 字，但不得落在 [[wikilink]] 内部（否则产生 [[xxx 残链）
  let end = Math.min(t.length, 100)
  const lastOpen = t.lastIndexOf('[[', end)
  const lastClose = t.lastIndexOf(']]', end)
  if (lastOpen !== -1 && (lastClose === -1 || lastClose < lastOpen)) {
    end = lastOpen // 截断点在未闭合 wikilink 内 → 回退到 [[ 之前
  }
  // 窗口内取第一个完整句（。！？!?），让摘要语义完整
  const m = /[。！？!?]/.exec(t.slice(0, end))
  return m?.index !== undefined ? t.slice(0, m.index + 1) : t.slice(0, end)
}

/** 全库 git 提交（无 .git 时静默返回 null）。gate executor 与笔记保存共用，保持"一次操作=一次提交"规范 */
export async function gitCommitAll(root: string, message: string): Promise<string | null> {
  const run = (args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const p = spawn('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.stderr.on('data', (d) => (out += d))
      p.on('close', (code) => resolve({ code: code ?? 1, out }))
    })
  try {
    await access(path.join(root, '.git'))
  } catch {
    return null
  }
  await run(['add', '-A'])
  const r = await run(['commit', '-m', message])
  if (r.code !== 0) return null
  const shaR = await run(['rev-parse', 'HEAD'])
  return shaR.out.trim() || null
}
