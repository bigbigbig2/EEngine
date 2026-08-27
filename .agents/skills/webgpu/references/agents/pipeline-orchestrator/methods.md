# Methods : Ordered Setup Checklist and Routing Map

Baseline: WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

This file is the operational core of the orchestrator. It gives the render-path
checklist, the compute-path checklist, the buffer-usage-flag table, and the full
task-to-skill routing map.

## The Render Path Checklist

Run these steps in this exact order. Steps 1 to 5 run ONCE per application. Steps 6
to 12 run ONCE at load time. Steps 13 to 15 run every frame.

| # | Action | Validation rule | Route to |
|---|--------|-----------------|----------|
| 1 | Check `navigator.gpu` is defined and the page is on a secure context (HTTPS or `localhost`) | `navigator.gpu` is `undefined` on insecure origins | `webgpu-core-architecture` |
| 2 | `const adapter = await navigator.gpu.requestAdapter(options)`, then null-check | `null` is a valid resolution, NOT a rejection | `webgpu-core-architecture` |
| 3 | Read `adapter.features` and `adapter.limits`, build `requiredFeatures` and `requiredLimits` | Requesting an absent feature makes step 4 fail | `webgpu-core-limits-features` |
| 4 | `const device = await adapter.requestDevice(descriptor)`, then `device.lost.then(...)` | Register `device.lost` BEFORE any resource | `webgpu-core-architecture`, `webgpu-errors-device-loss` |
| 5 | `const queue = device.queue` | `queue` is a property, NEVER a call | `webgpu-core-architecture` |
| 6 | `const ctx = canvas.getContext("webgpu")`, then `ctx.configure({ device, format })` | `format` comes from `navigator.gpu.getPreferredCanvasFormat()` | `webgpu-syntax-canvas-context` |
| 7 | `const module = device.createShaderModule({ code, label })`, then inspect `getCompilationInfo()` | Check for `type === "error"` messages | `webgpu-core-pipeline-architecture`, `webgpu-wgsl-syntax` |
| 8 | `createBindGroupLayout({ entries })` for each `@group` | One layout per group index used in WGSL | `webgpu-syntax-bind-groups` |
| 9 | `createPipelineLayout({ bindGroupLayouts })` | Array order MUST match `@group` indices | `webgpu-core-pipeline-architecture` |
| 10 | `createRenderPipeline({ layout, vertex, fragment, primitive, depthStencil?, multisample? })` | `fragment.targets[].format` MUST equal the attachment format | `webgpu-syntax-render-pipeline` |
| 11 | `createBuffer` / `createTexture` with the correct usage flags | See the buffer-usage-flag table below | `webgpu-syntax-buffers`, `webgpu-syntax-textures` |
| 12 | `createBindGroup({ layout, entries })` binding concrete resources | `binding` numbers MUST match the layout | `webgpu-syntax-bind-groups` |
| 13 | `const encoder = device.createCommandEncoder({ label })` | A fresh encoder every frame | `webgpu-syntax-command-encoder` |
| 14 | `beginRenderPass`, `setPipeline`, `setBindGroup`, `setVertexBuffer`, `draw`, `pass.end()` | `end()` MUST be called before `finish()` | `webgpu-syntax-command-encoder`, `webgpu-impl-render-targets` |
| 15 | `const cmd = encoder.finish()`, `queue.submit([cmd])` | A command buffer is single-use | `webgpu-syntax-command-encoder` |

The render-pass color attachment view is created fresh each frame:
`context.getCurrentTexture().createView()`. NEVER cache it.

## The Compute Path Checklist

| # | Action | Validation rule | Route to |
|---|--------|-----------------|----------|
| 1-5 | Same init as the render path (steps 1 to 5) | Identical | `webgpu-core-architecture`, `webgpu-core-limits-features` |
| 6 | Skip canvas configuration. A compute-only app has no canvas | No `getContext` call | (none) |
| 7 | `createShaderModule` with a `@compute @workgroup_size(...)` entry point | `@workgroup_size` is mandatory in WGSL | `webgpu-core-pipeline-architecture`, `webgpu-wgsl-compute-shaders` |
| 8 | `createBindGroupLayout` with `storage` / `read-only-storage` buffer entries | `visibility: GPUShaderStage.COMPUTE` | `webgpu-syntax-bind-groups` |
| 9 | `createPipelineLayout({ bindGroupLayouts })` | Same rule as render | `webgpu-core-pipeline-architecture` |
| 10 | `createComputePipeline({ layout, compute: { module, entryPoint } })` | `entryPoint` MUST name a `@compute` function | `webgpu-syntax-compute-pipeline` |
| 11 | `createBuffer` for input/output storage buffers and one readback staging buffer | Storage buffer cannot be mapped; readback buffer is separate | `webgpu-syntax-buffers`, `webgpu-impl-buffer-upload` |
| 12 | `createBindGroup` binding the storage buffers | `binding` numbers match the layout | `webgpu-syntax-bind-groups` |
| 13 | `createCommandEncoder` | Fresh encoder | `webgpu-syntax-command-encoder` |
| 14 | `beginComputePass`, `setPipeline`, `setBindGroup`, `dispatchWorkgroups(x,y,z)`, `pass.end()` | Workgroup count = ceil(itemCount / workgroupSize) | `webgpu-syntax-command-encoder`, `webgpu-impl-compute-usecases` |
| 15 | `copyBufferToBuffer` storage to staging, `encoder.finish()`, `queue.submit([cmd])` | Copy is recorded BEFORE `finish()` | `webgpu-syntax-command-encoder` |
| 16 | `await queue.onSubmittedWorkDone()`, then `await staging.mapAsync(GPUMapMode.READ)` | Reading before GPU finishes returns stale data | `webgpu-impl-async-patterns`, `webgpu-impl-buffer-upload` |

## Compute Feeds Render

When a compute pass produces data a render pass consumes, encode BOTH passes into the
SAME `GPUCommandEncoder` and submit once. Pass ordering inside one `queue.submit`
guarantees the compute write completes before the render read. NEVER `mapAsync` the
intermediate buffer; the GPU keeps ownership and no readback is needed.

## Buffer Usage Flag Table

Choose `GPUBufferUsage` flags by the resource role. Combine with `|`.

| Resource role | Usage flags | Notes |
|---------------|-------------|-------|
| Vertex positions / attributes | `VERTEX \| COPY_DST` | Bound via `setVertexBuffer` |
| Index data | `INDEX \| COPY_DST` | Bound via `setIndexBuffer` |
| Per-frame matrices / uniforms | `UNIFORM \| COPY_DST` | Max binding size 65536 bytes |
| Large random-access compute data | `STORAGE \| COPY_DST` | Max binding size 134217728 bytes (128 MiB) |
| Indirect draw / dispatch arguments | `INDIRECT \| COPY_DST` | `indirectOffset` multiple of 4 |
| GPU to CPU readback | `MAP_READ \| COPY_DST` | NEVER add `STORAGE`. `MAP_READ` combines ONLY with `COPY_DST` |
| CPU to GPU staging upload | `MAP_WRITE \| COPY_SRC` | `MAP_WRITE` combines ONLY with `COPY_SRC` |
| Initial data via `mappedAtCreation` | the target usage, e.g. `VERTEX` | No `COPY_DST` needed; `size` MUST be a multiple of 4 |
| `resolveQuerySet` destination | `QUERY_RESOLVE \| COPY_SRC` | Resolve target for timestamp / occlusion queries |

Hard rule: `MAP_READ` is valid ONLY with `COPY_DST`; `MAP_WRITE` is valid ONLY with
`COPY_SRC`. Any other combination with `MAP_*` fails validation. A storage buffer is
NEVER mappable; GPU to CPU readback ALWAYS uses a separate `MAP_READ` staging buffer.

## Bind Group Consistency Checklist

A binding lives in three places that MUST agree exactly. Verify all three before
creating the pipeline.

| Field | WGSL side | Bind group layout entry | Failure if mismatched |
|-------|-----------|-------------------------|-----------------------|
| Group index | `@group(g)` | the layout's position in `bindGroupLayouts[g]` | wrong group bound at draw time |
| Binding number | `@binding(b)` | `{ binding: b }` | pipeline or bind group validation error |
| Stage visibility | the stage that declares the `var` | `visibility: GPUShaderStage.*` | "resource not visible to stage" error |
| Resource kind | `var<uniform>` / `var<storage>` / `texture_2d` / `sampler` | `buffer` / `storageTexture` / `texture` / `sampler` entry | resource-type mismatch error |
| Texture / target format | the WGSL handle type and storage format | `storageTexture.format` and pipeline `targets[].format` | format mismatch error |

## Pipeline Layout Decision

| Situation | Layout choice | Reason |
|-----------|---------------|--------|
| Single pipeline, no resource sharing | `layout: "auto"` | Implicit layouts via `pipeline.getBindGroupLayout(i)` |
| Two or more pipelines share a bind group | explicit `createPipelineLayout` | `"auto"` layouts are NOT interchangeable across pipelines |
| A bind group must outlive one pipeline | explicit `createPipelineLayout` | Same reason |

A bind group made from `pipelineA.getBindGroupLayout(0)` is bound to `pipelineA` only.

## Full Task-to-Skill Routing Map

| Step / question | Skill |
|-----------------|-------|
| Step 1-2, 4-5: `navigator.gpu`, adapter / device / queue chain | `webgpu-core-architecture` |
| Step 3: `requiredLimits` / `requiredFeatures`, negotiation, `featureLevel` | `webgpu-core-limits-features` |
| Step 7, 9: render vs compute pipeline model, shader module, pipeline layout | `webgpu-core-pipeline-architecture` |
| Alignment: size mult-4, dynamic offset 256, `bytesPerRow` 256 | `webgpu-core-memory-model` |
| Browser differences, feature-detection, preferred canvas format | `webgpu-core-cross-browser` |
| WebGPU in Web Workers, `OffscreenCanvas`, render-on-worker | `webgpu-core-workers` |
| Step 11: `createBuffer`, usage flags, `mappedAtCreation`, `mapAsync` | `webgpu-syntax-buffers` |
| Step 11: `createTexture`, formats, views, samplers, external textures | `webgpu-syntax-textures` |
| Step 8, 12: `createBindGroupLayout` / `createBindGroup`, dynamic offsets | `webgpu-syntax-bind-groups` |
| Step 13-15: `createCommandEncoder`, passes, copies, `submit`, query sets | `webgpu-syntax-command-encoder` |
| Step 10: `GPURenderPipelineDescriptor`, vertex / fragment / depth state | `webgpu-syntax-render-pipeline` |
| Step 10: `GPUComputePipelineDescriptor`, `dispatchWorkgroups`, workgroup math | `webgpu-syntax-compute-pipeline` |
| Step 6: `getContext("webgpu")`, `configure`, `getCurrentTexture`, resize | `webgpu-syntax-canvas-context` |
| Step 7: WGSL types, `var` / `let` / `const` / `override`, operators, functions | `webgpu-wgsl-syntax` |
| Step 7: address spaces, vec3 16-byte trap, `@align` / `@size`, std140 layout | `webgpu-wgsl-memory-layout` |
| Step 7: WGSL builtin functions and `@builtin` values per stage | `webgpu-wgsl-builtins` |
| Step 7: WGSL texture handle types, `textureSample` family, per-stage legality | `webgpu-wgsl-textures` |
| Step 7: `@vertex` entry point, `@location` attributes, varyings, `@interpolate` | `webgpu-wgsl-vertex-shaders` |
| Step 7: `@fragment` entry point, MRT outputs, `discard`, depth output | `webgpu-wgsl-fragment-shaders` |
| Step 7: `@compute`, `@workgroup_size`, `var<workgroup>`, atomics, barriers | `webgpu-wgsl-compute-shaders` |
| Step 7: uniform control flow, `derivative_uniformity`, `enable` / `requires` | `webgpu-wgsl-uniformity` |
| Step 14: canvas color attachment, MRT, depth-stencil, MSAA, `loadOp` / `storeOp` | `webgpu-impl-render-targets` |
| Multi-pass, post-processing, deferred / G-buffer, shadow maps, ping-pong | `webgpu-impl-multipass` |
| Instanced draws, `drawIndirect`, `dispatchWorkgroupsIndirect`, GPU-driven | `webgpu-impl-instancing-indirect` |
| Step 11, 16: `writeBuffer` vs `mappedAtCreation` vs staging ring, readback | `webgpu-impl-buffer-upload` |
| Step 16: `mapAsync` lifecycle, `onSubmittedWorkDone`, frame loop, stalls | `webgpu-impl-async-patterns` |
| Workgroup tuning, pipeline / bind-group caching, render bundles, profiling | `webgpu-impl-performance` |
| Image processing, particles, physics, reduction / prefix-sum | `webgpu-impl-compute-usecases` |
| PBR materials, full-screen quad, screen-space effects, post-processing | `webgpu-impl-render-usecases` |
| WebGL to WebGPU concept mapping, clip-space Z, manual mipmaps | `webgpu-impl-webgl-migration` |
| Step 4: `device.lost`, `GPUDeviceLostInfo`, the recovery pattern | `webgpu-errors-device-loss` |
| Setup: `GPUValidationError`, `pushErrorScope` / `popErrorScope`, `uncapturederror` | `webgpu-errors-validation` |
| Setup: object labels, `getCompilationInfo`, debug groups, `chrome://gpu` | `webgpu-errors-debugging` |

## Per-Frame Render Loop Rules

The render loop runs steps 13 to 15 inside `requestAnimationFrame`. Each frame:

1. Update uniforms with `queue.writeBuffer` (NOT a new buffer).
2. Create a fresh `GPUCommandEncoder`.
3. Get a fresh `context.getCurrentTexture().createView()`.
4. Encode the render pass, call `pass.end()`.
5. `queue.submit([encoder.finish()])`.

NEVER `await` `onSubmittedWorkDone` or `mapAsync` inside the render loop; that stalls
the GPU-CPU pipeline. Route to `webgpu-impl-async-patterns`.
