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
  // ---- v0.2.5 · 原始素材 / MinerU PDF 解析 ----
  listSources: () => j('/api/sources'),
  getMineruConfig: () => j('/api/mineru/config'),
  saveMineruConfig: (apiKey) => post('/api/mineru/config', { apiKey }),
  testMineru: (apiKey) => post('/api/mineru/config/test', { apiKey }),
  mineruConvert: (files) => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f, f.name)
    return j('/api/mineru/convert', { method: 'POST', body: fd })
  },
  mineruTasks: () => j('/api/mineru/tasks'),
  // ---- v0.3 · Tavily 联网检索 / Agent 多步问答（ADR-003 D1） ----
  getTavilyConfig: () => j('/api/tavily/config'),
  saveTavilyConfig: (payload) => post('/api/tavily/config', payload),
  testTavily: (apiKey) => post('/api/tavily/config/test', { apiKey }),
  agentQuery: (question) => post('/api/agent-query', { question }),
  // ---- v0.3 · 定时任务（ADR-003 D2-3） ----
  parseTaskIntent: (text) => post('/api/tasks/parse', { text }),
  listTasks: () => j('/api/tasks'),
  createTask: (payload) => post('/api/tasks', payload),
  deleteTask: (id) => j(`/api/tasks/${id}`, { method: 'DELETE' }),
  toggleTask: (id, enabled) => post(`/api/tasks/${id}`, { enabled }),
  runTaskNow: (id) => post(`/api/tasks/${id}/run`, {}),
  // ---- v0.3 · 收件箱（ADR-003 D4-5） ----
  listInbox: () => j('/api/inbox'),
  readInbox: (rel) => j(`/api/${rel.replace(/^inbox\//, 'inbox/')}`),
  digestInbox: (rel) => post(`/api/${rel.replace(/^inbox\//, 'inbox/')}/digest`, {}),
  // ---- v0.3 · graph audit（ADR-003 D6-7）+ 人工建议（D8-9） ----
  startAudit: () => post('/api/graph/audit', {}),
  auditStatus: () => j('/api/graph/audit/status'),
  auditSuggestions: () => j('/api/graph/suggestions'),
  pageSuggestions: (rel) => j(`/api/suggestions/${rel}`),
  addSuggestion: (rel, note) => post(`/api/suggestions/${rel}`, { note }),
  removeSuggestion: (rel, index) => j(`/api/suggestions/${rel}?index=${index}`, { method: 'DELETE' }),
  // ---- v0.3 · bulletin board 便利贴（ADR-003 D10-11） ----
  listBulletins: () => j('/api/bulletins'),
  createBulletin: (text, kind = 'note', ttlDays = 7) => post('/api/bulletins', { text, kind, ttlDays }),
  setBulletinStatus: (id, status) => post(`/api/bulletins/${id}/status`, { status }),
  replyBulletin: (id, text) => post(`/api/bulletins/${id}/reply`, { text }),
  // ---- v0.3 · workbench 任务轨迹（ADR-003 D12） ----
  listWorkbench: () => j('/api/workbench'),
  workbenchTask: (id) => j(`/api/workbench/${id}`),
}
