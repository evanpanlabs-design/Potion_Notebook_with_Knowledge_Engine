import React, { useEffect, useRef } from 'react'
import { renderMarkdown, ensurePageIndex } from '../md.js'

/** markdown 宿主：先确保页面索引可用（裸 wikilink 解析），再渲染 HTML */
export default function MarkdownHost({ text, onOpenPage }) {
  const ref = useRef(null)
  useEffect(() => {
    let alive = true
    ensurePageIndex().then(() => {
      if (!alive || !ref.current) return
      const el = ref.current
      el.innerHTML = ''
      el.appendChild(renderMarkdown(text, { onOpenPage }))
    })
    return () => {
      alive = false
    }
  }, [text, onOpenPage])
  return <div ref={ref} />
}
