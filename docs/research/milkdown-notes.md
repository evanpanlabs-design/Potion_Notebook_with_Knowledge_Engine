# Milkdown wikilink 集成笔记（feat/milkdown-editor 分支）

> 两阶段记录：D6 spike 的放弃结论（保留作背景）→ feat 分支用新路线推翻它（2026-09-29）。

## 当前结论（2026-09-29，feat/milkdown-editor）

**Milkdown 可行且已落地**：磁盘格式零改动（`[[标题]]`、`[[标题|别名]]`、frontmatter 全保留），编辑体验升级为所见即所得。D6 的"放弃"结论根因是选错了集成路线（mark + 转义对抗），不是 Milkdown 本身不行。

### 新路线与 D6 的三点不同

1. **inline atom node 替代 mark**：wikilink 值存 attrs 不存文本，序列化自拼 `[[target|alias]]`，从根上杜绝 D6 的「文本与括号本体混叠」类污染
2. **Foam 生态语法扩展替代自研 micromark**：直接用 `micromark-extension-wiki-link` + `mdast-util-wiki-link` 的 parse 侧（fromMarkdown），stringify 侧自写 handler 绕过其 safe() 转义
3. **$remark 注入替代 mark 序列化对抗**：走 remarkCtx（parse/stringify 共用一个 unified 处理器），一处注入双向生效

### 关键踩坑（每个都是静默失败，务必记住）

1. **`$remark(id, factory)` 第一参是 slice id**——漏传会把 factory 落到 id 位置，插件静默不注册（无报错）
2. **`inline: true` 不会自动加入 `inline` group**——必须显式 `group: 'inline'`，否则 paragraph 拒绝该子节点，**parser console.error 吞错后整段静默丢弃**（症状：含 wikilink 的段落凭空消失）
3. **`$prose` 有注册竞态**——只等 SchemaReady 就往 prosePluginsCtx 塞插件，与 editorState 读该 ctx 并发，state 建好时插件可能未注册（症状：弹窗/decoration 从不出现，无任何报错）。**必须用 `$proseAsync`**（经 addTimer 挂进 editorStateTimerCtx）
4. **`apply(tr, prev)` 里传 `tr.selection` 给期望 state 的函数**——`selection.selection` 是 undefined，每个事务抛错（症状：selection 卡死在 1、输入全废）
5. **`markdownUpdated` 只在文档变化时触发，不对初始装配触发**——从源码带改动切到富文本后立即保存会把空正文落盘（真实清空事故）。修复：装配完成 effect 里主动 `ed.action(getMarkdown())` 上抛一次（注意 action 同步返回字符串非 promise）+ save() 保险丝（editorMd 为空且非空文档时拒绝保存）
6. **dirty 基线不能用磁盘原文**——remark 会对块间空行做 CommonMark 规范化（首次保存后永久稳定），直接比原文会「打开即 dirty」。以编辑器首次序列化产物为基线
7. **保存后要 `setDoc(text)`**——切源码模式时 CM6 重建读 doc state，不更新会显示保存前旧内容
8. **`setNodeMarkup` 不触发 markdownUpdated**——✎ 修改 attrs 后要追加空事务促 listener 重新序列化，否则 dirty 不亮
9. **micromark-extension-wiki-link 0.0.4 的 browser 字段指向 UMD 且无 default export**——需显式 `import { syntax } from 'micromark-extension-wiki-link/dist/index.esm.js'`

### 已验证的完整链路（浏览器 E2E）

- wikilink chip 渲染（span.wikilink + ✎ 按钮）✓
- `[[` 补全弹窗（真实页面索引候选、↑↓ 导航、Enter 插入）✓
- 单击 chip 跳转抽屉打开目标页 ✓
- ✎ 修改 target/alias → dirty → 保存落盘 ✓
- 保存 diff 最小化：只有真实改动 + 服务端 updated_at/log.md，frontmatter 全保留，零转义污染 ✓
- 幂等：保存后重开零假 dirty、chip 全渲染 ✓
- 富文本⇄源码带改动双向切换 ✓
- 72 文件真实语料 roundtrip：wikilink 保真 72/72、幂等 72/72、非空白差异 0 ✓
- vite build 通过（仅 chunk 大小警告）✓

### 文件地图

`apps/web/src/milkdown/serialize.js`（frontmatter 剥离/回拼、mixedToBare、foldEscapedBrackets）、`apps/web/src/milkdown/wikilink.js`（remark/node/inputRule/suggest/interact 五件套）、`apps/web/src/milkdown/MilkdownEditor.jsx`（React 封装 + epoch 代际 + 装配上抛）、`apps/web/src/views/Notes.jsx`（双模式切换 + dirty 基线 + save 保险丝）、`spike/roundtrip-milkdown.mjs`（72 文件回归）。

---

# 以下为 D6 spike 原始记录（2026-09-28，结论已被上述推翻）

> 结论先行：**放弃 Milkdown，降级 CodeMirror**（ROADMAP 预案兑现）。Milkdown 对 `[[wikilink]]` 的支持需要自研 remark 语法扩展三件套 + 转义层对抗，实测成本远超半天预算，且存在无法快速根治的序列化污染问题。

## 实测环境

`spike/milkdown/`（Vite 6 + React 19 + @milkdown/kit 7.22 / @milkdown/react 7.22）

## 验证过程与踩坑记录

按时间序，每一层都是真实踩过的坑：

1. **无内置支持**：`@milkdown/kit` 7.22 全家桶（components/crepe/preset-commonmark/preset-gfm/11 个 plugin）grep `wikilink` 零命中。Obsidian 风格链接完全靠自研。
2. **API 入口坑**：v7 的正确入口是 `Editor.make()`（`@milkdown/kit/core` 导出 `Editor`）；`editorView` 是 prose 插件容器不是 builder（报 `make is not a function`）。
3. **MarkSerializerSpec 形状坑**：`toMarkdown` 必须是 `{ match(mark), runner(state, mark, node) }`，不能用 `{ open, close }` 简写（报 `spec.toMarkdown.match is not a function`）。
4. **序列化必须走 remark AST**：runner 里 `state.write(']]')` 无效。内置 mark 的模式是 `state.withMark(mark, 'emphasis', …)` 往 remark AST 写节点，字符串最终由 remark handler 输出。自定义 AST 节点类型（`wikilink`）需要经 `remarkStringifyOptionsCtx` 注册 handler：`handlers: { wikilink: (node) => \`[[${node.value}]]\` }`。
5. **输入规则双括号 bug**：inputRule 若只 `addMark` 不删字符，mark 覆盖的文本含 `[[ ]]` 本体，handler 再包一层 → `[[[[知识复利]]]`。必须 delete+insert 纯 target 文本。
6. **最终拦路虎（未解决）**：remark 的 safe 转义层给行内 `[` 注入 `\`，与自定义 handler 叠加产生 `\[[[知[[知识复利]]` 这类污染输出。根治需要 override mdast-util-to-markdown 的 unsafe 转义配置（边缘 case 难穷举）+ 自写 micromark parse 插件才能支持"加载已有 [[...]] 文档"（本次未做，风险最高的一层）。

## 定制成本核算（D6 时点）

| 部分 | 状态 | 工作量估计 |
|---|---|---|
| mark schema + 输入规则 + 高亮样式 | ✅ 已验证（~60 行） | 0.5 天 |
| remark stringify handler + 转义对抗 | ⚠️ 输出污染未根治 | 0.5-1 天 |
| remark parse 插件（加载已有 wikilink 文档） | ❌ 未做（micromark 层） | 1-1.5 天 |
| 补全弹窗（输入 `[[` 列出页面） | ❌ 未做（prosemirror popup） | 0.5-1 天 |

合计 **2.5-4 天**，且转义/解析边缘 case 会持续产生维护负担。

## D6 遗留物

`spike/milkdown/` 保留作结论证据。产品前端当时的 CodeMirror 6 方案已作为源码模式保留为 fallback（双模式切换）。
