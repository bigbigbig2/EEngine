# Visibility

## VIS-WORK · Hierarchical GPU work generation

- Local owner/source: `OEngine/src/gpu/GpuWorkGenerationAbi.ts`、hierarchical work generator 与 Packed scene owners。
- Upstream: Bevy <https://github.com/bevyengine/bevy>；nanite-webgpu <https://github.com/Scthe/nanite-webgpu>。
- Revision: Bevy `5f8270f2e049f90139a503d1e930070d926f9427`；nanite-webgpu `b9cd33f65bb3cdba0464717e0fa621d330d2116f`。
- Upstream source: Bevy `cull_instances.wgsl`、`cull_bvh.wgsl`；nanite-webgpu `src/passes/cullInstances/*`、`cullMeshlets/*`。
- License: Bevy MIT OR Apache-2.0（采用 MIT）；nanite-webgpu MIT。
- Adoption: traceable local port/reimplementation of GPU producer-to-consumer staging。
- Retained invariants: root work、wavefront indirect dispatch、compact visible/raster work、conservative Frustum/HZB、GPU count 不回读控制本帧。
- OEngine/WebGPU differences: ABI v5 使用 32-bit records、有界 header/queue、完整 12 B dispatch 和 16 B draw indirect；不采用双端巨型队列、subgroup、MDI、mesh shader 或 64-bit atomic。
- Fallback/lifecycle: children reservation all-or-nothing；失败渲染 parent；overflow/capacity 进入稳定 counter。
- Local validation: `gpu-work-generation.test.mjs`、ABI/reference vector、queue boundary 和 shader audit。

## VIS-KEY · Hardware VisibilityKey

- Local owner/source: Packed hardware visibility Pass、`GpuVisibilityKeyAbi.ts`、material classification/resolve。
- Upstream: WebGPU/WGSL specifications；Burns & Hunt Visibility Buffer；Timberdoodle <https://github.com/Sunset-Flock/Timberdoodle>。
- Revision: WebGPU/WGSL living specs reviewed 2026-08-28；Timberdoodle `aa7f35483a9e312acb458d5a32ae9e0eea13c220`。
- Upstream source: WebGPU/WGSL specs；Timberdoodle `draw_visbuffer.hlsl`、`analyze_visbuffer.hlsl`、`visbuffer.hlsl`、`shade_opaque.hlsl`。
- License: specifications/paper are semantic references；Timberdoodle Apache-2.0。
- Adoption: specification/reference reimplementation plus selected lookup invariants。
- Retained invariants: compact pixel identity、frame-local MeshletWork lookup、reverse-Z depth、invalid sentinel、single visible-pixel shading。
- OEngine/WebGPU differences: VisibilityKey V2 冻结 `24-bit meshlet_work_slot + 8-bit local_primitive`，有效 local primitive 为 0..127，`0xffffffff/0xfffffffe` 保留；partition 0 与 generation 作为 queue context 校验。Material Resolve、MaterialClassDepth 与 debug consumer 经 MeshletWork 恢复 material/geometry，不采用 native descriptors、DGC、bindless 或 native command model。
- Fallback/lifecycle: invalid/stale key rejects conservatively and increments diagnostics；resources exist only for enabled Packed visibility。
- Local validation: visibility-key ABI tests、direct-key validation、debug views 和 invalid-key counter。

## VIS-MESHLET-WORK-V2 · Meshlet work queue normal path

- Local owner/source: `OEngine/src/gpu/GpuMeshletRasterWorkAbi.ts`、`OEngine/src/render/MeshletWorkCandidate.ts`、`OEngine/src/render/MeshletBucketRaster.ts`、`OEngine/src/shaders/meshlet_work_compaction.ts`、`OEngine/src/shaders/meshlet_bucket_visibility.ts`。
- Upstream: WebGPU/WGSL living specifications；meshoptimizer <https://github.com/zeux/meshoptimizer>；Bevy <https://github.com/bevyengine/bevy>。
- Revision: WebGPU/WGSL editor draft `e0aff163a37eb3633ffd612e2a943ceb6196d6af`（2026-09-01）；meshoptimizer `73583c335e541c139821d0de2bf5f12960a04941`；Bevy `5f8270f2e049f90139a503d1e930070d926f9427`。
- Upstream source: WebGPU `dispatchWorkgroupsIndirect`/storage-buffer validation rules；meshoptimizer `meshopt_clusterizer.*` 的 bounded meshlet identity；Bevy `cull_clusters.wgsl` 的 GPU work scheduling 仅作语义参考。
- License: WebGPU/WGSL 规范作为语义依据；meshoptimizer MIT；Bevy MIT OR Apache-2.0（采用 MIT 路径）。
- Adoption: 按规范独立实现；subgroup ballot/prefix 与 portable workgroup shared-memory prefix 均为本地规格实现，没有复制上游表达性 Shader。
- Retained invariants: 24 B meshlet identity、32 B attempted/written/consumed/capacity/overflow/generation header、workgroup tile 粒度 all-or-nothing reservation、frame-local generation、GPU producer 到 GPU validation 与标准 indirect raster consumer 闭合、reverse-Z、mirrored winding、OPAQUE/MASK coverage identity。
- OEngine/WebGPU differences: 从现有 VisibleCluster queue 紧凑生成，GPU histogram/prefix/scatter 为 32 个有界 raster bucket 生成完整标准 `drawIndirect` 记录；不使用 MDI，也不读取 queue 回控 CPU。`indirect-first-instance` specialization 写共享 queue base；fallback 以 bucket state base 加零起始 `instance_index`。Step 4 已让固定 32 次标准 indirect draw 写 production `r32uint` VisibilityKey V2；旧 exact raster 只写独立 parity target，GPU reducer 用两边 work table 恢复 instance/geometry/meshlet/local primitive/material 语义比较。
- Fallback/lifecycle: queue 是 normal path 的 CorrectnessCritical owner；容量不足按 workgroup tile 拒绝整个 range、保持 `overflow = attempted - written`，并把全部 bucket indirect instance count 清零，禁止呈现部分几何；subgroups 未协商时自动选择 portable path；owner release/device destroy 销毁 staging/bucketed queue、bucket state、uniform 与 indirect buffer。
- Local validation: CPU pack/unpack、stride/offset/profile/LOD/bucket/generation/boundary oracle，subgroup/portable Shader contract，真实 Chrome producer/consumer/indirect count closure、容量压力 overflow、两种 compact specialization 的 bucket Hardware Visibility semantic parity、padding/triangle/pixel counters，GPU validation/uncaptured/device-loss 必须为零。

## VIS-MATERIAL-DEPTH · Bounded MaterialClassDepth and adaptive setup

- Local owner/source: `OEngine/src/gpu/GpuSurfaceAbi.ts`、`OEngine/src/render/features/SurfaceFeature.ts`、`OEngine/src/render/MaterialClassDepthProbe.ts`、`OEngine/src/render/passes/PackedMaterialClassDepthPass.ts`、`OEngine/src/render/passes/PackedMaterialResolvePass.ts`。
- Upstream: Bevy <https://github.com/bevyengine/bevy>；Burns & Hunt, *The Visibility Buffer*；DAIS, *Deferred Attribute Interpolation Shading*；*NanoMesh: GPU-Driven Rendering for Particle-Based Discrete LOD Meshes*。
- Revision: Bevy `b70463f072a3380ebb37c8803f1c4941357e64fa`；论文分别采用 JCGT 2013、HPG 2015 与 SIGGRAPH 2024 公开版本。
- Upstream source: Bevy `crates/bevy_pbr/src/render/meshlet/resolve_render_targets.wesl`、`crates/bevy_pbr/src/render/meshlet/material_shade_nodes.rs`、`crates/bevy_pbr/src/render/meshlet/visibility_buffer_resolve.wesl`；论文仅作为算法与语义参考。
- License: Bevy MIT OR Apache-2.0（本迁移按 MIT 条款追踪）；论文仅作为非代码语义参考，未复制表达性源码。
- Adoption: traceable local reimplementation；MaterialClassDepth/class-discard 选择与统一 Surface ABI 已进入生产路径，可选 TriangleSetup 与 Tile backend 仍由证据门禁控制。
- Retained invariants: material-depth 选择、固定且有界的 kernel class、解析式 barycentric derivative、候选 setup cache 的确定性容量与 fail-visible fallback。
- OEngine/WebGPU differences: 采用 3-bit kernel class 与 `r32uint` VisibilityKey、固定 7 个 class、`class-discard` 正确性 fallback；不依赖 bindless、subgroup、64-bit atomic、multi-draw-indirect 或 mesh shader。
- Fallback/lifecycle: 非法 key 与容量 overflow 必须计数并 fail-visible；depth parity 不成立时切到 `class-discard`；资源按需创建并按提交完成点退役；feature-off 不保留 profiler pass、copy 或 readback。
- Local validation: `GpuVisibilityKeyAbi`/`GpuSurfaceAbi` CPU-WGSL oracle、MaterialClassDepth probe、class-discard fallback、invalid/overflow counter、截图/数值 parity、P50/P95、生命周期与预算门禁；当前开放项见 `docs/STATUS.md`，长期决定见 `docs/adr/0004-visibility-to-surface.md`。
