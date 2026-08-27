# Async Methods Reference

WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). Every API name and rule below
is verified against the W3C WebGPU specification, MDN, and the gpuweb explainer.

## The timeline model

WebGPU has two timelines:

- **Content timeline**: JavaScript execution. `requestAnimationFrame` callbacks, encoder
  recording, and `queue.submit` run here.
- **Queue timeline (GPU timeline)**: the GPU executes submitted command buffers here, on
  its own schedule, running ahead of or behind the content timeline.

Async APIs bridge the two. A promise from `mapAsync` or `onSubmittedWorkDone` resolves on
the content timeline once the queue timeline reaches the matching point. `await`-ing such
a promise inside the frame path forces the content timeline to wait for the queue
timeline, removing the overlap that keeps both busy. That overlap is "frame pipelining";
losing it is a "GPU stall".

## buffer.mapAsync(mode, offset, size)

Signature: `mapAsync(mode, offset = 0, size?)` returns `Promise<undefined>`.

- `mode` is `GPUMapMode.READ` or `GPUMapMode.WRITE`. `READ` requires the buffer was
  created with `GPUBufferUsage.MAP_READ`; `WRITE` requires `GPUBufferUsage.MAP_WRITE`.
- `offset` MUST be a multiple of **8**. Defaults to 0.
- `size` MUST be a multiple of **4**. Defaults to the buffer size minus `offset`.
- The promise resolves once the buffer is CPU-owned. It rejects if the buffer is already
  mapped or pending, if the device is lost, or if the buffer is destroyed.

`MAP_READ` may only be combined with `COPY_DST`; `MAP_WRITE` may only be combined with
`COPY_SRC`. Mixing `MAP_*` with `STORAGE`/`UNIFORM`/`VERTEX` fails buffer creation
validation. See webgpu-syntax-buffers.

## buffer.mapState lifecycle

`buffer.mapState` is a synchronously-readable property with three values:

| State | Meaning | Legal next action |
|-------|---------|-------------------|
| `"unmapped"` | GPU-owned (initial state) | call `mapAsync` |
| `"pending"` | `mapAsync` was called, promise not yet resolved | wait for the promise |
| `"mapped"` | CPU-owned, GPU commands on the buffer are forbidden | call `getMappedRange`, then `unmap` |

Lifecycle: `"unmapped"` -> `mapAsync()` -> `"pending"` -> promise resolves -> `"mapped"`
-> `unmap()` -> `"unmapped"`.

ALWAYS check `mapState === "unmapped"` before calling `mapAsync`. Calling it in any other
state produces a `"buffer is already mapped"` validation error.

A buffer created with `mappedAtCreation: true` starts in `"mapped"` state and skips the
`mapAsync` step for the initial upload; its `size` MUST be a multiple of 4.

## buffer.getMappedRange(offset, size) and buffer.unmap()

- `getMappedRange(offset = 0, size?)` returns an `ArrayBuffer` covering the mapped
  region. It is callable ONLY while `mapState === "mapped"`. `offset` MUST be a multiple
  of 8 and `size` a multiple of 4, matching the `mapAsync` request.
- `unmap()` returns the buffer to `"unmapped"` and **detaches** every `ArrayBuffer`
  returned by `getMappedRange()`. After `unmap()`, reading or writing through any typed
  view of that `ArrayBuffer` throws `TypeError`.

ALWAYS copy data out of the mapped range (for example with `.slice(0)`) before `unmap()`.

## queue.onSubmittedWorkDone()

Signature: `onSubmittedWorkDone()` returns `Promise<undefined>`.

- The promise resolves after all work submitted to the queue *before this call* finishes
  on the GPU. It does not cover work submitted afterward.
- It never rejects for normal completion. It carries no value; it is a pure checkpoint.
- Promises from `onSubmittedWorkDone` and `mapAsync` settle in submission order: a promise
  for earlier-submitted work resolves no later than one for later-submitted work.

Use `onSubmittedWorkDone` ONLY outside the render loop: a one-off readback, a test
assertion, or a clean shutdown. Inside `requestAnimationFrame` it forces a GPU stall.

For continuous in-loop readback, you do not need `onSubmittedWorkDone` at all: a
fire-and-forget `mapAsync` on a rotating staging buffer already resolves only after the
copy completes on the GPU.

## device.createRenderPipelineAsync / createComputePipelineAsync

- `createRenderPipelineAsync(descriptor)` returns `Promise<GPURenderPipeline>`.
- `createComputePipelineAsync(descriptor)` returns `Promise<GPUComputePipeline>`.
- Both take the same descriptor as their synchronous counterparts.
- Shader compilation and pipeline assembly happen off the content timeline, so awaiting
  them does not block frame rendering when done before the loop starts.
- The promise rejects with a `GPUPipelineError` if pipeline creation fails (for example
  an invalid shader or a layout mismatch).

The synchronous `createRenderPipeline` / `createComputePipeline` block the content
timeline while the shader compiles. That is acceptable ONLY before the frame loop starts
and for a small number of pipelines. Calling synchronous creation for many heavy shaders
mid-frame produces visible jank.

ALWAYS create every pipeline at load time with the async variants and `await` them with
`Promise.all` before the first `requestAnimationFrame`. Pipelines are immutable and
reusable; see webgpu-core-pipeline-architecture and webgpu-impl-performance.

## The frame loop anatomy

A WebGPU frame, driven by `requestAnimationFrame`, has four steps on the content
timeline:

1. **Update**: advance CPU-side state and push changed uniforms with
   `queue.writeBuffer(buffer, offset, data)`. `offset` and the data length MUST be
   multiples of 4. See webgpu-impl-buffer-upload.
2. **Encode**: create a FRESH `GPUCommandEncoder` (`device.createCommandEncoder()`),
   begin a render or compute pass, set the pre-created pipeline and bind groups, issue
   draws/dispatches, and call `pass.end()`.
3. **Submit**: `queue.submit([encoder.finish()])`. `encoder.finish()` yields a
   single-use `GPUCommandBuffer`.
4. **Reschedule**: call `requestAnimationFrame(frame)` again.

Rules:

- Create a new encoder every frame. `GPUCommandEncoder` and `GPUCommandBuffer` are
  single-use; reusing either across frames fails validation.
- Obtain `context.getCurrentTexture()` and `.createView()` fresh every frame. The
  swap-chain rotates textures; a cached view targets a stale texture.
- NEVER `await` GPU completion (`mapAsync`, `onSubmittedWorkDone`) inside the callback.
  Encode, submit, and return so the GPU can run ahead of the next content-timeline frame.
- Recreating the command encoder per frame is correct and required. Recreating pipelines
  or bind groups per frame is the anti-pattern; build those once at load time.

## Verified sources

- https://www.w3.org/TR/webgpu/#buffer-mapping
- https://www.w3.org/TR/webgpu/#gpuqueue
- https://developer.mozilla.org/en-US/docs/Web/API/GPUBuffer/mapAsync
- https://gpuweb.github.io/gpuweb/explainer/
