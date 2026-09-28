/**
 * RPM 限流队列（D2-4）：两个模型均 RPM=5。
 * 票据模型：acquire() 等待限速窗口 → 调用方发起请求 → release() 归还。
 * pi 的流是惰性的（迭代才真正发 HTTP），票据在流开始迭代时获取、首个事件到达后释放，
 * 这样 RPM 统计的是"请求发起时刻"，与平台限流语义一致。
 * 429/超时类错误由上层（pi 内部重试 / 管道层）处理；Phase 2 换 pi-durable 时本模块退役为兜底。
 */
import process from 'node:process'

export interface RateLimiterOptions {
  /** 每分钟允许的请求数 */
  rpm: number
  /** 等待票据的队列最长长度（防管道堆积） */
  maxWaiting?: number
}

const DEFAULTS: Required<Omit<RateLimiterOptions, 'rpm'>> = {
  maxWaiting: 20,
}

export class RpmGate {
  private readonly minIntervalMs: number
  private readonly maxWaiting: number
  private lastDispatchAt = 0
  private waiting: Array<() => void> = []
  private timer: NodeJS.Timeout | null = null

  constructor(opts: RateLimiterOptions) {
    this.minIntervalMs = Math.ceil(60_000 / opts.rpm)
    this.maxWaiting = opts.maxWaiting ?? DEFAULTS.maxWaiting
  }

  /** 取一张票据：等到下一个限速窗口。队列超载时 reject */
  acquire(): Promise<void> {
    if (this.waiting.length >= this.maxWaiting) {
      return Promise.reject(new Error(`rpm-gate: 等待队列已满（${this.waiting.length}），请稍后重试`))
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve)
      this.drain()
    })
  }

  /** 归还票据：记录本次请求完成占用的窗口起点 */
  release(): void {
    // 窗口以 acquire 时刻计；这里只负责触发下一轮派发
    this.drain()
  }

  private drain() {
    if (this.timer || this.waiting.length === 0) return
    const wait = this.lastDispatchAt + this.minIntervalMs - Date.now()
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.drain()
      }, wait)
      return
    }
    this.lastDispatchAt = Date.now()
    const next = this.waiting.shift()
    next?.()
    // release() 由持票者调用后触发后续派发
  }
}

/** 从 env 构建进程级单例（LLM_RPM，默认 5） */
export function globalRpmGate(): RpmGate {
  const rpm = Number(process.env.LLM_RPM ?? 5)
  const w = globalThis as { __keRpmGate?: RpmGate }
  if (!w.__keRpmGate) w.__keRpmGate = new RpmGate({ rpm })
  return w.__keRpmGate
}
