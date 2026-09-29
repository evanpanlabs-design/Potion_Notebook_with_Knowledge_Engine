import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import MarkdownHost from './MarkdownHost.jsx'

/**
 * 问答历史（v0.2.2）：提问入口已改为右下角全局悬浮球（AskOrb），
 * 本页只陈列归档的问答（wiki/queries/，30 天 TTL 到期自动遗忘）。
 * 点开一条回看完整 Q&A（带引用 [[链接]] 可跳页面抽屉）。
 */
export default function Ask({ onOpenPage }) {
  const [items, setItems] = useState(null)
  const [detail, setDetail] = useState(null) // { item, content }
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const r = await api.queries()
      setItems(r.queries)
    } catch (e) {
      setError(e.message)
      setItems([])
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function openItem(item) {
    if (detail?.item.path === item.path) {
      setDetail(null)
      return
    }
    setLoading(true)
    setError('')
    try {
      const r = await api.page(item.path)
      setDetail({ item, content: r.content })
    } catch (e) {
      setError(`读取问答失败：${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  // 归档页正文已含 Q/A 结构（## Q / ## A），剥掉 frontmatter 直接渲染
  const detailBody = detail ? detail.content.replace(/^---\n[\s\S]*?\n---\n/, '') : ''

  // 剩余有效期（天）
  const daysLeft = (expiresAt) => {
    if (!expiresAt) return null
    const t = Date.parse(expiresAt) - Date.now()
    return Math.max(0, Math.ceil(t / 24 / 60 / 60 / 1000))
  }

  return (
    <div className="page">
      <h1 className="page-title">问答历史</h1>
      <p className="page-desc">
        你与知识库的问答记录都在这里（新在前）。提问入口在右下角的 ✦ 悬浮球——任何页面都能随手问。
        记录保留 30 天后自动遗忘，避免一次性问答沉淀为永久知识。
      </p>

      {error && <div className="banner banner-danger">{error}</div>}
      {items === null && !error && (
        <div className="loading-row">
          <span className="spinner" /> 正在读取问答历史…
        </div>
      )}

      {items?.length === 0 && (
        <div className="empty-state">
          还没有问答记录。点击右下角的
          <span className="ask-orb-inline-hint">✦</span>
          悬浮球向知识库提问，问答会自动归档到这里。
        </div>
      )}

      {items?.length > 0 && (
        <div className="history-list">
          {items.map((it) => {
            const left = daysLeft(it.expiresAt)
            const open = detail?.item.path === it.path
            return (
              <div key={it.path} className={`history-item card ${open ? 'open' : ''}`}>
                <button className="history-head" onClick={() => openItem(it)}>
                  <span className="history-q">{it.question || '(无问题文本)'}</span>
                  <span className="history-meta mono">
                    {it.createdAt.slice(0, 16).replace('T', ' ')}
                    {left !== null && ` · 剩 ${left} 天`}
                  </span>
                </button>
                {open && (
                  <div className="history-body">
                    {loading && !detail && (
                      <div className="loading-row">
                        <span className="spinner" /> 正在加载问答内容…
                      </div>
                    )}
                    {detail && <MarkdownHost text={detailBody} onOpenPage={onOpenPage} />}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
