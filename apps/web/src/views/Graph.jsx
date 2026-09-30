import React, { useEffect, useMemo, useRef, useState } from 'react'
import Graph from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import louvain from 'graphology-communities-louvain'
import { api } from '../api.js'
import { exportSvgToPng } from '../export-svg.js'

/** v0.2.5 配色方案：kinds = 页面类型色，communities = Louvain 聚类调色盘（12 色），active = hover 邻接边高亮色 */
const SCHEMES = {
  classic: {
    label: '经典蓝紫',
    kinds: { entity: '#3b82f6', concept: '#8b5cf6', source: '#6b7280', note: '#f59e0b', other: '#9ca3af' },
    communities: ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#14b8a6', '#a855f7', '#64748b'],
  },
  forest: {
    label: '森林',
    kinds: { entity: '#059669', concept: '#65a30d', source: '#78716c', note: '#d97706', other: '#a8a29e' },
    communities: ['#059669', '#65a30d', '#0d9488', '#ca8a04', '#4d7c0f', '#0f766e', '#a16207', '#16a34a', '#b45309', '#15803d', '#854d0e', '#44403c'],
  },
  warm: {
    label: '暖调',
    kinds: { entity: '#ea580c', concept: '#e11d48', source: '#78716c', note: '#f59e0b', other: '#a8a29e' },
    communities: ['#ea580c', '#e11d48', '#d97706', '#db2777', '#dc2626', '#f97316', '#be123c', '#f59e0b', '#f43f5e', '#c2410c', '#fb7185', '#a8a29e'],
  },
  cool: {
    label: '冷调',
    kinds: { entity: '#0284c7', concept: '#4f46e5', source: '#64748b', note: '#0891b2', other: '#94a3b8' },
    communities: ['#0284c7', '#4f46e5', '#0891b2', '#7c3aed', '#1d4ed8', '#0e7490', '#6d28d9', '#2563eb', '#155e75', '#5b21b6', '#38bdf8', '#64748b'],
  },
}
const KIND_LABELS = { entity: '实体', concept: '概念', source: '来源', note: '笔记', other: '其他' }

/** 路径式 title 美化：wiki/queries/xxx.md → xxx */
function prettyTitle(t) {
  return t.includes('/') ? t.split('/').pop().replace(/\.md$/, '') : t
}

/** 位置缓存（llm_wiki 同款思路）：数据变了才重排，数据没变时用上次坐标做初始位置，布局不跳 */
const posCache = new Map()

const W = 900
const H = 560
const PAD = 70

/** 视图状态：zoom 缩放倍数；x/y 为 SVG 坐标系下的平移（作用于内容层 transform） */
/**
 * 知识图谱页（F7）：wikilink 关系网络。
 * MVP 渲染用 SVG（数据量 <10²，无 WebGL 依赖，headless 也可用）；规模上来后再切 sigma.js。
 *
 * 交互：滚轮缩放（以指针为锚点）、拖拽平移、点击节点打开页面；
 * 调节面板：节点大小 / 连线宽度 / 斥力（FA2 scalingRatio，实时重排）；
 * 标签独立图层绘制在节点之后（任何节点都不遮挡文字），hover 标签放大强调 + 白色描边光晕；
 * 来源节点默认不渲染（可选开关恢复）。
 */
export default function GraphView({ onOpenPage, go }) {
  const [graph, setGraph] = useState(null)
  const [error, setError] = useState('')
  const [hover, setHover] = useState(null)
  const [legendOpen, setLegendOpen] = useState(true) // 图例可折叠（默认展开）
  const [tuneOpen, setTuneOpen] = useState(false) // 微调面板可折叠（默认收起，基准参数已调好）
  // v0.3 D6-7：graph audit（体检 → 建议 → 待审 suggestions）
  const [auditBusy, setAuditBusy] = useState(false)
  const [auditNote, setAuditNote] = useState('')
  const auditTimer = useRef(null)
  const [showSources, setShowSources] = useState(false) // 来源节点默认不渲染
  // 配色：方案 + 着色模式（按页面类型 / 按 Louvain 聚类），均持久化到 localStorage
  const [schemeKey, setSchemeKey] = useState(() => localStorage.getItem('potion-graph-scheme') || 'classic')
  const [colorMode, setColorMode] = useState(() => localStorage.getItem('potion-graph-mode') || 'kind')
  const scheme = SCHEMES[schemeKey] ?? SCHEMES.classic
  useEffect(() => { localStorage.setItem('potion-graph-scheme', schemeKey) }, [schemeKey])
  useEffect(() => { localStorage.setItem('potion-graph-mode', colorMode) }, [colorMode])
  // v0.2.4 布局重调：FA2 开 preventOverlap + inferSettings，引力降到 3（strongGravityMode）。
  // 之前的病因：gravity 8 把每个连通分量压成致密球，scalingRatio 20 又把球间推得很远 →「分散 + 糊团」。
  const [cfg, setCfg] = useState({ nodeBase: 4.2, nodeScale: 1.75, edgeWidth: 1, repulsion: 10, gravity: 3 })
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 })

  const svgRef = useRef(null)
  const dragRef = useRef(null) // { startClientX, startClientY, startView, moved }

  useEffect(() => {
    let alive = true
    api
      .graph()
      .then((g) => alive && setGraph(g))
      .catch((e) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [])

  // ---- 数据过滤：来源节点不进图（开关可恢复） ----
  const nodes = useMemo(
    () => (graph ? (showSources ? graph.nodes : graph.nodes.filter((n) => n.kind !== 'source')) : []),
    [graph, showSources],
  )
  const edges = useMemo(() => {
    if (!graph) return []
    const ids = new Set(nodes.map((n) => n.id))
    return graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target))
  }, [graph, nodes])
  const deg = useMemo(() => {
    const d = {}
    for (const e of edges) {
      d[e.source] = (d[e.source] ?? 0) + 1
      d[e.target] = (d[e.target] ?? 0) + 1
    }
    return d
  }, [edges])
  const maxDeg = useMemo(() => Math.max(1, ...Object.values(deg)), [deg])

  /** 邻接表：hover 聚焦时用于「保留邻居、淡出无关」 */
  const neighborsOf = useMemo(() => {
    const m = {}
    for (const e of edges) {
      ;(m[e.source] ??= new Set()).add(e.target)
      ;(m[e.target] ??= new Set()).add(e.source)
    }
    return m
  }, [edges])

  /** √ 度数缩放半径（llm_wiki 同款思路）：枢纽节点不线性膨胀，给团内留出空间 */
  const radius = (id) => cfg.nodeBase + Math.sqrt(deg[id] ?? 0) * cfg.nodeScale * 1.6

  /** 确定性初始位置：id hash → 伪随机坐标（刷新布局不跳变，FA2 收敛结果可复现）；优先用上次缓存坐标 */
  function hashXY(id) {
    const cached = posCache.get(id)
    if (cached) return cached
    let h = 2166136261
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    const u = (h >>> 0) % 100000 / 100000
    const v = (Math.imul(h, 2654435761) >>> 0) % 100000 / 100000
    return { x: u * 400 - 200, y: v * 400 - 200 }
  }

  // 布局：graphology 建 + FA2 力导向 → 归一化到画布坐标（斥力参数改变时实时重排）。
  // v0.2.4：inferSettings 自动推导基准参数；gravity 1 + strongGravityMode（llm_wiki 同款），
  // preventOverlap + 节点 size 参与布局 → 团内节点不再叠成一球。
  const layout = useMemo(() => {
    if (!nodes.length) return null
    const g = new Graph({ multi: false })
    for (const n of nodes) {
      // FA2 要求节点必须有初始 x/y（确定性 hash，避免每次随机导致布局跳变）
      const { x, y } = hashXY(n.id)
      g.addNode(n.id, { x, y, size: radius(n.id) })
    }
    for (const e of edges) {
      if (g.hasNode(e.source) && g.hasNode(e.target) && !g.hasEdge(e.source, e.target)) {
        g.addEdge(e.source, e.target)
      }
    }
    if (g.order > 1) {
      const base = forceAtlas2.inferSettings(g)
      forceAtlas2.assign(g, {
        iterations: 300,
        settings: {
          ...base,
          gravity: cfg.gravity,
          strongGravityMode: true,
          scalingRatio: cfg.repulsion,
          barnesHutOptimize: nodes.length > 50,
          preventOverlap: true,
          edgeWeightInfluence: 0,
          slowDown: 10,
        },
      })
    }
    // 孤立节点摊在圆环上
    const linked = new Set()
    edges.forEach((e) => {
      linked.add(e.source)
      linked.add(e.target)
    })
    const isolated = nodes.filter((n) => !linked.has(n.id))
    isolated.forEach((n, i) => {
      const angle = (i / Math.max(1, isolated.length)) * Math.PI * 2
      g.setNodeAttribute(n.id, 'x', Math.cos(angle) * 50)
      g.setNodeAttribute(n.id, 'y', Math.sin(angle) * 50)
    })

    // 布局结果写回位置缓存：下次重排（数据变化/参数微调）从上次位置继续，而不是重新随机
    for (const n of nodes) posCache.set(n.id, { x: g.getNodeAttribute(n.id, 'x'), y: g.getNodeAttribute(n.id, 'y') })

    // 归一化
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const n of nodes) {
      const x = g.getNodeAttribute(n.id, 'x')
      const y = g.getNodeAttribute(n.id, 'y')
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    const sx = (maxX - minX) || 1
    const sy = (maxY - minY) || 1
    const pos = {}
    for (const n of nodes) {
      const x = g.getNodeAttribute(n.id, 'x')
      const y = g.getNodeAttribute(n.id, 'y')
      pos[n.id] = {
        x: PAD + ((x - minX) / sx) * (W - PAD * 2),
        y: PAD + ((y - minY) / sy) * (H - PAD * 2),
      }
    }
    return pos
  }, [nodes, edges, cfg.repulsion, cfg.gravity, cfg.nodeBase, cfg.nodeScale])

  /** Louvain 社区检测（llm_wiki 同款）：按 wikilink 拓扑自动聚类，仅「按聚类」着色时计算。
   *  与布局 memo 分离：微调滑杆重排时社区划分不变，颜色稳定。 */
  const communityOf = useMemo(() => {
    if (colorMode !== 'community' || !nodes.length) return null
    const g = new Graph({ multi: false })
    for (const n of nodes) g.addNode(n.id)
    for (const e of edges) {
      if (g.hasNode(e.source) && g.hasNode(e.target) && !g.hasEdge(e.source, e.target)) {
        g.addEdge(e.source, e.target)
      }
    }
    if (g.size > 0) louvain.assign(g)
    const m = {}
    for (const n of nodes) m[n.id] = g.getNodeAttribute(n.id, 'community') ?? 0
    return m
  }, [nodes, edges, colorMode])

  /** 节点颜色：按类型 → scheme.kinds；按聚类 → scheme.communities[社区号 % 12] */
  const nodeColor = (n) => {
    if (communityOf) return scheme.communities[(communityOf[n.id] ?? 0) % scheme.communities.length]
    return scheme.kinds[n.kind] ?? scheme.kinds.other
  }

  /** 聚类分组（图例用）：社区号 → { count, 代表节点 }，按成员数降序 */
  const communityGroups = useMemo(() => {
    if (!communityOf) return null
    const groups = {}
    for (const n of nodes) (groups[communityOf[n.id]] ??= []).push(n)
    return Object.entries(groups)
      .map(([c, ns]) => ({
        c: Number(c),
        count: ns.length,
        rep: [...ns].sort((a, b) => (deg[b.id] ?? 0) - (deg[a.id] ?? 0))[0],
      }))
      .sort((a, b) => b.count - a.count)
  }, [communityOf, nodes, deg])

  // ---- 标签避让：按度数降序贪心保留放得下的标签，hover 节点必显（llm_wiki labelThreshold 思路的 SVG 版） ----
  const shownLabels = useMemo(() => {
    if (!layout) return new Set()
    const kept = []
    const boxes = []
    const order = [...nodes].sort((a, b) => (deg[b.id] ?? 0) - (deg[a.id] ?? 0))
    for (const n of order) {
      const p = layout[n.id]
      if (!p) continue
      const r = radius(n.id)
      const title = prettyTitle(n.title)
      const w = title.length * 12 + 10 // CJK 字符 ≈ 12px（fontSize 11.5）
      const box = { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y + r + 3, y1: p.y + r + 22 }
      if (boxes.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue
      boxes.push(box)
      kept.push(n.id)
    }
    return new Set(kept)
  }, [layout, nodes, deg, cfg])

  // ---- 滚轮缩放：以指针位置为锚点（native listener，非 passive 才能 preventDefault）。
  // 依赖 graph：svg 在数据加载后才渲染，必须等 ref 挂载后再绑监听，否则滚轮会穿透为页面滚动。 ----
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const sx = ((e.clientX - rect.left) / rect.width) * W
      const sy = ((e.clientY - rect.top) / rect.height) * H
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0015)
        const nz = Math.min(6, Math.max(0.3, v.zoom * factor))
        const f = nz / v.zoom
        return { zoom: nz, x: sx - (sx - v.x) * f, y: sy - (sy - v.y) * f }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [graph])

  // ---- 拖拽平移（pointer events，触屏也可用；移动 <4px 视为点击不触发平移） ----
  function onPointerDown(e) {
    dragRef.current = { sx: e.clientX, sy: e.clientY, view, moved: 0 }
  }
  function onPointerMove(e) {
    const d = dragRef.current
    if (!d) return
    const rect = svgRef.current.getBoundingClientRect()
    const dx = ((e.clientX - d.sx) / rect.width) * W
    const dy = ((e.clientY - d.sy) / rect.height) * H
    d.moved = Math.max(d.moved, Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy))
    setView((v) => ({ ...v, x: d.view.x + dx, y: d.view.y + dy }))
  }
  function onPointerUp() {
    // 稍后清除，让随后的 click 事件能读到 moved 值
    setTimeout(() => { dragRef.current = null }, 50)
  }
  /** 拖拽后松手不算点击：节点 onClick 里用它判定 */
  function wasDrag() {
    return (dragRef.current?.moved ?? 0) >= 4
  }

  const counts = {}
  for (const n of nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1

  const upd = (k) => (e) => setCfg((c) => ({ ...c, [k]: Number(e.target.value) }))

  // v0.3 D6-7：触发图谱自检并轮询状态（跑完提示去审核页看建议）
  useEffect(() => () => { if (auditTimer.current) clearInterval(auditTimer.current) }, [])
  async function runAuditCheck() {
    if (auditBusy) return
    setAuditBusy(true)
    setAuditNote('体检中…')
    try {
      await api.startAudit()
      auditTimer.current = setInterval(async () => {
        try {
          const s = await api.auditStatus()
          if (!s.running) {
            if (auditTimer.current) clearInterval(auditTimer.current)
            const o = s.lastOutcome
            setAuditNote(
              o
                ? `自检完成：${o.health.findings} 嫌疑 → ${o.proposals} 建议 → ${o.suggestionsWritten.length} 页写入 suggestions（到「审核」页处理）`
                : '自检完成',
            )
            setAuditBusy(false)
          }
        } catch { /* 轮询失败静默，下轮再试 */ }
      }, 2000)
    } catch (e) {
      setAuditNote(`触发失败：${e.message}`)
      setAuditBusy(false)
    }
  }

  return (
    <div className="page page-wide page-full">
      <h1 className="page-title">知识图谱</h1>
      <p className="page-desc">
        wiki 页面之间的 wikilink 关系网络。滚轮缩放 · 拖拽平移 · 点击节点查看页面内容。
      </p>

      {/* v0.3 D6-7：图谱自检入口（体检 → 建议 → 审核队列） */}
      <div className="audit-bar">
        <button className="btn btn-secondary btn-sm" disabled={auditBusy} onClick={runAuditCheck} title="体检 → LLM 判定 → 建议写进页面 suggestions（待人工审核）">
          {auditBusy ? '⏳ 自检中…' : '🩺 图谱自检'}
        </button>
        {auditNote && <span className="mono audit-note">{auditNote}</span>}
        <button className="btn btn-ghost btn-sm" onClick={() => go?.('review')} title="audit 建议与 AI 生成页共用审核队列">
          到审核页看建议 →
        </button>
      </div>

      {error && <div className="banner banner-danger">加载图谱失败：{error}</div>}
      {!graph && !error && (
        <div className="loading-row">
          <span className="spinner" /> 正在加载图谱数据…
        </div>
      )}

      {graph && layout && (
        <>
          {/* ---- 调节面板：标题行常显（微调折叠开关 / 导出 / 复位），滑杆默认收起 ---- */}
          <div className="card" style={{ padding: '8px 16px', marginBottom: 16 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 20px', alignItems: 'center' }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setTuneOpen((v) => !v)}
                aria-expanded={tuneOpen}
              >
                ⚙ 微调 {tuneOpen ? '▾' : '▸'}
              </button>
              <span className="mono" style={{ color: 'var(--c-text-3)', fontSize: 12, flex: 1 }}>
                节点大小随引用度增长 · 连线为 wikilink 引用
              </span>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => exportSvgToPng(svgRef.current, '知识图谱.png').catch((e) => setError(`导出失败：${e.message}`))}
                title="把当前图谱导出为 PNG 图片（2x 分辨率）"
              >
                ⤓ 导出图片
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setView({ zoom: 1, x: 0, y: 0 })}>
                重置视图
              </button>
              <span className="mono" style={{ color: 'var(--c-text-3)', fontSize: 12 }}>
                缩放 {view.zoom.toFixed(2)}×
              </span>
            </div>
            {tuneOpen && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px 28px', alignItems: 'center', padding: '12px 0 4px', borderTop: '1px solid var(--c-border)', marginTop: 10 }}>
                {[
                  { k: 'nodeBase', label: '节点大小', min: 2, max: 14, step: 0.2 },
                  { k: 'nodeScale', label: '大小差异', min: 0, max: 6, step: 0.25 },
                  { k: 'edgeWidth', label: '连线宽度', min: 0.5, max: 3, step: 0.25 },
                  { k: 'repulsion', label: '斥力间距', min: 4, max: 80, step: 2 },
                  { k: 'gravity', label: '引力聚拢', min: 0.5, max: 16, step: 0.5 },
                ].map(({ k, label, min, max, step }) => (
                  <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8125rem', color: 'var(--c-text-2)' }}>
                    {label}
                    <input type="range" min={min} max={max} step={step} value={cfg[k]} onChange={upd(k)} style={{ width: 110, accentColor: 'var(--c-primary)' }} />
                    <span className="mono" style={{ color: 'var(--c-text-3)', fontSize: 12, minWidth: 28 }}>{cfg[k]}</span>
                  </label>
                ))}
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8125rem', color: 'var(--c-text-2)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={showSources} onChange={(e) => setShowSources(e.target.checked)} />
                  显示来源节点
                </label>
              </div>
            )}
          </div>

          <div className="graph-stage">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label="知识图谱"
              style={{ cursor: dragRef.current?.moved >= 4 ? 'grabbing' : 'grab', touchAction: 'none' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            >
              <g transform={`translate(${view.x},${view.y}) scale(${view.zoom})`}>
                {/* ---- 连线层 ---- */}
                {edges.map((e, i) => {
                  const a = layout[e.source]
                  const b = layout[e.target]
                  if (!a || !b) return null
                  const active = hover && (hover === e.source || hover === e.target)
                  // hover 聚焦：非邻接边淡出，邻接边高亮（llm_wiki edgeReducer 思路）
                  const dimmed = hover && !active
                  return (
                    <line
                      key={i}
                      x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      stroke={active ? scheme.kinds.entity : '#e5e7eb'}
                      strokeWidth={active ? cfg.edgeWidth + 1 : cfg.edgeWidth}
                      opacity={dimmed ? 0.12 : 1}
                    />
                  )
                })}
                {/* ---- 节点层（不画文字）；hover 聚焦时非邻居淡出 ---- */}
                {nodes.map((n) => {
                  const p = layout[n.id]
                  if (!p) return null
                  const r = radius(n.id)
                  const isNeighbor = Boolean(hover && neighborsOf[hover]?.has(n.id))
                  const dim = Boolean(hover) && hover !== n.id && !isNeighbor
                  return (
                    <circle
                      key={n.id}
                      cx={p.x}
                      cy={p.y}
                      r={r}
                      fill={nodeColor(n)}
                      opacity={dim ? 0.16 : 1}
                      stroke={hover === n.id ? '#111827' : 'transparent'}
                      strokeWidth={hover === n.id ? 2 : 0}
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={() => setHover(n.id)}
                      onMouseLeave={() => setHover(null)}
                      onClick={() => { if (!wasDrag()) onOpenPage(n.id) }}
                    />
                  )
                })}
                {/* ---- 标签层：避让后只画放得下的；hover 节点必显；非邻居标签同步淡出 ---- */}
                {nodes.map((n) => {
                  const p = layout[n.id]
                  if (!p) return null
                  const r = radius(n.id)
                  const on = hover === n.id
                  const isNeighbor = Boolean(hover && neighborsOf[hover]?.has(n.id))
                  const dimmed = Boolean(hover) && !on && !isNeighbor
                  if (!on && !shownLabels.has(n.id)) return null
                  const title = prettyTitle(n.title)
                  const shown = on || title.length > 14 ? (title.length > 22 && !on ? `${title.slice(0, 22)}…` : title) : title
                  return (
                    <text
                      key={`t-${n.id}`}
                      x={p.x}
                      y={p.y + r + 14}
                      textAnchor="middle"
                      fontSize={on ? 14 : 11.5}
                      fontFamily="'Open Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif"
                      fontWeight={on ? 800 : 500}
                      fill={on ? '#111827' : '#6b7280'}
                      opacity={dimmed ? 0.15 : 1}
                      // 白色描边光晕：保证文字叠在连线/节点上也清晰可读
                      stroke="white"
                      strokeWidth={on ? 4 : 3}
                      paintOrder="stroke"
                      style={{ pointerEvents: 'none', userSelect: 'none' }}
                    >
                      {shown}
                    </text>
                  )
                })}
              </g>
            </svg>
            <div className="graph-tip">滚轮缩放 · 拖拽平移 · 点击节点打开页面 · 连线为 wikilink 引用</div>
            <div className="graph-legend" style={legendOpen ? undefined : { width: 'auto', padding: '8px 12px' }}>
              <div
                role="button"
                tabIndex={0}
                aria-expanded={legendOpen}
                onClick={() => setLegendOpen((v) => !v)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLegendOpen((v) => !v) } }}
                style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', userSelect: 'none', outline: 'none', margin: legendOpen ? '0 0 8px' : 0 }}
              >
                <h3 style={{ fontFamily: 'var(--font-display)', margin: 0, fontSize: '1rem', flex: 1 }}>图例</h3>
                <span
                  aria-hidden
                  className="mono"
                  style={{
                    color: 'var(--c-text-3)',
                    fontSize: 12,
                    transform: legendOpen ? 'rotate(180deg)' : 'none',
                    display: 'inline-block',
                    transition: 'transform 0.15s ease',
                  }}
                >
                  ▲
                </span>
              </div>
              {legendOpen && (
                <>
                  {/* 着色模式 + 配色方案（选择持久化到 localStorage） */}
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                    {[
                      { k: 'kind', label: '按类型' },
                      { k: 'community', label: '按聚类' },
                    ].map(({ k, label }) => (
                      <button
                        key={k}
                        onClick={() => setColorMode(k)}
                        className="btn btn-sm"
                        style={colorMode === k
                          ? { background: 'var(--c-primary)', color: '#fff', border: 'none', padding: '3px 10px', borderRadius: 6 }
                          : { background: 'none', color: 'var(--c-text-2)', border: '1px solid var(--c-border)', padding: '3px 10px', borderRadius: 6 }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 10 }} title="配色方案">
                    {Object.entries(SCHEMES).map(([k, s]) => (
                      <button
                        key={k}
                        aria-label={s.label}
                        title={s.label}
                        onClick={() => setSchemeKey(k)}
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: '50%',
                          border: schemeKey === k ? '2px solid var(--c-primary)' : '1px solid var(--c-border)',
                          background: `linear-gradient(135deg, ${s.kinds.entity} 50%, ${s.kinds.concept} 50%)`,
                          cursor: 'pointer',
                          padding: 0,
                        }}
                      />
                    ))}
                  </div>
                  {communityGroups
                    ? communityGroups.map(({ c, count, rep }) => (
                        <div key={c} className="legend-row">
                          <span className="legend-dot" style={{ background: scheme.communities[c % scheme.communities.length] }} />
                          {prettyTitle(rep.title)}
                          <span className="count">{count}</span>
                        </div>
                      ))
                    : Object.entries(KIND_LABELS).map(([k, label]) => (
                        <div key={k} className="legend-row">
                          <span className="legend-dot" style={{ background: scheme.kinds[k] }} />
                          {label}
                          <span className="count">{counts[k] ?? 0}</span>
                        </div>
                      ))}
                  <div className="legend-row" style={{ borderTop: '1px solid var(--c-border)', paddingTop: 12, marginTop: 4 }}>
                    <span className="count">节点 {nodes.length}</span>
                    <span className="count" style={{ marginLeft: 8 }}>连线 {edges.length}</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
