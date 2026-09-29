import React, { useEffect, useRef } from 'react'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx } from '@milkdown/kit/core'
import { getMarkdown } from '@milkdown/kit/utils'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { wikilinkKit, applyWikilinkStringify } from './wikilink.js'
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
 */

function MilkdownEditorInner({ initial, pages, onOpenTitle, onMarkdown }) {
  // pages 走 ref：候选列表变化不重建编辑器，补全插件读最新值
  const pagesRef = useRef(pages)
  pagesRef.current = pages
  // 代际 token：编辑器重建（initial 变化）后旧编辑器迟到的 markdownUpdated 回调全部丢弃。
  // 注意：++ 必须在渲染期（factory 在子组件 effect 里被调用，早于父组件 effect）
  const epochRef = useRef(0)
  const lastInitialRef = useRef(initial)
  if (lastInitialRef.current !== initial) {
    lastInitialRef.current = initial
    epochRef.current++
  }

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
    },
    [initial],
  )

  // 关键：markdownUpdated 只在文档「变化」时触发，不对初始装配触发。
  // 装配完成后主动取一次规范化产物上抛，否则上层 editorMd 停在 ''，
  // 带改动切换/保存会话里会拿空正文落盘（曾致正文清空事故）。
  useEffect(() => {
    if (loading) return
    const ed = get()
    if (!ed) return
    try {
      // getMarkdown action 同步返回规范化字符串（非 promise）
      const md = ed.action(getMarkdown())
      onMarkdown?.(md)
    } catch {
      /* 编辑器异常由 ErrorBoundary 兜底 */
    }
  }, [loading, initial])

  return <Milkdown />
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
