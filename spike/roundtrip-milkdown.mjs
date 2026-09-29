/**
 * Milkdown 编辑器序列化管线的 Node 侧验收（feat/milkdown-editor 分支）。
 *
 * 模拟完整往返：磁盘 content → loadForEditor（剥 fm + mixedToBare）
 *   → remark parse + stringify（与 Milkdown transformer 同配置：wikilink 自写 handler）
 *   → saveFromEditor（foldEscapedBrackets）
 *   → joinFrontmatter 拼回 → 与「loadForEditor 后的原文」对比。
 *
 * 硬指标：wikilink 全保真（数量+值逐一相等）；文本差异仅允许块间空行/列表符/尾空白。
 *
 * 运行：node spike/roundtrip-milkdown.mjs [库目录]
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import micromarkWikiLink from 'micromark-extension-wiki-link'
import { fromMarkdown } from 'mdast-util-wiki-link'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const webSrc = join(root, 'apps', 'web', 'src', 'milkdown')

const { splitFrontmatter, joinFrontmatter, mixedToBare, foldEscapedBrackets, detectBullet } =
  await import(`file://${join(webSrc, 'serialize.js')}`)

const { syntax } = micromarkWikiLink

// 与 apps/web/src/milkdown/wikilink.js 同构：只注入 parse 扩展 + 自写 handler
function wikilinkPlugin() {
  const data = this.data()
  const add = (f, v) => {
    if (!data[f]) data[f] = []
    data[f].push(v)
  }
  add('micromarkExtensions', syntax({ aliasDivider: '|' }))
  add('fromMarkdownExtensions', fromMarkdown({ aliasDivider: '|' }))
}

const WIKILINK_STRINGIFY_HANDLER = {
  wikiLink(node) {
    const value = node.value ?? ''
    const alias = node.data?.alias
    return alias && alias !== value ? `[[${value}|${alias}]]` : `[[${value}]]`
  },
}

/** 与 MilkdownEditor 的进出管线完全一致 */
/** 编辑器往返：基线 = loadForEditor 产物（fm + mixedToBare 后的 body） */
function editorRoundtrip(content) {
  const { fmText, body: rawBody } = splitFrontmatter(content)
  const body = mixedToBare(rawBody)
  const baseline = joinFrontmatter(fmText, body)
  const endsNl = /\n$/.test(body)
  const proc = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(wikilinkPlugin)
    .use(remarkStringify, {
      bullet: detectBullet(body),
      emphasis: '*',
      strong: '*',
      rule: '-',
      handlers: WIKILINK_STRINGIFY_HANDLER,
    })
  let out = proc.processSync(body).toString()
  out = foldEscapedBrackets(out)
  if (!endsNl) out = out.replace(/\n$/, '')
  return { loaded: body, baseline, saved: joinFrontmatter(fmText, out) }
}

/** 从文本提取 wikilink 清单做保真断言 */
function wikilinks(md) {
  const out = []
  for (const m of md.matchAll(/\[\[([^\][\n]+)\]\]/g)) out.push(m[1])
  return out
}

const kbRoot = process.argv[2] || join(root, 'data')
const files = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.md')) files.push(p)
  }
}
walk(kbRoot)

let identical = 0, diff = 0, err = 0
let linkFail = 0
const diffSamples = []
for (const f of files) {
  const content = readFileSync(f, 'utf8')
  try {
    const { loaded, baseline, saved } = editorRoundtrip(content)
    // 硬指标：wikilink 保真（roundtrip 后 saved 的 body 部分重新提）
    const { body: savedBody } = splitFrontmatter(saved)
    const before = wikilinks(loaded)
    const after = wikilinks(savedBody)
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      linkFail++
      console.error(`WIKILINK 丢失/变形: ${f}`)
      console.error('  before:', before.join(' , '))
      console.error('  after :', after.join(' , '))
    }
    if (saved === baseline) identical++
    else {
      diff++
      if (diffSamples.length < 6) diffSamples.push({ f, content: baseline, saved })
    }
  } catch (e) {
    err++
    console.error('ERR', f, e.message)
  }
}

console.log(`\n===== 结果（${files.length} 文件）=====`)
console.log(`与原文件完全一致: ${identical}`)
console.log(`有差异:          ${diff}`)
console.log(`解析错误:        ${err}`)
console.log(`wikilink 保真失败: ${linkFail}`)

if (linkFail > 0) {
  console.log('\n!! wikilink 保真失败，不满足验收标准')
  process.exit(1)
}
if (diff > 0) {
  // 差异分类：是否仅为空白行增减
  const normalize = (s) => s.replace(/\n{2,}/g, '\n\n')
  let wsOnly = 0
  for (const d of diffSamples) {
    if (normalize(d.content) === normalize(d.saved)) wsOnly++
  }
  console.log(`\n（抽样 ${Math.min(diffSamples.length, diff)} 个差异中 ${wsOnly} 个为纯空白行差异）`)
}

for (const d of diffSamples) {
  console.log(`\n--- ${d.f.replace(kbRoot + '/', '')} 差异抽样`)
  const a = d.content.split('\n'), b = d.saved.split('\n')
  let shown = 0
  for (let i = 0; i < Math.max(a.length, b.length) && shown < 4; i++) {
    if (a[i] !== b[i]) {
      console.log(`  L${i + 1}: ${JSON.stringify(a[i])}`)
      console.log(`     → ${JSON.stringify(b[i])}`)
      shown++
    }
  }
}

// ---------- 幂等性验证：第一次往返的 saved 再走一遍，必须完全一致 ----------
let idemOk = 0, idemFail = 0
for (const f of files) {
  const content = readFileSync(f, 'utf8')
  try {
    const first = editorRoundtrip(content).saved
    const second = editorRoundtrip(first).saved
    if (first === second) idemOk++
    else {
      idemFail++
      if (idemFail <= 3) console.error(`非幂等: ${f}`)
    }
  } catch (e) {
    idemFail++
  }
}
console.log(`\n===== 幂等性（打开→保存→再打开→再保存）=====`)
console.log(`第二次往返后稳定: ${idemOk} / 不稳定: ${idemFail}`)
if (idemFail > 0) process.exit(1)

// ---------- 非空白差异检测：strip 所有空行后对比 ----------
let nonWs = 0
for (const f of files) {
  const content = readFileSync(f, 'utf8')
  const { baseline, saved } = editorRoundtrip(content)
  const strip = (s) => s.split('\n').map((l) => l.trimEnd()).filter((l) => l !== '').join('\n').trim()
  if (strip(baseline) !== strip(saved)) {
    nonWs++
    console.error(`非空白差异: ${f}`)
  }
}
console.log(`\n===== 非空白字符差异: ${nonWs} 个文件 ${nonWs === 0 ? '（全部差异均为块间空行）' : '!! 需排查'} =====`)
if (nonWs > 0) process.exit(1)
console.log('\n✅ 验收通过：wikilink 保真 + 幂等 + 差异仅为规范空行')
