import React, { useEffect, useMemo, useState } from 'react'
import Graph from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import { api } from '../api.js'

const KIND_COLORS = {
  entity: '#3b82f6',
  concept: '#8b5cf6',
  source: '#6b7280',
  query: '#16a34a',
  other: '#9ca3af',
}
const KIND_LABELS = { entity: '实体', concept: '概念', source: '来源', query: '问答', other: '其他' }

/** 路径式 title 美化：wiki/queries/xxx.md → xxx */
function prettyTitle(t) {
  return t.includes('/') ? t.split('/').pop().replace(/\.md$/, '') : t
}

const W = 900
const H = 560
const PAD = 70

/**
 * 知识图谱页（F7）：wikilink 关系网络。
 * MVP 渲染用 SVG（数据量 <10²，无 WebGL 依赖，headless 也可用）；规模上来后再切 sigma.js。
 */
export default function GraphView({ onOpenPage }) {
  const [graph, setGraph] = useState(null)
  const [error, setError] = useState('')
  const [hover, setHover] = useState(null)

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

  // 布局：graphology 建 + FA2 力导向 → 归一化到画布坐标
  const layout = useMemo(() => {
    if (!graph) return null
    const g = new Graph({ multi: false })
    const degree = {}
    for (const n of graph.nodes) {
      // FA2 要求节点必须有初始 x/y（否则 NaN 传染整个布局）
      g.addNode(n.id, { x: Math.random() * 100 - 50, y: Math.random() * 100 - 50 })
    }
    for (const e of graph.edges) {
      if (g.hasNode(e.source) && g.hasNode(e.target) && !g.hasEdge(e.source, e.target)) {
        g.addEdge(e.source, e.target)
      }
    }
    if (g.order > 1) {
      forceAtlas2.assign(g, {
        iterations: 300,
        settings: { gravity: 2, scalingRatio: 20, barnesHutOptimize: true, slowDown: 5 },
      })
    }
    // 孤立节点摊在圆环上
    const linked = new Set()
    graph.edges.forEach((e) => {
      linked.add(e.source)
      linked.add(e.target)
    })
    const isolated = graph.nodes.filter((n) => !linked.has(n.id))
    isolated.forEach((n, i) => {
      const angle = (i / Math.max(1, isolated.length)) * Math.PI * 2
      g.setNodeAttribute(n.id, 'x', Math.cos(angle) * 50)
      g.setNodeAttribute(n.id, 'y', Math.sin(angle) * 50)
    })

    // 归一化
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const n of graph.nodes) {
      const x = g.getNodeAttribute(n.id, 'x')
      const y = g.getNodeAttribute(n.id, 'y')
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    const sx = (maxX - minX) || 1
    const sy = (maxY - minY) || 1
    const pos = {}
    const deg = {}
    for (const e of graph.edges) {
      deg[e.source] = (deg[e.source] ?? 0) + 1
      deg[e.target] = (deg[e.target] ?? 0) + 1
    }
    for (const n of graph.nodes) {
      const x = g.getNodeAttribute(n.id, 'x')
      const y = g.getNodeAttribute(n.id, 'y')
      pos[n.id] = {
        x: PAD + ((x - minX) / sx) * (W - PAD * 2),
        y: PAD + ((y - minY) / sy) * (H - PAD * 2),
        r: 6 + (deg[n.id] ?? 0) * 2.5,
      }
    }
    return pos
  }, [graph])

  const counts = {}
  if (graph) for (const n of graph.nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1

  return (
    <div className="page page-wide">
      <h1 className="page-title">知识图谱</h1>
      <p className="page-desc">wiki 页面之间的 wikilink 关系网络。点击节点查看页面内容。</p>

      {error && <div className="banner banner-danger">加载图谱失败：{error}</div>}
      {!graph && !error && (
        <div className="loading-row">
          <span className="spinner" /> 正在加载图谱数据…
        </div>
      )}

      {graph && layout && (
        <div className="graph-layout">
          <div className="graph-canvas" style={{ height: 'auto' }}>
            <svg
              viewBox={`0 0 ${W} ${H}`}
              style={{ display: 'block', width: '100%' }}
              role="img"
              aria-label="知识图谱"
            >
              {graph.edges.map((e, i) => {
                const a = layout[e.source]
                const b = layout[e.target]
                if (!a || !b) return null
                const active = hover && (hover === e.source || hover === e.target)
                return (
                  <line
                    key={i}
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={active ? '#3b82f6' : '#e5e7eb'}
                    strokeWidth={active ? 2 : 1}
                  />
                )
              })}
              {graph.nodes.map((n) => {
                const p = layout[n.id]
                if (!p) return null
                return (
                  <g
                    key={n.id}
                    transform={`translate(${p.x},${p.y})`}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => onOpenPage(n.id)}
                  >
                    <circle r={p.r} fill={KIND_COLORS[n.kind] ?? KIND_COLORS.other} opacity={hover && hover !== n.id ? 0.45 : 1} />
                    <text
                      y={p.r + 14}
                      textAnchor="middle"
                      fontSize={12}
                      fontFamily="var(--font-body)"
                      fontWeight={600}
                      fill="#374151"
                    >
                      {prettyTitle(n.title).length > 14 ? `${prettyTitle(n.title).slice(0, 14)}…` : prettyTitle(n.title)}
                    </text>
                  </g>
                )
              })}
            </svg>
            <div className="graph-tip">点击节点打开页面 · 连线为 wikilink 引用</div>
          </div>
          <div className="card graph-legend">
            <h3 style={{ fontFamily: 'var(--font-display)', margin: '0 0 8px', fontSize: '1rem' }}>图例</h3>
            {Object.entries(KIND_LABELS).map(([k, label]) => (
              <div key={k} className="legend-row">
                <span className="legend-dot" style={{ background: KIND_COLORS[k] }} />
                {label}
                <span className="count">{counts[k] ?? 0}</span>
              </div>
            ))}
            <div className="legend-row" style={{ borderTop: '1px solid var(--c-border)', paddingTop: 12, marginTop: 4 }}>
              <span className="count">节点 {graph.nodes.length}</span>
              <span className="count" style={{ marginLeft: 8 }}>连线 {graph.edges.length}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
