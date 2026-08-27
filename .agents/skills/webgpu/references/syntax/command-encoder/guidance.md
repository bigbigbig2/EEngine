# WebGPU Command Encoder

Record GPU work into a `GPUCommandEncoder`, encode render or compute passes and
copy commands, finish into a `GPUCommandBuffer`, and submit it to `device.queue`.

## Quick Reference

| Step | Call | Returns |
|------|------|---------|
| Create encoder | `device.createCommandEncoder({ label })` | `GPUCommandEncoder` |
| Start render pass | `encoder.beginRenderPass(descriptor)` | `GPURenderPassEncoder` |
| Start compute pass | `encoder.beginComputePass({ label, timestampWrites })` | `GPUComputePassEncoder` |
| End any pass | `passEncoder.end()` | `undefined` |
| Copy buffer | `encoder.copyBufferToBuffer(...)` | `undefined` |
| Resolve queries | `encoder.resolveQuerySet(...)` | `undefined` |
| Finish recording | `encoder.finish({ label })` | `GPUCommandBuffer` |
| Submit work | `device.queue.submit([commandBuffer])` | `undefined` |
| Await completion | `device.queue.onSubmittedWorkDone()` | `Promise<undefined>` |

| Pass type | Begin method | Encoder type | Records |
|-----------|--------------|--------------|---------|
| Render | `beginRenderPass` | `GPURenderPassEncoder` | draws into color/depth attachments |
| Compute | `beginComputePass` | `GPUComputePassEncoder` | `dispatchWorkgroups` calls |
| (none) | copy/resolve methods | `GPUCommandEncoder` directly | data moves, query resolves |

Runtime model order: create encoder per frame, encode passes and copies, call
`finish()`, then `queue.submit()`. A `GPUCommandBuffer` is single-use.

Version: WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+.

## Decision Tree

```
Need to do GPU work?
├─ Draw geometry into a texture (color/depth attachments)?
│    -> encoder.beginRenderPass(descriptor) -> draw* -> pass.end()
├─ Run a compute shader (dispatchWorkgroups)?
│    -> encoder.beginComputePass({...}) -> dispatchWorkgroups -> pass.end()
├─ Move data between resources, no shader?
│    ├─ buffer -> buffer  -> encoder.copyBufferToBuffer(...)
│    ├─ buffer -> texture  -> encoder.copyBufferToTexture(...)
│    ├─ texture -> buffer  -> encoder.copyTextureToBuffer(...)
│    └─ texture -> texture -> encoder.copyTextureToTexture(...)
└─ Read GPU timing or occlusion counts?
     -> createQuerySet -> timestampWrites on a pass -> resolveQuerySet -> copy to MAP_READ buffer
```

Copy methods are recorded directly on the `GPUCommandEncoder`, NEVER inside an
open pass. A pass MUST be ended with `pass.end()` before any encoder-level call.

## Core Patterns

### Pattern 1: One encoder per frame, never reuse a command buffer

ALWAYS create a fresh `GPUCommandEncoder` and a fresh `GPUCommandBuffer` for each
frame. NEVER call `queue.submit` twice with the same command buffer.

```js
function frame() {
  const encoder = device.createCommandEncoder({ label: "frame-encoder" });
  // ... encode passes ...
  const commandBuffer = encoder.finish();
  device.queue.submit([commandBuffer]); // commandBuffer is now consumed
  requestAnimationFrame(frame);
}
```

### Pattern 2: Always end a pass before finishing the encoder

ALWAYS call `passEncoder.end()` before `encoder.finish()`. An encoder with an
open pass throws on `finish()`.

```js
const pass = encoder.beginRenderPass(renderPassDescriptor);
pass.setPipeline(pipeline);
pass.draw(3);
pass.end();              // mandatory before finish()
const cb = encoder.finish();
```

### Pattern 3: Copy commands sit outside passes

ALWAYS record `copyBufferToBuffer` and the other copy methods directly on the
encoder, NEVER between `beginRenderPass` and `pass.end()`.

```js
const pass = encoder.beginComputePass();
pass.setPipeline(computePipeline);
pass.setBindGroup(0, bindGroup);
pass.dispatchWorkgroups(64);
pass.end();                                       // pass closed first
encoder.copyBufferToBuffer(storageBuffer, readbackBuffer); // then the copy
```

### Pattern 4: Await GPU completion with onSubmittedWorkDone

ALWAYS use `queue.onSubmittedWorkDone()` to know when submitted work finished.
NEVER `await` it inside the render loop because it forces a CPU-GPU stall.

```js
device.queue.submit([encoder.finish()]);
await device.queue.onSubmittedWorkDone(); // safe at load time, NOT per frame
await readbackBuffer.mapAsync(GPUMapMode.READ);
```

### Pattern 5: Buffer copies obey the 4-byte alignment rule

ALWAYS keep `sourceOffset`, `destinationOffset`, and `size` as multiples of 4 in
`copyBufferToBuffer`. The source needs `COPY_SRC`, the destination needs `COPY_DST`.
For buffer-texture copies `bytesPerRow` MUST be a multiple of 256 (see
`webgpu-core-memory-model`).

```js
encoder.copyBufferToBuffer(src, 0, dst, 0, 1024); // all multiples of 4
```

### Pattern 6: Timestamp queries are a gated optional feature

ALWAYS request the `timestamp-query` feature before using `timestampWrites` or a
`"timestamp"` query set. NEVER assume the feature exists.

```js
const device = await adapter.requestDevice({
  requiredFeatures: adapter.features.has("timestamp-query")
    ? ["timestamp-query"]
    : [],
});
```

## Common Anti-Patterns

1. **Calling `encoder.finish()` with an open pass.** Forgetting `passEncoder.end()`
   leaves the pass open; `finish()` then throws. Fix: call `pass.end()` on every
   pass before `finish()`.

2. **Reusing a `GPUCommandBuffer` after submission.** A command buffer is consumed
   by `queue.submit`; submitting it again is a validation error. Fix: create a
   fresh encoder and buffer for every frame and every submit.

3. **Using `timestampWrites` without the `timestamp-query` feature.** Creating a
   `"timestamp"` query set or passing `timestampWrites` without the feature fails
   validation. Fix: feature-detect on the adapter and gate the code.

See `anti-patterns.md` for the full list with WHY explanations.

## Critical Warnings

- NEVER call `encoder.finish()` while any pass started on that encoder is still open.
- NEVER call `queue.submit` with a command buffer that was already submitted.
- NEVER record any command into an encoder after `finish()` has been called on it.
- NEVER record copy or resolve commands inside an open render or compute pass.
- NEVER `await` `onSubmittedWorkDone()` or `mapAsync()` inside the per-frame render loop.
- NEVER create a `"timestamp"` query set without the `timestamp-query` device feature.
- NEVER pass a `destinationOffset` to `resolveQuerySet` that is not a multiple of 256.

## Reference Files

- `methods.md` : full signatures for `createCommandEncoder`,
  `GPURenderPassDescriptor`, `GPUComputePassDescriptor`, all copy methods,
  `finish`, `queue.submit`, `onSubmittedWorkDone`, `createQuerySet`,
  `resolveQuerySet`, and debug group methods.
- `examples.md` : verified render pass, compute pass,
  buffer-to-buffer copy, and timestamp query examples.
- `anti-patterns.md` : mistakes with WHY-it-fails explanations.

Related skills: `webgpu-core-memory-model` (alignment, `bytesPerRow` 256 rule),
`webgpu-impl-render-targets` (color and depth attachment detail),
`webgpu-syntax-compute-pipeline` (compute pipeline and `dispatchWorkgroups`),
`webgpu-impl-performance` (timestamp profiling, render bundles, submit batching).
