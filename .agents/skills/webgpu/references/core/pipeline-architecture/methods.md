# Pipeline Architecture: Method Signatures

All signatures verified against the W3C WebGPU specification (https://www.w3.org/TR/webgpu/) and MDN on 2026-05-20. Baseline: WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

This file covers the architecture-level methods only. Full descriptor fields for the render and compute pipeline descriptors belong to `webgpu-syntax-render-pipeline` and `webgpu-syntax-compute-pipeline`.

## device.createShaderModule(descriptor)

```
createShaderModule(descriptor: GPUShaderModuleDescriptor) -> GPUShaderModule
```

`GPUShaderModuleDescriptor`:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `label` | `string` | No | Debug label |
| `code` | `string` | Yes | WGSL source text |
| `sourceMap` | `object` | No | Source map for tooling |
| `compilationHints` | `GPUShaderModuleCompilationHint[]` | No | Optional hints linking entry points to a layout for earlier compilation |

Returns synchronously. A WGSL syntax error does NOT throw here; the module object is still returned and the error is reported through `getCompilationInfo()` and at pipeline creation. One module can hold vertex, fragment, and compute entry points; `entryPoint` is selected later in the pipeline descriptor.

## shaderModule.getCompilationInfo()

```
getCompilationInfo() -> Promise<GPUCompilationInfo>
```

No parameters. Resolves to a `GPUCompilationInfo`:

| Object | Field | Type | Notes |
|--------|-------|------|-------|
| `GPUCompilationInfo` | `messages` | `GPUCompilationMessage[]` | All diagnostics from compiling the module |
| `GPUCompilationMessage` | `message` | `string` | Human-readable text |
| `GPUCompilationMessage` | `type` | `"error"` \| `"warning"` \| `"info"` | Severity |
| `GPUCompilationMessage` | `lineNum` | `number` | 1-based line, 0 if not applicable |
| `GPUCompilationMessage` | `linePos` | `number` | 1-based column, 0 if not applicable |
| `GPUCompilationMessage` | `offset` | `number` | UTF-16 code-unit offset into `code` |
| `GPUCompilationMessage` | `length` | `number` | UTF-16 code-unit length of the substring |

## device.createPipelineLayout(descriptor)

```
createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor) -> GPUPipelineLayout
```

`GPUPipelineLayoutDescriptor`:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `label` | `string` | No | Debug label |
| `bindGroupLayouts` | `GPUBindGroupLayout[]` | Yes | Ordered array; array index = `@group(n)` index in WGSL |

`GPUBindGroupLayout` objects come from `device.createBindGroupLayout(...)` (see `webgpu-syntax-bind-groups`). The returned `GPUPipelineLayout` is immutable and is passed as the `layout` field of one or more pipeline descriptors. Sharing one `GPUPipelineLayout` across pipelines is what makes a single `GPUBindGroup` reusable across them.

## device.createRenderPipeline(descriptor)

```
createRenderPipeline(descriptor: GPURenderPipelineDescriptor) -> GPURenderPipeline
```

Synchronous. Compiles and validates immediately; blocks the calling thread until done. Architecture-relevant fields of `GPURenderPipelineDescriptor`:

| Field | Type | Notes |
|-------|------|-------|
| `label` | `string` | Debug label |
| `layout` | `GPUPipelineLayout` \| `"auto"` | An explicit layout, or `"auto"` to generate implicit bind-group layouts |
| `vertex` | `GPUVertexState` | Required; `{ module, entryPoint?, constants?, buffers? }` |
| `fragment` | `GPUFragmentState` | Optional; `{ module, entryPoint?, constants?, targets }`. Each target has a `format` that MUST equal the attachment format |

Full descriptor (`primitive`, `depthStencil`, `multisample`, and the inner field shapes) is documented in `webgpu-syntax-render-pipeline`.

## device.createRenderPipelineAsync(descriptor)

```
createRenderPipelineAsync(descriptor: GPURenderPipelineDescriptor) -> Promise<GPURenderPipeline>
```

Same descriptor as `createRenderPipeline`. Compilation runs off the main thread; the Promise resolves with the `GPURenderPipeline` once it is ready to use without further compilation stalls. Rejects with a `GPUPipelineError` if creation fails. Use this variant whenever a pipeline is built while frames are rendering.

## device.createComputePipeline(descriptor)

```
createComputePipeline(descriptor: GPUComputePipelineDescriptor) -> GPUComputePipeline
```

Synchronous. Architecture-relevant fields of `GPUComputePipelineDescriptor`:

| Field | Type | Notes |
|-------|------|-------|
| `label` | `string` | Debug label |
| `layout` | `GPUPipelineLayout` \| `"auto"` | An explicit layout, or `"auto"` |
| `compute` | `GPUProgrammableStage` | Required; `{ module, entryPoint?, constants? }` |

Full descriptor is documented in `webgpu-syntax-compute-pipeline`.

## device.createComputePipelineAsync(descriptor)

```
createComputePipelineAsync(descriptor: GPUComputePipelineDescriptor) -> Promise<GPUComputePipeline>
```

Same descriptor as `createComputePipeline`. Compiles off the main thread; rejects with a `GPUPipelineError` on failure.

## pipeline.getBindGroupLayout(index)

```
getBindGroupLayout(index: number) -> GPUBindGroupLayout
```

Available on both `GPURenderPipeline` and `GPUComputePipeline`. `index` is the bind-group slot (the `@group(n)` index in WGSL). Returns the `GPUBindGroupLayout` for that slot.

When the pipeline was created with `layout: "auto"`, this returns the implicitly generated layout. A `GPUBindGroup` built from that layout is compatible ONLY with this pipeline. When the pipeline was created with an explicit `GPUPipelineLayout`, this returns the layout from that explicit layout's `bindGroupLayouts` array.
