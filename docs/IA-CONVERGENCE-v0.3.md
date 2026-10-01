# IA 收束提案 · v0.3.x：用户旅程梳理与产品形态收敛（草案）

> 状态：草案（与产品负责人讨论定稿，2026-09-30）· 分支：`feat/v0.3-agent`
> 配套：[ADR-003](ADR-003-v0.3.md)（v0.3 Agent 化）· [ADR-004](ADR-004-v0.4.md)（v0.4 能力半径）
> 本文档同时是**给后续实现 Agent 的任务说明书**：§5 的任务块自包含，可独立认领；执行前先读 §1-§3 掌握背景。

---

## 0. 决策速览（与产品负责人已对齐）

| # | 议题 | 决策 |
|---|---|---|
| D1 | 是否到了收束阶段 | **是**。12 个页面功能完备但 IA 摊平，按用户旅程重组而非继续加功能 |
| D2 | 笔记页库分类 | 库页面（`wiki/` 下 entities/concepts/sources/queries）按目录**分组折叠 + 类型过滤 chips** |
| D3 | 素材页 PDF 阅读 | **不引入 KillerPDF**（Windows 桌面程序，无法嵌入 web，见 §4 调研）。一期 `<iframe>` 原生预览 + 服务端只读静态路由；v0.4 视反馈升级 pdf.js |
| D4 | 便利贴 vs 收件箱 | **功能不重叠、心智重叠**（方向相反：便利贴=人→系统输入，收件箱=系统→人输出）。**不合并实体**，在导航上归入同一「处理」分组统一「待处理」心智 |
| D5 | 设置页 | 改**选项卡模式**：模型 / 联网 / 存储与版本 / 关于 |
| D6 | 导航重组 | 左侧导航从功能清单改为旅程四章节：**收集 → 处理 → 知识库 → 回顾**（见 §3，需纸面定稿后再动） |
| D7 | 悬浮球 | 定位不变（「收集」章万能入口），IA 收束后再评估统一交互 |

落地顺序（按投入产出，T1-T3 互不依赖、都不动数据层）：**T1 笔记折叠 → T2 设置选项卡 → T3 PDF 预览 → T4 导航分组（需二次对稿）→ T5 pdf.js（v0.4）**。

---

## 1. 背景与产品现状（新 Agent 必读）

**Potion · Knowledge Engine** 是 local-first 的知识管理应用：Fastify server（:3100）+ Vite/React web（:5175），npm workspaces monorepo（`packages/core` / `packages/agent-tools` / `apps/server` / `apps/web`）。知识库是 `data/my-wiki/` 下的纯 Markdown + 自托管 git 版本化；AI 生成的一切写入都走**人工审核闸门**（ADR-002 围栏原则：agent 不开洞，human-in-the-loop）。

v0.3 交付后，产品已有 12 个视图（`apps/web/src/App.jsx` NAV 数组）：

```
总览 overview · 笔记 notes · 素材 sources · 知识图谱 graph ·
收件箱 inbox · 便利贴 bulletins · 审核 review · 问答历史 ask ·
工作台 workbench · 设置 settings ·（悬浮球 AskOrb 全局常驻）
```

核心数据流（一条主线）：

> **捕获**（便利贴/上传素材/提问球）→ **Agent 加工**（工作台跑任务、收件箱落产出）→ **人审放行**（审核队列）→ **沉淀**（wiki/ entities/concepts/sources + notes/，图谱可视化）→ **复用**（问答、定时任务）→ 循环。

目录约定（`packages/core/src/kb.ts` 的 `KB_DIRS`）：`sources`（原始素材，含 PDF/图片二进制）、`wiki/entities`、`wiki/concepts`、`wiki/sources`（AI 消化产物）、`wiki/queries`（问答留痕）、`notes`（手写笔记）、`inbox`（定时任务产出，**不在 KB_DIRS 内、不进检索图谱**）、`bulletins`（便利贴）。

## 2. 问题诊断

1. **IA 摊平**：12 个平级入口把「内容库」「处理流水线」「系统面」三种角色混排，新用户难以建立「我该去哪」的心智模型。
2. **笔记页**：「我的」与「库」切换已有，但库页面把 entities/concepts/sources/queries 四类混在一个长列表里，页面数上百后不可用。
3. **素材页**：PDF 上传后（走 MinerU 解析）原始文件只能下载打开，无法在站内「看一眼源文件」。
4. **便利贴 vs 收件箱心智混淆**：两者都是「未处理的东西」，但一个是人的输入、一个是 AI 的输出，平级导航放大了混淆。
5. **设置页纵向堆叠**：LLM 双角色 + Tavily + MinerU + 数据目录等块全部长条堆叠，定位一个配置要滚很久。

## 3. 用户旅程与导航重组（D6，需二次对稿后执行）

按主线旅程把导航分四章节（每组内含徽标计数，如审核待办数）：

| 章节 | 含视图 | 旅程角色 |
|---|---|---|
| **收集** | 便利贴（改名「灵感便签」）、素材 | 人→系统的输入 |
| **处理** | 收件箱、审核、工作台 | AI 产出待人消化/人审放行 |
| **知识库** | 总览（作为仪表盘）、笔记、知识图谱 | 沉淀与可视化 |
| **回顾** | 问答历史、设置 | 复用与系统面 |

悬浮球不属于任何章节（全局常驻）。此重组**只动 `App.jsx` 的 NAV 数组与 sidebar 渲染**，不改路由与各视图内部。注意：分组标签语义需与产品负责人二次确认后执行，执行时保持各视图 id 不变（深链 `#/inbox` 等不破坏）。

## 4. 关键调研结论（D3）：PDF 阅读器选型

产品负责人最初提议 [KillerPDF](https://github.com/SteveTheKiller/KillerPDF)。调研结论：**它不适用**——KillerPDF 是 Windows 专用桌面 PDF 编辑器（.NET Framework 4.8，6MB 单文件 exe，GPLv3，pdfium 位图渲染），完全本地离线运行，无任何可嵌入 web 前端的形态。

web 内嵌的正确选型（按重量递增）：

| 方案 | 依赖 | 说明 |
|---|---|---|
| `<iframe src="/api/v1/sources/xxx.pdf">` | 零 | Chrome/Safari 内置 viewer（均基于 pdf.js 系），满足「看一眼」80% 需求。**v0.3.x 采用** |
| `pdfjs-dist` 直用 | ~1MB | Mozilla pdf.js 官方 npm 包（45k stars，Firefox 内置渲染器），React 生态有封装层 `react-pdf`。可做缩放/目录/搜索/自定义 UI。**v0.4 再评估** |

一期唯一的服务端工作：给 `sources/` 下的二进制加**只读静态路由**（注意 Content-Type 正确返回 `application/pdf`，路径校验防 `..` 穿越——参照 `apps/server/src/inbox.ts` 的 readInboxItem 模式）。

## 5. 任务块（自包含，可独立认领）

> 执行约定：所有改动在 `feat/v0.3-agent` 分支；UI 改动需浏览器实测截图验证；完成一批即 commit + push，commit message 用 `feat(ui):`/`fix:` 前缀；不破坏既有深链（`#/view-id`）。

### T1 · 笔记库页面分类折叠 + 类型过滤（D2）——预计半天

- 文件：`apps/web/src/views/Notes.jsx`（「库」子视图）、`apps/web/src/styles.css`
- 现状：库页面平铺列出 `wiki/entities|concepts|sources|queries` 全部页面为一个长列表
- 改动：
  1. 按目录分 4 组，每组渲染为可折叠 section（默认折叠，标题行 `实体（37）` 这类计数）
  2. 顶部加类型过滤 chips：`全部 / 实体 / 概念 / 素材页 / 问答`，选中过滤列表
  3. 折叠状态存组件本地 state 即可（不要求持久化）
- 验收：4 组各自计数正确；chip 过滤后列表只剩对应类型；展开/收起动画不影响页内搜索（如已有搜索框则过滤逻辑与之叠加）

### T2 · 设置页选项卡化（D5）——预计半天

- 文件：`apps/web/src/views/Settings.jsx`、`apps/web/src/styles.css`
- 现状：LLM 双角色卡（ingest/query）、Tavily 卡、MinerU 卡等纵向堆叠
- 改动：
  1. 顶部 tab 行：`模型`（LLM 双角色）/ `联网`（Tavily + MinerU）/ `存储与版本`（若有 git/数据目录配置块，没有则并入「关于」）/ `关于`（版本、仓库链接、健康自检入口如有）
  2. tab 状态本地 state；各卡**原逻辑不动**，只是搬进对应 tab 的容器
  3. 移动端（窄屏）tab 可横向滚动
- 验收：各配置保存/测试按钮在 tab 内行为不变；切换 tab 不丢已填未存的草稿（可接受丢失但要在 PR 描述注明）

### T3 · 素材 PDF 站内预览（D3 一期）——预计半天到一天

- 文件：`apps/server/src/index.ts`（新路由）、`apps/web/src/views/Sources.jsx`、`apps/web/src/styles.css`
- 服务端：`GET /api/v1/sources-file/:name`——name 为 `sources/` 目录内文件名（平铺，无子目录），校验扩展名 `\.(pdf|png|jpe?g|webp|gif)$/i` + 防穿越，`reply.type()` 按 MIME 返回；只读
- 前端：素材列表中 `.pdf` 条目加「预览」按钮，点开行内 `<iframe>`（或模态）加载该路由；非 PDF 图片可直接 `<img>`
- 验收：上传的 PDF 能在站内 iframe 中渲染滚动翻页；非法路径（含 `..`、非白名单扩展名）返回 404；不影响既有 MinerU 解析流程
- 注意：不要在这一期引入 pdfjs-dist——留给 v0.4 的 T5

### T4 · 导航四章节分组（D6）——需产品负责人确认分组稿后执行

- 文件：`apps/web/src/App.jsx`（NAV 数组 + sidebar 渲染）、`apps/web/src/styles.css`
- 见 §3。验收：12 个视图 id 与路由不变，仅分组展示变化；各章节标题旁显示待办徽标（审核队列长度等，如已有 API 则复用）

### T5 · pdf.js 完整阅读器（D3 二期）——**v0.4 范围，本期不做**

- 候选：`pdfjs-dist`（注意 worker 配置，Vite 下用 `import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'` 或 `new Worker(new URL(...))`）；功能基线：页码跳转、缩放、全文搜索

## 6. 验证与回归要求

- 每完成一个任务块：`npm run typecheck`（三包全过）+ `npm test`（当前基线 **122 pass / 0 fail**，不得引入新失败）
- 浏览器实测：`npm start` 起 :3100/:5175（注意 server dev 脚本**非 watch 模式**，改服务端代码必须杀进程重启）；悬浮球 ⌘/Ctrl+Enter、收件箱展开、审核队列等受影响路径回归
- 本提案涉及改动均为 UI/只读路由层，**不得动 ingest 管线、闸门、agent loop、scheduler**

## 7. 争议与遗留

- 「便利贴改名灵感便签」的具体文案未定稿（D4 只定了不合并、归「处理」分组——注意 §3 把它放进了「收集」，两处讨论口径以实现时产品负责人现场确认为准）
- 总览页去留：若四章节成立，「总览」作为知识库章节的仪表盘是否降为「知识库」默认子页，留 T4 时一并定
