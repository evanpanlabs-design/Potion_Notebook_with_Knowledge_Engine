import { Value } from '@sinclair/typebox/value'
import { FM_SCHEMAS, type PageType } from './frontmatter.ts'

/**
 * 写入闸门校验链（ARCHITECTURE §4）。
 * 纯函数、无 IO：库状态由调用方以快照形式传入。
 * 任何一环失败 = 零落盘；tags 界外是唯一"丢弃并警告"（不拒绝）的环。
 */

export type GateOperation = 'create' | 'update' | 'append'

export interface PageProposal {
  /** 库内相对路径，如 wiki/entities/foo.md */
  path: string
  /** 解析前的 frontmatter 对象 */
  fm: Record<string, unknown>
  body: string
  operation: GateOperation
}

/** 校验链所需的库状态快照（全部由调用方预提取，保持本模块纯函数） */
export interface GateContext {
  /** 已存在的页面路径集合（相对库根） */
  existingPages: ReadonlySet<string>
  /** 已存在的来源文件路径集合（sources/ 下，相对库根） */
  existingSources: ReadonlySet<string>
  /** frontmatter reviewed=true 的页面路径集合 */
  reviewedPages: ReadonlySet<string>
  /** AGENTS.md tags: 段定义的词表 */
  tagVocabulary: readonly string[]
  /** 允许写入 notes/ 的豁免操作（pull_wiki_to_note 用户显式触发）；默认无 */
  allowNoteWrite?: boolean
}

export interface GateResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  /** 净化后的提案（界外 tags 已被丢弃）；仅在 ok=true 时有意义 */
  sanitized: PageProposal | null
  /** 按路径推断的页面类型（schema 路由用） */
  pageType: PageType | null
}

function inferPageType(proposal: PageProposal): PageType | null {
  const t = proposal.fm['type']
  if (typeof t !== 'string') return null
  return (Object.keys(FM_SCHEMAS) as PageType[]).includes(t as PageType)
    ? (t as PageType)
    : null
}

/**
 * 校验链五环（顺序即 ARCHITECTURE §4）：
 * 1. frontmatter schema（TypeBox）
 * 2. tag 词表（界外丢弃 + 警告）
 * 3. sources[] 存在性
 * 4. reviewed:true 保护（只允许 append）
 * 5. notes/ 保护
 */
export function validateProposal(p: PageProposal, ctx: GateContext): GateResult {
  const errors: string[] = []
  const warnings: string[] = []
  const fm = { ...p.fm }

  // 环 5：notes/ 保护（先判路径，语义上"这页根本不归 Agent 管"）
  const isNote = p.path.startsWith('notes/')
  if (isNote && !ctx.allowNoteWrite) {
    errors.push(`gate:note-protected 路径 ${p.path} 位于 notes/，Agent 无写入权限（人所有）`)
  }

  // 环 1：schema 校验
  const pageType = inferPageType(p)
  if (pageType === null) {
    errors.push(
      `gate:schema frontmatter.type 缺失或未知（得到 ${JSON.stringify(p.fm['type'])}）`,
    )
  } else {
    const schema = FM_SCHEMAS[pageType]
    // 先落 boolean 再判断：Value.Check 是类型谓词，直接放 if 条件会窄化 fm，
    // 导致后续按 Record<string, unknown> 索引 tags/sources 报 TS7053
    const schemaOk = Value.Check(schema, fm)
    if (!schemaOk) {
      const detail = [...Value.Errors(schema, fm)]
        .slice(0, 5)
        .map((e) => `${e.path}: ${e.message}`)
        .join('; ')
      errors.push(`gate:schema ${pageType} 页 frontmatter 不合规：${detail}`)
    }
  }

  // 环 2：tag 词表（丢弃 + 警告，不拒绝）
  // Value.Check 是类型谓词，即便赋给中间变量也会窄化 fm；rec 显式重置为 Record 视图
  const rec = fm as Record<string, unknown>
  const tags = rec['tags']
  if (Array.isArray(tags)) {
    const vocab = new Set(ctx.tagVocabulary)
    const kept = tags.filter((t): t is string => typeof t === 'string' && vocab.has(t))
    const dropped = tags.filter((t) => !(typeof t === 'string' && vocab.has(t)))
    if (dropped.length > 0) {
      warnings.push(`gate:vocab 词表外 tags 已丢弃：${dropped.join(', ')}`)
      if (kept.length === 0) delete rec['tags']
      else rec['tags'] = kept
    }
  }

  // 环 3：sources 存在性（entity/concept/query 强制；source 摘要页的 source 字段单独验）
  const sources = rec['sources']
  if (Array.isArray(sources)) {
    const missing = sources.filter((s) => typeof s === 'string' && !ctx.existingSources.has(s))
    if (missing.length > 0) {
      errors.push(`gate:sources 引用的来源不存在：${missing.join(', ')}`)
    }
  }
  if (pageType === 'source') {
    const src = rec['source']
    if (typeof src === 'string' && !ctx.existingSources.has(src) && !/^https?:\/\//.test(src)) {
      errors.push(`gate:sources source 摘要页指向的来源不存在：${src}`)
    }
  }

  // 环 4：reviewed:true 保护（人审页面 Agent 不得覆盖，只允许追加）
  if (ctx.reviewedPages.has(p.path)) {
    if (p.operation === 'update') {
      errors.push(`gate:reviewed 页面 ${p.path} 已人审定稿（reviewed:true），仅允许 append`)
    } else if (p.operation === 'append') {
      warnings.push(`gate:reviewed 页面 ${p.path} 为受保护页，本次为受审追加`)
    }
  }

  const ok = errors.length === 0
  return {
    ok,
    errors,
    warnings,
    sanitized: ok ? { ...p, fm: rec } : null,
    pageType,
  }
}
