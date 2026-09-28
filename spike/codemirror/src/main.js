/* D7 spike：CodeMirror 6 编辑含 [[wikilink]] 的 Markdown——三件事验证：
 * 1. decorations 高亮 [[页面名]]（view 层着色，不改文档文本 → 保真 100%）
 * 2. autocomplete：输入 [[ 时弹出库内页面名列表（数据来自 GET /api/v1/notes + /pages）
 * 3. 保存往返：编辑器纯文本直接 POST /api/v1/notes，验证 [[ ]] 零损耗
 * 页面名数据：为简化 spike，直接 hardcode 一个列表（真实实现从 server /api/v1/graph nodes 拉） */
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { autocompletion, CompletionContext } from '@codemirror/autocomplete'
import { ViewPlugin, Decoration } from '@codemirror/view'

// ---------- 页面名数据（真实实现从 server 拉，这里 hardcode 模拟） ----------
const PAGE_NAMES = ['知识复利', '两段式 CoT ingest', 'LLM Wiki', 'Karpathy', 'NashSu/LLMWiki']

// ---------- 1. wikilink 高亮（decorations，纯 view 层不改文本） ----------
const wikilinkRegex = /\[\[([^\][\n]+)\]\]/g
function buildWikilinkDecorations(view) {
  const widgets = []
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to)
    wikilinkRegex.lastIndex = 0
    let m
    while ((m = wikilinkRegex.exec(text))) {
      widgets.push(
        Decoration.mark({ class: 'cm-wikilink', attributes: { title: `跳转到 ${m[1]}` } }).range(
          from + m.index,
          from + m.index + m[0].length,
        ),
      )
    }
  }
  return Decoration.set(widgets, true) // RangeSet<Decoration>，装饰集合
}
const wikilinkHighlighter = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildWikilinkDecorations(view) }
    update(u) { if (u.docChanged || u.viewportChanged) this.decorations = buildWikilinkDecorations(u.view) }
  },
  { decorations: (v) => v.decorations },
)

// ---------- 2. [[ 触发页面名补全 ----------
function pageNameCompletions(context) {
  const line = context.state.doc.lineAt(context.pos)
  const before = line.text.slice(0, context.pos - line.from)
  const open = before.lastIndexOf('[[')
  if (open < 0 || open < before.lastIndexOf(']')) return null // 不在 [[... 未闭合区间内
  const typed = before.slice(open + 2)
  return {
    from: context.pos - typed.length,
    options: PAGE_NAMES.map((name) => ({ label: name, type: 'variable', apply: `${name}]]` })),
    validFor: /^[^\][\n]*$/,
  }
}

// ---------- 组装编辑器 ----------
const INITIAL = [
  '# 我的笔记',
  '',
  '思考：知识引擎的价值在于 [[知识复利]]，机制参考 [[两段式 CoT ingest]]。',
  '输入 [[ 试试自动补全。',
].join('\n')

const view = new EditorView({
  parent: document.getElementById('editor'),
  state: EditorState.create({
    doc: INITIAL,
    extensions: [
      lineNumbers(),
      history(),
      highlightActiveLine(),
      markdown({ language: markdownLanguage }),
      wikilinkHighlighter,
      autocompletion({ override: [pageNameCompletions] }),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
    ],
  }),
})

// ---------- 3. 保存往返 ----------
const status = document.getElementById('status')
document.getElementById('dump').onclick = () => {
  status.textContent = view.state.doc.toString()
}
document.getElementById('save').onclick = async () => {
  // 关键点：编辑器内容是纯文本，直接 POST，无任何序列化层
  const res = await fetch('/api/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'cm6-spike-note.md', title: 'CodeMirror spike 笔记', content: view.state.doc.toString() }),
  })
  status.textContent = '保存结果: ' + JSON.stringify(await res.json())
}

window.__getDoc = () => view.state.doc.toString()
