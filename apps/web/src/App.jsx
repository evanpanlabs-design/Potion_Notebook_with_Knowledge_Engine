import React, { useEffect, useState, useCallback } from 'react'
import { api } from './api.js'
import MarkdownHost from './views/MarkdownHost.jsx'
import Overview from './views/Overview.jsx'
import Ask from './views/Ask.jsx'
import Notes from './views/Notes.jsx'
import Sources from './views/Sources.jsx'
import Graph from './views/Graph.jsx'
import Inbox from './views/Inbox.jsx'
import Review from './views/Review.jsx'
import Settings from './views/Settings.jsx'
import AskOrb from './AskOrb.jsx'
import { NavIcon } from './icons.jsx'
import { useEngineStream, EngineWorkbench } from './engine-stream.jsx'

/** v0.2.2 导航：提问入口改为全局悬浮球，原提问页变为「问答历史」；
 *  顺序调整为 总览 → 笔记 → 知识图谱 → 审核 → 问答历史 ｜ 设置。
 *  v0.2.3 图标：换用用户提供的 iconfont SVG（见 icons.jsx）。
 *  v0.2.5 审核：补上 check-circle-fill SVG。
 *  v0.2.5 新增「素材」页（原始素材层，含 MinerU PDF 解析）。 */
const NAV = [
  { id: 'overview', iconKey: 'overview', icon: '◈', label: '总览' },
  { id: 'notes', iconKey: 'notes', icon: '✎', label: '笔记' },
  { id: 'sources', iconKey: 'sources', icon: '▤', label: '素材' },
  { id: 'graph', iconKey: 'graph', icon: '⟡', label: '知识图谱' },
  { id: 'inbox', iconKey: 'inbox', icon: '✉', label: '收件箱' },
  { id: 'review', iconKey: 'review', icon: '☑', label: '审核' },
  { id: 'ask', iconKey: 'ask', icon: '◎', label: '问答历史' },
  { id: 'settings', iconKey: 'settings', icon: '⚙', label: '设置' },
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

/**
 * 引擎状态灯（侧栏）：处理中呼吸闪烁；点按打开全局流式渲染浮层。
 * 流挂在 App 层，切视图不打断 SSE 订阅——在笔记页消化素材时切去别的页面也能回来看到过程。
 */
function EngineStatus({ stream, open, onToggle }) {
  const busy = stream.busy
  const hasOutput = !!(stream.engine.analyze || stream.engine.generate)
  const state = busy ? 'busy' : hasOutput ? 'done' : 'idle'
  const label = busy ? `引擎处理中 ${stream.elapsed}s` : hasOutput ? '引擎输出' : '引擎空闲'
  return (
    <button
      className={`engine-status ${state} ${open ? 'active' : ''}`}
      onClick={onToggle}
      title={busy ? '引擎正在处理（LLM 两段式消化）——点按查看实时输出' : '点按查看引擎实时输出'}
    >
      <span className={`engine-dot ${state}`} />
      <span className="engine-status-label">{label}</span>
    </button>
  )
}

/** 全局引擎浮层：流式渲染器（与 Feed 时代的引擎工作台同一套渲染） */
function EnginePanel({ stream, onClose }) {
  const { stage, elapsed, busy } = stream
  return (
    <aside className="engine-panel" role="dialog" aria-label="引擎实时输出">
      <div className="engine-panel-head">
        <span className="engine-dot busy" />
        <span className="engine-panel-title mono">
          引擎工作台{busy ? ` · 处理中 ${elapsed}s` : ''}
        </span>
        {stage?.text && (
          <span className="mono" style={{ color: 'var(--c-text-3)', fontSize: '0.75rem', marginLeft: 8 }}>
            {stage.text}
          </span>
        )}
        <button className="drawer-close" onClick={onClose} aria-label="关闭">✕</button>
      </div>
      <div className="engine-panel-body">
        {busy ? (
          <EngineWorkbench stream={stream} active />
        ) : stream.engine.analyze || stream.engine.generate ? (
          <EngineWorkbench stream={stream} active />
        ) : (
          <div className="mono" style={{ color: 'var(--c-text-3)', padding: 16 }}>
            引擎当前空闲。在「笔记」页写笔记并「同步到知识库」、或用左侧「导入素材」把一份材料喂给引擎，
            处理时的 LLM 实时输出会在这里流式展示。
          </div>
        )}
      </div>
    </aside>
  )
}

/** markdown 宿主已拆至 views/MarkdownHost.jsx（避免 App ↔ Overview 循环依赖） */

export default function App() {
  const [view, setView] = useState('overview')
  const [pagePath, setPagePath] = useState(null)
  const [engineOpen, setEngineOpen] = useState(false)
  const stream = useEngineStream()

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

  // 引擎开始干活时自动弹出浮层（也可手动开合）
  useEffect(() => {
    if (stream.busy) setEngineOpen(true)
  }, [stream.busy])

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
              <span className="nav-icon" aria-hidden>{n.iconKey ? <NavIcon name={n.iconKey} /> : n.icon}</span>
              <span className="nav-text">{n.label}</span>
            </button>
          ))}
        </div>
        <EngineStatus stream={stream} open={engineOpen} onToggle={() => setEngineOpen((o) => !o)} />
        <div className="sidebar-footer">local-first · v0.1</div>
      </nav>
      <main className="main">
        {view === 'overview' && <Overview onOpenPage={openPage} go={switchView} />}
        {view === 'ask' && <Ask onOpenPage={openPage} />}
        {view === 'notes' && <Notes onOpenPage={openPage} stream={stream} />}
{view === 'sources' && <Sources onOpenPage={openPage} go={switchView} stream={stream} />}
        {view === 'graph' && <Graph onOpenPage={openPage} />}
        {view === 'inbox' && <Inbox onOpenPage={openPage} go={switchView} />}
        {view === 'review' && <Review />}
        {view === 'settings' && <Settings />}
      </main>
      {engineOpen && <EnginePanel stream={stream} onClose={() => setEngineOpen(false)} />}
      <PageDrawer pagePath={pagePath} onClose={closeDrawer} />
      {/* 全局悬浮球提问：常驻所有视图之上（v0.2.2） */}
      <AskOrb onOpenPage={openPage} />
    </div>
  )
}
