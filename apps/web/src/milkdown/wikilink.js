/**
 * wikilink 的 Milkdown 原生支持（磁盘格式不变，编辑器原生吃下 [[...]]）。
 *
 * 组成（与 D6 spike 的 mark 路线不同，本路线经 72 文件语料 roundtrip 验证）：
 *  1. wikilinkRemark   —— 把 Foam 生态 micromark/mdast 扩展注入 milkdown 的
 *                        remarkCtx（parse+stringify 共用一个 unified 处理器）
 *  2. wikilinkNode     —— inline atom 节点：attrs { target, alias }，值存 attrs
 *                        不存文本，杜绝「文本与括号本体混叠」类污染
 *  3. wikilinkInputRule—— 键入完整 [[target]] / [[target|alias]] 时转为节点
 *  4. wikilinkSuggest  —— 键入 [[ 触发页面名补全弹窗（纯 DOM 自包含，↑↓ Enter Esc）
 *  5. wikilinkInteract —— 单击跳转页面、✎ 按钮改 target/alias
 *
 * 序列化侧不用 mdast-util-wiki-link 的 toMarkdown 扩展（其 unsafe 规则会给
 * 行内 [ 注入 \、给值内 _ 注入 \）——改为自写 handler 直接拼字符串，绕过
 * safe() 转义层；残余的 mdast-util-to-markdown 基础转义由 serialize.js 的
 * foldEscapedBrackets 兜底。
 */
// 显式引 ESM 产物：该包 browser 字段指向 UMD，且无 default export（仅命名导出 syntax/html）
import { syntax } from 'micromark-extension-wiki-link/dist/index.esm.js'
import { fromMarkdown } from 'mdast-util-wiki-link'
import { $node, $inputRule, $remark, $proseAsync } from '@milkdown/kit/utils'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { schemaCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core'

const ALIAS_DIVIDER = '|'

/** 1. remark 层：解析 [[target]] / [[target|alias]]（代码块/行内代码天然保护）。
 *  注意 $remark 第一参是 slice id，第二参才是插件工厂——漏传 id 会静默不注册 */
export const wikilinkRemark = $remark(
  'wikilink-remark',
  () => {
    return function wikiLinkPlugin() {
      const data = this.data()
      const add = (field, value) => {
        if (!data[field]) data[field] = []
        data[field].push(value)
      }
      add('micromarkExtensions', syntax({ aliasDivider: ALIAS_DIVIDER }))
      add('fromMarkdownExtensions', fromMarkdown({ aliasDivider: ALIAS_DIVIDER }))
    }
  },
)

/** 自写 stringify handler（不注入 toMarkdown 扩展，绕过 safe() 转义）。
 *  供 Editor.config 的 remarkStringifyOptionsCtx 合并使用。 */
export const WIKILINK_STRINGIFY_HANDLER = {
  wikiLink(node) {
    const value = node.value ?? ''
    const alias = node.data?.alias
    return alias && alias !== value ? `[[${value}${ALIAS_DIVIDER}${alias}]]` : `[[${value}]]`
  },
}

/** 2. inline atom 节点。display 文本取 alias ?? target；# 锚点随 target 原样保存。 */
export const wikilinkNode = $node('wikilink', () => ({
  inline: true,
  group: 'inline', // 必须显式声明：PM 的 inline:true 不会自动加入 inline group，否则 paragraph 拒绝该节点（静默丢段）
  atom: true,
  attrs: {
    target: { default: '' },
    alias: { default: null },
  },
  parseDOM: [
    {
      tag: 'span[data-wikilink]',
      getAttrs: (dom) => ({
        target: dom.getAttribute('data-wikilink') || '',
        alias: dom.getAttribute('data-alias') || null,
      }),
    },
  ],
  toDOM: (node) => [
    'span',
    {
      'data-wikilink': node.attrs.target,
      'data-alias': node.attrs.alias || undefined,
      class: 'wikilink',
      title: `双链：${node.attrs.target}${node.attrs.alias ? `（显示为 ${node.attrs.alias}）` : ''}\n单击打开页面 · ✎ 修改`,
    },
    node.attrs.alias || node.attrs.target,
    ['span', { class: 'wl-edit', contenteditable: 'false', title: '修改链接' }, '✎'],
  ],
  parseMarkdown: {
    match: (node) => node.type === 'wikiLink',
    runner: (state, node, type) => {
      const alias = node.data?.alias
      state.addNode(type, {
        target: node.value ?? '',
        // Foam 扩展在无别名时令 data.alias === value，这里还原为 null
        alias: alias && alias !== node.value ? alias : null,
      })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'wikilink',
    runner: (state, node) => {
      state.addNode(
        'wikiLink',
        undefined,
        node.attrs.target,
        node.attrs.alias ? { data: { alias: node.attrs.alias } } : {},
      )
    },
  },
}))

/** 3. 输入规则：完整键入 [[xxx]] / [[xxx|alias]] 时收成节点 */
export const wikilinkInputRule = $inputRule((ctx) => {
  const schema = ctx.get(schemaCtx)
  const markType = schema.nodes['wikilink']
  return new InputRule(/\[\[([^|\][\n]+?)(?:\|([^\][\n]+?))?\]\]$/, (state, match) => {
    const [, target, alias] = match
    const to = state.selection.from
    const from = to - match[0].length
    return state.tr.replaceWith(
      from,
      to,
      markType.create({ target: target.trim(), alias: alias?.trim() || null }),
    )
  })
})

// ---------- 4. [[ 补全弹窗（纯 DOM，自包含；pagesGetter 返回 [{title}] 形状） ----------

const suggestKey = new PluginKey('WIKILINK_SUGGEST')

/** 检测光标前是否有未闭合的 [[，返回 { from, to, query } 或 null */
function detectSuggest(state) {
  const { $anchor } = state.selection
  const parent = $anchor.parent
  if (!parent.isTextblock || parent.type.name === 'code_block') return null
  const textBefore = parent.textBetween(0, $anchor.parentOffset, undefined, '\ufffc')
  const open = textBefore.lastIndexOf('[[')
  if (open === -1) return null
  const query = textBefore.slice(open + 2)
  if (query.includes(']') || query.includes('\ufffc') || query.includes('[')) return null
  const from = $anchor.pos - query.length - 2
  return { from, to: $anchor.pos, query }
}

export function wikilinkSuggest(pagesGetter) {
  // $proseAsync（非 $prose）：普通 $prose 只等 SchemaReady 就注册，与 editorState 读取
  // prosePluginsCtx 存在竞态，state 可能建好时插件未注册（症状：弹窗/decoration 从不出现）。
  // $proseAsync 经 addTimer 挂进 editorStateTimerCtx，保证注册先于 state 创建。
  return $proseAsync(() => {
    let selected = 0
    let filtered = []
    let hideUntil = 0 // Escape 后本次输入不再弹出

    const popup = document.createElement('div')
    popup.className = 'wl-suggest'
    popup.style.display = 'none'
    document.body.appendChild(popup)

    let active = false

    function renderList(view) {
      const st = suggestKey.getState(view.state)
      if (!st) return hide()
      const q = st.query.trim().toLowerCase()
      const titles = (pagesGetter() || [])
        .map((p) => p.title)
        .filter((t) => t && !t.includes(']]') && !t.includes('|'))
      filtered = q ? titles.filter((t) => t.toLowerCase().includes(q)) : titles
      if (filtered.length === 0) return hide()
      if (selected >= filtered.length) selected = 0
      popup.innerHTML = ''
      filtered.slice(0, 12).forEach((title, i) => {
        const item = document.createElement('div')
        item.className = 'wl-suggest-item' + (i === selected ? ' active' : '')
        item.textContent = title
        item.addEventListener('mousedown', (e) => {
          e.preventDefault()
          pick(view, title)
        })
        popup.appendChild(item)
      })
      popup.style.display = 'block'
      active = true
      position(view)
    }

    function position(view) {
      const st = suggestKey.getState(view.state)
      if (!st) return
      const coords = view.coordsAtPos(st.to)
      popup.style.left = `${Math.min(coords.left, window.innerWidth - 280)}px`
      popup.style.top = `${coords.bottom + 6}px`
    }

    function hide() {
      popup.style.display = 'none'
      active = false
      selected = 0
    }

    function pick(view, title) {
      const st = suggestKey.getState(view.state)
      if (!st) return
      const nodeType = view.state.schema.nodes['wikilink']
      const tr = view.state.tr
        .replaceWith(st.from, st.to, nodeType.create({ target: title }))
        .insertText(' ')
      view.dispatch(tr.scrollIntoView())
      hide()
      view.focus()
    }

    return new Plugin({
      key: suggestKey,
    state: {
      init: () => null,
      apply(tr, prev) {
        if (!tr.docChanged && !tr.selectionSet) return prev
        if (tr.docChanged) hideUntil = 0
        // Escape 抑制期内：文本再变才重新激活
        if (Date.now() < hideUntil) return null
        return detectSuggest(tr) ?? null
      },
    },
      props: {
        decorations(state) {
          const st = suggestKey.getState(state)
          if (!st) return DecorationSet.empty
          return DecorationSet.create(state.doc, [
            Decoration.inline(st.from, st.from + 2, { class: 'wl-brackets' }),
          ])
        },
        handleKeyDown(view, event) {
          const st = suggestKey.getState(view.state)
          if (!st) return false
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            const n = filtered.length
            if (!n) return false
            selected = event.key === 'ArrowDown' ? (selected + 1) % n : (selected - 1 + n) % n
            renderList(view)
            return true
          }
          if (event.key === 'Enter') {
            if (filtered.length === 0) return false
            pick(view, filtered[selected])
            return true
          }
          if (event.key === 'Escape') {
            hideUntil = Date.now() + 60_000 // 本次不再弹出，直到文本再变
            hide()
            return true
          }
          return false
        },
      },
      view(view) {
        return {
          update(v) {
            const st = suggestKey.getState(v.state)
            if (st) renderList(v)
            else hide()
          },
          destroy() {
            popup.remove()
          },
        }
      },
    })
  })
}

// ---------- 5. 单击跳转 + ✎ 修改（onOpenPage(title) 由上层解析 path） ----------

export function wikilinkInteract(onOpenTitle, promptEdit) {
  return $proseAsync(() =>
    new Plugin({
      key: new PluginKey('WIKILINK_INTERACT'),
      props: {
        handleDOMEvents: {
          mousedown(view, event) {
            const editBtn = event.target.closest?.('.wl-edit')
            if (editBtn) {
              event.preventDefault()
              const span = editBtn.closest('.wikilink')
              const target = span?.getAttribute('data-wikilink') || ''
              const alias = span?.getAttribute('data-alias') || ''
              const input = promptEdit
                ? promptEdit(target, alias)
                : window.prompt('修改双链（格式：页面名 或 页面名|显示别名）', alias ? `${target}|${alias}` : target)
              if (input === null) return true
              const [nt, na] = input.split('|').map((s) => s.trim())
              if (!nt) return true
              // 找到该节点位置并更新 attrs
              const pos = view.posAtDOM(span, 0)
              const node = view.state.doc.nodeAt(pos)
              if (node?.type.name === 'wikilink') {
                view.dispatch(
                  view.state.tr.setNodeMarkup(pos, undefined, { target: nt, alias: na || null }),
                )
                // setNodeMarkup 不触发 markdownUpdated（无 doc 结构监听），追加空事务促 listener 重新序列化
                view.dispatch(view.state.tr)
              }
              return true
            }
            const el = event.target.closest?.('.wikilink')
            if (!el) return false
            event.preventDefault()
            const title = el.getAttribute('data-wikilink') || ''
            if (title && onOpenTitle) onOpenTitle(title)
            return true
          },
        },
      },
    }),
  )
}

/** 供 MilkdownEditor 用的 remarkStringifyOptions 合并器 */
export function applyWikilinkStringify(ctx) {
  ctx.update(remarkStringifyOptionsCtx, (prev) => ({
    ...prev,
    handlers: { ...(prev.handlers ?? {}), ...WIKILINK_STRINGIFY_HANDLER },
  }))
}

/** 全家桶：Editor.use(...) 的便捷列表 */
export function wikilinkKit({ pagesGetter, onOpenTitle, promptEdit } = {}) {
  return [
    wikilinkRemark,
    wikilinkNode,
    wikilinkInputRule,
    wikilinkSuggest(pagesGetter || (() => [])),
    wikilinkInteract(onOpenTitle, promptEdit),
  ]
}
