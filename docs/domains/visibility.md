---
id: visibility
kind: domain
owner: visibility
state: current
verifies:
  files:
    - OEngine/src/render/vsm
    - OEngine/src/shaders/vsm_page_table.ts
    - OEngine/src/shaders/vsm_sampling.ts
    - OEngine/src/gpu/GpuVisibilityKeyAbi.ts
    - OEngine/src/render/passes/PackedVisibilityPass.ts
    - OEngine/src/render/MeshletBucketRaster.ts
    - OEngine/src/render/surface/NativeVisibilityPass.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/assets/geometry-product/GeometryProductWorkload.ts
    - OEngine/src/render/HierarchicalWorkGenerator.ts
    - OEngine/src/render/MeshletWorkCandidate.ts
    - OEngine/src/render/ShadowGeometryWork.ts
    - OEngine/src/render/features/VisibilityFeature.ts
    - OEngine/src/render/vsm/VsmCasterRecordPass.ts
    - OEngine/src/render/vsm/VsmReceiverDemandPass.ts
    - OEngine/src/shaders/virtual_geometry_work.ts
    - OEngine/src/gpu/GpuFrameGeometryArenaAbi.ts
    - OEngine/src/gpu/GpuFrameGeometryAttributesAbi.ts
    - OEngine/src/shaders/frame_geometry_vertices.ts
    - OEngine/src/shaders/native_visibility.ts
    - OEngine/src/shaders/surface_geometry_completion.ts
---
# Visibility

## 当前源码边界

核对日期：2026-10-08，G2.3 工作树。PackedVisibility 保留 GPU hierarchy/work generation、instance/vertex preparation、FrameGeometryArena 与 HZB 产品；MeshletBucketRaster 使用 NativeVisibilityPass 消费完整 native material publication，执行真实 alpha 并写唯一 winner。

VisibilityKey 仍为 r32uint：低 24 位 meshletWorkSlot，高 8 位 localPrimitive；generation/partition 属于外部 queue 生命周期 context。没有为 V4 扩宽或截断 identity，也不再分配旧 ShadingBinId MRT。CPU 不读取 visible/work 以控制本帧 GPU。

FrameProgramLowering 将写入后的 winner/depth/work/frame products 交给 SurfaceV4；Surface 依据实际 winner 恢复 Geometry 并 native shading。Temporal 仍使用 authoritative scene instance identity/motion。VSM 的 native caster alpha 共享 material 语义，但 page table、atlas、invalidation/history 属于 VSM owner。

准备域未完成或 attributes 不足时按真实 resident/Product source 解码恢复，不以旧 Surface heap/cache 为 fallback。current-HZB late recheck 保留 filtered work namespace 和 attachment load/depth 合同；streamed Product 的全域验收仍不由资源绑定测试代替。

FrameGeometryArena 数值 ABI4 的 frame attributes 为 96B/vertex：world normal/tangent/position、UV0/1/2 和 color；不再复制无 reader 的 object normal/tangent/position。resident object attributes 仍为96B，clip仍16B、packed triangle仍4B；UV2 contract保留。默认准备容量来自CPU合法work上界、25%有界headroom和1M顶限，不读取当帧GPU反馈；128MiB是单arena ceiling，256MiB owner计入未过末读fence的replacement。partial/zero preparation正确恢复resident数据，旧ABI不保兼容reader。

Product scene 容量由 descriptor 实际 forest depth、每 asset 最大层宽、全部 group/meshlet 上界按实例数求和；Product root dispatch 仅 seed，随后执行 depth+1 次 traversal，depth 0 也消费终端 root。绑定/dispatch 上限在 Scene 资源分配前检查；Product expansion 复用 prepare 写实际 VisibleCluster count 的 indirect args，每 cluster 一个 workgroup，以二维 grid 展平，空队列零组；不增加 dispatch。Hierarchy 无完整 coarse parent 的 overflow/非法引用传播到 MeshletWork invalid；finalize 同时清空 written count 与 indirect draw count，不把部分 cut 交给 Geometry preparation/Visibility。r32 winner 合同不变。

`VisibilityFeature` 拥有独立 `ShadowGeometryWork`：共享 Scene、ordinary geometry sources 和 VG metadata/banks，以 directional clipmaps 的完整coarse guard cell XY union（含gutter余量）沿 light Z 挤出的保守视图生成 caster work 与独立 frame-instance transforms。当前 SSE=0 选择 finest resident cut，缺页保合法 coarse；只选 CastsShadow、排除 Transparent，不使用主相机 cone/HZB、selected queue 或 prepared clips。FrameGraph 声明 foundation readers 与 shadow products writer，再交 VSM caster/atlas；atlas仅借 Arena header/source metadata，光空间恢复直接读 resident source。未启用阴影时不分配该 per-scene work。

阴影 missing-page demand 带 SHADOW 标记，经已有独立延迟 ring 进入多 Product scheduler；没有本帧反馈控制或 persistent work cache。VSM receiver update 同时发布当前 light/clip/generation 的 sampling constants，Surface 读取其写后版本；复用图通过每帧 binding 更新参数。caster header 的 invalid/overflow/超界使 caster overflow 可观察且 indirect draw count为零，不把 partial caster coverage 当完整成功。Shadow 的 Page allocator、atlas、PCF 和 history 仍属 VSM。

VSM需求已由完整虚拟页bitset生成，receiver与sampler共享first-containing-clip/mip0定义。全部touch后才回收无本帧需求slot，high/bounded分别预留最多150/100粗页；只在唯一dirty页clear/raster及实际caster/native partition成功后发布ready，空页也可完成。查询明确区分fine/coarse/missing/stale/dirty/outside。页表、atlas、frame serial/content epoch与失效由VSM持有，旧append/页锁/dirty bitset已删除。caster仍使用32B全局容量协议，超容量不发布ready；R3压力模式尚未实现。

## 验证与目标

VSM状态、实际GPU范围与未运行项只读[VSM执行计划](../next-execution/eengine-v4-vsm-execution-2026-10.md)；其余Geometry/Surface阶段只读[执行计划](../next-execution/eengine-v4-native-shading-execution-2026-10.md)。本次 ownership 切换不自动证明 traversal/raster 的全部 corner cases、VG streaming、完整画质或性能。

目标见[V4 母稿](../next-design/eengine-v4-native-shading-2026-10.md)；历史 cache/proof 身份不约束 winner contract。来源记录见[porting ledger](../porting/next-renderer.md)，旧结果通过历史与 Git 追溯。
