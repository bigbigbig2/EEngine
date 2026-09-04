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
