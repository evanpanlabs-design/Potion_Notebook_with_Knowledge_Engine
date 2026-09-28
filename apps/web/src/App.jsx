import React, { useEffect, useState, useCallback } from 'react'
import { api } from './api.js'
import MarkdownHost from './views/MarkdownHost.jsx'
import Overview from './views/Overview.jsx'
import Feed from './views/Feed.jsx'
import Ask from './views/Ask.jsx'
import Notes from './views/Notes.jsx'
import Graph from './views/Graph.jsx'

const NAV = [
  { id: 'overview', icon: '◈', label: '总览' },
  { id: 'feed', icon: '⇪', label: '投喂素材' },
  { id: 'ask', icon: '◎', label: '提问' },
  { id: 'notes', icon: '✎', label: '笔记' },
  { id: 'graph', icon: '⟡', label: '知识图谱' },
]

/** 页面抽屉：任何入口的 [[链接]]/引用 chip 点击都会打开它 */
function PageDrawer({ pagePath, onClose }) {
  const [content, setContent] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!pagePath) return
    let alive = true
    setContent('')
    setError('')
    api
      .page(pagePath)
      .then((r) => alive && setContent(r.content))
      .catch((e) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [pagePath])

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!pagePath) return null

  // frontmatter 剥离（--- ... ---）
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, '')

  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="页面查看">
        <div className="drawer-head">
          <h2 className="drawer-title">
            {pagePath.split('/').pop()}
            <span className="path">{pagePath}</span>
          </h2>
          <button className="drawer-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="drawer-body">
          {error && <div className="banner banner-danger">读取失败：{error}</div>}
          {!error && !content && (
            <div className="loading-row">
              <span className="spinner" /> 正在加载页面…
            </div>
          )}
          {content && <MarkdownHost text={body} onOpenPage={onClose} />}
        </div>
      </aside>
    </>
  )
}

/** markdown 宿主已拆至 views/MarkdownHost.jsx（避免 App ↔ Overview 循环依赖） */

export default function App() {
  const [view, setView] = useState('overview')
  const [pagePath, setPagePath] = useState(null)

  const openPage = useCallback((p) => setPagePath(p), [])

  const closeDrawer = useCallback((replaceWith) => {
    if (typeof replaceWith === 'string') {
      setPagePath(replaceWith) // 抽屉内跳转
    } else {
      setPagePath(null)
    }
  }, [])

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <div className="brand-logo">P</div>
          <div>
            <div className="brand-name">Potion</div>
            <div className="brand-sub">KNOWLEDGE ENGINE</div>
          </div>
        </div>
        <div className="nav">
          <div className="nav-label">Workspace</div>
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`nav-item ${view === n.id ? 'active' : ''}`}
              onClick={() => setView(n.id)}
            >
              <span className="nav-icon" aria-hidden>{n.icon}</span>
              <span className="nav-text">{n.label}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-footer">local-first · v0.1</div>
      </nav>
      <main className="main">
        {view === 'overview' && <Overview onOpenPage={openPage} go={setView} />}
        {view === 'feed' && <Feed go={setView} onOpenPage={openPage} />}
        {view === 'ask' && <Ask onOpenPage={openPage} />}
        {view === 'notes' && <Notes onOpenPage={openPage} />}
        {view === 'graph' && <Graph onOpenPage={openPage} />}
      </main>
      <PageDrawer pagePath={pagePath} onClose={closeDrawer} />
    </div>
  )
}
