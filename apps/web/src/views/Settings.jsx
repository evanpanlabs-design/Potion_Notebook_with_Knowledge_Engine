import { useEffect, useState } from 'react'
import { api } from '../api.js'

/**
 * 设置页：LLM 双角色配置（ingest 消化 / query 问答）。
 * 协议支持 OpenAI 兼容 / Anthropic；连通性现场测试；保存后立即生效（无需重启）。
 */

const ROLE_INFO = {
  ingest: {
    title: '消化引擎（ingest）',
    desc: '素材导入/笔记同步时的两段式消化（要点分析 + 页面生成）。建议用便宜、快的模型——这一步吃 token 大头。',
  },
  query: {
    title: '问答引擎（query）',
    desc: '提问时基于检索结果作答并标注引用。建议用强模型——回答质量直接由它决定。',
  },
}

const EMPTY_ROLE = { protocol: 'openai', baseUrl: '', apiKey: '', model: '' }

/** MinerU PDF 解析集成（v0.2.5）：API Key 配置 + 连通性测试。
 *  Key 存 data/mineru-config.json（本地文件，不入库不进 git）。 */
function MineruCard() {
  const [masked, setMasked] = useState(null)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState(null) // { ok, message }
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.getMineruConfig().then((c) => setMasked(c.hasKey ? c.masked : null)).catch(() => {})
  }, [])

  async function save() {
    setBusy(true)
    setStatus(null)
    try {
      const r = await api.saveMineruConfig(draft.trim() || '••')
      setMasked(r.masked)
      setDraft('')
      setStatus({ ok: true, message: '已保存' })
    } catch (e) {
      setStatus({ ok: false, message: e.message })
    } finally {
      setBusy(false)
    }
  }

  async function test() {
    setBusy(true)
    setStatus(null)
    try {
      const r = await api.testMineru(draft.trim())
      setStatus({ ok: r.ok, message: r.message })
    } catch (e) {
      setStatus({ ok: false, message: e.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card settings-role">
      <h2>MinerU PDF 解析</h2>
      <p className="settings-desc">
        在「素材」页上传 PDF/图片时，调用 MinerU 结构化解析为 Markdown，自动入库并触发消化。
        Key 在 <a href="https://mineru.net/apiManage" target="_blank" rel="noreferrer">mineru.net API 管理</a> 页创建；
        存于 <code>data/mineru-config.json</code>（本地文件，不入库不进 git）。官方限流：50 文件/分钟、5000 文件/天、单文件 ≤200MB。
      </p>
      <label className="settings-field">
        <span>API Token {masked ? <span className="settings-hint">（已配置：{masked}，留空沿用）</span> : null}</span>
        <input
          type="password"
          value={draft}
          placeholder={masked ? '留空则沿用已保存的 Key' : 'sk-…'}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <div className="settings-saverow">
        <button className="btn btn-primary btn-sm" disabled={busy || (!draft.trim() && !masked)} onClick={save}>保存</button>
        <button className="btn btn-secondary btn-sm" disabled={busy || (!draft.trim() && !masked)} onClick={test}>测试连通性</button>
        {status && <span className={status.ok ? 'settings-hint' : 'settings-warn'}>{status.message}</span>}
      </div>
    </section>
  )
}

function RoleForm({ role, form, onChange, onTest, testing, testResult }) {
  const set = (k, v) => onChange(role, { ...form, [k]: v })
  return (
    <section className="card settings-role">
      <h2>{ROLE_INFO[role].title}</h2>
      <p className="settings-desc">{ROLE_INFO[role].desc}</p>

      <label className="settings-field">
        <span>请求协议</span>
        <select value={form.protocol} onChange={(e) => set('protocol', e.target.value)}>
          <option value="openai">OpenAI 兼容（chat/completions）</option>
          <option value="anthropic">Anthropic（messages）</option>
        </select>
      </label>

      <label className="settings-field">
        <span>Base URL</span>
        <input
          type="text"
          value={form.baseUrl}
          placeholder={form.protocol === 'anthropic' ? 'https://api.anthropic.com（SDK 自动补 /v1/messages）' : 'https://api.example.com/v1'}
          onChange={(e) => set('baseUrl', e.target.value)}
        />
      </label>

      <label className="settings-field">
        <span>API Key</span>
        <input
          type="password"
          value={form.apiKey}
          placeholder={form.maskedKey ? `已保存：${form.maskedKey}（留空则沿用）` : 'sk-...'}
          onChange={(e) => set('apiKey', e.target.value)}
          autoComplete="off"
        />
      </label>

      <label className="settings-field">
        <span>模型名</span>
        <input
          type="text"
          value={form.model}
          placeholder={form.protocol === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o-mini / glm-4.7-flash / ...'}
          onChange={(e) => set('model', e.target.value)}
        />
      </label>

      <div className="settings-testrow">
        <button className="btn" disabled={testing} onClick={() => onTest(role)}>
          {testing ? '测试中…' : '测试连通性'}
        </button>
        {testResult && (
          <span className={testResult.ok ? 'test-ok' : 'test-fail'}>
            {testResult.ok
              ? `✓ 连通 ${testResult.latencyMs}ms · ${testResult.model} · 回复「${testResult.sample}」`
              : `✕ ${testResult.error}`}
          </span>
        )}
      </div>
    </section>
  )
}

export default function Settings() {
  const [forms, setForms] = useState({ ingest: { ...EMPTY_ROLE }, query: { ...EMPTY_ROLE } })
  const [source, setSource] = useState('none')
  const [loaded, setLoaded] = useState(false)
  const [testing, setTesting] = useState({})
  const [testResult, setTestResult] = useState({})
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .llmConfig()
      .then((c) => {
        if (!alive) return
        setSource(c.source)
        if (c.hasConfig) {
          const pick = (r) => ({
            protocol: r.protocol,
            baseUrl: r.baseUrl,
            apiKey: '',
            model: r.model,
            maskedKey: r.apiKey,
          })
          setForms({ ingest: pick(c.ingest), query: pick(c.query) })
        }
        setLoaded(true)
      })
      .catch((e) => {
        if (alive) {
          setError(e.message)
          setLoaded(true)
        }
      })
    return () => {
      alive = false
    }
  }, [])

  const onChange = (role, next) => setForms((f) => ({ ...f, [role]: next }))

  async function save() {
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const payload = {}
      for (const role of ['ingest', 'query']) {
        const f = forms[role]
        payload[role] = { protocol: f.protocol, baseUrl: f.baseUrl, apiKey: f.apiKey, model: f.model }
      }
      const r = await api.saveLlmConfig(payload.ingest, payload.query)
      setMessage(r.note ?? '已保存')
      // 重新拉取打码后的配置
      const c = await api.llmConfig()
      if (c.hasConfig) {
        const pick = (x) => ({ protocol: x.protocol, baseUrl: x.baseUrl, apiKey: '', model: x.model, maskedKey: x.apiKey })
        setForms({ ingest: pick(c.ingest), query: pick(c.query) })
        setSource(c.source)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function test(role) {
    setTesting((t) => ({ ...t, [role]: true }))
    setTestResult((r) => ({ ...r, [role]: null }))
    try {
      const f = forms[role]
      const res = await api.testLlmConfig(role, {
        protocol: f.protocol,
        baseUrl: f.baseUrl,
        apiKey: f.apiKey,
        model: f.model,
      })
      setTestResult((r) => ({ ...r, [role]: res }))
    } catch (e) {
      setTestResult((r) => ({ ...r, [role]: { ok: false, error: e.message } }))
    } finally {
      setTesting((t) => ({ ...t, [role]: false }))
    }
  }

  return (
    <div className="page page-wide settings-page">
      <h1 className="page-title">设置</h1>
      <p className="page-desc settings-sub">
        LLM 双引擎配置：消化（ingest）与问答（query）可分别使用不同厂商 / 不同模型。
        支持 OpenAI 兼容协议与 Anthropic 协议（含各类兼容网关，即「自定义」场景：换 Base URL 即可）。
        保存后立即生效，无需重启；配置存在 <code>data/llm-config.json</code>（本地文件，不入库不进 git）。
        {source === 'env' && ' 当前使用环境变量兜底配置，保存后将覆盖。'}
        {loaded && source === 'none' && (
          <strong className="settings-warn"> 尚未配置 LLM——素材导入与提问不可用，请先在下方填写。</strong>
        )}
      </p>

      {error && <div className="banner banner-err">{error}</div>}
      {message && <div className="banner banner-ok">{message}</div>}

      <RoleForm
        role="ingest"
        form={forms.ingest}
        onChange={onChange}
        onTest={test}
        testing={testing.ingest}
        testResult={testResult.ingest}
      />
      <RoleForm
        role="query"
        form={forms.query}
        onChange={onChange}
        onTest={test}
        testing={testing.query}
        testResult={testResult.query}
      />

      <div className="settings-saverow">
        <button className="btn btn-primary" disabled={saving} onClick={save}>
          {saving ? '保存中…' : '保存配置'}
        </button>
        <span className="settings-hint">两个角色都必填；API Key 留空表示沿用已保存的值。</span>
      </div>

      <MineruCard />
    </div>
  )
}
