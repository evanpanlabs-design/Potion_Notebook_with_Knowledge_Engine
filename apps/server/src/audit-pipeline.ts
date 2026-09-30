/**
 * graph audit 管线（ADR-003 §3.1）：图谱自检、自维护。
 *
 * 三段式：
 * 1. 体检（纯计算零 token）：孤立节点、疑似重复实体（标题相似度）、
 *    度数异常（超枢纽/低价值桥接边）
 * 2. LLM 判定：对初筛嫌疑批量判定「冗余边 / 缺漏关联 / 重复节点」→ proposals
 * 3. 落盘：建议写进目标页 frontmatter suggestions[]（origin: audit），
 *    进既有审核队列视角（AI 的维护动作默认待审——与人审共用一条链路）
 *
 * 缺漏补链证据顺序（溯源守门）：
 *   先 sources/ 全文检索（零 token）→ 无据且 Tavily 开启 → 联网搜索并
 *   物化 sources/url-<hash>.md 证据页 → 都无据则明说「无依据」。
 *
 * 本模块不直接改图谱——只产建议（写 suggestions frontmatter），执行由
 * 人工审核或后续 maintain 批次驱动（v0.2 rework 池泛化，D8-9 收口）。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

import { Type, type Static } from '@sinclair/typebox'
import { scanKb, parsePage, serializePage, buildLinkGraph, tokenize, type PageDoc } from '@ke/core'
import { callLlmJson, gitCommitAll } from './ingest-pipeline.ts'
import { createTavilyClient } from '@ke/agent-tools'
import { resolveTavilyConfig, bumpTavilyUsage } from './agent-tools.ts'

export interface AuditDeps {
  kbRoot: string
  dataRoot: string
  routing: unknown
}

// ---------------------------------------------------------------------------
// Phase 1：体检（纯计算，零 token）
// ---------------------------------------------------------------------------

export interface AuditFinding {
  kind: 'orphan' | 'duplicate' | 'hub' | 'bridge'
  /** 涉及页面（orphan/duplicate/hub 为单页；bridge 为 [from, to]） */
  paths: string[]
  titles: string[]
  /** 体检证据描述（喂给 LLM 判定 / 展示给用户） */
  evidence: string
}

export interface HealthReport {
  totalPages: number
  edges: number
  orphans: AuditFinding[]
  duplicates: AuditFinding[]
  hubs: AuditFinding[]
  bridges: AuditFinding[]
}

/** 相似度阈值：标题 token Jaccard ≥ 0.6 视为疑似重复 */
const DUP_THRESHOLD = 0.6
/** 超枢纽阈值：度数（入+出）> max(12, 平均度×3) */
const HUB_MIN_DEGREE = 12
/** 桥接边初筛：两端页面正文 token 重叠度低却互联（疑似无意义连线） */
const BRIDGE_OVERLAP = 0.08

export function healthCheck(pages: readonly PageDoc[], graph: Map<string, Set<string>>): HealthReport {
  const byPath = new Map(pages.map((p) => [p.path, p]))
  const inDeg = new Map<string, number>()
  let edges = 0
  for (const [from, outs] of graph) {
    for (const to of outs) {
      edges++
      inDeg.set(to, (inDeg.get(to) ?? 0) + 1)
    }
  }
  const degree = (p: string) => (graph.get(p)?.size ?? 0) + (inDeg.get(p) ?? 0)

  // 孤立节点：无出边无入边（queries 归档页不算——它们本就不是知识节点）
  const orphans: AuditFinding[] = pages
    .filter((p) => !p.path.startsWith('wiki/queries/') && degree(p.path) === 0)
    .slice(0, 20)
    .map((p) => ({ kind: 'orphan', paths: [p.path], titles: [p.title], evidence: '图谱中无任何连线（孤立节点）' }))

  // 疑似重复实体：标题 token Jaccard ≥ 0.6 且互不同页
  const dupSet = new Set<string>()
  const duplicates: AuditFinding[] = []
  const titleTokens = pages.map((p) => ({ p, tokens: new Set(tokenize(p.title)) }))
  for (let i = 0; i < titleTokens.length; i++) {
    for (let j = i + 1; j < titleTokens.length; j++) {
      const a = titleTokens[i]!
      const b = titleTokens[j]!
      if (a.p.path === b.p.path) continue
      const inter = [...a.tokens].filter((t) => b.tokens.has(t)).length
      const union = a.tokens.size + b.tokens.size - inter
      if (union > 0 && inter / union >= DUP_THRESHOLD) {
        const key = [a.p.path, b.p.path].sort().join('|')
        if (dupSet.has(key)) continue
        dupSet.add(key)
        duplicates.push({
          kind: 'duplicate',
          paths: [a.p.path, b.p.path],
          titles: [a.p.title, b.p.title],
          evidence: `标题高度相似（Jaccard ${(inter / union).toFixed(2)}）：「${a.p.title}」vs「${b.p.title}」`,
        })
      }
    }
  }

  // 超枢纽：度数 > max(12, 平均×3)
  const avgDeg = pages.length > 0 ? (edges * 2) / pages.length : 0
  const hubCut = Math.max(HUB_MIN_DEGREE, avgDeg * 3)
  const hubs: AuditFinding[] = pages
    .filter((p) => degree(p.path) > hubCut)
    .slice(0, 10)
    .map((p) => ({
      kind: 'hub',
      paths: [p.path],
      titles: [p.title],
      evidence: `度数 ${degree(p.path)}（库均值 ${avgDeg.toFixed(1)}，阈值 ${hubCut.toFixed(1)}）：疑似中心化枢纽，检查是否有低价值连线`,
    }))

  // 桥接边冗余初筛：相连两页正文 token 重叠 < 8%（连线疑似无内容支撑）
  const bodyTokens = new Map(pages.map((p) => [p.path, new Set(tokenize(p.body).slice(0, 2000))]))
  const bridges: AuditFinding[] = []
  for (const [from, outs] of graph) {
    for (const to of outs) {
      const a = bodyTokens.get(from)
      const b = bodyTokens.get(to)
      if (!a || !b) continue
      const inter = [...a].filter((t) => b.has(t)).length
      const union = Math.min(a.size, b.size)
      if (union > 30 && inter / union < BRIDGE_OVERLAP) {
        bridges.push({
          kind: 'bridge',
          paths: [from, to],
          titles: [byPath.get(from)?.title ?? from, byPath.get(to)?.title ?? to],
          evidence: `两端正文 token 重叠 ${(inter / union).toFixed(2)}（阈值 ${BRIDGE_OVERLAP}）：连线疑似缺少内容支撑`,
        })
      }
    }
  }

  return { totalPages: pages.length, edges, orphans, duplicates, hubs, bridges: bridges.slice(0, 30) }
}

// ---------------------------------------------------------------------------
// Phase 2：LLM 判定（批量）→ proposals
// ---------------------------------------------------------------------------

const AuditProposalSchema = Type.Object({
  proposals: Type.Array(
    Type.Object({
      action: Type.Union([Type.Literal('merge'), Type.Literal('addLink'), Type.Literal('removeLink'), Type.Literal('annotate')]),
      /** action 目标页（merge：保留页；addLink/removeLink：两页；annotate：单页） */
      target: Type.String({ description: '目标页 path' }),
      peer: Type.Optional(Type.String({ description: 'addLink/removeLink/merge 的另一页 path' })),
      reason: Type.String({ description: '判定理由（中文一句话）' }),
      confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    }),
    { maxItems: 30 },
  ),
  /** 需要联网补证据的缺漏关联（先库内无据的） */
  needsEvidence: Type.Optional(
    Type.Array(Type.Object({ target: Type.String(), peer: Type.String(), why: Type.String() }), { maxItems: 10 }),
  ),
})
type AuditProposalT = Static<typeof AuditProposalSchema>

const AUDIT_PROMPT = `你是知识图谱的维护审核员。下面是一次自动体检发现的嫌疑清单（孤立节点/疑似重复实体/超枢纽/疑似冗余连线），以及相关页面的标题与摘要。

对每个嫌疑做出判定，输出 JSON：
- proposals[]：可执行的维护建议
  - merge：两页实为同一实体，建议合并（target=保留页，peer=合并页）
  - addLink：两页应有关联但图谱缺失（target/peer 互连）
  - removeLink：连线无内容支撑，建议删除
  - annotate：孤立节点建议补充关联或说明其孤立原因
- needsEvidence[]：addLink 类建议中，库内素材可能不足、需要联网补充证据的（target/peer/why）

判定要求：
1. 只依据给出的信息，不确定就降低 confidence 或不提建议
2. reason 必须具体（"两页都讲 Zettelkasten 编号体系"而非"内容相似"）
3. 数量宁缺毋滥——每条建议都会进入人工审核队列`

export async function judgeFindings(
  deps: AuditDeps,
  report: HealthReport,
  pages: readonly PageDoc[],
): Promise<AuditProposalT | null> {
  const findings = [...report.duplicates, ...report.bridges, ...report.hubs, ...report.orphans]
  if (findings.length === 0) return null
  const byPath = new Map(pages.map((p) => [p.path, p]))
  const findingLines = findings
    .slice(0, 40)
    .map((f, i) => {
      const ctx = f.paths
        .map((p) => {
          const doc = byPath.get(p)
          if (!doc) return `${p}（未读到）`
          return `${doc.title}（${doc.tags.slice(0, 4).join(',')}）摘要：${doc.body.replace(/\s+/g, ' ').slice(0, 160)}`
        })
        .join(' || ')
      return `【${i + 1}】类型=${f.kind} 路径=${f.paths.join(' ↔ ')}：${f.evidence}\n    页面：${ctx}`
    })
    .join('\n')

  try {
    const res = await callLlmJson<AuditProposalT>(
      deps.routing as never,
      'ingest',
      AUDIT_PROMPT,
      [{ role: 'user', text: `嫌疑清单：\n${findingLines}` }],
      AuditProposalSchema,
    )
    return res.report
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Phase 3：建议落盘（suggestions frontmatter）+ 缺漏补链证据双路
// ---------------------------------------------------------------------------

export interface SuggestionRecord {
  origin: 'user' | 'audit'
  note: string
  at: string
  /** audit 提案结构化信息（执行时用） */
  action?: 'merge' | 'addLink' | 'removeLink' | 'annotate'
  peer?: string
  confidence?: number
  evidence?: string
}

/** 把 audit proposals 写进目标页 frontmatter suggestions[]（幂等：同 action+peer+note 不重复加） */
export async function writeSuggestions(
  kbRoot: string,
  proposals: NonNullable<AuditProposalT['proposals']>,
  evidenceMap: Map<string, string> = new Map(),
): Promise<string[]> {
  const written: string[] = []
  const touched = new Set<string>()
  for (const p of proposals) {
    touched.add(p.target)
    if (p.peer) touched.add(p.peer)
  }
  for (const rel of touched) {
    if (!rel.startsWith('wiki/') || rel.includes('..')) continue
    const abs = path.join(kbRoot, rel)
    let text: string
    try {
      text = await readFile(abs, 'utf8')
    } catch {
      continue
    }
    const { fm, body } = parsePage(text)
    const cur = (Array.isArray(fm['suggestions']) ? fm['suggestions'] : []) as SuggestionRecord[]
    let changed = false
    for (const p of proposals) {
      if (p.target !== rel && p.peer !== rel) continue
      if (p.target !== rel) continue // 只写目标页，避免同条建议双写
      const dup = cur.some((s) => s.origin === 'audit' && s.action === p.action && s.peer === p.peer && s.note === p.reason)
      if (dup) continue
      cur.push({
        origin: 'audit',
        note: p.reason,
        at: new Date().toISOString(),
        action: p.action,
        peer: p.peer,
        confidence: p.confidence,
        evidence: evidenceMap.get(`${p.target}|${p.peer ?? ''}`),
      })
      changed = true
    }
    if (changed) {
      await writeFile(abs, serializePage({ ...fm, suggestions: cur }, body), 'utf8')
      written.push(rel)
    }
  }
  return written
}

/** 缺漏补链：先查 sources/ 全文检索；无据且 Tavily 开 → 搜索并物化证据页 */
export async function findLinkEvidence(
  deps: AuditDeps,
  item: { target: string; peer: string; why: string },
  titleA: string,
  titleB: string,
): Promise<{ source: 'sources' | 'web' | 'none'; path?: string; note: string }> {
  const pair = `${titleA} ${titleB}`
  // 1. sources/ 全文检索（简单 includes 扫描，零 token）
  const snap = await scanKb(deps.kbRoot)
  for (const s of snap.sources) {
    try {
      const text = await readFile(path.join(deps.kbRoot, s), 'utf8')
      const hasA = text.toLowerCase().includes(titleA.toLowerCase())
      const hasB = text.toLowerCase().includes(titleB.toLowerCase())
      if (hasA && hasB) {
        return { source: 'sources', path: s, note: `素材 ${s} 同时提及两页主题` }
      }
    } catch { /* 跳过读不了的 */ }
  }
  // 2. Tavily 联网（需启用）→ 物化证据页
  const cfg = await resolveTavilyConfig(deps.dataRoot)
  if (cfg.enabled && cfg.apiKey) {
    try {
      const client = createTavilyClient(cfg.apiKey)
      const r = await client.search(pair, { maxResults: 3 })
      await bumpTavilyUsage(deps.dataRoot, r.credits)
      if (r.hits.length > 0) {
        const hash = createHash('sha256').update(`${titleA}|${titleB}`).digest('hex').slice(0, 10)
        const rel = `sources/url-${hash}.md`
        const body = [
          `# 联网证据：${titleA} × ${titleB}`,
          '',
          `> graph audit 补链检索于 ${new Date().toISOString()}；用途：${item.why}`,
          '',
          r.hits.map((h, i) => `## ${i + 1}. ${h.title || '(无标题)'}\n\n${h.url}\n\n${h.content}`).join('\n\n---\n\n'),
        ].join('\n')
        await mkdir(path.join(deps.kbRoot, 'sources'), { recursive: true })
        await writeFile(path.join(deps.kbRoot, rel), body, 'utf8')
        return { source: 'web', path: rel, note: `联网检索命中 ${r.hits.length} 条，已物化证据页 ${rel}` }
      }
    } catch { /* 网络失败走 none */ }
  }
  return { source: 'none', note: '素材与联网均未找到两页关联的依据' }
}

// ---------------------------------------------------------------------------
// 完整 audit 运行（体检 → 判定 → 补证据 → 落盘建议）
// ---------------------------------------------------------------------------

export interface AuditOutcome {
  health: { totalPages: number; edges: number; findings: number }
  judged: boolean
  proposals: number
  needsEvidenceChecked: number
  evidenceWritten: string[] // 新物化的证据页
  suggestionsWritten: string[] // 写了 suggestions 的页面
  durationMs: number
}

export interface AuditState {
  running: boolean
  startedAt: string | null
  lastOutcome: AuditOutcome | null
}
const auditState: AuditState = { running: false, startedAt: null, lastOutcome: null }
export function getAuditState(): AuditState {
  return { ...auditState, lastOutcome: auditState.lastOutcome ? { ...auditState.lastOutcome } : null }
}

export async function runAudit(deps: AuditDeps, pages: readonly PageDoc[]): Promise<AuditOutcome> {
  if (auditState.running) throw new Error('已有 audit 在运行中')
  auditState.running = true
  auditState.startedAt = new Date().toISOString()
  const started = Date.now()
  try {
    const graph = buildLinkGraph(pages)
    const report = healthCheck(pages, graph)
    const judged = await judgeFindings(deps, report, pages)
    let proposals = judged?.proposals ?? []
    const needsEvidence = judged?.needsEvidence ?? []
    const evidenceMap = new Map<string, string>()
    const evidenceWritten: string[] = []

    // 缺漏补链证据双路（守门：每条 addLink 建议必须找到证据才落盘）
    let checked = 0
    const byPath = new Map(pages.map((p) => [p.path, p]))
    for (const item of needsEvidence.slice(0, 10)) {
      const a = byPath.get(item.target)
      const b = byPath.get(item.peer)
      if (!a || !b) continue
      checked++
      const ev = await findLinkEvidence(deps, item, a.title, b.title)
      const key = `${item.target}|${item.peer}`
      evidenceMap.set(key, ev.note)
      if (ev.path && ev.source === 'web') evidenceWritten.push(ev.path)
      if (ev.source === 'none') {
        // 无据的 addLink 降级为 annotate（说明缺证据，不直接建议连线）
        proposals = proposals.map((p) =>
          p.target === item.target && p.peer === item.peer && p.action === 'addLink'
            ? { ...p, action: 'annotate', peer: undefined, reason: `${p.reason}（补链未找到依据：${ev.note}，暂不建议连线，待人工确认）` }
            : p,
        )
      }
    }

    const suggestionsWritten = proposals.length > 0 ? await writeSuggestions(deps.kbRoot, proposals, evidenceMap) : []
    if (suggestionsWritten.length > 0) {
      await gitCommitAll(deps.kbRoot, `audit: ${proposals.length} 条维护建议写入 ${suggestionsWritten.length} 页`)
    }

    const outcome: AuditOutcome = {
      health: {
        totalPages: report.totalPages,
        edges: report.edges,
        findings: report.orphans.length + report.duplicates.length + report.hubs.length + report.bridges.length,
      },
      judged: judged !== null,
      proposals: proposals.length,
      needsEvidenceChecked: checked,
      evidenceWritten,
      suggestionsWritten,
      durationMs: Date.now() - started,
    }
    auditState.lastOutcome = outcome
    return outcome
  } finally {
    auditState.running = false
    auditState.startedAt = null
  }
}
