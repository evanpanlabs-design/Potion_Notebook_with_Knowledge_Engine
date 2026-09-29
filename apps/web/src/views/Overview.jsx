import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import MarkdownHost from './MarkdownHost.jsx'

/** 总览页：库状态统计 + index 目录（库的门面 index.md 五段目录渲染） */
export default function Overview({ onOpenPage, go }) {
  const [status, setStatus] = useState(null)
  const [indexPage, setIndexPage] = useState(null)
  const [logEntries, setLogEntries] = useState([])
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    api
      .status()
      .then((s) => alive && setStatus(s))
      .catch((e) => alive && setError(e.message))
    api
      .page('index.md')
      .then((p) => alive && setIndexPage(p.content))
      .catch(() => {} /* 库未初始化时无 index.md，静默 */)
    api
      .log()
      .then((r) => alive && setLogEntries(r.entries.slice(0, 8)))
      .catch(() => {} /* log.md 不存在时静默 */)
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="page">
      <h1 className="page-title">总览</h1>
      <p className="page-desc">你的知识库当前状态与目录。</p>

      {error && <div className="banner banner-danger">无法连接知识引擎服务：{error}</div>}

      <div className="stat-row">
        <div className="stat-card tint-primary">
          <div className="stat-value">{status ? status.pages : '—'}</div>
          <div className="stat-label">Wiki 页面</div>
        </div>
        <div className="stat-card tint-secondary">
          <div className="stat-value">{status ? status.sources : '—'}</div>
          <div className="stat-label">投喂素材</div>
        </div>
        <div className="stat-card tint-success">
          <div className="stat-value">{status ? status.reviewed : '—'}</div>
          <div className="stat-label">已审阅页面</div>
        </div>
      </div>

      {!error && !status && (
        <div className="loading-row">
          <span className="spinner" /> 正在读取库状态…
        </div>
      )}

      {status && status.pages === 0 && (
        <div className="empty-state">
          知识库还是空的。去
          <button className="btn btn-sm btn-primary" style={{ margin: '0 8px' }} onClick={() => go('notes')}>
            笔记页导入素材
          </button>
          或写一篇笔记并「同步到知识库」，引擎会把它消化成结构化 wiki 页面。
        </div>
      )}

      {logEntries.length > 0 && (
        <section className="card">
          <h3 className="doc-label">最近动态 · log.md 流水</h3>
          <div className="timeline">
            {logEntries.map((e, i) => (
              <div key={`${e.ts}-${i}`} className="timeline-row">
                <span className={`op-badge op-${e.op}`}>{e.op}</span>
                <span className="timeline-title">{e.title}</span>
                <span className="timeline-ts">{e.ts}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {status?.pages > 0 && indexPage && (
        <section className="card">
          <h3 className="doc-label">库目录 · index.md</h3>
          <IndexBody text={indexPage} onOpenPage={onOpenPage} />
        </section>
      )}
    </div>
  )
}

/** index.md 渲染：wikilink 可点击 */
function IndexBody({ text, onOpenPage }) {
  return <MarkdownHost text={text} onOpenPage={onOpenPage} />
}
