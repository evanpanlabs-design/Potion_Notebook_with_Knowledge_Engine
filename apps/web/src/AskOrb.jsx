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
  // 拖拽位置：ball / input / window 三种形态各自记忆（null = 用 CSS 默认右下角）
  const [pos, setPos] = useState({ ball: null, input: null, window: null })
  // v0.3 定时任务意图（ADR-003 D2-3）：解析命中后弹确认卡片，用户确认→建任务
  const [scheduleDraft, setScheduleDraft] = useState(null) // { title, topic, query, schedule, scheduleDesc }
  const [scheduleBusy, setScheduleBusy] = useState(false)
  const [scheduleNote, setScheduleNote] = useState('')

  // ---- 长按拖拽 ----
  // 按下后移动超过 4px 进入拖拽（普通点击不受影响）；拖完的 click 事件被吞掉，
  // 避免球拖到别处又展开输入框。textarea/input/button 上按下不触发拖拽。
  function dragHandlers(key) {
    return {
      onPointerDown: (e) => {
        if (e.button !== 0) return
        // 悬浮球本身是 button，需允许从它开始拖；只排除输入控件和「拖拽根内部的其它按钮」（如标题栏 — ✕）
        const btn = e.target.closest?.('button')
        if (e.target.closest?.('textarea, input') || (btn && btn !== e.currentTarget)) return
        const el = e.currentTarget
        const rect = el.getBoundingClientRect()
        const startX = e.clientX
        const startY = e.clientY
        let moved = false
        const onMove = (ev) => {
          const dx = ev.clientX - startX
          const dy = ev.clientY - startY
          if (!moved && Math.hypot(dx, dy) < 4) return
          moved = true
          const nx = Math.min(Math.max(rect.left + dx, 8), window.innerWidth - rect.width - 8)
          const ny = Math.min(Math.max(rect.top + dy, 8), window.innerHeight - rect.height - 8)
          setPos((p) => ({ ...p, [key]: { x: nx, y: ny } }))
        }
        const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          el.__dragged = moved
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      },
      onClickCapture: (e) => {
        if (e.currentTarget.__dragged) {
          e.currentTarget.__dragged = false
          e.preventDefault()
          e.stopPropagation()
        }
      },
    }
  }
  const styleFor = (key) =>
    pos[key] ? { left: pos[key].x, top: pos[key].y, right: 'auto', bottom: 'auto' } : undefined

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
    // 定时意图识别（ADR-003 §3.2）：「每天 7 点搜 AI 资讯」→ 确认卡片 → cron 任务。
    // 解析失败/非定时意图不拦截提问（降级为普通问答）
    try {
      const p = await api.parseTaskIntent(q).catch(() => null)
      if (p?.isSchedule) {
        setScheduleDraft({
          title: p.title,
          topic: p.topic,
          query: p.query,
          schedule: p.schedule,
          scheduleDesc: p.scheduleDesc,
        })
        setBusy(false)
        return // 不走问答；用户取消后可重新发送
      }
    } catch { /* 解析失败降级为普通问答 */ }
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

  async function confirmSchedule() {
    if (!scheduleDraft || scheduleBusy) return
    setScheduleBusy(true)
    setScheduleNote('')
    try {
      await api.createTask(scheduleDraft)
      setScheduleNote('✓ 已创建定时任务，到点自动运行；错过 24h 内会在下次启动时补做一次')
      setTimeout(() => {
        setScheduleDraft(null)
        setScheduleNote('')
        setMode('ball')
      }, 2000)
    } catch (e) {
      setScheduleNote(`创建失败：${e.message}`)
    } finally {
      setScheduleBusy(false)
    }
  }

  function cancelSchedule() {
    setScheduleDraft(null)
    setScheduleNote('')
    setMode('input')
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
    setScheduleDraft(null)
    setScheduleNote('')
  }

  // ---- 悬浮球：有内容时点球回到窗口，否则展开输入框 ----
  if (mode === 'ball') {
    return (
      <button
        className="ask-orb"
        style={styleFor('ball')}
        {...dragHandlers('ball')}
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
      <div className="ask-orb-input" role="dialog" aria-label="向知识库提问" style={styleFor('input')} {...dragHandlers('input')}>
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
    <div className="ask-orb-window" role="dialog" aria-label="知识库问答" style={styleFor('window')}>
      <div className="ask-orb-head" {...dragHandlers('window')} title="按住拖动窗口">
        <span className={`ask-orb-dot ${busy ? 'busy' : ''}`} />
        <strong>知识库问答</strong>
        <span className="mono ask-orb-head-status">{busy ? '回答生成中…' : outcome ? '完成' : ''}</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" title="收起（保留本次问答）" onClick={() => setMode('ball')}>—</button>
        <button className="icon-btn" title="关闭" onClick={reset}>✕</button>
      </div>
      <div className="ask-orb-body" ref={bodyRef}>
        <div className="ask-orb-q">{currentQ}</div>
        {scheduleDraft && (
          <div className="card ask-orb-schedule">
            <h3 style={{ fontFamily: 'var(--font-display)', margin: '0 0 8px', fontSize: '1rem' }}>
              ⏱ 创建定时任务？
            </h3>
            <p style={{ margin: '0 0 10px', color: 'var(--c-text-2)' }}>
              这不是一次性提问——AI 将<strong>{scheduleDraft.scheduleDesc}</strong>自动执行：
            </p>
            <div className="schedule-draft-rows mono">
              <div>主题：{scheduleDraft.topic}</div>
              <div>排程：{scheduleDraft.scheduleDesc}</div>
              {scheduleDraft.query && <div>搜索词：{scheduleDraft.query}</div>}
              <div>产出：快报自动进入收件箱（不进知识图谱，可手动消化）</div>
            </div>
            <div className="ask-orb-input-foot" style={{ marginTop: 12 }}>
              <span className="mono">{scheduleNote || '确认后 AI 按时自动执行'}</span>
              <span style={{ flex: 1 }} />
              <button className="btn btn-secondary btn-sm" disabled={scheduleBusy} onClick={cancelSchedule}>
                取消，改为普通提问
              </button>
              <button className="btn btn-primary btn-sm" disabled={scheduleBusy} onClick={confirmSchedule}>
                {scheduleBusy ? '创建中…' : '创建任务'}
              </button>
            </div>
          </div>
        )}
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
