# ADR-001 · MVP 范围裁剪与五项设计决策

> 状态：已接受 · 日期：2026-09-28
> 配套：[PRD.md](../PRD.md) · [docs/SPEC.md](SPEC.md) · [docs/ARCHITECTURE.md](ARCHITECTURE.md) · [ROADMAP.md](../ROADMAP.md)
> 背景：产品决定将 MVP 交付期从 16 周（M0-M4）压缩到 **2 周**。本 ADR 记录裁剪决策与五项设计结论，**排期部分取代 ROADMAP 的 W1-W9 节奏**；ROADMAP 保留为完整愿景版，裁掉的功能不删除、降级进 Backlog。

---

## 0. 决策速览

| # | 议题 | 决策 |
|---|---|---|
| D1 | 记忆系统 | 库即记忆，不建独立记忆模块；工程重点 = 上下文组装器 + index.md 一致性 |
| D2 | RAG / Embedding | MVP 不做本地 embedding；级联检索预留 L3.5 可插拔向量槽位 + RRF 混排；长文档用分层摄入降本 |
| D3 | Hooks | 不建通用 Hook/插件系统；管道阶段边界即钩子（EventEmitter 总线） |
| D4 | AgentLoop | MVP 零自主循环，全确定性管道；loop 只用于 Phase 2 开放式任务，四条围栏先定死 |
| D5 | Harness | 八件套清单（见 §4），其中六件 MVP 必备，第一周成型 |
| D6 | 排期 | 2 周 MVP，日级计划见 §5 |

---

## 1. D1 · 记忆系统：库即记忆

**决策**：不设独立"记忆模块"。git 管理的 Markdown 库本身就是系统的全部记忆，对照认知科学四层：

| 记忆层 | 载体 | 说明 |
|---|---|---|
| 语义记忆 | `wiki/` | 实体/概念页，带 `sources[]` 溯源——每条记忆可回答"从哪知道的" |
| 程序记忆 | `AGENTS.md` | Agent 行为外化为可演化 schema（F8：人与 Agent 共同演化"如何学习"） |
| 情景记忆 | `log.md` + git 历史 + Thread | append-only 流水 + 每操作一提交，任何历史时刻可复原 |
| 工作记忆 | 每任务动态组装 | **不存储、只组装**：ingest = 来源全文 + index.md + 相关页；query = 检索选页 + 对话历史；预算 60/20/5/15 |

**工程重点（两处）**：
1. **上下文组装器**——预算内塞进最相关的页，是所有任务的第一道工序；
2. **index.md 一致性**——每次 ingest 重建相关段，它是 Agent 的"记忆索引"（对应 Karpathy 原文的目录职能），失一致即全局失明。

**拒绝**：向量库记忆、对话历史摘要记忆等任何独立记忆存储形态。理由：可读性、可审计、可 git 回滚是本产品的信任根基。

## 2. D2 · RAG 与本地 Embedding

**先澄清两个易混问题**（评审与面试中高频）：

1. **"从大素材提取内容再 ingest"不是 RAG 的工作。** RAG 是 query 时刻的检索机制（找哪些页进上下文）；ingest 是编译时刻的全量理解问题（读全文 → 产出结构化 wiki 页）。大文档降本靠 **ingest 管道内部分层阅读**：先读目录/标题骨架生成大纲 → 按大纲选择性深读，或分块 map-reduce（每块独立抽取实体 → 合并去重）。embedding 在 ingest 时刻没有"检索目标"，无法承担这道过滤。
2. **本系统本质上就是 RAG**，只是检索信号是词法 + LLM 关键词 + 图扩展（+ 将来的向量）。Query 永远只把"检索选出的页面全文"送进上下文，而非全库。

**决策**：
- 级联检索（ARCHITECTURE §6.5）预留 **L3.5 向量召回槽位**：接口先定（`query → 带分数的候选页列表`），实现后置；
- 开启条件：dogfooding 中词法+关键词召回可见失败案例，且 benchmark 对比数据支持；混合排序用 **RRF（倒数排名融合）**，不做手调权重；
- 若开：JS 生态 `@xenova/transformers`（ONNX 本地推理），中文选 `bge-small-zh-v1.5` 或 `multilingual-e5-small`；chunking 感知 Markdown 结构（按标题层级），chunk 元数据携带来源页 + 章节路径；
- **红线**：向量只是选页信号，答案永远由选中页面全文生成，引用跳转永远落到页面——F5"每条断言可溯源"的验收依赖此条。

## 3. D3 · Hooks：管道边界即钩子，不建插件系统

**决策**：不做通用 Hook/插件机制。系统已有两个更值得投入的可变轴：AGENTS.md（改行为）与工具注册表（改能力）。真正需要的是管道阶段边界的固定事件点：

| 事件点 | 用途 |
|---|---|
| `pre-ingest` | SHA256 判重 |
| `post-analyze` / `post-generate` | UI 进度推送（SSE） |
| `gate:pre-check` / `gate:rejected` | 校验与拒绝原因记录 |
| `post-commit` | 图缓存失效、index 重建、SSE 广播 |

实现：Node 内置 `EventEmitter` 一条内部总线，server 各模块发布、SSE 层与缓存失效逻辑订阅。将来若做本地 HTTP API（Backlog 项），此总线即现成挂点。

**拒绝**：第三方插件注册机制、动态加载、版本协商——全部 Backlog。

## 4. D4 · AgentLoop 与 D5 · Harness

**D4 决策**：MVP 的 F2-F6 主链路全部是**确定性管道**（固定阶段、每阶段单次 LLM 结构化调用），无自主循环。收益：成本可预算、延迟可控、fixture 快照测试成立——这是"可审计"叙事的技术根基。

Loop 仅用于 Phase 2 开放式任务（F9 笔记提升、Deep Research、F13 阅读建议），四条围栏现在定死：

1. 每类任务一张**工具白名单**（提升任务只给只读 + 起草工具）；
2. **最大迭代数 8**；
3. **每步 token 预算**，超限降级为"用已有材料尽力收尾"，不硬崩；
4. 所有副作用只能是 P 级提案（Propose），loop 内永远没有 GW 权限，人审闸门外无写。

**D5 · Harness 八件套**（模型周围的一切）：

| 件 | MVP 必备？ |
|---|---|
| 模型路由（ingest 便宜/query 强，降级链） | ✅ |
| 工具注册表（TypeBox 一份三用） | ✅ |
| 写入闸门 + gate executor | ✅ |
| 持久队列（pi-durable） | ✅ |
| 上下文组装器（预算 + 编号引用） | ✅ |
| Prompt 管理（AGENTS.md 注入系统提示） | ✅ |
| 观测记账（token/费用、log.md、SSE） | ✅（可简） |
| 权限分级 R/P/GW | ✅ |

**结论**：八件中至少六件 M1 期必备 → MVP 第一周必须成型 Harness 骨架。

## 5. D6 · 两周 MVP 日级计划

> 取代 ROADMAP §1-§3 的 W1-W9。锚点：W1 周一 = 2026-09-28。

| 天 | 交付 |
|---|---|
| D1 | M0 压缩为一天：pi 最小验证（LLM 调用 + 受控写文件）+ monorepo 脚手架 + **core 数据模型/frontmatter schema 定稿（不裁，宁可慢）** |
| D2-D4 | F1 建库 + F2 摄入 + F3 两段式 ingest（持久队列）。PDF 只做 pdf-parse 基础文本抽取，失败即明示"存档未消化"不阻塞；长文走最简分块 map-reduce |
| D5-D6 | F4 笔记编辑器 + F5 Query（词法 + 2 跳图扩展，L2 一次 LLM 关键词，L4/PPR 砍）。编辑器预案：Milkdown 验证半天不通即切 CodeMirror + `[[` 补全 |
| D7 | F6 归档 + Review Queue 简化版（无面板：建议写 `review-queue.md` 清单，人批准后执行——闸门语义不丢，UI 成本归零） |
| D8-D9 | F7 Graph 简版（sigma.js 渲染 + 悬停高亮；砍社区着色与布局缓存） |
| D10-D11 | 联调打磨 + 单命令启动 + token 记账 |
| D12-D13 | MVP 地狱测试（来源数 5→3 降档）+ README + demo 录屏 |
| D14 | 纯 buffer |

**裁掉出 MVP 的功能**（全部 Backlog，两周后按真实痛点排序回归）：本地 embedding、agent loop、F12 lint、F8 schema 编辑 UI（AGENTS.md 直接改文件、重启生效）、F9-F14、Web Clipper、Louvain 社区着色。

**多设备分工**：另一台设备（Codex）认领 web 前端（F1/F4/F7 UI + SSE 消费）；本设备认领 server + core（数据模型、ingest 管道、闸门、检索、图构建）。接口契约 = ARCHITECTURE §8 API 面，**开工前冻结**。两边直推 main，小步提交，每日开工先 pull、收工必 push。

## 6. 后果与风险

- **正面**：两周后立即有可用工具 + dogfooding 可提前 5 周启动，求职知识库从 W3 起真实积累；
- **负面**：检索质量上限受限（无 PPR/向量）、Review 体验原始（清单文件）、编辑器可能降级为 CodeMirror——均为演示可接受的降级；
- **风险对冲**：schema 定稿不压缩（ROADMAP"宁可 W3 慢一天也要定稳"原则保留）；范围蔓延风险因工期反而下降——无空隙可蔓延。

## 7. 决策记录

- 2026-09-28 · 多设备设计对谈（本设备）产出五项结论，用户拍板"MVP 两周出" → 成文落库。
