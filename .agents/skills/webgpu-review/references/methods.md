# Methods: WebGPU Review Checklist, API Surface, and Routing Map

This file holds the full review procedure for the `webgpu-agents-quality-validator`
skill. Version baseline: WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

The review has three parts:

1. The category-by-category review checklist (run in fixed order).
2. The WebGPU 1.0-stable API surface, for cross-checking against hallucinated APIs.
3. The issue-to-skill routing map.

---

## Part 1: Category-by-Category Review Checklist

Run the categories in order 1 to 12. Each check is binary: PASS or FAIL. On any FAIL,
record the defect and the routing target from Part 3. Do not stop at the first FAIL;
collect every defect, then report.

### 1. Initialization

| # | Check | FAIL condition |
|---|-------|----------------|
| 1.1 | Adapter null-check | `adapter.requestDevice()` is reached without an `if (!adapter)` guard. `requestAdapter()` resolves to `null` on no compatible GPU; `null` is a valid resolution, NOT a rejection. |
| 1.2 | Secure context | Code runs on an insecure origin and never checks `navigator.gpu` for `undefined`. WebGPU requires HTTPS or `localhost`. |
| 1.3 | `device.lost` handler | No `device.lost.then(...)` is attached before any GPU resource is created. |
| 1.4 | Queue access | `device.queue` is invoked as a call `device.queue()`. It is a read-only property. |
| 1.5 | Async chain | `requestAdapter`/`requestDevice` results are used without `await`. Both return Promises. |

### 2. Features and limits

| # | Check | FAIL condition |
|---|-------|----------------|
| 2.1 | Feature detection | A `GPUFeatureName` string is placed in `requiredFeatures` without a guarding `adapter.features.has(...)`. `requestDevice` rejects on a browser lacking the feature. |
| 2.2 | Limit negotiation | `requiredLimits` is set to the full `adapter.limits` object instead of the specific limits the app needs. |
| 2.3 | Limit checks | A draw or dispatch parameter (texture size, workgroup count, binding count) is used without checking it against `device.limits`. |

### 3. Buffers

| # | Check | FAIL condition |
|---|-------|----------------|
| 3.1 | Usage combination | `MAP_READ` is combined with anything other than `COPY_DST`, or `MAP_WRITE` with anything other than `COPY_SRC`. |
| 3.2 | Usage completeness | The buffer is used as vertex / index / uniform / storage / indirect but the corresponding `GPUBufferUsage` flag is absent. |
| 3.3 | Mapping state | `mapAsync` is called on a buffer that is already `"mapped"` or `"pending"`. |
| 3.4 | Detached buffer | The `ArrayBuffer` from `getMappedRange()` is read or written after `unmap()`. |
| 3.5 | Storage readback | A `STORAGE` buffer is mapped directly. Storage buffers cannot be mapped; copy into a `COPY_DST | MAP_READ` staging buffer first. |

### 4. Alignment

| # | Check | Required multiple |
|---|-------|-------------------|
| 4.1 | Buffer `size` when `mappedAtCreation: true` | 4 |
| 4.2 | `queue.writeBuffer` `bufferOffset` and `size` | 4 |
| 4.3 | `mapAsync` / `getMappedRange` `offset` | 8 |
| 4.4 | `mapAsync` / `getMappedRange` `size` | 4 |
| 4.5 | Dynamic uniform buffer binding offset | 256 (`minUniformBufferOffsetAlignment`) |
| 4.6 | Dynamic storage buffer binding offset | 256 (`minStorageBufferOffsetAlignment`) |
| 4.7 | `bytesPerRow` in buffer-texture copies | 256 |
| 4.8 | `indirectOffset` for indirect draws/dispatch | 4 |
| 4.9 | Copy `origin.x` / `origin.y` | format texel block size |

FAIL when a value is not the required multiple. The classic FAIL: a readback buffer
sized `width * height * 4` with `bytesPerRow = width * 4` where `width * 4` is not a
multiple of 256.

### 5. Textures and samplers

| # | Check | FAIL condition |
|---|-------|----------------|
| 5.1 | Texture usage | A render target lacks `RENDER_ATTACHMENT`; a sampled texture lacks `TEXTURE_BINDING`; a storage texture lacks `STORAGE_BINDING`. |
| 5.2 | Sampler binding type | A comparison sampler (`compare` set) binds to a non-`"comparison"` layout entry, or a filtering sampler binds to a `"non-filtering"` entry. |
| 5.3 | float32 filtering | A `float32` texture is sampled with a filtering sampler without the `float32-filterable` feature. |
| 5.4 | Canvas format | `"bgra8unorm"` or `"rgba8unorm"` is hard-coded as the canvas format instead of `navigator.gpu.getPreferredCanvasFormat()`. |
| 5.5 | `getCurrentTexture` lifetime | `context.getCurrentTexture()` or its view is cached and reused across frames. |
| 5.6 | External texture lifetime | A `GPUExternalTexture` from `importExternalTexture` is reused beyond the task that created it. |

### 6. Bind groups and layouts

| # | Check | FAIL condition |
|---|-------|----------------|
| 6.1 | Binding match | A WGSL `@group(g) @binding(b)` resource has no matching `GPUBindGroupLayoutEntry` with the same `binding`. |
| 6.2 | Resource type match | The WGSL resource type (uniform, storage, texture, sampler) does not match the layout entry resource object (`buffer`, `texture`, `sampler`, `storageTexture`, `externalTexture`). |
| 6.3 | Visibility | The layout entry `visibility` bitmask omits a shader stage that reads the binding. |
| 6.4 | Auto-layout reuse | A bind group built from `pipelineA.getBindGroupLayout(i)` is bound to `pipelineB`. Auto layouts are not interchangeable. |
| 6.5 | Storage texture view dimension | A `storageTexture` layout entry uses `viewDimension: "cube"` or `"cube-array"`. |

### 7. Pipelines

| # | Check | FAIL condition |
|---|-------|----------------|
| 7.1 | Target format match | A `fragment.targets[i].format` does not equal the matching render-pass attachment texture format. |
| 7.2 | Per-frame build | `createRenderPipeline` / `createComputePipeline` is called inside the frame loop. |
| 7.3 | Async build at load | Many heavy shaders are compiled with synchronous `createRenderPipeline` during a frame instead of `createRenderPipelineAsync` at load. |
| 7.4 | Layout choice | `"auto"` layout is used where the same resources must be shared across pipelines; an explicit `GPUPipelineLayout` is required. |

### 8. Render passes

| # | Check | FAIL condition |
|---|-------|----------------|
| 8.1 | Attachment count | `colorAttachments` count does not match `fragment.targets` count. |
| 8.2 | Attachment format | A `colorAttachments[i]` texture format does not match `fragment.targets[i].format`. |
| 8.3 | MSAA sample count | Pipeline `multisample.count` does not equal the attachment texture `sampleCount`. |
| 8.4 | Resolve target | A `resolveTarget` is not a single-sample (`sampleCount: 1`) view with a matching format. |
| 8.5 | Pass closed | `encoder.finish()` is called with a render or compute pass still open (no `.end()`). |
| 8.6 | Same-pass hazard | A texture is sampled in a bind group while it is also a writable attachment of the same pass. |
| 8.7 | Command buffer reuse | A `GPUCommandBuffer` is submitted more than once. Command buffers are single-use. |

### 9. WGSL correctness

| # | Check | FAIL condition |
|---|-------|----------------|
| 9.1 | No recursion | A WGSL function calls itself directly or via a cycle. The static call graph must be acyclic. |
| 9.2 | `switch` default | A `switch` statement omits the mandatory `default:` clause. |
| 9.3 | Uniform struct layout | A `uniform` struct does not satisfy the std140-like rule: `vec3` aligns to 16 bytes, array element stride is a multiple of 16 bytes, a nested struct/array member starts at a 16-byte offset. |
| 9.4 | Host offset match | The host-side `Float32Array` writes do not match the WGSL struct member offsets computed from the alignment rules. |
| 9.5 | Integer interpolation | An integer inter-stage variable lacks `@interpolate(flat)`. |
| 9.6 | Runtime array placement | `array<T>` (runtime-sized) is declared outside the last member of a `storage` struct. |
| 9.7 | `enable` directive | An `f16` literal or `subgroups` builtin is used without the matching `enable` / `requires` directive AND the matching device feature. |
| 9.8 | Stage-restricted builtin | `discard` is used outside `@fragment`; `dpdx`/`dpdy`/`fwidth` are used outside `@fragment`; `textureSample` (implicit-derivative form) is used outside `@fragment`. |
| 9.9 | Mixed swizzle sets | A swizzle mixes `.xyzw` with `.rgba`, for example `v.xr`. |

### 10. Compute correctness

| # | Check | FAIL condition |
|---|-------|----------------|
| 10.1 | `@workgroup_size` | A `@compute` entry point has no `@workgroup_size(...)` attribute. |
| 10.2 | Barrier presence | A read of `var<workgroup>` data written by other invocations has no `workgroupBarrier()` between the write and the read. |
| 10.3 | Barrier uniformity | `workgroupBarrier` / `storageBarrier` is placed inside divergent (non-uniform) control flow. |
| 10.4 | Atomic placement | `atomic<T>` is declared outside the `workgroup` or `storage` address space. |
| 10.5 | Workgroup size limit | The `@workgroup_size` product exceeds `maxComputeInvocationsPerWorkgroup` (256 default). |
| 10.6 | Dispatch ordering | A compute-output buffer is mapped to the CPU in the same frame without `await queue.onSubmittedWorkDone()`. |

### 11. Error handling and debugging

| # | Check | FAIL condition |
|---|-------|----------------|
| 11.1 | Error scopes | Suspect resource creation is not bracketed by `pushErrorScope("validation")` / `popErrorScope()`. |
| 11.2 | Labels | A buffer, texture, pipeline, bind group, sampler, or shader module has no `label`. |
| 11.3 | Compilation info | `getCompilationInfo()` is not checked after `createShaderModule`. |
| 11.4 | `uncapturederror` misuse | `uncapturederror` is treated as WebGL's synchronous `getError()` for targeted diagnosis. |

### 12. Performance

| # | Check | FAIL condition |
|---|-------|----------------|
| 12.1 | Frame-loop stall | The render loop `await`s `mapAsync` or `onSubmittedWorkDone`. |
| 12.2 | Resource churn | `GPURenderPipeline`, `GPUComputePipeline`, or `GPUBindGroup` objects are rebuilt every frame. |
| 12.3 | Bundle rebuild | Render bundles are rebuilt every frame instead of replayed unchanged. |
| 12.4 | Buffer-per-object | A separate uniform buffer is allocated per object instead of one buffer with dynamic offsets. |

---

## Part 2: WebGPU 1.0-Stable API Surface (Hallucination Cross-Check)

To catch hallucinated APIs, cross-check every API name, method, descriptor field, enum
value, and WGSL builtin in the reviewed code against this surface. Anything NOT listed
here, and not present in the W3C WebGPU or WGSL specification, is a hallucinated API
and a hard FAIL.

### Host-side entry point and device

- `navigator.gpu` / `WorkerNavigator.gpu` (the `GPU` interface).
- `GPU`: `requestAdapter(options)`, `getPreferredCanvasFormat()`, `wgslLanguageFeatures`.
- `GPUAdapter`: `features`, `limits`, `info`, `requestDevice(descriptor)`.
- `GPUDevice`: `features`, `limits`, `queue`, `lost`, `label`, `createBuffer`,
  `createTexture`, `createSampler`, `createBindGroupLayout`, `createPipelineLayout`,
  `createBindGroup`, `createShaderModule`, `createComputePipeline`,
  `createComputePipelineAsync`, `createRenderPipeline`, `createRenderPipelineAsync`,
  `createCommandEncoder`, `createRenderBundleEncoder`, `createQuerySet`,
  `pushErrorScope`, `popErrorScope`, `destroy`, `importExternalTexture`.
- `GPUQueue`: `submit`, `writeBuffer`, `writeTexture`, `copyExternalImageToTexture`,
  `onSubmittedWorkDone`.

`device.queue` is a property. There is NO `device.createBufferSync`, NO
`device.getQueue()`, NO `adapter.createDevice` (the method is `requestDevice`).

### Buffers and textures

- `GPUBuffer`: `size`, `usage`, `mapState`, `mapAsync(mode, offset?, size?)`,
  `getMappedRange(offset?, size?)`, `unmap`, `destroy`, `label`.
- `GPUBufferUsage`: `MAP_READ`, `MAP_WRITE`, `COPY_SRC`, `COPY_DST`, `INDEX`, `VERTEX`,
  `UNIFORM`, `STORAGE`, `INDIRECT`, `QUERY_RESOLVE`.
- `GPUMapMode`: `READ`, `WRITE`.
- `GPUTexture`: `createView(descriptor?)`, `destroy`, `width`, `height`,
  `depthOrArrayLayers`, `mipLevelCount`, `sampleCount`, `dimension`, `format`, `usage`.
- `GPUTextureUsage`: `COPY_SRC`, `COPY_DST`, `TEXTURE_BINDING`, `STORAGE_BINDING`,
  `RENDER_ATTACHMENT`.
- `GPUSampler`, `GPUTextureView`, `GPUExternalTexture`.

There is NO `GPUBuffer.update`, NO `texture.generateMipmaps()`, NO `buffer.write()`.
WebGPU has no automatic mipmap generation.

### Pipelines, bind groups, commands

- `GPUShaderModule`: `getCompilationInfo()`.
- `GPURenderPipeline`, `GPUComputePipeline`: `getBindGroupLayout(index)`.
- `GPUPipelineLayout`, `GPUBindGroupLayout`, `GPUBindGroup`.
- `GPUCommandEncoder`: `beginRenderPass`, `beginComputePass`, `copyBufferToBuffer`,
  `copyBufferToTexture`, `copyTextureToBuffer`, `copyTextureToTexture`,
  `clearBuffer`, `resolveQuerySet`, `pushDebugGroup`, `popDebugGroup`,
  `insertDebugMarker`, `finish`.
- `GPURenderPassEncoder`: `setPipeline`, `setBindGroup`, `setVertexBuffer`,
  `setIndexBuffer`, `setViewport`, `setScissorRect`, `setBlendConstant`,
  `setStencilReference`, `draw`, `drawIndexed`, `drawIndirect`, `drawIndexedIndirect`,
  `executeBundles`, `end`.
- `GPUComputePassEncoder`: `setPipeline`, `setBindGroup`, `dispatchWorkgroups`,
  `dispatchWorkgroupsIndirect`, `end`.
- `GPUCommandBuffer` (single-use).
- `GPUQuerySet` types: `"occlusion"`, `"timestamp"`.

There is NO `passEncoder.bindPipeline` (it is `setPipeline`), NO
`encoder.beginPass` (it is `beginRenderPass`), NO `passEncoder.drawArrays`.

### Canvas

- `canvas.getContext("webgpu")` -> `GPUCanvasContext`.
- `GPUCanvasContext`: `configure(config)`, `unconfigure()`, `getCurrentTexture()`.

### Errors

- `GPUValidationError`, `GPUOutOfMemoryError`, `GPUInternalError` (all `GPUError`).
- `GPUDeviceLostInfo`: `reason` (`"destroyed"`, `"unknown"`), `message`.
- `uncapturederror` event on `GPUDevice`.

### Key enums

- `GPUFeatureName`: `"depth-clip-control"`, `"depth32float-stencil8"`,
  `"texture-compression-bc"`, `"texture-compression-etc2"`,
  `"texture-compression-astc"`, `"timestamp-query"`, `"indirect-first-instance"`,
  `"shader-f16"`, `"rg11b10ufloat-renderable"`, `"bgra8unorm-storage"`,
  `"float32-filterable"`, `"float32-blendable"`, `"clip-distances"`,
  `"dual-source-blending"`, `"subgroups"`.
- `GPUBufferBindingType`: `"uniform"`, `"storage"`, `"read-only-storage"`.
- `GPUSamplerBindingType`: `"filtering"`, `"non-filtering"`, `"comparison"`.
- `GPUTextureSampleType`: `"float"`, `"unfilterable-float"`, `"depth"`, `"sint"`,
  `"uint"`.
- `GPUStorageTextureAccess`: `"write-only"`, `"read-only"`, `"read-write"`.
- `loadOp`: `"clear"`, `"load"`. `storeOp`: `"store"`, `"discard"`.

### WGSL surface

- Scalars: `bool`, `i32`, `u32`, `f32`, `f16` (gated by `enable f16;` + `shader-f16`).
- Composites: `vecN<T>`, `matCxR<T>`, `array<T, N>`, `array<T>` (runtime-sized,
  storage last member only), `struct`, `atomic<i32>`, `atomic<u32>`, `ptr<...>`.
- Declarations: `var`, `let`, `const`, `override`, `alias`, `fn`.
- Address spaces: `function`, `private`, `workgroup`, `uniform`, `storage`, `handle`.
- Stage attributes: `@vertex`, `@fragment`, `@compute`, `@workgroup_size`.
- IO / layout attributes: `@location`, `@builtin`, `@group`, `@binding`,
  `@interpolate`, `@invariant`, `@align`, `@size`, `@id`, `@must_use`, `@diagnostic`.
- Builtin values: `vertex_index`, `instance_index`, `position`, `clip_distances`,
  `front_facing`, `frag_depth`, `sample_index`, `sample_mask`, `local_invocation_id`,
  `local_invocation_index`, `global_invocation_id`, `workgroup_id`, `num_workgroups`,
  `subgroup_invocation_id`, `subgroup_size`.
- Texture builtins: `textureSample`, `textureSampleLevel`, `textureSampleBias`,
  `textureSampleGrad`, `textureSampleCompare`, `textureSampleCompareLevel`,
  `textureSampleBaseClampToEdge`, `textureLoad`, `textureStore`, `textureDimensions`,
  `textureNumLayers`, `textureNumLevels`, `textureNumSamples`, `textureGather`,
  `textureGatherCompare`.
- Sync builtins: `workgroupBarrier`, `storageBarrier`, `textureBarrier`,
  `workgroupUniformLoad`.
- Atomic builtins: `atomicLoad`, `atomicStore`, `atomicAdd`, `atomicSub`, `atomicMax`,
  `atomicMin`, `atomicAnd`, `atomicOr`, `atomicXor`, `atomicExchange`,
  `atomicCompareExchangeWeak`.
- Derivative builtins (`@fragment` only): `dpdx`, `dpdy`, `fwidth` plus
  `Coarse`/`Fine` variants.

There is NO `texture_2d.sample()` method form (texture sampling is the free function
`textureSample`), NO `gl_Position` (it is `@builtin(position)`), NO `const fn`
(WGSL 1.0 has no user-declarable const functions), NO C-style `switch` fall-through.

---

## Part 3: Issue-to-Skill Routing Map

For each confirmed defect, route to the sibling skill that holds the authoritative fix.
The validator checks and routes; it does not re-teach the API.

| Defect category | Routing target skill |
|-----------------|----------------------|
| Adapter null-check, queue call form, async chain, secure context | `webgpu-core-architecture` |
| Missing `device.lost` handler, unsafe recovery, silent retry loop | `webgpu-errors-device-loss` |
| Optional feature in `requiredFeatures` without detection, limit negotiation | `webgpu-core-limits-features` |
| Cross-browser feature gaps, canvas format portability | `webgpu-core-cross-browser` |
| WebGPU in Web Workers / OffscreenCanvas setup defects | `webgpu-core-workers` |
| Host-side alignment numbers (4 / 8 / 256), texel-block origin | `webgpu-core-memory-model` |
| Buffer usage flags, mapping lifecycle, detached `ArrayBuffer` | `webgpu-syntax-buffers` |
| Texture format/usage, sampler binding type, external texture lifetime | `webgpu-syntax-textures` |
| `@binding`/`@group` mismatch, layout mismatch, mixed auto/explicit | `webgpu-syntax-bind-groups` |
| Pass not closed, copy-method misuse, query set defect | `webgpu-syntax-command-encoder` |
| `fragment.targets` format mismatch, vertex buffer layout defect | `webgpu-syntax-render-pipeline` |
| `@workgroup_size` coupling, dispatch math, indirect dispatch | `webgpu-syntax-compute-pipeline` |
| `getCurrentTexture` cached across frames, configure defects | `webgpu-syntax-canvas-context` |
| Render vs compute pipeline model, `"auto"` vs explicit layout, async build | `webgpu-core-pipeline-architecture` |
| WGSL types, recursion, missing `switch default:`, mixed swizzle | `webgpu-wgsl-syntax` |
| WGSL struct layout, `vec3` 16-byte trap, address space, runtime array | `webgpu-wgsl-memory-layout` |
| WGSL builtin functions and builtin values per stage | `webgpu-wgsl-builtins` |
| WGSL texture handle types, sampler types, stage legality | `webgpu-wgsl-textures` |
| `@vertex` entry, varyings, `@interpolate(flat)` on integers | `webgpu-wgsl-vertex-shaders` |
| `@fragment` entry, `discard`, MRT outputs, depth output | `webgpu-wgsl-fragment-shaders` |
| `@compute` entry, `@workgroup_size`, barriers, atomics, subgroups | `webgpu-wgsl-compute-shaders` |
| Uniform control flow, `enable`/`requires`/`diagnostic`, derivative uniformity | `webgpu-wgsl-uniformity` |
| Color/depth attachment, MSAA `sampleCount`/`resolveTarget` mismatch | `webgpu-impl-render-targets` |
| Same-pass read-write hazard, post-processing, deferred, shadow map | `webgpu-impl-multipass` |
| Indirect buffer stride, `firstInstance`, GPU-driven rendering | `webgpu-impl-instancing-indirect` |
| Upload-path choice, GPU-CPU readback, `bytesPerRow` padding | `webgpu-impl-buffer-upload` |
| Render-loop stall, map-state lifecycle, async pipeline creation | `webgpu-impl-async-patterns` |
| Per-frame pipeline rebuild, bundle rebuild, state churn | `webgpu-impl-performance` |
| Compute use-case structure (particles, reduction, image processing) | `webgpu-impl-compute-usecases` |
| Render use-case structure (PBR, full-screen quad, SSAO) | `webgpu-impl-render-usecases` |
| WebGL-to-WebGPU concept mapping, clip-space Z, manual mipmaps | `webgpu-impl-webgl-migration` |
| Error scopes, `GPUError` subtypes, `uncapturederror` misuse | `webgpu-errors-validation` |
| Missing labels, `getCompilationInfo` ignored, debug groups | `webgpu-errors-debugging` |
| Hallucinated API not in the 1.0 spec surface | Cross-check against Part 2; remove or replace the call |

### Reporting format

After running the checklist, report each defect in this shape:

```
[FAIL <category>.<number>] <one-line description>
  Detection: <where it was spotted in the code>
  Fix: route to <skill-name>
```

Report the FIRST defect in any contagious error chain as the root cause and mark
later dependent failures as downstream.
