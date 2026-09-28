# Knowledge Engine · 技术架构

> 配套：[PRD.md](../PRD.md) · [ROADMAP.md](../ROADMAP.md) · [SPEC.md](SPEC.md)
>
> 本文档定义**怎么建**：模块边界、数据模型、Agent 工具契约、写入闸门、ingest/query 管道。产品行为见 SPEC.md。

---

## 1. 系统总览

```
浏览器前端（apps/web · Vite + React）
   │  REST + SSE（仅 127.0.0.1）
Node 后端（apps/server · Fastify）
   ├─ API 层：REST + SSE 流式
   ├─ Agent 编排：pi-agent-core（工具调用 + 状态）
   │    ├─ LLM：pi-ai（多 provider；ingest 与 query 分别路由）
   │    └─ 工具集：packages/agent-tools（全部只读或提案级）
   ├─ 写入闸门：gate executor（唯一能执行 git 的模块）
   ├─ 持久队列：pi-durable（ingest 队列，崩溃恢复）
   └─ 领域逻辑：packages/core（纯函数，无 IO）
         ↓
   本地知识库（Markdown 文件夹 + git 仓库）
```

**职责铁律**

- Agent **永远不持有裸文件写权限**——工具集里没有 `write_file`。
- 只有 gate executor 能执行写入与 git 提交；Agent 只能产出"提案"。
- `packages/core` 无 IO、无网络、无文件系统——检索、图、lint、frontmatter 全是纯函数，可全量单测。

### Monorepo 布局

```
knowledge-engine/
├── apps/
│   ├── server/        Fastify + Agent 编排 + gate executor
│   └── web/           Vite + React + Milkdown + sigma.js
├── packages/
│   ├── core/          领域逻辑：frontmatter / 检索级联 / 图 / lint
│   └── agent-tools/   pi 工具契约 + 适配层（隔离 pi API 变化）
├── docs/              SPEC / ARCHITECTURE / research / adr
├── PRD.md
└── ROADMAP.md
```

服务器选型在 Fastify 与 Hono 之间取 **Fastify**：TypeBox 内建 schema 校验（正好做 LLM 结构化输出与 API 入参的双重校验）、SSE 与静态服务成熟。M0 起冻结，不再议。

---

## 2. 数据层

### 2.1 知识库目录

```
<knowledge-base>/
├── AGENTS.md          Schema：Agent 操作规程（人可改，git 可追溯）
├── index.md           内容目录（内容导向，每次 ingest 更新）
├── log.md             操作流水（时间导向，append-only）
├── sources/           原料层（不可变）
├── notes/             思考层（人所有）
└── wiki/
    ├── entities/      人物 / 组织 / 产品 / 事件
    ├── concepts/      理论 / 方法 / 术语
    ├── sources/       每篇来源的摘要页
    ├── queries/       归档的好答案
    └── synthesis/     跨来源综述 / 对比页
```

与 Obsidian vault 惯例完全兼容：`[[wikilink]]`、frontmatter、纯 Markdown。`.obsidian/` 不生成（不依赖它，但欢迎用户自己开）。

### 2.2 Frontmatter schema

**来源摘要页（wiki/sources/）**

```yaml
type: source
title: 原文标题
source: sources/<文件名>     # 或直接 url
url: https://…              # 可选
sha256: <内容哈希>
ingested_at: 2026-10-12T10:30:00+08:00
tokens: { analysis: 8420, generation: 12650 }
```

**实体 / 概念页（wiki/entities|concepts/）**

```yaml
type: entity        # 或 concept
title: 页面标题
aliases: [别名, 缩写]
sources: [sources/foo.pdf, sources/bar.md]   # 强制：无 sources 不得落盘
tags: [来自词表的标签]
reviewed: false     # true = 受人审保护，Agent 不得覆盖
updated_at: ISO8601
```

**笔记（notes/）**

```yaml
type: note
title: 标题
created_at: ISO8601
updated_at: ISO8601
provenance: manual | archived-thread | pulled-from-wiki   # 来源标记
sources: []       # 可选：有引用时填
```

**归档答案（wiki/queries/）**

```yaml
type: query
question: 原问题
sources: []
created_at: ISO8601
```

### 2.3 index.md 与 log.md

- `index.md`：按类别（entities/concepts/sources/queries/synthesis）分组，每行 `- [[页面]] · 一句话摘要`。每次 ingest 后重建相关段，保持与实际页面一致。它同时是 query 的第一导航入口。
- `log.md`：append-only，条目格式 `## [YYYY-MM-DD HH:mm] <op> | <标题>`，`op ∈ {ingest, query, lint, review, note}`。`grep "^## \[" log.md | tail -5` 即最近 5 条——Karpathy 的可解析约定原样保留。

### 2.4 Tag 词表（唯一真源）

允许的标签集合定义在 AGENTS.md 的 `tags:` 段。写入闸门据此校验：**词表外的值直接丢弃并记录校验警告，不落盘**。LLM 被提供的选项、写入闸门、lint 三处读同一份词表——模型看到什么，盘上就落什么（obsidian-llm-wiki 验证过的防漂移设计）。

---

## 3. Agent 层：pi 集成

| pi 包 | 我们用它做什么 | 不用它做什么 |
|---|---|---|
| `pi-ai` | 多 provider LLM 调用；ingest 与 query 分别路由（ingest → 便宜模型，query/综合 → 强模型） | 不绕过它自己写 fetch |
| `pi-agent-core` | Agent 运行时：工具调用循环、状态管理 | 不用它的 CLI 形态，以库嵌入 |
| `pi-durable` | ingest 持久队列：串行处理、崩溃恢复、失败重试 | 不手写队列文件格式 |

**pi 无内置权限系统**（以其 README 为准：默认以启动者权限运行）。因此工具分级与写入闸门是**我们自己的责任**——这也是本项目的信任设计核心，见 §4。

### 3.1 工具契约

Agent 可见工具全部只读或提案级。副作用分三级：**R**（只读）/ **P**（仅写入待审区）/ **GW**（门控写：仅由 gate executor 在人审批准后执行）。

| 工具 | 输入（要点） | 输出 | 级别 |
|---|---|---|---|
| `read_index` | `—` | index.md 解析结果 | R |
| `search_wiki` | `{query, scope?}` | 排序后的页面候选（标题+别名+摘要+路径） | R |
| `read_page` | `{path}` | 页面正文 + frontmatter | R |
| `read_source` | `{source_id}` | 原文内容（截断到预算） | R |
| `analyze_source` | `{source_id}` | 结构化分析（Phase 1，见 §5） | R（纯 LLM 调用） |
| `draft_wiki_update` | `{analysis}` | 结构化更新提案（Phase 2） | P |
| `propose_review` | `{kind, diff, actions[]}` | 待审项（动作必须是预定义枚举） | P |
| `promote_note_draft` | `{note_path, selection?}` | 提升草稿（进 Review） | P |
| `pull_wiki_to_note` | `{wiki_path}` | 带引用的笔记草稿 | GW（用户显式点击触发） |
| `lint_wiki` | `—` | 四类问题报告 | R |
| `graph_query` | `{node?, depth, filters?}` | 子图（节点+边+权重） | R |

工具入参出参用 TypeBox 定义 JSON schema，同一份 schema 同时用于：pi 工具注册、LLM 结构化输出校验、API 层校验。**一份 schema，三处复用。**

---

## 4. 写入闸门（Write Gate）

pi 没有权限系统，所以闸门完全由 `packages/agent-tools` + gate executor 实现：

```
Agent 提案（draft_wiki_update / propose_review）
   → 校验链 → 全部通过才进入待执行队列
       1. frontmatter schema 校验（TypeBox）
       2. tag 词表校验（界外值丢弃并警告）
       3. sources[] 存在性校验（引用的来源必须真实存在）
       4. reviewed:true 保护（既有页只允许追加，不允许覆盖）
       5. note 保护（notes/ 路径除 pull_wiki_to_note 外一律拒绝）
   → 人审（Review Queue）批准
   → gate executor 执行写入 + git 提交（唯一写通道）
```

**提交粒度与信息规范**

| 操作 | 提交信息 |
|---|---|
| 一次 ingest | `ingest: <来源标题>` |
| 一次 review 决策 | `review: <id> <action>` |
| 笔记保存 | `note: <标题>` |
| schema 修改 | `schema: <摘要>` |
| 拉取草稿 | `note: pull from <wiki页>` |

一次操作 = 一次提交 = 一个可 `git revert` 的回滚单元。校验链任何一环失败 = **零落盘**（不存在"写了一半"的中间态）。

---

## 5. Ingest 管道

```
入队（pi-durable，串行）
  → SHA256 缓存检查（未变来源直接跳过）
  → Phase 1 · 分析（LLM，结构化输出）
       读：来源全文 + index.md + 相关页
       出：实体/概念清单、与现有 wiki 的关联、矛盾点、建议更新页
  → Phase 2 · 生成（LLM，结构化输出）
       读：Phase 1 分析
       出：页面更新方案（新建/更新哪些页，全部带 sources[]）
  → 写入闸门校验（§4 校验链）
  → gate executor：写 wiki/ + 重建 index.md 相关段 + 追加 log.md + git 提交
  → 矛盾/合并/覆盖建议 → Review Queue（不阻塞完成）
  → 完成（token 消耗入账）
```

**可靠性**

- Phase 1/2 输出各自有 TypeBox schema；校验失败 = 任务失败，自动重试 ≤ 3 次（重试附加"修正提示"），仍失败则停在队列中可人工重试。
- 队列持久化在 pi-durable：应用崩溃重启后未完成任务自动续跑，不丢不重。
- **级联删除**（M3 起，Backlog 升级项）：删除已消化来源 → 进 Review Queue；批准后删来源摘要页、从共享实体页的 `sources[]` 中摘除该来源（多来源共享页不整页删除）、清理死链、更新 index.md——整个过程一次 git 提交。

---

## 6. Query 管道（5 段级联 + Monte Carlo PPR）

```
L1 词法快速路径：标题/别名 token 重叠（中英文分词，CJK bigram）
    ├─ 信号足够 → 直接进 L5
L2 LLM 关键词生成：8-12 个跨语言关键词
L3 本地子串扫描：关键词对标题/别名/正文再匹配
    ├─ 信号足够 → 进 L5
L4 LLM 兜底重筛：前 N 候选交 LLM 做一次语义判定（仅在 L1-L3 皆弱时）
L5 Monte Carlo PPR 图扩展：
       3,000 次随机游走 × 50 步，O(K×L) 与页数无关
       从候选种子沿 wikilink+共现边扩散，带衰减
→ 预算分配：60% wiki 页 / 20% 对话历史 / 5% index / 15% 系统提示
→ 上下文组装：页面全文按"检索分+图分"排序，编号引用 [1][2]…
→ 流式回答 + 引用面板
```

**设计要点**

- 级联截断：L1 命中就不花 L2 的钱，L3 够就不进 L4——便宜优先，逐级加码。
- PPR 复杂度与页数无关，正好覆盖规模目标（2000 页时扩展延迟与 200 页同量级）。
- **只读原文模式**：scope 限定 `sources/`，跳过 wiki 综合，答案仅由原文生成。
- **无依据回答**是硬约束：检索空手而回时，系统提示强制回答"库内无依据"，不编造。对抗性测试用例固化此行为。
- 向量检索默认关闭；LanceDB 留作可选开关，开启前用同一测试集 benchmark 与本管线对比，数据说话。

---

## 7. Graph

### 7.1 4 信号相关度（边权）

| 信号 | 权重 | 含义 |
|---|---|---|
| 直链 | ×3.0 | 两页有 `[[wikilink]]` 直连 |
| 来源共现 | ×4.0 | 两页 frontmatter `sources[]` 共享同一来源 |
| Adamic-Adar | ×1.5 | 共同邻居加权（低度邻居贡献更高） |
| 类型亲和 | ×1.0 | 同类页面（entity↔entity 等）加成 |

### 7.2 社区与洞察

- **Louvain 社区发现**（graphology-communities-louvain）：着色模式之一；凝聚力 = 社区内实际边 / 可能边，`< 0.15` 且 ≥ 3 页 → 标记稀疏社区。
- **孤岛**：度 ≤ 1 的页面。
- **桥节点**：连接 ≥ 3 个社区的页面。
- **意外连接**：跨社区/跨类型的高相关度边（复合惊奇分排序）。
- 布局位置缓存：数据更新时保持未变节点坐标，避免整图跳动。

图构建在 `packages/core` 纯函数内完成（frontmatter + wikilink 解析 → graphology 图），UI 只消费序列化结果。

---

## 8. API 面（示意，M1 定稿）

仅绑定 `127.0.0.1`，不做鉴权（本地单用户）。

```
POST /api/v1/sources             添加来源（文件/URL/文本）→ 入队
GET  /api/v1/queue               ingest 队列状态（SSE 进度推送）
POST /api/v1/query               提问 → SSE 流式回答 + 引用
GET  /api/v1/graph               图数据（节点/边/权重/社区）
GET  /api/v1/pages/*path         读任意库内页面
POST /api/v1/notes               新建/保存笔记（人的通道）
GET  /api/v1/reviews             Review 列表
POST /api/v1/reviews/:id/resolve 处理（approve/reject/redo）
GET  /api/v1/lint                触发/读取 lint 报告
GET  /api/v1/commits/:sha        读 diff（Activity/Review 跳转用）
GET  /api/v1/settings            模型路由/成本/队列配置
```

Web 前端是唯一一等客户端；本地 HTTP API 的对外开放（给外部 agent 用）在 Backlog，不在 MVP。

---

## 9. 错误处理与回滚

| 故障 | 行为 |
|---|---|
| LLM 超时/429/5xx | 退避重试；ingest 路由降级到备用便宜模型链 |
| 结构化输出校验失败 | 任务失败（零落盘），重试 ≤ 3 次，附修正提示 |
| 闸门校验失败 | 提案拒绝，原因进 Activity/Review，不部分写入 |
| 应用崩溃 | pi-durable 队列恢复，未完成任务续跑，不丢不重 |
| 误操作/坏内容 | 对应 git 提交 `revert`，单提交恢复 |
| schema 文件损坏 | 保存前 TypeBox+语法校验拦截，库照常可用 |

回滚语义：**每次操作一个提交**，所以任何一次 Agent 行为都可以被单独撤销，而不牵连相邻操作。

---

## 10. 测试策略

| 层 | 内容 |
|---|---|
| 单元（packages/core） | frontmatter 解析、检索级联各段、4 信号、PPR、Louvain 封装、lint 规则、index/log 生成——全量覆盖，无网络无 token |
| 闸门测试 | 用**固化 fixture**（真实 LLM 输出样本存档）驱动校验链：无 sources 落盘必须被拒、词表外 tag 被丢、`reviewed:true` 不被覆盖、notes/ 写入被拒 |
| 对抗测试 | 无依据问题必须答"无依据"；矛盾来源必须进 Review 而非静默覆盖 |
| e2e（Playwright） | MVP 地狱测试脚本自动化：建库 → 5 来源 → wiki 成形 → 笔记 → 提问 → 归档 → 图谱 |
| 冒烟 | `npm install && npm start` 后健康检查通过 |

fixture 快照测试是关键设计：**LLM 行为回归不花 token**——把真实输出存成样本，闸门与解析器的回归全在本地跑。

---

## 11. 工程约定

- **TypeScript strict** 全仓；ESLint + Prettier 统一格式。
- **pi 版本锁定**：`save-exact` 精确版本；`packages/agent-tools` 是唯一 import pi 的地方（适配层），pi 升级只动适配层，M0 后每两周评估一次。
- **直接依赖从紧**：每加一个依赖都要能在 ADR 里写出一句话理由（借鉴 pi 仓库自身的供应链纪律）。
- **单命令启动**：`npm install && npm start` 是产品的一部分，任何破坏它的改动都是回归。
- 提交信息规范见 §4；每个里程碑的 gate 验证命令进 CI（W3 起 GitHub Actions 跑 check + 冒烟）。
