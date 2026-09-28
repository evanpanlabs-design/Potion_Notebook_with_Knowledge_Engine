// D5 F5 真实 e2e：对真实库提问（有依据/无依据/归档）
const path = await import('node:path')
const { readFile } = await import('node:fs/promises')
const KB = path.resolve('data/my-wiki')

const { answerQuery } = await import('../apps/server/src/query-pipeline.ts')
const { createRouting } = await import('../packages/agent-tools/src/index.ts')
const routing = createRouting({
  ingest: { baseUrl: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL_INGEST },
  query: { baseUrl: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL_QUERY },
})

const t0 = Date.now()
// Q1: 有依据的问题
const q1 = await answerQuery({ kbRoot: KB, routing }, '什么是知识复利？')
console.log('=== Q1: 什么是知识复利 ===')
console.log(`noEvidence=${q1.noEvidence} tokens(in=${q1.tokens.input},out=${q1.tokens.output}) 引用页=${q1.citedPages.length}`)
console.log(q1.answer.slice(0, 300))
console.log()

// Q2: 库外无依据问题
const q2 = await answerQuery({ kbRoot: KB, routing }, '量子计算的基本原理是什么？')
console.log('=== Q2: 量子计算原理（应判无依据）===')
console.log(`noEvidence=${q2.noEvidence} tokens(in=${q2.tokens.input},out=${q2.tokens.output}) 引用页=${q2.citedPages.length}`)
console.log(q2.answer.slice(0, 200))
console.log()

// Q3: 归档
const q3 = await answerQuery({ kbRoot: KB, routing }, '两段式 CoT ingest 是什么机制？', { archive: true })
console.log('=== Q3: 两段式 CoT ingest（带归档）===')
console.log(`noEvidence=${q3.noEvidence} archive=${q3.archivePath}`)
if (q3.archivePath) {
  const archived = await readFile(path.join(KB, q3.archivePath), 'utf8')
  console.log('归档页前 260 字:', archived.slice(0, 260).replace(/\n/g, ' | '))
}
console.log(`\n总耗时 ${Math.round((Date.now() - t0) / 1000)}s（RPM=5 串行 3 次调用）`)
