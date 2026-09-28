import React, { useState } from 'react'
import { api } from '../api.js'
import MarkdownHost from './MarkdownHost.jsx'
import MiniGraph from '../MiniGraph.jsx'

/** 提问页：问知识库 → 带引用回答，无依据明说（零幻觉承诺的 UI 面）。
 *  v0.2：回答完成后可展开「关联知识图谱」——引用页为种子 + 一跳邻居的局部子图。 */
export default function Ask({ onOpenPage }) {
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [outcome, setOutcome] = useState(null)
  const [subGraph, setSubGraph] = useState(null) // 局部子图数据 {nodes,edges,seeds}
  const [subLoading, setSubLoading] = useState(false)
  const [subError, setSubError] = useState('')

  async function ask() {
    if (!question.trim() || busy) return
    setError('')
    setOutcome(null)
    setSubGraph(null)
    setSubError('')
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

  // 拉取问答涉及的局部子图（种子 = 命中页面路径）
  async function loadSubGraph() {
    if (subGraph || subLoading || !outcome?.citedPages?.length) return
    setSubLoading(true)
    setSubError('')
    try {
      const g = await api.graphSub(outcome.citedPages.map((p) => p.path))
      setSubGraph(g)
    } catch (e) {
      setSubError(e.message)
    } finally {
      setSubLoading(false)
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

          {/* 关联知识图谱：引用页为种子的局部子图（v0.2 第 5 条） */}
          {outcome.citedPages?.length > 0 && !subGraph && (
            <div className="subgraph-trigger">
              <button className="btn btn-secondary" disabled={subLoading} onClick={loadSubGraph}>
                {subLoading ? <span className="spinner" /> : '✦'} {subLoading ? '正在构建局部子图…' : '✦ 关联知识图谱'}
              </button>
              {subError && <span className="mono" style={{ color: 'var(--c-danger, #c66)' }}>加载失败：{subError}</span>}
            </div>
          )}
          {subGraph && (
            <div className="card">
              <h3 style={{ fontFamily: 'var(--font-display)', margin: '0 0 8px', fontSize: '1rem' }}>
                关联知识图谱 · 引用页 + 一跳邻居
              </h3>
              <MiniGraph data={subGraph} onOpenPage={onOpenPage} />
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
