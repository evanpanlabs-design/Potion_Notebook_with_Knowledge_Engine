import { Type, type Static } from '@sinclair/typebox'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/**
 * Frontmatter schemas（ARCHITECTURE §2.2）。
 * 注意：source 类型有两种语义——sources/ 目录下的原文没有 frontmatter，
 * wiki/sources/ 下的来源摘要页用 SourcePageFm。
 */
export const SourcePageFm = Type.Object({
  type: Type.Literal('source'),
  title: Type.String(),
  source: Type.String(), // sources/<文件名> 或直接 url
  url: Type.Optional(Type.String()),
  sha256: Type.String(),
  ingested_at: Type.String(),
  tokens: Type.Object({ analysis: Type.Number(), generation: Type.Number() }),
})

export const EntityConceptPageFm = Type.Object({
  type: Type.Union([Type.Literal('entity'), Type.Literal('concept')]),
  title: Type.String(),
  aliases: Type.Optional(Type.Array(Type.String())),
  sources: Type.Array(Type.String(), { minItems: 1 }), // 强制：无 sources 不得落盘
  tags: Type.Optional(Type.Array(Type.String())),
  reviewed: Type.Optional(Type.Boolean({ default: false })),
  updated_at: Type.String(),
})

export const NoteFm = Type.Object({
  type: Type.Literal('note'),
  title: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String(),
  provenance: Type.Union([
    Type.Literal('manual'),
    Type.Literal('archived-thread'),
    Type.Literal('pulled-from-wiki'),
  ]),
  sources: Type.Optional(Type.Array(Type.String())),
})

export const QueryPageFm = Type.Object({
  type: Type.Literal('query'),
  question: Type.String(),
  sources: Type.Array(Type.String()),
  created_at: Type.String(),
})

export type SourcePageFmT = Static<typeof SourcePageFm>
export type EntityConceptPageFmT = Static<typeof EntityConceptPageFm>
export type NoteFmT = Static<typeof NoteFm>
export type QueryPageFmT = Static<typeof QueryPageFm>

/** frontmatter schema 表：type 字段 → TypeBox schema */
export const FM_SCHEMAS = {
  source: SourcePageFm,
  entity: EntityConceptPageFm,
  concept: EntityConceptPageFm,
  note: NoteFm,
  query: QueryPageFm,
} as const

export type PageType = keyof typeof FM_SCHEMAS

export interface ParsedPage {
  fm: Record<string, unknown>
  body: string
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** 解析一篇 Markdown 页面：frontmatter（YAML）+ 正文。无 frontmatter 时 fm 为空对象 */
export function parsePage(text: string): ParsedPage {
  const m = FM_RE.exec(text)
  if (!m) return { fm: {}, body: text }
  const raw = m[1] ?? ''
  const fm = (parseYaml(raw) ?? {}) as Record<string, unknown>
  const body = text.slice(m[0].length)
  return { fm, body }
}

/** 序列化一篇页面：frontmatter + 正文 */
export function serializePage(fm: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(fm).trimEnd()}\n---\n${body}`
}
