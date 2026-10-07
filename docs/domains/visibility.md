---
id: visibility
kind: domain
owner: visibility
state: current
verifies:
  - OEngine/src/gpu/GpuVisibilityKeyAbi.ts
  - OEngine/src/render/passes/PackedVisibilityPass.ts
  - OEngine/src/render/MeshletBucketRaster.ts
  - OEngine/src/render/surface/NativeVisibilityPass.ts
  - OEngine/src/render/program/FrameProgramLowering.ts
---
# Visibility

## 当前源码边界

核对日期：2026-10-08，S2 工作树。PackedVisibility 保留 GPU hierarchy/work generation、instance/vertex preparation、FrameGeometryArena 与 HZB 产品；MeshletBucketRaster 使用 NativeVisibilityPass 消费完整 native material publication，执行真实 alpha 并写唯一 winner。

VisibilityKey 仍为 r32uint：低 24 位 meshletWorkSlot，高 8 位 localPrimitive；generation/partition 属于外部 queue 生命周期 context。没有为 V4 扩宽或截断 identity，也不再分配旧 ShadingBinId MRT。CPU 不读取 visible/work 以控制本帧 GPU。

FrameProgramLowering 将写入后的 winner/depth/work/frame products 交给 SurfaceV4；Surface 依据实际 winner 恢复 Geometry 并 native shading。Temporal 仍使用 authoritative scene instance identity/motion。VSM 的 native caster alpha 共享 material 语义，但 page table、atlas、invalidation/history 属于 VSM owner。

准备域未完成或 attributes 不足时按真实 resident/Product source 解码恢复，不以旧 Surface heap/cache 为 fallback。current-HZB late recheck 保留 filtered work namespace 和 attachment load/depth 合同；streamed Product 的全域验收仍不由资源绑定测试代替。

## 验证与目标

具体阶段状态、测试范围和未运行项只读[执行计划](../next-execution/eengine-v4-native-shading-execution-2026-10.md)。本次 ownership 切换不自动证明 traversal/raster 的全部 corner cases、VG streaming、完整画质或性能。

目标见[V4 母稿](../next-design/eengine-v4-native-shading-2026-10.md)；历史 cache/proof 身份不约束 winner contract。来源记录见[porting ledger](../porting/next-renderer.md)，旧结果通过历史与 Git 追溯。
