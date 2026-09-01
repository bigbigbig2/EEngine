# OEngine 文档入口

本目录只保存当前仍有效的产品方向、架构、性能契约、长期决策和协作知识。旧的 three.js 兼容路线、Shade-like 产品叙事、00–09 重复分册和母本文档不再是权威。

## 阅读顺序

| 目的 | 文档 |
|---|---|
| 了解项目词汇 | [CONTEXT.md](./CONTEXT.md) |
| 了解引擎要成为什么 | [DIRECTION.md](./DIRECTION.md) |
| 了解当前目标平台和 workload | [TARGETS.md](./TARGETS.md) |
| 理解整体分层和数据所有权 | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| 理解一帧和软硬件混合渲染 | [RENDER-PIPELINE.md](./RENDER-PIPELINE.md) |
| 做性能工作或对比 three.js | [PERFORMANCE.md](./PERFORMANCE.md) |
| 查看已采集基线及其证据等级 | [BASELINE-ARTIFACTS.md](./BASELINE-ARTIFACTS.md) |
| 核对 Shader 事实源和删除候选 | [SHADER-SOURCES.md](./SHADER-SOURCES.md) |
| 区分目标与当前代码 | [CURRENT-STATE.md](./CURRENT-STATE.md) |
| 查看推进顺序 | [ROADMAP.md](./ROADMAP.md) |
| 按任务实施、迁移和验收 | [implementation/README.md](./implementation/README.md) |
| 执行综合渲染管线重构 | [implementation/11-render-pipeline-reconstruction.md](./implementation/11-render-pipeline-reconstruction.md) |
| 查看长期决策 | [wiki/adr/README.md](./wiki/adr/README.md) |

## 参考与移植

- [references/README.md](./references/README.md)：当前参考路由与优先级。
- [GPU-DRIVEN.md](./references/GPU-DRIVEN.md)：核心项目映射和历史移植记录。
- [OPEN-SOURCE-REUSE.md](./references/OPEN-SOURCE-REUSE.md)：许可证、性能和 WebGPU 适配规范。
- [references/deferred](./references/deferred/README.md)：不支配当前路线的超大世界、高级 GI 等研究。

## 文档系统

```text
AGENTS.md                     全仓库稳定约束
CONTEXT-MAP.md                任务 → 领域 → 搜索根
docs/CONTEXT.md               共享术语
docs/contexts/*/CONTEXT.md    领域语言与职责
docs/implementation/          分阶段实施、迁移、删除与验证手册
OEngine/**/AGENTS.md          靠近代码的所有权规则
docs/wiki/adr/                长期架构决策
docs/wiki/agents/             Agent 工作流程
docs/wiki/lessons/            已验证的疑难经验
docs/wiki/tracker/            PRD/Issue 约定
```

## 写作纪律

- 方向、目标和事实分开写；当前代码存在不代表长期接受。
- ADR 只记录已接受决策；尚未决定的内容留在讨论或 tracker。
- 同一规则只保留一个 owner，其他文档使用链接。
- `CURRENT-STATE` 只拥有当前代码事实；`ROADMAP` 只拥有阶段依赖；`implementation/README` 只拥有当前执行入口；任务级状态只在对应 implementation package 维护。
- 文档必须提供下一跳，不创建孤立长文。
- 过期内容直接删除；只有仍有调查价值且不会误导时才保留为 reference。
