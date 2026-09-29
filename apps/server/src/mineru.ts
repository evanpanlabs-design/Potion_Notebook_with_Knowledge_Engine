/**
 * MinerU PDF 解析集成（v0.2.5）。
 *
 * 官方文档 https://mineru.net/apiManage/docs ——「精准解析 API」：
 *   1. 批量上传：POST /api/v4/file-urls/batch（申请预签名上传 URL，≤200 文件/批）
 *      → PUT 文件二进制到预签名 URL（不带鉴权头）
 *   2. 轮询结果：POST /api/v4/extract-results/batch { batch_id }
 *      state: pending | waiting-file | pending-file | running | converting | done | failed
 *      done 后 full_zip_url 指向结果 zip（full.md 为 Markdown 解析结果）
 *   3. 单文件 URL 解析：POST /api/v4/extract/task（本项目暂不用：本地文件无公网 URL）
 *
 * 限流（官方口径，本地单用户按文件数计）：
 *   - 提交任务接口（file-urls/batch / extract/task / file-extract*）：50 文件/分钟；5000 文件/天
 *   - 获取结果接口（extract-results/batch / extract/task/{id}）：1000 次/分钟
 * 实现为进程内滑动窗口计数器；本应用单用户本地跑，轮询频率 5s/次远低于上限，
 * 频控主要防「批量导入选了一堆 PDF 连点提交」。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'

const MINERU_BASE = 'https://mineru.net/api/v4'

/** config 存 data/mineru-config.json（与 llm-config.json 同层，本地文件不入 KB git） */
export function mineruConfigPath(dataRoot: string): string {
  return path.join(dataRoot, 'mineru-config.json')
}

export async function readMineruKey(dataRoot: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(mineruConfigPath(dataRoot), 'utf8')) as { apiKey?: string }
    return raw.apiKey?.trim() || null
  } catch {
    return null
  }
}

export async function writeMineruKey(dataRoot: string, apiKey: string): Promise<void> {
  await mkdir(dataRoot, { recursive: true })
  await writeFile(mineruConfigPath(dataRoot), JSON.stringify({ apiKey: apiKey.trim() }, null, 2), 'utf8')
}

export function maskMineruKey(key: string): string {
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 5)}••••${key.slice(-4)}`
}

// ---------------------------------------------------------------------------
// 限流：滑动窗口（分钟）+ 当日计数（进程内存；重启清零是可接受的近似）
// ---------------------------------------------------------------------------

const uploadTimestamps: number[] = [] // 每个文件的提交时刻
const resultTimestamps: number[] = [] // 每次结果查询的时刻
let dailyUploads = { day: '', count: 0 }

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function slide(win: number[], max: number, now: number): void {
  while (win.length > 0 && now - win[0]! > 60_000) win.shift()
  if (win.length >= max) throw new Error(`触发 MinerU 限流：本分钟已 ${win.length} 次（上限 ${max}/分钟），请稍后再试`)
  win.push(now)
}

/** 提交 n 个文件前检查（50 文件/分钟 + 5000 文件/天） */
export function checkUploadQuota(n: number): void {
  const now = Date.now()
  slide(uploadTimestamps, 50, now)
  const d = today()
  if (dailyUploads.day !== d) dailyUploads = { day: d, count: 0 }
  if (dailyUploads.count + n > 5000) throw new Error(`触发 MinerU 限流：今日已上传 ${dailyUploads.count} 个文件（上限 5000/天）`)
  dailyUploads.count += n
  for (let i = 0; i < n; i++) uploadTimestamps.push(now)
}

/** 结果查询检查（1000 次/分钟） */
export function checkResultQuota(): void {
  slide(resultTimestamps, 1000, Date.now())
}

// ---------------------------------------------------------------------------
// 任务状态持久化：data/mineru-tasks.json
// ---------------------------------------------------------------------------

export interface MineruTask {
  batchId: string
  fileName: string
  dataId: string
  state: string // pending | waiting-file | running | converting | done | failed
  errMsg?: string
  sourcePath?: string // 完成后落盘的 sources/*.md
  ingested?: boolean
  createdAt: string
  updatedAt: string
}

export function tasksPath(dataRoot: string): string {
  return path.join(dataRoot, 'mineru-tasks.json')
}

export async function readTasks(dataRoot: string): Promise<MineruTask[]> {
  try {
    const raw = JSON.parse(await readFile(tasksPath(dataRoot), 'utf8')) as { tasks?: MineruTask[] }
    return raw.tasks ?? []
  } catch {
    return []
  }
}

export async function writeTasks(dataRoot: string, tasks: MineruTask[]): Promise<void> {
  await mkdir(dataRoot, { recursive: true })
  await writeFile(tasksPath(dataRoot), JSON.stringify({ tasks: tasks.slice(-500) }, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// MinerU HTTP 客户端
// ---------------------------------------------------------------------------

interface MineruResponse<T> {
  code: number
  msg?: string
  data?: T
}

async function mineruFetch<T>(apiKey: string, urlPath: string, init: RequestInit = {}): Promise<MineruResponse<T>> {
  const res = await fetch(`${MINERU_BASE}${urlPath}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
  })
  let body: MineruResponse<T>
  try {
    body = (await res.json()) as MineruResponse<T>
  } catch {
    throw new Error(`MinerU 返回非 JSON（HTTP ${res.status}）`)
  }
  // 401/403 = token 无效或过期；MinerU 业务错误用 code!==0 表达
  if (res.status === 401 || res.status === 403) {
    throw new Error(`MinerU 鉴权失败（HTTP ${res.status}）：请检查 API Key`)
  }
  if (body.code !== 0) {
    throw new Error(`MinerU 错误（code=${body.code}）：${body.msg ?? '未知错误'}`)
  }
  return body
}

/** 连通性测试：不带 files 请求批量上传接口——鉴权通过会收到业务参数校验错误（code!==0），
 *  鉴权失败则 HTTP 401/403。据此区分「Key 有效可连通」与「Key 无效」。 */
export async function testMineruConnectivity(apiKey: string): Promise<{ ok: boolean; message: string }> {
  try {
    await mineruFetch(apiKey, '/file-urls/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [] }),
    })
    return { ok: true, message: '连通成功，API Key 有效' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 业务参数错误（空 files）恰好证明鉴权已通过
    if (msg.includes('MinerU 错误')) return { ok: true, message: `连通成功，API Key 有效（${msg}）` }
    return { ok: false, message: msg }
  }
}

/** 批量申请上传 URL 并 PUT 文件。返回 batch_id。 */
export async function uploadFilesToMineru(
  apiKey: string,
  files: Array<{ name: string; dataId: string; bytes: Buffer }>,
): Promise<string> {
  const res = await mineruFetch<{ batch_id: string; file_urls: string[] }>(apiKey, '/file-urls/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model_version: 'vlm', // 官方推荐 vlm，结构化质量更好
      enable_formula: true,
      enable_table: true,
      language: 'ch',
      files: files.map((f) => ({ name: f.name, is_ocr: true, data_id: f.dataId })),
    }),
  })
  const batchId = res.data?.batch_id
  const urls = res.data?.file_urls ?? []
  if (!batchId || urls.length !== files.length) {
    throw new Error('MinerU 返回的 batch_id/URL 数量不匹配')
  }
  // PUT 到预签名 URL：不带 Authorization，二进制流
  for (let i = 0; i < files.length; i++) {
    const put = await fetch(urls[i]!, { method: 'PUT', body: new Uint8Array(files[i]!.bytes) })
    if (!put.ok) throw new Error(`上传文件 ${files[i]!.name} 失败（HTTP ${put.status}）`)
  }
  return batchId
}

/** 轮询一批任务结果。返回 data_id → { state, fullZipUrl, errMsg } */
export async function pollBatchResults(
  apiKey: string,
  batchId: string,
): Promise<Array<{ fileName: string; dataId?: string; state: string; fullZipUrl?: string; errMsg?: string }>> {
  checkResultQuota()
  const res = await mineruFetch<{
    extract_result: Array<{ file_name: string; data_id?: string; state: string; full_zip_url?: string; err_msg?: string }>
}>(apiKey, `/extract-results/batch/${encodeURIComponent(batchId)}`)
  return (res.data?.extract_result ?? []).map((r) => ({
    fileName: r.file_name,
    dataId: r.data_id,
    state: r.state,
    fullZipUrl: r.full_zip_url,
    errMsg: r.err_msg,
  }))
}

/** 下载结果 zip，抽出 full.md。返回 markdown 文本。 */
export async function fetchMarkdownFromZip(zipUrl: string): Promise<string> {
  const res = await fetch(zipUrl)
  if (!res.ok) throw new Error(`下载解析结果失败（HTTP ${res.status}）`)
  const buf = Buffer.from(await res.arrayBuffer())
  const zip = new AdmZip(buf)
  const entry = zip.getEntry('full.md')
  if (!entry) throw new Error('结果 zip 中未找到 full.md')
  return zip.readAsText(entry)
}
