# Anti-Patterns : Orchestration-Level Mistakes

Baseline: WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

These are SETUP-ORDER and SEQUENCING mistakes. They are not API-detail bugs; each
detailed skill documents its own descriptor-level anti-patterns. This file covers
mistakes in the orchestration: doing steps out of order, skipping steps, or wiring
the pieces together inconsistently.

## 1. Creating resources before negotiating limits and features

WHAT: calling `device.createBuffer` or `device.createTexture` with sizes chosen
without first reading `adapter.limits`, or requesting a feature in `requiredFeatures`
without checking `adapter.features`.

WHY IT FAILS: a device validates every API call against the NEGOTIATED limits, not
the adapter's full limits. A buffer sized above `maxStorageBufferBindingSize` or a
texture above `maxTextureDimension2D` fails validation. Requesting an absent feature
makes `requestDevice()` itself fail, breaking the app on browsers and machines that
lack that feature.

FIX: run setup steps 1 to 3 before step 11. Build `requiredFeatures` with
`adapter.features.has("...")` checks. Build `requiredLimits` from what the app
actually needs, clamped to `adapter.limits`. Route to `webgpu-core-limits-features`.

## 2. Building the pipeline before its bind group layouts

WHAT: calling `device.createRenderPipeline` or `device.createComputePipeline` and
only afterward defining the `GPUBindGroupLayout` objects, or passing a partially
built layout array.

WHY IT FAILS: the dependency chain is fixed. The pipeline consumes a
`GPUPipelineLayout`; the pipeline layout consumes the `GPUBindGroupLayout` array. An
object cannot consume an input that does not yet exist. With `layout: "auto"` the
pipeline does generate implicit layouts, but those are produced AFTER pipeline
creation and are not reusable across pipelines.

FIX: run step 8 (bind group layouts), then step 9 (pipeline layout), then step 10
(pipeline). Route to `webgpu-syntax-bind-groups` and `webgpu-core-pipeline-architecture`.

## 3. Mismatched @binding numbers across WGSL and the bind group layout

WHAT: a WGSL resource declared `@group(0) @binding(2)` with no corresponding
`{ binding: 2 }` entry in the bind group layout, or the numbers shifted by one.

WHY IT FAILS: WebGPU binding is positional, not name-matched. The implementation
matches WGSL `@binding(n)` to the layout entry with the same `binding: n`. A missing
or shifted number means the shader reads an unbound slot, and pipeline creation or
the draw call fails validation with a layout-mismatch error.

FIX: cross-check every WGSL `@group` / `@binding` pair against the layout's
`binding` values before creating the pipeline. Use the bind group consistency
checklist in `methods.md`. Route to `webgpu-syntax-bind-groups`.

## 4. Wrong visibility stage on a bind group layout entry

WHAT: a bind group layout entry with `visibility: GPUShaderStage.VERTEX` for a
uniform that the fragment shader reads, or `GPUShaderStage.FRAGMENT` for a buffer a
compute shader reads.

WHY IT FAILS: `visibility` declares which shader stages may access the binding. If
the stage that actually reads the resource is not in the `visibility` bitmask,
pipeline creation fails because the WGSL declares an access the layout forbids.

FIX: set `visibility` to exactly the stages that declare the matching `var` in WGSL.
Combine stages with `|` when a binding is read by more than one stage. Route to
`webgpu-syntax-bind-groups`.

## 5. Skipping device-loss handling during setup

WHAT: completing steps 1 to 15 with no `device.lost.then(...)` registration, or
registering it after resources are already created.

WHY IT FAILS: `requestDevice()` never rejects for runtime failure; it can resolve to
an already-lost device. Without a `device.lost` handler the app silently runs against
a dead device and renders nothing, with no error surfaced. Registering the handler
late misses any loss that happens during initialization.

FIX: register `device.lost.then(...)` in step 4, immediately after `requestDevice()`
resolves and BEFORE any resource is created. Recovery re-runs steps 1 to 15 against a
NEW device; resources are bound to the device that created them. NEVER write a silent
retry loop; check `info.reason !== "destroyed"` and bound the attempts. Route to
`webgpu-errors-device-loss`.

## 6. Not labeling objects

WHAT: creating buffers, textures, pipelines, bind groups, shader modules, and
encoders with no `label` field.

WHY IT FAILS: `GPUValidationError` and `GPUDeviceLostInfo` messages reference objects
by their `label`. Without labels the implementation can only report "a texture" or
"a buffer", turning a precise validation message into a guessing game across the
whole setup.

FIX: set a meaningful `label` on every descriptor in steps 4 to 15. Route to
`webgpu-errors-debugging`.

## 7. Choosing MAP_READ usage on a buffer that also needs STORAGE

WHAT: `usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.STORAGE` on a buffer intended
to be both a compute storage target and CPU-readable.

WHY IT FAILS: `MAP_READ` is valid ONLY in combination with `COPY_DST`. Adding
`STORAGE` (or `UNIFORM`, or `VERTEX`) to a `MAP_READ` buffer fails buffer-creation
validation. A storage buffer is fundamentally not mappable; the GPU owns it.

FIX: use TWO buffers. The storage buffer is `STORAGE | COPY_SRC`. A separate readback
buffer is `MAP_READ | COPY_DST`. Record `copyBufferToBuffer` from the storage buffer
into the readback buffer, then `mapAsync` the readback buffer. Route to
`webgpu-syntax-buffers` and `webgpu-impl-buffer-upload`.

## 8. Skipping the canvas configuration step for a render app

WHAT: building a render pipeline and calling `context.getCurrentTexture()` without
first calling `context.configure({ device, format })`.

WHY IT FAILS: `getCurrentTexture()` called before `configure()` throws an
`InvalidStateError`. The context must be associated with a device and a format before
it can hand out presentable textures.

FIX: run step 6 (`getContext("webgpu")` then `configure`) before any frame. Use
`navigator.gpu.getPreferredCanvasFormat()` for the `format`. Route to
`webgpu-syntax-canvas-context`.

## 9. Pipeline fragment target format not matching the attachment format

WHAT: `fragment.targets[0].format` set to a hardcoded value (for example
`"bgra8unorm"`) that differs from the actual canvas attachment format.

WHY IT FAILS: the render pipeline's fragment target format MUST equal the format of
the render-pass color attachment it writes to. A mismatch fails pipeline creation or
the render pass. On Safari the preferred format can differ from Chrome, so a
hardcoded format silently breaks cross-browser.

FIX: derive ONE `format` value from `navigator.gpu.getPreferredCanvasFormat()` and
use it for both `context.configure({ format })` and `fragment.targets[].format`.
Route to `webgpu-syntax-render-pipeline` and `webgpu-core-cross-browser`.

## 10. Reading compute output before the GPU finishes

WHAT: calling `mapAsync` on a readback buffer immediately after `queue.submit`,
without first awaiting `queue.onSubmittedWorkDone()`.

WHY IT FAILS: `queue.submit` only schedules work; it does not wait for it.
`copyBufferToBuffer` runs on the GPU timeline. Mapping the readback buffer before
that copy completes reads stale or zero data.

FIX: in a one-shot compute job, `await queue.onSubmittedWorkDone()` before
`mapAsync`. In a per-frame loop, NEVER block; read results one or two frames late via
a rotating staging buffer. Route to `webgpu-impl-async-patterns`.

## 11. Caching getCurrentTexture or reusing a command buffer

WHAT: storing `context.getCurrentTexture()` or its view in a variable that lives
across frames, or calling `queue.submit` twice with the same `GPUCommandBuffer`.

WHY IT FAILS: the swap chain rotates textures every frame; a cached view targets a
texture that is no longer presentable, producing a black canvas or a validation
error. A `GPUCommandBuffer` is single-use; submitting it again fails validation.

FIX: per frame, call `context.getCurrentTexture().createView()` fresh (step 14) and
build a fresh `GPUCommandEncoder` (step 13). Route to `webgpu-syntax-canvas-context`
and `webgpu-syntax-command-encoder`.

## 12. Forgetting pass.end() before encoder.finish()

WHAT: calling `encoder.finish()` while a render pass or compute pass is still open.

WHY IT FAILS: `finish()` throws if the encoder has an unfinished pass. The pass must
be explicitly closed with `pass.end()` before the encoder can produce a command
buffer.

FIX: call `pass.end()` at the close of step 14, before `encoder.finish()` in step 15.
Route to `webgpu-syntax-command-encoder`.

## Orchestration Self-Check

Before declaring a WebGPU setup correct, verify in order:

1. Steps 1 to 4 ran before any resource was created.
2. `device.lost` was registered in step 4, before any resource.
3. Every bind group layout existed before its pipeline layout and pipeline.
4. Every WGSL `@group` / `@binding` matches a layout entry, with the right
   `visibility` and resource kind.
5. Every buffer's usage flags match its role; no `MAP_READ` buffer carries `STORAGE`,
   `UNIFORM`, or `VERTEX`.
6. The render pipeline's fragment target format equals the canvas attachment format.
7. Every descriptor carries a `label`.
8. The per-frame loop builds a fresh encoder and a fresh `getCurrentTexture` view, and
   never awaits `mapAsync` or `onSubmittedWorkDone` inside the loop.
9. A compute readback awaits `onSubmittedWorkDone` before `mapAsync`, and copies data
   out before `unmap()`.
