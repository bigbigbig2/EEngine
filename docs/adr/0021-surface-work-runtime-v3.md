---
id: adr/0021-surface-work-runtime-v3
state: current
verifies:
  - project/workstreams/active
---
# ADR-0021：以用户指定第三版设计统一 SurfaceWork Runtime 方向

Status: accepted

## Context

2026-10-02 用户明确要求严格按照提供的第三版最终重构设计清理工程方向，并在完成后逐项对照。此前 Surface v2、Signal-Rate、缓存 Surface 的目标和执行记录并存，部分入口仍把已删除的 sample-driven owner 写作现状，并沿用没有出现在新原文中的固定百分比性能门槛。

原文日期为 2026-10-01，源码基线为 `e7296be9cebbc3bcc1b6b738d682c928548d72d5`。用户提供的 Downloads 原文 SHA256 为 `6d229211f8aab8e8efcf9e10a253452a57ed98b84557869e7049928502aa5401`。仓库内[权威设计](../next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)保留原文的目标架构与执行要求，并增加单独的当前源码核对段，因此是工程适配副本，不再声称与下载文件逐字节一致。采纳日期与原文日期分别保留。

## Decision

该原文成为后续 Surface/Appearance/Lighting 重构的唯一目标依据，优先于整体架构中旧 Surface 描述、旧模块计划和此前聊天候选方案。继续推进第三版，不回退 9/30 Signal-Rate，不改为另一套普通融合求值优先的目标。

最终链是 SurfaceWork 的 implicit/uniform/mixed 工作组织、唯一 SurfaceGeometryRecord producer、前置 Appearance cache lookup 与 miss-only compaction、独立 diffuse/specular/coat/IBL signal work、TemporalFacts 唯一基础 owner、廉价 reconstruct，以及 FrameGraph 可见的真实阶段和有界溢出。

保留 GPU Scene/VG/Visibility、资源 owner、FrameGraph、Environment/VSM/AO/Temporal/FSR3/显示及唯一 frame submit 边界。删除被替代执行模型，不建旧/新桥梁，不使用本帧 GPU→CPU→GPU work control。完整目标接通后集中验收；开发节奏沿用根 AGENTS 的 Surface 覆盖规则。

## Consequences

[ADR-0020](./0020-clean-cut-renderer.md) 的单路径、GPU-first、真实来源和 owner 原则继续有效；其旧 Surface 阶段顺序由本决定和[新执行计划](../next-execution/surface-work-runtime-v3-rebuild-2026.md)替代。旧 Surface 设计/执行文件从活动树删除，用 Git 查询历史。来源、诊断、retired ABI/claims 保留历史身份，不自动变成新目标或新证据。

不承诺固定 FPS 或百分比；按原文 §8–§11 完成四版本同条件比较、工作量/命中/IBL/例外计数、完整画质与生命周期验收。文档切换不修改运行实现，也不提升实现、claim 或 donor adoption 状态。

## Verification

本次检查原文 SHA256、目标条目映射、活动入口、链接和 YAML 语法，复核删除文件的引用及现状/目标区分。实现验证遵循 [VALIDATION](../VALIDATION.md)，本次不运行 typecheck/build/renderer tests/browser/benchmark。
