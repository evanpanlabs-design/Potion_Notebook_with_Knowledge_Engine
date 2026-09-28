import { Type, type Static } from '@sinclair/typebox'

/**
 * 两段式 ingest 的 LLM 结构化输出 schema（ARCHITECTURE §6.2，对应 ingest-pipeline.ts 两段调用）。
 * Phase1 分析：输出 entities/concepts/claims 结构化清单（不含正文写作）。
 * Phase2 生成：输入 Phase1 结果 + 库内相关页，输出对每个待写页面的正文。
 * TypeBox schema 一份三用：prompt 内嵌 schema 说明 → LLM 输出校验 → server API 校验。
 */

const Claim = Type.Object({
  /** 主张一句话 */
  statement: Type.String(),
  /** 该主张出自来源的哪部分（章节/段落标识，自由文本） */
  locus: Type.String(),
})

const EntityAnalysis = Type.Object({
  name: Type.String(),
  /** 实体一句话定义 */
  definition: Type.String(),
  /** 已知别名（无则空数组） */
  aliases: Type.Optional(Type.Array(Type.String())),
  claims: Type.Array(Claim),
  /** 建议 tags（须在词表内，闸门会再验） */
  tags: Type.Optional(Type.Array(Type.String())),
})

const ConceptAnalysis = Type.Object({
  name: Type.String(),
  definition: Type.String(),
  claims: Type.Array(Claim),
  tags: Type.Optional(Type.Array(Type.String())),
})

/** Phase1 分析结果（analyze 段的结构化输出） */
export const AnalysisReport = Type.Object({
  /** 来源的一句话摘要 */
  summary: Type.String(),
  /** 来源语言（en/zh 等） */
  language: Type.String(),
  entities: Type.Array(EntityAnalysis, { maxItems: 20 }),
  concepts: Type.Array(ConceptAnalysis, { maxItems: 20 }),
})
export type AnalysisReportT = Static<typeof AnalysisReport>

/** Phase2 单页生成结果 */
export const PageGeneration = Type.Object({
  /** 实体/概念名（与 Phase1 的 name 对应） */
  name: Type.String(),
  /** 页面正文（Markdown，含 [[wikilink]]，不含 frontmatter——由管道组装） */
  body: Type.String(),
  /** 正文中用到的 sources 引用（闸门验存在性） */
  sources: Type.Array(Type.String(), { minItems: 1 }),
})

/** Phase2 生成结果（generate 段的结构化输出） */
export const GenerationResult = Type.Object({
  pages: Type.Array(PageGeneration, { maxItems: 40 }),
})
export type GenerationResultT = Static<typeof GenerationResult>

/** 从 JSON 文本解析 LLM 输出（容错：剥 markdown 代码块包裹、剥 <summation>） */
export function parseLlmJson<T>(text: string): T {
  let t = text.trim()
  t = t.replace(/^<summation>[\s\S]*?<\/summation>\s*/i, '') // 推理模型包裹
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  if (fence?.[1]) t = fence[1].trim()
  const first = t.indexOf('{')
  const last = t.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('parseLlmJson: 输出中找不到 JSON 对象')
  }
  return JSON.parse(t.slice(first, last + 1)) as T
}
