# M0 Spike 验证点 2 · Milkdown wikilink 定制成本实测（D6，2026-09-28）

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

## 定制成本核算

| 部分 | 状态 | 工作量估计 |
|---|---|---|
| mark schema + 输入规则 + 高亮样式 | ✅ 已验证（~60 行） | 0.5 天 |
| remark stringify handler + 转义对抗 | ⚠️ 输出污染未根治 | 0.5-1 天 |
| remark parse 插件（加载已有 wikilink 文档） | ❌ 未做（micromark 层） | 1-1.5 天 |
| 补全弹窗（输入 `[[` 列出页面） | ❌ 未做（prosemirror popup） | 0.5-1 天 |

合计 **2.5-4 天**，且转义/解析边缘 case 会持续产生维护负担。

## 降级决策：CodeMirror 6

- 纯文本编辑，`[[ ]]` 保真 100%（零序列化层，零转义风险）
- wikilink 高亮：CM6 decorations（搜索 `[[…]]` 着色，~30 行）
- 补全：CM6 autocomplete 挂页面名列表（index.md 数据现成），~50 行
- 总成本 **≤ 0.5 天**，且与"Markdown 文件即真相源"的存储模型完全对齐（Milkdown 的所见即所得反而引入序列化损耗层）

## 遗留物

`spike/milkdown/` 保留作结论证据（build 通过、浏览器实测截图在会话记录）。产品前端（apps/web，另一台设备负责）应基于 CodeMirror 6 方案。
