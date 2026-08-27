# Compute Pipeline API Reference

WebGPU 1.0-stable. Verified against the W3C WebGPU specification
(https://www.w3.org/TR/webgpu/), MDN `GPUDevice/createComputePipeline`,
MDN `GPUComputePassEncoder`, and the project vooronderzoek (PART A section 3,
PART C section 3).

## device.createComputePipeline(descriptor)

```
GPUComputePipeline device.createComputePipeline(GPUComputePipelineDescriptor descriptor)
```

Creates a `GPUComputePipeline` synchronously. The pipeline runs a single
`@compute` shader stage.

### GPUComputePipelineDescriptor

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `label` | `string` | No | Debug label. Quoted in `GPUError` messages. ALWAYS set it. |
| `layout` | `GPUPipelineLayout` or `"auto"` | Yes | Pipeline layout. See "layout" below. |
| `compute` | `GPUProgrammableStage` | Yes | The compute stage descriptor. |

### GPUProgrammableStage (the `compute` field)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `module` | `GPUShaderModule` | Yes | The WGSL module created with `device.createShaderModule`. |
| `entryPoint` | `string` | No | Name of the `@compute` function. Omit only when the module has exactly one `@compute` entry point; otherwise creation fails with a `GPUValidationError`. |
| `constants` | `record<string, GPUPipelineConstantValue>` | No | Override values for WGSL `override` constants. Keys are the `@id(n)` numeric id (as a string) or the constant identifier name. Values are numbers or booleans. |

### layout

- `GPUPipelineLayout` : an explicit layout from
  `device.createPipelineLayout({ bindGroupLayouts: [...] })`. Bind groups built
  from this layout are reusable across every pipeline that shares the layout.
- `"auto"` : the pipeline derives an implicit bind-group layout from the shader.
  Retrieve a derived layout with `pipeline.getBindGroupLayout(index)`. Bind groups
  built from an `"auto"` layout are usable ONLY with the pipeline that produced
  them. For resources shared across multiple pipelines, use an explicit
  `GPUPipelineLayout`. See webgpu-core-pipeline-architecture.

## device.createComputePipelineAsync(descriptor)

```
Promise<GPUComputePipeline> device.createComputePipelineAsync(GPUComputePipelineDescriptor descriptor)
```

Same descriptor as `createComputePipeline`. Compiles the shader off the content
timeline so the frame loop is not blocked. ALWAYS use the async form for heavy
shader compilation during loading. The returned promise rejects with a
`GPUPipelineError` if the pipeline cannot be created. See
webgpu-core-pipeline-architecture for async compilation guidance.

## GPUComputePipeline methods

| Method | Returns | Description |
|--------|---------|-------------|
| `getBindGroupLayout(index)` | `GPUBindGroupLayout` | Returns the bind-group layout at `index`. With an `"auto"` layout this is the implicit derived layout. |

`GPUComputePipeline` is immutable. ALWAYS create it once and reuse it. NEVER
recreate it per frame or per dispatch.

## encoder.beginComputePass(descriptor)

```
GPUComputePassEncoder encoder.beginComputePass(optional GPUComputePassDescriptor descriptor)
```

Begins a compute pass on a `GPUCommandEncoder` and returns a
`GPUComputePassEncoder`.

### GPUComputePassDescriptor

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `label` | `string` | No | Debug label. |
| `timestampWrites` | `GPUComputePassTimestampWrites` | No | Timestamp query writes. Requires the `timestamp-query` feature. |

## GPUComputePassEncoder methods

### setPipeline(pipeline)

```
undefined setPipeline(GPUComputePipeline pipeline)
```

Sets the active `GPUComputePipeline` for subsequent dispatch commands. A pipeline
MUST be set before any `dispatchWorkgroups` or `dispatchWorkgroupsIndirect` call.

### setBindGroup(index, bindGroup, dynamicOffsets)

```
undefined setBindGroup(GPUIndex32 index, GPUBindGroup? bindGroup,
                       optional sequence<GPUBufferDynamicOffset> dynamicOffsets = [])
```

Binds `bindGroup` at group `index`. Every bind group required by the active
pipeline's layout MUST be bound before a dispatch.

- `index` : the `@group(n)` index in WGSL.
- `bindGroup` : the `GPUBindGroup`, or `null` to clear the slot.
- `dynamicOffsets` : one offset per `hasDynamicOffset: true` buffer entry in the
  bind group layout. Each offset MUST be a multiple of
  `minUniformBufferOffsetAlignment` (256) for uniform buffers or
  `minStorageBufferOffsetAlignment` (256) for storage buffers. See
  webgpu-syntax-bind-groups.

A second overload exists that takes the `dynamicOffsets` data as a `Uint32Array`
with an explicit start and length, for large offset arrays.

### dispatchWorkgroups(workgroupCountX, workgroupCountY, workgroupCountZ)

```
undefined dispatchWorkgroups(GPUSize32 workgroupCountX,
                             optional GPUSize32 workgroupCountY = 1,
                             optional GPUSize32 workgroupCountZ = 1)
```

Dispatches a 3D grid of workgroups for the active `GPUComputePipeline`.

- The arguments are WORKGROUP counts, NOT shader-invocation counts.
- `workgroupCountY` and `workgroupCountZ` default to 1.
- Total shader invocations launched =
  `workgroupCountX * workgroupCountY * workgroupCountZ` multiplied by the
  product of the WGSL `@workgroup_size(x, y, z)`.
- Validation: each of `workgroupCountX`, `workgroupCountY`, `workgroupCountZ`
  MUST NOT exceed `device.limits.maxComputeWorkgroupsPerDimension` (spec default
  65535). Exceeding it is a `GPUValidationError`.

### dispatchWorkgroupsIndirect(indirectBuffer, indirectOffset)

```
undefined dispatchWorkgroupsIndirect(GPUBuffer indirectBuffer,
                                     GPUSize64 indirectOffset)
```

Dispatches a grid of workgroups whose counts are read from a GPU buffer instead
of from JavaScript. Enables GPU-driven dispatch where the count is computed by an
earlier pass.

- `indirectBuffer` MUST be created with the `GPUBufferUsage.INDIRECT` flag.
- `indirectOffset` MUST be a multiple of 4. It defaults to 0 if the
  implementation accepts the single-argument form; ALWAYS pass it explicitly.
- The buffer encodes exactly 3 consecutive `u32` values, little-endian, tightly
  packed = 12 bytes total, starting at `indirectOffset`:

  | Offset (bytes) | Field | Type |
  |----------------|-------|------|
  | 0 | `workgroupCountX` | `u32` |
  | 4 | `workgroupCountY` | `u32` |
  | 8 | `workgroupCountZ` | `u32` |

- Each of the three values is validated against
  `device.limits.maxComputeWorkgroupsPerDimension` the same way as the direct
  `dispatchWorkgroups` arguments.

This is a different layout from the draw-indirect buffers. For contrast (see
webgpu-syntax-render-pipeline and PART C section 3 of the vooronderzoek):

| Indirect call | Values | Bytes |
|---------------|--------|-------|
| `dispatchWorkgroupsIndirect` | `workgroupCountX, Y, Z` | 12 |
| `drawIndirect` | `vertexCount, instanceCount, firstVertex, firstInstance` | 16 |
| `drawIndexedIndirect` | `indexCount, instanceCount, firstIndex, baseVertex, firstInstance` | 20 |

### end()

```
undefined end()
```

Completes recording of the compute pass. Returns nothing. After `end()`, no
further commands may be encoded on this pass encoder. `end()` MUST be called
before `encoder.finish()`; finishing an encoder with an open pass throws.

### Debug methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `pushDebugGroup` | `pushDebugGroup(groupLabel)` | Begins a labeled debug group in the command stream. |
| `popDebugGroup` | `popDebugGroup()` | Ends the most recent debug group. |
| `insertDebugMarker` | `insertDebugMarker(markerLabel)` | Inserts a single labeled marker. |

## Relevant device limits

| Limit | Default | Relevance |
|-------|---------|-----------|
| `maxComputeWorkgroupsPerDimension` | 65535 | Max value for each `dispatchWorkgroups` argument and each indirect count. |
| `maxComputeInvocationsPerWorkgroup` | 256 | Max product of WGSL `@workgroup_size(x, y, z)`. Set in the shader, not at dispatch. |
| `maxComputeWorkgroupSizeX` / `Y` | 256 | Max individual `@workgroup_size` dimension. |
| `maxComputeWorkgroupSizeZ` | 64 | Max `@workgroup_size` Z dimension. |
| `maxComputeWorkgroupStorageSize` | 16384 | Max bytes of `var<workgroup>` shared memory. |

Always read these from `device.limits`; an adapter may report higher maxima.
