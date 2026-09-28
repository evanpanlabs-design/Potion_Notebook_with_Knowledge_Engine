/**
 * pi-ai 适配层（ARCHITECTURE §11：packages/agent-tools 是唯一 import pi 的地方）。
 *
 * 职责：
 * 1. 把用户的 OpenAI 兼容端点（baseUrl + apiKey + model）注册为 pi 自定义 provider
 * 2. 提供两类路由（ADR-001 / ARCHITECTURE §3）：ingest → 便宜模型，query → 强模型
 * 3. stream() 返回归一化的文本流；上游 pi 版本升级时只改本文件
 */
import { createModels, createProvider } from '@earendil-works/pi-ai'
import {
  stream as openaiCompletionsStream,
  streamSimple as openaiCompletionsStreamSimple,
} from '@earendil-works/pi-ai/api/openai-completions'
import {
  stream as anthropicMessagesStream,
  streamSimple as anthropicMessagesStreamSimple,
} from '@earendil-works/pi-ai/api/anthropic-messages'
import type {
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
} from '@earendil-works/pi-ai'
import { globalRpmGate } from './rpm-queue.ts'

export interface LlmEndpointConfig {
  /** OpenAI 兼容 base URL，如 https://api.example.com/v1；Anthropic 协议填到域名根（SDK 自动补 /v1/messages） */
  baseUrl: string
  apiKey: string
  /** 模型 id（provider 内部） */
  model: string
  /** 请求协议：openai = OpenAI 兼容 chat/completions；anthropic = Anthropic messages（默认 openai） */
  protocol?: 'openai' | 'anthropic'
  /** 展示名 */
  label?: string
}

export interface RoutingConfig {
  ingest: LlmEndpointConfig
  query: LlmEndpointConfig
}

export type TaskKind = 'ingest' | 'query'

/** 归一化模型句柄：任务路由后可拿到 (providerId, modelId) */
export interface ResolvedModel {
  providerId: string
  modelId: string
  model: Model<'openai-completions'> | Model<'anthropic-messages'>
  config: LlmEndpointConfig
}

/** 简单消息形状（适配层不暴露 pi 的完整消息类型）
 * 注：历史 assistant 消息需要完整运行时字段（usage/stopReason 等），
 * 多轮对话重建在 D5（Query 管道）落地，当前管道只需 user/system */
export interface SimpleMessage {
  role: 'user' | 'system'
  text: string
}

function buildProvider(config: LlmEndpointConfig, id: string) {
  const protocol = config.protocol === 'anthropic' ? 'anthropic-messages' : 'openai-completions'
  const model = {
    api: protocol,
    id: config.model,
    provider: id,
    name: config.label ?? config.model,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  } as never as Model<'openai-completions'> | Model<'anthropic-messages'>

  const api =
    protocol === 'anthropic-messages'
      ? {
          stream: anthropicMessagesStream as never,
          streamSimple: anthropicMessagesStreamSimple as never,
        }
      : {
          stream: openaiCompletionsStream as never,
          streamSimple: openaiCompletionsStreamSimple as never,
        }

  return createProvider({
    id,
    name: config.label ?? id,
    baseUrl: config.baseUrl,
    auth: {
      // 静态 Bearer key（OpenAI 兼容）/ x-api-key（Anthropic），无交互式 login
      apiKey: {
        name: `${config.label ?? id} API key`,
        resolve: async () => ({
          auth: { apiKey: config.apiKey, baseUrl: config.baseUrl },
          source: 'static-config',
        }),
      },
    },
    models: [model],
    api,
  })
}

/** 建立带路由的 Models 集合（每次调用独立构建，无全局状态） */
export function createRouting(config: RoutingConfig) {
  const models = createModels()
  models.setProvider(buildProvider(config.ingest, 'ke-ingest'))
  models.setProvider(buildProvider(config.query, 'ke-query'))
  return {
    resolve(kind: TaskKind): ResolvedModel {
      const c = kind === 'ingest' ? config.ingest : config.query
      const providerId = kind === 'ingest' ? 'ke-ingest' : 'ke-query'
      const m = models.getModel(providerId, c.model)
      if (!m) throw new Error(`pi 适配层：模型未注册 (${providerId}/${c.model})`)
      return {
        providerId,
        modelId: c.model,
        model: m as Model<'openai-completions'>,
        config: c,
      }
    },
    /** 直连流（不*RPM 门控，供 gated 包装调用；外部请勿直接用） */
    rawStream(resolved: ResolvedModel, context: { systemPrompt?: string; messages: unknown[] }): AssistantMessageEventStream {
      return models.stream(resolved.model, context as never)
    },
    /** 流式调用（经 RPM 门控）：返回惰性 AsyncIterable。
     * 票据在开始迭代时获取、首个事件到达后归还（即限流按“请求发起”计），
     * 迭代中途异常会释放票据，不会死锁队列 */
    stream(kind: TaskKind, systemPrompt: string | undefined, messages: SimpleMessage[]): AssistantMessageEventStream {
      const resolved = this.resolve(kind)
      // pi Message 是判别联合：按 role 分支构造
      const now = Date.now()
      const context = {
        systemPrompt,
        messages: messages.map((m) =>
          m.role === 'user'
            ? { role: 'user', content: m.text, timestamp: now }
            : { role: 'system', content: m.text, timestamp: now },
        ),
      }
      const gate = globalRpmGate()
      const self = this
      async function* gated(): AsyncGenerator<AssistantMessageEvent> {
        await gate.acquire()
        let released = false
        const release = () => {
          if (!released) {
            released = true
            gate.release()
          }
        }
        try {
          for await (const ev of self.rawStream(resolved, context)) {
            release() // 首个事件已到：请求已发起，窗口占用完成
            yield ev
          }
        } finally {
          release() // 异常/中断也要释放票据
        }
      }
      return gated() as never as AssistantMessageEventStream
    },
  }
}

/** 从事件流中收集纯文本与 usage（spike 与 ingest Phase1/2 的辅助函数） */
export async function collectText(stream: AssistantMessageEventStream): Promise<{ text: string; usage: { input: number; output: number } | null; events: AssistantMessageEvent[] }> {
  const chunks: string[] = []
  const events: AssistantMessageEvent[] = []
  let usage: { input: number; output: number } | null = null
  for await (const ev of stream) {
    events.push(ev)
    if (ev.type === 'text_delta') {
      chunks.push(ev.delta)
    }
    if (ev.type === 'done') {
      // done 事件载荷在 message 字段（AssistantMessage，含 usage）
      const u = ev.message?.usage
      if (u) usage = { input: u.input ?? 0, output: u.output ?? 0 }
    }
  }
  if (!events.some((e) => e.type === 'done')) {
    const err = events.find((e) => e.type === 'error')
    throw new Error(`pi 适配层：流未正常结束（${err ? JSON.stringify(err) : '无 done 事件'}）`)
  }
  return { text: chunks.join(''), usage, events }
}
