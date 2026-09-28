import React, { useEffect, useState, useCallback } from 'react'
import { api } from './api.js'
import MarkdownHost from './views/MarkdownHost.jsx'
import Overview from './views/Overview.jsx'
import Feed from './views/Feed.jsx'
import Ask from './views/Ask.jsx'
import Notes from './views/Notes.jsx'
import Graph from './views/Graph.jsx'
import Review from './views/Review.jsx'
import Settings from './views/Settings.jsx'

const NAV = [
  { id: 'overview', icon: '◈', label: '总览' },
  { id: 'feed', icon: '⇪', label: '投喂素材' },
  { id: 'ask', icon: '◎', label: '提问' },
  { id: 'notes', icon: '✎', label: '笔记' },
  { id: 'review', icon: '☑', label: '审核' },
  { id: 'graph', icon: '⟡', label: '知识图谱' },
  { id: 'settings', icon: '⚙', label: '设置' },
]

/** 路径 → 短标题（wiki/concepts/知识复利.md → 知识复利） */
function pretty(p) {
  return p.split('/').pop().replace(/\.md$/, '')
}

/** 页面抽屉：任何入口的 [[链接]]/引用 chip 点击都会打开它 */
function PageDrawer({ pagePath, onClose }) {
  const [content, setContent] = useState('')
  const [error, setError] = useState('')
  const [backlinks, setBacklinks] = useState([])

  useEffect(() => {
    if (!pagePath) return
    let alive = true
    setContent('')
    setError('')
    setBacklinks([])
    api
      .page(pagePath)
      .then((r) => alive && setContent(r.content))
      .catch((e) => alive && setError(e.message))
    // 反向链接：graph edges 中 target === 当前页的 source 列表
    api
      .graph()
      .then((g) => {
        if (!alive) return
        setBacklinks(g.edges.filter((e) => e.target === pagePath).map((e) => e.source))
      })
      .catch(() => {})
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
          {content && (
            <div className="backlinks">
              <h4>反向链接 · 被哪些页面引用</h4>
              {backlinks.length === 0 ? (
                <span className="backlink-empty">暂无 —— 在其它页面里用 [[本页标题]] 引用它，这里就会亮起来。</span>
              ) : (
                backlinks.map((p) => (
                  <button key={p} className="backlink-item" onClick={() => onClose(p)}>
                    ↩ {pretty(p)}
                  </button>
                ))
              )}
            </div>
          )}
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

  /** D12-13 修复：笔记有未保存修改时，切视图先 confirm（防内容静默丢失） */
  const switchView = useCallback((v) => {
    if (window.__potionNoteDirty && !window.confirm('笔记有未保存的修改，离开将丢失。仍要离开？')) return
    setView(v)
  }, [])

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
              onClick={() => switchView(n.id)}
            >
              <span className="nav-icon" aria-hidden>{n.icon}</span>
              <span className="nav-text">{n.label}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-footer">local-first · v0.1</div>
      </nav>
      <main className="main">
        {view === 'overview' && <Overview onOpenPage={openPage} go={switchView} />}
        {view === 'feed' && <Feed go={switchView} onOpenPage={openPage} />}
        {view === 'ask' && <Ask onOpenPage={openPage} />}
        {view === 'notes' && <Notes onOpenPage={openPage} />}
        {view === 'graph' && <Graph onOpenPage={openPage} />}
        {view === 'review' && <Review />}
{view === 'settings' && <Settings />}
      </main>
      <PageDrawer pagePath={pagePath} onClose={closeDrawer} />
    </div>
  )
}
