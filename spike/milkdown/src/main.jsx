/* M0 spike 验证点 2：Milkdown 能否编辑含 [[wikilink]] 的 Markdown 并无损保存。
 * 结论收集器：页面 + 控制台日志 + 保存回传 server 的往返测试。 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { Editor, rootCtx, defaultValueCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { getMarkdown } from '@milkdown/kit/utils'
import { wikilinkSchema, wikilinkInputRule, WIKILINK_STYLE, WIKILINK_STRINGIFY_OPTIONS } from './wikilink-mark.jsx'

// spike 调试：把运行时错误打到页面上
window.__errs = []
window.addEventListener('error', (e) => { window.__errs.push('ERR: ' + e.message); window.__flush() })
window.addEventListener('unhandledrejection', (e) => { window.__errs.push('REJ: ' + e.reason); window.__flush() })
window.__flush = () => {
  const el = document.getElementById('errs')
  if (el) el.textContent = window.__errs.join('\n')
}

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  render() {
    if (this.state.err) return <pre style={{ color: 'crimson' }}>{String(this.state.err && this.state.err.stack || this.state.err)}</pre>
    return this.props.children
  }
}

const TEST_MD = [
  '# 笔记标题',
  '',
  '普通文本对照：加粗 **bold**。',
  '',
  '- 列表项一',
  '',
  '| 表格 | 列 |',
  '|---|---|',
  '| a | b |',
].join('\n')
// wikilink 验证不走初始加载（需 remark 解析扩展，风险最高），先验证：输入规则 + 序列化往返

function MilkdownEditor() {
  const { get } = useEditor((root) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        ctx.set(defaultValueCtx, TEST_MD)
        ctx.update(remarkStringifyOptionsCtx, (prev) => ({
          ...prev,
          handlers: { ...(prev.handlers ?? {}), ...WIKILINK_STRINGIFY_OPTIONS.handlers },
        }))
        ctx.get(listenerCtx).markdownUpdated((_, markdown) => {
          document.getElementById('output').textContent = markdown
        })
      })
      .use(commonmark)
      .use(gfm)
      .use(wikilinkSchema)
      .use(wikilinkInputRule)
      .use(history)
      .use(listener)
  )
  return (
    <Milkdown />
  )
}

function App() {
  const [recovered, setRecovered] = React.useState('')
  return (
    <div>
      <h2>Milkdown wikilink spike</h2>
      <pre id="errs" style={{ color: 'crimson', whiteSpace: 'pre-wrap' }} />
      <style>{WIKILINK_STYLE}</style>
      <MilkdownProvider>
        <MilkdownEditor />
      </MilkdownProvider>
      <button onClick={() => {
        // get() 返回 EditorView 上下文，getMarkdown 是 ctx 取值函数
        const md = getMarkdown()(get())
        setRecovered(md)
        window.__recovered = md
      }}>取回序列化 Markdown</button>
      <h3>listener 实时输出：</h3>
      <pre id="output" style={{ background: '#f5f5f5', padding: 8, whiteSpace: 'pre-wrap' }} />
      <h3>点击取回：</h3>
      <pre style={{ background: '#eee', padding: 8, whiteSpace: 'pre-wrap' }}>{recovered}</pre>
    </div>
  )
}

function Root() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  )
}

createRoot(document.getElementById('app')).render(<Root />)
