/**
 * LLM 配置存储（设置页后端）。
 *
 * 优先级：data/llm-config.json（设置页保存）> 环境变量（LLM_BASE_URL 等）> 无配置。
 * 双角色：ingest（消化，便宜快）/ query（问答，强模型）。
 * apiKey 只落本地文件（data/ 在 .gitignore，local-first），API 返回时打码。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import type { LlmEndpointConfig } from '@ke/agent-tools'

export type LlmProtocol = 'openai' | 'anthropic'

export interface LlmRoleConfig extends LlmEndpointConfig {
  protocol: LlmProtocol
}

export interface LlmConfigFile {
  ingest: LlmRoleConfig
  query: LlmRoleConfig
}

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', 'data')
const CONFIG_PATH = path.join(DATA_DIR, 'llm-config.json')

function isValidRole(r: unknown): r is LlmRoleConfig {
  const c = r as LlmRoleConfig
  return (
    !!c &&
    typeof c === 'object' &&
    typeof c.baseUrl === 'string' && c.baseUrl.trim() !== '' &&
    typeof c.apiKey === 'string' && c.apiKey.trim() !== '' &&
    typeof c.model === 'string' && c.model.trim() !== '' &&
    (c.protocol === 'openai' || c.protocol === 'anthropic')
  )
}

/** 读设置页保存的文件配置；不存在或字段残缺返回 null */
export async function loadLlmFileConfig(): Promise<LlmConfigFile | null> {
  let text: string
  try {
    text = await readFile(CONFIG_PATH, 'utf8')
  } catch {
    return null
  }
  try {
    const cfg = JSON.parse(text) as LlmConfigFile
    if (isValidRole(cfg?.ingest) && isValidRole(cfg?.query)) return cfg
    return null
  } catch {
    return null
  }
}

/** 环境变量兜底（OpenAI 兼容协议） */
export function envLlmConfig(): LlmConfigFile | null {
  const baseUrl = process.env.LLM_BASE_URL
  const apiKey = process.env.LLM_API_KEY
  if (!baseUrl || !apiKey) return null
  const protocol = (process.env.LLM_PROTOCOL === 'anthropic' ? 'anthropic' : 'openai') as LlmProtocol
  const ingestModel = process.env.LLM_MODEL_INGEST ?? 'gpt-4o-mini'
  return {
    ingest: { protocol, baseUrl, apiKey, model: ingestModel },
    query: { protocol, baseUrl, apiKey, model: process.env.LLM_MODEL_QUERY ?? ingestModel },
  }
}

/** 当前生效配置：文件 > env > null */
export async function resolveLlmConfig(): Promise<{ config: LlmConfigFile | null; source: 'file' | 'env' | 'none' }> {
  const file = await loadLlmFileConfig()
  if (file) return { config: file, source: 'file' }
  const env = envLlmConfig()
  if (env) return { config: env, source: 'env' }
  return { config: null, source: 'none' }
}

export async function saveLlmConfig(cfg: LlmConfigFile): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}

/** apiKey 打码：只留前 3 后 4 */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return '••••••••'
  return `${key.slice(0, 3)}••••••••${key.slice(-4)}`
}

/** 前端回传的 apiKey 是空串或含打码符 → 沿用旧值 */
export function mergeApiKey(incoming: string | undefined, existing: string | undefined): string {
  const v = (incoming ?? '').trim()
  if (!v || v.includes('••')) return existing ?? ''
  return v
}
