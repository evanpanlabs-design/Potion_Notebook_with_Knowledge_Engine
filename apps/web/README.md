# apps/web — 前端（由另一台协作设备负责）

按 ADR-001 分工：本包由 Codex 侧设备实现（Vite + React + Milkdown + sigma.js，SSE 消费）。

接口契约：`docs/ARCHITECTURE.md` §8 的 API 面（已冻结）。

后端最小骨架已就绪：`GET /api/v1/health`、`GET /api/v1/pages/*path`（只读）。
