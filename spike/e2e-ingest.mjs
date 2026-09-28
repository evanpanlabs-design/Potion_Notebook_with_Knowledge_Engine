// D2-4f 全链路：建库→摄料→ingest→验证闸门/git/index/log
const { initKb, scanKb } = await import('../packages/core/src/index.ts')
const path = await import('node:path')
const { readFile } = await import('node:fs/promises')

const KB = path.resolve('data/my-wiki')
const kb = await initKb(KB)
console.log('[1] 建库:', kb.created.join(','))

// 摄入一篇真实素材（Karpathy gist 的浓缩版）
const { writeFile } = await import('node:fs/promises')
const sample = `# LLM Wiki 构想（Karpathy）

Karpathy 在 gist 中提出"用 LLM 维护个人 wiki"的工作流：把原始资料（书、论文、对话）投喂给 LLM，
由 LLM 负责提取、整合、维护一组 Markdown wiki 页面；人负责策展与判断。

关键机制：
1. wiki 页面带双向链接（类似 Obsidian 的 [[wikilink]]），由 LLM 维护
2. 每次操作（ingest/query）追加进 log.md，形成可审计的操作流水
3. index.md 是 LLM 可读的目录，每次 ingest 后重建
4. 人随时可以直接编辑任何页面；LLM 的工作是把这个"手工流程"自动化

他强调这种系统的价值在于"知识复利"：每次投喂新材料时，LLM 会把新知识与已有页面整合，
而不是像聊天记录一样让知识蒸发。

nashsu/llm_wiki 项目把这个构想工程化：Rust 实现、两段式 CoT ingest（先分析后生成）、
LanceDB 向量索引（可选，Phase 1.5 语义召回）、git 集成可回滚。`
await writeFile(path.join(KB, 'sources', 'karpathy-gist.md'), sample, 'utf8')
console.log('[2] 摄入 sources/karpathy-gist.md 完成')

// 启动 ingest 管道（真实 LLM）
const { ingestSource } = await import('../apps/server/src/ingest-pipeline.ts')
const { createRouting } = await import('../packages/agent-tools/src/index.ts')
const routing = createRouting({
  ingest: { baseUrl: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL_INGEST },
  query: { baseUrl: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL_QUERY },
})
const { EventEmitter } = await import('node:events')
const bus = new EventEmitter()
bus.on('analyze:done', (r) => console.log(`[3] analyze 完成: summary="${r.summary?.slice(0, 40)}…" entities=${r.entities.length} concepts=${r.concepts.length}`))
bus.on('generate:done', (r) => console.log(`[4] generate 完成: ${r.pages.length} 页`))
bus.on('gate:rejected', (errs) => console.log(`[!] 闸门拒绝:`, errs))
bus.on('commit', (sha) => console.log(`[5] git 提交: ${sha}`))

const t0 = Date.now()
const outcome = await ingestSource({ kbRoot: KB, routing, events: bus }, 'sources/karpathy-gist.md')
console.log(`[6] ingest 总耗时 ${Math.round((Date.now() - t0) / 1000)}s`)
console.log(`    落盘页: ${outcome.writtenPages.join(', ')}`)
console.log(`    拒绝数: ${outcome.rejections.length}`)
console.log(`    tokens: analysis(in=${outcome.analysisTokens.input},out=${outcome.analysisTokens.output}) generation(in=${outcome.generationTokens.input},out=${outcome.generationTokens.output})`)

// 验证
const snap = await scanKb(KB)
console.log(`[7] 库状态: pages=${snap.pages.size} sources=${snap.sources.size}`)
const idx = await readFile(path.join(KB, 'index.md'), 'utf8')
console.log('[8] index.md 段:', [...idx.matchAll(/^## (.+)$/gm)].map(m => m[1]).join(', '))
const log = await readFile(path.join(KB, 'log.md'), 'utf8')
console.log('[9] log.md 末条:', log.trimEnd().split('\n').pop())
const firstPage = outcome.writtenPages.find(p => p.startsWith('wiki/entities'))
if (firstPage) {
  const text = await readFile(path.join(KB, firstPage), 'utf8')
  console.log(`[10] 样例页 ${firstPage} 前 400 字:\n${text.slice(0, 400)}`)
}
