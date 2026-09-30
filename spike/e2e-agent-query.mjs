/**
 * D1 e2e 冒烟（ADR-003）：agent loop 真实模式——多步工具调用全链路。
 *   真实 LLM（glm-53）+ 真实库（data/my-wiki）+ 真实工具（search_kb/read_page/list_neighbors）
 * 验证点：模型会按系统提示先 search_kb → read_page，再综合作答；trace/留痕/引用归一化。
 *
 * 运行：node --env-file-if-exists=.env spike/e2e-agent-query.mjs
 */
console.log('[e2e] 模式：real（调 LLM + 真实库工具）')
// ⚠️ 中文目录名会被 URL.pathname 百分号编码，必须用 fileURLToPath 还原
import { fileURLToPath } from 'node:url'
const KB_ROOT = fileURLToPath(new URL('../data/my-wiki', import.meta.url))
const DATA_ROOT = fileURLToPath(new URL('../data', import.meta.url))

// 1) routing（与 server 同源的 OpenAI 兼容自定义 provider）
const { createRouting } = await import('../packages/agent-tools/src/pi-adapter.ts')
const routing = createRouting({
  ingest: {
    baseUrl: process.env.LLM_BASE_URL,
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL_INGEST ?? 'LongCat-2.0',
  },
  query: {
    baseUrl: process.env.LLM_BASE_URL,
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL_QUERY ?? 'glm-53-meituan',
  },
})

// 2) 工具 + agent 管道
const { buildKbTools } = await import('../apps/server/src/agent-tools.ts')
const { runAgentLoop } = await import('../packages/agent-tools/src/agent-loop.ts')

const tools = await buildKbTools({ kbRoot: KB_ROOT, dataRoot: DATA_ROOT })
console.log(`[e2e] 工具白名单：${tools.map((t) => t.name).join(', ')}（web_search ${tools.some((t) => t.name === 'web_search') ? '已启用' : '未启用'}）`)

const AGENT_PROMPT = `你是知识库研究助手，可以调用工具多步检索后回答问题。工作规则：
1. 先用 search_kb 检索库内相关页面；命中不足时可用 list_neighbors 顺藤摸瓜，或用 read_page 读整页细看
2. 回答中的库内主张用 [[页面名]] 标注出处
3. 库内无依据时必须明说，禁止编造
4. 工具调用要有节制：通常 2-6 步足够；信息够了就直接作答
5. 回答用与问题相同的语言`

const question = '卡片盒笔记法和费曼学习法、间隔重复有什么关系？结合起来怎么用？'
const t0 = Date.now()
const result = await runAgentLoop({
  systemPrompt: AGENT_PROMPT,
  userPrompt: question,
  tools,
  routing,
  maxTurns: 8,
  onEvent: (ev) => {
    if (ev.type === 'agent:tool_start') console.log(`[e2e] 🔧 ${ev.name}(${JSON.stringify(ev.args).slice(0, 80)})`)
    if (ev.type === 'agent:tool_end') console.log(`[e2e] ← ${ev.name} ${ev.ms}ms ${ev.isError ? 'ERROR' : 'ok'}: ${ev.preview.slice(0, 60)}…`)
    if (ev.type === 'agent:turn_start') console.log(`[e2e] --- 轮 ${ev.turn} ---`)
  },
})

console.log(`\n[e2e] 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s · ${result.turns} 轮 ${result.steps} 步 · truncated=${result.truncated} · tokens in=${result.tokens.input} out=${result.tokens.output}`)
console.log('[e2e] trace 摘要：')
for (const s of result.trace) {
  console.log(`  - ${s.tool} ${s.ms}ms ${s.isError ? 'ERR' : ''} → ${s.resultPreview.slice(0, 70)}`)
}
console.log(`\n[e2e] 回答（前 600 字）：\n${result.answer.slice(0, 600)}`)

if (result.turns < 2 || result.steps < 1) {
  console.error('\n[e2e] ⚠️ 模型没有走多步工具链路（steps=0 或单轮直答）——检查提示词或模型工具调用能力')
  process.exit(1)
}
console.log('\n[e2e] ✅ agent loop 多步工具调用全链路通过')
