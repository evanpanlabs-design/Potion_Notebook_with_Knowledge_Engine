/**
 * F5 检索层（ARCHITECTURE §6.5 级联的 MVP 子集，纯函数）：
 *   L1 词法匹配（页面名/aliases/title/tags vs 问题分词）
 *   L2 图扩展（命 中页沿 [[wikilink]] 2 跳扩邻居，MVP 不做 LLM 关键词/PPR）
 *   + 上下文组装（预算内塞整页全文，60/20/5/15 原则的简化版：页面优先整页）
 *
 * 输入是"页面语料快照"（server 侧扫描库后构建），保证本模块零 IO 可测。
 */
import { extractWikiLinks, normalizePageName } from './wikilink.ts'

export interface PageDoc {
  /** 库内相对路径 wiki/entities/foo.md */
  path: string
  /** frontmatter title */
  title: string
  aliases: string[]
  tags: string[]
  body: string
}

/** 从页面集构建 name → path 索引（wikilink 目标解析用） */
export function buildPageIndex(pages: readonly PageDoc[]): Map<string, string> {
  const idx = new Map<string, string>()
  for (const p of pages) {
    idx.set(normalizePageName(p.title), p.path)
    for (const a of p.aliases) idx.set(normalizePageName(a), p.path)
    // 文件名兜底
    idx.set(normalizePageName(p.path.replace(/^.*\//, '').replace(/\.md$/, '')), p.path)
  }
  return idx
}

/** 页面正文的 wikilink 出边（path → path） */
export function buildLinkGraph(pages: readonly PageDoc[]): Map<string, Set<string>> {
  const idx = buildPageIndex(pages)
  const g = new Map<string, Set<string>>()
  for (const p of pages) {
    const outs = new Set<string>()
    for (const l of extractWikiLinks(p.body)) {
      const target = idx.get(normalizePageName(l.target))
      if (target && target !== p.path) outs.add(target)
    }
    g.set(p.path, outs)
  }
  return g
}

/** 中英混排粗分词：英文按词、中文按 2-gram（MVP 够用；不引分词库） */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const latin = text.toLowerCase().match(/[a-z][a-z0-9-]{1,}/g) ?? []
  out.push(...latin)
  const cjk = text.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const seg of cjk) {
    if (seg.length <= 2) {
      out.push(seg)
    } else {
      for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2))
    }
  }
  return out
}

export interface LexHit {
  path: string
  score: number
}

/** L1 词法匹配：页面名命中权重远高于正文命中 */
export function lexicalMatch(query: string, pages: readonly PageDoc[], opts: { limit?: number } = {}): LexHit[] {
  const limit = opts.limit ?? 8
  const qTokens = new Set(tokenize(query))
  const rawQuery = query.toLowerCase().trim()
  const hits: LexHit[] = []
  for (const p of pages) {
    let score = 0
    // 1. 页面名/别名整串命中（最强信号）
    const names = [p.title, ...p.aliases].map((n) => n.toLowerCase())
    if (names.some((n) => n === rawQuery)) score += 100
    else if (names.some((n) => rawQuery.includes(n) || n.includes(rawQuery))) score += 50
    // 2. 名字 token 命中
    for (const n of names) {
      for (const t of tokenize(n)) {
        if (qTokens.has(t)) score += 10
      }
    }
    // 3. tags 命中
    for (const tag of p.tags) {
      if (qTokens.has(tag.toLowerCase())) score += 8
    }
    // 4. 正文 token 命中（密度计分）
    const bodyTokens = tokenize(p.body)
    if (bodyTokens.length > 0) {
      let matched = 0
      for (const t of bodyTokens) {
        if (qTokens.has(t)) matched++
      }
      score += Math.min(20, (matched / bodyTokens.length) * 200)
    }
    if (score > 0) hits.push({ path: p.path, score })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** L2 图扩展：从 L1 命中页沿出边 + 入边 2 跳找邻居，给低分补位（不挤掉词法命中） */
export function graphExpand(seeds: readonly LexHit[], graph: Map<string, Set<string>>, opts: { limit?: number; hop2Score?: number } = {}): LexHit[] {
  const limit = opts.limit ?? 10
  const hop2Score = opts.hop2Score ?? 2
  const inEdges = new Map<string, Set<string>>()
  for (const [from, outs] of graph) {
    for (const to of outs) {
      if (!inEdges.has(to)) inEdges.set(to, new Set())
      inEdges.get(to)!.add(from)
    }
  }
  const merged = new Map(seeds.map((h) => [h.path, h.score]))
  const bump = (path: string, score: number) => {
    merged.set(path, (merged.get(path) ?? 0) + score)
  }
  for (const seed of seeds) {
    const outs1 = graph.get(seed.path) ?? new Set<string>()
    const ins1 = inEdges.get(seed.path) ?? new Set<string>()
    for (const n of [...outs1, ...ins1]) bump(n, 5) // 1 跳
    for (const n of outs1) {
      for (const n2 of graph.get(n) ?? []) bump(n2, hop2Score) // 2 跳（沿出边）
    }
  }
  return [...merged.entries()]
    .map(([path, score]) => ({ path, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export interface AssembledContext {
  /** 选中页面（按分排序，已填全文） */
  pages: Array<{ path: string; score: number; title: string; aliases: string[]; body: string }>
  /** 被预算裁掉的页面名 */
  dropped: string[]
}

/** 上下文组装：预算内塞整页（ARCHITECTURE 原则：答案由整页生成，绝不用碎片） */
export function assembleContext(
  hits: readonly LexHit[],
  pages: readonly PageDoc[],
  opts: { charBudget?: number } = {},
): AssembledContext {
  const budget = opts.charBudget ?? 24_000
  const byPath = new Map(pages.map((p) => [p.path, p]))
  const out: AssembledContext['pages'] = []
  let used = 0
  const dropped: string[] = []
  for (const h of hits) {
    const p = byPath.get(h.path)
    if (!p) continue
    const cost = p.body.length + p.title.length + h.path.length + 32
    if (used + cost > budget) {
      dropped.push(p.title)
      continue
    }
    used += cost
    out.push({ path: h.path, score: h.score, title: p.title, aliases: p.aliases, body: p.body })
  }
  return { pages: out, dropped }
}
