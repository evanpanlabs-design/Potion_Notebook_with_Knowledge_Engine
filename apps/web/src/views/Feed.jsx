import React, { useState } from 'react'
import { api } from '../api.js'

/** 投喂页：贴文本 → 存素材 → 触发两段式摄取 → 展示产物 */
export default function Feed({ go, onOpenPage }) {
  const [filename, setFilename] = useState('')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false) // 'save' | 'ingest' | null
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  const canSubmit = filename.trim() && content.trim() && !busy

  async function submit() {
    setError('')
    setResult(null)
    try {
      setBusy('save')
      await api.addSource(filename.trim(), content)
      setBusy('ingest')
      const outcome = await api.ingest(`sources/${filename.trim()}`)
      setResult(outcome)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

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
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button className="btn btn-primary" disabled={!canSubmit} onClick={submit}>
            {busy === 'save' && <span className="spinner" style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,0.35)' }} />}
            {busy === 'save' ? '正在保存素材…' : busy === 'ingest' ? '引擎正在消化素材（约 1 分钟）…' : '投喂并消化'}
          </button>
          {busy && <span className="mono" style={{ color: 'var(--c-text-3)' }}>{busy === 'save' ? '写入 sources/' : 'LLM 分析 → 生成 → 闸门校验 → 落盘'}</span>}
        </div>
      </div>

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
