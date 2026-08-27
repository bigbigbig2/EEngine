# Anti-Patterns: Consolidated WebGPU Catalog

The 18-entry consolidated WebGPU anti-pattern catalog. Each entry gives the
**detection cue** (how a reviewer spots it in code), **why it fails**, the **fix**, and
the **routing target** (the sibling skill with the authoritative fix). Version
baseline: WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

This catalog is the backbone of the `webgpu-agents-quality-validator` review. The top 3
(hallucinated APIs, missing device-loss handling, alignment errors) are summarized
inline in SKILL.md.

---

## AP-01: Hallucinated or invented API

Detection cue: an API name, method, descriptor field, enum value, or WGSL builtin that
is not in the WebGPU 1.0-stable surface. Examples: `device.createBufferSync`,
`adapter.createDevice`, `GPUBuffer.update`, `passEncoder.bindPipeline`,
`encoder.beginPass`, `texture.generateMipmaps`, `const fn` in WGSL, `gl_Position`.

Why it fails: the call references something that does not exist; the code throws a
`TypeError` at runtime or never compiles. Generated code is the highest-risk source of
hallucinated APIs.

Fix: cross-check every API token against the surface in `references/methods.md` Part 2.
Replace with the real API or remove the call.

Routing: cross-check against `references/methods.md` Part 2.

---

## AP-02: Missing device-loss handling

Detection cue: a WebGPU app with no `device.lost.then(...)` attached before resource
creation.

Why it fails: after a GPU process crash, driver update, or hardware removal, the device
becomes silently dead and every subsequent call fails with no clear cause.

Fix: attach a `device.lost` handler that inspects `info.reason` and recreates all
resources when `reason !== "destroyed"`.

Routing: `webgpu-errors-device-loss`.

---

## AP-03: Alignment error

Detection cue: a buffer `size`, `writeBuffer` offset/size, `mapAsync` offset, dynamic
bind-group offset, or `bytesPerRow` that is not the required multiple. The classic case
is a readback buffer sized `width * height * 4` with `bytesPerRow = width * 4` where
`width * 4` is not a multiple of 256.

Why it fails: WebGPU rejects the operation with a validation error. Alignment is the
single largest source of WebGPU validation failures.

Fix: enforce the multiples: size mult-4, `writeBuffer` mult-4, `mapAsync` offset mult-8,
dynamic offset mult-256, `bytesPerRow` mult-256.

Routing: `webgpu-core-memory-model`, `webgpu-impl-buffer-upload`.

---

## AP-04: Caching getCurrentTexture across frames

Detection cue: `context.getCurrentTexture()` or its view is stored once and reused
across frames.

Why it fails: the swap-chain rotates textures each frame; a stale view targets a
texture that is no longer presentable, producing a black canvas or a validation error.

Fix: call `context.getCurrentTexture().createView()` fresh inside the frame loop.

Routing: `webgpu-syntax-canvas-context`, `webgpu-impl-render-targets`.

---

## AP-05: Sampling a texture still bound as an attachment in the same pass

Detection cue: a bind group containing a texture view that is also a color or depth
attachment of the active render pass.

Why it fails: read/write ordering is undefined; WebGPU validation rejects the bind group.

Fix: split into two passes, or ping-pong two textures so the read source and the write
target are never the same texture in one pass.

Routing: `webgpu-impl-multipass`.

---

## AP-06: mapAsync on an already-mapped or pending buffer

Detection cue: `mapAsync` is called on a buffer whose `mapState` is `"mapped"` or
`"pending"`.

Why it fails: WebGPU rejects the second call with a "buffer is already mapped"
validation error.

Fix: only map a buffer when `mapState === "unmapped"`; pair every `mapAsync` with an
`unmap()`.

Routing: `webgpu-syntax-buffers`, `webgpu-impl-async-patterns`.

---

## AP-07: Using a detached ArrayBuffer after unmap

Detection cue: the `ArrayBuffer` returned by `getMappedRange()` is read or written after
`unmap()` has been called.

Why it fails: `unmap()` detaches the `ArrayBuffer`; typed views over it throw
`TypeError`.

Fix: copy the data out of the mapped range before calling `unmap()`.

Routing: `webgpu-syntax-buffers`.

---

## AP-08: Wrong indirect buffer stride

Detection cue: a `drawIndirect` buffer using a 20-byte layout, a `drawIndexedIndirect`
buffer using a 16-byte layout, or uninitialized trailing bytes.

Why it fails: the GPU reads a fixed byte count; wrong stride or garbage produces
out-of-range vertex fetches, corrupt geometry, or a validation error.

Fix: 16 bytes / 4 u32 for `drawIndirect` (`vertexCount, instanceCount, firstVertex,
firstInstance`); 20 bytes / 5 u32 for `drawIndexedIndirect` (`indexCount, instanceCount,
firstIndex, baseVertex, firstInstance`); 12 bytes / 3 u32 for
`dispatchWorkgroupsIndirect`. `indirectOffset` must be a multiple of 4.

Routing: `webgpu-impl-instancing-indirect`.

---

## AP-09: Non-zero firstInstance without indirect-first-instance

Detection cue: an indirect draw buffer carrying a non-zero `firstInstance` while the
device was created without the `indirect-first-instance` feature.

Why it fails: the value is silently forced to a no-op, producing wrong instance
indexing rather than an error.

Fix: request the `indirect-first-instance` feature, or keep `firstInstance` zero and
offset via the buffer binding instead.

Routing: `webgpu-impl-instancing-indirect`, `webgpu-core-limits-features`.

---

## AP-10: Awaiting mapAsync or onSubmittedWorkDone inside the render loop

Detection cue: the per-frame code `await`s `mapAsync` or `queue.onSubmittedWorkDone`.

Why it fails: it forces a full CPU-GPU sync, collapsing frame pipelining and tanking the
frame rate.

Fix: read GPU results one or two frames late through a rotating staging buffer; never
block the frame.

Routing: `webgpu-impl-async-patterns`, `webgpu-impl-performance`.

---

## AP-11: Recreating pipelines or bind groups every frame

Detection cue: `createRenderPipeline`, `createComputePipeline`, or `createBindGroup` is
called inside the frame loop.

Why it fails: these objects are immutable and expensive to build; rebuilding them every
frame wastes CPU time.

Fix: build pipelines and bind groups once at load time and reuse them; use dynamic
offsets for per-object uniform data.

Routing: `webgpu-impl-performance`, `webgpu-core-pipeline-architecture`.

---

## AP-12: Rebuilding render bundles every frame

Detection cue: `createRenderBundleEncoder` plus `finish()` is called inside the frame
loop.

Why it fails: bundle encoding still pays the validation cost; rebuilding each frame
negates the only benefit, which is cheap replay.

Fix: build bundles once for static content and replay them unchanged with
`executeBundles`; drive variation through updated buffers and indirect draws.

Routing: `webgpu-impl-performance`.

---

## AP-13: Silent retry loop on device loss

Detection cue: a `device.lost` handler that immediately calls `requestDevice()` again
without checking `info.reason` or bounding the attempts.

Why it fails: on `reason === "destroyed"` it fights the app's own shutdown; on a
permanent hardware fault it busy-loops forever and hides the root cause.

Fix: recover only when `info.reason !== "destroyed"`, recreate every resource, bound the
attempts, and surface persistent failure to the user.

Routing: `webgpu-errors-device-loss`.

---

## AP-14: Mismatched sampleCount between pipeline and attachments

Detection cue: the render pipeline `multisample.count` does not equal the attachment
texture `sampleCount`, or a `resolveTarget` is not single-sampled.

Why it fails: WebGPU validation rejects the render pass because the multisample state of
the pipeline and the attachments must agree.

Fix: keep `multisample.count` equal to the attachment `sampleCount`; the `resolveTarget`
must have `sampleCount: 1` and a matching format.

Routing: `webgpu-impl-render-targets`.

---

## AP-15: Pipeline fragment.targets not matching colorAttachments

Detection cue: the pipeline `fragment.targets` array and the render-pass
`colorAttachments` array differ in count or in per-index texture format.

Why it fails: for multiple render targets, count and formats must match exactly, or
pipeline creation or the render pass fails validation.

Fix: align the pipeline target list with the render-pass attachment list, format for
format, in the same order.

Routing: `webgpu-syntax-render-pipeline`, `webgpu-impl-render-targets`.

---

## AP-16: Hard-coding the canvas format

Detection cue: `"bgra8unorm"` or `"rgba8unorm"` is written as a literal canvas format
in `context.configure` or `fragment.targets`.

Why it fails: the preferred format is platform-dependent and notably differs on Safari;
a hard-coded format costs a conversion or fails to match.

Fix: always call `navigator.gpu.getPreferredCanvasFormat()` and use that value for both
the context configuration and the pipeline target.

Routing: `webgpu-syntax-canvas-context`, `webgpu-core-cross-browser`.

---

## AP-17: Requesting an optional feature without checking adapter.features

Detection cue: a `GPUFeatureName` string in `requiredFeatures` with no guarding
`adapter.features.has(...)`.

Why it fails: `requestDevice` rejects on a browser whose adapter lacks the feature,
breaking the app on Safari or Firefox even though it works in Chrome.

Fix: feature-detect every optional feature against `adapter.features` and degrade
gracefully when it is absent.

Routing: `webgpu-core-limits-features`, `webgpu-core-cross-browser`.

---

## AP-18: Shipping unlabeled descriptors and ignoring getCompilationInfo

Detection cue: buffers, textures, pipelines, bind groups, or shader modules created with
no `label`, and `createShaderModule` calls with no following `getCompilationInfo()`
check.

Why it fails: WebGPU validation messages reference objects by `label`; without labels a
generic message names "a texture" and diagnosis is guesswork. WGSL errors otherwise
surface only as opaque pipeline-creation failures.

Fix: set a meaningful `label` on every GPU object, and inspect
`shaderModule.getCompilationInfo()` for messages with `type === "error"`.

Routing: `webgpu-errors-debugging`, `webgpu-errors-validation`.

---

## Cross-cutting reviewer notes

- WebGPU errors are contagious: an invalid descriptor poisons every dependent object.
  When the catalog flags several defects in one chain, report the FIRST as the root
  cause and the rest as downstream.
- The catalog covers host-side and WGSL-side defects. WGSL-specific shader-creation
  errors (recursion, missing `switch default:`, missing `@workgroup_size`, missing
  barriers, uniform struct layout) are checked under categories 9 and 10 of the
  `references/methods.md` checklist and route to the `webgpu-wgsl-*` skills.
- Every fix in this catalog routes to exactly one authoritative sibling skill. The
  validator checks and routes; it does not re-teach the API.
