# D7 Spike · CodeMirror 6 wikilink 编辑器验证（2026-09-28）

> 结论先行：**CodeMirror 6 方案全部验证通过，Milkdown 降级决策落定**。高亮（decorations）、`[[` 触发页面名补全（autocompletion）、保存零损耗往返（纯文本直存）三件事实测可用，核心代码 ~90 行。产品前端（apps/web，Codex 设备）可直接按本清单实施。

## 实测环境

`spike/codemirror/`（Vite 6 + CodeMirror 6：view/state/commands/lang-markdown/autocomplete，37 个包，装包 7s）

## 验证结果（浏览器实测，截图在会话记录）

| 验证项 | 结果 | 说明 |
|---|---|---|
| `[[页面名]]` 高亮 | ✅ | ViewPlugin + Decoration.mark，view 层着色，**不改文档文本** |
| `[[` 触发补全 | ✅ | autocompletion override，输入 `[[Kar` + Enter → `[[Karpathy]]` 完整插入（自动补 `]]`） |
| 保存往返零损耗 | ✅ | `view.state.doc.toString()` 纯文本 POST → 盘上文件逐字符一致，git 提交 `note:` 规范 |

## 实施清单（Codex 设备直接复用）

### 1. wikilink 高亮（~40 行，`src/main.js` 的 `wikilinkHighlighter`）

- `ViewPlugin.fromClass` + `Decoration.mark({ class: 'cm-wikilink' })`，正则 `/\[\[([^\][\n]+)\]\]/g` 扫 `view.visibleRanges`
- `update()` 里 `docChanged || viewportChanged` 时重建
- ⚠️ `DecorationSet` 是纯 TS 类型，**运行时不存在**，不要从 `@codemirror/view` import（报模块错误）

### 2. 页面名补全（~25 行，`pageNameCompletions`）

- `autocompletion({ override: [...] })`，回调里检查光标前最近未闭合的 `[[`（`before.lastIndexOf('[[') > before.lastIndexOf(']')`）
- `apply` 直接给 `${name}]]`——补全后自动闭合双链
- 页面名数据源：真实实现从 `GET /api/v1/graph`（nodes 数组，已就绪）或未来加 `/api/v1/titles` 轻量端点拉，建议编辑器启动时 fetch 一次 + ingest 完成事件刷新

### 3. 保存（~10 行）

- `view.state.doc.toString()` 直接 POST `/api/v1/notes`（body: filename/title/content），**无任何序列化层**——这是选 CM 的核心理由
- vite proxy 注意：`/api` → `http://127.0.0.1:3100` 需 rewrite `/api` → `/api/v1`（server 路由带 v1 前缀），否则 404

### 4. 建议后续加（不阻塞）

- 点击 wikilink 跳转：`EditorView.domEventHandlers({ click })` 判断 target `.cm-wikilink` → 路由到页面
- `[[` 补全面板里显示页面类型（entity/concept/source，从 graph nodes 的 kind 字段）
- frontmatter 高亮可加 `@codemirror/lang-yaml` 混合

## 与 Milkdown 结论合并看

| | Milkdown 7.22 | CodeMirror 6 |
|---|---|---|
| wikilink 内置支持 | 无 | 无（但 view 层 40 行解决） |
| 序列化保真 | ❌ remark 转义层污染（未根治） | ✅ 纯文本零损耗 |
| 成本 | 2.5-4 天 | **≤0.5 天（实测）** |
| 所见即所得 | ✅（代价是序列化损耗层） | ❌ 源码模式 |

## 遗留物

`spike/codemirror/` 保留作证据（不含 node_modules）。
