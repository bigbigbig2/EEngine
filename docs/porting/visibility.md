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
- Retained invariants: compact pixel identity、frame-local RasterWork lookup、reverse-Z depth、invalid sentinel、single visible-pixel shading。
- OEngine/WebGPU differences: `r32uint` attachment and OEngine instance/geometry/material tables；不采用 native descriptors、DGC、bindless 或 native command model。
- Fallback/lifecycle: invalid/stale key rejects conservatively and increments diagnostics；resources exist only for enabled Packed visibility。
- Local validation: visibility-key ABI tests、direct-key validation、debug views 和 invalid-key counter。

## VIS-MATERIAL · Visible-pixel material classification

- Local owner/source: Packed classification scan/scatter、`PackedMaterialResolvePass`、Surface counter owners。
- Upstream: The Forge <https://github.com/ConfettiFX/The-Forge> 与 deferred attribute interpolation references。
- Revision: The Forge `cd5046893faba2dc7869243873bf01f02a6f0df9`。
- Upstream source: `Examples_3/Visibility_Buffer/src/Visibility_Buffer.cpp`、Visibility Buffer shaders。
- License: The Forge Apache-2.0；论文/博客仅作数学参考。
- Adoption: port workload organization and reimplement WebGPU scan/class resolve。
- Retained invariants: only visible pixels are classified；bounded fixed class count；barycentric/gradient/material reconstruction stays consistent with VisibilityKey。
- OEngine/WebGPU differences: recursive scan handles arbitrary legal framebuffer workgroup count；不采用 wave intrinsic、bindless、64-bit atomic 或 material-count CPU loop。
- Fallback/lifecycle: overflow is counted and fails visible；feature-off removes classification/resolve resources。
- Local validation: packed material classification、scan CPU oracle、Surface ABI、counter 和 source-audit tests。

## VIS-MATERIAL-DEPTH · Bounded MaterialClassDepth and adaptive setup

- Local owner/source: `docs/OEngine_Visibility_to_Surface_WebGPU_RFC.md`；后续由 `OEngine/src/render/material-depth/`、`OEngine/src/render/surface/` 与 FrameGraph owner 承载。
- Upstream: Bevy <https://github.com/bevyengine/bevy>；Burns & Hunt, *The Visibility Buffer*；DAIS, *Deferred Attribute Interpolation Shading*；*NanoMesh: GPU-Driven Rendering for Particle-Based Discrete LOD Meshes*。
- Revision: Bevy `b70463f072a3380ebb37c8803f1c4941357e64fa`；论文分别采用 JCGT 2013、HPG 2015 与 SIGGRAPH 2024 公开版本。
- Upstream source: Bevy `crates/bevy_pbr/src/render/meshlet/resolve_render_targets.wesl`、`crates/bevy_pbr/src/render/meshlet/material_shade_nodes.rs`、`crates/bevy_pbr/src/render/meshlet/visibility_buffer_resolve.wesl`；论文仅作为算法与语义参考。
- License: Bevy MIT OR Apache-2.0（本迁移按 MIT 条款追踪）；论文仅作为非代码语义参考，未复制表达性源码。
- Adoption: proposed traceable reimplementation；在 RFC 的对应阶段门禁通过前，不声明运行时采用完成。
- Retained invariants: material-depth 选择、固定且有界的 kernel class、解析式 barycentric derivative、候选 setup cache 的确定性容量与 fail-visible fallback。
- OEngine/WebGPU differences: 采用 3-bit kernel class 与 `r32uint` VisibilityKey、固定 7 个 class、`class-discard` 正确性 fallback；不依赖 bindless、subgroup、64-bit atomic、multi-draw-indirect 或 mesh shader。
- Fallback/lifecycle: 非法 key 与容量 overflow 必须计数并 fail-visible；depth parity 不成立时切到 `class-discard`；资源按需创建并按提交完成点退役；feature-off 不保留 profiler pass、copy 或 readback。
- Local validation: RFC M0-M7 的 ABI oracle、截图/数值回归、P50/P95、overflow、生命周期与预算门禁；当前仅完成设计登记，不构成实现完成证据。
