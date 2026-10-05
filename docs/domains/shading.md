---
id: shading
kind: domain
owner: shading
state: current
verifies:
  - OEngine/src/render/surface/SurfaceWorkRuntime.ts
  - OEngine/src/render/surface/SurfaceReconstructionPass.ts
  - OEngine/src/render/program/FrameProgramLowering.ts
---
# Shading

## 当前源码接线

核对日期：2026-10-05；源码基准 11a7af962dd4eae54e900e31d28dc856d540d443。本轮核对主链注册与直接资源 consumer，未重新运行 GPU 数值、画质或性能验收。阶段读取 workstream，不在本页复制。

[SurfaceWorkRuntime](../../OEngine/src/render/surface/SurfaceWorkRuntime.ts) 在同一 FrameGraph 注册 classifier→demand→geometry→Appearance→FieldStore publish→lighting→SignalStore publish→reconstruction。Appearance 通过 publication.encodeSurfaceFields 消费 geometry.records/demand；lighting 消费同一 records 与 fields，输出 signal values；reconstruction 消费 Field/Signal refs/values、覆盖与 Temporal facts，发布 radiance/reactiveMask。

Runtime 持有 scratch、FieldStore/SignalStore 引用与上述 pass owners；FrameProgramLowering 提供当前 visibility、几何源、材质/纹理 publication、lighting providers 和版本输入。资源接线存在不等于所有命中/拒绝、唯一 writer、容量与生命周期分支已正确。

## 边界与已知问题

本页不再把旧 material/geometry cache bypass、dirty Phase5 或旧 batch 数字描述为当前状态。重复且失效的说明已收回，历史内容由 Git 追溯，不新增一份文档快照。

独立审计已指出前端管理、物理表示、命令规模和计时范围问题。布局、容量和成本直接查当前 producer/ABI 与[审计](../reviews/eengine-independent-source-gpu-performance-audit-2026-10-05.md)，不在本页再复制一套易漂移数字。测试全绿、短 smoke、预算未超均不能证明完整性能或质量。

## 目标与归纳原则

目标见[极致性能设计](../next-design/eengine-extreme-performance-rebuild-2026-10.md)，切换见[执行计划](../next-execution/eengine-extreme-performance-rebuild-execution-2026-10.md)。薄 GeometryRecord、有限材质 family、需求/率与字段/信号复用属于目标要求；逐项以生产实现和真实 consumer 判定落实程度。

Shading 拥有 Surface 字段/信号工作与重建；geometry/visibility 提供选中源，material/texture 提供 publication/版本，frame-runtime 负责图与提交。来源与阶段映射集中在[porting ledger](../porting/next-renderer.md)，组件旧结果不自动转授新主链 adoption。

后续每个切换单元完成后，把已核实的算法理由、不变量与失败行为归纳到本页；稳定 ABI 留独立 specs，不把全部实施日志搬回来。
