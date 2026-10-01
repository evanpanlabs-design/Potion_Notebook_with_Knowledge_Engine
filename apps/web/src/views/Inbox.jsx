import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import MarkdownHost from './MarkdownHost.jsx'

/**
 * 收件箱（v0.3 D4-5）：定时任务的产出落点。
 * - inbox/ 不进知识图谱（scanKb 不扫它）——收件箱只是「待处理的素材流」
 * - 每封 = 一次定时任务的日报：主题 / 生成时间 / 来源数 / 综合预览
 * - 「消化进图谱」= 把证据页（sources/inbox-*.md）走既有 ingest 管线，
 *   产物进审核队列（AI 生成页默认待审的老规矩不变）
 */
export default function Inbox({ onOpenPage, go }) {
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')
  const [openPath, setOpenPath] = useState(null)
  const [openContent, setOpenContent] = useState('')
  const [busy, setBusy] = useState('')
  const [digestNote, setDigestNote] = useState('')

  useEffect(() => {
    let alive = true
    api
      .listInbox()
      .then((r) => alive && setItems(r.items))
      .catch((e) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [])

  async function toggleOpen(it) {
    if (openPath === it.path) {
      setOpenPath(null)
      return
    }
    setOpenPath(it.path)
    setOpenContent('')
    setDigestNote('')
    try {
      const r = await api.readInbox(it.path)
      setOpenContent(r.content)
    } catch (e) {
      setOpenContent(`> 读取失败：${e.message}`)
    }
  }

  async function digest(it) {
    if (busy) return
    setBusy(it.path)
    setDigestNote('')
    try {
      const r = await api.digestInbox(it.path)
      setDigestNote(r.digestOutcome || (r.ok ? '已消化' : '消化失败'))
      setItems((xs) => xs.map((x) => (x.path === it.path ? { ...x, digested: r.ok, digestOutcome: r.digestOutcome } : x)))
    } catch (e) {
      setDigestNote(`消化失败：${e.message}`)
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="page page-wide">
      <h1 className="page-title">收件箱</h1>
      <p className="page-desc">
        定时任务的产出落在这里（AI 日报、补跑快报）。收件箱内容不进知识图谱——点「消化进图谱」后，
        证据页会走引擎的消化管线生成待审核的 wiki 页面。
      </p>

      {error && <div className="banner banner-danger">无法读取收件箱：{error}</div>}

      {items === null && !error && (
        <div className="loading-row">
          <span className="spinner" /> 正在读取收件箱…
        </div>
      )}

      {items?.length === 0 && (
        <div className="empty-state">
          收件箱是空的。对右下角提问球说一句「每天 7 点帮我搜今天最新 AI 资讯」，
          <button className="btn btn-sm btn-primary" style={{ margin: '0 8px' }} onClick={() => go('overview')}>
            到总览看定时任务
          </button>
          ，AI 产出的日报会自动落到这里。
        </div>
      )}

      {items?.length > 0 && (
        <div className="inbox-list">
          {items.map((it) => {
            const open = openPath === it.path
            return (
              <div key={it.path} className={`card inbox-item ${open ? 'open' : ''}`}>
                <button className="inbox-head" onClick={() => toggleOpen(it)}>
                  <span className={`inbox-dot ${it.digested ? 'digested' : 'unread'}`} title={it.digested ? '已消化' : '未消化'} />
                  <span className="inbox-title">{it.taskTitle || it.title}</span>
                  <span className="inbox-topic">{it.topic}</span>
                  <span className="mono inbox-meta">
                    {it.mode === 'manual' ? '手动' : '定时'} · {(it.generatedAt || '').slice(0, 16).replace('T', ' ')}
                    {it.runner === 'agent'
                      ? ` · agent ${it.turns ?? '?'}轮${it.steps ?? '?'}步`
                      : ` · ${it.sources.length} 来源`}
                  </span>
                  <span className="inbox-chevron">{open ? '▾' : '▸'}</span>
                </button>
                {it.summary && !open && <div className="inbox-preview">{it.summary}</div>}
                {it.digested && <div className="mono inbox-digested">{it.digestOutcome}</div>}
                {open && (
                  <div className="inbox-body">
                    {digestNote && (
                      <div className={`banner ${digestNote.includes('失败') ? 'banner-danger' : 'banner-success'}`}>{digestNote}</div>
                    )}
                    {openContent ? (
                      <MarkdownHost text={openContent} onOpenPage={onOpenPage} />
                    ) : (
                      <div className="loading-row">
                        <span className="spinner" /> 正在读取正文…
                      </div>
                    )}
                    <div className="inbox-actions">
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={busy === it.path || it.digested}
                        onClick={() => digest(it)}
                        title="把证据页交给引擎消化（走审核队列）"
                      >
                        {busy === it.path ? '消化中…' : it.digested ? '已消化' : '⚙ 消化进图谱'}
                      </button>
                      <span className="mono inbox-action-note">
                        {it.evidence ? `证据页：${it.evidence}` : '（无证据页，无法消化）'}
                      </span>
                    </div>
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
