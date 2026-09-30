/**
 * Tavily 联网搜索客户端（ADR-003 D1）。
 *
 * 决策背景（2026-09-28 + ADR-003 D3）：Tavily 走 REST 直封装为内部工具，
 * 不做 MCP——我们的工具注册表是 TypeBox 自有体系，直接 REST 更一致且零依赖。
 *
 * - 免费档 1000 次/月；用量按月落盘计数（data/tavily-config.json），超限由调用方守门
 * - 超时 15s；非 2xx 或业务错误抛异常（工具层 catch 后以 isError 回给模型）
 * - API 契约：POST https://api.tavily.com/search（Bearer key），参考官方 v1 文档
 */
import process from 'node:process'

export interface TavilyHit {
  title: string
  url: string
  content: string
  score: number
}

export interface TavilySearchResult {
  query: string
  hits: TavilyHit[]
  /** 本次消耗的搜索次数（basic 档 = 1） */
  credits: number
}

export interface TavilyOptions {
  /** 每次返回条数（1-10，默认 5） */
  maxResults?: number
  /** 搜索深度 basic / advanced（advanced 消耗 2 credits） */
  searchDepth?: 'basic' | 'advanced'
  /** 是否包含答案摘要（不占额外 credit） */
  includeAnswer?: boolean
  timeoutMs?: number
}

/** 最低限度的 fetch 兼容（Node 22+ 原生 fetch 即可） */
type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export function createTavilyClient(apiKey: string, fetchImpl: FetchLike = ((u, i) => fetch(u, i)) as FetchLike) {
  const key = apiKey.trim()
  if (!key) throw new Error('Tavily key 为空：请先在设置页配置')

  async function search(query: string, opts: TavilyOptions = {}): Promise<TavilySearchResult> {
    const maxResults = Math.max(1, Math.min(10, opts.maxResults ?? 5))
    const depth = opts.searchDepth ?? 'basic'
    const body = {
      query,
      max_results: maxResults,
      search_depth: depth,
      include_answer: opts.includeAnswer ?? false,
      topic: 'news',
    }
    const res = await fetchImpl('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Tavily ${res.status}：${text.slice(0, 200)}`)
    }
    const data = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string; score?: number }>
    }
    const hits: TavilyHit[] = (data.results ?? [])
      .filter((r) => typeof r.url === 'string')
      .map((r) => ({
        title: r.title ?? '',
        url: r.url!,
        content: r.content ?? '',
        score: r.score ?? 0,
      }))
    return { query, hits, credits: depth === 'advanced' ? 2 : 1 }
  }

  return { search }
}

/** 环境变量兜底（与 LLM 配置同策略：设置页文件 > env） */
export function tavilyKeyFromEnv(): string | null {
  const v = process.env.TAVILY_API_KEY?.trim()
  return v || null
}
