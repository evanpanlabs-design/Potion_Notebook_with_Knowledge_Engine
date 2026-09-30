import React, { useEffect, useState, useCallback, useRef } from 'react'
import { api } from '../api.js'
import MarkdownHost from './MarkdownHost.jsx'

/**
 * D10-11 审核页（v0.2）：AI 生成页默认待审，人在把关（Human-in-the-loop）。
 * 三种处置：通过（fm.reviewed=true）/ 驳回删除 / 返修（附修改意见进返修池）。
 * 返修池：攒一批意见后「统一修复」让 LLM 集中执行；修复运行期间新返修暂缓进池（deferred）。
 */
export default function Review() {
  const [queue, setQueue] = useState([])
  const [reviewedCount, setReviewedCount] = useState(0)
  const [maintenanceRunning, setMaintenanceRunning] = useState(false)
  const [sel, setSel] = useState(null) // 当前选中 {path,title,type,updatedAt,rework}
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [flash, setFlash] = useState('')

  // 返修：意见草稿 + 返修池状态 + 批量修复进度
  const [reworkNote, setReworkNote] = useState('')
  // v0.3 D6-7：选中页的 suggestions（audit 维护建议展示）
  const [suggestions, setSuggestions] = useState([])
  const [sugBusy, setSugBusy] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchInfo, setBatchInfo] = useState(null) // {running, processing, done}
  const pollRef = useRef(null)

  const refresh = useCallback(async () => {
    try {
      const r = await api.reviewQueue()
      // 返修中的页置顶：待返修 > 暂缓 > 普通（稳定排序，不改变同优先级内顺序）
      const rank = (p) => (p.rework?.status === 'pending' ? 0 : p.rework?.status === 'deferred' ? 1 : 2)
      const queue = [...r.queue].sort((a, b) => rank(a) - rank(b))
      setQueue(queue)
      setReviewedCount(r.reviewedCount)
      setMaintenanceRunning(!!r.maintenanceRunning)
      return queue
    } catch (e) {
      setError(`读取队列失败：${e.message}`)
      return []
    }
  }, [])

  // 批量修复进度轮询：running 结束后停表并刷新队列
  const watchBatch = useCallback(async () => {
    setBatchBusy(true)
    try {
      while (true) {
        const s = await api.reworkStatus()
        setBatchInfo(s)
        if (!s.running) break
        await new Promise((res) => (pollRef.current = setTimeout(res, 1500)))
      }
      await refresh()
    } catch { /* 轮询失败静默，下次操作会重新同步 */ }
    setBatchBusy(false)
  }, [refresh])

  // v0.2.2 返修池：给过返修意见的条目（待返修 + 暂缓）整体挪进顶部池区块，
  // 待审列表只陈列普通条目；池空时不渲染返修池区块（只看待审清单）
  const pool = queue.filter((p) => p.rework)
  const reworkPool = pool.filter((p) => p.rework.status === 'pending')
  const deferredCount = pool.length - reworkPool.length
  const plainQueue = queue.filter((p) => !p.rework)

  // 初次加载：取队列并选中第一项
  useEffect(() => {
    let alive = true
    refresh().then((q) => {
      if (alive && q.length > 0) setSel(q[0])
    })
    return () => {
      alive = false
    }
  }, [refresh])

  // 选中项变化：拉取页面内容 + 回显已有返修意见 + 解析 suggestions（audit/用户建议）
  useEffect(() => {
    if (!sel) {
      setContent('')
      setReworkNote('')
      setSuggestions([])
      return
    }
    setReworkNote(sel.rework?.note ?? '')
    let alive = true
    setLoading(true)
    setError('')
    api
      .page(sel.path)
      .then((r) => {
        if (!alive) return
        setContent(r.content)
        // frontmatter suggestions[] 展示（v0.3 D6-7 audit / D8-9 用户建议共用）：
        // serializePage 输出形如
        //   suggestions:
        //     - origin: audit
        //       note: 两页都讲 X
        const sug = []
        const fmMatch = r.content.match(/^---\n([\s\S]*?)\n---\n/)
        if (fmMatch) {
          const block = fmMatch[1].match(/^suggestions:((?:\n[ \t]+-.*)*)/m)
          if (block) {
            for (const item of block[1].split('\n-').map((s) => s.trim()).filter(Boolean)) {
              const note = /note:\s*['"]?(.+?)['"]?\s*$/m.exec(item)?.[1] ?? ''
              const origin = /origin:\s*(\w+)/.exec(item)?.[1] ?? 'audit'
              const action = /action:\s*(\w+)/.exec(item)?.[1]
              if (note) sug.push({ note, origin, action })
            }
          }
        }
        setSuggestions(sug)
      })
      .catch((e) => alive && setError(`读取页面失败：${e.message}`))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [sel])

  // D8-9：提交/撤除用户建议（意见统一走 reworkNote 文本框，留言/返修二选一）
  async function submitSuggestion(text) {
    const note = (text ?? '').trim()
    if (!sel || sugBusy || !note) return
    setSugBusy(true)
    try {
      const r = await api.addSuggestion(sel.path, note)
      setSuggestions(r.suggestions ?? [])
      setReworkNote('')
      setFlash('建议已记录：下一轮统一修复会带上它')
      setTimeout(() => setFlash(''), 3000)
    } catch (e) {
      setError(`提交建议失败：${e.message}`)
    } finally {
      setSugBusy(false)
    }
  }

  async function dropSuggestion(index) {
    if (!sel || sugBusy) return
    setSugBusy(true)
    try {
      const r = await api.removeSuggestion(sel.path, index)
      setSuggestions(r.suggestions ?? [])
    } catch (e) {
      setError(`撤除建议失败：${e.message}`)
    } finally {
      setSugBusy(false)
    }
  }

  const act = async (action, note) => {
    if (!sel || busy) return
    setBusy(true)
    setError('')
    try {
      await api.reviewEx(sel.path, action, note)
      setFlash(
        action === 'approve'
          ? `已通过：${sel.title}`
          : action === 'rework'
            ? maintenanceRunning
              ? `返修意见已记录（批量修复进行中，本条暂缓进池）：${sel.title}`
              : `已加入返修池：${sel.title}`
            : `已驳回并删除：${sel.title}`,
      )
      const q = await refresh()
      setSel(q.find((p) => p.path === sel.path) ?? q[0] ?? null)
    } catch (e) {
      setError(`操作失败：${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  const runBatch = async () => {
    if (batchBusy || reworkPool.length === 0) return
    setError('')
    try {
      await api.reworkRun()
      setFlash(`统一修复已启动：${reworkPool.length} 页排队处理，运行期间新返修暂缓进池。`)
      watchBatch()
    } catch (e) {
      setError(`批量修复启动失败：${e.message}`)
    }
  }

  // flash 提示 3.5s 自动消失
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(''), 3500)
    return () => clearTimeout(t)
  }, [flash])

  // 卸载兜底
  useEffect(() => () => pollRef.current && clearTimeout(pollRef.current), [])

  const stripFm = content.replace(/^---\n[\s\S]*?\n---\n/, '')

  return (
    <div className="notes-shell">
      <aside className="notes-pane">
        {/* v0.2.3 侧栏 = 上下两个子栏：上栏返修池（无返修时不渲染），下栏待审核 */}
        {pool.length > 0 && (
        <div className="review-subpanel pool">
          <div className="review-subpanel-head">
            <span className="pane-title">返修池 · {pool.length}</span>
            <button
              className="btn btn-secondary btn-sm"
              disabled={batchBusy || reworkPool.length === 0 || maintenanceRunning}
              onClick={runBatch}
            >
              ⚙ 统一修复
            </button>
          </div>
          {maintenanceRunning && !batchBusy && (
            <div className="rework-pool-hint">批量修复运行中（可能由其他窗口触发），新返修暂缓进池。</div>
          )}
          {batchBusy && batchInfo && (
            <div className="rework-pool-hint running">
              修复中：{batchInfo.processing ?? '…'} · 已完成 {batchInfo.done ?? 0} 页
            </div>
          )}
          {deferredCount > 0 && !batchBusy && (
            <div className="rework-pool-hint">另有 {deferredCount} 条暂缓意见待修复结束后自动回流。</div>
          )}
          <div className="rework-pool-list">
            {pool.map((p) => (
              <button
                key={p.path}
                className={`note-item ${sel?.path === p.path ? 'active' : ''}`}
                onClick={() => setSel(p)}
              >
                <span className="note-title">
                  {p.title}
                  <span className={`rework-tag ${p.rework.status === 'deferred' ? 'deferred' : ''}`}>
                    💬 {p.rework.status === 'deferred' ? '暂缓' : '待返修'}
                  </span>
                </span>
                <span className="note-meta">{p.type} · {p.path}</span>
              </button>
            ))}
          </div>
        </div>
        )}

        <div className="review-subpanel queue">
          <div className="review-subpanel-head">
            <span className="pane-title">待审核 · {plainQueue.length}</span>
          </div>
          <div className="note-list">
            {queue.length === 0 && <div className="review-empty">队列空了 —— AI 生成的页面都已过审 ✅</div>}
            {plainQueue.length === 0 && pool.length > 0 && (
              <div className="review-empty" style={{ padding: '10px 12px', color: 'var(--c-text-3)', fontSize: '0.8125rem' }}>
                其余条目都已给过返修意见，正在返修池中等统一修复。
              </div>
            )}
            {plainQueue.map((p) => (
              <button
                key={p.path}
                className={`note-item ${sel?.path === p.path ? 'active' : ''}`}
                onClick={() => setSel(p)}
              >
                <span className="note-title">{p.title}</span>
                <span className="note-meta">{p.type} · {p.path}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="notes-pane-foot">已过审 {reviewedCount} 页 · 机生页需人把关后才算正式知识</div>
      </aside>

      <section className="notes-main">
        {error && <div className="banner banner-danger">{error}</div>}
        {flash && <div className="banner banner-ok">{flash}</div>}
        {maintenanceRunning && <div className="banner banner-warning">返修批量修复进行中：新返修意见会暂缓进池，修复结束后统一回流处理。</div>}
        {!sel && !error && (
          <div className="review-blank">
            <p>这里陈列所有 AI 落盘但尚未过审的页面。</p>
            <p className="review-hint">逐页预览 →「通过」让它转正、「驳回」删除它，或写一条「返修意见」让 LLM 集中修复。所有操作都会记入 log.md 流水。</p>
          </div>
        )}
        {sel && (
          <div className="editor-wrap">
            <div className="editor-toolbar review-toolbar">
              <div className="review-pageinfo">
                <span className="review-title">{sel.title}</span>
                <span className="path">{sel.path}</span>
              </div>
              <div className="review-actions">
                <button className="btn btn-ok" disabled={busy} onClick={() => act('approve')}>
                  ✓ 通过
                </button>
                <button className="btn btn-danger" disabled={busy} onClick={() => act('reject')}>
                  ✕ 驳回删除
                </button>
              </div>
            </div>
            <div className="review-preview editor-host">
              {loading ? (
                <div className="loading-row">
                  <span className="spinner" /> 正在加载页面…
                </div>
              ) : (
                <MarkdownHost text={stripFm} onOpenPage={() => {}} />
              )}
            </div>
            {/* v0.3 D6-7 + D8-9 合并：维护建议与返修共用一个意见区。
                留言 = 仅记录到页面 suggestions[]（不改状态）；
                提交返修 = 意见进返修池，攒一批后「统一修复」让 LLM 集中执行。 */}
            <div className="audit-suggestions">
              <div className="audit-suggestions-label">维护建议与返修</div>
              <div className="audit-sug-sub">
                AI 自检建议与你的意见在同一条池子里。写下意见后二选一：
                <b>留言</b>＝仅记录到页面；<b>提交返修</b>＝把页面放进返修池，攒一批后「统一修复」由 LLM 集中执行。
              </div>
              {suggestions.length === 0 && (
                <div className="audit-sug-empty mono">暂无建议——图谱页可跑「🩺 图谱自检」，或在下方写下第一条</div>
              )}
              {suggestions.map((s, i) => (
                <div key={i} className="audit-suggestion-item">
                  <span className={`audit-sug-origin ${s.origin}`}>{s.origin === 'audit' ? 'AI' : '我'}</span>
                  <span className="audit-sug-note">{s.note}</span>
                  {s.action && <span className="audit-sug-action">{s.action}</span>}
                  <button
                    className="btn btn-ghost btn-sm"
                    title="把这条建议填入下方意见框，随返修交给 LLM 集中执行"
                    onClick={() => setReworkNote((n) => (n ? `${n}\n${s.note}` : s.note))}
                  >
                    转返修
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    title="撤除这条建议"
                    disabled={sugBusy}
                    onClick={() => dropSuggestion(i)}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <textarea
                className="textarea"
                style={{ minHeight: 60 }}
                placeholder="给这个页面写维护建议或返修意见，如：补充与[[卡片盒笔记法]]的关联；第二段与来源不符请核对。"
                value={reworkNote}
                onChange={(e) => setReworkNote(e.target.value)}
              />
              <div className="rework-form-foot">
                {sel.rework && (
                  <span className="mono rework-status">
                    已在返修池（{sel.rework.status === 'deferred' ? '暂缓进池' : '待修复'} · {sel.rework.at?.slice(0, 10)}）
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={sugBusy || !reworkNote.trim()}
                  title="仅把意见记录到页面（suggestions），不改变页面状态"
                  onClick={() => submitSuggestion(reworkNote.trim())}
                >
                  {sugBusy ? '提交中…' : '留言'}
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={busy || !reworkNote.trim()}
                  title="记录意见并进返修池，攒批后「统一修复」让 LLM 执行"
                  onClick={() => act('rework', reworkNote.trim())}
                >
                  💬 {sel.rework ? '更新返修' : '提交返修'}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
