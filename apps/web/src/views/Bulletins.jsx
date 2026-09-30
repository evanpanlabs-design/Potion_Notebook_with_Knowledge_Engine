import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

/**
 * bulletin board（v0.3 D10-11）：用户与 AI 的异步交互便利贴。
 * - 用户留言（directive = 给定时任务的指令；todo/note = 提醒与备忘）
 * - AI 发帖（任务跳过通知、缺数据 request）
 * - 保质期：过期自动转 dropped 归档不删除
 * - 状态流转：open → done / dropped；回复进 thread 并转 replied
 */
const KIND_LABEL = { directive: '指令', todo: '待办', request: 'AI 求助', note: '留言' }
const KIND_HINT = {
  directive: '会在每次定时任务执行前注入（如「日报主题改成财经」）',
  todo: '给自己的提醒',
  request: 'AI 向你要东西（如换 Tavily key）',
  note: '普通留言',
}

export default function Bulletins() {
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [kind, setKind] = useState('directive')
  const [busy, setBusy] = useState(false)
  const [replyDraft, setReplyDraft] = useState({})

  useEffect(() => {
    let alive = true
    api
      .listBulletins()
      .then((r) => alive && setItems(r.bulletins))
      .catch((e) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [])

  async function post() {
    if (busy || !draft.trim()) return
    setBusy(true)
    try {
      await api.createBulletin(draft.trim(), kind)
      setDraft('')
      const r = await api.listBulletins()
      setItems(r.bulletins)
    } catch (e) {
      setError(`发帖失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function setStatus(b, status) {
    if (busy) return
    setBusy(true)
    try {
      await api.setBulletinStatus(b.id, status)
      const r = await api.listBulletins()
      setItems(r.bulletins)
    } catch (e) {
      setError(`状态变更失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function reply(b) {
    const text = (replyDraft[b.id] ?? '').trim()
    if (busy || !text) return
    setBusy(true)
    try {
      await api.replyBulletin(b.id, text)
      setReplyDraft((m) => ({ ...m, [b.id]: '' }))
      const r = await api.listBulletins()
      setItems(r.bulletins)
    } catch (e) {
      setError(`回复失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  const open = (items ?? []).filter((b) => b.status === 'open' || b.status === 'replied')
  const archived = (items ?? []).filter((b) => b.status === 'done' || b.status === 'dropped')

  return (
    <div className="page page-wide">
      <h1 className="page-title">便利贴</h1>
      <p className="page-desc">
        你和 AI 的异步对话面板：留指令（定时任务执行前自动读取）、待办与备忘；
        AI 也会在这里发帖（任务跳过通知、缺数据求助）。过期贴自动归档不删除。
      </p>

      {error && <div className="banner banner-danger">{error}</div>}

      {/* ---- 发帖 ---- */}
      <div className="card bulletin-compose">
        <div className="bulletin-compose-row">
          <select className="input" style={{ width: 110 }} value={kind} onChange={(e) => setKind(e.target.value)} title={KIND_HINT[kind]}>
            <option value="directive">指令</option>
            <option value="todo">待办</option>
            <option value="note">留言</option>
          </select>
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder={kind === 'directive' ? '如：明天日报主题改成财经；日报加上 OpenAI 动态' : '写点什么…'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') post()
            }}
          />
          <button className="btn btn-primary btn-sm" disabled={busy || !draft.trim()} onClick={post}>
            {busy ? '…' : '贴上'}
          </button>
        </div>
        <div className="mono bulletin-kind-hint">{KIND_HINT[kind]} · 7 天保质期</div>
      </div>

      {items === null && !error && (
        <div className="loading-row">
          <span className="spinner" /> 正在读取便利贴…
        </div>
      )}

      {/* ---- 活跃贴 ---- */}
      {open.length > 0 && (
        <div className="bulletin-board">
          {open.map((b) => (
            <BulletinCard key={b.id} b={b} busy={busy} replyDraft={replyDraft[b.id] ?? ''} onReplyDraft={(v) => setReplyDraft((m) => ({ ...m, [b.id]: v }))} onReply={() => reply(b)} onStatus={(s) => setStatus(b, s)} />
          ))}
        </div>
      )}
      {items?.length === 0 && (
        <div className="empty-state">还没有便利贴。上面第一条指令试试——它会影响定时任务的行为。</div>
      )}

      {/* ---- 归档 ---- */}
      {archived.length > 0 && (
        <details className="bulletin-archive">
          <summary className="doc-label">
            归档 · {archived.length} 张（已完成 / 已过期放弃）
          </summary>
          <div className="bulletin-board archived">
            {archived.map((b) => (
              <BulletinCard key={b.id} b={b} busy={busy} archivedView onStatus={(s) => setStatus(b, s)} />
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

function BulletinCard({ b, busy, archivedView, replyDraft = '', onReplyDraft, onReply, onStatus }) {
  const expired = b.status === 'dropped'
  return (
    <div className={`bulletin-card author-${b.author} ${expired ? 'expired' : ''}`}>
      <div className="bulletin-card-head">
        <span className="bulletin-author">{b.author === 'ai' ? '🤖 AI' : '👤 我'}</span>
        <span className={`bulletin-kind kind-${b.kind}`}>{KIND_LABEL[b.kind] ?? b.kind}</span>
        {b.status === 'replied' && <span className="bulletin-status st-replied">已回复</span>}
        {expired && <span className="bulletin-status st-dropped">已过期</span>}
        {b.status === 'done' && <span className="bulletin-status st-done">已完成</span>}
        <span className="mono bulletin-time">{(b.createdAt || '').slice(0, 10)}</span>
      </div>
      <div className="bulletin-text">{b.text}</div>
      {b.thread?.length > 0 && (
        <div className="bulletin-thread">
          {b.thread.map((t, i) => (
            <div key={i} className="bulletin-reply">
              <span className="bulletin-reply-author">{t.author === 'ai' ? 'AI' : '我'}</span>
              <span>{t.text}</span>
            </div>
          ))}
        </div>
      )}
      {!archivedView && (
        <div className="bulletin-actions">
          <input
            className="input input-sm"
            placeholder="回复…"
            value={replyDraft}
            onChange={(e) => onReplyDraft?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onReply?.()
            }}
          />
          <button className="btn btn-ghost btn-sm" disabled={busy || !replyDraft.trim()} onClick={onReply}>
            回复
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn btn-ok btn-sm" disabled={busy} title="标记完成" onClick={() => onStatus('done')}>
            ✓
          </button>
          <button className="btn btn-ghost btn-sm" disabled={busy} title="放弃这张贴" onClick={() => onStatus('dropped')}>
            ✕
          </button>
        </div>
      )}
      {archivedView && b.status === 'dropped' && (
        <div className="bulletin-actions">
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-sm" disabled={busy} title="重新激活" onClick={() => onStatus('open')}>
            重新激活
          </button>
        </div>
      )}
    </div>
  )
}
