/* 自定义 wikilink mark：[[页面名]] / [[页面名|别名]] / [[页面名#标题]]。
 * Milkdown 7.x 无内置 wikilink preset——本文件就是“定制成本”实测本体。
 *
 * 实测踩坑记录（重要结论，写进 docs/research/）：
 * 1. MarkSerializerSpec 必须是 { match(mark), runner(state, mark, node) }，
 *    不能用 {open, close} 简写（报 toMarkdown.match is not a function）
 * 2. runner 里序列化 = 往 remark AST 写节点（withMark(mark, astType, value)），
 *    直接 state.write(']]') 无效——字符串要经 remark handler 输出
 * 3. 自定义 AST 节点类型需要配套注册 remark stringify handler（remarkStringifyOptionsCtx），
 *    于是完整链路 = mark schema + inputRule + remark handler 三件套 ≈ 100 行定制代码
 * 4. 加载已有 [[...]] 文本还需 remark parse 插件（micromark 语法），未验证——风险最高的部分 */
import { $mark, $inputRule, $remark } from '@milkdown/kit/utils'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { schemaCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core'

/** remark stringify handler：AST 'wikilink' 节点 → 输出 [[value]] */
export const wikilinkRemarkHandler = $remark(() => () => (tree) => tree)
// 上面占位——handler 实际经 remarkStringifyOptionsCtx 注入：

/** mark schema：inline 标记，序列化为 remark AST 'wikilink' 节点 */
export const wikilinkSchema = $mark('wikilink', () => ({
  inclusive: false,
  attrs: { target: { default: '' } },
  parseDOM: [{ tag: 'span[data-wikilink]' }],
  toDOM: (node) => ['span', { 'data-wikilink': node.attrs['target'], class: 'wikilink' }, 0],
  parseMarkdown: {
    // 加载已有 [[...]] 文本需 remark parse 插件（本 spike 不做，见结论第 4 条）
    match: () => false,
    runner: () => {},
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'wikilink',
    runner: (state, mark, node) => {
      // node.text = mark 覆盖的文本（含 [[]] 括号本身，因为 inputRule 不删字符）
      state.withMark(mark, 'wikilink', node.text ?? '')
      return true
    },
  },
}))

/** 序列化选项注入：告诉 remark 怎么把 'wikilink' AST 节点写成文本。
 * 用法：Editor.config(ctx => ctx.update(remarkStringifyOptionsCtx, ...))，见 main.jsx */
export const WIKILINK_STRINGIFY_OPTIONS = {
  handlers: {
    wikilink: (node) => `[[${node.value}]]`,
  },
  // 关闭 mdast-util-to-markdown 对未知节点的报错（unsafe 配置见实验）
}

/** 输入规则：键入 `[[xxx]]` 完成时，括号内文本加 wikilink mark。
 * 注意：mark 覆盖的文本应为纯 target（不含括号），序列化时由 remark handler 统一包 [[ ]] */
export const wikilinkInputRule = $inputRule((ctx) => {
  const schema = ctx.get(schemaCtx)
  const markType = schema.marks['wikilink']
  return new InputRule(/\[\[([^[\]\n]+)\]\]$/, (state, match) => {
    const inner = match[1]
    const to = state.selection.from // 光标在 ]] 后
    const from = to - inner.length // 回退到括号内文本起点（括号本体由 ProseMirror inputRule 的 replaceWith 语义移除）
    return state.tr
      .delete(from, to)
      .insert(from, state.schema.text(inner, [markType.create({ target: inner })]))
  })
})

/** 样式：让 wikilink 在编辑器里可见（蓝色下划线），确认 mark 真实生效 */
export const WIKILINK_STYLE = `
.wikilink { color: #2563eb; text-decoration: underline; cursor: pointer; background: rgba(37,99,235,0.08); border-radius: 2px; }
`
