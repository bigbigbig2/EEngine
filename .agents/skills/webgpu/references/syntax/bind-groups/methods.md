# Bind Group Methods Reference

WebGPU 1.0-stable. Verified against the W3C WebGPU specification, MDN
`GPUDevice/createBindGroupLayout`, and MDN `GPUDevice/createBindGroup`.

## device.createBindGroupLayout(descriptor)

Returns a `GPUBindGroupLayout`. Defines the interface shape of a group of
bindings without referencing concrete resources.

`GPUBindGroupLayoutDescriptor`:

| Field | Type | Notes |
|-------|------|-------|
| `label` | `string` | Optional debug label |
| `entries` | `GPUBindGroupLayoutEntry[]` | Required, one per binding |

### GPUBindGroupLayoutEntry

| Field | Type | Notes |
|-------|------|-------|
| `binding` | `number` | Matches WGSL `@binding(n)`, unique within the layout |
| `visibility` | `GPUShaderStage` bitmask | OR-combine `VERTEX`, `FRAGMENT`, `COMPUTE` |
| `buffer` | `GPUBufferBindingLayout` | Provide exactly one of these five |
| `sampler` | `GPUSamplerBindingLayout` | |
| `texture` | `GPUTextureBindingLayout` | |
| `storageTexture` | `GPUStorageTextureBindingLayout` | |
| `externalTexture` | `GPUExternalTextureBindingLayout` | |

An entry MUST contain exactly ONE of `buffer` / `sampler` / `texture` /
`storageTexture` / `externalTexture`. Zero or two fails validation.

## The 5 Entry Layout Types

### 1. GPUBufferBindingLayout (`buffer`)

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `type` | `"uniform"` \| `"storage"` \| `"read-only-storage"` | `"uniform"` | Binding access class |
| `hasDynamicOffset` | `boolean` | `false` | When `true`, offset is supplied to `setBindGroup` |
| `minBindingSize` | `number` | `0` | Minimum bound byte size; `0` means checked at draw time |

- `"uniform"` maps to WGSL `var<uniform>`. Read-only, small, fixed size.
- `"storage"` maps to WGSL `var<storage, read_write>`. Read and write.
- `"read-only-storage"` maps to WGSL `var<storage, read>`. Read-only, large
  or runtime-sized arrays allowed.
- Setting `minBindingSize` to a non-zero value moves the size check from draw
  time to bind group creation time.

### 2. GPUSamplerBindingLayout (`sampler`)

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `type` | `"filtering"` \| `"non-filtering"` \| `"comparison"` | `"filtering"` | Sampler class |

- `"filtering"` allows linear `magFilter` / `minFilter` / `mipmapFilter`.
- `"non-filtering"` requires a sampler created with only `"nearest"` filters.
- `"comparison"` requires a sampler created with a `compare` function; maps to
  WGSL `sampler_comparison`, used with `textureSampleCompare`.

### 3. GPUTextureBindingLayout (`texture`)

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `sampleType` | `"float"` \| `"unfilterable-float"` \| `"depth"` \| `"sint"` \| `"uint"` | `"float"` | Sampled value type |
| `viewDimension` | `GPUTextureViewDimension` | `"2d"` | View dimension of the bound view |
| `multisampled` | `boolean` | `false` | `true` for an MSAA texture |

- `viewDimension` values: `"1d"`, `"2d"`, `"2d-array"`, `"cube"`, `"cube-array"`, `"3d"`.
- `sampleType: "depth"` maps to WGSL `texture_depth_2d`.
- `sampleType: "float"` allows a filtering sampler; `"unfilterable-float"` does not.
- `multisampled: true` maps to WGSL `texture_multisampled_2d<T>` and cannot be
  sampled, only `textureLoad`-ed.

### 4. GPUStorageTextureBindingLayout (`storageTexture`)

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `access` | `"write-only"` \| `"read-only"` \| `"read-write"` | `"write-only"` | WGSL access mode |
| `format` | `GPUTextureFormat` | Required | Texel format, e.g. `"rgba8unorm"` |
| `viewDimension` | `GPUTextureViewDimension` | `"2d"` | NEVER `"cube"` / `"cube-array"` |

- Maps to WGSL `texture_storage_2d<format, access>`.
- `"read-only"` and `"read-write"` require the
  `readonly_and_readwrite_storage_textures` WGSL language feature; without it a
  `GPUValidationError` is generated.
- `viewDimension` allows `"1d"`, `"2d"`, `"2d-array"`, `"3d"`. Cube dimensions
  are not valid for storage textures.

### 5. GPUExternalTextureBindingLayout (`externalTexture`)

An empty object `{}`. It marks the binding as a `GPUExternalTexture` slot
(imported from `HTMLVideoElement` or `VideoFrame`), mapping to WGSL
`texture_external`.

## device.createBindGroup(descriptor)

Returns a `GPUBindGroup`. Binds concrete resources to the slots a
`GPUBindGroupLayout` defines.

`GPUBindGroupDescriptor`:

| Field | Type | Notes |
|-------|------|-------|
| `label` | `string` | Optional debug label |
| `layout` | `GPUBindGroupLayout` | Required; from `createBindGroupLayout` or `pipeline.getBindGroupLayout(i)` |
| `entries` | `GPUBindGroupEntry[]` | Required, one per binding in the layout |

### GPUBindGroupEntry

| Field | Type | Notes |
|-------|------|-------|
| `binding` | `number` | Matches a `binding` in the layout and WGSL `@binding(n)` |
| `resource` | `GPUBindingResource` | The concrete resource |

`resource` is one of:

- `GPUBufferBinding` (an object) for a `buffer` layout entry.
- `GPUSampler` (passed directly) for a `sampler` layout entry.
- `GPUTextureView` (passed directly) for a `texture` or `storageTexture` entry.
- `GPUExternalTexture` (passed directly) for an `externalTexture` entry.

### GPUBufferBinding

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `buffer` | `GPUBuffer` | Required | The buffer resource |
| `offset` | `number` | `0` | Byte offset; multiple of 8 for the static offset |
| `size` | `number` | rest of buffer | Bound byte range; defaults to `buffer.size - offset` |

A buffer `resource` is ALWAYS this object, never a bare `GPUBuffer`. The
buffer's `usage` MUST include `GPUBufferUsage.UNIFORM` for a `"uniform"` layout
entry or `GPUBufferUsage.STORAGE` for a `"storage"` / `"read-only-storage"`
entry.

## GPUShaderStage Flags

`GPUShaderStage` is a namespace of bitmask constants used in `visibility`:

| Constant | Meaning |
|----------|---------|
| `GPUShaderStage.VERTEX` | Binding readable from the vertex stage |
| `GPUShaderStage.FRAGMENT` | Binding readable from the fragment stage |
| `GPUShaderStage.COMPUTE` | Binding readable from the compute stage |

Combine with bitwise OR: `GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT`. The
binding MUST list every stage that reads it, or validation fails. Some
combinations are restricted by binding type, for example a `"storage"` buffer
binding is not visible to the vertex stage.

## Dynamic Offset Rules

When a `buffer` layout entry sets `hasDynamicOffset: true`:

- The offset is NOT baked into the `GPUBindGroup`. It is supplied per draw as
  the third argument to `setBindGroup`.
- Signature: `passEncoder.setBindGroup(index, bindGroup, dynamicOffsets)` where
  `dynamicOffsets` is a `number[]`, one entry per dynamic-offset binding in the
  group, in ascending `binding` order.
- Each dynamic offset MUST be a multiple of `minUniformBufferOffsetAlignment`
  (256) for a `"uniform"` buffer, or `minStorageBufferOffsetAlignment` (256)
  for a `"storage"` / `"read-only-storage"` buffer.
- A struct used at dynamic offsets MUST be padded so its stride is a multiple
  of 256. Indexing by the raw struct size produces unaligned offsets.
- The exact alignment numbers and uniform struct padding rules are in
  `webgpu-core-memory-model`.

## getBindGroupLayout from Auto Layout

A pipeline created with `layout: "auto"` generates implicit bind group layouts.
`pipeline.getBindGroupLayout(index)` returns the `GPUBindGroupLayout` for that
group index.

- Index MUST be a valid group index used by the pipeline's shaders.
- The returned layout is implicit and specific to that pipeline.
- A bind group created from `pipelineA.getBindGroupLayout(0)` is NOT compatible
  with `pipelineB`. For resources shared across pipelines, create an explicit
  `GPUBindGroupLayout` and an explicit `GPUPipelineLayout` from
  `device.createPipelineLayout({ bindGroupLayouts: [...] })`.
- See `webgpu-core-pipeline-architecture` for the full auto vs explicit layout
  discussion.
