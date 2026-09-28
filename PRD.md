# 知识引擎（Knowledge Engine）产品需求文档 · v0.2

> 状态：方向已拍板，进入 M0 前的最后一版
> 日期：2026-09-28（v0.2 根据形态与意图决策修订）
> 作者：与 Codex 协作起草
> 一句话定位：**一个替你"消化"知识的笔记本——人负责记与问，Agent 负责把原料编译成可复利增长的 Wiki，并让两者互相显化。**

---

## 0. 已拍板的关键决策

| 决策 | 结论 | 一句话理由 |
|---|---|---|
| 产品形态 | **本地 Web 应用**（浏览器 UI + 本地 Node 后端，单命令启动） | 开发最快、演示最方便、与 pi 同为 TypeScript 栈；不做插件、暂不打包桌面壳 |
| 项目意图 | **求职作品集**（2027 春招为目标节点） | 成功标准从商业指标改为"演示力 × 技术深度 × 决策叙事" |
| 第一个用户 | **作者本人**（用本工具管理自己的求职知识库） | dogfooding 是作品集最有说服力的证据链 |
| 与 llm_wiki 关系 | 不 fork，独立实现闭环；M0 精读其源码作架构参考 | 作品集需要展示完整闭环能力，但不必重复踩坑 |
| 多模态边界 | MVP 只做 Markdown / 网页 URL / PDF | 音视频转录放 P2，控制表面积 |

---

## 1. 背景与问题定义

### 1.1 观察到的现实

现有的 AI 知识工具分裂为两个互不通气的范式：

| 范式 | 代表 | 核心机制 | 长处 | 结构性短板 |
|---|---|---|---|---|
| **Notebook 范式** | Google NotebookLM（2026-07 已并入 Gemini Notebook）、open-notebook（39.6k★）、SurfSense（16.3k★） | RAG：查询时从原文检索片段，临时拼答案 | 笔记/来源/对话是一等公民；上手快；笔记体验好 | 知识不积累。每次提问都从零重新发现，答案随对话流失；没有"系统理解了你"的那一层 |
| **LLM Wiki 范式** | Karpathy 模式（2026-04 提出）、nashsu/llm_wiki（20k★）、Tencent/WeKnora（30.7k★） | 编译：LLM 增量维护一个持久 wiki，知识编译一次、持续保鲜 | 知识复利、图谱显化、矛盾与缺口可见 | 人的笔记不是一等公民；写作/思考体验薄；生成内容的信任问题（"AI slop"）悬而未决 |

### 1.2 问题陈述

**个人知识工作者的知识无法同时"被思考"和"被消化"。**

- 笔记（note）是人的思考过程：碎片、私密、演进中、充满半成形的想法。
- Wiki 是系统的理解结果：结构化、互联、可检索、可审计。
- 今天的工具迫使你二选一：要么住在 Notebook 里，知识随对话蒸发；要么住在 Wiki 工具里，沦为给 Agent 投喂原料的"图书管理员"。

Karpathy 本人的工作流（agent 与 Obsidian 分屏并用，"Obsidian 是 IDE，LLM 是程序员，wiki 是代码库"）证明了这个融合需求真实存在，但目前只能靠两个工具人肉桥接。**本项目 = 把 Karpathy 的手工工作流产品化。**

### 1.3 需求验证摘要

- 底层需求：✅ Karpathy gist 五个月催生 15+ 实现、合计 8 万+ star；llm_wiki 单项目 20k★；NotebookLM 主流化。HN 最高相关帖 260 分 / 114 评论。
- 融合需求：✅ 存在但窗口在收窄——open-knowledge（4.3k★）、obsidian-llm-wiki 插件（667★）、claude-obsidian（15.3k★）都在逼近。**机会在差异化，不在首创。**
- 可行性：✅ 架构已被多个开源实现趟平；MVP 单人可达；难在体验质量与信任设计。

---

## 2. 竞品格局与差异化定位

### 2.1 直接竞品解剖

| 产品 | 形态 | ★ | Note 一等公民 | 持久 Wiki | 图谱 | 启示 |
|---|---|---|---|---|---|---|
| nashsu/llm_wiki | Tauri 桌面应用（Rust+TS） | 20k | ❌ 仅 chat/wiki 页编辑 | ✅ 完整 | ✅ 4 信号相关度+Louvain 社区+图谱洞察 | 架构教科书：两段式 ingest、review queue、index.md-first 检索。它的 wiki 目录兼容 Obsidian——承认了自己不做笔记 |
| lfnovo/open-notebook | Web 应用（Python+Next.js+SurrealDB） | 39.6k | ✅ note 是一等对象 | ❌ 只有 RAG 索引 | ❌ | Notebook 范式天花板：note/source/chat 对象模型、transformation 管道值得学 |
| GD4AI/obsidian-llm-wiki | Obsidian 插件 | 667 | 🟡 笔记=待 ingest 的源 | ✅ vault 内 wiki/ | ✅ 复用 Obsidian 图谱 | 笔记与 wiki 是单向关系；检索有公开 benchmark（PPR@5 27.1% vs kNN 24.1%） |
| inkeep/open-knowledge | 桌面+Web 编辑器（TS，GPL-3.0） | 4.3k | ✅ 完整编辑器 | 🟡 靠 starter pack 脚手架 | ✅ wikilink 图 | 与本 idea 最接近；但消化闭环要用户自己组装，非开箱即用 |
| AgriciDaniel/claude-obsidian | Claude Code skill 集合 | 15.3k | 🟡 | ✅ | 🟡 | 证明拼装方案有拥趸，也意味着纯拼装壁垒低 |

### 2.2 未被占据的位置

所有竞品都缺同一件事：**笔记层与 Wiki 层的双向一等公民关系。**

**差异化主张（UVP）：笔记与 Wiki 是两个平等的一等公民层，由同一个 Agent 持续进行双向翻译——你的思考被消化进 Wiki，Wiki 的理解被显化回你的笔记。**

第二条差异化：**把"可审计"做成特色**——所有 LLM 生成内容强制溯源、所有覆盖性操作进人审队列、所有修改 git 可回滚。HN 社区对该品类最大的质疑是"70% 可靠的 wiki 谁敢信"，谁先回答这个问题谁就有叙事制高点。

### 2.3 楔形人群

**深度研究型个人**：用数周到数月攻克一个主题的人——研究生、转行者、独立研究者。来源持续流入（每周 5-20 篇）、需要跨来源综合、有输出压力。

第一个用户即作者本人：**用本产品管理 2027 求职的全部知识**（行业调研、公司研究、面经、项目文档）。这同时构成作品集的核心叙事："我造了这个工具，并且它是真的好用——我自己的求职就是靠它管理的。"

---

## 3. 核心场景（JTBD）

1. **投喂**：读到好东西 → 一键 clip/拖入 → 继续干别的，知道系统会消化它。
2. **消化**：系统读完来源 → 更新 wiki（实体页、概念页、矛盾标记）→ 告诉你"这篇与你上周读的 X 冲突"。
3. **思考**：在笔记里自由写作（人的领地，LLM 不擅自改）；可随手 `[[wikilink]]` 引用、向系统提问。
4. **结晶**：一段笔记想清楚了 → 一键"提升"为 wiki 页（Agent 起草，人批准）。
5. **显化**：打开图谱看知识形状：哪里密集、哪里是孤岛、哪里有桥；让缺口驱动下一步阅读。
6. **回顾**：定期 lint：矛盾、陈旧、孤儿页、该补的引用。

---

## 4. 产品概念模型

### 4.1 五类一等对象

```
Source（原料层）  不可变。PDF/网页/Markdown
Wiki （理解层）  LLM 拥有并维护。实体页/概念页/综述页
Note （思考层）  人拥有。Agent 只建议，不擅改
Thread（对话层） 查询/讨论；好答案可归档为 Note 或 Wiki
Graph（显化层）  以上四层关系的投影与洞察

Schema（AGENTS.md 等约定）= Agent 的操作规程
全部落盘为 Markdown + frontmatter 的本地文件库（git 友好）
```

### 4.2 四个循环（本产品的"引擎"）

1. **消化循环**（Source → Wiki）：两段式 ingest（先分析后生成）→ 更新实体/概念页 → 标矛盾 → 进 review queue。
2. **思考循环**（Query → Thread → Note/Wiki）：提问 → 带引用的答案 → 一键归档为笔记草稿或 wiki 页。
3. **结晶循环**（Note ↔ Wiki）：笔记成熟后提升为 wiki 页；反向：wiki 页可"拉取"为笔记草稿做再加工。
4. **健康循环**（Lint → Review）：定期扫描矛盾/孤儿/陈旧/缺口 → 生成 review 队列与阅读建议。

### 4.3 信任设计

- 一切 LLM 生成内容必须带 `sources[]` 溯源（frontmatter + 行内引用）。
- Review Queue：覆盖、合并、矛盾判定必须人审，LLM 只有建议权。
- Note 层神圣不可侵犯：Agent 对笔记只有"评论权"（除非显式授权单次操作）。
- Lint 报告可视化：矛盾、孤儿、陈旧、缺口四类，可一键定位。
- 全部文件 git 可 diff：LLM 的每次修改都是一次可回滚的提交。

---

## 5. 功能需求

### P0（MVP 必须）

| # | 功能 | 验收标准 |
|---|---|---|
| F1 | 本地文件库：打开一个文件夹作为知识库，sources/notes/wiki 三区 | 新建库 30 秒内可用；全部内容为 Markdown 文件 |
| F2 | Source 摄入：Markdown / 网页 URL / PDF（云模型直读或 MinerU 类管道） | 单篇摄入 ≤ 2 分钟；生成带来源的摘要页 |
| F3 | 两段式 Ingest：分析→生成，更新实体/概念页 + index.md + log.md | 一篇来源触达的页面更新可追溯、可回滚（git） |
| F4 | Note 编辑器：流畅的 Markdown 写作（基于 Milkdown，**不自研编辑器内核**） | 支持 `[[wikilink]]` 自动补全 wiki 页与笔记 |
| F5 | Query：index.md-first → 全文检索 → 图扩展的检索管道，答案带引用 | 答案每条断言可跳转到 wiki 页/source 页 |
| F6 | 归档：答案一键存为 Note 或 Wiki 页 | 归档内容自动带引用 frontmatter |
| F7 | Graph：wikilink+sources 共现构建的关系图，可按类型/社区着色 | 200 页规模下流畅缩放、悬停高亮邻居 |
| F8 | Schema 文件：AGENTS.md 驱动的 ingest/query/lint 规程，用户可改 | 修改 schema 后下一次 ingest 行为可见变化 |

### P1（差异化关键）

| # | 功能 | 备注 |
|---|---|---|
| F9 | Note → Wiki 提升流：选一段笔记 → Agent 起草 wiki 页/更新 → 人审入队 | 双向一等公民的半边 |
| F10 | Wiki → Note 拉取：把 wiki 页转为笔记草稿（带引用），供人再加工 | 另外半边 |
| F11 | Review Queue 面板：矛盾/合并/覆盖建议的异步审批 | 信任设计核心 |
| F12 | Lint 面板 + 一键修复建议 | 参考 obsidian-llm-wiki 的 Smart Fix |
| F13 | 图谱洞察：孤岛页、稀疏社区、桥节点、意外连接 → 一键生成阅读建议 | 参考 llm_wiki Graph Insights |
| F14 | Web Clipper 浏览器扩展 | 投喂摩擦的最大来源；仅做"剪藏进库"的极简版 |

### P2（明确不做）

- 播客生成、多人协作、移动端、发布静态站、音视频转录、自建向量数据库、Tauri/Electron 桌面壳（需要时再加，前端 100% 复用）

---

## 6. 非功能需求

- **本地优先**：断网可用（除 LLM 调用）；文件离开本软件仍是可读 Markdown；兼容 Obsidian vault 惯例（`[[wikilink]]` + frontmatter），用户随时可用 Obsidian 打开自己的库。
- **模型无关**：多 provider（OpenAI/Anthropic/Google/DeepSeek/Ollama），chat 与 ingest 分别路由（pi-ai 现成能力）。
- **成本透明**：每次 ingest/query 显示 token 消耗；内容 hash 增量缓存跳过未变来源。
- **规模目标**：单库 500 来源 / 2000 wiki 页内流畅（检索 < 2s 首 token）。
- **可回滚**：所有 Agent 写操作自动 git 提交。
- **单命令启动**：`npm install && npm start` 后浏览器打开即用——面试官友好。

---

## 7. 技术方案

### 7.1 形态：本地 Web 应用

```
用户运行 npm start
  └─ Node 后端（Fastify/Hono，嵌入 pi-agent-core + pi-ai）
       ├─ 读写本地知识库文件夹（sources/ notes/ wiki/ index.md log.md AGENTS.md）
       ├─ Agent 工具集：ingest / query / lint / promote / pull / search / graph
       └─ 提供 REST + SSE（流式）API
  └─ 浏览器前端（Vite + React）
       ├─ Milkdown 编辑器（Note/Wiki 写作）
       ├─ sigma.js + graphology（Graph 面板）
       └─ 面板：库树 / 编辑器 / Chat / Graph / Review / Lint
```

选型理由（对齐"快速 + 作品集"）：

- **全 TypeScript 单语言**：前后端 + pi 同栈，上下文切换成本最低；面试官读起来也顺。
- **pi 以库形式嵌入**（`pi-agent-core` / `pi-ai` / `pi-durable`），不是包一层 CLI——这本身就是有深度的工程叙事点。
- **检索**：index.md-first → BM25/分词 → wikilink 图扩展（可参考 PPR）。**默认不上向量库**；需要时用 LanceDB 嵌入式，benchmark 证明后再开。
- **图谱**：借鉴 llm_wiki 的 4 信号相关度模型（直链 ×3 / 来源共现 ×4 / Adamic-Adar ×1.5 / 类型亲和 ×1）+ Louvain 社区发现。
- **不碰 Neo4j**：单用户本地场景，wikilink 图 + graphology 足够；Neo4j 是企业级多用户方案，引入即过度工程。
- **编辑器**：Milkdown（WYSIWYG Markdown，插件体系成熟）。绝不自研编辑器内核。

### 7.2 技术风险

- 编辑器体验是吞时巨兽 → 用成熟框架，限制定制范围。
- LLM 输出质量决定生死 → 两段式 ingest + 结构化输出校验 + 写入闸门。
- pi 迭代快 → 锁定版本 + 适配层隔离。

---

## 8. 里程碑（对齐 2027 春招，共约 16 周）

| 里程碑 | 周 | 内容 | 作品集产出 |
|---|---|---|---|
| M0 Spike | W1-2 | pi 嵌入验证（agent 读写本地库 + 一段式 ingest 跑通）；Milkdown/sigma.js 技术验证；精读 llm_wiki 源码 | 技术选型笔记（博客素材） |
| M1 闭环 | W3-6 | F1-F6：库/摄入/ingest/编辑器/query/归档。**W6 起开始 dogfooding：用它管理真实求职知识库** | 第一个可演示版本 |
| M2 显化 | W7-9 | F7-F8 + Graph 面板 + 基础 lint | 演示效果最强的素材（图谱截图/录屏） |
| M3 双向层 | W10-12 | F9-F11：Note↔Wiki 双向 + Review Queue | 差异化叙事核心；竞品调研博客定稿（博客①） |
| M4 叙事包装 | W13-16 | 打磨 README、录 3 分钟 demo 视频、写构建记录博客（博客②）、修 bug、buffer | 面试材料全套 |

**MVP 地狱测试**（M2 结束时自测）：新用户 30 分钟内完成——导入 5 篇来源 → 看 wiki 自动成形 → 写笔记并 `[[链接]]` 到 wiki 页 → 提问得到带引用答案 → 归档 → 图谱里看到知识形状。

### 8.1 成功标准（作品集导向，替代商业指标）

- **dogfooding 证据链**：本人连续使用 ≥ 8 周；真实库积累 ≥ 50 来源 / ≥ 200 wiki 页；log.md 是真实使用记录（面试可直接展示）
- **演示力**：< 3 分钟 demo 视频讲清四个循环；README 让面试官 30 秒看懂"这是什么、和 llm_wiki/open-notebook 有什么不同"
- **深度可讲述**：≥ 2 篇技术博客（① 竞品调研与定位判断——本文档 §1-2 的公开版；② 架构决策记录——为什么 pi、为什么不要向量库、信任设计怎么做）
- **加分项**：GitHub 开源后获得真实用户反馈/star；被相关社区（Obsidian/LLM wiki 圈）提及

---

## 9. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| **范围蔓延**（作品集头号杀手：想做的太多，16 周做不完） | 🔴 最高 | P2 清单就是"不做清单"，每周对照；任何新想法先记进 backlog 不当周做 |
| **LLM 输出质量/信任**（"70% 可靠的 wiki"质疑） | 🔴 高 | 把信任设计做成特色而非软肋：强制溯源 + Review Queue + git 可回滚；这也是博客②的核心章节 |
| **LLM API 成本**（dogfooding 花的是真钱） | 🟡 中 | ingest 路由到便宜模型（DeepSeek 等），演示/关键综合用强模型；增量缓存 |
| **完美主义拖延**（编辑器/图谱细节无限打磨） | 🟡 中 | M1 只要求"能用"，M2 之后不许再改编辑器；打磨时间集中在 M4 |
| **赛道热点消退**（2027 面试时 LLM wiki 不再新鲜） | 🟢 低 | 热点消退反而凸显判断力的稀缺；且"知识消化"是持久问题，叙事不过时 |

---

## 10. 附录：需求判断的证据链

**判断一：底层需求为真。** Karpathy gist（2026-04）5 个月内 15+ 实现、合计 8 万+ star；HN 最高帖 260 分 114 评论；NotebookLM 播客功能 HN 907 分；付费意愿信号：HN 评论 "I would happily pay for anything like this for Logseq."

**判断二：融合需求为真，窗口在收窄。** 逼近者：open-knowledge、claude-obsidian（15.3k★）、obsidian-llm-wiki 插件。尚无赢家的原因：编辑器难、闭环难（插件方案要自己组装）、信任难（无人解决"AI slop"审计）。

**判断三：技术可行，壁垒在工程与品味。** 架构模式公开且被多次复现；中等规模检索不需要重型基础设施；与头部的差距是 6 个月工程细节（llm_wiki 功能清单即差距清单）。

**判断四：不宜做的事。** 不自研编辑器内核、不上 Neo4j、不做多人协作、不做播客、不做移动端、不做插件形态。

---

## 11. 决策记录（ADR 摘要）

> 本节目的是把关键取舍留痕——既是工程习惯，也是面试时"你是怎么做决策的"的直接素材。

**D1 形态：本地 Web 应用，而非 Tauri 桌面应用或 Obsidian 插件**（2026-09-28）
- 背景：候选形态有三——本地 Web、Tauri 桌面壳、Obsidian 插件。
- 决策：本地 Web（Node 后端 + 浏览器 UI，单命令启动）。
- 理由：① 速度——全 TS 单语言，无 Rust 工具链、无安装包签名/跨平台打包成本；② 演示——面试官面前 `npm start` 即跑，也可录屏；③ pi 是 Node 工具包，库形式嵌入最自然；④ 桌面壳日后可补（前端 100% 复用）；插件形态主动放弃（依附他人生态，作品集的独立性叙事弱）。
- 代价：用户要自己跑命令行启动（对目标用户可接受）；没有"开箱即用安装包"的质感。

**D2 不 fork llm_wiki，独立实现**（2026-09-28）
- 理由：作品集的核心是展示"从判断到闭环"的完整能力，fork 会模糊贡献边界；但 M0 阶段精读其源码（两段式 ingest、4 信号图谱、review queue 的实现细节），把别人的坑变成自己的笔记。

**D3 默认不用向量数据库**（2026-09-28）
- 理由：Karpathy 验证 index.md 在 ~100 来源规模内有效；obsidian-llm-wiki 的公开 benchmark 显示图检索（PPR）优于纯向量 kNN；少一个组件少一类 bug。embedding 留为可选开关，用 benchmark 说话再开。

**D4 不做 Neo4j**（2026-09-28）
- 理由：单用户、单机、单写者（Agent）场景下，graphology 内存图 + Markdown 落盘完全够；Neo4j 解决的是多用户并发图查询，那是另一个产品的问题。
