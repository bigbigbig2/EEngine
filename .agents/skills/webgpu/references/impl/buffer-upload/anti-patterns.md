# Anti-Patterns: Buffer Upload and Readback

Mistakes that cause validation errors, corrupt readbacks, or wasted CPU work in
WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). Each entry states the
mistake, WHY it fails, and the correct fix.

## 1. Sizing a readback buffer as width * height * 4

WRONG:

```js
const readback = device.createBuffer({
  size: width * height * 4,                         // tight, NO row padding
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
encoder.copyTextureToBuffer(
  { texture },
  { buffer: readback, bytesPerRow: width * 4 },     // not a multiple of 256
  { width, height },
);
```

WHY IT FAILS: `copyTextureToBuffer` requires `bytesPerRow` to be a multiple of
256. For a 100-pixel-wide RGBA8 texture, `width * 4` is 400, which is not a
multiple of 256, so the copy fails with a `GPUValidationError`. Even when the copy
were accepted, a buffer sized for `width * 4` per row has no room for the padding
the GPU writes between rows.

CORRECT:

```js
const unpaddedBytesPerRow = width * 4;
const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;  // 512 for width 100
const readback = device.createBuffer({
  size: paddedBytesPerRow * height,                 // padded total
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
encoder.copyTextureToBuffer(
  { texture },
  { buffer: readback, bytesPerRow: paddedBytesPerRow, rowsPerImage: height },
  { width, height },
);
```

Then strip the per-row padding on the CPU after mapping (see
`references/examples.md`, Example 5).

## 2. Reading a storage buffer directly

WRONG:

```js
const storageBuffer = device.createBuffer({
  size: 1024,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.MAP_READ,   // illegal combination
});
await storageBuffer.mapAsync(GPUMapMode.READ);
```

WHY IT FAILS: `MAP_READ` may ONLY be combined with `COPY_DST`. Adding `STORAGE`
(or `UNIFORM`, `VERTEX`, `INDEX`, `INDIRECT`, `QUERY_RESOLVE`) makes `createBuffer`
fail validation. A `STORAGE` buffer is GPU-owned and cannot be mapped at all.

CORRECT: copy the storage buffer into a separate `COPY_DST | MAP_READ` staging
buffer, then map that buffer.

```js
const readback = device.createBuffer({
  size: storageBuffer.size,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
const encoder = device.createCommandEncoder();
encoder.copyBufferToBuffer(storageBuffer, 0, readback, 0, storageBuffer.size);
device.queue.submit([encoder.finish()]);
await readback.mapAsync(GPUMapMode.READ);
const result = new Float32Array(readback.getMappedRange()).slice();
readback.unmap();
```

## 3. Mapping a readback buffer before the GPU finished

WRONG:

```js
device.queue.submit([encoder.finish()]);
const range = readback.getMappedRange();            // buffer is not mapped yet
const result = new Float32Array(range);
```

WHY IT FAILS: `submit()` only SCHEDULES the GPU work; it does not wait for it.
`getMappedRange()` throws when the buffer is not in the `"mapped"` state. Skipping
`mapAsync` entirely means the data is never CPU-visible. Even calling
`getMappedRange` after a `mapAsync` whose promise has not yet resolved is wrong:
the buffer is still `"pending"` and the call throws. The `mapAsync` promise is the
exact point at which the GPU has finished writing the buffer; reading earlier
yields stale or undefined data.

CORRECT:

```js
device.queue.submit([encoder.finish()]);
await readback.mapAsync(GPUMapMode.READ);            // wait for the GPU
const result = new Float32Array(readback.getMappedRange()).slice();
readback.unmap();
```

## 4. Building a staging ring where writeBuffer would do

WRONG:

```js
// A 3-buffer ring for an occasional small uniform update.
const ring = [bufA, bufB, bufC];
function updateUniform(data) {
  const staging = ring[frame % 3];
  /* mapAsync, getMappedRange, write, unmap, copyBufferToBuffer, submit, re-map */
}
```

WHY IT FAILS: it does not produce a wrong result, but it is wasted complexity. A
staging ring only pays off for LARGE buffers rewritten EVERY frame, where
`writeBuffer` profiles as a bottleneck. For per-frame uniforms, occasional
updates, or any upload not measured as a bottleneck, the ring adds buffer pool
management, async map bookkeeping, and extra memory for no measurable gain.
`queue.writeBuffer` lets the user agent pick the optimal internal upload path with
a single line.

CORRECT:

```js
function updateUniform(data) {
  device.queue.writeBuffer(uniformBuffer, 0, data);
}
```

Reach for a staging ring ONLY after `writeBuffer` is measured as the bottleneck on
a large per-frame upload.

## 5. Using a mapped range after unmap

WRONG:

```js
await readback.mapAsync(GPUMapMode.READ);
const range = readback.getMappedRange();
readback.unmap();
const result = new Float32Array(range);             // range is detached
console.log(result[0]);                             // throws TypeError
```

WHY IT FAILS: `unmap()` detaches the `ArrayBuffer` returned by `getMappedRange()`.
Any typed view created over it afterward, or any access to a view created before,
throws `TypeError`.

CORRECT: copy the bytes out BEFORE calling `unmap()`.

```js
await readback.mapAsync(GPUMapMode.READ);
const result = new Float32Array(readback.getMappedRange()).slice();  // copy OUT now
readback.unmap();
console.log(result[0]);                             // safe: result is independent
```

## 6. Awaiting mapAsync inside the render loop

WRONG:

```js
function frame() {
  // ... encode and submit render work ...
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();          // full CPU-GPU stall every frame
  requestAnimationFrame(frame);
}
```

WHY IT FAILS: awaiting `onSubmittedWorkDone` or `mapAsync` in the frame path forces
the CPU to wait for the GPU to drain, which collapses frame pipelining and tanks
the frame rate. The CPU and GPU can no longer work on different frames in parallel.

CORRECT: never block the render path. Readback that must run every frame uses a
rotating staging buffer and consumes results one or two frames late, so the
`mapAsync` of frame N is awaited while frame N+1 or N+2 is already rendering.

## Sources

- W3C WebGPU spec : https://www.w3.org/TR/webgpu/
- MDN GPUBuffer.mapAsync : https://developer.mozilla.org/en-US/docs/Web/API/GPUBuffer/mapAsync
- toji.dev WebGPU buffer uploads : https://toji.dev/webgpu-best-practices/buffer-uploads.html
