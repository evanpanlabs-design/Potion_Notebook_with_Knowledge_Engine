import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import MarkdownHost from './MarkdownHost.jsx'

/**
 * workbench 任务追踪（v0.3 D12）：agent 任务的轨迹看板。
 * 每个任务 = data/tasks/<taskId>.md 四节结构（背景与目标 → 探索链路 →
 * 执行链路 → 结果与迭代）；点击任务展开时间线详情。
 */
const STATUS_LABEL = { running: '运行中', done: '已完成', error: '失败' }

export default function Workbench() {
  const [tasks, setTasks] = useState(null)
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState('')

  function load() {
    api
      .listWorkbench()
      .then((r) => setTasks(r.tasks))
      .catch((e) => setError(e.message))
  }

  useEffect(load, [])

  // 打开任务：拉详情
  useEffect(() => {
    if (!openId) {
      setDetail(null)
      return
    }
    let alive = true
    setDetail(null)
    setDetailError('')
    api
      .workbenchTask(openId)
      .then((r) => alive && setDetail(r.task))
      .catch((e) => alive && setDetailError(e.message))
    return () => {
      alive = false
    }
  }, [openId])

  // running 态任务存在时轮询刷新列表
  useEffect(() => {
    if (!tasks?.some((t) => t.status === 'running')) return
    const timer = setInterval(load, 3000)
    return () => clearInterval(timer)
  }, [tasks])

  return (
    <div className="page page-wide">
      <h1 className="page-title">工作台</h1>
      <p className="page-desc">
        agent 任务的过程留痕：每次多步问答都会按「背景与目标 → 探索链路 → 执行链路 → 结果与迭代」
        四节结构落盘。这些轨迹未来可作为「项目经验」被知识库消化。
      </p>

      {error && <div className="banner banner-danger">{error}</div>}

      {tasks === null && !error && (
        <div className="loading-row">
          <span className="spinner" /> 正在读取任务…
        </div>
      )}

      {tasks?.length === 0 && (
        <div className="empty-state">
          还没有 agent 任务记录。用右下角悬浮球提问（或在「问答历史」看归档），
          每次多步问答都会在这里留下完整轨迹。
        </div>
      )}

      {tasks?.length > 0 && (
        <div className="workbench-list">
          {tasks.map((t) => (
            <button key={t.taskId} className={`workbench-row ${t.status} ${openId === t.taskId ? 'active' : ''}`} onClick={() => setOpenId(openId === t.taskId ? null : t.taskId)}>
              <span className={`workbench-status st-${t.status}`}>
                {t.status === 'running' ? <span className="spinner" /> : STATUS_LABEL[t.status]}
              </span>
              <span className="workbench-question">{t.question || '(无问题)'}</span>
              <span className="mono workbench-stats">
                {t.steps} 步{t.truncated ? ' · 截断' : ''}
              </span>
              <span className="mono workbench-time">{(t.startedAt || '').slice(0, 16).replace('T', ' ')}</span>
            </button>
          ))}
        </div>
      )}

      {openId && (
        <div className="workbench-detail card">
          {detailError && <div className="banner banner-danger">{detailError}</div>}
          {!detailError && !detail && (
            <div className="loading-row">
              <span className="spinner" /> 正在加载轨迹…
            </div>
          )}
          {detail && (
            <>
              <div className="workbench-detail-head">
                <span className="mono workbench-detail-id">{detail.taskId}</span>
                {detail.tokens && (
                  <span className="mono workbench-stats">
                    token in/out {detail.tokens.input}/{detail.tokens.output} · 轮数 {detail.turns}
                  </span>
                )}
              </div>
              <MarkdownHost text={detail.body} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
