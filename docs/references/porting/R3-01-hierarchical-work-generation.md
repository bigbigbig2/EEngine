# R3-01 · Cluster hierarchy GPU work generation

Status: R3-A reference/ABI 已实现；R3-B～R3-D GPU 移植仍为 planned

Reference ID: `R3-01`

本记录冻结 R3 的上游来源、许可证、采用与拒绝范围。长期结构决策见 [ADR-0009](../../wiki/adr/0009-r3-cluster-hierarchy-work-generation.md)，具体执行、ABI 和 Gate 见 [05-hierarchical-work-generation](../../implementation/05-hierarchical-work-generation.md)。开始复制或翻译任何表达性代码前，提交必须在本文件补充真实函数/行区段和保留的 notice。

## OEngine 输入与输出

输入：

- R2 `InstanceRecord` v2；
- resident Geometry/Cluster/Meshlet records；
- strict renderable Cluster hierarchy、bounds、cone、geometric error；
- current view、previous committed HZB 和 feature/config bits。

输出 ABI：

```text
TraversalWork          8 B  = instanceRecordIndex + clusterRecordIndex
VisibleClusterRecord  16 B  = instance + geometry + cluster + material
RasterWork             8 B  = visibleClusterSlot + meshletRecordIndex
dispatch indirect     12 B  = workgroupCountX/Y/Z
draw indirect         16 B  = vertexCount/instanceCount/firstVertex/firstInstance
```

OEngine 特有不变量：有界 queue；children all-or-nothing reservation；容量不足选择 renderable parent；HW RasterWork 不静默截断；feature-off 不创建无 consumer 资源；GPU 数量不 readback 驱动当前帧。

## Bevy Meshlet Renderer

```text
upstream project: Bevy
repository URL: https://github.com/bevyengine/bevy
commit: 5f8270f2e049f90139a503d1e930070d926f9427
license: MIT OR Apache-2.0
OEngine license path: MIT；移植文件保留必要 copyright/license notice
maturity class: production engine implementation
decision: port（调度与数学）+ reject（数据/平台专用部分）
```

Source paths：

```text
crates/bevy_pbr/src/meshlet/cull_instances.wgsl
crates/bevy_pbr/src/meshlet/cull_bvh.wgsl
crates/bevy_pbr/src/meshlet/cull_clusters.wgsl
crates/bevy_pbr/src/meshlet/meshlet_cull_shared.wgsl
crates/bevy_pbr/src/meshlet/fill_counts.wgsl
crates/bevy_pbr/src/meshlet/visibility_buffer_raster_node.rs
```

采用范围：

- Instance 产生 root work 的阶段拆分；
- `max_bvh_depth` 类似的 ping/pong indirect dispatch scheduling；
- perspective/orthographic SSE、world scale 与 sphere nearest-distance 语义；
- conservative Frustum/HZB fail-open 的控制结构；
- GPU compact work 到 indirect raster consumer 的 producer/consumer 不变量。

拒绝范围：

- Bevy BVH record 和 OEngine 当前 BVH8 语义不同，不复制；
- ECS、resource manager、native render graph、push constants；
- 64 位原子、subgroup 或 native backend capability 假设；
- 双端巨型 queue、Software Raster 和完整 early/late pipeline；
- 预分配足够容量而没有 OEngine fail-visible fallback 的假设。

OEngine/WebGPU adaptation：Cluster hierarchy root 直接作为 traversal 主干；使用 32 位 index ABI；scene 实际 depth 决定 FrameGraph rounds；children 以 `atomicCompareExchangeWeak` 整组预约；输出 OEngine VisibleCluster/RasterWork，而不是 Bevy record。

Precision/semantic differences：矩阵、clip/reverse-Z 和 bounds layout 使用 OEngine 已冻结约定；SSE 数值先移植到 CPU reference，再以明确容差核对 GPU；current BVH8 不参与首版选择。

R3-A 实际采用区段（2026-08-28）：

- `meshlet_cull_shared.wgsl:14-36`：world axis scale、Perspective/Orthographic 分支、sphere nearest distance 和 projection-scale 结构；
- OEngine `GeometryHierarchy.ts` 保留 `worldError = objectError × conservativeScale` 于两个投影分支，并统一使用 vertical viewport height；固定 Bevy commit 的 Perspective 表达式没有乘 `world_scale`，因此未逐字复制；
- Instance transform 使用仓库已锁定的 `gl-matrix@3.4.4` `vec3.transformMat4`；正交 TRS 使用 Bevy 的最大轴长度，检测到 shear 时改用 Frobenius norm 保守上界；
- 本阶段尚未移植 `aabb_in_frustum`、Cone 或 HZB WGSL；CPU oracle 使用 world-space sphere planes，R3-B 再与真实 GPU Shader 对齐。

## Scthe/nanite-webgpu

```text
upstream project: nanite-webgpu
repository URL: https://github.com/Scthe/nanite-webgpu
commit: b9cd33f65bb3cdba0464717e0fa621d330d2116f
license: MIT
maturity class: working WebGPU research/demo implementation
decision: port/reimplement（WebGPU producer/consumer 对照）+ reject（flat 产品结构）
```

Source paths：

```text
src/passes/cullInstances/cullInstancesPass.ts
src/passes/cullInstances/cullInstancesPass.wgsl.ts
src/passes/cullMeshlets/cullMeshletsPass.ts
src/passes/cullMeshlets/cullMeshletsPass.wgsl.ts
src/passes/_shaderSnippets/nanite.wgsl.ts
src/scene/naniteBuffers/drawnMeshletsBuffer.ts
```

采用范围：

- WebGPU Compute producer → GPU indirect consumer 的编码与 usage 对照；
- `vec2u(instance, meshlet)` 类紧凑 work item；
- 完整写入 indirect record；
- parent/current error crossing 的 LOD 语义对照；
- candidate/drawn/triangle 等工作量统计语义。

拒绝范围：

- 单资产 `Instance × all Meshlets` flat dispatch；
- 固定巨型队列和 demo lifecycle/owner；
- 将上游 projected error 结果直接当作 OEngine CPU oracle；
- R3 提前引入 SW/HW 双端 queue。

OEngine/WebGPU adaptation：work item 改成 VisibleCluster seam；容量来自 hierarchy cut 上界；完整间接参数由真实 `written` 生成；资源进入 FrameGraph 和 Work Generator owner。

## Niagara

```text
upstream project: Niagara
repository URL: https://github.com/zeux/niagara
commit: eefec2794681a1f8416e1fcc2771c1cdc11a86cb
license: MIT
maturity class: mature GPU-driven reference implementation
decision: port/reimplement（数学不变量）+ reject（Vulkan command model）
```

Source paths：

```text
src/shaders/drawcull.comp.glsl
src/shaders/clustercull.comp.glsl
src/shaders/math.h
```

采用范围：sphere Frustum、bounds nearest-distance LOD threshold、normal-cone/backface、reverse-Z HZB projection/mip selection，以及 early/late 可见性对照。

拒绝范围：Vulkan push constants、mesh/task shader、MDI/DGC、buffer address、native 8/16-bit storage 假设，以及 overflow 后直接 drop work。

OEngine/WebGPU adaptation：GLSL 数学先进入 CPU reference/property cases，再用 WGSL/OEngine matrix convention 独立实现；Cone 对 mirrored/non-uniform transform 在未通过 reference 前 fail-open；HZB 使用 R1 `rg16float` min/max previous history。

R3-A 实际采用区段（2026-08-28）：`src/shaders/drawcull.comp.glsl:73-82` 的 sphere/Frustum signed-distance 判定作为数学依据。OEngine CPU oracle 按同一不变量独立实现，并允许输入未归一化 world-space plane，因此比较半径时显式乘 plane normal length；Niagara 的 Vulkan buffer、command 和 native 类型结构均未复制。

## AnKi 3D Engine

```text
upstream project: AnKi 3D Engine
repository URL: https://github.com/godlikepanos/anki-3d-engine
commit: 98d4ce3245337dbfd3b0e7ba1ebebbb4dad3e409
license: BSD-3-Clause
maturity class: production native engine implementation
decision: reimplement（ownership/分阶段结构参考）+ reject（native runtime）
```

Source paths：

```text
AnKi/Renderer/Utils/GpuVisibility.*
AnKi/Shaders/GpuVisibilityStage1.ankiprog
AnKi/Shaders/GpuVisibilityStage2And3.ankiprog
```

采用范围：staged GPU visibility ownership、compact queue/counter、shadow-view work generation、GPU Scene 与 Renderer 职责分离。

拒绝范围：Vulkan DGC/MDI、bindless descriptor/runtime allocator 和 native submission model。AnKi 不作为 WGSL 表达性代码的主要复制来源。

## meshoptimizer / R2 Cooker

```text
package: meshoptimizer@1.0.0
upstream commit: 73583c335e541c139821d0de2bf5f12960a04941
license: MIT
decision: adopt，已在 R2 登记和验证
```

R3 只消费 R2 已冻结的 Meshlet、bounds/cone、Cluster hierarchy 和 geometric error，不重新实现 Cooker 算法，也不改变 R2 package provenance。

## 按规格独立实现部分

以下不是从单一上游复制的成熟 module，采用 `decision: reimplement`：

1. OEngine TraversalWork/VisibleCluster/RasterWork 与 Queue header ABI；
2. 基于 WGSL atomic semantics 的 children all-or-nothing bounded reservation；
3. `maxCutMeshlets(node)` hierarchy cut 容量证明；
4. `HierarchicalWorkGenerator` FrameGraph/owner/lifetime；
5. OEngine evidence schema、unsupported/blocker 和 feature-off 行为。

理由：这些行为由 OEngine 现有 GPU records、WebGPU limits、统一主管线和 fail-visible Gate 决定；上游没有相同 ABI 与失败契约。独立实现前必须先有 CPU/property test，不得把“reimplement”解释为无来源自由编写算法。

## 性能假设与 benchmark

假设：对中大型高几何密度、多 Packed Instance 场景，Hierarchy/SSE 减少的 flat candidate/Raster work 大于新增的 round dispatch、queue bandwidth、table lookup 和 atomics 成本。

必须运行同条件 flat/hierarchy paired A/B/C，记录：visited/selected/raster work、encoded/effective/empty rounds、queue bytes/peak/overflow/fallback、submitted/useful triangles、CPU encode、GPU traversal/raster/frame P50/P95/P99。简单低密度场景也必须报告，不能只选择远景胜例。

## Fallback 与失败行为

- children queue 预约失败：选择当前 renderable parent，记录 raw attempted/overflow/fallback；
- root/VisibleCluster/HW RasterWork 保底容量无法满足 adapter limit：prepare 明确失败或 `unsupported + blockerTaskId`，不截断画面；
- Cone/HZB 未通过 reference 或 history 无效：fail-open，保留工作；
- hierarchy 总时间回退：允许同一 output ABI 下研究小几何 implementation，不恢复 CPU readback/draw loop；
- current BVH8 不具备 LOD cut 语义：R3 v1 拒绝接入热路径。

## Local regression/example

```text
R3-A complete: tests/geometry-hierarchy-r3a.test.mjs
R3-A complete: tests/gpu-work-generation-abi.test.mjs
R3-A complete: multi-instance selector、64 fixed random-tree legal-cut enumeration、reservation property tests
R3-A complete: TS/WGSL queue ABI and complete 12 B dispatch / 16 B draw indirect layouts
R3-B planned: GPU ping-pong/empty rounds、selected-set readback
Vertical: examples/r3-hierarchical-work-generation
Performance: fixed A/B/C flat-vs-hierarchy paired artifacts
```

只有标为 complete 的 R3-A 条目已有本地证据；GPU、Vertical 和 Performance 条目仍为 planned，不得写成已通过。
