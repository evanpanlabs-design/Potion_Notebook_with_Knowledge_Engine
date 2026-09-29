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
  // ---- v0.2 · 文档工作台 / 同步 / 返修池 / 子图 ----
  files: () => j('/api/files'),
  putPage: (path, content) => j(`/api/pages/${path}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ content }) }),
  sync: (path) => post('/api/sync', { path }),
  archiveNote: (path, archived) => post('/api/notes/archive', { path, archived }),
  deleteNote: (path) => j(`/api/notes?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  renameNote: (path, filename) => post('/api/notes/rename', { path, filename }),
  saveNoteEx: (filename, content, title, project) => post('/api/notes', { filename, content, title, project }),
  reviewEx: (path, action, note) => post('/api/review', { path, action, note }),
  reworkStatus: () => j('/api/review/rework-status'),
  reworkRun: (items) => post('/api/review/rework-run', { items }),
  graphSub: (seeds) => j(`/api/graph/sub?seeds=${encodeURIComponent(seeds.join(','))}`),
  // ---- v0.2.2 · 问答历史 / 悬浮球提问 ----
  queries: () => j('/api/queries'),
}
