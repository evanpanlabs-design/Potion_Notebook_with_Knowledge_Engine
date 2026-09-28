/**
 * index.md 与 log.md 的生成纯函数（ARCHITECTURE §2.3）。
 * index.md：按类别分组，每行 `- [[页面]] · 一句话摘要`，每次 ingest 后重建相关段。
 * log.md：append-only，`## [YYYY-MM-DD HH:mm] <op> | <标题>`，op ∈ {ingest, query, lint, review, note}。
 */

export const LOG_OPS = ['ingest', 'query', 'lint', 'review', 'note'] as const
export type LogOp = (typeof LOG_OPS)[number]

export interface IndexEntry {
  /** 页面名（wikilink 目标，不含 .md） */
  page: string
  /** 一句话摘要 */
  summary: string
  /** 所属类别：entities / concepts / sources / queries / synthesis */
  section: 'entities' | 'concepts' | 'sources' | 'queries' | 'synthesis'
}

const SECTION_ORDER: IndexEntry['section'][] = [
  'entities',
  'concepts',
  'sources',
  'queries',
  'synthesis',
]

/** 由条目列表生成完整 index.md 文本 */
export function renderIndex(entries: readonly IndexEntry[]): string {
  const lines: string[] = ['# 内容目录', '']
  for (const section of SECTION_ORDER) {
    const inSection = entries.filter((e) => e.section === section)
    if (inSection.length === 0) continue
    lines.push(`## ${section}`, '')
    for (const e of inSection) {
      lines.push(`- [[${e.page}]] · ${e.summary}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

interface SplitIndex {
  /** 首个 ## 段之前的序言（如 "# 内容目录" 与空行） */
  preamble: string
  /** 段名 → 段内容（不含 "## 段名" 行本身），保持出现顺序 */
  sections: Map<string, string>
}

const SECTION_HEADER_RE = /^## (.+)$/

/** 把 index.md 文本按 "## 段名" 切成序言 + 有序段表 */
function splitIndexSections(text: string): SplitIndex {
  const preamble: string[] = []
  const sections = new Map<string, string[]>()
  let cur: string | null = null
  for (const line of text.split('\n')) {
    const m = SECTION_HEADER_RE.exec(line)
    if (m?.[1]) {
      cur = m[1].trim()
      sections.set(cur, [])
    } else if (cur === null) {
      preamble.push(line)
    } else {
      sections.get(cur)?.push(line)
    }
  }
  return {
    preamble: preamble.join('\n'),
    sections: new Map([...sections].map(([k, v]) => [k, v.join('\n')])),
  }
}

/** 从完整 index 文本中取出指定段的块（含段头行） */
function extractSectionBlock(text: string, section: string): string {
  const split = splitIndexSections(text)
  const content = split.sections.get(section)
  if (content === undefined) {
    throw new Error(`rebuildIndexSection: 生成的 index 缺少段 ${section}`)
  }
  return `## ${section}\n${content.trimEnd()}\n\n`
}

/**
 * 重建 index.md 的某一个"相关段"：保留其它段不动，只替换本段。
 * 供 ingest 管道增量更新使用（避免整文件抖动，diff 更可读）。
 */
export function rebuildIndexSection(
  currentText: string,
  section: IndexEntry['section'],
  newEntries: readonly IndexEntry[],
): string {
  const secBlock = extractSectionBlock(renderIndex(newEntries), section)
  const { preamble, sections } = splitIndexSections(currentText)
  const out = preamble.trimEnd().length === 0 ? '# 内容目录\n\n' : `${preamble.trimEnd()}\n\n`
  if (sections.has(section)) {
    sections.set(section, secBlock.slice(`## ${section}\n`.length).trimEnd())
    return (
      out +
      [...sections]
        .map(([title, content]) => `## ${title}\n${content.trimEnd()}\n\n`)
        .join('')
    )
  }
  // 当前 index 没有该段：追加到末尾
  const body =
    [...sections]
      .map(([title, content]) => `## ${title}\n${content.trimEnd()}\n\n`)
      .join('') + secBlock
  return out + body
}

/** 生成一条 log.md 条目文本（含结尾换行） */
export function renderLogEntry(
  op: LogOp,
  title: string,
  date = new Date(),
): string {
  if (!LOG_OPS.includes(op)) throw new Error(`renderLogEntry: 未知 op ${String(op)}`)
  const pad = (n: number) => String(n).padStart(2, '0')
  const ts = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `## [${ts}] ${op} | ${title}\n`
}
