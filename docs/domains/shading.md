---
id: shading
kind: domain
owner: shading
---
# Shading

## 当前源码事实

核对日期：2026-10-02；源码基线 `e7296be9cebbc3bcc1b6b738d682c928548d72d5`。本页描述当前实现，目标见[第三版原文](../next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)，执行见[SurfaceWork V3 计划](../next-execution/surface-work-runtime-v3-rebuild-2026.md)。Phase 1 已切断旧 Surface owner；Phase 2–7 尚未完成，本页不作运行或性能通过声明。

当前 Surface 生产链处于 Phase 1 与 Phase 2 之间的破坏式切换窗口：

```text
VisibilityKey / Depth / MeshletWork / shared frame geometry
  → （旧 Appearance/SparseLighting owner 已删除）
  → SurfaceWorkRuntime / SurfaceGeometryPass（Phase 2 实现中）
  → HDR / Sky / Aerial / FSR3 / Radiometry / Bloom / Present
```

旧 SurfaceMaterialPass、Probe、SurfaceSampleAbi、sample worker/result/Resolve 协调器以及旧 Appearance/SparseLighting owner 已删除；不保留 fallback 或兼容桥。

### Appearance

`AppearanceCachePass.addToGraph` 内调用 Winner owner 与 `GpuAppearancePublication.encodeDemand`，创建六层 internal-full rgba16float fields。Publication 按 extent stripe 供给有效像素 tasks，经分组、真实 geometry inputs、program evaluate/cache stages 和 field resolve 发布。简单源/常量/static product 不分配昂贵动态 cache 页，但仍经过通用 demand 与字段发布；不能把已有 cache 误写为 miss-only 工作链。

AppearanceGraphCompiler 已支持 typed dependencies、等价采样合并、常量/无用通道处理和 product 分类，lowering 输出 WGSL 求值程序。GpuMaterialStore 发布字段版本，AppearanceProgramRegistry 持有程序 leases，AppearanceStaticResidency 管理静态产品与 completion 退役。当前 mutable material 编辑仍需要实际 republication/resync，不能宣称所有动态输入或 nonlocal providers 已完成。

### 共享几何与照明

FrameGeometryArena/Vertices 提供当帧共享 clips/triangles/attributes。WinnerPrimitiveInterpolation 使用 frame-local VisibilityKey、有界 dictionary/work、48-byte coefficients 和 indirect setup，miss 使用同一共享几何直接构造 coefficients。它已被当前 Appearance 消费，不是仅诊断组件；尚未构成原文要求的唯一 SurfaceGeometryRecord producer。

Appearance geometry inputs 与 `surface_sparse_lighting.ts::prepare_surface` 仍分别恢复所需几何/属性。SparseLighting classify 依据当前字段、几何、history、cluster/AO/VSM/environment 等事实建立 signal packets。evaluate 消费真实 direct/IBL/coat，reconstruct 读取当前或历史 signal 并输出 HDR/history/reactive；当前组织不能等同于第三版最终廉价重建。

SparseLighting 持有 guide、dependency signature 和四层 radiance 的双份 history。TemporalFacts 独立发布 motion/identity/validity 基础产品，FSR3 读取其 motion/mask 与 SparseLighting reactive；Surface 不另有 motion attachment。当前基础事实与最终 signal reactive 的完整合同仍待重构收敛。

## 最终目标与现状差距

| 原文目标 | 当前差距 |
| --- | --- |
| implicit/uniform/mixed SurfaceWork，不全员 pixel task | 当前 Appearance demand 仍按有效像素供给 |
| 唯一 SurfaceGeometryRecord | Appearance inputs 和 Lighting prepare 仍有独立恢复 |
| lookup 前置、仅 miss heavy work | 当前 geometry inputs 早于 program cache stages |
| 独立 diffuse/specular/coat/IBL work | 现有 packet 基础需要按新 GeometryRecord/field/history 协议重构 |
| 廉价 reconstruct | 需清除重字段/DFG等重复求值，按结果映射和合成收敛 |
| FrameGraph 看到真实阶段 | Appearance 内部 dispatch 仍藏在单外层回调 |
| 原文完整生命周期和四版本验收 | 未通过；文档切换不提升状态 |

skin/morph/previous deformation、Product 跨 LOD/source/seam 对应、nonlocal/provider、屏外 VSM caster 与透明 composition 均继续列为缺口。当前源码仍在返工，未重新完成整个新目标的编译、浏览器、连续画质和稳定热状态性能验收。

## Owner 与入口

- shading：`render/surface/` 下的新 SurfaceWorkRuntime、GeometryRecord、cache、signal packet 和 reconstruct owner；`WinnerPrimitiveInterpolation.ts` 与 appearance publication 作为保留的数学/资源资产。
- materials-textures：AppearanceGraphCompiler、GpuMaterialStore、TextureResidency、AppearanceStaticResidency、AppearanceProgramRegistry 和 publication 生命周期。
- visibility/geometry：winner/depth 和共享 frame geometry；frame-runtime：FrameProgram/Lowering/FrameGraph/submit。
- temporal：TemporalFacts/TemporalFabric/FSR3 的基础事实与事务；signal owner 管理专用 confidence/history。

未来 SurfaceWorkRuntime、SurfaceGeometryPass、SurfaceMaterialCachePass、SurfaceLightingWorkPass 和 SurfaceReconstructionPass 属于计划，不标作当前存在的实现。

历史来源与数值/组件检查保留在[porting ledger](../porting/next-renderer.md)及固定 revision。R02/R03/R20/R23 等 adoption 和正式 claims 需各自满足来源、数值和真实 GPU 消费证据，不从旧组件结果转授新主链。已退休的 contracts/specs 不规定新 SurfaceWork ABI。
