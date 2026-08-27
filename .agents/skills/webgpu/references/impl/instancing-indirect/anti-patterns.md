# Anti-Patterns: Instancing and Indirect Draws

WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). Each entry states the
mistake, WHY it fails, and the correct approach.

## 1. Wrong indirect record stride: 20 bytes for drawIndirect, or 16 for drawIndexedIndirect

WRONG:

```js
// Non-indexed draw, but a 20-byte indexed-shaped record.
const record = new Uint32Array([vertexCount, instanceCount, 0, 0, 0]); // 5 values
const buf = device.createBuffer({ size: 20,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.INDIRECT });
device.queue.writeBuffer(buf, 0, record);
pass.drawIndirect(buf, 0);
```

WHY it fails: `drawIndirect` reads EXACTLY 16 bytes: `vertexCount, instanceCount,
firstVertex, firstInstance`. The fifth value is never read. Worse, if multiple records
are packed back-to-back with a 20-byte stride, every record after the first is offset
by 4 bytes, so `firstVertex` and `firstInstance` are read from the neighbouring
record's data, producing out-of-range vertex fetches and corrupt geometry. The mirror
mistake, a 16-byte buffer for `drawIndexedIndirect`, fails validation because
`indirectOffset + 20` exceeds the buffer size.

CORRECT: `drawIndirect` uses a 16-byte record of 4 `u32`. `drawIndexedIndirect` uses a
20-byte record of 5 `u32`. Match the stride to the call.

## 2. Leaving indirect buffer bytes uninitialized

WRONG:

```js
const buf = device.createBuffer({ size: 16,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.INDIRECT });
// Only the first two fields written.
device.queue.writeBuffer(buf, 0, new Uint32Array([vertexCount, instanceCount]));
pass.drawIndirect(buf, 0);
```

WHY it fails: a freshly created buffer's contents are zero-initialized by WebGPU, but
once any code reuses or partially overwrites the buffer the trailing `firstVertex` and
`firstInstance` slots hold stale values. The GPU reads all 16 bytes regardless; a
non-zero `firstVertex` shifts every vertex fetch out of range, drawing garbage or
triggering a validation error. Relying on implicit zeroing is fragile because it breaks
the moment the buffer is recycled.

CORRECT: ALWAYS write the complete record, including explicit zeros:
`new Uint32Array([vertexCount, instanceCount, 0, 0])`.

## 3. Non-zero firstInstance in an indirect draw without the indirect-first-instance feature

WRONG:

```js
const device = await adapter.requestDevice(); // feature NOT requested
const record = new Uint32Array([36, 100, 0, 0, 64]); // firstInstance = 64
device.queue.writeBuffer(indirectBuffer, 0, record);
pass.drawIndexedIndirect(indirectBuffer, 0);
```

WHY it fails: a non-zero `firstInstance` in an indirect record requires the
`indirect-first-instance` feature. Without it, the value is silently forced to 0. The
draw still runs, no error fires, and `@builtin(instance_index)` starts at 0 instead of
64, so per-instance data is read from the wrong slice. This is a silent correctness bug
with no diagnostic, and it is the hardest to notice because the scene still renders.

CORRECT: feature-detect and request the feature conditionally:

```js
const device = await adapter.requestDevice({
  requiredFeatures: adapter.features.has("indirect-first-instance")
    ? ["indirect-first-instance"] : [],
});
```

If the feature is unavailable, keep every indirect record's `firstInstance` at 0 and
offset per-instance data another way, such as a uniform base index in the shader. A
direct `draw` / `drawIndexed` call accepts a non-zero `firstInstance` without any
feature.

## 4. indirectOffset that is not a multiple of 4

WRONG:

```js
// Records packed with an 18-byte stride.
pass.drawIndirect(indirectBuffer, 18);
```

WHY it fails: `indirectOffset` MUST be a multiple of 4. An offset of 18 produces a
`GPUValidationError` and invalidates the entire pass encoder, so the whole render pass
is dropped. This commonly happens when records are packed with a non-4-aligned stride,
or when `firstInstance` is stored as a 2-byte value to "save space".

CORRECT: keep every record at a 4-aligned offset. `drawIndirect` records pack cleanly
at multiples of 16; `drawIndexedIndirect` records pack at multiples of 20; both 16 and
20 are multiples of 4, so back-to-back packing is always valid.

## 5. Assuming multiDrawIndirect is universally available

WRONG:

```js
// Used directly with no feature check, no fallback.
pass.multiDrawIndexedIndirect(indirectBuffer, 0, drawCount);
```

WHY it fails: `multiDrawIndirect` and `multiDrawIndexedIndirect` are experimental,
Chrome 131+ only, behind the `chromium-experimental-multi-draw-indirect` feature. They
are NOT part of the WebGPU 1.0-stable baseline and do not exist in Safari or Firefox.
Calling the method on a browser that lacks it throws a `TypeError` (the method is
`undefined`), and creating the device without the feature makes the call fail
validation. The code breaks for the majority of users.

CORRECT: feature-detect and always provide the loop-of-`drawIndirect` path, which is
correct on every WebGPU 1.0-stable browser:

```js
if (adapter.features.has("chromium-experimental-multi-draw-indirect")) {
  pass.multiDrawIndexedIndirect(indirectBuffer, 0, drawCount);
} else {
  for (let i = 0; i < drawCount; i++) {
    pass.drawIndexedIndirect(indirectBuffer, i * 20);
  }
}
```

## 6. A per-object CPU loop of draw calls instead of instanceCount

WRONG:

```js
for (let i = 0; i < 5000; i++) {
  pass.setBindGroup(0, perObjectBindGroups[i]);
  pass.draw(36, 1, 0, 0); // one object per call
}
```

WHY it fails: 5000 `draw` calls plus 5000 `setBindGroup` calls is heavy CPU-side
command-submission cost; it negates WebGPU's main advantage and causes frame-rate
collapse on large scenes. It also forces one bind group per object.

CORRECT: issue a single instanced draw and read per-instance data from a vertex buffer
with `stepMode: "instance"` or from a storage buffer indexed by
`@builtin(instance_index)`:

```js
pass.setBindGroup(0, sharedBindGroup); // one storage buffer of all transforms
pass.draw(36, 5000, 0, 0);
```

## 7. stepMode "vertex" on a per-instance vertex buffer

WRONG:

```js
// Per-instance model matrix, but stepMode left at the default "vertex".
const layout = {
  arrayStride: 64,
  stepMode: "vertex",   // wrong: advances per vertex
  attributes: [/* mat4x4f */],
};
```

WHY it fails: with `stepMode: "vertex"` the attribute advances once per vertex, so the
shader reads instance 0's data for vertices 0..N, instance 1's data for the next N
vertices, and so on. Every instance ends up identical (all using slot 0), or the buffer
runs out of data and reads garbage.

CORRECT: set `stepMode: "instance"` on any vertex buffer holding per-instance data so
the attribute advances once per instance.

## 8. Reading the GPU-written indirect count back to the CPU each frame

WRONG:

```js
// After the cull pass, copy instanceCount to a staging buffer and await it.
encoder.copyBufferToBuffer(indirectBuffer, 4, stagingBuffer, 0, 4);
device.queue.submit([encoder.finish()]);
await stagingBuffer.mapAsync(GPUMapMode.READ);
const count = new Uint32Array(stagingBuffer.getMappedRange())[0];
// ...then issue a direct draw with that count.
```

WHY it fails: `mapAsync` is asynchronous and forces a full CPU-GPU synchronization. The
CPU stalls until the GPU finishes the cull pass, collapsing frame-pipelining and
tanking frame rate. The whole point of indirect draws is to avoid this round-trip.

CORRECT: the compute pass and the render pass in the SAME `queue.submit` are ordered by
the command encoder. The render pass reads the indirect buffer the compute pass wrote
with no CPU involvement. Use `drawIndexedIndirect` and let the GPU keep the count.

## Verified Sources

- https://www.w3.org/TR/webgpu/ (W3C WebGPU specification)
- https://developer.mozilla.org/en-US/docs/Web/API/GPURenderPassEncoder/drawIndirect
- https://developer.mozilla.org/en-US/docs/Web/API/GPURenderPassEncoder/drawIndexedIndirect
- vooronderzoek-webgpu.md PART C section 3, section 5, section 6
