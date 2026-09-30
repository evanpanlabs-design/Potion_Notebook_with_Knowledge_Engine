import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import MarkdownHost from './MarkdownHost.jsx'

/** 总览页：库状态统计 + 定时任务 + index 目录（库的门面 index.md 五段目录渲染） */
export default function Overview({ onOpenPage, go }) {
  const [status, setStatus] = useState(null)
  const [indexPage, setIndexPage] = useState(null)
  const [logEntries, setLogEntries] = useState([])
  const [tasks, setTasks] = useState(null)
  const [taskBusy, setTaskBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    api
      .status()
      .then((s) => alive && setStatus(s))
      .catch((e) => alive && setError(e.message))
    api
      .page('index.md')
      .then((p) => alive && setIndexPage(p.content))
      .catch(() => {} /* 库未初始化时无 index.md，静默 */)
    api
      .log()
      .then((r) => alive && setLogEntries(r.entries.slice(0, 8)))
      .catch(() => {} /* log.md 不存在时静默 */)
    api
      .listTasks()
      .then((r) => alive && setTasks(r.tasks))
      .catch(() => alive && setTasks([]))
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="page page-wide">
      <h1 className="page-title">总览</h1>
      <p className="page-desc">你的知识库当前状态与目录。</p>

      {error && <div className="banner banner-danger">无法连接知识引擎服务：{error}</div>}

      <div className="stat-row">
        <div className="stat-card tint-primary">
          <div className="stat-value">{status ? status.pages : '—'}</div>
          <div className="stat-label">Wiki 页面</div>
        </div>
        <div
          className="stat-card tint-secondary"
          title="sources/ 目录下的原始文件数：早期导入的素材 + 每篇笔记「同步到知识库」时生成的不可变快照（sources/note-*.md）。它们是 ingest 管线的输入层。"
        >
          <div className="stat-value">{status ? status.sources : '—'}</div>
          <div className="stat-label">原始素材</div>
        </div>
        <div className="stat-card tint-success">
          <div className="stat-value">{status ? status.reviewed : '—'}</div>
          <div className="stat-label">已审阅页面</div>
        </div>
      </div>

      {!error && !status && (
        <div className="loading-row">
          <span className="spinner" /> 正在读取库状态…
        </div>
      )}

      {status && status.pages === 0 && (
        <div className="empty-state">
          知识库还是空的。去
          <button className="btn btn-sm btn-primary" style={{ margin: '0 8px' }} onClick={() => go('notes')}>
            笔记页导入素材
          </button>
          或写一篇笔记并「同步到知识库」，引擎会把它消化成结构化 wiki 页面。
        </div>
      )}

      {tasks && tasks.length > 0 && (
        <section className="card">
          <h3 className="doc-label">定时任务 · AI 自动执行中</h3>
          <TaskList
            tasks={tasks}
            busy={taskBusy}
            onToggle={async (t) => {
              setTaskBusy(t.id)
              try {
                const r = await api.toggleTask(t.id, !t.enabled)
                setTasks((ts) => ts.map((x) => (x.id === t.id ? r.task : x)))
              } catch { /* ignore */ } finally { setTaskBusy('') }
            }}
            onRun={async (t) => {
              setTaskBusy(t.id)
              try {
                const r = await api.runTaskNow(t.id)
                if (r.task) setTasks((ts) => ts.map((x) => (x.id === t.id ? r.task : x)))
              } catch { /* ignore */ } finally { setTaskBusy('') }
            }}
            onDelete={async (t) => {
              setTaskBusy(t.id)
              try {
                await api.deleteTask(t.id)
                setTasks((ts) => ts.filter((x) => x.id !== t.id))
              } catch { /* ignore */ } finally { setTaskBusy('') }
            }}
          />
        </section>
      )}

      {logEntries.length > 0 && (
        <section className="card">
          <h3 className="doc-label">最近动态 · log.md 流水</h3>
          <div className="timeline">
            {logEntries.map((e, i) => (
              <div key={`${e.ts}-${i}`} className="timeline-row">
                <span className={`op-badge op-${e.op}`}>{e.op}</span>
                <span className="timeline-title">{e.title}</span>
                <span className="timeline-ts">{e.ts}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {status?.pages > 0 && indexPage && (
        <section className="card">
          <h3 className="doc-label">库目录 · index.md</h3>
          <IndexBody text={indexPage} onOpenPage={onOpenPage} />
        </section>
      )}
    </div>
  )
}

/** index.md 渲染：wikilink 可点击 */
function IndexBody({ text, onOpenPage }) {
  return <MarkdownHost text={text} onOpenPage={onOpenPage} />
}

/** 定时任务列表：排程 + 下次执行 + 最近结果 + 开关/立即运行/删除 */
const OUTCOME_LABEL = {
  ok: ['成功', 'outcome-ok'],
  'caught-up': ['补做', 'outcome-ok'],
  skipped: ['已放弃', 'outcome-skip'],
  error: ['失败', 'outcome-err'],
  manual: ['手动', 'outcome-ok'],
}

function TaskList({ tasks, busy, onToggle, onRun, onDelete }) {
  return (
    <div className="task-list">
      {tasks.map((t) => {
        const [label, cls] = OUTCOME_LABEL[t.lastOutcome] ?? [t.lastOutcome ?? '未运行', '']
        return (
          <div key={t.id} className={`task-row${t.enabled ? '' : ' disabled'}`}>
            <div className="task-main">
              <div className="task-title">
                {t.title}
                {t.kind === 'agent' && <span className="task-tag task-tag-agent">Agent</span>}
                {!t.enabled && <span className="task-tag">已停用</span>}
              </div>
              <div className="task-meta">
                <span className="task-schedule">{t.scheduleDesc}</span>
                {t.enabled && t.nextDueIn && <span>下次 {t.nextDueIn}</span>}
                {t.lastOutcome && (
                  <span className={`task-outcome ${cls}`} title={t.lastNote || ''}>
                    最近：{label}
                    {t.lastRunAgo ? `（${t.lastRunAgo}）` : ''}
                  </span>
                )}
              </div>
              {t.lastOutcome === 'error' && t.lastNote && (
                <div className="task-error-note">⚠ {t.lastNote}</div>
              )}
              {t.kind === 'agent' && t.prompt && (
                <div className="task-prompt" title={t.prompt}>🎯 {t.prompt}</div>
              )}
              {t.lastArtifact && <div className="mono task-artifact">产出 {t.lastArtifact}</div>}
            </div>
            <div className="task-actions">
              <button
                className="btn btn-sm"
                disabled={busy === t.id || !t.enabled}
                title="立即执行一次"
                onClick={() => onRun(t)}
              >
                运行
              </button>
              <button
                className="btn btn-sm"
                disabled={busy === t.id}
                onClick={() => onToggle(t)}
                title={t.enabled ? '停用' : '启用'}
              >
                {t.enabled ? '停用' : '启用'}
              </button>
              <button
                className="btn btn-sm btn-danger-ghost"
                disabled={busy === t.id}
                onClick={() => onDelete(t)}
              >
                删除
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
