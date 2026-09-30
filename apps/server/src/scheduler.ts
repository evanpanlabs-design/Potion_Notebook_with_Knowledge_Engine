/**
 * 定时任务调度器（ADR-003 D2-3）：tasks.json 落盘 + 60s 内存扫描 + 启动补偿。
 *
 * 设计（ADR-003 §3.2 / D2 决策）：
 * - 自建轻量 scheduler，不引 pi-durable（其 scheduler 无时间触发原语）
 * - 单进程内存态扫描；容器回收无妨——tasks.json 与 run 记录均落盘，启动补偿覆盖
 * - 补偿：错过 < 24h 补做一次（caught-up）；≥ 24h 放弃本轮（skipped），
 *   放弃时的 bulletin 便利贴挂钩在 D10-11 bulletin board 落地时接上
 * - 任务执行互斥：同一任务不会并发跑（内存 running 集合 + 持久化前的检查）
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import {
  computeNextDue,
  decideCatchup,
  type ScheduledTask,
  type TaskRunRecord,
  type TaskSchedule,
} from '@ke/core'

/** 任务的运行器：kind → 执行体。D2-3 注册 digest（Tavily → inbox 原始快报）；D4-5 升级为 LLM 综合版 */
export type TaskRunner = (task: ScheduledTask, ctx: { manual: boolean }) => Promise<{ note?: string; artifact?: string }>

export interface SchedulerDeps {
  dataRoot: string
  /** 任务产物（inbox/ 等）所在的 KB 根 */
  kbRoot: string
  /** kind → runner 注册表 */
  runners: Map<string, TaskRunner>
  events?: EventEmitter
  /** 扫描间隔（测试可调小） */
  scanMs?: number
}

const HISTORY_CAP = 20

function tasksPath(dataRoot: string): string {
  return path.join(dataRoot, 'tasks.json')
}

// ---------------------------------------------------------------------------
// TaskStore：tasks.json 读写（串行化防并发写坏）
// ---------------------------------------------------------------------------

export class TaskStore {
  private readonly dataRoot: string
  private queue: Promise<unknown> = Promise.resolve()
  constructor(dataRoot: string) {
    this.dataRoot = dataRoot
  }

  private async readRaw(): Promise<ScheduledTask[]> {
    try {
      const data = JSON.parse(await readFile(tasksPath(this.dataRoot), 'utf8')) as { tasks?: ScheduledTask[] }
      return Array.isArray(data.tasks) ? data.tasks : []
    } catch {
      return []
    }
  }

  private async writeRaw(tasks: ScheduledTask[]): Promise<void> {
    await mkdir(this.dataRoot, { recursive: true })
    await writeFile(tasksPath(this.dataRoot), JSON.stringify({ tasks }, null, 2) + '\n', 'utf8')
  }

  /** 串行读改写（回调返回修改后的任务数组） */
  private async mutate(fn: (tasks: ScheduledTask[]) => ScheduledTask[] | Promise<ScheduledTask[]>): Promise<ScheduledTask[]> {
    const run = async () => {
      const tasks = await this.readRaw()
      const next = await fn(tasks)
      await this.writeRaw(next)
      return next
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p
  }

  list(): Promise<ScheduledTask[]> {
    return this.queue.then(() => this.readRaw(), () => this.readRaw())
  }

  get(id: string): Promise<ScheduledTask | undefined> {
    return this.list().then((ts) => ts.find((t) => t.id === id))
  }

  create(input: { kind: 'digest'; title: string; topic: string; query?: string; schedule: TaskSchedule; enabled?: boolean }): Promise<ScheduledTask> {
    const task: ScheduledTask = {
      id: `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      kind: input.kind,
      title: input.title.slice(0, 60),
      topic: input.topic.slice(0, 120),
      query: input.query?.slice(0, 200),
      schedule: input.schedule,
      enabled: input.enabled ?? true,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      nextDue: computeNextDue(input.schedule, new Date()).toISOString(),
      history: [],
    }
    return this.mutate((ts) => [...ts, task]).then(() => task)
  }

  remove(id: string): Promise<boolean> {
    return this.mutate((ts) => ts.filter((t) => t.id !== id)).then((ts) => !ts.some((t) => t.id === id))
  }

  setEnabled(id: string, enabled: boolean): Promise<ScheduledTask | undefined> {
    return this.mutate((ts) => {
      const t = ts.find((x) => x.id === id)
      if (!t) return ts
      t.enabled = enabled
      // 停用恢复时重算 nextDue，避免立刻补做一大段停用期的错过
      if (enabled) t.nextDue = computeNextDue(t.schedule, new Date(), new Date(t.createdAt)).toISOString()
      return ts
    }).then((ts) => ts.find((t) => t.id === id))
  }

  /** 追加一条运行记录（新在前，cap） */
  record(id: string, rec: TaskRunRecord, patch: { lastRunAt: string; nextDue: string }): Promise<void> {
    return this.mutate((ts) => {
      const t = ts.find((x) => x.id === id)
      if (!t) return ts
      t.history = [rec, ...t.history].slice(0, HISTORY_CAP)
      t.lastRunAt = patch.lastRunAt
      t.nextDue = patch.nextDue
      return ts
    }).then(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// 调度循环：扫描 + 触发 + 启动补偿
// ---------------------------------------------------------------------------

export interface SchedulerHandle {
  store: TaskStore
  stop(): void
  /** 立即手动跑一次（不等扫描窗口） */
  runNow(id: string): Promise<TaskRunRecord>
  /** 只做补偿决策与推进（不执行）：测试与启动时共用 */
  sweepOnce(now?: Date): Promise<{ ran: string[]; skipped: string[] }>
}

export function startScheduler(deps: SchedulerDeps): SchedulerHandle {
  const { kbRoot, runners } = deps
  const events = deps.events ?? new EventEmitter()
  const scanMs = deps.scanMs ?? 60_000
  const store = new TaskStore(deps.dataRoot)
  /** 运行中任务 id（互斥；进程内存态——崩溃重启后由补偿机制兜底） */
  const running = new Set<string>()

  async function execute(task: ScheduledTask, mode: 'due' | 'caught-up' | 'manual'): Promise<TaskRunRecord> {
    const startedAt = new Date().toISOString()
    events.emit('task:started', { id: task.id, title: task.title, mode })
    let rec: TaskRunRecord
    try {
      const runner = runners.get(task.kind)
      if (!runner) throw new Error(`任务模板未注册：${task.kind}`)
      const r = await runner(task, { manual: mode === 'manual' })
      rec = {
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome: mode === 'manual' ? 'manual' : mode === 'caught-up' ? 'caught-up' : 'ok',
        note: r.note,
        artifact: r.artifact,
      }
      events.emit('task:done', { id: task.id, title: task.title, outcome: rec.outcome, artifact: rec.artifact })
    } catch (e) {
      rec = {
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome: 'error',
        note: (e as Error).message.slice(0, 300),
      }
      events.emit('task:error', { id: task.id, title: task.title, note: rec.note })
    }
    // 无论成败：lastRun=now，nextDue 推进到严格未来
    const nextDue = computeNextDue(task.schedule, new Date(), new Date(task.createdAt)).toISOString()
    await store.record(task.id, rec, { lastRunAt: rec.finishedAt, nextDue })
    void kbRoot
    return rec
  }

  /** 扫描一轮：到期触发 + 错过补偿。返回本轮跑掉/放弃的任务 id */
  async function sweepOnce(now: Date = new Date()): Promise<{ ran: string[]; skipped: string[] }> {
    const ran: string[] = []
    const skipped: string[] = []
    const tasks = await store.list()
    for (const t of tasks) {
      if (!t.enabled) continue
      if (!t.nextDue) continue
      const due = Date.parse(t.nextDue)
      if (due > now.getTime()) continue
      if (running.has(t.id)) continue
      // 错过补偿决策（ADR-003 §3.2）
      const action = decideCatchup(due, now.getTime())
      if (action === 'skip') {
        // 放弃本轮：只推进 nextDue + 记一条 skipped（产物无副作用）
        // TODO(D10-11)：在 bulletin board 发一张 AI 便利贴告知用户本轮已跳过
        const nextDue = computeNextDue(t.schedule, now, new Date(t.createdAt)).toISOString()
        const rec: TaskRunRecord = {
          startedAt: t.nextDue,
          finishedAt: now.toISOString(),
          outcome: 'skipped',
          note: `服务未运行错过 ${Math.round((now.getTime() - due) / 3600_000)} 小时，本轮放弃（≥24h）`,
        }
        await store.record(t.id, rec, { lastRunAt: t.lastRunAt ?? now.toISOString(), nextDue })
        events.emit('task:skipped', { id: t.id, title: t.title })
        skipped.push(t.id)
        continue
      }
      running.add(t.id)
      void execute(t, Date.now() - due < 60_000 ? 'due' : 'caught-up')
        .catch(() => {})
        .finally(() => running.delete(t.id))
      ran.push(t.id)
    }
    return { ran, skipped }
  }

  const timer = setInterval(() => {
    sweepOnce().catch(() => {})
  }, scanMs)
  timer.unref()
  // 启动即扫一轮（错过的任务在此补偿）
  sweepOnce().catch(() => {})

  return {
    store,
    stop() {
      clearInterval(timer)
    },
    async runNow(id) {
      const t = await store.get(id)
      if (!t) throw new Error(`任务不存在：${id}`)
      if (running.has(id)) throw new Error('任务正在运行中')
      running.add(id)
      try {
        return await execute(t, 'manual')
      } finally {
        running.delete(id)
      }
    },
    sweepOnce,
  }
}
