/**
 * 定时任务的时间语义（ADR-003 D2-3）：纯函数，零 IO 可测。
 *
 * schedule 用结构化对象而非裸 cron——「每天 7 点」「每 6 小时」覆盖 MVP 全部场景，
 * 计算与校验都比 cron 解析器简单一个量级；将来要 cron 再加 type。
 *
 * 补偿语义（ADR-003 §3.2）：
 *   服务启动/扫描时发现 nextDue <= now（错过）：
 *     now - nextDue < 24h → 补做一次（outcome: caught-up）
 *     否则               → 放弃本轮（outcome: skipped），nextDue 推进到下一个未来时刻
 */
import { Type, type Static } from '@sinclair/typebox'

/** 结构化排程：每天固定时刻 | 固定间隔小时数（锚点 = 任务创建时刻） */
export const TaskScheduleSchema = Type.Union([
  Type.Object({
    type: Type.Literal('daily'),
    at: Type.String({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: 'HH:MM 本地时间' }),
  }),
  Type.Object({
    type: Type.Literal('interval'),
    hours: Type.Number({ minimum: 1, maximum: 24 * 30 }),
  }),
])
export type TaskSchedule = Static<typeof TaskScheduleSchema>

/** 单次运行记录（history 新在前，cap 20） */
export interface TaskRunRecord {
  startedAt: string
  finishedAt: string
  /** ok 正常完成 | caught-up 补做 | skipped 错过放弃 | error 执行失败 | manual 手动触发成功 */
  outcome: 'ok' | 'caught-up' | 'skipped' | 'error' | 'manual'
  note?: string
  /** 产物路径（如 inbox/2026-09-30-ai-日报.md） */
  artifact?: string
}

/** 定时任务定义（data/tasks.json 的一条）
 *  kind 两种：
 *  - digest：专用日报管线（Tavily → 证据页 → LLM 综合）
 *  - agent：到点唤醒一个子 Agent（完整 agent loop + 工具白名单），自由目标
 */
export interface ScheduledTask {
  id: string
  kind: 'digest' | 'agent'
  title: string
  /** digest：搜索主题；agent：任务短标签 */
  topic: string
  /** 可选自定义搜索词（仅 digest 用；缺省用 topic） */
  query?: string
  /** agent 任务的目标描述（唤醒子 Agent 时的用户提示，自由文本） */
  prompt?: string
  schedule: TaskSchedule
  enabled: boolean
  createdAt: string
  lastRunAt: string | null
  /** ISO；null = 尚未计算（创建时一定填上） */
  nextDue: string | null
  history: TaskRunRecord[]
}

/** 兜底窗口：错过不到 24h 补做，超过则放弃（ADR-003 §3.2） */
export const CATCHUP_WINDOW_MS = 24 * 60 * 60 * 1000

/** 宽容解析用户/LLM 传入的 schedule：非法返回 null */
export function normalizeSchedule(input: unknown): TaskSchedule | null {
  if (!input || typeof input !== 'object') return null
  const s = input as { type?: unknown; at?: unknown; hours?: unknown }
  if (s.type === 'daily') {
    if (typeof s.at !== 'string') return null
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(s.at.trim())
    if (!m) return null
    const h = Number(m[1])
    const min = Number(m[2])
    if (h > 23 || min > 59) return null
    return { type: 'daily', at: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` }
  }
  if (s.type === 'interval') {
    const n = Number(s.hours)
    if (!Number.isFinite(n) || n < 1 || n > 24 * 30) return null
    return { type: 'interval', hours: Math.round(n) }
  }
  return null
}

/** 下一个到期时刻（严格晚于 from）。interval 以 anchor（创建时刻）为锚对齐 */
export function computeNextDue(schedule: TaskSchedule, from: Date, anchor: Date = from): Date {
  if (schedule.type === 'daily') {
    const [h, m] = schedule.at.split(':').map(Number)
    const c = new Date(from)
    c.setHours(h!, m!, 0, 0)
    if (c.getTime() <= from.getTime()) c.setDate(c.getDate() + 1)
    return c
  }
  const ms = schedule.hours! * 60 * 60 * 1000
  const elapsed = from.getTime() - anchor.getTime()
  const k = Math.floor(elapsed / ms) + 1
  return new Date(anchor.getTime() + k * ms)
}

/** 错过补偿决策：now 时刻发现 nextDue 已过，补做还是放弃 */
export function decideCatchup(nextDue: number, now: number): 'run' | 'skip' {
  return now - nextDue < CATCHUP_WINDOW_MS ? 'run' : 'skip'
}

/** 人话描述排程（UI 展示） */
export function describeSchedule(schedule: TaskSchedule): string {
  if (schedule.type === 'daily') return `每天 ${schedule.at}`
  return `每 ${schedule.hours} 小时`
}

/** 相对时间描述（“3 分钟后” / “2 小时前”） */
export function describeRelative(iso: string, now: number = Date.now()): string {
  const diff = Date.parse(iso) - now
  const abs = Math.abs(diff)
  let text: string
  if (abs < 60_000) text = '不到 1 分钟'
  else if (abs < 3600_000) text = `${Math.round(abs / 60_000)} 分钟`
  else if (abs < 86_400_000) text = `${Number((abs / 3600_000).toFixed(1))} 小时` // 去尾零：3.0 → 3，3.5 保留
  else text = `${Math.round(abs / 86_400_000)} 天`
  return diff >= 0 ? `${text}后` : `${text}前`
}
