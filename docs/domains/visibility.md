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
    - OEngine/src/shaders/vsm_sampling_publication.ts
    - OEngine/src/shaders/vsm_depth_bounds.ts
    - OEngine/src/shaders/vsm_caster_invalidation.ts
    - OEngine/src/gpu/VirtualGeometryResidency.ts
    - OEngine/src/gpu/GpuVisibilityKeyAbi.ts
    - OEngine/src/render/passes/PackedVisibilityPass.ts
    - OEngine/src/render/MeshletBucketRaster.ts
    - OEngine/src/render/surface/NativeVisibilityPass.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/assets/geometry-product/GeometryProductWorkload.ts
    - OEngine/src/render/HierarchicalWorkGenerator.ts
    - OEngine/src/render/MeshletWorkCandidate.ts
    - OEngine/src/gpu/GpuShadowBoundsAbi.ts
    - OEngine/src/render/ShadowMeshletBounds.ts
    - OEngine/src/shaders/shadow_meshlet_bounds.ts
    - OEngine/src/shaders/vsm_geometry.ts
    - OEngine/src/render/ShadowGeometryWork.ts
    - OEngine/src/render/features/VisibilityFeature.ts
    - OEngine/src/render/vsm/VsmGeometryRaster.ts
    - OEngine/src/render/vsm/VsmReceiverDemandPass.ts
    - OEngine/src/shaders/virtual_geometry_work.ts
    - OEngine/src/gpu/GpuFrameGeometryArenaAbi.ts
    - OEngine/src/gpu/GpuFrameGeometryAttributesAbi.ts
    - OEngine/src/shaders/frame_geometry_vertices.ts
    - OEngine/src/shaders/native_visibility.ts
    - OEngine/src/shaders/surface_geometry_completion.ts
    - OEngine/src/gpu/GpuWinnerInterpolationAbi.ts
    - OEngine/src/assets/geometry-product/GeometryProductResidentAttributes.ts
    - OEngine/src/shaders/geometry_source_decode.ts
    - OEngine/src/shaders/vsm_receiver_demand.ts
    - OEngine/src/render/vsm/VsmSettings.ts
---
# Visibility

## 当前源码边界

VSM内容变化与projection身份分开。`VsmGeneration`观察caster/source、GPU Scene提交与scene shading revisions；变更帧`VsmDepthBoundsPass`比较完整提交快照和asset source stamps，生成old/new affine AABB损伤，全部clip/mip/coarse按原pairing gutter交测试撤销局部ready，保留allocation及完整身份。Geometry upload/retire更新全部相关asset stamp，不依赖主视图可见性；MASK未知coverage保守损伤全部MASK。稳定帧不新增delta dispatch。完整caster depth域只扩不缩，扩大先撤销全部内容ready，不能复用旧reverse-depth编码。Sun/scene/device/extent/reset仍全失效；数量变化重建快照/all-dirty，abort不提交快照，旧buffer成功提交后fenced退休。局部正确性/成本出口见性能执行§6.2，不等于完整VSM R4验收。

核对日期：2026-10-23；主Visibility基础沿用`2caf5fe2`，VSM已按下文新owner切换。PackedVisibility保留GPU hierarchy/work generation、instance/vertex preparation、FrameGeometryArena与HZB产品；MeshletBucketRaster使用NativeVisibilityPass消费完整native material publication，执行真实alpha并写唯一winner。

VisibilityKey 仍为 r32uint：低 24 位 meshletWorkSlot，高 8 位 localPrimitive；generation/partition 属于外部 queue 生命周期 context。没有为 V4 扩宽或截断 identity，也不再分配旧 ShadingBinId MRT。CPU 不读取 visible/work 以控制本帧 GPU。

FrameProgramLowering 将写入后的 winner/depth/work/frame products 交给 SurfaceV4；Surface 依据实际 winner 恢复 Geometry 并 native shading。Temporal 仍使用 authoritative scene instance identity/motion。VSM 的 native caster alpha 共享 material 语义，但 page table、atlas、invalidation/history 属于 VSM owner。

准备域未完成或 attributes 不足时按真实 resident/Product source 解码恢复，不以旧 Surface heap/cache 为 fallback。current-HZB late recheck 保留 filtered work namespace 和 attachment load/depth 合同；streamed Product 的全域验收仍不由资源绑定测试代替。

FrameGeometryArena当前数值ABI7，frame产品为metadata、source/必要filtered目录、16B clip与4B packed triangle，没有96B/vertex frame属性数组。24B meshlet目录保存counts/base及resident source locator；ordinary属性仍有自身96B object-space表示，Product直接读紧凑Page，两者不能混称CPU展开。默认准备容量来自CPU合法work上界、25%有界headroom和1M顶限，不读取当帧GPU反馈；默认ceiling为512MiB/view、1GiB/owner，实际分配按admitted work而非预留ceiling，并计入末读fence前的replacement。partial/zero preparation仍恢复真实resident数据，UV2语义不由删frame数组而撤销。

Product scene 容量由 descriptor 实际 forest depth、每 asset 最大层宽、全部 group/meshlet 上界按实例数求和；Product root dispatch 仅 seed，随后执行 depth+1 次 traversal，depth 0 也消费终端 root。绑定/dispatch 上限在 Scene 资源分配前检查；Product expansion 复用 prepare 写实际 VisibleCluster count 的 indirect args，每 cluster 一个 workgroup，以二维 grid 展平，空队列零组；不增加 dispatch。Hierarchy 无完整 coarse parent 的 overflow/非法引用传播到 MeshletWork invalid；finalize 同时清空 written count 与 indirect draw count，不把部分 cut 交给 Geometry preparation/Visibility。r32 winner 合同不变。

`VisibilityFeature`拥有独立`ShadowGeometryWork`：仍共享Scene/ordinary/Product residency与独立frame-instance transforms，不使用主相机HZB/cone。
现在从本帧selected dirty fine/coarse金字塔拒绝无关refine，ordinary/Product coarse handoff按相交页实际world texel及`shadowLodErrorTexels`共同选级；不再常规SSE0或coarse requested全域驱动。
SHADOW missing-page demand沿已有延迟ring进入scheduler，不新增本帧CPU反馈控制或persistent geometry cache。

`VsmGeometryRaster`独立消费Shadow source/bounds，页外source在decode前拒绝，唯一顶点/活性alpha属性跨页复用；triangle/page SAT→无损CSR位集/前缀→有限native bins→实际命中indirect raster。
feature使用四gutter clip distances；baseline显式polygon clip并保留barycentric lineage，MASK从原triangle plane恢复CXY/梯度；opaque无FS，不页外discard或丢弃巨triangle。
source容量按32/64MiB分chunk同frame清一次/全量累积，完成status合法才commit，空几何可clear发布；旧显式/隐式pair及主Visibility的VSM专属分支已删除。
`GpuShadowBoundsAbi`属于Geometry，`GpuVsmGeometryAbi`属于VSM；页表/atlas/depth/descriptor生命周期仍由VSM持有。

receiver与sampling共享distance selector与fine两端，64texel×64page、最多16clip，仅mip0/5管理；所有有效正reverse-depth需求完整发布。
raw/admitted分开，优先相邻fine后coarse兜底，不混coarse过渡。资源档显式16/64/256MiB，不以设备上限自动开启最高档。
alloc/evict/roll/damage/commit mutation维护persistent sampling descriptor，首次/reset完整初始化，final lighting scratch始终完整copy。
alpha view依赖来自实际lowered coverage；source/influence仅写变化runs，提交baseline不在abort推进。兼容publication/queue重绑复用大scratch，旧绑定按末读fence退休。

## 验证与目标

VSM atlas/page完成后发布fine/coarse采样descriptor，完整world/mip/generation/epoch/namespace与flags由producer校验，Native同次几何恢复执行Sun查询/滤波。
当前仍是disk4/1.5texel、point/gather诊断；本步不改filter。选级、geometry/raster/status、descriptor与生命周期的小型GPU出口及未运行的完整Renderer/VT/HDR/streaming组合，
只读[当前执行记录](../next-execution/eengine-vsm-quality-execution-2026-10.md)。旧性能结果不自动证明新CSR/裁剪路径净收益。

VSM、Geometry/Surface 的日期化实施和原验证范围分别见 [VSM历史执行记录](../next-execution/eengine-v4-vsm-execution-2026-10.md)、[Geometry/Surface历史执行记录](../next-execution/eengine-v4-native-shading-execution-2026-10.md)。当前模块和延期责任由 [workstream](../../project/workstreams/active/eengine-next-clean-rebuild.yaml) 导航；这些旧记录不继续原施工顺序，也不自动证明最新源码所有 corner cases、画质或性能。

目标见[V4 母稿](../next-design/eengine-v4-native-shading-2026-10.md)；历史 cache/proof 身份不约束 winner contract。来源记录见[porting ledger](../porting/next-renderer.md)，旧结果通过历史与 Git 追溯。
