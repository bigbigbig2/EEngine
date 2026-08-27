# WebGPU Core Architecture: API Reference

Complete signatures for the WebGPU initialization surface. Baseline: WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). Verified against the W3C WebGPU specification, the gpuweb explainer, and MDN.

## Entry point: navigator.gpu

`navigator.gpu` exposes the `GPU` interface. Inside a Web Worker the equivalent is `WorkerNavigator.gpu`, reached as `self.navigator.gpu`.

WebGPU requires a secure context. On HTTP origins other than `localhost`, `navigator.gpu` is `undefined`. ALWAYS test `if (!navigator.gpu)` before any further call.

## Interface: GPU

The object returned by `navigator.gpu`.

| Member | Signature | Notes |
|--------|-----------|-------|
| `requestAdapter` | `requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter \| null>` | Resolves to `null` when no compatible adapter exists. Null is NOT a rejection. |
| `getPreferredCanvasFormat` | `getPreferredCanvasFormat(): GPUTextureFormat` | Returns `"bgra8unorm"` or `"rgba8unorm"` depending on platform. |
| `wgslLanguageFeatures` | `WGSLLanguageFeatures` (read-only) | Set-like object of supported WGSL language extensions. |

### GPURequestAdapterOptions

The descriptor passed to `requestAdapter`. It has exactly two optional fields.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `powerPreference` | `"low-power" \| "high-performance"` | unset | When omitted, the user agent chooses. |
| `forceFallbackAdapter` | `boolean` | `false` | When `true`, requests a fallback (software) adapter. If none exists, `requestAdapter` resolves to `null`. |

```js
navigator.gpu.requestAdapter();                                       // UA chooses
navigator.gpu.requestAdapter({ powerPreference: "high-performance" }); // discrete GPU preferred
navigator.gpu.requestAdapter({ powerPreference: "low-power" });        // integrated GPU preferred
navigator.gpu.requestAdapter({ forceFallbackAdapter: true });          // software path
```

`powerPreference` is a hint, not a guarantee. The user agent may return any adapter.

## Interface: GPUAdapter

Represents a physical WebGPU implementation: a discrete GPU, an integrated GPU, or a software fallback. An adapter does not allocate GPU resources by itself. It is the handle from which a device is requested.

| Member | Signature | Notes |
|--------|-----------|-------|
| `features` | `GPUSupportedFeatures` (read-only) | Set-like object of `GPUFeatureName` strings. Query with `adapter.features.has("...")`. |
| `limits` | `GPUSupportedLimits` (read-only) | Numeric limits the adapter supports. See `webgpu-core-limits-features`. |
| `info` | `GPUAdapterInfo` (read-only) | Identification details. See below. |
| `requestDevice` | `requestDevice(descriptor?: GPUDeviceDescriptor): Promise<GPUDevice>` | Returns a logical device. Resolves even on failure. |

A `GPUAdapter` can yield at most one `GPUDevice` per `requestDevice` call. After `requestDevice` succeeds, the adapter is considered consumed; calling `requestDevice` again on the same adapter resolves to an already-lost device.

### GPUAdapterInfo

Read-only identification details, available as `adapter.info` and also as `device.adapterInfo`.

| Field | Type | Notes |
|-------|------|-------|
| `vendor` | `string` | GPU vendor name. May be an empty string for privacy. |
| `architecture` | `string` | GPU architecture family. May be an empty string for privacy. |
| `device` | `string` | Device identifier. May be an empty string for privacy. |
| `description` | `string` | Human-readable description. May be an empty string for privacy. |

All four fields are strings. Browsers may return empty strings to limit fingerprinting. NEVER branch on a non-empty value being present.

## Interface: GPUDevice

A logical connection to the adapter. It abstracts the implementation so the owner can act as the sole user of the adapter. The device is the root owner of every object created from it: when the device is lost or destroyed, all child objects are freed together.

| Member | Signature | Notes |
|--------|-----------|-------|
| `features` | `GPUSupportedFeatures` (read-only) | The features actually enabled on this device. A subset of or equal to `adapter.features`. |
| `limits` | `GPUSupportedLimits` (read-only) | The negotiated limits. API calls are validated against these, not the adapter's full limits. |
| `adapterInfo` | `GPUAdapterInfo` (read-only) | Same shape as `GPUAdapter.info`. |
| `queue` | `GPUQueue` (read-only) | The default queue. A property, NEVER a method. |
| `lost` | `Promise<GPUDeviceLostInfo>` (read-only) | Resolves (never rejects) when the device becomes unusable. |
| `label` | `string` | Mutable debug label. |
| `destroy` | `destroy(): undefined` | Destroys the device and all child objects. Triggers `lost` with `reason: "destroyed"`. |
| `createBuffer` | `createBuffer(descriptor): GPUBuffer` | Allocates a buffer. |
| `createTexture` | `createTexture(descriptor): GPUTexture` | Allocates a texture. |
| `createSampler` | `createSampler(descriptor?): GPUSampler` | Creates a sampler. |
| `createShaderModule` | `createShaderModule(descriptor): GPUShaderModule` | Compiles WGSL source. |
| `createBindGroupLayout` | `createBindGroupLayout(descriptor): GPUBindGroupLayout` | Defines a bind-group shape. |
| `createPipelineLayout` | `createPipelineLayout(descriptor): GPUPipelineLayout` | Combines bind-group layouts. |
| `createBindGroup` | `createBindGroup(descriptor): GPUBindGroup` | Binds concrete resources. |
| `createRenderPipeline` | `createRenderPipeline(descriptor): GPURenderPipeline` | Synchronous render pipeline creation. |
| `createComputePipeline` | `createComputePipeline(descriptor): GPUComputePipeline` | Synchronous compute pipeline creation. |
| `createRenderPipelineAsync` | `createRenderPipelineAsync(descriptor): Promise<GPURenderPipeline>` | Off-thread compile. |
| `createComputePipelineAsync` | `createComputePipelineAsync(descriptor): Promise<GPUComputePipeline>` | Off-thread compile. |
| `createCommandEncoder` | `createCommandEncoder(descriptor?): GPUCommandEncoder` | Begins command recording. |
| `pushErrorScope` | `pushErrorScope(filter): undefined` | Pushes a LIFO error scope. See `webgpu-errors-device-loss`. |
| `popErrorScope` | `popErrorScope(): Promise<GPUError \| null>` | Pops the top error scope. |

### GPUDeviceDescriptor

The descriptor passed to `requestDevice`. All fields are optional.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `label` | `string` | `""` | Debug label, quoted in error messages. ALWAYS set it. |
| `requiredFeatures` | `GPUFeatureName[]` | `[]` | Each entry must be present in `adapter.features` or `requestDevice` fails. |
| `requiredLimits` | `Record<string, number>` | `{}` | Each value is negotiated against the adapter's limits. Requesting better than supported fails. |
| `defaultQueue` | `GPUQueueDescriptor` | `{}` | Configures the default queue. Has an optional `label` field. |

`requestDevice` never throws for runtime failures. Per the gpuweb explainer it always resolves to a `GPUDevice`. On failure that device is already lost, so the `lost` promise resolves immediately. Detect this by registering `device.lost` before using the device. The promise rejects only for descriptor validation errors such as requesting an unsupported feature.

## Interface: GPUQueue

The queue receives command buffers and direct write operations. Reached as `device.queue`.

| Member | Signature | Notes |
|--------|-----------|-------|
| `label` | `string` | Mutable debug label. |
| `submit` | `submit(commandBuffers: GPUCommandBuffer[]): undefined` | Schedules command buffers in array order. |
| `onSubmittedWorkDone` | `onSubmittedWorkDone(): Promise<undefined>` | Resolves after all prior submitted work completes. |
| `writeBuffer` | `writeBuffer(buffer, bufferOffset, data, dataOffset?, size?): undefined` | CPU to GPU buffer write. `bufferOffset` and `size` must be multiples of 4. |
| `writeTexture` | `writeTexture(destination, data, dataLayout, size): undefined` | CPU to GPU texture write. |
| `copyExternalImageToTexture` | `copyExternalImageToTexture(source, destination, copySize): undefined` | Copies an image source into a texture. |

`device.queue` is a read-only property. `device.queue()` throws `TypeError`. The 1.0-stable specification defines exactly one queue per device, exposed as the default queue.

## The 4-phase runtime model

WebGPU work flows through four phases. Phase 1 runs once; phases 2 through 4 repeat per frame.

1. **Initialization.** Request the adapter, request the device, read `device.queue`, configure the canvas context, and create all long-lived resources (buffers, textures, shader modules, pipelines, bind groups). Runs once.
2. **Recording.** Per frame, create a fresh `GPUCommandEncoder` with `device.createCommandEncoder()`, encode render or compute passes, and call `encoder.finish()` to produce a `GPUCommandBuffer`.
3. **Submission.** Call `device.queue.submit([commandBuffer])` to schedule the recorded work.
4. **Asynchronous validation and execution.** The implementation validates and runs the commands on the GPU timeline, decoupled from the JavaScript content timeline. Completion is observed with `queue.onSubmittedWorkDone()` or buffer `mapAsync`.

Command buffers are single-use. Each frame needs a fresh encoder and a fresh command buffer.

## GPUDeviceLostInfo

The value the `device.lost` promise resolves with.

| Field | Type | Notes |
|-------|------|-------|
| `reason` | `"destroyed" \| "unknown"` | `"destroyed"` means the app called `device.destroy()`. `"unknown"` is a transient loss. |
| `message` | `string` | Human-readable description. |

`device.lost` resolves and never rejects. Recover only when `reason !== "destroyed"`. The full recovery procedure is in `webgpu-errors-device-loss`.
