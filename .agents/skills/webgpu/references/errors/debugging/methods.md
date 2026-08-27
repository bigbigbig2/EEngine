# WebGPU Debugging: Methods Reference

API surface and tooling for debugging WebGPU. Applies to WebGPU 1.0-stable (Chrome 113+,
Safari 26+, Firefox 141+). Every API name is verified against the WebGPU specification
and MDN.

## 1. Object Labels

### The label field

Every WebGPU descriptor accepts an optional `label` of type `string`. The default is the
empty string `""`. Objects created with a label expose it as a read-only `label`
property.

Descriptors that accept `label`:

- `GPUBufferDescriptor` : `device.createBuffer`
- `GPUTextureDescriptor` : `device.createTexture`
- `GPUTextureViewDescriptor` : `texture.createView`
- `GPUSamplerDescriptor` : `device.createSampler`
- `GPUShaderModuleDescriptor` : `device.createShaderModule`
- `GPUBindGroupLayoutDescriptor` : `device.createBindGroupLayout`
- `GPUPipelineLayoutDescriptor` : `device.createPipelineLayout`
- `GPUBindGroupDescriptor` : `device.createBindGroup`
- `GPURenderPipelineDescriptor` : `device.createRenderPipeline` and `...Async`
- `GPUComputePipelineDescriptor` : `device.createComputePipeline` and `...Async`
- `GPUCommandEncoderDescriptor` : `device.createCommandEncoder`
- `GPURenderPassDescriptor` : `encoder.beginRenderPass`
- `GPUComputePassDescriptor` : `encoder.beginComputePass`
- `GPURenderBundleEncoderDescriptor` : `device.createRenderBundleEncoder`
- `GPUQuerySetDescriptor` : `device.createQuerySet`
- `GPUDeviceDescriptor` and the `GPURequestAdapterOptions` device request

### Why labels matter

`GPUError.message` is implementation-defined human-readable text. Dawn and wgpu both
quote the `label` of the object that failed validation. With labels, a message reads
`Texture "shadow-depth-texture" usage ...`. Without labels, the implementation can only
say `a texture`, which is not actionable when a frame creates dozens of textures.

### Label discipline rules

- ALWAYS set a `label` on every descriptor. Treat the empty default as a bug.
- ALWAYS make the label identify the object's role, for example `"g-buffer-albedo"`,
  not `"texture1"`.
- ALWAYS keep labels stable across runs so they are greppable in logs and captures.
- The `label` is mutable on the created object; setting it post-creation is valid but
  the descriptor `label` is the one most tooling reads first.

## 2. Shader Compilation Diagnostics

### createShaderModule

`device.createShaderModule(descriptor)` returns a `GPUShaderModule` synchronously. The
descriptor is `{ code, label?, sourceMap?, compilationHints? }`, where `code` is the WGSL
source string. Critically, `createShaderModule` does NOT throw on a WGSL syntax or type
error. The returned module may be invalid. The only channel for compile diagnostics is
`getCompilationInfo()`.

### getCompilationInfo

`shaderModule.getCompilationInfo()` returns `Promise<GPUCompilationInfo>`. It never
rejects. The promise always resolves, even when the module is invalid.

`GPUCompilationInfo` has one read-only property:

- `messages` : a read-only frozen array of `GPUCompilationMessage`.

### GPUCompilationMessage

Each `GPUCompilationMessage` is a read-only object with these properties:

| Property | Type | Meaning |
|----------|------|---------|
| `message` | `string` | Human-readable description of the diagnostic |
| `type` | `GPUCompilationMessageType` | `"error"`, `"warning"`, or `"info"` |
| `lineNum` | `number` | 1-based line number of the start of the substring, or `0` if not applicable |
| `linePos` | `number` | 1-based column (UTF-16 code units) on that line, or `0` if not applicable |
| `offset` | `number` | UTF-16 code-unit offset from the start of `code` to the start of the substring |
| `length` | `number` | UTF-16 code-unit length of the substring the message refers to |

Semantics:

- `type === "error"` means the module is INVALID. Any pipeline built from it fails.
- `type === "warning"` means the module is valid but the code is suspect.
- `type === "info"` is advisory only.
- `lineNum` and `linePos` are 1-based. A value of `0` means the message has no source
  location.
- `offset` and `length` index into the original `code` string in UTF-16 code units and
  let you highlight the exact substring.

### Required usage

ALWAYS call `getCompilationInfo()` immediately after `createShaderModule` during
development. ALWAYS treat any `type === "error"` message as a hard failure and NEVER pass
that module to `createRenderPipeline` or `createComputePipeline`.

## 3. Debug Groups and Markers

Debug groups and markers attach human-readable names to the command stream. They have no
effect on rendering output. They appear in GPU frame captures and in some browser
tooling. They are available on encoders and on render and compute pass encoders.

### pushDebugGroup and popDebugGroup

`encoder.pushDebugGroup(groupLabel)` opens a named, nestable group. `encoder.popDebugGroup()`
closes the most recently opened group. Available on:

- `GPUCommandEncoder`
- `GPURenderPassEncoder`
- `GPUComputePassEncoder`
- `GPURenderBundleEncoder`

Rules:

- Every `pushDebugGroup` MUST be matched by exactly one `popDebugGroup` on the SAME
  encoder before that encoder's `finish()` or `end()`.
- Groups nest: a `popDebugGroup` closes the innermost open group.
- An unmatched push, or a pop with no open group, is a validation error.

### insertDebugMarker

`encoder.insertDebugMarker(markerLabel)` inserts a single named point into the command
stream. It does not open or close anything and needs no matching call. Available on the
same four encoder types as `pushDebugGroup`.

### Usage rules

- ALWAYS wrap each render pass or compute pass, or each logical phase, in a
  `pushDebugGroup` / `popDebugGroup` pair.
- ALWAYS use a descriptive name, for example `"shadow-pass"` or `"post-processing"`.
- Use `insertDebugMarker` for a one-off landmark such as `"begin-particle-update"`.

## 4. Browser GPU Tooling

### Chrome DevTools console

Chrome's DevTools console surfaces uncaptured WebGPU errors at runtime. An error that is
not captured by an error scope fires the `uncapturederror` event and Chrome logs it to
the console. The console is the default place to see runtime WebGPU errors during
development.

### chrome://gpu

Navigating to `chrome://gpu` in Chrome or Edge reports adapter and driver status,
including the GPU vendor, the driver version, and whether any features are blocklisted
or software-emulated. Check `chrome://gpu` first when WebGPU is entirely unavailable,
because that indicates an environmental problem rather than a code bug.

### chrome://flags/#enable-unsafe-webgpu

`chrome://flags/#enable-unsafe-webgpu` enables experimental WebGPU features that are not
yet stable. ALWAYS test with this flag OFF for code that ships, because end users do not
have it enabled.

### Secure context requirement

WebGPU is only exposed in a secure context. `navigator.gpu` is `undefined` on a plain
`http://` origin other than `localhost`. When `navigator.gpu` is missing, confirm the
page is served over `https://` or from `localhost` before debugging further.

## 5. GPU Frame Captures

A GPU frame capture records every command of one rendered frame and lets you inspect
per-draw state offline.

- Dawn, the Chrome WebGPU implementation, integrates with PIX on Windows for
  Microsoft's GPU capture and analysis tool.
- Dawn also supports RenderDoc-style frame capture, an open-source GPU debugger.
- The `label` of each object and the `pushDebugGroup` / `insertDebugMarker` names appear
  in the capture. Without them a capture is a flat, unlabeled list of draw calls.
- Chrome 131 added a `strictMath` shader-module developer option that disables certain
  floating-point optimizations to make shader math reproducible during debugging.

ALWAYS label objects and add debug groups BEFORE taking a capture. The capture is only
as readable as the names baked into the command stream.

## Reference Sources

- https://developer.mozilla.org/en-US/docs/Web/API/GPUShaderModule/getCompilationInfo
- https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API
- https://developer.chrome.com/docs/web-platform/webgpu
- https://www.w3.org/TR/webgpu/
- vooronderzoek-webgpu.md PART C sections 10 and 11, PART A section 3
