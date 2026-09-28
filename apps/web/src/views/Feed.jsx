import React, { useState, useEffect, useRef } from 'react'
import { api } from '../api.js'

/** 投喂页：贴文本 → 存素材 → 触发两段式摄取 → 展示产物。
 *  反馈设计：busy 状态期间经 SSE（/api/events）实时展示管道阶段（analyze → generate → 闸门/落盘），
 *  并计时；超过阈值提示 LLM 退避重试属正常，避免“黑盒等待”被误判为卡死。 */

const SLOW_HINT_SECONDS = 90 // 超过此秒数追加“慢但正常”的安抚提示

const PHASE_LABEL = { analyze: 'Phase 1/2 · 分析（LLM 流式输出）', generate: 'Phase 2/2 · 生成（LLM 流式输出）' }

export default function Feed({ go, onOpenPage }) {
  const [filename, setFilename] = useState('')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false) // 'save' | 'ingest' | null
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [stage, setStage] = useState(null) // { text, ok } 当前管道阶段描述
  const [elapsed, setElapsed] = useState(0) // busy 以来经过的秒数
  const esRef = useRef(null)

  // ---- 引擎工作台：LLM 原始流式输出（“thinking”显化）----
  const [engine, setEngine] = useState({ analyze: '', generate: '' })
  const [llmMeta, setLlmMeta] = useState({}) // { analyze: { firstByteMs, totalMs }, … }
  const [llmWait, setLlmWait] = useState(null) // { phase, since } 请求已发出但还没收到首个 delta
  const bufRef = useRef({ analyze: '', generate: '' })
  const flushTimerRef = useRef(null)
  const logBoxRef = useRef(null)

  // SSE delta 高频到达：先写入 ref 缓冲，最多 120ms 批量 flush 一次，避免逐 token 重渲染
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

  const canSubmit = filename.trim() && content.trim() && !busy

  // 计时器：busy 期间每秒 +1
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [busy])

  // SSE 阶段订阅：仅 ingest 期间打开，结束即关
  function openStageStream() {
    const es = new EventSource('/api/events')
    esRef.current = es
    const on = (name, fn) => es.addEventListener(name, fn)
    on('analyze:start', () => setStage({ text: 'Phase 1/2 · LLM 正在分析素材（实体 / 概念 / claims 抽取）…' }))
    on('analyze:done', (e) => {
      try {
        const r = JSON.parse(e.data)
        const n = (r.entities?.length ?? 0) + (r.concepts?.length ?? 0)
        setStage({ text: `分析完成：识别出 ${n} 个条目（实体 ${r.entities?.length ?? 0} / 概念 ${r.concepts?.length ?? 0}）` })
      } catch { setStage({ text: 'Phase 1/2 · 分析完成' }) }
    })
    on('generate:start', (e) => {
      const n = (() => { try { return JSON.parse(e.data) } catch { return '' } })()
      setStage({ text: `Phase 2/2 · 正在生成 ${n || ''}个 wiki 页正文（受 RPM 限流，逐页排队）…` })
    })
    on('gate:rejected', () => setStage({ text: '闸门校验中：不合规产出会被拒绝落盘…' }))
    on('generate:done', () => setStage({ text: '闸门校验 → 落盘 → git 提交…' }))
    on('commit', () => setStage({ text: '引擎已完成，正在接收结果…', ok: true }))
    // ---- LLM 原始流式输出（引擎工作台）----
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
        if (buf[phase].length > 24000) buf[phase] = buf[phase].slice(-20000) // 展示窗口封顶
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
    // SSE 断开不影响主请求（会自动重连），静默即可
    es.onerror = () => {}
    return es
  }

  async function submit() {
    setError('')
    setResult(null)
    setStage(null)
    setElapsed(0)
    setEngine({ analyze: '', generate: '' })
    setLlmMeta({})
    setLlmWait(null)
    bufRef.current = { analyze: '', generate: '' }
    const es = openStageStream()
    try {
      setBusy('save')
      setStage({ text: '正在保存素材到 sources/…' })
      await api.addSource(filename.trim(), content)
      setBusy('ingest')
      setStage({ text: 'Phase 1/2 · LLM 正在分析素材（实体 / 概念 / claims 抽取）…' })
      const outcome = await api.ingest(`sources/${filename.trim()}`)
      setResult(outcome)
    } catch (e) {
      setError(e.message)
    } finally {
      es.close()
      esRef.current = null
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      setEngine({ ...bufRef.current }) // 冲刷残余缓冲，完成后仍保留工作台内容供回看
      setBusy(null)
      setStage(null)
      setElapsed(0)
    }
  }

  // 卸载时兜底关闭 SSE
  useEffect(() => () => esRef.current?.close(), [])

  const slow = busy === 'ingest' && elapsed >= SLOW_HINT_SECONDS

  return (
    <div className="page">
      <h1 className="page-title">投喂素材</h1>
      <p className="page-desc">
        粘贴一篇文章或笔记，引擎会两段式消化它：先分析要点，再生成结构化 wiki
        页面（实体 / 概念 / 来源摘要），全程可溯源。
      </p>

      {error && <div className="banner banner-danger">摄取失败：{error}</div>}

      <div className="card">
        <div className="field">
          <label className="field-label" htmlFor="feed-name">素材文件名</label>
          <input
            id="feed-name"
            className="input"
            placeholder="如 karpathy-gist.md"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="feed-content">正文内容</label>
          <textarea
            id="feed-content"
            className="textarea"
            style={{ minHeight: 260 }}
            placeholder="粘贴要消化的内容（markdown / 纯文本）…"
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" disabled={!canSubmit} onClick={submit}>
            {busy && <span className="spinner" style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,0.35)' }} />}
            {busy === 'save' ? '正在保存素材…' : busy === 'ingest' ? '引擎正在消化素材…' : '投喂并消化'}
          </button>
          {busy && stage && (
            <span className="mono" style={{ color: stage.ok ? 'var(--c-accent, #4a9)' : 'var(--c-text-3)' }}>
              {stage.text}
            </span>
          )}
          {busy && (
            <span className="mono" style={{ color: 'var(--c-text-3)' }}>
              已耗时 {elapsed}s
            </span>
          )}
        </div>
        {slow && (
          <div className="banner banner-warning" style={{ marginTop: 12 }}>
            已耗时 {elapsed}s：LLM 管道受 RPM 限流与 429 退避重试影响，耗时数分钟属正常范围；上方阶段未变化也不代表卡死，完成后会自动展示结果（也可稍后到「总览」时间线确认）。
          </div>
        )}
      </div>

      {(engine.analyze || engine.generate || busy === 'ingest') && (
        <div className="card">
          <h3 style={{ fontFamily: 'var(--font-display)', margin: '0 0 8px', fontSize: 16 }}>引擎工作台 · LLM 实时输出</h3>
          <p className="mono" style={{ color: 'var(--c-text-3)', fontSize: '0.75rem', margin: '0 0 12px' }}>
            传输层本就是流式（text_delta 逐 token）；这里把引擎正在生成的内容原样显化。首字等待主要来自网关排队与 RPM 门控。
          </p>
          {busy === 'ingest' && llmWait && Date.now() - llmWait.since > 45000 && (
            <div className="banner banner-warning" style={{ marginBottom: 12 }}>
              「{PHASE_LABEL[llmWait.phase] ?? llmWait.phase}」请求已发出 {Math.round((Date.now() - llmWait.since) / 1000)}s
              未收到首个字节：通常是 LLM 网关排队中，并非卡死，请耐心等待。
            </div>
          )}
          <div
            ref={logBoxRef}
            style={{
              maxHeight: 280,
              overflowY: 'auto',
              background: 'var(--c-bg)',
              border: '1px solid var(--c-border)',
              borderRadius: 8,
              padding: 12,
            }}
          >
            {['analyze', 'generate'].map((phase) =>
              engine[phase] || (busy === 'ingest' && llmWait?.phase === phase) ? (
                <div key={phase} style={{ marginBottom: 12 }}>
                  <div className="mono" style={{ color: 'var(--c-text-3)', fontSize: '0.75rem', marginBottom: 4 }}>
                    ▸ {PHASE_LABEL[phase] ?? phase}
                    {llmMeta[phase]
                      ? ` · 首字 ${((llmMeta[phase].firstByteMs ?? 0) / 1000).toFixed(1)}s · 总计 ${((llmMeta[phase].totalMs ?? 0) / 1000).toFixed(1)}s`
                      : ''}
                    {busy === 'ingest' && !llmMeta[phase] ? ' · 生成中…' : ''}
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      color: 'var(--c-text-2)',
                    }}
                  >
                    {engine[phase] || '（等待首字节…）'}
                    {busy === 'ingest' && !llmMeta[phase] ? '▍' : ''}
                  </pre>
                </div>
              ) : null,
            )}
          </div>
        </div>
      )}

      {result && (
        <div className="card">
          <div className="banner banner-success" style={{ margin: 0 }}>
            摄取完成，产出 {result.writtenPages.length} 个页面，git 提交 {result.commitSha?.slice(0, 7) ?? '未提交'}。
          </div>
          {result.rejections?.length > 0 && (
            <div className="banner banner-warning">
              {result.rejections.length} 条产出未通过闸门校验，已被拒：{result.rejections.map((r) => r.title ?? r.path).join('、')}
            </div>
          )}
          <div className="result-grid">
            <div className="result-item">
              <div className="k">分析 tokens（Phase 1）</div>
              <div className="v">{result.analysisTokens?.input ?? '—'} in / {result.analysisTokens?.output ?? '—'} out</div>
            </div>
            <div className="result-item">
              <div className="k">生成 tokens（Phase 2）</div>
              <div className="v">{result.generationTokens?.input ?? '—'} in / {result.generationTokens?.output ?? '—'} out</div>
            </div>
          </div>
          <h3 style={{ fontFamily: 'var(--font-display)', margin: '24px 0 8px' }}>新页面</h3>
          <div className="page-link-list">
            {result.writtenPages.map((path) => (
              <div key={path} className="page-link" onClick={() => onOpenPage?.(path)}>
                <span className="kind-badge kind-note">NEW</span>
                <strong style={{ fontWeight: 600 }}>{path.split('/').pop().replace(/\.md$/, '')}</strong>
                <span className="path">{path}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 16 }}>
            <button className="btn btn-secondary" onClick={() => go('overview')}>到总览看看</button>
          </div>
        </div>
      )}
    </div>
  )
}
