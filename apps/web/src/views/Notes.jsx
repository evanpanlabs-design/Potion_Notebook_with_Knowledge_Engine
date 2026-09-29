import React, { useEffect, useRef, useState, useCallback } from 'react'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { autocompletion } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { livePreview, wikilinkClickHandler } from '../cm-livepreview.js'
import MilkdownEditor from '../milkdown/MilkdownEditor.jsx'
import { loadForEditor, joinFrontmatter, saveFromEditor } from '../milkdown/serialize.js'
import { api } from '../api.js'
import { SLOW_HINT_SECONDS } from '../engine-stream.jsx'

/**
 * 文档工作台（v0.2 · ADR-002 第 1/2/3 条）：
 *  - 左栏双 tab：我的笔记（项目分层树，含 ingest 同步徽标、归档/删除）+ 库页面（wiki/sources 全量）
 *  - 全部文档可查看编辑：notes 走人写通道，wiki/sources 保存走 PUT（保留 frontmatter 溯源）
 *  - 「同步到知识库」：notes → 快照+两段式 ingest；sources → 重新 ingest；wiki → LLM 局部维护
 *  - 「导入素材」（v0.2.1 收编原投喂页）：贴文本落盘 sources/ → 两段式消化，产出进审核队列
 *  - 同步全程 SSE 流式详情由 App 层全局引擎流托管（侧栏状态灯 + 浮层渲染器），切视图不打断
 */

/** [[ 触发页面名补全，apply 自动补 ]] */
function pageNameCompletions(getPages) {
  return (context) => {
    const before = context.state.sliceDoc(Math.max(0, context.pos - 120), context.pos)
    const open = before.lastIndexOf('[[')
    if (open === -1 || open < before.lastIndexOf(']]')) return null
    const typed = before.slice(open + 2)
    if (typed.includes(']') || typed.includes('\n')) return null
    const pages = getPages().map((p) => p.title).filter((t) => t && !t.includes(']]'))
    const options = pages.map((title) => ({
      label: title,
      apply: `${title}]]`,
      detail: 'wiki 页面',
    }))
    const filtered = typed ? options.filter((o) => o.label.toLowerCase().includes(typed.toLowerCase())) : options
    return {
      from: context.pos - typed.length,
      options: filtered.slice(0, 20),
      validFor: /^[^\]\n]*$/,
    }
  }
}

const SYNC_BADGE = {
  synced: { text: '已同步', cls: 'sync-badge ok' },
  dirty: { text: '有改动未同步', cls: 'sync-badge dirty' },
  never: { text: '未消化', cls: 'sync-badge never' },
}

export default function Notes({ onOpenPage, stream }) {
  const [tab, setTab] = useState('notes') // 'notes' | 'library'
  const [notes, setNotes] = useState([])
  const [showArchived, setShowArchived] = useState(false)
  const [libraryFiles, setLibraryFiles] = useState([])
  const [graphPages, setGraphPages] = useState([])
  const [current, setCurrent] = useState(null) // { path, title, kind: 'note'|'wiki'|'source'|'meta' }
  const [doc, setDoc] = useState('')
  const [savedText, setSavedText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [paneCollapsed, setPaneCollapsed] = useState(false)
  const [newProject, setNewProject] = useState('') // 新建笔记时的项目输入
  // ---- 编辑模式（feat/milkdown-editor）：'wysiwyg'（Milkdown）| 'source'（CM6 源码 fallback） ----
  const [editMode, setEditMode] = useState(() => localStorage.getItem('ke.editMode') || 'wysiwyg')
  const [fmText, setFmText] = useState(null) // frontmatter yaml 原文（不进编辑器，保存拼回）
  const [fmPanelOpen, setFmPanelOpen] = useState(false)
  const [editorInitial, setEditorInitial] = useState('') // Milkdown 装配初值（仅打开/切换文档时变，否则每次按键会重建编辑器）
  const [editorMd, setEditorMd] = useState('') // Milkdown 实时序列化产物（listener 回调）
  const savedRef = useRef('') // 已保存的完整落盘文本（dirty 判定基线）
const wysInitRef = useRef(false) // wysiwyg 基线是否已随编辑器装配建立（remark 空行规范化会让首帧产物≠原文，需以首帧产物为基线，避免打开即误报 dirty）
const wysPendingDirty = useRef(false) // 带改动切到 wysiwyg 时保持 dirty 标记（基线重建后由它恢复）
const hostRef = useRef(null)
const viewRef = useRef(null)
const milkActionsRef = useRef(null) // Milkdown 命令句柄（插入表格等），由 MilkdownEditor 装配后填充
  const pagesRef = useRef([])


  const loadNotes = useCallback(async () => {
    try {
      const r = await api.notes()
      setNotes(r.notes)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  const loadLibrary = useCallback(async () => {
    try {
      const r = await api.files()
      setLibraryFiles(r.files)
    } catch { /* 库为空时静默 */ }
  }, [])

  // 补全候选 = wiki 页面名 + 已有笔记标题
  useEffect(() => {
    let alive = true
    loadNotes()
    loadLibrary()
    api
      .graph()
      .then((g) => {
        if (!alive) return
        setGraphPages(g.nodes)
        pagesRef.current = g.nodes
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [loadNotes, loadLibrary])

  const openDoc = useCallback(async (item) => {
    setError('')
    setMessage('')
    setSyncResult(null)
    try {
      const p = await api.page(item.path)
      setCurrent(item)
      const text = p.content
      setSavedText(text)
      savedRef.current = text
      setDoc(text)
      const { fmText, body } = loadForEditor(text)
      setFmText(fmText)
      setEditorInitial(body)
      setEditorMd('') // 清空：等编辑器 listener 首次序列化产物再建 dirty 基线（避免用原文当基线的假阳性）
      wysInitRef.current = false
      wysPendingDirty.current = false
      setDirty(false)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  function newNote(projectOverride) {
    // 支持两个入口：顶部输入框（隐式建组）+ 项目组标签上的「+」（在该组内直接新建）。
    // 注意顶部按钮是 onClick={newNote}，React 会把 event 对象作为首参传入，需防御非字符串。
    const proj = (typeof projectOverride === 'string' ? projectOverride : newProject).trim()
    const prefix = proj ? `notes/${proj}/` : 'notes/'
    const existing = new Set(notes.map((n) => n.path))
    let name = ''
    for (let i = 0; i < 100; i++) {
      const cand = (i === 0 ? '未命名笔记' : `未命名笔记-${i}`) + '.md'
      if (!existing.has(prefix + cand)) {
        name = cand
        break
      }
    }
    if (!name) return setError('无法分配新笔记文件名')
    setCurrent({ path: prefix + name, title: name.replace(/\.md$/, ''), kind: 'note' })
    setSavedText('')
    savedRef.current = ''
    setDoc('')
    setFmText(null)
    setEditorInitial('')
    setEditorMd('')
    wysInitRef.current = false
    wysPendingDirty.current = false
    setDirty(false)
    setPaneCollapsed(false)
  }

  /** 当前编辑内容 → 完整落盘文本（两模式统一出口） */
  const composeContent = useCallback(() => {
    if (editMode === 'wysiwyg') {
      return joinFrontmatter(fmText, saveFromEditor(editorMd))
    }
    // 源码模式：编辑器全文（frontmatter 就在正文里，CM6 直编）
    return viewRef.current?.state.doc.toString() ?? ''
  }, [editMode, fmText, editorMd])

  /** 组装当前编辑的正文（不含 fm），供 Milkdown 重建 / dirty 细化 */
  const switchMode = useCallback(
    (next) => {
      if (next === editMode) return
      if (dirty) {
        // 带改动切换：先把当前内容带回另一模式
        const content = composeContent()
        setDoc(content)
        const { fmText: fm, body } = loadForEditor(content)
        setFmText(fm)
        setEditorInitial(body)
        setEditorMd('')
        wysInitRef.current = false
        wysPendingDirty.current = true
      }
      setEditMode(next)
      localStorage.setItem('ke.editMode', next)
    },
    [editMode, dirty, composeContent],
  )

  // Milkdown 实时序列化 → dirty 判定。
  // 首次产物用于建立基线（remark 对原文有空行规范化等 CommonMark 等价改写，
  // 直接拿原文当基线会「打开即 dirty」）；空文档场景基线为 ''。
  useEffect(() => {
    if (editMode !== 'wysiwyg' || !current) return
    if (!wysInitRef.current) {
      if (editorMd === '') return // 编辑器 listener 尚未产出
      wysInitRef.current = true
      savedRef.current = editorInitial === '' ? '' : joinFrontmatter(fmText, saveFromEditor(editorMd))
      setDirty(wysPendingDirty.current)
      return
    }
    setDirty(joinFrontmatter(fmText, saveFromEditor(editorMd)) !== savedRef.current)
  }, [editMode, editorMd, editorInitial, fmText, current])

  // 挂载/切换笔记时重建 CM6 编辑器（仅源码模式）
  useEffect(() => {
    if (!hostRef.current || !current || editMode !== 'source') return
    const state = EditorState.create({
      doc: doc,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        markdown(),
        livePreview(),
        wikilinkClickHandler(onOpenPage),
        autocompletion({
          override: [pageNameCompletions(() => {
            const noteTitles = notes.map((n) => ({ title: n.title }))
            return [...pagesRef.current, ...noteTitles]
          })],
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) setDirty(true)
        }),
        EditorView.lineWrapping,
      ],
    })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    view.focus()
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.path, editMode])

  const isNote = current?.kind === 'note'
  const noteMeta = isNote ? notes.find((n) => n.path === current?.path) : null

  async function save() {
    if (!current || saving) return
    // 保险丝：富文本模式下编辑器未产出（重建中/异常）时保存会把空正文落盘（曾致正文清空事故）
    if (editMode === 'wysiwyg' && editorMd === '' && editorInitial !== '') {
      setError('编辑器尚未就绪（正在重建），请稍候 1 秒再保存')
      return
    }
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const text = composeContent()
      let r
      if (isNote) {
        const relNoPrefix = current.path.replace(/^notes\//, '')
        const project = relNoPrefix.includes('/') ? relNoPrefix.split('/')[0] : ''
        const filename = relNoPrefix.split('/').pop()
        r = await api.saveNoteEx(filename, text, current.title, project)
        await loadNotes()
      } else {
        r = await api.putPage(current.path, text)
        await loadLibrary()
      }
      setSavedText(text)
      savedRef.current = text
      setDoc(text) // 保存后同步 doc state：切源码模式时 CM6 重建要读最新全文（否则显示保存前旧内容）
      setDirty(false)
      setMessage(`已保存 · commit ${r.commitSha?.slice(0, 7) ?? '—'}`)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  /** 同步到知识库：先保存（若有改动）→ POST /sync → SSE 工作台已实时展示过程 */
  async function syncToKb() {
    if (!current || syncing || stream.busy) return
    setSyncing(true)
    setError('')
    setMessage('')
    setSyncResult(null)
    stream.begin()
    try {
      if (dirty) await save()
      const outcome = await api.sync(current.path)
      setSyncResult(outcome)
      setMessage(null)
      await loadNotes()
      await loadLibrary()
    } catch (e) {
      setError(e.message)
    } finally {
      stream.end()
      setSyncing(false)
    }
  }

  async function toggleArchive(note) {
    try {
      await api.archiveNote(note.path, !note.archived)
      await loadNotes()
    } catch (e) {
      setError(e.message)
    }
  }

  /** 重命名笔记：同目录内改文件名（分组不变）；若 title 就是旧文件名则同步更新。
   *  打开中的笔记同步更新路径，编辑器内容保留。 */
  async function renameNote(note) {
    const oldName = note.path.split('/').pop().replace(/\.md$/, '')
    const input = window.prompt(`重命名「${note.title}」（只改文件名，分组不变；title 若为默认值会一并同步）`, oldName)
    if (input === null) return
    const newName = input.trim()
    if (!newName) return
    if (newName === oldName) return
    try {
      const r = await api.renameNote(note.path, `${newName}.md`)
      if (!r.unchanged && current?.path === note.path) {
        setCurrent({ ...current, path: r.path, title: newName })
      }
      await loadNotes()
      setMessage(`已重命名为「${newName}」`)
    } catch (e) {
      setError(e.message)
    }
  }

  async function removeNote(note) {
    if (!window.confirm(`确定删除「${note.title}」？文件将从磁盘移除（git 历史仍可找回）。`)) return
    try {
      await api.deleteNote(note.path)
      if (current?.path === note.path) {
        setCurrent(null)
        setDoc('')
        setSavedText('')
        savedRef.current = ''
      }
      await loadNotes()
    } catch (e) {
      setError(e.message)
    }
  }

  // 左栏：我的笔记按项目分组
  const visibleNotes = notes.filter((n) => showArchived || !n.archived)
  const projects = []
  for (const n of visibleNotes) {
    let g = projects.find((p) => p.name === n.project)
    if (!g) {
      g = { name: n.project, notes: [] }
      projects.push(g)
    }
    g.notes.push(n)
  }
  projects.sort((a, b) => (a.name === '' ? -1 : b.name === '' ? 1 : a.name.localeCompare(b.name)))

  // 左栏：库页面按目录分组
  const libGroups = []
  for (const f of libraryFiles) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '(根目录)'
    let g = libGroups.find((x) => x.dir === dir)
    if (!g) {
      g = { dir, files: [] }
      libGroups.push(g)
    }
    g.files.push(f)
  }

  const slow = syncing && stream.elapsed >= SLOW_HINT_SECONDS
  const badge = noteMeta ? SYNC_BADGE[noteMeta.syncState] : null

  return (
    <div className="notes-shell">
      <aside className={`notes-pane ${paneCollapsed ? 'collapsed' : ''}`}>
        <div className="notes-pane-head">
          {!paneCollapsed && <span className="pane-title">文档 · {isNote ? '笔记' : '全库'}</span>}
          <button
            className="pane-btn"
            onClick={() => setPaneCollapsed(!paneCollapsed)}
            aria-label={paneCollapsed ? '展开列表' : '折叠列表'}
            title={paneCollapsed ? '展开列表' : '折叠列表'}
          >
            {paneCollapsed ? '»' : '«'}
          </button>
        </div>
        {!paneCollapsed && (
          <div className="notes-pane-body">
            <div className="doc-tabs">
              <button className={`doc-tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}>
                我的笔记 · {notes.length}
              </button>
              <button className={`doc-tab ${tab === 'library' ? 'active' : ''}`} onClick={() => setTab('library')}>
                库页面 · {libraryFiles.length}
              </button>
            </div>

            {tab === 'notes' && (
              <>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  <button className="btn btn-sm btn-secondary" onClick={newNote} style={{ flex: 1 }}>+ 新建笔记</button>
                </div>
                <input
                  className="input input-sm"
                  style={{ width: '100%', marginBottom: 8, boxSizing: 'border-box' }}
                  placeholder="📁 项目分组名（可空）——填了再点「新建笔记」即创建新项目组"
                  value={newProject}
                  onChange={(e) => setNewProject(e.target.value)}
                  title="填了项目名再点「新建笔记」，新笔记会放进 notes/<项目>/ 子目录（即创建该分组）"
                />
                <div className="doc-tree">
                  {projects.length === 0 && (
                    <div className="mono" style={{ color: 'var(--c-text-3)', padding: 8, lineHeight: 1.7 }}>
                      写笔记，或到「素材」页导入材料，引擎会自动消化进知识库，随时到「审核」页把关。
                    </div>
                  )}
                  {projects.map((g) => (
                    <div key={g.name || '(默认)'}>
                      <div className="doc-group-label">
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {g.name ? `📁 ${g.name}` : '📁 默认项目'} · {g.notes.length}
                        </span>
                        <button
                          className="group-add"
                          title={g.name ? `在「${g.name}」下新建笔记` : '在默认项目下新建笔记'}
                          onClick={() => newNote(g.name)}
                        >
                          +
                        </button>
                      </div>
                      {g.notes.map((n) => (
                        <div key={n.path} className={`note-row ${current?.path === n.path ? 'active' : ''}`}>
                          <button className="note-item" onClick={() => openDoc({ ...n, kind: 'note' })}>
                            <span className="note-title">
                              {n.title}
                              {n.archived && <span className="archived-tag">已归档</span>}
                              {n.syncState === 'dirty' && <span className="sync-dot" title="有改动未同步到知识库">●</span>}
                            </span>
                            <span className="note-time">{n.updatedAt?.slice(0, 16).replace('T', ' ')}</span>
                          </button>
                          <span className="note-row-actions">
                            <button className="icon-btn" title="重命名" onClick={() => renameNote(n)}>✎</button>
                            <button className="icon-btn" title={n.archived ? '取消归档' : '归档'} onClick={() => toggleArchive(n)}>
                              {n.archived ? '↩' : '📦'}
                            </button>
                            <button className="icon-btn" title="删除" onClick={() => removeNote(n)}>✕</button>
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
                <label className="show-archived">
                  <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                  显示已归档
                </label>
                <div className="notes-pane-foot">
                  输入 [[ 可补全引用任意 wiki 页面；保存后自动带 frontmatter 入库、提交 git。
                </div>
              </>
            )}

            {tab === 'library' && (
              <div className="doc-tree">
                {libGroups.length === 0 && (
                  <div className="mono" style={{ color: 'var(--c-text-3)', padding: 8 }}>库为空——先写笔记或到「素材」页导入并同步。</div>
                )}
                {libGroups.map((g) => (
                  <div key={g.dir}>
                    <div className="doc-group-label">{g.dir}</div>
                    {g.files.map((f) => (
                      <button
                        key={f.path}
                        className={`note-item ${current?.path === f.path ? 'active' : ''}`}
                        onClick={() => openDoc({ path: f.path, title: f.path.split('/').pop().replace(/\.md$/, ''), kind: f.kind })}
                      >
                        <span className="note-title">
                          {f.path.split('/').pop().replace(/\.md$/, '')}
                          {f.reviewed && <span className="reviewed-tag">✓</span>}
                        </span>
                        <span className="note-time">{f.kind}</span>
                      </button>
                    ))}
                  </div>
                ))}
                <div className="notes-pane-foot">
                  库页面（AI 生成 / 来源）同样可直接编辑；保存保留溯源 frontmatter，改完可「同步到知识库」让引擎局部维护关联页。
                </div>
              </div>
            )}
          </div>
        )}
      </aside>

      <section className="notes-main">
        {error && <div className="banner banner-danger" style={{ margin: '12px 24px 0' }}>{error}</div>}

        {!current && (
          <div className="empty-state" style={{ margin: 'auto', border: 'none' }}>
            从左侧选择一篇文档，或新建一篇笔记
          </div>
        )}

        {current && (
          <div className="editor-wrap">
            <div className="editor-toolbar">
              <span className="filename">
                {current.path} {dirty && <span className="dirty-dot">● 未保存</span>}
                {isNote && badge && <span className={badge.cls}>{badge.text}</span>}
                {isNote && noteMeta?.lastIngestedAt && (
                  <span className="ingest-time">上次消化 {noteMeta.lastIngestedAt.slice(0, 16).replace('T', ' ')}</span>
                )}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <div className="mode-switch" title="切换编辑模式（改动会带入）">
                  <button
                    className={`mode-btn ${editMode === 'wysiwyg' ? 'active' : ''}`}
                    onClick={() => switchMode('wysiwyg')}
                    title="所见即所得（Milkdown）"
                  >
                    富文本
                  </button>
                  <button
                    className={`mode-btn ${editMode === 'source' ? 'active' : ''}`}
                    onClick={() => switchMode('source')}
                    title="Markdown 源码（CodeMirror）"
                  >
                    源码
                  </button>
                </div>
                {editMode === 'wysiwyg' && (
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => {
                      if (!milkActionsRef.current?.insertTable?.()) {
                        setMessage('编辑器尚未就绪，稍候再试')
                      }
                    }}
                    title="在光标处插入 3×3 表格（GFM）"
                  >
                    表格
                  </button>
                )}
                {editMode === 'wysiwyg' && fmText != null && (
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => setFmPanelOpen(!fmPanelOpen)}
                    title="查看/编辑页面元信息（frontmatter：溯源、时间戳等，保存时拼回）"
                  >
                    {fmPanelOpen ? '▾ 元信息' : '▸ 元信息'}
                  </button>
                )}
                {isNote && (
                  <button className="btn btn-sm btn-secondary" onClick={syncToKb} disabled={syncing || stream.busy}>
                    {syncing ? `同步中 ${stream.elapsed}s…` : noteMeta?.syncState === 'never' ? '⚙ 消化此笔记' : '⚙ 同步到知识库'}
                  </button>
                )}
                {!isNote && (
                  <button className="btn btn-sm btn-secondary" onClick={syncToKb} disabled={syncing || stream.busy}>
                    {syncing ? `同步中 ${stream.elapsed}s…` : '⚙ 同步到知识库'}
                  </button>
                )}
                <button className="btn btn-sm btn-primary" onClick={save} disabled={saving || !dirty}>
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
            {editMode === 'wysiwyg' && fmPanelOpen && fmText != null && (
              <div className="fm-panel">
                <div className="fm-panel-label">frontmatter（高级元信息，谨慎修改 · 保存时拼回文件头）</div>
                <textarea
                  className="input mono"
                  value={fmText}
                  onChange={(e) => { setFmText(e.target.value); setDirty(true) }}
                  rows={Math.min(12, fmText.split('\n').length + 1)}
                  spellCheck={false}
                />
              </div>
            )}
            <div className="editor-host" style={{ display: editMode === 'wysiwyg' ? 'none' : 'block' }} ref={hostRef} />
            {editMode === 'wysiwyg' ? (
              <div className="editor-host milk-host">
                <MilkdownEditor
                  initial={editorInitial}
                  pages={[...graphPages, ...notes.map((n) => ({ title: n.title }))].map((p) => ({ title: p.title }))}
                  onOpenTitle={(path) => onOpenPage?.(path)}
                  onMarkdown={setEditorMd}
                  actionRef={milkActionsRef}
                />
              </div>
            ) : null}
            {message && <div className="banner banner-success" style={{ margin: 0, borderRadius: 0 }}>{message}</div>}
            {syncing && stream.stage && (
              <div className="sync-stage-bar">
                <span className="spinner" />
                <span className="mono">{stream.stage.text} · 已耗时 {stream.elapsed}s</span>
              </div>
            )}
            {syncing && slow && (
              <div className="banner banner-warning" style={{ margin: 0, borderRadius: 0 }}>
                已耗时 {stream.elapsed}s：LLM 管道受 RPM 限流与 429 退避重试影响，耗时数分钟属正常范围。
              </div>
            )}
            {syncResult && (
              <div className="sync-result" style={{ margin: 0, borderRadius: 0 }}>
                <div className="banner banner-success">
                  同步完成（{syncResult.kind === 'note-ingest' ? '笔记已消化' : syncResult.kind === 'source-reingest' ? '来源已重新消化' : '知识图谱已局部维护'}）
                  {syncResult.kind === 'wiki-maintain' && syncResult.summary ? `：${syncResult.summary}` : ''}
                </div>
                {syncResult.kind === 'wiki-maintain' ? (
                  <>
                    {syncResult.updatedPages?.length > 0 && (
                      <div className="mono sync-detail">
                        联动更新：{syncResult.updatedPages.join('、')}
                      </div>
                    )}
                    {syncResult.updatedPages?.length === 0 && (
                      <div className="mono sync-detail">周边页面无需更新。</div>
                    )}
                  </>
                ) : (
                  syncResult.writtenPages?.length > 0 && (
                    <div className="mono sync-detail">
                      产出 {syncResult.writtenPages.length} 页{syncResult.snapshotPath ? ` · 来源快照 ${syncResult.snapshotPath}` : ''}
                    </div>
                  )
                )}
                {syncResult.skipped && <div className="mono sync-detail">内容未变化，引擎幂等跳过。</div>}
                {syncResult.rejections?.length > 0 && (
                  <div className="mono sync-detail warn">闸门拒绝 {syncResult.rejections.length} 条提案</div>
                )}
              </div>
            )}
          </div>
        )}

        {graphPages.length === 0 && current && (
          <div className="mono" style={{ color: 'var(--c-text-3)', padding: '8px 24px' }}>
            提示：wiki 页面名补全需要库里有页面（当前为空）
          </div>
        )}
      </section>

    </div>
  )
}
