---
name: webgpu-review
description: Review WebGPU and WGSL code for API validity, resource and layout correctness, synchronization, error handling, and performance hazards. Use for explicit code reviews, audits, or validation; do not use for ordinary implementation questions.
---

# WebGPU Quality Validator

Review generated WebGPU host code and WGSL shaders for correctness, then route each
defect to the matching topic in `$webgpu`. This is a review workflow; do not use it
for ordinary implementation guidance.


> Topic identifiers such as `webgpu-core-architecture` refer to reference topics
> inside `$webgpu`; they are not separately installed skills. Use `$webgpu` to load
> the matching topic guidance when a finding needs implementation detail.

## Quick Reference

| Review category | What it catches | Routes to |
|-----------------|-----------------|-----------|
| Initialization | Missing adapter null-check, missing `device.lost` handler | webgpu-core-architecture, webgpu-errors-device-loss |
| Features and limits | Optional feature in `requiredFeatures` without detection | webgpu-core-limits-features, webgpu-core-cross-browser |
| Buffers | Illegal usage-flag combinations, missing usage flags | webgpu-syntax-buffers |
| Alignment | Size not mult-4, dynamic offset not 256, `bytesPerRow` not 256 | webgpu-core-memory-model, webgpu-impl-buffer-upload |
| Textures and samplers | Format/usage mismatch, sampler binding-type mismatch | webgpu-syntax-textures, webgpu-wgsl-textures |
| Bind groups | `@binding`/`@group` mismatch, layout mismatch, mixed auto/explicit | webgpu-syntax-bind-groups |
| Pipelines | Target format mismatch, sync pipeline build per frame | webgpu-syntax-render-pipeline, webgpu-core-pipeline-architecture |
| Render passes | Attachment count/format mismatch, `sampleCount` mismatch | webgpu-impl-render-targets, webgpu-impl-multipass |
| WGSL correctness | Recursion, missing `default:`, uniform struct layout | webgpu-wgsl-syntax, webgpu-wgsl-memory-layout, webgpu-wgsl-uniformity |
| Compute correctness | Missing `@workgroup_size`, missing barrier | webgpu-wgsl-compute-shaders, webgpu-syntax-compute-pipeline |
| Error handling | No error scopes, missing labels | webgpu-errors-validation, webgpu-errors-debugging |
| Performance | Per-frame pipeline or bind-group rebuild, render-loop stall | webgpu-impl-performance, webgpu-impl-async-patterns |

## Review Checklist

Run the checklist in this fixed order. Each line is a binary pass/fail check. Full
checklist text and the issue-to-skill routing map are in `references/methods.md`.

### 1. Initialization

- ALWAYS verify the code null-checks the adapter: `requestAdapter()` can resolve to
  `null`, which is NOT a rejection. Flag any code that calls `adapter.requestDevice()`
  without a preceding `if (!adapter)` guard.
- ALWAYS verify a `device.lost` handler is attached before any GPU resource is created.
  Flag any WebGPU app with no `device.lost.then(...)`.
- ALWAYS verify `device.queue` is read as a property. Flag `device.queue()` (call form).

### 2. Features and limits

- ALWAYS verify every entry in `requiredFeatures` is gated by `adapter.features.has(...)`.
  Flag a hard-coded feature string in `requiredFeatures`.
- ALWAYS verify `requiredLimits` requests only what the app needs. Flag values copied
  from `adapter.limits` wholesale.

### 3. Buffers

- ALWAYS verify `usage` flags are legal: `MAP_READ` combines only with `COPY_DST`,
  `MAP_WRITE` combines only with `COPY_SRC`. Flag `MAP_READ | STORAGE` and similar.
- ALWAYS verify the usage flag set matches how the buffer is used (a vertex buffer
  needs `VERTEX`, an indirect buffer needs `INDIRECT`).

### 4. Alignment

- ALWAYS verify buffer `size` is a multiple of 4 when `mappedAtCreation: true`.
- ALWAYS verify `writeBuffer` `bufferOffset` and `size` are multiples of 4.
- ALWAYS verify dynamic bind-group offsets are multiples of 256.
- ALWAYS verify `bytesPerRow` in buffer-texture copies is a multiple of 256.

### 5. Textures and samplers

- ALWAYS verify texture `usage` includes `RENDER_ATTACHMENT` for render targets,
  `TEXTURE_BINDING` for sampled textures, `STORAGE_BINDING` for storage textures.
- ALWAYS verify a comparison sampler binds to a `"comparison"` sampler layout entry and
  a filtering sampler binds to a `"filtering"` entry.
- ALWAYS verify the canvas format comes from `getPreferredCanvasFormat()`, not a
  hard-coded `"bgra8unorm"`.

### 6. Bind groups and layouts

- ALWAYS verify each WGSL `@group(g) @binding(b)` has a matching `GPUBindGroupLayoutEntry`
  with the same `binding` and a compatible resource type.
- ALWAYS verify `visibility` covers every shader stage that reads the binding.
- ALWAYS verify a bind group built from `pipeline.getBindGroupLayout(i)` is used only
  with that pipeline. Flag a shared bind group built from an `"auto"` layout.

### 7. Pipelines

- ALWAYS verify each `fragment.targets[i].format` equals the matching render-pass
  `colorAttachments[i]` texture format.
- ALWAYS verify pipelines are built once at load time, never inside the frame loop.

### 8. Render passes

- ALWAYS verify `colorAttachments` count and formats match the pipeline `fragment.targets`.
- ALWAYS verify pipeline `multisample.count` equals the attachment texture `sampleCount`
  and that any `resolveTarget` is single-sampled.
- ALWAYS verify every `beginRenderPass`/`beginComputePass` is closed with `.end()` before
  `encoder.finish()`.

### 9. WGSL correctness

- ALWAYS verify the static call graph is acyclic. Flag any recursive WGSL function.
- ALWAYS verify every `switch` has a `default:` clause.
- ALWAYS verify a `uniform` struct accounts for `vec3` 16-byte alignment and 16-byte
  array element stride; the host `Float32Array` offsets MUST match the WGSL layout.
- ALWAYS verify integer inter-stage variables carry `@interpolate(flat)`.
- ALWAYS verify `textureSample`, `dpdx`, and barriers run in uniform control flow.

### 10. Compute correctness

- ALWAYS verify every `@compute` entry point declares `@workgroup_size(...)`.
- ALWAYS verify a `workgroupBarrier()` separates a write to `var<workgroup>` from a later
  read by other invocations.

### 11. Error handling and debugging

- ALWAYS verify suspect resource creation is bracketed by `pushErrorScope`/`popErrorScope`.
- ALWAYS verify every buffer, texture, pipeline, bind group, and shader module has a
  `label`.
- ALWAYS verify `getCompilationInfo()` is checked after `createShaderModule`.

### 12. Performance

- ALWAYS verify the render loop does not `await mapAsync` or `await onSubmittedWorkDone`.
- ALWAYS verify render bundles, when used, are built once and replayed, never rebuilt
  per frame.

## Decision Tree

Use this tree to route a confirmed defect to a `$webgpu` topic identifier.

```
Issue found in review
├─ API name / descriptor field / enum / WGSL builtin not in the 1.0 spec surface?
│   └─ HALLUCINATED API -> see references/methods.md "API surface cross-check"
├─ Initialization defect
│   ├─ adapter not null-checked / queue called -> webgpu-core-architecture
│   └─ no device.lost handler / unsafe recovery -> webgpu-errors-device-loss
├─ Feature or limit defect -> webgpu-core-limits-features, webgpu-core-cross-browser
├─ Buffer usage / mapping defect -> webgpu-syntax-buffers
├─ Alignment defect (4 / 8 / 256) -> webgpu-core-memory-model, webgpu-impl-buffer-upload
├─ Texture / sampler defect -> webgpu-syntax-textures
├─ Bind-group / layout / @binding mismatch -> webgpu-syntax-bind-groups
├─ Pipeline format / build defect -> webgpu-syntax-render-pipeline,
│                                    webgpu-core-pipeline-architecture
├─ Render-pass attachment / MSAA defect -> webgpu-impl-render-targets, webgpu-impl-multipass
├─ WGSL language defect
│   ├─ types / control flow / recursion -> webgpu-wgsl-syntax
│   ├─ struct layout / alignment / address space -> webgpu-wgsl-memory-layout
│   ├─ texture handle / sampler type -> webgpu-wgsl-textures
│   └─ uniform control flow / diagnostics -> webgpu-wgsl-uniformity
├─ Shader-stage defect -> webgpu-wgsl-vertex-shaders, webgpu-wgsl-fragment-shaders,
│                         webgpu-wgsl-compute-shaders
├─ Error-handling / labeling defect -> webgpu-errors-validation, webgpu-errors-debugging
└─ Performance defect -> webgpu-impl-performance, webgpu-impl-async-patterns
```

## Core Patterns

- ALWAYS cross-check every API name, descriptor field, enum value, and WGSL builtin
  against the WebGPU 1.0-stable surface. Anything not in the spec is a hallucinated API
  and a hard failure. `references/methods.md` lists the legal surface for cross-checking.
- ALWAYS treat a missing `device.lost` handler as a defect, not a style issue. Without
  it the app silently produces a dead device after a GPU process crash.
- ALWAYS report the FIRST defect in the contagious chain. WebGPU errors propagate: an
  invalid descriptor poisons every dependent object, so later messages are downstream
  noise. Fix the root cause.
- NEVER pass code with a positional mismatch between WGSL `@binding`/`@group` and the
  `GPUBindGroupLayout` entries. WebGPU binds by index, not by name; a silent off-by-one
  reads the wrong resource.
- NEVER accept a uniform struct whose host-side `Float32Array` offsets ignore the WGSL
  `vec3` 16-byte alignment. A `vec3f` member lands at the next 16-byte offset.
- ALWAYS verify alignment numbers literally: size mult-4, `mapAsync` offset mult-8,
  dynamic offset mult-256, `bytesPerRow` mult-256. These are the largest source of
  WebGPU validation errors.

## Common Anti-Patterns

Top 3 inline. The full 18-entry catalog with detection cue and fix is in
`references/anti-patterns.md`.

- Hallucinated or invented API. Detection cue: an API name, descriptor field, enum
  value, or WGSL builtin not in the 1.0-stable spec (for example `device.createBufferSync`,
  `GPUBuffer.update`, `passEncoder.bindPipeline`, `textureSampleArray`). Fix: replace
  with the real API or remove the call; cross-check against `references/methods.md`.
- Missing device-loss handling. Detection cue: a WebGPU app with no `device.lost.then(...)`
  attached before resource creation. Fix: route to webgpu-errors-device-loss for the
  recovery pattern.
- Alignment error. Detection cue: a buffer `size`, `writeBuffer` offset, dynamic
  bind-group offset, or `bytesPerRow` that is not the required multiple (4 / 8 / 256).
  Fix: route to webgpu-core-memory-model.

## Critical Warnings

- NEVER approve WebGPU code that calls an API absent from the WebGPU 1.0-stable spec.
- NEVER approve a WebGPU app that omits the adapter null-check or the `device.lost`
  handler.
- NEVER approve a buffer whose `usage` flags are an illegal combination, for example
  `MAP_READ` with `STORAGE` or `UNIFORM`.
- NEVER approve a uniform struct whose host offsets ignore the WGSL 16-byte alignment
  rules.
- NEVER approve a `@compute` entry point without `@workgroup_size`, or a `switch` without
  `default:`; both are WGSL shader-creation errors.
- NEVER report a downstream contagious error as the root cause; trace back to the first
  invalid object.

## Reference Files

- `references/methods.md`: the full category-by-category review checklist, the WebGPU
  1.0-stable API surface for hallucination cross-check, and the issue-to-skill routing map.
- `references/examples.md`: before/after pairs of flawed WebGPU and WGSL code with the
  corrected version.
- `references/anti-patterns.md`: the consolidated 18-entry WebGPU anti-pattern catalog,
  each with a detection cue and a fix.
