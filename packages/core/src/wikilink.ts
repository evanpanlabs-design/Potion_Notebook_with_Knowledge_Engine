/**
 * [[wikilink]] 解析（ARCHITECTURE §2.1，Obsidian 兼容语法）。
 * 支持：[[page]]、[[page|alias]]、[[page#heading]]、[[page#heading|alias]]
 */

export interface WikiLink {
  /** 目标页面名（去 alias/heading 后的裸名） */
  target: string
  /** 锚点（# 后部分），无则 null */
  heading: string | null
  /** 显示别名（| 后部分），无则 null */
  alias: string | null
  /** 在原文中的起始偏移 */
  offset: number
}

const LINK_RE = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g

/** 提取正文中全部 wikilink */
export function extractWikiLinks(body: string): WikiLink[] {
  const out: WikiLink[] = []
  for (const m of body.matchAll(LINK_RE)) {
    const target = (m[1] ?? '').trim()
    if (target === '') continue
    out.push({
      target,
      heading: m[2]?.trim() ?? null,
      alias: m[3]?.trim() ?? null,
      offset: m.index ?? 0,
    })
  }
  return out
}

/** 页面名（不含扩展名、不含路径）标准化：用于 wikilink 与文件路径的匹配 */
export function normalizePageName(name: string): string {
  return name.replace(/\.md$/i, '').trim().toLowerCase()
}
