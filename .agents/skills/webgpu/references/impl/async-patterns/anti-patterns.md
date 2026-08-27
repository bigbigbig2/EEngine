# Async Anti-Patterns

Each entry states the mistake, WHY it fails, and the fix. WebGPU 1.0-stable
(Chrome 113+, Safari 26+, Firefox 141+).

## 1. Awaiting mapAsync inside the render loop

```js
// WRONG
async function frame() {
  encoder.copyBufferToBuffer(gpuResult, 0, staging, 0, size);
  queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ); // STALL
  const data = staging.getMappedRange();
  staging.unmap();
  requestAnimationFrame(frame);
}
```

WHY it fails: `mapAsync` resolves only after the GPU finishes every command submitted
before it. Awaiting it inside the frame callback parks the content timeline until the
queue timeline drains. The two timelines can no longer overlap, so the CPU sits idle
during GPU work and the GPU sits idle during CPU work. Frame pipelining collapses and
frame rate drops, often by half or more.

Fix: use a rotating staging buffer and a fire-and-forget `mapAsync` whose `.then`
resolves a frame or two later. See `examples.md` Example 5.

## 2. Awaiting onSubmittedWorkDone inside the render loop

```js
// WRONG
function frame() {
  queue.submit([encoder.finish()]);
  queue.onSubmittedWorkDone().then(() => requestAnimationFrame(frame)); // STALL
}
```

WHY it fails: `onSubmittedWorkDone` resolves only after the GPU completes all submitted
work. Gating the next `requestAnimationFrame` on it makes every frame wait for the GPU to
fully drain before the CPU may build the next frame. The GPU can never run ahead, which
is exactly the pipelining the API is built to allow.

Fix: call `requestAnimationFrame(frame)` unconditionally right after `queue.submit`. Use
`onSubmittedWorkDone` ONLY outside the loop, for a one-off readback or a clean shutdown.

## 3. Calling mapAsync on an already-mapped or pending buffer

```js
// WRONG
staging.mapAsync(GPUMapMode.READ).then(...); // call 1
staging.mapAsync(GPUMapMode.READ).then(...); // call 2: buffer is "pending"
```

WHY it fails: a buffer can only be mapped when `mapState === "unmapped"`. The second
`mapAsync` runs while the buffer is `"pending"` (or `"mapped"`), and WebGPU rejects it
with a `"buffer is already mapped"` validation error. A common shape is a per-frame
readback that re-maps a slot before its previous `mapAsync`/`unmap` cycle finished.

Fix: guard every `mapAsync` with `if (buffer.mapState === "unmapped")` and strictly pair
each `mapAsync` with exactly one `unmap`. Use a ring of staging buffers so a slot is
never re-mapped before it has been unmapped.

## 4. Using a detached ArrayBuffer after unmap()

```js
// WRONG
const view = new Float32Array(staging.getMappedRange());
staging.unmap();
console.log(view[0]); // TypeError: detached ArrayBuffer
```

WHY it fails: `unmap()` detaches every `ArrayBuffer` returned by `getMappedRange()`. A
typed view over a detached `ArrayBuffer` has zero length and any access throws
`TypeError`. The bytes belong to the GPU again the instant `unmap()` returns.

Fix: copy the data out before `unmap()`. `new Float32Array(getMappedRange().slice(0))`
makes a detached-safe copy; then call `unmap()` and use the copy.

## 5. Creating pipelines per frame instead of recreating the encoder

```js
// WRONG
function frame() {
  const pipeline = device.createRenderPipeline(desc); // recompiles every frame
  const encoder = device.createCommandEncoder();      // this part is correct
  // ...
}
```

WHY it fails: recreating the `GPUCommandEncoder` every frame is correct and required,
because encoders and command buffers are single-use. Recreating the *pipeline* every
frame is not: pipelines are immutable and expensive to assemble, and synchronous
`createRenderPipeline` compiles the shader on the content timeline, producing a
per-frame compilation hitch.

Fix: create every pipeline once at load time with `createRenderPipelineAsync` and
`await` it before the first frame. Recreate only the encoder per frame. See
webgpu-impl-performance and webgpu-core-pipeline-architecture.

## 6. Synchronous createRenderPipeline for many shaders during loading

```js
// WRONG
for (const desc of allMaterialDescriptors) {
  pipelines.push(device.createRenderPipeline(desc)); // blocks per shader
}
```

WHY it fails: synchronous `createRenderPipeline` compiles the shader on the content
timeline and returns only when compilation finishes. A loop over many heavy shaders
freezes the page for the whole batch, and if it runs after the loop has started it
produces a visible stall.

Fix: map the descriptors to `createRenderPipelineAsync` and `await Promise.all(...)`.
Compilation runs off the content timeline and all shaders compile concurrently.

## 7. Mapping a compute-output buffer in the same frame without ordering

```js
// WRONG
queue.submit([computeEncoder.finish()]);
await resultBuffer.mapAsync(GPUMapMode.READ); // reads before GPU finished? (storage buffer cannot map anyway)
```

WHY it fails: a `STORAGE` buffer cannot be mapped at all; it must first be copied into a
separate `COPY_DST | MAP_READ` staging buffer. Even with a correct staging buffer,
mapping it the same frame the compute pass was submitted forces a GPU stall, because the
`mapAsync` promise resolves only after the compute work completes on the GPU.

Fix: copy the compute result into a staging buffer, then either read it one or two frames
late through a rotating ring (continuous case), or `await queue.onSubmittedWorkDone()`
before `mapAsync` outside the loop (one-off case). See webgpu-impl-buffer-upload.

## 8. Relying on experimental mapSync as the readback path

```js
// WRONG (on 1.0-stable)
const data = staging.mapSync(GPUMapMode.READ); // not in 1.0-stable
```

WHY it fails: synchronous `buffer.mapSync()` is a Chrome 145 experimental feature for Web
Workers, gated behind `--enable-features=WebGPUMapSyncOnWorkers`. It is not part of the
WebGPU 1.0-stable specification, is unavailable on the main thread, and is absent in
Safari and Firefox. Code that depends on it breaks on every conforming 1.0-stable engine.

Fix: use `mapAsync` as the only readback path on 1.0-stable. If `mapSync` is used at all,
feature-gate it with `typeof buffer.mapSync === "function"` and keep `mapAsync` as the
required fallback path.

## Verified sources

- https://www.w3.org/TR/webgpu/#buffer-mapping
- https://www.w3.org/TR/webgpu/#gpuqueue
- https://developer.mozilla.org/en-US/docs/Web/API/GPUBuffer/mapAsync
- https://gpuweb.github.io/gpuweb/explainer/
