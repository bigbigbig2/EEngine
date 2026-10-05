---
id: readme
state: current
verifies:
  - project/workstreams/active/eengine-next-clean-rebuild.yaml
  - docs
---

# EEngine Next 文档入口

当前方向以第三版原文为架构边界。文档说明目标、执行和源码事实，不是逐批编码许可；准备完成不等于生产代码已重构。

**当前阶段不在本页断言。** 阶段状态只有一个权威来源：[workstream 的 currentSlice](../project/workstreams/active/eengine-next-clean-rebuild.yaml) 与[执行记录](./next-execution/eengine-extreme-performance-rebuild-execution-2026-10.md)。本页曾经把"Phase5 实施中"写死在这里，结果 HEAD 已是 Phase 7 提交而入口仍在说 Phase 5——新读者读到的第一个状态就是错的。任何"当前处于什么阶段"的文字都会漂移，所以这里只提供导航，不复制状态。

## 从这里开始

1. [第三版最终重构设计](./next-design/eengine-extreme-performance-rebuild-2026-10.md)：用户指定原文，后续 Surface/Appearance/Lighting 的唯一目标依据。
2. [最终性能重构设计](./next-design/eengine-extreme-performance-rebuild-2026-10.md)、[当前执行计划](./next-execution/eengine-extreme-performance-rebuild-execution-2026-10.md)与[进度/基线](./next-execution/eengine-extreme-performance-rebuild-execution-2026-10.md)：有界前端、源码切换与最终验收。重构前基线 `14c17078`。
3. [整体架构](./next-design/eengine-extreme-performance-rebuild-2026-10.md)与[架构层计划](next-execution/eengine-next-architecture-layer-plan-2026.md)：保留系统边界与后续 SSSR/GI/VT/Transparency 方向；Surface 部分服从第三版原文。
4. [当前 workstream](../project/workstreams/active/eengine-next-clean-rebuild.yaml)：当前切片和待完成目标。
5. `node tools/vibe.mjs context <path>`：查询 owner/current docs/Next 入口。
6. `node tools/docs-verify.mjs`：校验本文档树是否仍满足自身合同。

## 文档合同

每份文档在 frontmatter 声明 `state`，只有三种取值，由 `tools/docs-verify.mjs` 强制：

| state | 含义 | 强制条件 |
| --- | --- | --- |
| `generated` | 由工具写出 | 必须带生成器标记；手改即失败 |
| `current` | 声称描述当前代码 | 必须声明 `verifies`——否则无法证伪，即为失败 |
| `history` | 日期化记录，不定义当前规则 | 不得被入口点当作当前依据引用 |

设计动机：此前 141 份文档没有任何机读有效期，于是三处入口同时停在过期阶段、设计文档把已变的容量值称作"当前"。文档是给 agent 读的约束，**约束必须可证伪，否则会静默变假**。

## 文档分层

| 位置 | 作用 |
| --- | --- |
| next-design/ | 目标架构与模块设计 |
| next-execution/ | 人读的执行顺序与切断步骤；日期化 phase 记录标注为历史 |
| domains/ | 源码现状与缺口；不能用目标代替实现事实 |
| contracts/、specs/ | 稳定跨 owner 协议和 ABI |
| porting/ | 固定来源、许可、阶段映射和真实 adoption 状态 |
| adr/ | 长期决策和替代关系 |
| reviews/、performance/ | 日期化检查与历史诊断；一律 `state: history`，不是当前设计或性能证明 |
| archive/ | 已归档，只供追溯 |

原文与执行摘要冲突时以原文为架构目标；性能物理策略以当前最终设计细化，执行时点以当前计划和根 `AGENTS.md` 为准。源码描述现状，不因文档采纳自动完成。

## 开发与验收

检查时机与失败修复规则见 [VALIDATION](VALIDATION.md)；测试可信度合同见[执行计划 §1.4](./next-execution/eengine-extreme-performance-rebuild-execution-2026-10.md#14-测试可信度失败修复与阶段完成规则2026-10-05-补齐)。

正式 evidence/claims 留最终验收。历史诊断（如 run06 约 801.7ms，accepted=false）不是性能通过。
