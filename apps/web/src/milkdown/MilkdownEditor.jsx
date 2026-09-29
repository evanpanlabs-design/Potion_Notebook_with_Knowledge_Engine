import React, { useEffect, useRef, useState } from 'react'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx, editorViewCtx } from '@milkdown/kit/core'
import { getMarkdown, callCommand, $prose } from '@milkdown/kit/utils'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm, insertTableCommand, columnResizingPlugin } from '@milkdown/kit/preset/gfm'
import { Plugin } from '@milkdown/kit/prose/state'
import {
  addRowBefore,
  addRowAfter,
  addColumnBefore,
  addColumnAfter,
  deleteRow,
  deleteColumn,
  deleteTable,
} from '@milkdown/kit/prose/tables'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { wikilinkKit, applyWikilinkStringify } from './wikilink.js'
import { tableInfoFromView, moveTable, setColumnAlign } from './tableOps.js'
import { ensurePageIndex, resolveTitle } from '../md.js'

/**
 * Milkdown 所见即所得编辑器（feat/milkdown-editor）。
 *
 * 数据流（磁盘格式零改动）：
 *   load:  content → loadForEditor（剥 frontmatter + mixedToBare）→ defaultValue
 *   save:  getMarkdown() → saveFromEditor（foldEscapedBrackets）→ joinFrontmatter → 由父组件落盘
 *
 * 文档切换：useEditor 的 deps 变化 → 编辑器整体重建（@milkdown/react 官方模式）。
 * wikilinkKit：remark 扩展（原生 [[...]] 解析）+ inline 节点 + 输入规则 + [[ 补全 + 单击跳转。
 * 表格：gfm 预设（含列宽拖拽）+ 光标所在表格的浮动工具栏（增删行列/对齐/整表移动删除）。
 */

function MilkdownEditorInner({ initial, pages, onOpenTitle, onMarkdown, actionRef }) {
  // pages 走 ref：候选列表变化不重建编辑器，补全插件读最新值
  const pagesRef = useRef(pages)
  pagesRef.current = pages
  // 代际 token：编辑器重建（initial 变化）后旧编辑器的迟到回调全部丢弃。
  // 注意：++ 必须在渲染期（factory 在子组件 effect 里被调用，早于父组件 effect）
  const epochRef = useRef(0)
  const lastInitialRef = useRef(initial)
  if (lastInitialRef.current !== initial) {
    lastInitialRef.current = initial
    epochRef.current++
  }

  // 表格浮动工具栏：Plugin update → 计算「光标是否在表格内 + 视口矩形」→ setState
  const [tableCtx, setTableCtx] = useState(null)
  const viewRef = useRef(null)
  // ref 中转：编辑器工厂闭包捕获 ref，回调永远走最新值（避免闭包过期）
  const tableViewCbRef = useRef(null)
const handleTableView = (view) => {
const info = tableInfoFromView(view)
  setTableCtx(info ? { row: info.row, col: info.col, top: info.rect.top, left: info.rect.left, width: info.rect.width } : null)
}
  tableViewCbRef.current = handleTableView

  const { loading, get } = useEditor(
    (root) => {
      const epoch = epochRef.current
      return Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root)
          ctx.set(defaultValueCtx, initial)
          ctx.update(editorViewOptionsCtx, (prev) => ({
            ...prev,
            attributes: { class: 'milk-editor', spellcheck: 'false' },
          }))
          applyWikilinkStringify(ctx)
          ctx.get(listenerCtx).markdownUpdated((_, markdown) => {
            if (epoch !== epochRef.current) return // 旧编辑器的迟到回调，丢弃
            onMarkdown?.(markdown)
          })
        })
        .use(commonmark)
        .use(gfm)
        // preset-gfm 导出了 columnResizingPlugin 但未组合进 gfm（表格包内无它），
        // 不显式挂载则列宽拖拽不生效
        .use(columnResizingPlugin)
        .use(history)
        .use(listener)
        .use(
          wikilinkKit({
            pagesGetter: () => pagesRef.current,
            onOpenTitle: (title) => {
              void ensurePageIndex().then(() => {
                const path = resolveTitle(title)
                if (path) onOpenTitle(path)
              })
            },
          }),
        )
        .use(
          // 光标所在表格监测：每次事务后刷新工具栏状态
          $prose(
            () =>
              new Plugin({
                view: () => ({
                  update: (view) => tableViewCbRef.current?.(view),
                }),
              }),
          ),
        )
    },
    [initial],
  )

  // 表格工具栏操作入口（也通过 actionRef 暴露给父组件）
  const tableActionsRef = useRef({})
  useEffect(() => {
    if (loading) return
    const ed = get()
    if (!ed) return
    try {
      ed.action((ctx) => {
        viewRef.current = ctx.get(editorViewCtx)
      })
    } catch {
      /* ignore */
    }
    // 编辑器重建（fast-refresh / 文档切换）后 Plugin.view.update 不会自动触发，
    // 立即按新实例的 selection 重算工具栏，避免旧 state 残留导致按钮空转
    tableViewCbRef.current?.(viewRef.current)
    // prosemirror-tables 命令统一走 (state, dispatch)
    const runProse = (cmd) => {
      const view = viewRef.current
      if (!view) return false
      try {
        return cmd(view.state, view.dispatch, view) ?? true
      } catch {
        return false
      }
    }
    const runKit = (cmd, payload) => {
      try {
        ed.action(callCommand(cmd.key, payload))
        return true
      } catch {
        return false
      }
    }
    const actions = {
      insertTable: (row = 3, col = 3) => runKit(insertTableCommand, { row, col }),
      addRowAbove: () => runProse(addRowBefore),
      addRowBelow: () => runProse(addRowAfter),
      deleteRow: () => runProse(deleteRow),
      addColLeft: () => runProse(addColumnBefore),
      addColRight: () => runProse(addColumnAfter),
      deleteCol: () => runProse(deleteColumn),
      deleteTable: () => runProse(deleteTable),
      // GFM 对齐是列级语义（序列化只读表头行的 alignment）。
      // 官方 setAlignCommand 只改光标所在 cell，正文 cell 会被 keepTableAlignPlugin
      // 回滚成表头对齐 → 净效果空转。改为一次性设置整列所有 cell，与插件预期一致。
      setAlign: (a) => setColumnAlign(viewRef.current, a),
      moveTable: (dir) => moveTable(viewRef.current, dir),
    }
    tableActionsRef.current = actions
    if (actionRef) actionRef.current = actions
    try {
      // getMarkdown action 同步返回规范化字符串（非 promise）
      const md = ed.action(getMarkdown())
      onMarkdown?.(md)
    } catch {
      /* 编辑器异常由 ErrorBoundary 兜底 */
    }
    // 滚动/窗口变化时重新定位工具栏
    const reposition = () => tableViewCbRef.current?.(viewRef.current)
    document.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
      if (actionRef) actionRef.current = null
    }
  }, [loading, initial])

  const act = (fn, arg) => tableActionsRef.current?.[fn]?.(arg)
  // 工具栏定位：表格上缘外挂；顶部放不下时贴进表格内；
  // 左右 clamp 到视口内（窗口较窄时工具栏会溢出右侧导致按钮无法点击）
  const barRef = useRef(null)
  const barTop = tableCtx ? (tableCtx.top - 36 >= 8 ? tableCtx.top - 36 : tableCtx.top + 6) : 0
  const barLeft = tableCtx
    ? Math.max(8, Math.min(tableCtx.left, window.innerWidth - (barRef.current?.offsetWidth || 260) - 8))
    : 0

  return (
    <>
      <Milkdown />
      {tableCtx && (
        <div ref={barRef} className="table-toolbar" style={{ top: barTop, left: barLeft }}>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => act('addRowAbove')} title="在当前行上方插入一行">↑行</button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => act('addRowBelow')} title="在当前行下方插入一行">↓行</button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => act('deleteRow')} title="删除当前行" className="tt-danger">✕行</button>
          <span className="tt-sep" />
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => act('addColLeft')} title="在当前列左侧插入一列">←列</button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => act('addColRight')} title="在当前列右侧插入一列">→列</button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => act('deleteCol')} title="删除当前列" className="tt-danger">✕列</button>
          <span className="tt-sep" />
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => act('setAlign', 'left')} title="本列左对齐">左</button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => act('setAlign', 'center')} title="本列居中">中</button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => act('setAlign', 'right')} title="本列右对齐">右</button>
          <span className="tt-sep" />
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => act('moveTable', -1)} title="整表上移（与上一块交换）">↑表</button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => act('moveTable', 1)} title="整表下移（与下一块交换）">↓表</button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => act('deleteTable')} title="删除整表（Ctrl+Z 可撤销）" className="tt-danger">✕表</button>
        </div>
      )}
    </>
  )
}

export default class MilkdownEditor extends React.Component {
  constructor(props) {
    super(props)
    this.state = { err: null }
  }
  static getDerivedStateFromError(err) {
    return { err: String(err?.message ?? err) }
  }
  render() {
    if (this.state.err) {
      return (
        <div className="banner banner-danger" style={{ margin: 12 }}>
          Milkdown 编辑器加载失败：{this.state.err}
          <div className="mono" style={{ marginTop: 6, fontSize: 12 }}>
            请切换「源码模式」继续编辑（编辑器右上角切换按钮），并把此错误反馈给开发者。
          </div>
        </div>
      )
    }
    return (
      <MilkdownProvider>
        <MilkdownEditorInner {...this.props} />
      </MilkdownProvider>
    )
  }
}
