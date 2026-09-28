import { ViewPlugin, Decoration, EditorView } from '@codemirror/view'

/**
 * Obsidian 风格 live-preview：编辑时把 markdown 渲染出"笔记软件观感"。
 * 底层仍是纯文本（零序列化风险），只做显示层：
 *   - 标题行：整行字号/字重 + 光标不在该行时隐藏 "# " 标记
 *   - 加粗 **x**：光标不在该行时隐藏两侧 **，内部加粗
 *   - 行内代码 `x`：样式化（保留反引号）
 *   - 列表标记：淡化
 *   - wikilink：chip 样式（点击跳转由 Notes 的 domEvent 处理）
 */

const HIDDEN = () => Decoration.replace({})

function buildDeco(view) {
  const decos = []
  const selLines = new Set()
  for (const r of view.state.selection.ranges) {
    selLines.add(view.state.doc.lineAt(r.from).number)
    selLines.add(view.state.doc.lineAt(r.to).number)
  }

  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos)
      pos = line.to + 1
      const text = line.text
      const cursorIn = selLines.has(line.number)

      // 标题：# / ## / ###
      const h = /^(#{1,3})(\s+)(.*)$/.exec(text)
      if (h) {
        decos.push(Decoration.line({ class: `cm-h${h[1].length}` }).range(line.from))
        if (!cursorIn) {
          decos.push(HIDDEN().range(line.from, line.from + h[1].length + h[2].length))
        }
        continue
      }

      // 列表标记淡化
      const li = /^(\s*)([-*+]|\d+\.)\s/.exec(text)
      if (li) {
        decos.push(
          Decoration.mark({ class: 'cm-list-marker' }).range(
            line.from + li[1].length,
            line.from + li[1].length + li[2].length,
          ),
        )
      }

      // 加粗 **x**（不在光标行时隐藏标记）
      if (!cursorIn) {
        const boldRe = /\*\*([^*\n]+)\*\*/g
        let m
        while ((m = boldRe.exec(text))) {
          const s = line.from + m.index
          decos.push(HIDDEN().range(s, s + 2))
          decos.push(Decoration.mark({ class: 'cm-strong' }).range(s + 2, s + 2 + m[1].length))
          decos.push(HIDDEN().range(s + 2 + m[1].length, s + 4 + m[1].length))
        }
      }

      // 行内代码 `x`
      const codeRe = /`([^`\n]+)`/g
      let cm
      while ((cm = codeRe.exec(text))) {
        decos.push(
          Decoration.mark({ class: 'cm-inline-code' }).range(
            line.from + cm.index,
            line.from + cm.index + cm[0].length,
          ),
        )
      }

      // wikilink chip
      const wlRe = /\[\[([^\][\n]+)\]\]/g
      let w
      while ((w = wlRe.exec(text))) {
        decos.push(
          Decoration.mark({ class: 'cm-wikilink', attributes: { title: `跳转到：${w[1]}` } }).range(
            line.from + w.index,
            line.from + w.index + w[0].length,
          ),
        )
      }
    }
  }

  return Decoration.set(decos, true)
}

/** live-preview extension */
export function livePreview() {
  return [
    ViewPlugin.fromClass(
      class {
        constructor(view) {
          this.decorations = buildDeco(view)
        }
        update(u) {
          if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = buildDeco(u.view)
        }
      },
      { decorations: (v) => v.decorations },
    ),
  ]
}

/** 编辑器内 wikilink 点击 → title→path → onOpenPage */
export function wikilinkClickHandler(openPage) {
  return EditorView.domEventHandlers({
    mousedown(e) {
      const t = e.target.closest?.('.cm-wikilink')
      if (!t) return false // 非 wikilink：同步返回 false，让 CM 正常处理光标
      const text = t.textContent ?? ''
      const title = text.replace(/^\[\[/, '').replace(/\]\]$/, '').trim()
      if (!title) return false
      e.preventDefault()
      void (async () => {
        const { ensurePageIndex, resolveTitle } = await import('./md.js')
        await ensurePageIndex()
        const path = resolveTitle(title)
        if (path) openPage(path)
      })()
      return true
    },
  })
}
