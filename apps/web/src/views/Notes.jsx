import React, { useEffect, useRef, useState, useCallback } from 'react'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { autocompletion } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { livePreview, wikilinkClickHandler } from '../cm-livepreview.js'
import { api } from '../api.js'

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

export default function Notes({ onOpenPage }) {
  const [notes, setNotes] = useState([])
  const [graphPages, setGraphPages] = useState([])
  const [current, setCurrent] = useState(null) // { path, title }
  const [doc, setDoc] = useState('') // 编辑器外的受控镜像（用于 dirty 判断）
  const [savedText, setSavedText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [paneCollapsed, setPaneCollapsed] = useState(false)
  const hostRef = useRef(null)
  const viewRef = useRef(null)
  const pagesRef = useRef([])

  // D12-13 修复：dirty 状态广播到全局（App 切视图时 confirm 拦截）+ beforeunload 防误关
  useEffect(() => {
    window.__potionNoteDirty = dirty
    const onBeforeUnload = (e) => {
      if (dirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.__potionNoteDirty = false
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [dirty])

  const loadNotes = useCallback(async () => {
    try {
      const r = await api.notes()
      setNotes(r.notes)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  // 补全候选 = wiki 页面名（图数据可得 title）+ 已有笔记标题
  useEffect(() => {
    let alive = true
    loadNotes()
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
  }, [loadNotes])

  const openNote = useCallback(async (note) => {
    setError('')
    setMessage('')
    try {
      const p = await api.page(note.path)
      setCurrent(note)
      const text = p.content
      setSavedText(text)
      setDoc(text)
      setDirty(false)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  function newNote() {
    // D12-13 P2：去掉原生 prompt，自动唯一命名，创建后直接聚焦编辑器
    const existing = new Set(notes.map((n) => n.path))
    let name = ''
    for (let i = 0; i < 100; i++) {
      const cand = i === 0 ? '未命名笔记.md' : `未命名笔记-${i}.md`
      if (!existing.has(`notes/${cand}`)) {
        name = cand
        break
      }
    }
    if (!name) return setError('无法分配新笔记文件名')
    const note = { path: `notes/${name}`, title: name.replace(/\.md$/, ''), updatedAt: '' }
    setCurrent(note)
    setSavedText('')
    setDoc('')
    setDirty(false)
    setPaneCollapsed(false)
  }

  // 挂载/切换笔记时重建编辑器
  useEffect(() => {
    if (!hostRef.current || !current) return
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
  }, [current?.path])

  async function save() {
    if (!current || saving) return
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const filename = current.path.replace(/^notes\//, '')
      const text = viewRef.current.state.doc.toString()
      const r = await api.saveNote(filename, text, current.title)
      setSavedText(text)
      setDirty(false)
      setMessage(`已保存 · commit ${r.commitSha?.slice(0, 7) ?? '—'}`)
      loadNotes()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="notes-shell">
      <aside className={`notes-pane ${paneCollapsed ? 'collapsed' : ''}`}>
        <div className="notes-pane-head">
          {!paneCollapsed && <span className="pane-title">我的笔记 · {notes.length}</span>}
          <button
            className="pane-btn"
            onClick={() => setPaneCollapsed(!paneCollapsed)}
            aria-label={paneCollapsed ? '展开笔记列表' : '折叠笔记列表'}
            title={paneCollapsed ? '展开笔记列表' : '折叠笔记列表'}
          >
            {paneCollapsed ? '»' : '«'}
          </button>
        </div>
        {!paneCollapsed && (
          <div className="notes-pane-body">
            <button className="btn btn-sm btn-secondary" onClick={newNote}>+ 新建</button>
            <div className="note-list">
              {notes.length === 0 && (
                <div className="mono" style={{ color: 'var(--c-text-3)', padding: 8 }}>还没有笔记，点“新建”开始写。</div>
              )}
              {notes.map((n) => (
                <button
                  key={n.path}
                  className={`note-item ${current?.path === n.path ? 'active' : ''}`}
                  onClick={() => openNote(n)}
                >
                  <span className="note-title">{n.title}</span>
                  <span className="note-time">{n.updatedAt?.slice(0, 16).replace('T', ' ')}</span>
                </button>
              ))}
            </div>
            <div className="notes-pane-foot">
              输入 [[ 可补全引用任意 wiki 页面；保存后自动带 frontmatter 入库、提交 git。
            </div>
          </div>
        )}
      </aside>

      <section className="notes-main">
        {error && <div className="banner banner-danger" style={{ margin: '12px 24px 0' }}>{error}</div>}

        {!current && (
          <div className="empty-state" style={{ margin: 'auto', border: 'none' }}>
            从左侧选择一篇笔记，或新建一篇
          </div>
        )}

        {current && (
          <div className="editor-wrap">
            <div className="editor-toolbar">
              <span className="filename">{current.path} {dirty && <span className="dirty-dot">● 未保存</span>}</span>
              <button className="btn btn-sm btn-primary" onClick={save} disabled={saving || !dirty}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
            <div className="editor-host" ref={hostRef} />
            {message && <div className="banner banner-success" style={{ margin: 0, borderRadius: 0 }}>{message}</div>}
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
