import React, { useState } from 'react'
import { api } from '../api.js'
import MarkdownHost from './MarkdownHost.jsx'

/** 提问页：问知识库 → 带引用回答，无依据明说（零幻觉承诺的 UI 面） */
export default function Ask({ onOpenPage }) {
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [outcome, setOutcome] = useState(null)

  async function ask() {
    if (!question.trim() || busy) return
    setError('')
    setOutcome(null)
    setBusy(true)
    try {
      const r = await api.query(question.trim())
      setOutcome(r)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <h1 className="page-title">提问</h1>
      <p className="page-desc">
        只依据你的知识库回答，并标注引用来源。库里没有依据的问题会直接告诉你——不编造。
      </p>

      {error && <div className="banner banner-danger">查询失败：{error}</div>}

      <div className="card">
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label" htmlFor="ask-input">你的问题</label>
          <textarea
            id="ask-input"
            className="textarea"
            style={{ minHeight: 72 }}
            placeholder="如：知识复利的核心机制是什么？"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') ask()
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 16 }}>
          <button className="btn btn-primary" disabled={!question.trim() || busy} onClick={ask}>
            {busy && <span className="spinner" style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,0.35)' }} />}
            {busy ? '正在检索并回答…' : '提问'}
          </button>
          <span className="mono" style={{ color: 'var(--c-text-3)' }}>⌘/Ctrl + Enter</span>
        </div>
      </div>

      {busy && (
        <div className="loading-row" style={{ marginTop: 16 }}>
          <span className="spinner" /> 词法匹配 → 图扩展 → 组装上下文 → 生成回答…
        </div>
      )}

      {outcome && (
        <>
          {outcome.noEvidence ? (
            <div className="banner banner-warning">
              库内没有回答这个问题所需的依据。引擎不会编造——投喂相关素材后再来问。
            </div>
          ) : (
            <div className="card">
              <MarkdownHost text={outcome.answer} onOpenPage={onOpenPage} />
            </div>
          )}

          {outcome.citedPages?.length > 0 && (
            <div className="card">
              <h3 style={{ fontFamily: 'var(--font-display)', margin: '0 0 12px', fontSize: '1rem' }}>
                本次检索命中的页面
              </h3>
              <div className="cite-chips">
                {outcome.citedPages.map((p) => (
                  <button key={p.path} className="cite-chip" onClick={() => onOpenPage(p.path)}>
                    {p.title.includes('/') ? p.title.split('/').pop().replace(/\.md$/, '') : p.title}
                    <span className="score">{p.score?.toFixed?.(1) ?? p.score}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {outcome.archivePath && (
            <div className="mono" style={{ color: 'var(--c-text-3)', marginTop: 8 }}>
              问答已归档：{outcome.archivePath}
            </div>
          )}
        </>
      )}
    </div>
  )
}
