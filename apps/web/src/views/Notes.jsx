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
  const hostRef = useRef(null)
  const viewRef = useRef(null)
  const pagesRef = useRef([])

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
    const name = prompt('新笔记文件名（.md 结尾）', `note-${Date.now().toString(36)}.md`)
    if (!name) return
    if (!/\.md$/.test(name)) return setError('文件名需要 .md 结尾')
    const note = { path: `notes/${name}`, title: name.replace(/\.md$/, ''), updatedAt: '' }
    setCurrent(note)
    setSavedText('')
    setDoc('')
    setDirty(false)
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
    <div className="page page-wide">
      <h1 className="page-title">笔记</h1>
      <p className="page-desc">
        你的手写笔记，与 wiki 平级。输入 <code className="mono">[[</code> 可补全引用任意 wiki
        页面，保存后自动带 frontmatter 入库、提交 git。
      </p>

      {error && <div className="banner banner-danger">{error}</div>}

      <div className="notes-layout">
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span className="field-label" style={{ margin: 0 }}>我的笔记</span>
            <button className="btn btn-sm btn-secondary" onClick={newNote}>+ 新建</button>
          </div>
          <div className="note-list">
            {notes.length === 0 && <div className="mono" style={{ color: 'var(--c-text-3)', padding: 8 }}>还没有笔记，点“新建”开始写。</div>}
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
        </div>

        <div>
          {!current && (
            <div className="empty-state" style={{ height: 480, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
            </div>
          )}
          {message && (
            <div className="banner banner-success" style={{ marginTop: 12, marginBottom: 0 }}>
              {message}
            </div>
          )}
          {graphPages.length === 0 && (
            <div className="mono" style={{ color: 'var(--c-text-3)', marginTop: 8 }}>
              提示：wiki 页面名补全需要库里有页面（当前为空）
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
