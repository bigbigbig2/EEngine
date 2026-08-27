# Command Encoder Anti-Patterns

Each entry states the mistake, WHY it fails, and the fix. Verified against the
W3C WebGPU specification and MDN. Version baseline: WebGPU 1.0-stable.

## 1. Calling encoder.finish() with an open pass

```js
const encoder = device.createCommandEncoder();
const pass = encoder.beginRenderPass(descriptor);
pass.draw(3);
const cb = encoder.finish(); // WRONG: pass was never ended
```

WHY it fails: a `GPUCommandEncoder` is locked while a pass is open. `finish()`
requires every pass started on the encoder to be closed. An open pass makes
`finish()` throw and produces no command buffer.

Fix: call `pass.end()` on every render and compute pass before `finish()`.

```js
pass.draw(3);
pass.end();             // close the pass
const cb = encoder.finish();
```

## 2. Reusing a GPUCommandBuffer after submission

```js
const cb = encoder.finish();
device.queue.submit([cb]);
device.queue.submit([cb]); // WRONG: cb was already consumed
```

WHY it fails: a `GPUCommandBuffer` is single-use. `queue.submit` consumes it.
Submitting the same buffer twice is a validation error. The same applies to
recording one encoder once and replaying its buffer every frame.

Fix: create a fresh `GPUCommandEncoder` and a fresh `GPUCommandBuffer` for every
frame and every submit. For repeatable command sequences use a `GPURenderBundle`
(see `webgpu-impl-performance`), not buffer reuse.

```js
function frame() {
  const encoder = device.createCommandEncoder({ label: "frame" });
  // ... encode ...
  device.queue.submit([encoder.finish()]); // new buffer each frame
  requestAnimationFrame(frame);
}
```

## 3. Using timestamp queries without the timestamp-query feature

```js
const device = await adapter.requestDevice(); // no requiredFeatures
const querySet = device.createQuerySet({ type: "timestamp", count: 2 }); // WRONG
```

WHY it fails: `"timestamp"` query sets and the `timestampWrites` pass field both
require the optional `timestamp-query` feature. Without it, `createQuerySet`
produces an invalid query set and `timestampWrites` fails pass validation. Safari
and Firefox often do not expose this feature even when Chrome does.

Fix: feature-detect on the adapter and gate every timestamp code path.

```js
const canTimestamp = adapter.features.has("timestamp-query");
const device = await adapter.requestDevice({
  requiredFeatures: canTimestamp ? ["timestamp-query"] : [],
});
if (canTimestamp) {
  const querySet = device.createQuerySet({ type: "timestamp", count: 2 });
  // ...
}
```

## 4. Recording into an already-finished encoder

```js
const encoder = device.createCommandEncoder();
const cb = encoder.finish();
encoder.copyBufferToBuffer(src, dst); // WRONG: encoder is locked after finish()
```

WHY it fails: `finish()` permanently locks the encoder. Every command method
called afterwards is invalid. The encoder is a one-shot recorder; it cannot be
reset or reused.

Fix: record all commands before `finish()`. If more work is needed after a
submit, create a new encoder.

```js
const encoder = device.createCommandEncoder();
encoder.copyBufferToBuffer(src, dst); // record first
const cb = encoder.finish();          // then finish
device.queue.submit([cb]);
```

## 5. Recording copy or resolve commands inside an open pass

```js
const pass = encoder.beginRenderPass(descriptor);
encoder.copyBufferToBuffer(src, dst); // WRONG: pass is still open
pass.end();
```

WHY it fails: while a pass is open the encoder only accepts pass-level commands.
Copy methods (`copyBufferToBuffer`, `copyBufferToTexture`, etc.) and
`resolveQuerySet` are encoder-level commands. Calling them with an open pass is a
validation error.

Fix: end the pass first, then record the copy or resolve.

```js
const pass = encoder.beginRenderPass(descriptor);
// ... draws ...
pass.end();
encoder.copyBufferToBuffer(src, dst); // now valid
```

## 6. Awaiting onSubmittedWorkDone inside the render loop

```js
function frame() {
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone(); // WRONG inside the frame loop
  requestAnimationFrame(frame);
}
```

WHY it fails: `onSubmittedWorkDone()` resolves only after the GPU finishes the
submitted work. Awaiting it per frame forces the CPU to wait for the GPU,
collapsing CPU-GPU pipelining and tanking the frame rate.

Fix: use `onSubmittedWorkDone()` at load time or for one-off readback. For
per-frame readback, copy results into a rotating staging buffer and read them one
or two frames late without blocking the frame.

## 7. Unbalanced debug groups

```js
encoder.pushDebugGroup("phase-a");
const cb = encoder.finish(); // WRONG: popDebugGroup was never called
```

WHY it fails: `pushDebugGroup` and `popDebugGroup` form a stack. `finish()`
requires the stack to be empty. An unmatched push leaves an open group and
`finish()` throws.

Fix: pair every `pushDebugGroup` with a `popDebugGroup` on the same encoder
before `finish()`.

## 8. Misaligned offsets in copies and query resolves

```js
encoder.copyBufferToBuffer(src, 2, dst, 0, 100); // WRONG: 2 is not a multiple of 4
encoder.resolveQuerySet(querySet, 0, 2, resolveBuffer, 64); // WRONG: 64 not 256-aligned
```

WHY it fails: `copyBufferToBuffer` requires `sourceOffset`, `destinationOffset`,
and `size` to each be a multiple of 4. `resolveQuerySet` requires
`destinationOffset` to be a multiple of 256. A misaligned value is a validation
error. For buffer-texture copies, `bytesPerRow` must be a multiple of 256.

Fix: keep copy offsets and sizes at multiples of 4, keep `resolveQuerySet`
destination offsets at multiples of 256, and round `bytesPerRow` up to the next
256-byte multiple (see `webgpu-core-memory-model`).

## 9. Mapping a QUERY_RESOLVE buffer directly

```js
const resolveBuffer = device.createBuffer({
  size: 16,
  usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.MAP_READ, // WRONG combination
});
```

WHY it fails: `MAP_READ` may only be combined with `COPY_DST`. Combining it with
`QUERY_RESOLVE` fails buffer-creation validation, so timestamp results cannot be
mapped from the resolve buffer directly.

Fix: resolve into a `QUERY_RESOLVE | COPY_SRC` buffer, then `copyBufferToBuffer`
into a separate `COPY_DST | MAP_READ` buffer and map that one. See Example 4 in
`references/examples.md`.
