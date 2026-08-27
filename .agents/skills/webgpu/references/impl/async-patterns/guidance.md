# WebGPU Async Patterns

WebGPU is asynchronous by design: the GPU runs on its own timeline while JavaScript runs
on the content timeline. This skill structures the frame loop, maps buffers safely, and
loads pipelines without blocking on WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## Quick Reference

| API | Returns | Timeline | Use for |
|-----|---------|----------|---------|
| `buffer.mapAsync(mode, offset, size)` | `Promise<undefined>` | resolves when buffer is CPU-owned | CPU access to a `MAP_READ`/`MAP_WRITE` buffer |
| `buffer.mapState` | `"unmapped"` / `"pending"` / `"mapped"` | read synchronously | guard before calling `mapAsync` |
| `buffer.getMappedRange(offset, size)` | `ArrayBuffer` | valid only while `mapped` | read or write the mapped bytes |
| `buffer.unmap()` | `undefined` | returns buffer to `"unmapped"` | release the buffer back to the GPU |
| `queue.onSubmittedWorkDone()` | `Promise<undefined>` | resolves after submitted work completes | one-time GPU completion checkpoint |
| `device.createRenderPipelineAsync(desc)` | `Promise<GPURenderPipeline>` | compiles off the content timeline | load-time pipeline creation |
| `device.createComputePipelineAsync(desc)` | `Promise<GPUComputePipeline>` | compiles off the content timeline | load-time pipeline creation |
| `requestAnimationFrame(cb)` | frame handle | content timeline | the per-frame render driver |

Alignment for `mapAsync` and `getMappedRange`: `offset` MUST be a multiple of 8, `size`
MUST be a multiple of 4.

Promise ordering: `mapAsync` and `onSubmittedWorkDone` promises settle in submission order.

## Decision Tree

```
Creating a pipeline?
├── At app load / level load, no frame is rendering yet
│     -> ALWAYS createRenderPipelineAsync / createComputePipelineAsync.
│        await it before the first frame. Compilation runs off the content
│        timeline, so no shader-compilation hitch.
└── Already inside the frame loop and need a pipeline RIGHT NOW
      -> This is the anti-pattern. NEVER create pipelines per frame.
         Pre-create every pipeline at load time. See webgpu-impl-performance.

Reading GPU data back to the CPU?
├── One-off readback (screenshot, test, debug), no frame loop running
│     -> await queue.onSubmittedWorkDone(), then await stagingBuffer.mapAsync(READ).
│        A stall here is acceptable because no frame is in flight.
└── Continuous readback inside the render loop (picking, histogram, stats)
      -> NEVER await mapAsync or onSubmittedWorkDone in the render path.
         Use a rotating staging buffer; read results one or two frames late.
         See Pattern 4 and examples.md.

Where to await?
├── Initialization (adapter, device, pipelines, initial uploads) -> await freely.
└── Inside requestAnimationFrame -> NEVER await GPU completion. Encode and submit
      only. Let the GPU run ahead.
```

## Core Patterns

### Pattern 1: The requestAnimationFrame frame loop

ALWAYS drive rendering with `requestAnimationFrame`. Each frame: update uniforms via
`queue.writeBuffer`, create a FRESH `GPUCommandEncoder`, encode the pass, call
`queue.submit`. NEVER await GPU completion inside the callback.

```js
function frame() {
  // 1. Update CPU-side state, push uniforms.
  queue.writeBuffer(uniformBuffer, 0, uniformData);

  // 2. Fresh encoder every frame. Command buffers are single-use.
  const encoder = device.createCommandEncoder({ label: "frame-encoder" });
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(), // fresh view per frame
      loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();

  // 3. Submit. Do NOT await anything here.
  queue.submit([encoder.finish()]);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

NEVER cache `getCurrentTexture()` or its view across frames: the swap-chain rotates
textures. See webgpu-core-pipeline-architecture for pipeline reuse.

### Pattern 2: The mapAsync map-state lifecycle

A `GPUBuffer` moves through three states exposed by `buffer.mapState`:
`"unmapped"` (GPU-owned) -> `"pending"` (after `mapAsync`, before resolve) ->
`"mapped"` (CPU-owned). ALWAYS map only when `mapState === "unmapped"`.

```js
if (buffer.mapState !== "unmapped") return; // already pending or mapped
await buffer.mapAsync(GPUMapMode.READ);     // offset multiple of 8, size multiple of 4
const data = new Float32Array(buffer.getMappedRange().slice(0)); // copy out NOW
buffer.unmap();                              // ArrayBuffer is now detached
```

ALWAYS copy data out of `getMappedRange()` before calling `unmap()`. After `unmap()` the
`ArrayBuffer` is detached and any typed view over it throws `TypeError`.

### Pattern 3: Async pipeline creation at load time

ALWAYS use `createRenderPipelineAsync` / `createComputePipelineAsync` during loading.
They compile shaders off the content timeline, so no compilation hitch reaches a frame.

```js
const [opaquePipeline, shadowPipeline] = await Promise.all([
  device.createRenderPipelineAsync(opaqueDesc),
  device.createRenderPipelineAsync(shadowDesc),
]);
// Only start the frame loop after every pipeline resolves.
requestAnimationFrame(frame);
```

The synchronous `createRenderPipeline` is correct ONLY before the frame loop starts and
for a small number of pipelines. NEVER call it for many heavy shaders during a frame.

### Pattern 4: Non-blocking readback with a rotating staging buffer

For continuous GPU-to-CPU readback, ALWAYS use a ring of staging buffers and read each
result one or two frames late. NEVER await `mapAsync` inside the frame.

```js
const RING = 3;
const staging = Array.from({ length: RING }, (_, i) =>
  device.createBuffer({ label: `readback-${i}`, size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
let frameIndex = 0;

function frame() {
  const writeBuf = staging[frameIndex % RING];
  if (writeBuf.mapState === "unmapped") {
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(gpuResult, 0, writeBuf, 0, 256);
    queue.submit([encoder.finish()]);
    // Fire-and-forget map. The promise resolves on a LATER frame.
    writeBuf.mapAsync(GPUMapMode.READ).then(() => {
      const data = new Float32Array(writeBuf.getMappedRange().slice(0));
      writeBuf.unmap();
      consumeReadback(data);
    });
  }
  frameIndex++;
  requestAnimationFrame(frame);
}
```

### Pattern 5: onSubmittedWorkDone as a one-time checkpoint

`queue.onSubmittedWorkDone()` resolves after all previously submitted work completes.
Use it ONLY outside the render loop: a one-off screenshot, a test, or a clean shutdown.

```js
queue.submit([encoder.finish()]);
await queue.onSubmittedWorkDone(); // GPU has finished. Acceptable stall: no frame in flight.
await stagingBuffer.mapAsync(GPUMapMode.READ);
```

NEVER place `await queue.onSubmittedWorkDone()` in a `requestAnimationFrame` callback.

### Pattern 6: Synchronous mapSync in workers (experimental)

Chrome 145 (Jan 2026) adds experimental synchronous `buffer.mapSync()` for Web Workers
behind `--enable-features=WebGPUMapSyncOnWorkers`. It is NOT in the WebGPU 1.0-stable
spec and is unavailable on the main thread, in Safari, and in Firefox. ALWAYS feature-gate
it (`typeof buffer.mapSync === "function"`) and keep `mapAsync` as the only path on
1.0-stable.

## Common Anti-Patterns

1. **Awaiting `mapAsync` or `onSubmittedWorkDone` inside the render loop.** This forces a
   full CPU-GPU synchronization: the CPU idles until the GPU drains every submitted
   command, so the two timelines can no longer overlap and frame rate collapses. Fix: use
   a rotating staging buffer (Pattern 4) and read results one or two frames late.

2. **Calling `mapAsync` on an already-mapped or pending buffer.** WebGPU rejects the
   second call with a `"buffer is already mapped"` validation error, because a buffer can
   only be re-mapped after `unmap()` returns it to `"unmapped"`. Fix: guard with
   `buffer.mapState === "unmapped"` and strictly pair every `mapAsync` with `unmap`.

3. **Using a detached `ArrayBuffer` after `unmap()`.** `unmap()` detaches the buffer
   returned by `getMappedRange()`; any typed view over it then throws `TypeError`. Fix:
   copy the data out (`.slice(0)`) before `unmap()`.

## Critical Warnings

- NEVER `await` `mapAsync` or `onSubmittedWorkDone` inside a `requestAnimationFrame`
  callback. It collapses frame pipelining.
- NEVER call `mapAsync` unless `buffer.mapState === "unmapped"`.
- NEVER read or write a `getMappedRange()` `ArrayBuffer` after `unmap()`; it is detached.
- NEVER reuse a `GPUCommandEncoder` or `GPUCommandBuffer` across frames; both are
  single-use. Create a fresh encoder every frame.
- NEVER recreate pipelines per frame; pre-create them with the async variants at load
  time. See webgpu-impl-performance.
- ALWAYS keep `mapAsync` `offset` a multiple of 8 and `size` a multiple of 4.
- ALWAYS feature-gate `mapSync`; it is experimental and absent on 1.0-stable.

## Reference Files

- `methods.md` : `mapAsync` and `mapState` lifecycle, `onSubmittedWorkDone`,
  `createRenderPipelineAsync`, and the frame-loop anatomy.
- `examples.md` : working verified code for a `requestAnimationFrame` render
  loop, async pipeline loading, and non-blocking readback.
- `anti-patterns.md` : async mistakes with WHY-it-fails explanations.

Related skills: webgpu-syntax-buffers (buffer creation and usage flags),
webgpu-impl-buffer-upload (CPU-to-GPU upload strategies), webgpu-impl-performance
(pipeline reuse, staging rings, bundle caching), webgpu-core-pipeline-architecture
(pipeline objects and the timeline model).
