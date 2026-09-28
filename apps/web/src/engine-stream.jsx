import { useEffect, useRef, useState, useCallback } from 'react'

/**
 * 引擎工作台 hook（v0.2 从 Feed.jsx 抽出共用）：
 * 订阅 /api/events SSE，缓冲 llm:delta 高频事件（120ms 批量 flush），
 * 暴露 { engine, stage, llmWait, llmMeta, open, close, reset }。
 * Feed / Notes 的「投喂消化」「同步到知识库」共用同一条流式展示通道。
 */

export const SLOW_HINT_SECONDS = 90

export const PHASE_LABEL = {
  analyze: 'Phase 1/2 · 分析（LLM 流式输出）',
  generate: 'Phase 2/2 · 生成（LLM 流式输出）',
}

export function useEngineStream() {
  const [engine, setEngine] = useState({ analyze: '', generate: '' })
  const [stage, setStage] = useState(null) // { text, ok }
  const [llmMeta, setLlmMeta] = useState({})
  const [llmWait, setLlmWait] = useState(null)
  const [elapsed, setElapsed] = useState(0)
  const [busy, setBusy] = useState(false)
  const bufRef = useRef({ analyze: '', generate: '' })
  const flushTimerRef = useRef(null)
  const esRef = useRef(null)
  const logBoxRef = useRef(null)

  function scheduleFlush() {
    if (flushTimerRef.current) return
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null
      setEngine({ ...bufRef.current })
    }, 120)
  }

  // 流式输出自动滚到底部
  useEffect(() => {
    const el = logBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [engine])

  // 计时器
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [busy])

  const close = useCallback(function closeStream() {
    esRef.current?.close()
    esRef.current = null
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
  }, [])

  const open = useCallback(function openStageStream() {
    close()
    const es = new EventSource('/api/events')
    esRef.current = es
    const on = (name, fn) => es.addEventListener(name, fn)
    on('analyze:start', () => setStage({ text: 'Phase 1/2 · LLM 正在分析素材（实体 / 概念 / claims 抽取）…' }))
    on('analyze:done', (e) => {
      try {
        const r = JSON.parse(e.data)
        const n = (r.entities?.length ?? 0) + (r.concepts?.length ?? 0) + (r.updates?.length ?? 0)
        setStage({ text: n ? `分析完成：涉及 ${n} 个条目` : '分析完成' })
      } catch { setStage({ text: 'Phase 1/2 · 分析完成' }) }
    })
    on('generate:start', () => {
      setStage({ text: 'Phase 2/2 · 正在生成/维护 wiki 页（受 RPM 限流，逐页排队）…' })
    })
    on('gate:rejected', () => setStage({ text: '闸门校验中：不合规产出会被拒绝落盘…' }))
    on('generate:done', () => setStage({ text: '闸门校验 → 落盘 → git 提交…' }))
    on('commit', () => setStage({ text: '引擎已完成，正在接收结果…', ok: true }))
    on('llm:start', (e) => {
      try {
        const { phase } = JSON.parse(e.data)
        if (phase) setLlmWait({ phase, since: Date.now() })
      } catch { /* 忽略畸形事件 */ }
    })
    on('llm:delta', (e) => {
      try {
        const { phase, delta } = JSON.parse(e.data)
        if (!phase || !delta) return
        setLlmWait((w) => (w && w.phase === phase ? null : w))
        const buf = bufRef.current
        buf[phase] = (buf[phase] ?? '') + delta
        if (buf[phase].length > 24000) buf[phase] = buf[phase].slice(-20000)
        scheduleFlush()
      } catch { /* 忽略畸形事件 */ }
    })
    on('llm:done', (e) => {
      try {
        const { phase, firstByteMs, totalMs } = JSON.parse(e.data)
        if (!phase) return
        setLlmWait((w) => (w && w.phase === phase ? null : w))
        setLlmMeta((m) => ({ ...m, [phase]: { firstByteMs, totalMs } }))
      } catch { /* 忽略畸形事件 */ }
    })
    es.onerror = () => {} // 断开不影响主请求（自动重连）
    return es
  }, [close])

  const reset = useCallback(function resetStream() {
    setEngine({ analyze: '', generate: '' })
    setStage(null)
    setLlmMeta({})
    setLlmWait(null)
    setElapsed(0)
    bufRef.current = { analyze: '', generate: '' }
  }, [])

  const begin = useCallback(function beginStream() {
    reset()
    setBusy(true)
    open()
  }, [open, reset])

  const end = useCallback(function endStream() {
    close()
    // 冲刷残余缓冲，完成后保留工作台内容供回看
    setEngine({ ...bufRef.current })
    setBusy(false)
    setStage(null)
    setElapsed(0)
  }, [close])

  // 卸载兜底
  useEffect(() => () => close(), [close])

  return { engine, stage, llmMeta, llmWait, elapsed, busy, logBoxRef, begin, end, reset }
}

/** 引擎工作台展示面板（Feed/Notes 共用渲染） */
export function EngineWorkbench({ stream, active }) {
  const { engine, llmMeta, llmWait, busy, logBoxRef } = stream
  const show = engine.analyze || engine.generate || active
  if (!show) return null
  return (
    <div className="card">
      <h3 style={{ fontFamily: 'var(--font-display)', margin: '0 0 8px', fontSize: 16 }}>引擎工作台 · LLM 实时输出</h3>
      <p className="mono" style={{ color: 'var(--c-text-3)', fontSize: '0.75rem', margin: '0 0 12px' }}>
        传输层本就是流式（text_delta 逐 token）；这里把引擎正在生成的内容原样显化。首字等待主要来自网关排队与 RPM 门控。
      </p>
      {busy && llmWait && Date.now() - llmWait.since > 45000 && (
        <div className="banner banner-warning" style={{ marginBottom: 12 }}>
          「{PHASE_LABEL[llmWait.phase] ?? llmWait.phase}」请求已发出 {Math.round((Date.now() - llmWait.since) / 1000)}s
          未收到首个字节：通常是 LLM 网关排队中，并非卡死，请耐心等待。
        </div>
      )}
      <div ref={logBoxRef} className="engine-logbox">
        {['analyze', 'generate'].map((phase) =>
          engine[phase] || (busy && llmWait?.phase === phase) ? (
            <div key={phase} style={{ marginBottom: 12 }}>
              <div className="mono engine-phase-label">
                ▸ {PHASE_LABEL[phase] ?? phase}
                {llmMeta[phase]
                  ? ` · 首字 ${((llmMeta[phase].firstByteMs ?? 0) / 1000).toFixed(1)}s · 总计 ${((llmMeta[phase].totalMs ?? 0) / 1000).toFixed(1)}s`
                  : ''}
                {busy && !llmMeta[phase] ? ' · 生成中…' : ''}
              </div>
              <pre className="engine-stream-pre">
                {engine[phase] || '（等待首字节…）'}
                {busy && !llmMeta[phase] ? '▍' : ''}
              </pre>
            </div>
          ) : null,
        )}
      </div>
    </div>
  )
}
