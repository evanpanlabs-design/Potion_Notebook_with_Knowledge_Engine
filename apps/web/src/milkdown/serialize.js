/**
 * Milkdown 编辑器的加载/保存文本变换（纯函数，Node/浏览器皆可测）。
 *
 * 磁盘格式（Obsidian 风格 [[wikilink]] + frontmatter）保持不变；
 * 本模块只做编辑器进出两侧的最小适配，保证「打开 → 不编辑 → 保存」diff 最小。
 */

/** 拆出 frontmatter：`---\nyaml\n---\n` 块（若在文件头部）。
 *  返回 { fmText: string|null, body: string }，fmText 为 yaml 原文（不含 --- 分隔线）。 */
export function splitFrontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!m) return { fmText: null, body: content }
  return { fmText: m[1], body: content.slice(m[0].length) }
}

/** 拼回 frontmatter（fmText 为 null 时原样返回 body）。 */
export function joinFrontmatter(fmText, body) {
  if (fmText == null || fmText.trim() === '') return body
  return `---\n${fmText.replace(/\s+$/, '')}\n---\n\n${body}`
}

/** 加载侧：服务端引用归一化产物 `[[标题]](path)` → 裸 `[[标题]]`。
 *  path 可由 title→path 索引（/api/graph）还原，编辑层无信息损失；
 *  core 的 extractWikiLinks 只认裸形式，混合形式在 CM6 时代也无法被图谱识别。 */
export function mixedToBare(md) {
  return md.replace(
    /\[\[([^\]|\n]+?)\]\]\((?:wiki|notes|sources|queries)\/[^)\s]+?\.md\)/g,
    '[[$1]]',
  )
}

/** 保存侧：折叠 remark-stringify 的保守转义 `\[` → `[`。
 *  仅当折叠不会创建 link/image/引用语法时折叠（后随 `(` 或 `[` 时保留转义；
 *  `!\[` 图片转义保留）。mdast-util-to-markdown 基础库会对行内 `[` 注入 `\`，
 *  语料中 sources[] / ## [date] 等写法会被误伤，此函数还原。 */
export function foldEscapedBrackets(md) {
  let out = ''
  let i = 0
  while (i < md.length) {
    const c = md[i]
    if (c === '\\' && md[i + 1] === '[') {
      const prev = out.slice(-1)
      const prev2 = out.slice(-2, -1)
      // `!\[` 是转义图片，保留
      if (prev === '!' && prev2 !== '\\') {
        out += '\\['
        i += 2
        continue
      }
      // 向后找匹配的 `]`（跨过 `\\]` 转义），限制在同段（最多一个空行）
      let j = i + 2
      let closed = -1
      let blank = 0
      while (j < md.length) {
        const cj = md[j]
        if (cj === '\\' && md[j + 1] === ']') {
          j += 2
          continue
        }
        if (cj === ']') {
          closed = j
          break
        }
        if (cj === '\n') {
          if (++blank === 2) break
        } else {
          blank = 0
        }
        j++
      }
      // 折叠后若会形成 [..]( 或 [..][ 语法（链接/脚注引用），保留转义
      if (closed !== -1 && (md[closed + 1] === '(' || md[closed + 1] === '[')) {
        out += '\\['
        i += 2
        continue
      }
      out += '['
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/** 逐文档检测主列表符（remarkStringify bullet 选项用），保持 `*` 列表文档不被改写。 */
export function detectBullet(md) {
  const star = (md.match(/^\* /gm) || []).length
  const dash = (md.match(/^- /gm) || []).length
  return star > dash ? '*' : '-'
}

/** 编辑器加载：整页 → { fmText, body }（body 已 mixedToBare）。 */
export function loadForEditor(content) {
  const { fmText, body } = splitFrontmatter(content)
  return { fmText, body: mixedToBare(body) }
}

/** 编辑器保存：body → 落盘正文（折叠转义）。fm 由调用方 joinFrontmatter 拼回。 */
export function saveFromEditor(body) {
  return foldEscapedBrackets(body)
}
