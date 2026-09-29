/**
 * SVG → PNG 导出（图谱页与局部子图共用）。
 * 原理：克隆 SVG 序列化 → Blob URL → Image 绘制到 2x canvas → PNG 下载。
 * 注意：SVG 内不能依赖外部 CSS（var()/class 样式不会带进图片），
 *       需要导出的文本/图形必须在 JSX 上带显式 presentation 属性。
 */
export async function exportSvgToPng(svgEl, filename = 'graph.png', { scale = 2, background = '#ffffff' } = {}) {
  if (!svgEl) throw new Error('SVG 未就绪')
  const clone = svgEl.cloneNode(true)
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const vb = (svgEl.getAttribute('viewBox') || '0 0 100 100').split(/\s+/).map(Number)
  const w = vb[2] || svgEl.clientWidth || 800
  const h = vb[3] || svgEl.clientHeight || 600
  clone.setAttribute('width', w)
  clone.setAttribute('height', h)
  const xml = new XMLSerializer().serializeToString(clone)
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image()
      im.onload = () => resolve(im)
      im.onerror = () => reject(new Error('SVG 渲染失败'))
      im.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = background
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = filename
    a.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}
