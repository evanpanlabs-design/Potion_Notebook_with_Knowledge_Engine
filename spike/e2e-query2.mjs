// 复验 Q1：引用归一化（路径式 → [[标题]](path)）
const path = await import('node:path')
const KB = path.resolve('data/my-wiki')
const { answerQuery } = await import('../apps/server/src/query-pipeline.ts')
const { createRouting } = await import('../packages/agent-tools/src/index.ts')
const routing = createRouting({
  ingest: { baseUrl: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL_INGEST },
  query: { baseUrl: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL_QUERY },
})
const q = await answerQuery({ kbRoot: KB, routing }, '什么是知识复利？')
console.log(`noEvidence=${q.noEvidence} 引用页=${q.citedPages.length}`)
console.log(q.answer)
console.log('\n--- 残留路径式引用检查 ---')
console.log(/\[\[(sources|wiki)\//.test(q.answer) ? 'FAIL: 仍有路径式引用' : 'OK: 无路径式引用')
console.log((q.answer.match(/\[\[.*?\]\]\([^)]+\)/g) ?? []).join('\n'))
