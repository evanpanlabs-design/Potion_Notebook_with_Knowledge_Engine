import React, { useMemo } from 'react'

const KIND_COLORS = {
  entity: '#3b82f6',
  concept: '#8b5cf6',
  source: '#6b7280',
  query: '#16a34a',
  other: '#9ca3af',
}

const KIND_LABELS = { entity: '实体', concept: '概念', source: '来源', query: '问答', other: '其他' }

/**
 * 局部子图（问答后展示）：种子页居中、一跳邻居环绕的径向 SVG mini 图。
 * 轻量无依赖（不复用 forceatlas2），节点可点击跳页。
 * props.data: { seeds: string[], nodes: [{id,title,kind}], edges: [{source,target}] }
 */
export default function MiniGraph({ data, onOpenPage, height = 300 }) {
  const layout = useMemo(() => {
    const nodes = data?.nodes ?? []
    const edges = data?.edges ?? []
    const seedList = (data?.seeds ?? []).map((s) => (typeof s === 'string' ? s : s?.id)).filter(Boolean)
    const seedSet = new Set(seedList)
    const isSeed = (n) => seedSet.has(n.id)
    const seeds = nodes.filter(isSeed)
    const ring = nodes.filter((n) => !isSeed(n))
    const W = 560
    const H = height
    const cx = W / 2
    const cy = H / 2
    const pos = {}
    if (seeds.length === 1) {
      pos[seeds[0].id] = { x: cx, y: cy }
    } else if (seeds.length > 1) {
      const r0 = Math.min(W, H) * 0.18
      seeds.forEach((n, i) => {
        const a = (2 * Math.PI * i) / seeds.length - Math.PI / 2
        pos[n.id] = { x: cx + r0 * Math.cos(a), y: cy + r0 * Math.sin(a) }
      })
    }
    const r1 = Math.min(W, H) * 0.4
    ring.forEach((n, i) => {
      const a = (2 * Math.PI * i) / Math.max(ring.length, 1) - Math.PI / 2
      pos[n.id] = { x: cx + r1 * Math.cos(a), y: cy + r1 * Math.sin(a) }
    })
    return { W, H, nodes, edges, pos, seeds: seedSet }
  }, [data, height])

  if (!layout.nodes.length) return null

  const { W, H, nodes, edges, pos, seeds } = layout

  return (
    <div className="minigraph-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="minigraph-svg" role="img" aria-label="问答关联知识图谱">
        {edges.map((e, i) => {
          const a = pos[e.source]
          const b = pos[e.target]
          if (!a || !b) return null
          const seedEdge = seeds.has(e.source) || seeds.has(e.target)
          return (
            <line
              key={`e${i}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={seedEdge ? '#4a9e8f' : 'var(--c-border)'}
              strokeWidth={seedEdge ? 1.6 : 1}
              opacity={seedEdge ? 0.75 : 0.5}
            />
          )
        })}
        {nodes.map((n) => {
          const p = pos[n.id]
          if (!p) return null
          const isSeed = seeds.has(n.id)
          const r = isSeed ? 9 : 6
          return (
            <g key={n.id} className="minigraph-node" onClick={() => onOpenPage?.(n.id)} style={{ cursor: 'pointer' }}>
              <circle cx={p.x} cy={p.y} r={r + 6} fill="transparent" />
              <circle cx={p.x} cy={p.y} r={r} fill={KIND_COLORS[n.kind] ?? KIND_COLORS.other} stroke={isSeed ? '#4a9e8f' : 'transparent'} strokeWidth={2} />
              <text x={p.x} y={p.y + r + 13} textAnchor="middle" className="minigraph-label">
                {n.title.length > 14 ? `${n.title.slice(0, 13)}…` : n.title}
              </text>
            </g>
          )
        })}
      </svg>
      <div className="minigraph-legend">
        {Object.entries(KIND_LABELS).map(([k, label]) => (
          <span key={k} className="legend-row">
            <span className="legend-dot" style={{ background: KIND_COLORS[k] }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}
