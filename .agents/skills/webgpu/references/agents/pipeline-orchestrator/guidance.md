# WebGPU Pipeline Orchestrator

Sequence a correct end-to-end WebGPU setup and route every step to the right detailed skill. Baseline: WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## Quick Reference

The canonical setup sequence. ALWAYS run these steps in this exact order. Each step depends on every step above it.

| # | Step | Output | Detailed skill |
|---|------|--------|----------------|
| 1 | Guard `navigator.gpu`, check secure context | go / no-go | `webgpu-core-architecture` |
| 2 | `requestAdapter()`, null-check the result | `GPUAdapter` | `webgpu-core-architecture` |
| 3 | Read `adapter.features` / `adapter.limits`, build `requiredFeatures` / `requiredLimits` | negotiated request | `webgpu-core-limits-features` |
| 4 | `requestDevice()`, register `device.lost` BEFORE any resource | `GPUDevice` | `webgpu-core-architecture`, `webgpu-errors-device-loss` |
| 5 | Read `device.queue` (property) | `GPUQueue` | `webgpu-core-architecture` |
| 6 | Configure canvas context (render path only) | `GPUCanvasContext` | `webgpu-syntax-canvas-context` |
| 7 | `createShaderModule()`, check `getCompilationInfo()` | `GPUShaderModule` | `webgpu-core-pipeline-architecture`, `webgpu-wgsl-syntax` |
| 8 | `createBindGroupLayout()` per group | `GPUBindGroupLayout[]` | `webgpu-syntax-bind-groups` |
| 9 | `createPipelineLayout({ bindGroupLayouts })` | `GPUPipelineLayout` | `webgpu-core-pipeline-architecture` |
| 10 | `createRenderPipeline()` or `createComputePipeline()` | `GPUPipeline` | `webgpu-syntax-render-pipeline`, `webgpu-syntax-compute-pipeline` |
| 11 | `createBuffer()` / `createTexture()` with correct usage flags | resources | `webgpu-syntax-buffers`, `webgpu-syntax-textures` |
| 12 | `createBindGroup()` binding resources to the layouts | `GPUBindGroup[]` | `webgpu-syntax-bind-groups` |
| 13 | `createCommandEncoder()` | `GPUCommandEncoder` | `webgpu-syntax-command-encoder` |
| 14 | `beginRenderPass()` / `beginComputePass()`, set pipeline + bind groups, draw / dispatch, `end()` | recorded pass | `webgpu-syntax-command-encoder` |
| 15 | `encoder.finish()`, `queue.submit([buffer])` | submitted work | `webgpu-syntax-command-encoder` |

Steps 1 to 5 run ONCE per application. Steps 7 to 12 run ONCE at load time. Steps 13 to 15 run every frame with a fresh encoder.

## Decision Tree

```
What is the workload?
├─ Draw pixels to a canvas → RENDER PATH
│    1-5 init  →  6 configure canvas  →  7 shader module (vertex + fragment)
│    →  8 bind group layouts  →  9 pipeline layout  →  10 createRenderPipeline
│    →  11 vertex/index/uniform buffers + textures  →  12 bind groups
│    →  per frame: 13 encoder → 14 beginRenderPass → 15 finish + submit
│
├─ Run a GPGPU kernel, no canvas → COMPUTE PATH
│    1-5 init  →  (skip 6, no canvas)  →  7 shader module (compute)
│    →  8 bind group layouts  →  9 pipeline layout  →  10 createComputePipeline
│    →  11 storage buffers + readback staging buffer  →  12 bind groups
│    →  13 encoder → 14 beginComputePass + dispatchWorkgroups → 15 finish + submit
│    →  await onSubmittedWorkDone, then mapAsync the staging buffer
│
└─ Both (compute feeds render) → run COMPUTE PATH then RENDER PATH
     in the SAME encoder; pass ordering inside one submit guarantees the
     compute write completes before the render read.

Use "auto" layout or an explicit GPUPipelineLayout?
├─ One pipeline, resources not shared → layout: "auto"
│    bind groups come from pipeline.getBindGroupLayout(i), bound to THAT pipeline only
└─ Resources shared across pipelines → explicit createPipelineLayout
     ALWAYS explicit when two pipelines must share a bind group.

Which buffer usage flags? (see Skill Routing Map and methods.md)
├─ Mesh positions → VERTEX | COPY_DST
├─ Index data → INDEX | COPY_DST
├─ Per-frame matrices → UNIFORM | COPY_DST
├─ Large random-access compute data → STORAGE | COPY_DST
├─ Indirect draw/dispatch args → INDIRECT | COPY_DST
└─ GPU to CPU readback → MAP_READ | COPY_DST   (NEVER add STORAGE here)
```

## Core Patterns

### Pattern 1: ALWAYS negotiate limits and features before creating any resource

Steps 1 to 3 run before step 11. `requestDevice()` validates API calls against the negotiated limits, not the adapter's full limits. Creating a buffer or texture before the device exists is impossible; planning sizes before reading `adapter.limits` produces resources that fail validation on lower-tier hardware. ALWAYS feature-detect: `requiredFeatures: adapter.features.has("shader-f16") ? ["shader-f16"] : []`. Route to `webgpu-core-limits-features`.

### Pattern 2: ALWAYS build bind group layouts before the pipeline

The pipeline layout (step 9) consumes the bind group layouts (step 8), and the pipeline (step 10) consumes the pipeline layout. NEVER call `createRenderPipeline` or `createComputePipeline` before its `GPUBindGroupLayout` objects exist. With `layout: "auto"` the pipeline generates implicit layouts, but those layouts are NOT reusable across pipelines. Route to `webgpu-syntax-bind-groups` and `webgpu-core-pipeline-architecture`.

### Pattern 3: ALWAYS keep @group/@binding, visibility, and formats consistent across three places

A binding is defined in THREE places that MUST agree exactly:

```
WGSL                          Bind group layout entry        Pipeline / bind group
@group(0) @binding(0)    ==   { binding: 0, ... }       (group index, binding number)
var<uniform> u: Uniforms      { visibility: VERTEX }     (stage that reads it)
                              { buffer: { type:"uniform" } }   resource kind
```

A mismatch in the binding number, the group index, the visibility stage, or the resource type fails pipeline or draw validation. The fragment target `format` MUST equal the render-pass attachment format. ALWAYS cross-check WGSL against the layout. Route to `webgpu-syntax-bind-groups`, `webgpu-wgsl-memory-layout`.

### Pattern 4: ALWAYS choose buffer usage flags by resource role

`MAP_READ` combines ONLY with `COPY_DST`; `MAP_WRITE` combines ONLY with `COPY_SRC`. NEVER add `STORAGE`, `UNIFORM`, or `VERTEX` to a `MAP_READ` buffer; that fails validation. A storage buffer cannot be mapped, so GPU to CPU readback ALWAYS uses a separate `MAP_READ | COPY_DST` staging buffer fed by `copyBufferToBuffer`. Route to `webgpu-syntax-buffers`, `webgpu-impl-buffer-upload`.

### Pattern 5: ALWAYS register device.lost and use error scopes as part of setup

Device-loss handling is part of a correct setup, not an afterthought. Register `device.lost.then(...)` in step 4, BEFORE any resource is created. During setup, wrap suspect resource creation in `pushErrorScope("validation")` / `popErrorScope()` to localize failures. Recovery means re-running steps 1 to 15 against a NEW device; resources are bound to the device that created them. NEVER write a silent retry loop. Route to `webgpu-errors-device-loss`, `webgpu-errors-validation`.

### Pattern 6: ALWAYS label every object and run per-frame steps with a fresh encoder

Every descriptor accepts a `label`; `GPUError` messages quote it. Set a meaningful `label` on every buffer, texture, pipeline, bind group, shader module, and encoder. Command buffers are single-use: each frame creates a fresh `GPUCommandEncoder` (step 13). `context.getCurrentTexture()` is called once per frame and NEVER cached. Route to `webgpu-errors-debugging`, `webgpu-syntax-canvas-context`.

## Skill Routing Map

For any step or question, route to the matching sibling skill. All 33 detailed skills:

| Task or question | Skill |
|------------------|-------|
| `navigator.gpu`, adapter / device / queue chain, runtime model | `webgpu-core-architecture` |
| `requiredLimits` / `requiredFeatures`, negotiation, `featureLevel` | `webgpu-core-limits-features` |
| render vs compute pipeline model, shader module, pipeline layout | `webgpu-core-pipeline-architecture` |
| host-side alignment: size mult-4, dynamic offset 256, `bytesPerRow` 256 | `webgpu-core-memory-model` |
| Chrome / Safari / Firefox differences, feature-detection, canvas format | `webgpu-core-cross-browser` |
| WebGPU in Web Workers, `OffscreenCanvas`, render-on-worker | `webgpu-core-workers` |
| `createBuffer`, usage flags, `mappedAtCreation`, `mapAsync` | `webgpu-syntax-buffers` |
| `createTexture`, formats, views, samplers, external textures | `webgpu-syntax-textures` |
| `createBindGroupLayout` / `createBindGroup`, dynamic offsets | `webgpu-syntax-bind-groups` |
| `createCommandEncoder`, passes, copies, `submit`, query sets | `webgpu-syntax-command-encoder` |
| `GPURenderPipelineDescriptor`, vertex / fragment / depth state | `webgpu-syntax-render-pipeline` |
| `GPUComputePipelineDescriptor`, `dispatchWorkgroups`, workgroup math | `webgpu-syntax-compute-pipeline` |
| `getContext("webgpu")`, `configure`, `getCurrentTexture`, resize | `webgpu-syntax-canvas-context` |
| WGSL types, `var` / `let` / `const` / `override`, operators, functions | `webgpu-wgsl-syntax` |
| address spaces, vec3 16-byte trap, `@align` / `@size`, std140 layout | `webgpu-wgsl-memory-layout` |
| WGSL builtin functions and `@builtin` values per stage | `webgpu-wgsl-builtins` |
| WGSL texture handle types, `textureSample` family, per-stage legality | `webgpu-wgsl-textures` |
| `@vertex` entry point, `@location` attributes, varyings, `@interpolate` | `webgpu-wgsl-vertex-shaders` |
| `@fragment` entry point, MRT outputs, `discard`, depth output | `webgpu-wgsl-fragment-shaders` |
| `@compute`, `@workgroup_size`, `var<workgroup>`, atomics, barriers | `webgpu-wgsl-compute-shaders` |
| uniform control flow, `derivative_uniformity`, `enable` / `requires` | `webgpu-wgsl-uniformity` |
| canvas color attachment, MRT, depth-stencil, MSAA, `loadOp` / `storeOp` | `webgpu-impl-render-targets` |
| multi-pass, post-processing, deferred / G-buffer, shadow maps, ping-pong | `webgpu-impl-multipass` |
| instanced draws, `drawIndirect`, `dispatchWorkgroupsIndirect`, GPU-driven | `webgpu-impl-instancing-indirect` |
| `writeBuffer` vs `mappedAtCreation` vs staging ring, GPU to CPU readback | `webgpu-impl-buffer-upload` |
| `mapAsync` lifecycle, `onSubmittedWorkDone`, frame loop, avoiding stalls | `webgpu-impl-async-patterns` |
| workgroup tuning, pipeline / bind-group caching, render bundles, profiling | `webgpu-impl-performance` |
| image processing, particles, physics, reduction / prefix-sum | `webgpu-impl-compute-usecases` |
| PBR materials, full-screen quad, screen-space effects, post-processing | `webgpu-impl-render-usecases` |
| WebGL to WebGPU concept mapping, clip-space Z, manual mipmaps | `webgpu-impl-webgl-migration` |
| `device.lost`, `GPUDeviceLostInfo`, the recovery pattern | `webgpu-errors-device-loss` |
| `GPUValidationError`, `pushErrorScope` / `popErrorScope`, `uncapturederror` | `webgpu-errors-validation` |
| object labels, `getCompilationInfo`, debug groups, `chrome://gpu` | `webgpu-errors-debugging` |

## Common Anti-Patterns

1. **Creating buffers or textures before negotiating limits and features.** Sizes planned without reading `adapter.limits` exceed device limits on lower-tier hardware and fail validation. Steps 1 to 3 ALWAYS precede step 11.

2. **Building a pipeline before its bind group layouts exist.** The pipeline consumes the pipeline layout, which consumes the bind group layouts. Step 8 ALWAYS precedes steps 9 and 10.

3. **Mismatched `@binding` numbers across WGSL and the bind group layout.** A WGSL `@binding(2)` with no `{ binding: 2 }` layout entry, or a visibility stage that excludes the reading stage, fails pipeline or draw validation.

See `anti-patterns.md` for the full list with WHY-it-fails explanations.

## Critical Warnings

- NEVER create a resource before steps 1 to 4 complete. The device must exist and limits must be negotiated first.
- NEVER call `createRenderPipeline` or `createComputePipeline` before its `GPUBindGroupLayout` objects exist.
- NEVER let WGSL `@group` / `@binding` numbers, the bind group layout `binding` numbers, the `visibility` stages, or the formats disagree. All must align exactly.
- NEVER add `STORAGE`, `UNIFORM`, or `VERTEX` usage to a `MAP_READ` buffer. `MAP_READ` combines ONLY with `COPY_DST`.
- NEVER skip `device.lost` registration. Register it in step 4, before any resource. See `webgpu-errors-device-loss`.
- NEVER ship descriptors without a `label`. Validation messages reference objects by label. See `webgpu-errors-debugging`.
- NEVER cache `context.getCurrentTexture()` or reuse a `GPUCommandBuffer`. Each frame needs a fresh texture and a fresh encoder.

## Reference Files

- `methods.md` : the ordered setup checklist for the render and compute paths, the buffer-usage-flag table per resource role, and the full task-to-skill routing map.
- `examples.md` : a complete verified minimal render setup and a complete minimal compute setup, end to end.
- `anti-patterns.md` : orchestration-level mistakes (wrong setup order, missing steps) with WHY-it-fails explanations.

Related skills: this orchestrator routes to all 33 detailed WebGPU skills listed in the Skill Routing Map above. For deep API detail on any single step, open the routed skill.
