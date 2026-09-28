const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function j(url, opts) {
  const r = await fetch(url, opts)
  let d = {}
  try { d = await r.json() } catch { /* 非 JSON 响应 */ }
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}

const post = (url, body) => j(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) })

export const api = {
  status: () => j('/api/kb/status'),
  addSource: (filename, content) => post('/api/sources', { filename, content }),
  ingest: (source) => post('/api/ingest', { source }),
  query: (question, archive = true) => post('/api/query', { question, archive }),
  graph: () => j('/api/graph'),
  notes: () => j('/api/notes'),
  saveNote: (filename, content, title) => post('/api/notes', { filename, content, title }),
  page: (path) => j(`/api/pages/${path}`),
  reviewQueue: () => j('/api/review-queue'),
  review: (path, action) => post('/api/review', { path, action }),
  log: () => j('/api/log'),
  llmConfig: () => j('/api/llm-config'),
  saveLlmConfig: (ingest, query) => post('/api/llm-config', { ingest, query }),
  testLlmConfig: (role, config) => post('/api/llm-config/test', { role, config }),
}
