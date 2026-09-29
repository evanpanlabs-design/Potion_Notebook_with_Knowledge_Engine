import React, { useEffect, useMemo, useRef, useState } from 'react'
import Graph from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import { api } from '../api.js'
import { exportSvgToPng } from '../export-svg.js'

const KIND_COLORS = {
  entity: '#3b82f6',
  concept: '#8b5cf6',
  source: '#6b7280',
  note: '#f59e0b',
  other: '#9ca3af',
}
const KIND_LABELS = { entity: '实体', concept: '概念', source: '来源', note: '笔记', other: '其他' }

/** 路径式 title 美化：wiki/queries/xxx.md → xxx */
function prettyTitle(t) {
  return t.includes('/') ? t.split('/').pop().replace(/\.md$/, '') : t
}

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
export default function GraphView({ onOpenPage }) {
  const [graph, setGraph] = useState(null)
  const [error, setError] = useState('')
  const [hover, setHover] = useState(null)
  const [legendOpen, setLegendOpen] = useState(true) // 图例可折叠（默认展开）
  const [tuneOpen, setTuneOpen] = useState(false) // 微调面板可折叠（默认收起，基准参数已调好）
  const [showSources, setShowSources] = useState(false) // 来源节点默认不渲染
  // v0.2.2 基准下调：节点半径基准缩到原 70%（6→4.2，大小差异同步 2.5→1.75），
  // 引力聚拢加倍（4→8，滑块上限同步提高到 16），留出上下微调空间
  const [cfg, setCfg] = useState({ nodeBase: 4.2, nodeScale: 1.75, edgeWidth: 1, repulsion: 20, gravity: 8 })
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

  // 布局：graphology 建 + FA2 力导向 → 归一化到画布坐标（斥力参数改变时实时重排）
  const layout = useMemo(() => {
    if (!nodes.length) return null
    const g = new Graph({ multi: false })
    for (const n of nodes) {
      // FA2 要求节点必须有初始 x/y（否则 NaN 传染整个布局）
      g.addNode(n.id, { x: Math.random() * 100 - 50, y: Math.random() * 100 - 50 })
    }
    for (const e of edges) {
      if (g.hasNode(e.source) && g.hasNode(e.target) && !g.hasEdge(e.source, e.target)) {
        g.addEdge(e.source, e.target)
      }
    }
    if (g.order > 1) {
      forceAtlas2.assign(g, {
        iterations: 300,
        settings: { gravity: cfg.gravity, scalingRatio: cfg.repulsion, barnesHutOptimize: true, slowDown: 5 },
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
  }, [nodes, edges, cfg.repulsion, cfg.gravity])

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

  return (
    <div className="page page-wide">
      <h1 className="page-title">知识图谱</h1>
      <p className="page-desc">
        wiki 页面之间的 wikilink 关系网络。滚轮缩放 · 拖拽平移 · 点击节点查看页面内容。
      </p>

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
                  return (
                    <line
                      key={i}
                      x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      stroke={active ? '#3b82f6' : '#e5e7eb'}
                      strokeWidth={active ? cfg.edgeWidth + 1 : cfg.edgeWidth}
                    />
                  )
                })}
                {/* ---- 节点层（不画文字） ---- */}
                {nodes.map((n) => {
                  const p = layout[n.id]
                  if (!p) return null
                  const r = cfg.nodeBase + (deg[n.id] ?? 0) * cfg.nodeScale
                  const dim = hover && hover !== n.id
                  return (
                    <circle
                      key={n.id}
                      cx={p.x}
                      cy={p.y}
                      r={r}
                      fill={KIND_COLORS[n.kind] ?? KIND_COLORS.other}
                      opacity={dim ? 0.45 : 1}
                      stroke={hover === n.id ? '#111827' : 'transparent'}
                      strokeWidth={hover === n.id ? 2 : 0}
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={() => setHover(n.id)}
                      onMouseLeave={() => setHover(null)}
                      onClick={() => { if (!wasDrag()) onOpenPage(n.id) }}
                    />
                  )
                })}
                {/* ---- 标签层：最后绘制，任何节点都不遮挡文字；hover 强调 ---- */}
                {nodes.map((n) => {
                  const p = layout[n.id]
                  if (!p) return null
                  const r = cfg.nodeBase + (deg[n.id] ?? 0) * cfg.nodeScale
                  const on = hover === n.id
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
                  {Object.entries(KIND_LABELS).map(([k, label]) => (
                    <div key={k} className="legend-row">
                      <span className="legend-dot" style={{ background: KIND_COLORS[k] }} />
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
