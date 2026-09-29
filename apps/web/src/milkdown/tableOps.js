/**
 * Milkdown 表格操作（feat/milkdown-editor）。
 *
 * 依赖 @milkdown/preset-gfm 的表格 schema（table > tr > td/th）与内置
 * columnResizing 插件（列宽拖拽）。本模块提供：
 *   - tableInfoFromView(view)：定位光标所在表格（位置 / 行列号 / 视口矩形），
 *     供浮动工具栏显隐与定位
 *   - moveTable(view, dir)：整表上移/下移（与相邻兄弟块交换事务）
 *
 * 增删行列、对齐等操作直接用 prosemirror-tables 命令（经 @milkdown/kit/prose/tables
 * 导出）+ gfm 的 setAlignCommand，在 MilkdownEditor.jsx 里调用。
 */

/** 表格节点类型名（preset-gfm schema） */
const TABLE_TYPE = 'table'

/** 光标所在表格信息：{ pos, row, col, rect:{top,left,width} }；不在表格中返回 null */
export function tableInfoFromView(view) {
  if (!view) return null
  const { state } = view
  if (!state || state.selection == null) return null
  const { $from } = state.selection
  let depth = null
  for (let d = $from.depth; d >= 1; d--) {
    if ($from.node(d).type.name === TABLE_TYPE) {
      depth = d
      break
    }
  }
  if (depth == null) return null
  const pos = $from.before(depth)
  const dom = view.nodeDOM(pos)
  if (!dom || typeof dom.getBoundingClientRect !== 'function') return null
  const rect = dom.getBoundingClientRect()
  return {
    pos,
    row: $from.index(depth + 1), // tr 在 table 中的序号（行号）
    col: $from.index(depth + 2), // 单元格在行中的序号（列号，含合并单元格时近似）
    rect: { top: rect.top, left: rect.left, width: rect.width },
  }
}

/** 整列对齐：GFM 表格的对齐是列级语义（序列化时只读表头行 cell 的 alignment），
 *  且 preset-gfm 的 keepTableAlignPlugin 会把正文 cell 对齐回滚成表头对齐。
 *  故一次事务内把光标所在列的全部 cell（含表头）统一设为 value，避免逐 cell 设置被回滚。 */
export function setColumnAlign(view, value) {
  if (!view) return false
  const info = tableInfoFromView(view)
  if (!info) return false
  const { state, dispatch } = view
  const table = state.doc.nodeAt(info.pos)
  if (!table) return false
  const col = info.col
  const tr = state.tr
  let pos = info.pos + 1
  let changed = 0
  table.forEach((row) => {
    let i = 0
    let cellPos = pos + 1
    row.forEach((cell) => {
      if (i === col && cell.attrs.alignment !== value) {
        tr.setNodeMarkup(cellPos, null, { ...cell.attrs, alignment: value })
        changed++
      }
      i++
      cellPos += cell.nodeSize
    })
    pos += row.nodeSize
  })
  if (!changed) return false
  dispatch(tr)
  return true
}

/** 整表上移(dir=-1)/下移(dir=1)：与相邻兄弟块交换位置。边界（首/末）返回 false。 */
export function moveTable(view, dir) {
  if (!view) return false
  const info = tableInfoFromView(view)
  if (!info) return false
  const { state, dispatch } = view
  const pos = info.pos
  const node = state.doc.nodeAt(pos)
  if (!node) return false
  const $pos = state.doc.resolve(pos)
  const parent = $pos.parent
  const index = $pos.index()
  if (dir < 0 && index === 0) return false
  if (dir > 0 && index >= parent.childCount - 1) return false

  const tr = state.tr
  const size = node.nodeSize
  tr.delete(pos, pos + size)
  if (dir < 0) {
    const prev = parent.child(index - 1)
    tr.insert(pos - prev.nodeSize, node) // 删除点之前的插入位置不受该删除影响
  } else {
    const next = parent.child(index + 1)
    tr.insert(pos + next.nodeSize, node) // 删除后 next 左移 size，表插到它后面
  }
  dispatch(tr.scrollIntoView())
  return true
}
