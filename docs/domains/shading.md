---
id: shading
kind: domain
owner: shading
state: current
verifies:
  - OEngine/src/render/surface/SurfaceWorkRuntime.ts
  - OEngine/src/shaders/surface_work_reconstruct.ts
  - OEngine/src/render/program/FrameProgramLowering.ts
---
# Shading

## 当前源码接线

核对日期：2026-10-06；本轮工作树主链注册与直接资源 consumer。阶段和检查结果读取 workstream/执行计划，不在本页复制。

[SurfaceWorkRuntime](../../OEngine/src/render/surface/SurfaceWorkRuntime.ts) 在同一 FrameGraph 注册 coverage→有限家族工作/indirect→Geometry与Appearance→signal rate→Lighting→Reconstruct。publication 通过 encodeWorkPublication 发布常量；Geometry与Appearance消费者共用当前源与域目录；Lighting只读已完成Geometry/fields/guides；Reconstruct只消费必要fields、signal values、AO与Temporal facts，发布radiance/reactiveMask。

Runtime 持有分bank的frame scratch与有限work kernels；FrameProgramLowering提供当前visibility、几何源、材质/纹理publication、lighting providers和版本输入。旧Field/SignalStore不再接此主链；可选精确缓存仍需按C实现，接线存在不证明完整性能或全部生命周期分支正确。

材质发布分离完整结构模板与实例快照；普通家族与完整 General 共用实际产品采样语义。General tape 按语义宽度、C/CXY 点域和最后读者安排 f32 words，publication/material/frame 子图按真实依赖更新并随帧事务提交。coherence 只组织多模板 General 工作，容量不足保留完整 indexed worker。

唯一 FrameGeometryArena 提供 prepared attributes 与 resident fallback；Surface 局部完成 Geometry 后交给 Appearance，跨阶段只保留 closed fields、薄几何与必要 guides。六路 RGB 信号携带显式 state，各信号分别发布率；重构保持原加法分组、output-pixel AO 和颜色/preExposure 语义。普通几何已移除无读者 continuity 载荷，但保留 TemporalFacts 实际消费的 primitive identity 映射。

## 边界与已知问题

本页不再把旧 material/geometry cache bypass、dirty Phase5 或旧 batch 数字描述为当前状态。重复且失效的说明已收回，历史内容由 Git 追溯，不新增一份文档快照。

独立审计已指出前端管理、物理表示、命令规模和计时范围问题。布局、容量和成本直接查当前 producer/ABI 与[审计](../reviews/eengine-independent-source-gpu-performance-audit-2026-10-05.md)，不在本页再复制一套易漂移数字。测试全绿、短 smoke、预算未超均不能证明完整性能或质量。

## 目标与归纳原则

目标见[极致性能设计](../next-design/eengine-v4-native-shading-2026-10.md)，切换见[执行计划](../next-execution/eengine-v4-native-shading-execution-2026-10.md)。V4 目标是 native material、默认 fused opaque、简单 execution bins 和 demanded Aux；本页上述实现仍是退休中的旧 Surface，只有真实 producer/consumer 切换后才更新事实。

Shading 拥有 Surface 字段/信号工作与重建；geometry/visibility 提供选中源，material/texture 提供 publication/版本，frame-runtime 负责图与提交。来源与阶段映射集中在[porting ledger](../porting/next-renderer.md)，组件旧结果不自动转授新主链 adoption。

后续每个切换单元完成后，把已核实的算法理由、不变量与失败行为归纳到本页；稳定 ABI 留独立 specs，不把全部实施日志搬回来。
