import React, { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import MarkdownHost from './views/MarkdownHost.jsx'
import MiniGraph from './MiniGraph.jsx'

/**
 * v0.2.2 全局悬浮球提问：
 *  - 右下角悬浮球常驻所有视图之上（z-index 高于抽屉/引擎浮层/导入弹窗）；
 *  - 点开是输入框，Enter 发送后展开为悬浮窗，AI 回答流式渲染
 *    （server 在 query 管道广播 query:start / query:delta，经 SSE 到这里逐 token 上屏）；
 *  - 回答完成后展示引用页 chip + 局部子图（种子 = 命中页），问答自动归档，
 *    可到「问答历史」页回看（30 天 TTL 自动遗忘）。
 *  - 本地单用户：同一时刻只允许一次提问（发送期间输入禁用）。
 */
export default function AskOrb({ onOpenPage }) {
  const [mode, setMode] = useState('ball') // ball | input | window
  const [question, setQuestion] = useState('')
  const [currentQ, setCurrentQ] = useState('')
  const [streamText, setStreamText] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState(null)
  const [subGraph, setSubGraph] = useState(null)
  const [error, setError] = useState('')
  const inputRef = useRef(null)
  const bodyRef = useRef(null)
  const esRef = useRef(null)
  const bufRef = useRef('')
  const flushRef = useRef(null)
  const doneRef = useRef(false) // POST 返回后不再接受迟到的 delta（避免覆盖归一化后的最终稿）

  // SSE 订阅：问答流式通道（独立于引擎 ingest 的 llm:delta 相位）
  useEffect(() => {
    const es = new EventSource('/api/events')
    esRef.current = es
    const flush = () => {
      flushRef.current = null
      if (!doneRef.current) setStreamText(bufRef.current)
    }
    es.addEventListener('query:start', () => {
      bufRef.current = ''
      if (!doneRef.current) setStreamText('')
    })
    es.addEventListener('query:delta', (e) => {
      try {
        const { delta } = JSON.parse(e.data)
        if (!delta || doneRef.current) return
        bufRef.current += delta
        if (!flushRef.current) flushRef.current = setTimeout(flush, 120)
      } catch { /* 忽略畸形事件 */ }
    })
    return () => {
      es.close()
      if (flushRef.current) clearTimeout(flushRef.current)
    }
  }, [])

  // 输入态自动聚焦
  useEffect(() => {
    if (mode === 'input') inputRef.current?.focus()
  }, [mode])

  // 流式/新回答时自动滚底
  useEffect(() => {
    const el = bodyRef.current
    if (el && busy) el.scrollTop = el.scrollHeight
  }, [streamText, busy])

  // Escape 收起；点击悬浮球/输入框/悬浮窗以外区域也收起（聊天 widget 惯例）
  useEffect(() => {
    if (mode === 'ball') return
    const onKey = (e) => {
      if (e.key === 'Escape') setMode('ball')
    }
    const onDown = (e) => {
      if (e.target.closest?.('.ask-orb, .ask-orb-input, .ask-orb-window')) return
      setMode('ball')
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [mode])

  async function send() {
    const q = question.trim()
    if (!q || busy) return
    setError('')
    setOutcome(null)
    setSubGraph(null)
    setCurrentQ(q)
    setQuestion('')
    bufRef.current = ''
    setStreamText('')
    doneRef.current = false
    setBusy(true)
    setMode('window')
    try {
      const r = await api.query(q)
      doneRef.current = true
      setOutcome(r)
      // 用引用归一化后的最终稿覆盖流式缓冲（[[标题]](path) 已补全 path）
      setStreamText(r.answer)
      if (r.citedPages?.length) {
        api
          .graphSub(r.citedPages.map((p) => p.path))
          .then((g) => setSubGraph(g))
          .catch(() => {})
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  function reset() {
    setMode('ball')
    setQuestion('')
    setCurrentQ('')
    setStreamText('')
    setOutcome(null)
    setSubGraph(null)
    setError('')
    setBusy(false)
    doneRef.current = true
  }

  // ---- 悬浮球：有内容时点球回到窗口，否则展开输入框 ----
  if (mode === 'ball') {
    return (
      <button
        className="ask-orb"
        onClick={() => setMode(outcome || streamText ? 'window' : 'input')}
        title={outcome || streamText ? '回到上一条问答' : '向知识库提问'}
        aria-label="向知识库提问"
      >
        ✦
      </button>
    )
  }

  // ---- 输入态 ----
  if (mode === 'input') {
    return (
      <div className="ask-orb-input" role="dialog" aria-label="向知识库提问">
        <button className="ask-orb-collapse" title="收起" aria-label="收起" onClick={() => setMode('ball')}>
          —
        </button>
        <textarea
          ref={inputRef}
          className="textarea"
          style={{ minHeight: 64, resize: 'vertical' }}
          placeholder="问知识库一个问题，如：知识复利的核心机制是什么？"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <div className="ask-orb-input-foot">
          <span className="mono">Enter 发送 · Esc 收起</span>
          <button className="btn btn-primary btn-sm" disabled={!question.trim() || busy} onClick={send}>
            发送
          </button>
        </div>
      </div>
    )
  }

  // ---- 悬浮窗：问答进行中 / 已完成 ----
  return (
    <div className="ask-orb-window" role="dialog" aria-label="知识库问答">
      <div className="ask-orb-head">
        <span className={`ask-orb-dot ${busy ? 'busy' : ''}`} />
        <strong>知识库问答</strong>
        <span className="mono ask-orb-head-status">{busy ? '回答生成中…' : outcome ? '完成' : ''}</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" title="收起（保留本次问答）" onClick={() => setMode('ball')}>—</button>
        <button className="icon-btn" title="关闭" onClick={reset}>✕</button>
      </div>
      <div className="ask-orb-body" ref={bodyRef}>
        <div className="ask-orb-q">{currentQ}</div>
        {error && <div className="banner banner-danger">查询失败：{error}</div>}
        {outcome?.noEvidence ? (
          <div className="banner banner-warning">
            库内没有回答这个问题所需的依据。引擎不会编造——到「笔记」页导入相关素材后再来问。
          </div>
        ) : (
          streamText && (
            <div className="card ask-orb-answer">
              <MarkdownHost text={streamText} onOpenPage={onOpenPage} />
              {busy && <span className="ask-orb-caret">▍</span>}
            </div>
          )
        )}
        {busy && !streamText && (
          <div className="loading-row">
            <span className="spinner" /> 词法匹配 → 图扩展 → 组装上下文 → 生成回答…
          </div>
        )}
        {outcome && !outcome.noEvidence && outcome.citedPages?.length > 0 && (
          <div className="cite-chips">
            {outcome.citedPages.map((p) => (
              <button key={p.path} className="cite-chip" onClick={() => onOpenPage?.(p.path)}>
                {p.title.includes('/') ? p.title.split('/').pop().replace(/\.md$/, '') : p.title}
                <span className="score">{p.score?.toFixed?.(1) ?? p.score}</span>
              </button>
            ))}
          </div>
        )}
        {subGraph && (
          <div className="card">
            <h3 style={{ fontFamily: 'var(--font-display)', margin: '0 0 8px', fontSize: '1rem' }}>
              关联知识图谱 · 引用页 + 一跳邻居
            </h3>
            <MiniGraph data={subGraph} onOpenPage={onOpenPage} height={240} />
          </div>
        )}
        {outcome?.archivePath && (
          <div className="mono ask-orb-archive">已归档 {outcome.archivePath}（30 天后自动遗忘）</div>
        )}
      </div>
      <div className="ask-orb-foot">
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder="继续提问…"
          value={question}
          disabled={busy}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
        />
        <button className="btn btn-primary" disabled={busy || !question.trim()} onClick={send}>
          发送
        </button>
      </div>
    </div>
  )
}
