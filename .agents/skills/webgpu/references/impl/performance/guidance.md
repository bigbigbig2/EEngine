# WebGPU Performance

Optimize WebGPU by minimizing CPU-side command-submission cost and GPU state churn.
Most WebGPU apps are CPU-bound, so the levers below target per-frame JavaScript work.

## Quick Reference

| Lever | Action | Pays off when |
|-------|--------|---------------|
| Pipeline caching | Create `GPURenderPipeline` / `GPUComputePipeline` once at load, reuse | Always |
| Bind-group caching | Create `GPUBindGroup` once, reuse; vary data via dynamic offsets | Always |
| Render bundles | Record a command subset once, replay via `executeBundles` | Static or mostly-static scenes; content drawn multiple times per frame |
| State sorting | Sort draws by pipeline, then by bind group | Many draws with mixed state |
| Buffer sub-allocation | Pack many small uniforms into one buffer, use dynamic offsets | Many per-object uniform buffers |
| Workgroup-size tuning | `@workgroup_size` product is a multiple of 32 or 64 | Compute shaders |
| Timestamp queries | `GPUQuerySet` of type `"timestamp"` + `timestampWrites` | Measuring real GPU pass cost |

All values target WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## Decision Tree

**Should I use render bundles?**

- Scene draws the SAME command sequence unchanged across frames → ALWAYS use a render
  bundle. Encode once, replay every frame.
- Same geometry drawn multiple times per frame (VR per-eye, cascaded shadow maps) →
  ALWAYS use a render bundle.
- Draw list changes every frame (objects added/removed each frame) → NEVER use a render
  bundle. Encode directly into the render pass instead.
- Draw list is fixed but per-object data (matrices, colors) changes → use a render
  bundle. Update the uniform/storage buffers between replays; the bundle stays valid.
- Draw COUNT must change per frame → keep the bundle, drive variation with indirect
  draws whose argument buffer a compute pass writes.

**How do I size a compute workgroup?**

- Pick `@workgroup_size(x, y, z)` so `x * y * z` is a multiple of the hardware subgroup
  width (32 on most NVIDIA/Intel, 64 on most AMD).
- ALWAYS use 64 as the portable default when unsure: `@workgroup_size(64)`.
- 2D image work → `@workgroup_size(8, 8)` (product 64). 3D → `@workgroup_size(4, 4, 4)`.
- NEVER let `x * y * z` exceed `maxComputeInvocationsPerWorkgroup` (default 256).
- NEVER pick a product that is not a multiple of 32 (for example 100): partial
  subgroups waste GPU lanes.

## Core Patterns

### ALWAYS create pipelines and bind groups once

`GPURenderPipeline`, `GPUComputePipeline`, and `GPUBindGroup` are immutable and expensive
to build. Create them at load time, store the references, reuse them every frame.

```js
// Load time (once)
const pipeline = device.createRenderPipeline({ label: "scene", layout, vertex, fragment });
const bindGroup = device.createBindGroup({ label: "scene-bg", layout: bgl, entries });

// Frame loop (reuse)
function frame() {
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  // ...
}
```

NEVER call `createRenderPipeline` or `createBindGroup` inside the frame loop.

### ALWAYS reuse one render bundle for static draws

`device.createRenderBundleEncoder` records a command subset once. `finish()` yields a
`GPURenderBundle` that `passEncoder.executeBundles([bundle])` replays. Validation and
native translation happen at encode time, so replay costs far less CPU work.

```js
// Load time (once)
const bundleEncoder = device.createRenderBundleEncoder({
  label: "static-scene",
  colorFormats: [presentationFormat],
  depthStencilFormat: "depth24plus",
  sampleCount: 1,
});
bundleEncoder.setPipeline(pipeline);
for (const obj of staticObjects) {
  bundleEncoder.setBindGroup(0, obj.bindGroup);
  bundleEncoder.setVertexBuffer(0, obj.vertexBuffer);
  bundleEncoder.draw(obj.vertexCount);
}
const bundle = bundleEncoder.finish();

// Frame loop (replay)
pass.executeBundles([bundle]);
```

NEVER rebuild the bundle inside the frame loop. Update buffers, replay the same bundle.

### ALWAYS sort draws by pipeline then bind group

State changes (`setPipeline`, `setBindGroup`) are the dominant per-draw cost. Sort the
draw list by pipeline first, then by bind group, then issue draws. This collapses
redundant state switches.

```js
draws.sort((a, b) => a.pipelineId - b.pipelineId || a.bindGroupId - b.bindGroupId);
```

### ALWAYS pack small uniforms into one buffer with dynamic offsets

Allocating one `GPUBuffer` per object multiplies allocation and binding cost. Pack all
per-object uniform structs into a single buffer and select one with a dynamic offset.

```js
// Layout entry must declare hasDynamicOffset
const bgl = device.createBindGroupLayout({
  entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX,
    buffer: { type: "uniform", hasDynamicOffset: true } }],
});
// Each dynamic offset MUST be a multiple of minUniformBufferOffsetAlignment (256)
pass.setBindGroup(0, bindGroup, [objectIndex * 256]);
```

The per-object struct stride MUST be padded to 256 bytes. See
`webgpu-impl-buffer-upload` for the upload side.

### ALWAYS profile passes with timestamp queries (feature-gated)

The `timestamp-query` feature plus a `GPUQuerySet` of type `"timestamp"` measure real
GPU pass duration. `timestampWrites` on a render or compute pass records a start and end
timestamp; `resolveQuerySet` copies them into a buffer.

```js
// Gate the feature at device creation
const device = await adapter.requestDevice({
  requiredFeatures: adapter.features.has("timestamp-query") ? ["timestamp-query"] : [],
});
```

See `methods.md` for the full query-set setup and `examples.md`
for the resolve-and-read code.

### NEVER block the frame on GPU readback

`await mapAsync(...)` or `await queue.onSubmittedWorkDone()` inside the render path
forces a full CPU-GPU sync that collapses frame pipelining. Read GPU results one or two
frames late from a rotating staging buffer instead. See `webgpu-impl-async-patterns`.

## Common Anti-Patterns

1. **Rebuilding render bundles every frame.** Encoding a bundle still pays the full
   validation cost. Rebuilding it each frame negates the only benefit, cheap replay.
   The bundle stays valid when the draw list is fixed: update buffers, replay unchanged.

2. **Recreating pipelines or bind groups per frame.** Both are immutable and expensive
   to build. Per-frame creation adds allocation, validation, and shader-translation cost
   to every frame. Build once at load, reuse.

3. **Synchronously blocking on `mapAsync` each frame for readback.** Awaiting the map
   promise stalls the CPU until the GPU drains, destroying the frame pipeline. Use a
   rotating staging buffer and accept results one or two frames late.

## Critical Warnings

- NEVER call `createRenderPipeline`, `createComputePipeline`, or `createBindGroup`
  inside the frame loop.
- NEVER rebuild a `GPURenderBundle` per frame when the draw list is unchanged.
- NEVER pass a dynamic offset that is not a multiple of 256
  (`minUniformBufferOffsetAlignment` / `minStorageBufferOffsetAlignment`).
- NEVER pick a compute `@workgroup_size` product that is not a multiple of 32 or 64.
- NEVER let `@workgroup_size` product exceed `maxComputeInvocationsPerWorkgroup`
  (default 256).
- NEVER use a `GPUQuerySet` of type `"timestamp"` or `timestampWrites` without first
  confirming `adapter.features.has("timestamp-query")` and adding it to
  `requiredFeatures`. Requesting the feature unconditionally makes `requestDevice`
  reject on browsers that lack it.
- NEVER `await mapAsync` or `await onSubmittedWorkDone` inside the per-frame render path.

## Reference Files

- `methods.md` — render bundle API, caching strategy, workgroup-size tuning,
  timestamp-query profiling setup.
- `examples.md` — verified code: render bundle encode and replay, timestamp
  query profiling, dynamic-offset sub-allocation.
- `anti-patterns.md` — performance mistakes with WHY-it-fails explanations.

## Related Skills

- `webgpu-syntax-command-encoder` — command encoder and render pass basics.
- `webgpu-core-pipeline-architecture` — pipeline and bind-group layout design.
- `webgpu-impl-buffer-upload` — `writeBuffer` versus staging-ring upload strategy.
- `webgpu-impl-async-patterns` — non-blocking readback, `mapAsync`, `onSubmittedWorkDone`.
- `webgpu-wgsl-compute-shaders` — `@workgroup_size`, compute dispatch in WGSL.
