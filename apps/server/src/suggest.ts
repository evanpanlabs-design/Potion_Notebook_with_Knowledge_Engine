/**
 * 人工维护建议（ADR-003 §3.1 设想 #3，D8-9 泛化收口）：
 *
 * 任意 wiki 页可由用户留建议（frontmatter suggestions[]，origin: user），
 * 与 audit 建议同池异源——审核页统一展示，可「转返修」由 LLM 集中执行，
 * 执行完成后从 suggestions[] 移除该条（含 audit 建议同规则）。
 *
 * 复用 rework 池机制零新执行器：suggestions 只是「待执行意见」的另一种来源。
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { parsePage, serializePage } from '@ke/core'

export interface UserSuggestionBody {
  note: string
}

export interface SuggestionEntry {
  origin: 'user' | 'audit'
  note: string
  at: string
  action?: string
  peer?: string
  confidence?: number
  evidence?: string
}

export function suggestionsPathGuard(rel: string): boolean {
  return rel.startsWith('wiki/') && rel.endsWith('.md') && !rel.includes('..')
}

/** 用户给页面追加一条建议（origin: user；幂等：同 note 不重复） */
export async function addUserSuggestion(kbRoot: string, rel: string, note: string): Promise<SuggestionEntry[]> {
  if (!suggestionsPathGuard(rel)) throw new Error('只允许 wiki/ 下的 .md 页面')
  const trimmed = note.trim()
  if (!trimmed) throw new Error('建议内容不能为空')
  const abs = path.join(kbRoot, rel)
  const text = await readFile(abs, 'utf8') // 不存在则抛错（404 由路由层转）
  const { fm, body } = parsePage(text)
  const cur = (Array.isArray(fm['suggestions']) ? (fm['suggestions'] as SuggestionEntry[]) : []).filter(
    (s) => s && typeof s.note === 'string',
  )
  if (cur.some((s) => s.origin === 'user' && s.note === trimmed)) return cur
  const entry: SuggestionEntry = { origin: 'user', note: trimmed, at: new Date().toISOString() }
  const next = [...cur, entry]
  await writeFile(abs, serializePage({ ...fm, suggestions: next }, body), 'utf8')
  return next
}

/** 移除一条建议（执行完成后清账；index 定位） */
export async function removeSuggestion(kbRoot: string, rel: string, index: number): Promise<SuggestionEntry[]> {
  if (!suggestionsPathGuard(rel)) throw new Error('只允许 wiki/ 下的 .md 页面')
  const abs = path.join(kbRoot, rel)
  const text = await readFile(abs, 'utf8')
  const { fm, body } = parsePage(text)
  const cur = (Array.isArray(fm['suggestions']) ? (fm['suggestions'] as SuggestionEntry[]) : []).filter(
    (s) => s && typeof s.note === 'string',
  )
  if (index < 0 || index >= cur.length) throw new Error(`建议序号越界：${index}（共 ${cur.length} 条）`)
  const next = cur.filter((_, i) => i !== index)
  const fmNext = { ...fm }
  if (next.length === 0) delete fmNext['suggestions']
  else fmNext['suggestions'] = next
  await writeFile(abs, serializePage(fmNext, body), 'utf8')
  return next
}

/** 读某页建议（audit + user 合并视角） */
export async function readSuggestions(kbRoot: string, rel: string): Promise<SuggestionEntry[]> {
  if (!suggestionsPathGuard(rel)) throw new Error('只允许 wiki/ 下的 .md 页面')
  try {
    const { fm } = parsePage(await readFile(path.join(kbRoot, rel), 'utf8'))
    return (Array.isArray(fm['suggestions']) ? (fm['suggestions'] as SuggestionEntry[]) : []).filter(
      (s) => s && typeof s.note === 'string',
    )
  } catch {
    return []
  }
}
