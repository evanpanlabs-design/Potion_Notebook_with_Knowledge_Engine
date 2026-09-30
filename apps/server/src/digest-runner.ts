/**
 * digest 任务运行器（ADR-003 D2-3 最小版，D4-5 升级为 LLM 综合快报）。
 *
 * D2-3 版本：Tavily 按主题搜索 → 结果物化为 inbox/<date>-<slug>.md 原始快报
 *（标题/URL/摘要列表，frontmatter 带 sources）→ git 提交留痕。
 * inbox/ 不在 scanKb 集合内——收件箱内容天然不进图谱（ADR-003 §3.2）。
 * D4-5 升级：LLM 综合生成快报正文 + 收件箱视图 + 「消化进图谱」按钮。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { serializePage } from '@ke/core'
import { createTavilyClient } from '@ke/agent-tools'
import { resolveTavilyConfig, bumpTavilyUsage, TAVILY_MONTHLY_LIMIT } from './agent-tools.ts'
import { gitCommitAll } from './ingest-pipeline.ts'
import type { ScheduledTask } from '@ke/core'
import type { TaskRunner } from './scheduler.ts'

export function createDigestRunner(deps: { kbRoot: string; dataRoot: string }): TaskRunner {
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

    // 搜索词：任务自定义 query 优先；缺省「<主题> 最新 资讯」（Tavily topic=newnews 已限新闻域）
    const query = task.query?.trim() || `${task.topic} 最新资讯 今日`
    const client = createTavilyClient(cfg.apiKey)
    const r = await client.search(query, { maxResults: 5 })
    await bumpTavilyUsage(dataRoot, r.credits)

    // inbox/<date>-<slug>.md（同日同主题重跑覆盖——日报语义天然幂等）
    const date = new Date().toISOString().slice(0, 10)
    const slug = slugify(task.topic)
    const rel = `inbox/${date}-${slug}.md`
    const fm = {
      type: 'bulletin' as const,
      task: task.id,
      taskTitle: task.title,
      topic: task.topic,
      generatedAt: new Date().toISOString(),
      mode: ctx.manual ? 'manual' : 'scheduled',
      sources: r.hits.map((h) => h.url),
    }
    const body = [
      `# ${task.title} · ${date}`,
      '',
      ctx.manual ? '> 手动触发生成' : '> 定时任务生成',
      '',
      r.hits.length === 0
        ? `搜索「${query}」无结果。`
        : r.hits.map((h, i) => `## ${i + 1}. ${h.title || '(无标题)'}\n\n${h.url}\n\n${h.content}`).join('\n\n---\n\n'),
      '',
      `---\n\n搜索词：\`${query}\` · Tavily 本月用量 ${used + r.credits}/${TAVILY_MONTHLY_LIMIT}`,
      '',
    ].join('\n')

    await mkdir(path.join(kbRoot, 'inbox'), { recursive: true })
    await writeFile(path.join(kbRoot, rel), serializePage(fm, `\n${body}\n`), 'utf8')
    await gitCommitAll(kbRoot, `task: ${task.title} ${date}${ctx.manual ? '（手动）' : ''}`)

    return {
      note: `命中 ${r.hits.length} 条`,
      artifact: rel,
    }
  }
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
