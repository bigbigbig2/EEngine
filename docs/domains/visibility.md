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
  - OEngine/src/assets/geometry-product/GeometryProductWorkload.ts
  - OEngine/src/render/HierarchicalWorkGenerator.ts
  - OEngine/src/render/MeshletWorkCandidate.ts
  - OEngine/src/shaders/virtual_geometry_work.ts
  - OEngine/src/gpu/GpuFrameGeometryArenaAbi.ts
  - OEngine/src/gpu/GpuFrameGeometryAttributesAbi.ts
  - OEngine/src/shaders/frame_geometry_vertices.ts
  - OEngine/src/shaders/native_visibility.ts
  - OEngine/src/shaders/surface_geometry_completion.ts
---
# Visibility

## 当前源码边界

核对日期：2026-10-08，S2 工作树。PackedVisibility 保留 GPU hierarchy/work generation、instance/vertex preparation、FrameGeometryArena 与 HZB 产品；MeshletBucketRaster 使用 NativeVisibilityPass 消费完整 native material publication，执行真实 alpha 并写唯一 winner。

VisibilityKey 仍为 r32uint：低 24 位 meshletWorkSlot，高 8 位 localPrimitive；generation/partition 属于外部 queue 生命周期 context。没有为 V4 扩宽或截断 identity，也不再分配旧 ShadingBinId MRT。CPU 不读取 visible/work 以控制本帧 GPU。

FrameProgramLowering 将写入后的 winner/depth/work/frame products 交给 SurfaceV4；Surface 依据实际 winner 恢复 Geometry 并 native shading。Temporal 仍使用 authoritative scene instance identity/motion。VSM 的 native caster alpha 共享 material 语义，但 page table、atlas、invalidation/history 属于 VSM owner。

准备域未完成或 attributes 不足时按真实 resident/Product source 解码恢复，不以旧 Surface heap/cache 为 fallback。current-HZB late recheck 保留 filtered work namespace 和 attachment load/depth 合同；streamed Product 的全域验收仍不由资源绑定测试代替。

FrameGeometryArena 数值 ABI4 的 frame attributes 为 96B/vertex：world normal/tangent/position、UV0/1/2 和 color；不再复制无 reader 的 object normal/tangent/position。resident object attributes 仍为96B，clip仍16B、packed triangle仍4B；UV2 contract保留。默认准备容量来自CPU合法work上界、25%有界headroom和1M顶限，不读取当帧GPU反馈；128MiB是单arena ceiling，256MiB owner计入未过末读fence的replacement。partial/zero preparation正确恢复resident数据，旧ABI不保兼容reader。

Product scene 容量由 descriptor 实际 forest depth、每 asset 最大层宽、全部 group/meshlet 上界按实例数求和；Product root dispatch 仅 seed，随后执行 depth+1 次 traversal，depth 0 也消费终端 root。绑定/dispatch 上限在 Scene 资源分配前检查，当前 Product expansion 仍为一维 capacity dispatch。Hierarchy 无完整 coarse parent 的 overflow/非法引用传播到 MeshletWork invalid；finalize 同时清空 written count 与 indirect draw count，不把部分 cut 交给 Geometry preparation/Visibility。r32 winner 合同不变。

## 验证与目标

具体阶段状态、测试范围和未运行项只读[执行计划](../next-execution/eengine-v4-native-shading-execution-2026-10.md)。本次 ownership 切换不自动证明 traversal/raster 的全部 corner cases、VG streaming、完整画质或性能。

目标见[V4 母稿](../next-design/eengine-v4-native-shading-2026-10.md)；历史 cache/proof 身份不约束 winner contract。来源记录见[porting ledger](../porting/next-renderer.md)，旧结果通过历史与 Git 追溯。
