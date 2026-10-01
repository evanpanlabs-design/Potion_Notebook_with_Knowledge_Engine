# IA 收束 v0.3.x · 执行方案（已定稿）

> 状态：**已定稿（2026-10-01 与负责人对齐）** · 批次 A 开工
> 上游：[IA-CONVERGENCE-v0.3.md](IA-CONVERGENCE-v0.3.md)（ac8778f）
> 本文 = 代码级调研结论 + 对提案 T1-T4 的落地细化。

---

## 0. 调研结论总览（影响执行的五个事实）

代码基线：`feat/v0.3-agent` @ ac8778f，`npm test` **122 pass / 0 fail**，`typecheck` 三包全绿（2026-10-01 实测）。

| # | 发现 | 对提案的影响 |
|---|---|---|
| F1 | **PDF 原始二进制从未落盘**。`POST /mineru/convert`（index.ts:342）收到 bytes 后只上传 MinerU，完成后仅落盘解析出的 `full.md`（mineru.ts）。实测 `data/my-wiki/sources/` 只有 5 个 .md，无任何二进制 | **T3 存在前提缺口**——提案 §1 说「sources（原始素材，含 PDF/图片二进制）」与现状不符。必须先补「上传时二进制落盘」，否则静态路由无文件可服务 |
| F2 | **深链不存在**。web 用 `useState` 管视图（App.jsx:179），main.jsx 无 hash/router，URL 全程不变 | 提案多处强调「不破坏 `#/view-id` 深链」是**不存在的功能**。T4 可顺势补真深链（hash 同步约 20 行），或仅纠正提案表述 |
| F3 | 库页面**已按目录分组**（Notes.jsx `libGroups`，wiki/entities 等自然成组），缺的是折叠交互、类型 chips、每类计数 | T1 工作量比提案预估（半天）更小，纯增量交互 |
| F4 | 设置页无任何「存储与版本」配置块；「关于」也无现成内容（仅 `/api/health` 可用） | T2 的四 tab 里「存储与版本」无内容可搬。建议改为三 tab 起步（模型/联网/关于），或造一个**只读存储信息卡**（KB 路径、git HEAD、页面统计——`/api/kb/status` 数据现成） |
| F5 | `walkMd` 只收集 `.md`（kb.ts:97）；`data/` 整体 gitignore | F1 的补救是安全的：二进制落盘 `sources/` **不污染** scanKb 快照、**不进** git。但 `/api/v1/sources` 列表来自 `scanKb().sources`（仅 .md），需扩展才能显示 PDF 条目 |

其余执行环境事实：vite 代理把前端 `/api/*` 重写为 `/api/v1/*`（iframe src 直接写 `/api/sources-file/x.pdf` 即可）；server dev 脚本非 watch 模式（改服务端代码须杀进程重启）；MinerU 上传已有 200MB/20 文件 multipart 限制可复用。

---

## 1. 执行批次与顺序

提案的 T1→T2→T3→T4 顺序保持，按提交粒度分三批。每批完成即 commit+push（`feat(ui):` / `fix:` 前缀），跑 typecheck + test（122 基线）+ 浏览器实测截图。

### 批次 A · T1 + T2（纯前端，预计半天）

**A1 · 笔记库分类折叠 + 类型过滤**（`Notes.jsx` library tab + `styles.css`）

现状：`tab === 'library'` 渲染 `libGroups`（按目录字符串分组的平铺列表，目录名直接显示 `wiki/entities` 这类原始路径）。

改动：
1. 目录名 → 中文类型名映射：`wiki/entities→实体`、`wiki/concepts→概念`、`wiki/sources→素材页`、`wiki/queries→问答`、其余目录原样显示（防御未来新目录）
2. 每组渲染为可折叠 section（默认**折叠**）：标题行 `▸ 实体（37）`，点击展开/收起；折叠状态存组件本地 state（`useState` 的 Record<dir, boolean>，不持久化）
3. library tab 顶部加类型过滤 chips：`全部 / 实体 / 概念 / 素材页 / 问答`，选中后只显示对应组（chips 与折叠独立运作）
4. 组内列表项渲染逻辑**不动**（openDoc / reviewed 标记照旧）

验收：各组计数正确；chip 过滤后只剩对应类型；折叠不影响「我的笔记」tab；编辑器与保存链路回归正常。

**A2 · 设置页选项卡化**（`Settings.jsx` + `styles.css`）

Tab 划分（结合 F4 调整，**待拍板项 P2**）：
- `模型`：双 RoleForm + 底部保存行（整块搬运，逻辑零改动）
- `联网`：TavilyCard（MinerU 是否归此 tab 见 P3）
- `关于`：新增只读信息卡——版本 v0.3、仓库链接、`/api/health` 自检按钮、KB 路径（来自 health 响应 `kb` 字段）

实现：tab state 本地 `useState`；各卡片组件**原样搬进 tab 容器**不拆内部；tab 行窄屏横向滚动（`overflow-x: auto`）。已填未存草稿切换 tab 会保留（组件不卸载，仅 CSS 隐藏——用 `display:none` 而非条件渲染，天然满足提案的草稿保留要求且比提案预期更好）。

### 批次 B · T3 素材 PDF 站内预览（前后端，预计一天）

结合 F1 拆成四步，**B1 是提案没有的前置补救**：

**B1 · 上传时原始二进制落盘**（`index.ts` mineru/convert 路由）
- multipart 迭代收集 bytes 时同步 `writeFile(KB_ROOT/sources/assets/<安全名>, bytes)`；文件名沿用 `mineruSourcePath` 同款清洗（非白名单字符换 `-`，重名加时间戳后缀）
- 任务记录里加 `sourceBinPath` 字段留痕（tasks.json 结构兼容追加，老任务无此字段不受影响）
- 历史上传无法追溯补存（MinerU 侧 zip 有时效），仅对新上传生效——文档里明说
- 落盘在上传请求内同步完成，**不依赖解析成败**：解析失败也能预览原件

**B2 · 只读静态路由**（`index.ts` 新增）
- `GET /api/v1/sources-file/:name`：`name` 白名单 `\.(pdf|png|jpe?g|webp|gif|bmp)$`（对齐 MinerU 支持的图片类）；`..`/绝对路径/子目录一律拒绝（`sources/assets/` 平铺无子目录）；按扩展名映射 MIME（pdf→application/pdf 等）；`readFile` 失败 404。参照 `pages/*` 路由（index.ts:1325）的 normalize+startsWith 越界校验模式
- 只读、无写操作，符合提案「不动数据层」红线

**B3 · 素材列表扩展**（`index.ts` GET /sources + 前端）
- 列表路由额外 readdir `sources/assets/`，返回项带 `kind: 'binary'` 与既有 `kind` 区分；排序规则沿用 mtime 倒序

**B4 · 前端预览**（`Sources.jsx` + `styles.css`）
- 二进制条目点击 → 右栏 `sources-view` 区域渲染：PDF 用 `<iframe src="/api/sources-file/x.pdf">`（height 撑满右栏）；图片直接 `<img>`
- PDF 条目显示 `[PDF]` 徽标 + 大小；保留「下载」兜底（右键新标签打开，零成本）
- 既有 `.md` 素材查看路径完全不动

验收：上传 PDF → 解析中即可预览原件；`curl ../sources-file/../../etc/passwd` 类路径 404；`.exe`/`.md` 请求 404；MinerU 解析流程与自动 ingest 回归正常。

### 批次 C · T4 导航四章节（**等分组稿拍板后执行**）

改动面：`App.jsx` 的 NAV 数组改分组结构 + sidebar 渲染加章节标题；`styles.css`。视图 id、组件挂载逻辑、switchView 防丢稿逻辑全部不动。

分组结构（§3 方案 + 拍板项 P1）：
- 收集：灵感便签（bulletins）、素材（sources）
- 处理：收件箱（inbox）、审核（review）、工作台（workbench）
- 知识库：总览（overview）、笔记（notes）、知识图谱（graph）
- 回顾：问答历史（ask）、设置（settings）

徽标（提案要求）：「处理」章节标题旁挂审核待办数（`/api/v1/review-queue` 的 `queue.length`，App 层已有可复用的轮询/拉取时机——挂 view 切换时惰性刷新即可，避免常驻轮询）；收件箱数（`/api/v1/inbox` 长度）视成本加。

**可选 C+（真深链，结合 F2）**：`useEffect` 双向同步 `location.hash ↔ view`，约 20 行，让 `#/inbox` 真的可分享/刷新保持。若不做，至少把提案里「不破坏深链」表述纠正掉。

---

## 2. 分歧点拍板结果（2026-10-01）

| # | 议题 | 结论 |
|---|---|---|
| P1 | 便利贴归属 | **归「收集」**（人→系统的输入，与素材同侧） |
| P2 | 设置 tab 结构 | **三 tab：模型与解析 / 联网 / 关于**；「关于」内放只读存储信息卡 |
| P3 | MinerU 卡归属 | 并入「模型」tab，tab 名「**模型与解析**」 |
| P4 | 真深链 | **做**——hash ↔ 视图双向同步，并入批次 C 交付 |
| P5 | PDF 二进制落盘位置 | **`sources/assets/` 子目录** |

## 3. 红线与回归清单（每批必过）

- 不动：ingest 管线、闸门、agent loop、scheduler、Milkdown/CM6 编辑器内部
- `npm run typecheck` 三包全绿；`npm test` 维持 122 pass / 0 fail
- 浏览器实测（`npm start` → :3100/:5175；改服务端代码后杀进程重启）：提问球 ⌘/Ctrl+Enter、收件箱展开、审核队列、笔记保存链路
- commit message：`feat(ui):` / `fix:` 前缀，push 到 `feat/v0.3-agent`
