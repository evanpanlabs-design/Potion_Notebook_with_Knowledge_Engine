# Potion · Knowledge Engine

> 替你消化知识的笔记本 —— 你写笔记，它替你把素材消化成结构化 Wiki，两者互为一等公民。

Potion 是一个**本地优先**的知识管理应用：把文章、笔记、想法投喂给引擎，两段式 LLM 管道会将素材消化成互相链接的 Wiki 页面（实体 / 概念 / 来源摘要）；你随时用自己的笔记（Note）与这套 Wiki 双向链接。所有产物都是纯 Markdown 文件 + git 版本管理 —— **知识库永远属于你，随时可以用 Obsidian 打开**。

![总览](docs/demo/screenshots/v02-overview.png)

## 演示

[▶ 观看完整演示（约 2 分 50 秒）](docs/demo/demo.mp4)：从空库开始，投喂素材并观察引擎工作台的实时流式生成，审核把关，跨来源提问，最后在知识图谱中查看整体结构。

## 设计理念

现有笔记工具存在两难：Notion/Obsidian 的结构靠人肉维护，难以持续；AI 笔记工具生成的内容黑盒存储、无法溯源、难以信任。Potion 的答案是**信任设计**：

- **溯源**：每张 AI 生成页的 frontmatter 带 `sources[]`，正文引用可点击跳转
- **人审**：AI 落盘的页面默认进入审核队列，通过才算正式知识；驳回即删除；**驳回之外还可返修**——写一条修改意见进返修池，攒一批后让 LLM 统一修复，修完回到待审
- **活结构**：Wiki 不是一次性生成物——编辑任意页面后点「同步到知识库」，LLM 感知 diff 对关联页面做局部维护
- **回滚**：一次操作 = 一次 git 提交，任何动作可整体回滚
- **Note 神圣性**：`notes/` 目录只由人写入，git 历史可证明
- **成本透明**：每次 ingest/query 逐次展示 token 消耗，LLM 流式输出全程显化
- **零锁定**：全库纯 Markdown，随时迁出

## 快速开始

```bash
# 要求：Node.js ≥ 22
npm install
npm start          # 同时启动 server(:3100) 与 web(:5175)
```

打开 http://localhost:5175 ，新建知识库后投喂第一篇素材即可。LLM 接口通过 `.env` 配置，也可在应用内的「设置」页填写（OpenAI 兼容 / Anthropic 协议，ingest 与 query 可分别用不同厂商/模型，保存即生效）：

```ini
LLM_BASE_URL=https://api.example.com/v1
LLM_API_KEY=sk-xxx
LLM_MODEL_INGEST=gpt-4o-mini    # 摄取用（可选）
LLM_MODEL_QUERY=gpt-4o          # 问答用（可选）
```

![LLM 双引擎设置页](docs/demo/screenshots/v02-settings.png)

## 功能

| 模块 | 说明 |
|---|---|
| 文档工作台 | 我的笔记（项目分层）与库页面（wiki/sources）双 tab，全部文档可查看编辑；每篇笔记带消化状态徽标（未消化 / 已同步 / 有改动未同步），一键「同步到知识库」触发消化或局部维护 |
| 投喂素材 | 粘贴 Markdown/文本 → 两段式消化（分析 → 生成）→ 闸门校验 → 落盘；LLM 实时输出全程可视化 |
| 提问 | 级联检索（词法 + 图扩展）→ 生成带引用的回答；无依据时明说，不编造；回答后可展开**关联知识图谱**局部子图 |
| 审核 | AI 生成页默认待审：通过 / 驳回删除 / **💬 返修附意见**；返修池支持「⚙ 统一修复」批量执行，运行期间新意见自动暂缓进池 |
| 知识图谱 | 实体 / 概念 / 笔记 / 问答的 wikilink 关系网络，支持缩放平移与布局参数调节 |
| 总览 | 库状态、`log.md` 操作流水时间线（ingest / query / edit / sync / rework…）、index 目录 |

![文档工作台：笔记编辑 + 消化状态](docs/demo/screenshots/v02-notes-editor.png)

笔记的消化状态由 frontmatter 元数据（`ingested_sha256` / `last_ingested_at`）驱动：编辑保存后自动变「有改动未同步」，点「⚙ 同步到知识库」消化后回到「已同步」——你永远知道哪些改动还没进引擎。

![提问后展开关联知识图谱局部子图](docs/demo/screenshots/ask-subgraph.png)

## 架构

```
┌────────────┐   HTTP    ┌─────────────────────────────┐
│  Web (vite) │ ───────▶ │  Server (Fastify)           │
│  React+CM6  │           │  ├─ ingest-pipeline（两段式）│
└────────────┘            │  ├─ maintain-pipeline（同步）│
                          │  ├─ query-pipeline（级联检索）│
                          │  └─ @ke/core（闸门/日志/索引） │
                          └──────────┬──────────────────┘
                                     │ 唯一写通道（gate executor）
                          ┌──────────▼──────────────────┐
                          │  data/my-wiki/（纯 Markdown）│
                          │  ├─ notes/   只由人写入      │
                          │  ├─ wiki/    AI 生成，默认待审│
                          │  ├─ index.md log.md AGENTS.md│
                          │  └─ .git（一次操作一次提交）  │
                          └─────────────────────────────┘
```

两段式 ingest（ARCHITECTURE §6.2）：**Phase 1 analyze** 将素材分析为结构化 JSON（实体 / 概念 / claims，带出处 locus）→ **Phase 2 generate** 逐页生成结构化正文（实体页：概述/关键事实/关系网络/来源；概念页：定义/机制/相关概念/常见误区）→ **闸门校验链**（命名 / 重复 / 标签词表 / 路径越界）→ 落盘 → git 提交。闸门是唯一写通道，AI 没有绕过它的路径。

![知识图谱：27 节点 wikilink 网络](docs/demo/screenshots/v02-graph.png)

## 工程实践

- **Monorepo**（npm workspaces）：`packages/core`（闸门、索引、日志、schema）、`packages/agent-tools`（LLM 路由 + RPM 门控 + OpenAI/Anthropic 双协议）、`apps/server`、`apps/web`
- **TypeScript 严格模式** + TypeBox schema 校验 LLM 输出（不合 schema 自动回喂修复一轮）
- **测试**：`npm test`（node:test，41 用例覆盖闸门校验链、索引重建、日志解析等核心纯函数）
- **韧性**：LLM 429 按 3s/8s/15s 退避重试；重复投喂同一来源按 sha256 幂等跳过
- **审计**：`log.md` 记录每次 ingest/query/note/edit/sync/review/rework，前端时间线可视化
- **SSE 显化**：LLM 流式 token、管道阶段、耗时指标经 `/api/events` 实时推送，无黑盒等待

![审核：三处置 + 返修意见](docs/demo/screenshots/v02-review.png)

## 文档

- [PRD](PRD.md) — 产品定义与信任设计原则
- [SPEC](docs/SPEC.md) — 功能规格与 MVP 验收
- [ARCHITECTURE](docs/ARCHITECTURE.md) — 模块划分与 API 契约
- [ADR-001](docs/ADR-001-mvp-scope.md) — MVP 范围决策
- [ADR-002](docs/ADR-002-v0.2.md) — v0.2 文档工作台/返修池决策 + Agent 化三阶段路线

---

local-first · 纯 Markdown · 无锁定
