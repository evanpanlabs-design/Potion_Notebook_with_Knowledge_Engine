/**
 * 素材页（v0.2.5/0.2.6）：原始素材层（sources/）的导航级入口，统一素材导入中心。
 *  - 上传 PDF/图片/Office → MinerU 结构化解析（done 自动落盘 sources/ 并后台 ingest）
 *  - 导入 .md/.txt → 直接落盘 sources/ 并立即两段式消化（原笔记页「导入素材」功能收编于此）
 *  - 左栏：MinerU 解析任务 + 原始素材列表；右栏：素材内容查看
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import { api } from '../api.js'

/** MinerU 任务状态 → 展示文案 + 徽标色 */
const TASK_STATE = {
  pending: { label: '排队中', cls: 'muted' },
  'waiting-file': { label: '等待上传', cls: 'muted' },
  'pending-file': { label: '等待上传', cls: 'muted' },
  running: { label: '解析中', cls: 'busy' },
  converting: { label: '转换中', cls: 'busy' },
  done: { label: '完成', cls: 'ok' },
  failed: { label: '失败', cls: 'err' },
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export default function Sources({ onOpenPage, go, stream }) {
  const [sources, setSources] = useState([])
  const [tasks, setTasks] = useState([])
  const [selected, setSelected] = useState(null) // { path, name, content }
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [uploading, setUploading] = useState(false)
  const [hasKey, setHasKey] = useState(null) // null = 查询中
  const fileRef = useRef(null)

  // ---- 文本素材导入（.md/.txt，立即两段式消化；原笔记页功能收编于此）----
  const textFileRef = useRef(null)
  const [importFile, setImportFile] = useState(null) // { name, size, content }
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState('')
  const [importResult, setImportResult] = useState(null)

  const load = useCallback(async () => {
    try {
      const [s, t, c] = await Promise.all([api.listSources(), api.mineruTasks(), api.getMineruConfig()])
      setSources(s.sources)
      setTasks(t.tasks)
      setHasKey(c.hasKey)
      setError('')
    } catch (e) {
      setError(e.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // 有进行中的解析任务时每 5s 轮询（服务端惰性轮询 MinerU，配额友好）
  const hasActive = useMemo(() => tasks.some((t) => ['pending', 'waiting-file', 'pending-file', 'running', 'converting'].includes(t.state)), [tasks])
  useEffect(() => {
    if (!hasActive) return undefined
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [hasActive, load])

  async function openSource(s) {
    try {
      const page = await api.page(s.path)
      setSelected({ path: s.path, name: s.name, content: page.content ?? '' })
    } catch (e) {
      setError(e.message)
    }
  }

  async function onPickFiles(e) {
    const files = [...(e.target.files ?? [])]
    e.target.value = ''
    if (files.length === 0) return
    if (hasKey === false) {
      setError('尚未配置 MinerU API Key——请先到「设置」页填写并测试')
      return
    }
    setUploading(true)
    setError('')
    setMessage('')
    try {
      const r = await api.mineruConvert(files)
      setMessage(`已提交 ${r.count} 个文件到 MinerU 解析（batch ${r.batchId.slice(0, 8)}…），完成后自动入库并消化`)
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  // ---- 文本素材导入（收编自笔记页「导入素材」）：落盘 sources/ → 立即两段式消化 ----
  async function acceptTextFile(file) {
    if (!file) return
    if (!/\.(md|txt|markdown)$/i.test(file.name)) {
      setImportError('仅支持 .md / .txt 文本文件（PDF/图片请用 MinerU 上传）')
      return
    }
    setImportError('')
    try {
      const text = await file.text()
      setImportFile({ name: file.name, size: file.size, content: text })
    } catch (e) {
      setImportError(`读取文件失败：${e.message}`)
    }
  }

  async function submitImport() {
    if (!importFile || importBusy || stream?.busy) return
    setImportError('')
    setImportBusy(true)
    setImportResult(null)
    stream?.begin()
    try {
      // 文件名空格换连字符（server 端 filename 白名单不含空格）
      const safeName = importFile.name.replace(/\s+/g, '-')
      await api.addSource(safeName, importFile.content)
      const outcome = await api.ingest(`sources/${safeName}`)
      setImportResult(outcome)
      setImportFile(null)
      await load()
    } catch (e) {
      setImportError(e.message)
    } finally {
      stream?.end()
      setImportBusy(false)
    }
  }

  const rendered = useMemo(() => {
    if (!selected) return ''
    if (selected.name.endsWith('.md')) {
      try { return marked.parse(selected.content, { async: false }) } catch { return '' }
    }
    return null // 纯文本走 <pre>
  }, [selected])

  return (
    <section className="page page-wide sources-page">
      <h1 className="page-title">原始素材</h1>
      <p className="page-desc">
        ingest 管线的输入层（<code>sources/</code>）。上传 PDF/图片后经 MinerU 转为结构化 Markdown 自动入库；导入 .md/.txt 则直接落盘并立即两段式消化。
      </p>

      {hasKey === false && (
        <div className="banner banner-warn">
          尚未配置 MinerU API Key，PDF 解析不可用。
          <button className="btn btn-sm btn-secondary" style={{ marginLeft: 10 }} onClick={() => go?.('settings')}>去设置</button>
        </div>
      )}
      {error && <div className="banner banner-err">{error}</div>}
      {message && <div className="banner banner-ok">{message}</div>}
      {importError && <div className="banner banner-err">导入失败：{importError}</div>}
      {importResult && (
        <div className="banner banner-ok">
          消化完成：产出 {importResult.writtenPages.length} 个页面
          {importResult.rejections?.length > 0 ? `，另有 ${importResult.rejections.length} 条被闸门拒绝` : ''}
          。
          {importResult.writtenPages.map((p) => (
            <button key={p} className="btn btn-sm btn-secondary" style={{ marginLeft: 8 }} onClick={() => onOpenPage?.(p)}>
              {p.split('/').pop().replace(/\.md$/, '')}
            </button>
          ))}
        </div>
      )}

      <div className="sources-toolbar">
        <input ref={fileRef} type="file" multiple hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.bmp,.gif,.doc,.docx,.ppt,.pptx,.xls,.xlsx" onChange={onPickFiles} />
        <input ref={textFileRef} type="file" hidden accept=".md,.txt,.markdown" onChange={(e) => { acceptTextFile(e.target.files?.[0]); e.target.value = '' }} />
        <button className="btn btn-primary" disabled={uploading || hasKey === false} onClick={() => fileRef.current?.click()}>
          {uploading ? '提交中…' : '上传 PDF/图片（MinerU 解析）'}
        </button>
        <button className="btn btn-secondary" disabled={importBusy || !!importFile} onClick={() => textFileRef.current?.click()} title="把一份 .md/.txt 材料落盘并立即两段式消化">
          {importFile ? `已选：${importFile.name}` : '导入 md/txt（立即消化）'}
        </button>
        {importFile && !importBusy && (
          <button className="btn btn-sm btn-secondary" onClick={() => setImportFile(null)}>取消</button>
        )}
        {importFile && (
          <button className="btn btn-primary" disabled={importBusy || stream?.busy} onClick={submitImport}>
            {importBusy && <span className="spinner" style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,0.35)' }} />}
            {importBusy ? `引擎消化中 ${stream?.elapsed ?? 0}s…` : `导入并消化「${importFile.name}」`}
          </button>
        )}
        {importBusy && (
          <span className="mono" style={{ color: 'var(--c-text-3)', fontSize: '0.75rem' }}>
            {stream?.stage?.text ?? '排队中…'}（实时输出见侧栏引擎状态灯）
          </span>
        )}
      </div>

      <div className="sources-layout">
        <aside className="sources-side">
          {tasks.length > 0 && (
            <div className="side-block">
              <div className="side-block-title">MinerU 解析任务{hasActive ? <span className="task-live">● 轮询中</span> : null}</div>
              <div className="side-list">
                {tasks.map((t, i) => {
                  const st = TASK_STATE[t.state] ?? { label: t.state, cls: 'muted' }
                  return (
                    <div key={`${t.dataId}-${i}`} className="task-row" title={t.errMsg ?? ''}>
                      <span className={`task-badge task-${st.cls}`}>{st.label}</span>
                      <span className="task-name" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.fileName}
                      </span>
                      {t.ingested && <span className="task-badge task-ok" title="已自动完成两段式消化">已消化</span>}
                      {t.sourcePath && (
                        <button className="btn btn-sm btn-secondary" onClick={() => openSource({ path: t.sourcePath, name: t.sourcePath.replace(/^sources\//, '') })}>
                          查看
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          <div className="side-block">
            <div className="side-block-title">素材文件 · {sources.length}</div>
            <div className="side-list">
              {sources.length === 0 && <div className="muted" style={{ padding: 8 }}>还没有原始素材——先上传 PDF 或在笔记页导入文本。</div>}
              {sources.map((s) => (
                <button
                  key={s.path}
                  className={`side-item ${selected?.path === s.path ? 'active' : ''}`}
                  onClick={() => openSource(s)}
                  title={s.path}
                >
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                  <span className="muted" style={{ fontSize: '0.72rem', flex: 'none' }}>{fmtSize(s.size)}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <div className="sources-view">
          {selected === null ? (
            <div className="muted" style={{ padding: 24 }}>左侧选择一个素材查看内容。</div>
          ) : (
            <>
              <div className="sources-view-head">
                <strong>{selected.name}</strong>
                <span className="muted mono" style={{ fontSize: '0.75rem' }}>{selected.path}</span>
              </div>
              <div className="sources-view-body">
                {rendered === null
                  ? <pre className="source-raw">{selected.content}</pre>
                  : <div className="md-preview" dangerouslySetInnerHTML={{ __html: rendered }} />}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
