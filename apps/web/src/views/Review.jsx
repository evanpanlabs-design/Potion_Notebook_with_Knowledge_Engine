import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../api.js'
import MarkdownHost from './MarkdownHost.jsx'

/**
 * D10-11 审核页：AI 生成页默认待审，人在把关（Human-in-the-loop）。
 * 左列 = 待审队列（wiki/ 下 reviewed !== true 的机生页），右列 = 页面预览 + 通过/驳回。
 * 通过 → fm.reviewed = true；驳回 → 删除该页（log 留痕可追溯）。
 */
export default function Review() {
  const [queue, setQueue] = useState([])
  const [reviewedCount, setReviewedCount] = useState(0)
  const [sel, setSel] = useState(null) // 当前选中 {path,title,type,updatedAt}
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [flash, setFlash] = useState('')

  const refresh = useCallback(async (keepPath) => {
    try {
      const r = await api.reviewQueue()
      setQueue(r.queue)
      setReviewedCount(r.reviewedCount)
      return r.queue
    } catch (e) {
      setError(`读取队列失败：${e.message}`)
      return []
    }
  }, [])

  // 初次加载：取队列并选中第一项
  useEffect(() => {
    let alive = true
    refresh().then((q) => {
      if (alive && q.length > 0) setSel(q[0])
    })
    return () => {
      alive = false
    }
  }, [refresh])

  // 选中项变化：拉取页面内容
  useEffect(() => {
    if (!sel) {
      setContent('')
      return
    }
    let alive = true
    setLoading(true)
    setError('')
    api
      .page(sel.path)
      .then((r) => alive && setContent(r.content))
      .catch((e) => alive && setError(`读取页面失败：${e.message}`))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [sel])

  const act = async (action) => {
    if (!sel || busy) return
    setBusy(true)
    setError('')
    try {
      await api.review(sel.path, action)
      setFlash(action === 'approve' ? `已通过：${sel.title}` : `已驳回并删除：${sel.title}`)
      const q = await refresh()
      setSel(q.find((p) => p.path === sel.path) ?? q[0] ?? null)
    } catch (e) {
      setError(`操作失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  // flash 提示 3s 自动消失
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(''), 3000)
    return () => clearTimeout(t)
  }, [flash])

  const stripFm = content.replace(/^---\n[\s\S]*?\n---\n/, '')

  return (
    <div className="notes-shell">
      <aside className="notes-pane">
        <div className="notes-pane-head">
          <span className="pane-title">待审队列 · {queue.length}</span>
        </div>
        <div className="note-list">
          {queue.length === 0 && <div className="review-empty">队列空了 —— AI 生成的页面都已过审 ✅</div>}
          {queue.map((p) => (
            <button
              key={p.path}
              className={`note-item ${sel?.path === p.path ? 'active' : ''}`}
              onClick={() => setSel(p)}
            >
              <span className="note-title">{p.title}</span>
              <span className="note-meta">{p.type} · {p.path}</span>
            </button>
          ))}
        </div>
        <div className="notes-pane-foot">已过审 {reviewedCount} 页 · 机生页需人把关后才算正式知识</div>
      </aside>
      <section className="notes-main">
        {error && <div className="banner banner-danger">{error}</div>}
        {flash && <div className="banner banner-ok">{flash}</div>}
        {!sel && !error && (
          <div className="review-blank">
            <p>这里陈列所有 AI 落盘但尚未过审的页面。</p>
            <p className="review-hint">逐页预览 →「通过」让它转正，或「驳回」删除它。所有操作都会记入 log.md 流水。</p>
          </div>
        )}
        {sel && (
          <div className="editor-wrap">
            <div className="editor-toolbar review-toolbar">
              <div className="review-pageinfo">
                <span className="review-title">{sel.title}</span>
                <span className="path">{sel.path}</span>
              </div>
              <div className="review-actions">
                <button className="btn btn-ok" disabled={busy} onClick={() => act('approve')}>
                  ✓ 通过
                </button>
                <button className="btn btn-danger" disabled={busy} onClick={() => act('reject')}>
                  ✕ 驳回删除
                </button>
              </div>
            </div>
            <div className="review-preview editor-host">
              {loading ? (
                <div className="loading-row">
                  <span className="spinner" /> 正在加载页面…
                </div>
              ) : (
                <MarkdownHost text={stripFm} onOpenPage={() => {}} />
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
