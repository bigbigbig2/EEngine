# Methods: WebGPU Performance

API reference for the optimization levers in this skill. All names verified against the
W3C WebGPU specification, MDN, and the toji.dev render-bundle best-practices page.
Targets WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## Render Bundles

### device.createRenderBundleEncoder(descriptor)

Returns a `GPURenderBundleEncoder`. The descriptor is a `GPURenderBundleEncoderDescriptor`:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `label` | string | no | ALWAYS set for debuggable validation messages |
| `colorFormats` | `(GPUTextureFormat \| null)[]` | yes | Must match the formats of the render pass that replays the bundle |
| `depthStencilFormat` | `GPUTextureFormat` | no | Must match the render pass `depthStencilAttachment` format |
| `sampleCount` | number | no | Default 1; must equal the render pass attachment `sampleCount` |
| `depthReadOnly` | boolean | no | Default false |
| `stencilReadOnly` | boolean | no | Default false |

The `colorFormats`, `depthStencilFormat`, and `sampleCount` MUST match the render pass
that later calls `executeBundles`, or replay fails validation.

### GPURenderBundleEncoder methods

A render bundle encoder records a SUBSET of render pass commands:

| Method | Purpose |
|--------|---------|
| `setPipeline(pipeline)` | Set the `GPURenderPipeline` |
| `setBindGroup(index, bindGroup, dynamicOffsets?)` | Bind a `GPUBindGroup` |
| `setVertexBuffer(slot, buffer, offset?, size?)` | Set a vertex buffer |
| `setIndexBuffer(buffer, indexFormat, offset?, size?)` | Set the index buffer |
| `draw(vertexCount, instanceCount?, firstVertex?, firstInstance?)` | Non-indexed draw |
| `drawIndexed(indexCount, instanceCount?, firstIndex?, baseVertex?, firstInstance?)` | Indexed draw |
| `drawIndirect(indirectBuffer, indirectOffset)` | Draw with GPU-supplied arguments |
| `drawIndexedIndirect(indirectBuffer, indirectOffset)` | Indexed draw with GPU-supplied arguments |
| `pushDebugGroup(label)` / `popDebugGroup()` | Annotate the command stream |
| `insertDebugMarker(label)` | Insert a single marker |
| `finish(descriptor?)` | Stop recording, return a `GPURenderBundle` |

### Methods NOT available on a render bundle encoder

A render bundle encoder CANNOT call these render pass methods. The bundle inherits these
values from the `GPURenderPassEncoder` that replays it:

- `setViewport`
- `setScissorRect`
- `setBlendConstant`
- `setStencilReference`
- `beginOcclusionQuery` / `endOcclusionQuery`
- `executeBundles` (a bundle cannot execute another bundle)

### finish() and GPURenderBundle

`finish()` returns an immutable `GPURenderBundle`. The same bundle object is replayed
every frame. A bundle is a plain command list; it carries no GPU resources of its own.

### GPURenderPassEncoder.executeBundles(bundles)

Takes an array of `GPURenderBundle` objects: `passEncoder.executeBundles([bundleA, bundleB])`.
Each bundle replays its recorded commands into the active render pass.

### State-reset semantics (critical)

The render pass pipeline, bind group, and vertex/index buffer state is reset to
"unset" BOTH before AND after every bundle execution. Consequences:

- A bundle does NOT inherit state set by `passEncoder.setPipeline(...)` before
  `executeBundles`. Every bundle MUST set its own pipeline, bind groups, and buffers.
- Sequential bundles do NOT share state. `executeBundles([A, B])` resets between A and
  B; B must independently set everything it uses.
- After `executeBundles` returns, the render pass has NO pipeline or bind groups set.
  Any direct draw after the bundle MUST call `setPipeline` / `setBindGroup` again.

### When render bundles pay off

- ALWAYS for a static or mostly-static draw list replayed unchanged across frames.
- ALWAYS for content drawn multiple times per frame (VR per-eye, cascaded shadows).
- NEVER for a draw list that changes membership every frame; encode directly instead.

### Driving variation without rebuilding

A bundle is reusable when the draw list is fixed even if per-object data changes:

- Update uniform / storage buffers between replays. The bundle references the buffer
  objects, not their contents, so new data reaches the shader without re-encoding.
- Use `drawIndirect` / `drawIndexedIndirect` inside the bundle and have a compute pass
  write the argument buffer. Draw counts then vary without touching the bundle.
- Compute-based GPU culling writes the indirect arguments; the bundle stays constant.

## Pipeline and Bind-Group Caching

`GPURenderPipeline`, `GPUComputePipeline`, and `GPUBindGroup` are immutable after
creation and expensive to build (validation plus native shader/state translation).

- ALWAYS create them once at load time. Store the references on a long-lived object.
- ALWAYS reuse the cached objects in the frame loop.
- NEVER call `createRenderPipeline`, `createComputePipeline`, or `createBindGroup`
  inside the per-frame path.
- For shader compilation off the main thread during loading, use
  `createRenderPipelineAsync` / `createComputePipelineAsync`.

Bind-group caching key: keep a `Map` keyed by the resource set so identical bind groups
are created once and looked up thereafter.

## Buffer Sub-Allocation with Dynamic Offsets

Pack many per-object uniform structs into ONE `GPUBuffer` and select a struct with a
dynamic offset, instead of one buffer per object.

- The bind group layout entry MUST set `buffer.hasDynamicOffset: true`.
- The dynamic offset is passed at draw time:
  `setBindGroup(index, bindGroup, [offset])`.
- Each dynamic offset MUST be a multiple of `minUniformBufferOffsetAlignment` (256) for
  uniform buffers, or `minStorageBufferOffsetAlignment` (256) for storage buffers. Both
  are `minimum`-class limits and never drop below 256.
- The per-object struct stride MUST therefore be padded up to a 256-byte multiple. A
  192-byte struct still needs a 256-byte stride.

See `webgpu-impl-buffer-upload` for the upload mechanics.

## Workgroup-Size Tuning

`@workgroup_size(x, y, z)` on a `@compute` entry point sets the per-workgroup invocation
grid. Performance rule:

- The product `x * y * z` MUST be a multiple of the hardware subgroup width: 32 on most
  NVIDIA and Intel GPUs, 64 on most AMD GPUs.
- 64 is the robust portable default: `@workgroup_size(64)` divides cleanly by both 32
  and 64.
- 2D image work: `@workgroup_size(8, 8)` (product 64). 3D work:
  `@workgroup_size(4, 4, 4)` (product 64).
- The product MUST NOT exceed `maxComputeInvocationsPerWorkgroup` (default 256). An
  adapter may report higher; query `device.limits.maxComputeInvocationsPerWorkgroup`.
- Each dimension MUST NOT exceed `maxComputeWorkgroupSizeX` / `Y` / `Z`.
- A product that is not a multiple of 32 (for example 100) leaves partial subgroups
  with idle lanes, wasting GPU throughput.

The dispatch count is separate: `dispatchWorkgroups(cx, cy, cz)` launches the grid of
workgroups. Compute the count as `ceil(itemCount / workgroupSize)` and guard the tail
in WGSL with a bounds check on `global_invocation_id`.

## Timestamp-Query Profiling (feature-gated)

The `timestamp-query` feature enables on-GPU profiling. It is OPTIONAL; gate it.

### Feature gating

```js
const adapter = await navigator.gpu.requestAdapter();
const hasTimestamp = adapter.features.has("timestamp-query");
const device = await adapter.requestDevice({
  requiredFeatures: hasTimestamp ? ["timestamp-query"] : [],
});
```

NEVER add `"timestamp-query"` to `requiredFeatures` unconditionally; `requestDevice`
rejects on browsers that lack it (notably some Safari and Firefox builds).

### device.createQuerySet(descriptor)

Returns a `GPUQuerySet`:

| Field | Type | Notes |
|-------|------|-------|
| `label` | string | ALWAYS set |
| `type` | `"occlusion"` \| `"timestamp"` | Use `"timestamp"` for profiling |
| `count` | number | Number of query slots; 2 per pass (start + end) |

### timestampWrites on a pass

Both `beginRenderPass` and `beginComputePass` accept a `timestampWrites` object:

| Field | Type | Notes |
|-------|------|-------|
| `querySet` | `GPUQuerySet` | The timestamp query set |
| `beginningOfPassWriteIndex` | number | Slot to write the pass-start timestamp |
| `endOfPassWriteIndex` | number | Slot to write the pass-end timestamp |

### Resolving and reading the results

1. `commandEncoder.resolveQuerySet(querySet, firstQuery, queryCount, destination, destinationOffset)`
   copies the `u64` timestamp values into a `GPUBuffer`. The destination buffer MUST
   have `GPUBufferUsage.QUERY_RESOLVE` usage.
2. Copy from the resolve buffer into a separate `MAP_READ | COPY_DST` staging buffer
   with `copyBufferToBuffer`.
3. After submit, `await stagingBuffer.mapAsync(GPUMapMode.READ)`, read the values as
   `BigUint64Array`, `unmap()`.

Timestamps are in nanoseconds. Pass duration is `end - start`. To avoid stalling the
frame, read the staging buffer one or two frames late (see `webgpu-impl-async-patterns`).

## Verified Sources

- https://www.w3.org/TR/webgpu/ — render bundle encoder, query sets, timestampWrites,
  resolveQuerySet, limits, dynamic offsets.
- https://developer.mozilla.org/en-US/docs/Web/API/GPURenderBundleEncoder — method list,
  descriptor fields, methods not available versus a render pass encoder.
- https://toji.dev/webgpu-best-practices/render-bundles.html — state-reset semantics,
  when bundles pay off, driving variation without rebuilding (cross-check only).
- docs/research/vooronderzoek-webgpu.md — PART C section 5 (Performance), PART A
  section 2 (limits, features, timestamp-query), PART C section 11 (debugging).
