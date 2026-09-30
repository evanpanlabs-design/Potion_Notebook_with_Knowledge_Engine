/**
 * digest 任务运行器（ADR-003 D4-5：LLM 综合日报版）。
 *
 * 管线：Tavily 搜索 → 结果物化 sources/inbox-<date>-<slug>.md 证据页 →
 * LLM 综合成 inbox/<date>-<slug>.md 日报（带建议消化动作）→ git 留痕。
 *
 * 溯源守门（2026-09-28 决策）：wiki 可引用的依据必须先物化到 sources/——
 * 搜索命中先落证据页，日报正文中的信息都可回溯；「消化进图谱」按钮
 * 直接 ingest 该证据页，等于复用既有管线（零新机制）。
 *
 * inbox/ 不在 scanKb 集合内——收件箱内容天然不进图谱；同日同主题重跑覆盖（幂等）。
 * LLM 未配置时降级为 D2-3 的原始快报（不 fail 任务）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Type, type Static } from '@sinclair/typebox'
import { serializePage, type ScheduledTask } from '@ke/core'
import type { SimpleMessage } from '@ke/agent-tools'
import { createTavilyClient } from '@ke/agent-tools'
import { resolveTavilyConfig, bumpTavilyUsage, TAVILY_MONTHLY_LIMIT } from './agent-tools.ts'
import { callLlmJson, gitCommitAll } from './ingest-pipeline.ts'
import type { TaskRunner } from './scheduler.ts'

/** LLM 综合输出的 schema（宽松：字段缺失就降级原始快报） */
const DigestReport = Type.Object({
  summary: Type.String({ description: '一段话综述（80 字内）' }),
  highlights: Type.Array(
    Type.Object({
      title: Type.String(),
      point: Type.String({ description: '这条资讯的要点，一两句' }),
      url: Type.Optional(Type.String()),
    }),
    { maxItems: 8 },
  ),
  suggestion: Type.Optional(Type.String({ description: '给用户的一条消化建议（可选）' })),
})
type DigestReportT = Static<typeof DigestReport>

const DIGEST_PROMPT = `你是知识引擎的日报编辑。把给你的搜索结果（标题/URL/摘要）综合成一份简报。

要求：
1. summary：80 字内概括今天该主题的整体动向
2. highlights：3-6 条最有信息量的资讯（合并同事件的多条来源），每条一两句讲清楚"发生了什么、为什么值得关注"
3. suggestion：可选。如果某条内容与用户知识库可能强相关，给一条"是否消化进图谱"的建议
4. 只依据给出的搜索结果，不要引入外部记忆；没有足够信息就少写条目
5. 输出 JSON，字段：summary / highlights[{title, point, url}] / suggestion`

export interface DigestRunnerDeps {
  kbRoot: string
  dataRoot: string
  /** LLM 路由（server 注入；缺省时降级原始快报） */
  routing?: IngestRoutingLike
}

/** 与 callLlmJson 的最小路由接口（避免循环依赖，只声明用到的方法形状） */
interface IngestRoutingLike {
  stream: (kind: 'ingest' | 'query', systemPrompt: string | undefined, messages: SimpleMessage[]) => AsyncIterable<unknown>
}

export function createDigestRunner(deps: DigestRunnerDeps): TaskRunner {
  const { kbRoot, dataRoot } = deps
  return async (task: ScheduledTask, ctx) => {
    const cfg = await resolveTavilyConfig(dataRoot)
    if (!cfg.enabled || !cfg.apiKey) {
      throw new Error('联网检索未启用：请到「设置」页开启 Tavily（定时日报依赖它）')
    }
    const month = new Date().toISOString().slice(0, 7)
    const used = cfg.usedMonth === month ? cfg.usedCount : 0
    if (used >= TAVILY_MONTHLY_LIMIT) {
      throw new Error(`Tavily 月度额度已用尽（${used}/${TAVILY_MONTHLY_LIMIT}）`)
    }

    // 搜索词：任务自定义 query 优先；缺省「<主题> 最新 资讯」（Tavily topic=news 已限新闻域）
    const query = task.query?.trim() || `${task.topic} 最新资讯 今日`
    const client = createTavilyClient(cfg.apiKey)
    const r = await client.search(query, { maxResults: 5 })
    await bumpTavilyUsage(dataRoot, r.credits)

    const date = new Date().toISOString().slice(0, 10)
    const slug = slugify(task.topic)

    // ---------- 证据页：sources/inbox-<date>-<slug>.md（wiki 引用的合法依据） ----------
    const evidenceRel = `sources/inbox-${date}-${slug}.md`
    const evidenceBody = [
      `# ${task.title} · ${date} 检索证据`,
      '',
      `> 由定时任务「${task.title}」于 ${new Date().toISOString()} 检索；搜索词：\`${query}\``,
      '',
      r.hits.length === 0
        ? '（本次搜索无结果）'
        : r.hits.map((h, i) => `## ${i + 1}. ${h.title || '(无标题)'}\n\n${h.url}\n\n${h.content}`).join('\n\n---\n\n'),
      '',
    ].join('\n')
    await mkdir(path.join(kbRoot, 'sources'), { recursive: true })
    await writeFile(path.join(kbRoot, evidenceRel), evidenceBody, 'utf8')

    // ---------- LLM 综合日报（未配置/失败 → 原始快报降级，任务不 fail） ----------
    let report: DigestReportT | null = null
    if (deps.routing && r.hits.length > 0) {
      try {
        const feed = r.hits.map((h, i) => `【${i + 1}】${h.title || '(无标题)'}\nURL: ${h.url}\n摘要：${h.content}`).join('\n\n')
        const res = await callLlmJson<DigestReportT>(
          deps.routing as never,
          'ingest',
          DIGEST_PROMPT,
          [{ role: 'user', text: `主题：${task.topic}\n日期：${date}\n\n搜索结果：\n${feed}` }],
          DigestReport,
        )
        report = res.report
      } catch {
        report = null // 降级：LLM 失败不 fail 任务
      }
    }

    // ---------- inbox/<date>-<slug>.md（收件箱视图消费） ----------
    const rel = `inbox/${date}-${slug}.md`
    const fm = {
      type: 'bulletin' as const,
      task: task.id,
      taskTitle: task.title,
      topic: task.topic,
      generatedAt: new Date().toISOString(),
      mode: ctx.manual ? 'manual' : 'scheduled',
      sources: r.hits.map((h) => h.url),
      evidence: evidenceRel,
      digested: false,
      digestOutcome: '',
    }
    const body = report
      ? renderReport(task.title, date, report, ctx.manual, evidenceRel, used + r.credits)
      : renderRaw(task.title, date, query, r.hits, ctx.manual, evidenceRel, used + r.credits, !deps.routing)
    await mkdir(path.join(kbRoot, 'inbox'), { recursive: true })
    await writeFile(path.join(kbRoot, rel), serializePage(fm, `\n${body}\n`), 'utf8')

    // 证据页与日报一起提交（留痕一次完成）
    await gitCommitAll(kbRoot, `task: ${task.title} ${date}${ctx.manual ? '（手动）' : ''}`)

    return {
      note: report ? `综合 ${report.highlights.length} 条（命中 ${r.hits.length}）` : `命中 ${r.hits.length} 条${deps.routing ? '（LLM 综合失败，原始快报）' : '（LLM 未配置，原始快报）'}`,
      artifact: rel,
    }
  }
}

/** LLM 综合版日报正文 */
function renderReport(title: string, date: string, report: DigestReportT, manual: boolean, evidenceRel: string, usedCount: number): string {
  const lines: string[] = [
    `# ${title} · ${date}`,
    '',
    manual ? '> 手动触发生成' : '> 定时任务生成',
    '',
    report.summary,
    '',
  ]
  for (const h of report.highlights) {
    lines.push(`## ${h.title}`)
    lines.push('')
    lines.push(h.point)
    if (h.url) lines.push(`\n来源：${h.url}`)
    lines.push('')
  }
  if (report.suggestion) {
    lines.push('---', '', `**消化建议**：${report.suggestion}`, '')
  }
  lines.push(`---`, '', `证据页：[[${evidenceRel.replace(/\.md$/, '')}]] · Tavily 本月用量 ${usedCount}/${TAVILY_MONTHLY_LIMIT}`, '')
  return lines.join('\n')
}

/** 原始快报降级版正文（LLM 未配置或失败） */
function renderRaw(
  title: string,
  date: string,
  query: string,
  hits: { title: string; url: string; content: string }[],
  manual: boolean,
  evidenceRel: string,
  usedCount: number,
  llmMissing: boolean,
): string {
  return [
    `# ${title} · ${date}`,
    '',
    manual ? '> 手动触发生成' : '> 定时任务生成',
    llmMissing ? '> LLM 未配置，展示原始搜索结果（配置后自动升级为综合日报）' : '> LLM 综合失败，降级为原始搜索结果',
    '',
    hits.length === 0
      ? `搜索「${query}」无结果。`
      : hits.map((h, i) => `## ${i + 1}. ${h.title || '(无标题)'}\n\n${h.url}\n\n${h.content}`).join('\n\n---\n\n'),
    '',
    `---\n\n证据页：[[${evidenceRel.replace(/\.md$/, '')}]] · 搜索词：\`${query}\` · Tavily 本月用量 ${usedCount}/${TAVILY_MONTHLY_LIMIT}`,
    '',
  ].join('\n')
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[\s/\\]+/g, '-')
      .replace(/[^\p{L}\p{N}-]/gu, '')
      .slice(0, 40) || 'digest'
  )
}
