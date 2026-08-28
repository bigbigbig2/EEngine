# R3-01 · Cluster hierarchy GPU work generation

Status: R3-A/R3-B/R3-C 已完成；R3-D-08/09 代码与 live correctness 已完成，等待 clean/full A/B/C 关闭 G3 performance

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

R3-B 实际采用区段（2026-08-28）：

- `cull_instances.wgsl::cull_instances`：保留 Instance 阶段先产生 hierarchy root work、后续 GPU consumer 不由 CPU readback 决定数量的分段不变量；OEngine 改读 R2 `InstanceRecord`/`GeometryRecord`，输出 8 B TraversalWork。
- `cull_bvh.wgsl::cull_bvh`：只保留按 hierarchy depth 编码 ping/pong indirect dispatch 的 wavefront 调度不变量；没有复制 Bevy BVH record、双端 queue、subgroup 或 native render graph。
- `meshlet_cull_shared.wgsl::lod_error_is_imperceptible`：保留 Perspective/Orthographic、nearest sphere distance 与 conservative world scale 的 SSE 数学结构，并严格对齐 R3-A CPU oracle；OEngine 使用 vertical viewport height、OEngine matrix/clip 约定和 Cluster geometric error。
- `HierarchicalWorkGenerator`、32 B queue header、children all-or-nothing reservation、parent fallback、owner/evidence 与 runtime-array `minBindingSize` 是 OEngine/WebGPU `reimplement`，不是 Bevy 表达性代码移植。

R3-D-08/09 实际采用边界（2026-08-28）：

- 保留 Bevy `cull_instances.wgsl::cull_instances` 与 `cull_bvh.wgsl::cull_bvh` 的“Instance 产生首层 hierarchy work、后续 wavefront 由 GPU 间接调度”阶段语义，但把 OEngine 的 InstanceCull 与 root Cluster 判定融合为 `r3_fused_root_cull`；没有复制 Bevy 的 BVH record、双端 queue、subgroup 或 native RenderGraph 表达性代码。
- root 与 traversal children、SelectedCluster 均采用 OEngine 已在 `SceneDatabase.ts` 验证过的 workgroup compact 结构：workgroup-local atomic 分配连续局部槽位，lane 0 对全局有界 queue 做一次 all-or-nothing reservation，随后各 lane 写入连续区间。该结构按 OEngine Queue header/fail-visible fallback 独立重实现，不声称来自某一上游逐字移植。
- 容量预约失败仍以“整组 children 不写、各 renderable parent 回退”为语义；workgroup 合并只减少全局 reservation/CAS 次数，不改变 attempted/written/overflow/fallback ABI。
- `maxHierarchyDepth === 0` 的小场景使用同一 `VisibleClusterRecord/RasterWork/16 B drawIndirect` ABI 的 `r3_fused_leaf_work`。它是对 Scthe producer→consumer 与 Bevy staged-cull 不变量的 OEngine/WebGPU `reimplement`，不是恢复 flat queue，也不建立第二条产品管线。
- fast path 当前只在 `instanceCount <= 144 && rasterWorkCapacity <= 144` 时启用。这里使用选择前可证明的静态 capacity；C 实际为 `144 instances / 144 capacity / 127 emitted RasterWork`。第一轮把 emitted 数误当 capacity、将阈值写成 128，clean C 因而未命中 fast path；该接线错误已由浏览器 artifact 发现并修正。未完成更多 crossover sweep 前禁止继续扩大。
- queue header evidence 与四个 contention counter 只在 benchmark sampling/显式 diagnostics 时产生；稳定非采样帧不分配 evidence buffer、不复制 header，也不运行 reducer。counter 采样仍由真实 producer 写入，不允许用结构推算或假值补齐 Gate。

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

R3-C 实际采用区段（2026-08-28）：

- `src/passes/cullMeshlets/cullMeshletsPass.ts` 与 `drawnMeshletsBuffer.ts`：保留 Compute compact work buffer 直接成为后续 GPU raster consumer 输入、当前帧不 readback count 的 producer/consumer 不变量；
- `cullMeshletsPass.wgsl.ts`：只采用紧凑 `instance + meshlet` work item 与 GPU counter 驱动 indirect args 的结构依据，没有复制其 flat instance×meshlet 调度或 SW/HW 双端 queue；
- OEngine 将输入改为 `VisibleCluster → RasterWork(visibleClusterSlot, meshletRecordIndex)`，完整写入 `[384, written, 0, 0]` 的 16 B `drawIndirect`，随后由生产 `PackedVisibilityPass` vertex pulling consumer 调用 `drawIndirect()`；
- 因 WebGPU 默认每 stage 8 个 storage buffer binding，OEngine 没有提高 required limit，而是把 traversal、RasterWork dispatch preparation、RasterWork expansion 和 evidence counter reduction 拆成有序最小 Compute Pass；
- 为避免同一 compute usage scope 内把 selected dispatch buffer 同时作为 writable storage 与 `INDIRECT` 使用，dispatch preparation、expansion、evidence 使用三个最小 BindGroup/PipelineLayout；这些是 OEngine/WebGPU `reimplement`，不是上游表达性代码移植。
- A full 的保守 traversal capacity 首次暴露单维 65,535 workgroup 上限；OEngine 保持 12 B dispatch ABI，把 GPU 生成的线性 workgroup count 映射成不超过 adapter limit 的 `x/y` 二维网格，并用 `num_workgroups.x` 在 WGSL 还原线性 invocation index。它不降低 capacity、不截断队列，也不新增 required limit；固定回归覆盖 160,000 workgroup → `65,535 × 3`。
- queue evidence reduction 分开登记 VisibleCluster `selectedClusters` 与 RasterWork/Meshlet `hwClusters`；paired artifact 不允许把后者重复写入两个字段来制造“已有 counter”。
- C 异构场景包含 Cooker 合法保留为 `NoHierarchy` 的 tiny Geometry。OEngine 没有为通过 benchmark 改写 Package，也没有让它回退旧 flat producer；`GpuAssetStore` 以 `reimplement` 方式追加一个 runtime-only virtual leaf Cluster（全 Meshlet、零 geometric error、禁用 cone reject），capacity 与 CPU oracle同步采用一 Cluster 语义。这样所有 Geometry 共用相同 GPU producer/consumer ABI，且该适配有 mixed hierarchy/single-level 与 residency record 回归。

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

R3-A/R3-B 实际采用区段（2026-08-28）：`src/shaders/drawcull.comp.glsl:73-82` 的 sphere/Frustum signed-distance 判定作为数学依据。OEngine CPU oracle 与 WGSL producer 按同一不变量独立实现，并允许输入未归一化 world-space plane，因此比较半径时显式乘 plane normal length；零法线且 `w >= 0` 表示 infinite-far disabled plane。Niagara 的 Vulkan buffer、command 和 native 类型结构均未复制。

R3-D 实际采用区段（2026-08-28）：

- `src/shaders/drawcull.comp.glsl`、`src/shaders/clustercull.comp.glsl` 与 `src/shaders/math.h`：保留 HZB 的投影、mip 与 reverse-Z conservative compare 不变量；OEngine 改为对 Cluster object-space AABB 做 8-corner previous-frame 投影，选择 `ceil(log2(max footprint))` mip，读取最多四个覆盖 texel 的 min/farthest channel。
- committed previous HZB 必须使用与它匹配的上一帧 `worldToClip`；动态 Instance 先以 `previous_from_current × current_object_to_world` 还原上一帧 object-to-world。`MotionInvalid` 时 fail-open，禁止用当前相机/当前物体坐标查询上一帧深度。
- R1 的 `rg16float` HZB 存 `min/max` reverse-Z；R3-D 精确读取 `.x` farthest/min，不采样、不依赖 sampler。首帧、resize、camera cut、history discontinuity、`clip.w <= epsilon` 和非有限投影全部 fail-open。
- OEngine 只在 committed previous view 非空时惰性创建 HZB traversal pipeline/bind group；无 HZB variant 不声明 texture binding，并保持 WebGPU baseline 每 shader stage 最多 8 个 storage buffer。
- Niagara 的 Vulkan descriptor、push constant、early/late MDI 和 native types 均未复制；OEngine 当前没有 second-chance hierarchy wave，`rejectedHzb` 只计真实 traversal reject event。

## meshoptimizer Cone（R3-D）

```text
upstream project: meshoptimizer
repository URL: https://github.com/zeux/meshoptimizer
tag: v1.0
commit: 73583c335e541c139821d0de2bf5f12960a04941
source paths: README.md、src/meshoptimizer.h
license: MIT
decision: adopt Cooker bounds + port mathematical predicate
```

保留的不变量是 `dot(normalize(cone_apex - camera_position), cone_axis) >= cone_cutoff`。Cone apex/axis/cutoff 直接来自 R2 已固定版本的 meshoptimizer bounds，R3-D 不重算 cone。WGSL 与 `HierarchyOcclusionReference.ts` 使用同一列主矩阵约定和容差。

OEngine/WebGPU 差异：只有 positive orientation、uniform scale、orthogonal basis、有效 cone 且非 double-sided Cluster 允许 reject；mirrored、non-uniform、shear、singular、invalid cone 全部 fail-open。该限制减少可剔除工作但优先避免 normal transform 符号/尺度错误；以后放宽必须新增 CPU/GPU reference 和性能对照。

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
6. 8-storage-binding baseline 下的 RasterWork dispatch preparation、queue evidence reduction 与 completion-safe prepared-resource retirement；
7. 每 selected Cluster 一个 64-lane expansion workgroup、lane-0 单次 reservation 和 workgroup base 广播。
8. InstanceCull + root Cluster 判定融合，以及 root/traversal children 与 SelectedCluster 的 workgroup-local compaction；
9. depth-zero、小工作量场景的同 ABI fused-leaf GPU implementation 与保守 crossover；
10. sampled/opt-in queue evidence，以及 `rootStageQueueReservations`、`traversalQueueReservations`、`workGenerationDispatchUpdates`、`workGenerationCasRetries` 四个真实 contention counter。

理由：这些行为由 OEngine 现有 GPU records、WebGPU limits、统一主管线和 fail-visible Gate 决定；上游没有相同 ABI 与失败契约。独立实现前必须先有 CPU/property test，不得把“reimplement”解释为无来源自由编写算法。

## 性能假设与 benchmark

假设：对中大型高几何密度、多 Packed Instance 场景，Hierarchy/SSE 减少的 flat candidate/Raster work 大于新增的 round dispatch、queue bandwidth、table lookup 和 atomics 成本。

必须运行同条件 flat/hierarchy paired A/B/C，记录：visited/selected/raster work、encoded/effective/empty rounds、queue bytes/peak/overflow/fallback、submitted/useful triangles、CPU encode、GPU traversal/raster/frame P50/P95/P99。简单低密度场景也必须报告，不能只选择远景胜例。

R3-C clean/full paired 证据已于 2026-08-28 基于 commit `0b77ce8cf67e110aef5d6cf82ee9e0e2f9c837d0` 采集，环境为 NVIDIA Turing / Chrome 150 / 1280×720 / DPR 1 / 60 warm-up + 180 sample frames。六组 artifact 均 clean、gate eligible、zero counter issue/overflow/WebGPU diagnostics。结果：A 减少 90.1% RasterWork 但 Visibility P50 回退 14.1%；B 减少 80.4% 且 Visibility P50 改善 69.6%；C 两路均为 127 RasterWork，hierarchy 多约 0.262 ms 固定成本。A 的三个阶段是热点，但不是三个 `workgroup_size(1)`；R3-D 只对真实串行的 Cluster Meshlet expansion 改成 one-cluster/64-lane workgroup，并继续保留 queue/atomic 假设待测。

R3-D 没有采用 Prefix Scan：当前 Cluster meshlet count 有界，lane-0 每 Cluster 一次 all-or-nothing atomic reservation 保留已有 ABI/fallback，且不增加 scan/scatter buffer 与 dispatch。clean/full after 已证明该选择把 A/B/C expansion P50 从 38.54/2.49/0.131 ms 降至 6.82/1.31/0.066 ms；但它没有关闭总时间 Gate，A P95 长尾与 C 低密度固定成本仍由 `R3-D-08/09` 处理。完整分位数和采集条件见 [05 实施文档](../../implementation/05-hierarchical-work-generation.md) 与 [PERFORMANCE](../../PERFORMANCE.md)。

R3-D-08/09 的 dirty tuning probe 只用于冻结实现选择，不作为 Gate artifact：B smoke 中 root 全局预约从 76 降为 4、traversal 预约从 244 降至约 51、CAS retry 从约 7392 降为 0，hierarchy phase P50 从约 1.114 ms 降至约 0.918 ms；C full 的 fused-leaf 相对 forced-wavefront 删除两个固定 Compute Pass，总 GPU frame P50/P95 从约 0.524/0.590 ms 降至约 0.459/0.495 ms。最终结论只认提交后的 clean/full A/B/C。

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
R3-B complete: tests/hierarchical-work-generator.test.mjs（owner、真实 depth rounds、feature-off、runtime-array binding size）
R3-B complete: examples/r3-hierarchical-work-generation（live GPU ping/pong、empty rounds、capacity fallback、GPU/CPU selected-set）
R3-B live: Perspective 68、Orthographic 16、empty 0、pressure fallback 3；shader/validation/uncaptured/console errors 均为空
R3-C complete: VisibleCluster → RasterWork → complete 16 B drawIndirect → production Packed Hardware Visibility consumer
R3-C regression: tests/gpu-work-generation-abi.test.mjs、tests/hierarchical-work-generator.test.mjs、Shader source audit、examples/r3-hierarchical-work-generation GPU/CPU RasterWork oracle
R3-C live oracle: Perspective/Orthographic/empty/pressure 的 VisibleCluster、RasterWork 与完整 indirect record 对齐；validation/uncaptured errors 为空
R3-C paired complete: A/B/C 六组 clean/full JSON + `*-visual.png`，commit `0b77ce8`，`gateEligible=true`、zero counter issue/overflow/diagnostics
R3-D structural complete: tests/hierarchy-occlusion-reference.test.mjs、ABI/source/deletion gates、OEngine npm test 161/161、examples build
R3-D live complete: Cone/HZB production counters、GPU/CPU oracle、clean/full A/B/C hierarchy after artifact
R3-D performance blocked: R3-D-08 A InstanceCull/round-0 P95；R3-D-09 C low-density fast path
R3-D-08/09 implementation complete: fused root、workgroup-local compaction、sampled diagnostics、depth-zero fused-leaf；等待 clean/full A/B/C Gate
```

R3-D 的生产代码、来源台账、CPU reference、counter/feature-off、flat 删除与 live 浏览器证据已关闭；`R3-D-08/09` 的实现也已落地，但提交后的 clean/full A/B/C 尚未重采。在该 artifact 证明 A P95 不再回退、C 固定成本被消除且 B 不明显退化前，不宣称 G3 performance complete。
