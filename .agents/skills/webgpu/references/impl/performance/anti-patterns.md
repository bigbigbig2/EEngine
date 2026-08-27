# Anti-Patterns: WebGPU Performance

Each entry states the mistake, WHY it fails, and the fix. Verified against the W3C
WebGPU specification, MDN, and the toji.dev render-bundle best-practices page.
Targets WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## 1. Rebuilding render bundles every frame

**Mistake:** Calling `createRenderBundleEncoder`, re-recording all draws, and `finish()`
inside the frame loop, often to absorb objects added or removed that frame.

**WHY it fails:** Bundle encoding still pays the full per-command validation and native
translation cost. The single benefit of a bundle is cheap REPLAY of an already-validated
command list. Rebuilding it each frame pays the encode cost every frame and gains
nothing; a per-frame rebuilt bundle is strictly slower than encoding directly into the
render pass, because of the extra bundle object.

**Fix:** Build the bundle ONCE at load time when the draw list is fixed. Replay the same
`GPURenderBundle` every frame via `executeBundles`. When per-object data changes, update
the uniform or storage buffers between replays; the bundle stays valid. When the draw
COUNT must change, keep the bundle and use `drawIndirect` whose argument buffer a compute
pass writes. If the draw list genuinely changes membership every frame, do NOT use a
bundle at all; encode directly into the render pass.

## 2. Recreating pipelines or bind groups per frame

**Mistake:** Calling `device.createRenderPipeline`, `createComputePipeline`, or
`createBindGroup` inside the per-frame render path.

**WHY it fails:** `GPURenderPipeline`, `GPUComputePipeline`, and `GPUBindGroup` are
immutable. Creation runs validation plus native shader and pipeline-state translation.
Doing this every frame adds that cost to every frame, producing visible jank and a CPU
bottleneck that no amount of GPU headroom can hide.

**Fix:** Create pipelines and bind groups ONCE at load time and store the references.
Reuse the cached objects in the frame loop. For shader compilation during loading, use
`createRenderPipelineAsync` / `createComputePipelineAsync` so compilation runs off the
content timeline. For per-object variation, do not create new bind groups; pack uniforms
into one buffer and select with dynamic offsets.

## 3. Synchronously blocking on mapAsync each frame for readback

**Mistake:** `await stagingBuffer.mapAsync(GPUMapMode.READ)` (or `await
queue.onSubmittedWorkDone()`) inside the per-frame render path to read GPU output.

**WHY it fails:** Awaiting the map promise forces a full CPU-GPU synchronization. The CPU
cannot proceed until the GPU has finished and drained all submitted work. This collapses
frame pipelining, which depends on the CPU recording frame N+1 while the GPU executes
frame N. The result is a hard stall and a large frame-rate drop.

**Fix:** Use a rotating staging buffer (2 or 3 buffers). Submit the copy this frame, and
read a buffer that the GPU finished one or two frames ago, accepting results one or two
frames late. Never `await` the map inside the render path; trigger `mapAsync` and read in
its `.then` callback. See `webgpu-impl-async-patterns`.

## 4. A workgroup size that is not a multiple of 32 or 64

**Mistake:** Picking `@workgroup_size` so the product `x * y * z` is an arbitrary number
such as 100, 50, or 10.

**WHY it fails:** GPUs execute compute invocations in fixed-width subgroups (32 lanes on
most NVIDIA and Intel hardware, 64 on most AMD). A workgroup whose invocation count is
not a multiple of the subgroup width leaves the final subgroup partially filled; those
idle lanes still consume scheduling slots and execution cycles, wasting GPU throughput.

**Fix:** Choose `@workgroup_size` so the product is a multiple of the subgroup width. Use
64 as the portable default (`@workgroup_size(64)`), which divides cleanly by both 32 and
64. For 2D work use `@workgroup_size(8, 8)` (product 64); for 3D use
`@workgroup_size(4, 4, 4)`. Keep the product at or below
`maxComputeInvocationsPerWorkgroup` (default 256). Guard the dispatch tail in WGSL with a
bounds check on `global_invocation_id`.

## 5. Using timestamp queries without the timestamp-query feature

**Mistake:** Calling `device.createQuerySet({ type: "timestamp", ... })` or attaching
`timestampWrites` to a pass without the `timestamp-query` feature enabled, or adding
`"timestamp-query"` to `requiredFeatures` unconditionally.

**WHY it fails:** `timestamp-query` is an OPTIONAL `GPUFeatureName`. Creating a
`"timestamp"` query set or using `timestampWrites` without the feature on the device is a
validation error. Adding it to `requiredFeatures` without first checking the adapter
makes `requestDevice` REJECT on any browser that does not expose it; Safari and Firefox
expose different optional-feature sets than Chrome, so the app breaks entirely on those
browsers rather than degrading.

**Fix:** Feature-detect on the adapter and gate everything:

```js
const adapter = await navigator.gpu.requestAdapter();
const hasTimestamp = adapter.features.has("timestamp-query");
const device = await adapter.requestDevice({
  requiredFeatures: hasTimestamp ? ["timestamp-query"] : [],
});
```

Only create the query set and attach `timestampWrites` when `hasTimestamp` is true. Skip
profiling gracefully when the feature is absent.

## 6. Allocating one uniform buffer per object

**Mistake:** Calling `device.createBuffer` once per scene object and a matching
`createBindGroup` per object, to hold each object's transform and material uniforms.

**WHY it fails:** Each buffer is a separate allocation, and each bind group is a separate
immutable object that costs validation time to build. With hundreds of objects this
multiplies allocation count, binding-switch cost, and memory fragmentation, and inflates
the per-frame `setBindGroup` count.

**Fix:** Pack all per-object uniform structs into ONE `GPUBuffer`. Create ONE bind group
whose layout entry sets `buffer.hasDynamicOffset: true`. Select an object per draw with a
dynamic offset passed to `setBindGroup(index, bindGroup, [offset])`. Pad each object's
struct stride to a 256-byte multiple so every offset satisfies
`minUniformBufferOffsetAlignment`.

## 7. Issuing draws in random state order

**Mistake:** Iterating the scene in arbitrary or scene-graph order and calling
`setPipeline` / `setBindGroup` before every draw, even when consecutive draws share
state.

**WHY it fails:** `setPipeline` and `setBindGroup` are the dominant per-draw CPU cost.
Random ordering forces a redundant state switch on nearly every draw, so the command
stream is mostly state changes rather than draws.

**Fix:** Sort the draw list by pipeline first, then by bind group, before encoding. Track
the last-set pipeline and bind group and skip the call when it is unchanged. This
collapses runs of same-state draws into a single state switch followed by many cheap
draw calls.

## Verified Sources

- https://www.w3.org/TR/webgpu/ — render bundle encoder, query sets, optional features,
  dynamic offsets, limits.
- https://developer.mozilla.org/en-US/docs/Web/API/GPURenderBundleEncoder — bundle
  encoder semantics.
- https://toji.dev/webgpu-best-practices/render-bundles.html — rebuild anti-pattern,
  state reset (cross-check only).
- docs/research/vooronderzoek-webgpu.md — PART C section 5 (Performance anti-patterns),
  PART A section 2 (features, limits), PART C Anti-Patterns Catalog items 7, 8, 9.
