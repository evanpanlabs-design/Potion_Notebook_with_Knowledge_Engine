/**
 * 知识库（KB）文件层（D2）：建库、目录约定、库扫描、AGENTS.md 词表解析。
 * 纯 fs/git 操作，全部集中在 server 侧调用；本模块不做 LLM 相关任何事。
 * 目录约定（ARCHITECTURE §2）：
 *   sources/          原始素材（无 frontmatter，不可变）
 *   wiki/entities/    实体页
 *   wiki/concepts/    概念页
 *   wiki/sources/     来源摘要页
 *   wiki/queries/     query 归档页
 *   notes/            用户笔记（Agent 不可写）
 *   index.md          内容目录（F4 跳转入口）
 *   log.md            append-only 流水
 *   AGENTS.md         Agent 行为 schema（tags 词表在此定义）
 */
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'

export const KB_DIRS = [
  'sources',
  'wiki/entities',
  'wiki/concepts',
  'wiki/sources',
  'wiki/queries',
  'notes',
] as const

export const DEFAULT_AGENTS_MD = `# AGENTS.md — Agent 行为 schema

> 本文件定义 Agent 在本库上的行为约束。人可以直接编辑；重启 server 后生效。

## tags 词表

- ai
- agent
- knowledge-graph
- note-taking
- retrieval
- product
- engineering

## 行为约定

- ingest 时：先分析后生成，一次 ingest 一次 git 提交
- Wiki 页必须带 sources[] 引用，无依据不落盘
- notes/ 由人所有，Agent 只有建议权
`

/** 建库：目录骨架 + AGENTS.md/index.md/log.md 初始化。已存在的库幂等（不覆盖已有文件） */
export async function initKb(root: string): Promise<{ created: string[]; existed: boolean }> {
  const created: string[] = []
  for (const dir of KB_DIRS) {
    const p = path.join(root, dir)
    await mkdir(p, { recursive: true })
    created.push(dir)
  }
  const files: Array<[string, string]> = [
    ['AGENTS.md', DEFAULT_AGENTS_MD],
    ['index.md', '# 内容目录\n'],
    ['log.md', '# 操作流水\n'],
  ]
  for (const [rel, content] of files) {
    const p = path.join(root, rel)
    try {
      await readFile(p, 'utf8')
      // 已存在：不覆盖
    } catch {
      await writeFile(p, content, 'utf8')
    }
  }
  return { created, existed: false }
}

/** 解析 AGENTS.md 的 tags 词表段（## tags 词表 之后的 - 列表） */
export async function readTagVocabulary(agentsMdPath: string): Promise<string[]> {
  let text: string
  try {
    text = await readFile(agentsMdPath, 'utf8')
  } catch {
    return []
  }
  const m = /##\s*tags[^\n]*\n([\s\S]*?)(?=\n## |$)/i.exec(text)
  if (!m?.[1]) return []
  return [...m[1].matchAll(/^\s*-\s+(.+)$/gm)].map((x) => x[1]!.trim()).filter(Boolean)
}

export interface KbSnapshot {
  /** 全部 wiki 页面相对路径（wiki 下所有 .md） */
  pages: Set<string>
  /** sources/ 下全部文件相对路径 */
  sources: Set<string>
  /** reviewed:true 的页面路径 */
  reviewedPages: Set<string>
}

async function walkMd(root: string, rel: string, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(path.join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const relPath = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) await walkMd(root, relPath, out)
    else if (e.name.endsWith('.md')) out.push(relPath)
  }
}

/** 扫描库快照（闸门校验链的 GateContext 来源）。reviewed 状态需读 frontmatter */
export async function scanKb(root: string): Promise<KbSnapshot> {
  const { parsePage } = await import('./frontmatter.ts')
  const pages = new Set<string>()
  const sources = new Set<string>()
  const reviewedPages = new Set<string>()

  const wikiFiles: string[] = []
  await walkMd(root, 'wiki', wikiFiles)
  for (const f of wikiFiles) {
    pages.add(f)
    const text = await readFile(path.join(root, f), 'utf8')
    if (parsePage(text).fm['reviewed'] === true) reviewedPages.add(f)
  }

  const sourceFiles: string[] = []
  await walkMd(root, 'sources', sourceFiles)
  for (const f of sourceFiles) sources.add(f)

  return { pages, sources, reviewedPages }
}
