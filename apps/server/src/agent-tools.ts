/**
 * Agent 工具注册表（ADR-003 D1，阶段 A · ToolCall 检索工具化）。
 *
 * 四个只读工具 + 一个联网工具，全部走 TypeBox 参数 schema：
 *   search_kb       库内词法检索（复用 core lexicalMatch）
 *   read_page       读整页（标题/别名/正文，预算截断）
 *   list_neighbors  图邻居（出边+入边，带页面名）
 *   web_search      Tavily 联网搜索（启用时才注册——白名单即围栏）
 *
 * 围栏（ADR-002 阶段 A 原则）：工具只读；写操作一律走 gate executor，不在这里开口子。
 * Tavily 配置：data/tavily-config.json（key + enabled + 用量）> 环境变量 TAVILY_API_KEY（默认关）。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { Type } from '@sinclair/typebox'
import { scanKb, parsePage, lexicalMatch, buildLinkGraph, type PageDoc } from '@ke/core'
import { createTavilyClient, tavilyKeyFromEnv, defineAgentTool, type AgentToolSpec } from '@ke/agent-tools'

// ---------------------------------------------------------------------------
// Tavily 配置（与 mineru-config 同层同风格：本地文件不入 KB git）
// ---------------------------------------------------------------------------

export interface TavilyConfig {
  apiKey: string
  enabled: boolean
  /** 当月用量（搜索次数；免费档 1000/月） */
  usedMonth: string | null // 'YYYY-MM'
  usedCount: number
}

export function tavilyConfigPath(dataRoot: string): string {
  return path.join(dataRoot, 'tavily-config.json')
}

export async function resolveTavilyConfig(dataRoot: string): Promise<TavilyConfig> {
  let file: Partial<TavilyConfig> = {}
  try {
    file = JSON.parse(await readFile(tavilyConfigPath(dataRoot), 'utf8')) as Partial<TavilyConfig>
  } catch { /* 无文件，走 env */ }
  const apiKey = (typeof file.apiKey === 'string' && file.apiKey.trim()) || tavilyKeyFromEnv() || ''
  const month = new Date().toISOString().slice(0, 7)
  return {
    apiKey,
    enabled: typeof file.enabled === 'boolean' ? file.enabled : false,
    usedMonth: typeof file.usedMonth === 'string' ? file.usedMonth : null,
    usedCount: typeof file.usedCount === 'number' ? file.usedCount : 0,
  }
}

export async function saveTavilyConfig(dataRoot: string, patch: Partial<TavilyConfig>): Promise<TavilyConfig> {
  const cur = await resolveTavilyConfig(dataRoot)
  const next: TavilyConfig = { ...cur, ...patch }
  await mkdir(dataRoot, { recursive: true })
  await writeFile(tavilyConfigPath(dataRoot), JSON.stringify(next, null, 2), 'utf8')
  return next
}

/** 月度额度（免费档）；到量即拒绝（守门在工具注册处） */
export const TAVILY_MONTHLY_LIMIT = 1000

export async function bumpTavilyUsage(dataRoot: string, credits: number): Promise<void> {
  const cfg = await resolveTavilyConfig(dataRoot)
  const month = new Date().toISOString().slice(0, 7)
  const usedMonth = cfg.usedMonth === month ? month : month
  const usedCount = (cfg.usedMonth === month ? cfg.usedCount : 0) + credits
  await saveTavilyConfig(dataRoot, { usedMonth, usedCount })
}

// ---------------------------------------------------------------------------
// 库工具构建（页面语料由调用方一次性扫描，工具执行时零 IO 之外的重复扫描）
// ---------------------------------------------------------------------------

async function loadPageDocs(kbRoot: string): Promise<PageDoc[]> {
  const snap = await scanKb(kbRoot)
  const out: PageDoc[] = []
  for (const p of snap.pages) {
    const text = await readFile(path.join(kbRoot, p), 'utf8')
    const { fm, body } = parsePage(text)
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

export interface KbToolsDeps {
  kbRoot: string
  dataRoot: string
}

/** 构建库内三件套只读工具 + 按需挂 web_search */
export async function buildKbTools(deps: KbToolsDeps): Promise<AgentToolSpec[]> {
  const { kbRoot, dataRoot } = deps
  const pages = await loadPageDocs(kbRoot)
  const graph = buildLinkGraph(pages)
  const byPath = new Map(pages.map((p) => [p.path, p]))
  const byTitle = new Map(pages.map((p) => [p.title, p]))
  const inEdges = new Map<string, Set<string>>()
  for (const [from, outs] of graph) {
    for (const to of outs) {
      if (!inEdges.has(to)) inEdges.set(to, new Set())
      inEdges.get(to)!.add(from)
    }
  }

  const tools: AgentToolSpec[] = [
    defineAgentTool({
      name: 'search_kb',
      description: '在知识库中检索与查询相关的页面（词法匹配）。返回页面路径、标题与相关度评分。先用它找页面，再用 read_page 读全文。',
      parameters: Type.Object({
        query: Type.String({ description: '检索词（中文或英文，尽量用页面标题里的关键词）' }),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10, default: 5, description: '返回条数上限' })),
      }),
      async execute({ query, limit }) {
        const hits = lexicalMatch(query, pages, { limit: limit ?? 5 })
        if (hits.length === 0) return { content: '库内无命中。可尝试换关键词（如页面标题中的实体名）或用 web_search 查库外资料。' }
        const lines = hits.map((h) => {
          const p = byPath.get(h.path)
          return `- ${p?.title ?? h.path}（path: ${h.path}，score ${Math.round(h.score)}）`
        })
        return { content: `命中 ${hits.length} 页：\n${lines.join('\n')}` }
      },
    }),
    defineAgentTool({
      name: 'read_page',
      description: '读取库内一页的完整正文（含标题与别名）。输入 search_kb 返回的 path 或页面标题。',
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: '页面库内路径，如 wiki/entities/foo.md' })),
        title: Type.Optional(Type.String({ description: '页面标题（path 未提供时按标题找）' })),
      }),
      async execute({ path: rel, title }) {
        let p = rel ? byPath.get(rel) : undefined
        if (!p && title) p = byTitle.get(title)
        if (!p && rel) {
          // 宽容匹配：裸文件名或去 .md 后缀
          const base = rel.replace(/^.*\//, '').replace(/\.md$/, '')
          p = pages.find((x) => x.path.replace(/^.*\//, '').replace(/\.md$/, '') === base)
        }
        if (!p) return { content: `未找到页面：${rel ?? title ?? '(空)'}。请用 search_kb 先检索。`, isError: true }
        const body = p.body.length > 12_000 ? `${p.body.slice(0, 12_000)}\n…（正文过长已截断）` : p.body
        return { content: `# ${p.title}\n\npath: ${p.path}\n${p.aliases.length ? `aliases: ${p.aliases.join(', ')}\n` : ''}\n${body}` }
      },
    }),
    defineAgentTool({
      name: 'list_neighbors',
      description: '列出某页面在知识图谱中的直接关联页面（出边 + 入边），用于顺藤摸瓜扩展调查范围。',
      parameters: Type.Object({
        path: Type.String({ description: '页面库内路径（search_kb / read_page 返回的 path）' }),
      }),
      async execute({ path: rel }) {
        const p = byPath.get(rel)
        if (!p) return { content: `未找到页面：${rel}`, isError: true }
        const outs = [...(graph.get(rel) ?? [])]
        const ins = [...(inEdges.get(rel) ?? [])]
        if (outs.length + ins.length === 0) return { content: '该页面没有图谱关联（孤立节点）。' }
        const fmt = (list: string[], dir: string) =>
          list.map((x) => `- [${dir}] ${byPath.get(x)?.title ?? x}（${x}）`).join('\n')
        return {
          content: [
            outs.length ? `出边（本页引用）：\n${fmt(outs, '→')}` : '',
            ins.length ? `入边（被引用）：\n${fmt(ins, '←')}` : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        }
      },
    }),
  ]

  // ---------- web_search（Tavily 启用且有 key 时才进白名单） ----------
  const tavily = await resolveTavilyConfig(dataRoot)
  if (tavily.enabled && tavily.apiKey) {
    const client = createTavilyClient(tavily.apiKey)
    tools.push(
      defineAgentTool({
        name: 'web_search',
      description: '联网搜索（Tavily）。用于知识库内没有的时效性/外部信息。返回标题、URL 与内容摘要。注意：搜索结果需先作为素材入库才能被引用为知识。',
      parameters: Type.Object({
        query: Type.String({ description: '搜索查询词' }),
        maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 10, default: 5, description: '返回条数' })),
      }),
      async execute({ query, maxResults }) {
        const cfg = await resolveTavilyConfig(dataRoot)
        const month = new Date().toISOString().slice(0, 7)
        const used = cfg.usedMonth === month ? cfg.usedCount : 0
        if (used >= TAVILY_MONTHLY_LIMIT) {
          return { content: `Tavily 月度额度已用尽（${used}/${TAVILY_MONTHLY_LIMIT}）。请到设置页更换 key 或下月再试。`, isError: true }
        }
        const r = await client.search(query, { maxResults })
        await bumpTavilyUsage(dataRoot, r.credits)
        if (r.hits.length === 0) return { content: `无搜索结果：${query}` }
        const lines = r.hits.map((h, i) => `### ${i + 1}. ${h.title}\nURL: ${h.url}\n${h.content.slice(0, 800)}`)
        return { content: `搜索「${query}」命中 ${r.hits.length} 条（本月已用 ${used + r.credits}/${TAVILY_MONTHLY_LIMIT}）：\n\n${lines.join('\n\n')}` }
      },
      })
    )
  }

  return tools
}

export { process }
