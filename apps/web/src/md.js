import { marked } from 'marked'

/**
 * Markdown → HTML + wikilink 可点击化（marked extension 词法层拦截）
 * 两种引用形式：
 *   1. [[标题]](wiki/path.md)  ← 服务端归一化产物，直接可跳
 *   2. 裸 [[标题]]             ← 用 /api/graph 建 title→path 索引解析；解析不到仅样式化
 * 必须用 extension 而非后处理正则：marked 会先把 [[..]](path) 吃成 [link][link] 引用语法
 */

let titleToPath = null // Map<string, string> | null

export function ensurePageIndex() {
  if (titleToPath) return Promise.resolve()
  return fetch('/api/graph')
    .then((r) => r.json())
    .then((g) => {
      titleToPath = new Map()
      for (const n of g.nodes ?? []) {
        if (n.title) titleToPath.set(n.title, n.id)
        if (n.id) titleToPath.set(n.id.replace(/\.md$/, ''), n.id)
      }
    })
    .catch(() => {
      titleToPath = new Map()
    })
}

/** 裸标题 → 页面 path（需先 ensurePageIndex） */
export function resolveTitle(title) {
  return titleToPath?.get(title) ?? titleToPath?.get(title.replace(/\.md$/, '')) ?? null
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

const wikilinkExt = {
  name: 'wikilink',
  level: 'inline',
  start(src) {
    const i = src.indexOf('[[')
    return i === -1 ? undefined : i
  },
  tokenizer(src) {
    const m = /^\[\[([^\][\n]+?)\]\](?:\(([^)\s]+)\))?/.exec(src)
    if (m) return { type: 'wikilink', raw: m[0], label: m[1], path: m[2] }
  },
  renderer(token) {
    const path = token.path ?? titleToPath?.get(token.label.trim())
    if (path) return `<a class="wikilink" data-page="${esc(path)}">${esc(token.label)}</a>`
    return `<span class="wikilink" title="未链接的页面引用">${esc(token.label)}</span>`
  },
}

marked.use({ extensions: [wikilinkExt], gfm: true })

export function renderMarkdown(text, { onOpenPage } = {}) {
  const wrap = document.createElement('div')
  wrap.className = 'md'
  wrap.innerHTML = marked.parse(text, { async: false })
  if (onOpenPage) {
    wrap.querySelectorAll('a[data-page]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault()
        onOpenPage(a.getAttribute('data-page'))
      })
    })
  }
  return wrap
}
