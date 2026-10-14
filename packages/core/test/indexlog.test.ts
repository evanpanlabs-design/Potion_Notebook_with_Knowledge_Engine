import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderIndex, rebuildIndexSection, renderLogEntry } from '../src/indexlog.ts'

test('renderIndex 分组渲染且空段省略', () => {
  const text = renderIndex([
    { page: 'Karpathy', summary: 'LLM Wiki 提出者', section: 'entities' },
    { page: 'RAG', summary: '检索增强生成', section: 'concepts' },
    { page: 'LLM Wiki 设想', summary: '起源文章', section: 'sources' },
  ])
  assert.ok(text.includes('## entities'))
  assert.ok(text.includes('- [[Karpathy]] · LLM Wiki 提出者'))
  assert.ok(text.includes('## concepts'))
  assert.ok(text.includes('- [[RAG]] · 检索增强生成'))
  assert.ok(!text.includes('## queries'))
})

test('rebuildIndexSection 只替换目标段，其它段保持', () => {
  const current = renderIndex([
    { page: 'Karpathy', summary: '旧摘要', section: 'entities' },
    { page: 'RAG', summary: '检索增强生成', section: 'concepts' },
  ])
  const updated = rebuildIndexSection(current, 'entities', [
    { page: 'Karpathy', summary: '新摘要', section: 'entities' },
    { page: 'Mario Zechner', summary: 'pi 作者', section: 'entities' },
  ])
  assert.ok(updated.includes('- [[Karpathy]] · 新摘要'))
  assert.ok(updated.includes('- [[Mario Zechner]] · pi 作者'))
  assert.ok(!updated.includes('旧摘要'))
  assert.ok(updated.includes('- [[RAG]] · 检索增强生成')) // 其它段不动
})

test('rebuildIndexSection 当前缺段时追加', () => {
  const current = '# 内容目录\n\n## entities\n\n- [[A]] · a\n'
  const updated = rebuildIndexSection(current, 'concepts', [
    { page: 'RAG', summary: '新段', section: 'concepts' },
  ])
  assert.ok(updated.includes('## concepts'))
  assert.ok(updated.includes('- [[RAG]] · 新段'))
  assert.ok(updated.includes('- [[A]] · a'))
})

test('renderLogEntry 格式与 Karpathy 可解析约定一致', () => {
  // 日志时间戳渲染的是**机器本地时区**的人读时间轴（Karpathy 惯例），
  // 所以这里必须用本地时间构造 Date：写成固定偏移的 ISO 串会让断言只在
  // 特定时区（如 UTC+8）成立，CI 跑在 UTC 的 runner 上会失败。
  const d = new Date(2026, 8, 28, 14, 5)
  const line = renderLogEntry('ingest', 'LLM Wiki 设想', d)
  assert.equal(line, '## [2026-09-28 14:05] ingest | LLM Wiki 设想\n')
  // grep 约定自检：每条以 "## [" 开头
  assert.ok(line.startsWith('## ['))
})

test('renderLogEntry 拒绝未知 op', () => {
  assert.throws(() => renderLogEntry('destroy' as never, 'x'))
})
