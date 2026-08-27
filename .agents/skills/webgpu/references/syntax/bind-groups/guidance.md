# WebGPU Bind Groups

Define resource interfaces with `GPUBindGroupLayout`, bind concrete buffers,
textures, and samplers with `GPUBindGroup`, and wire them to WGSL `@group` /
`@binding` slots without triggering WebGPU validation errors.

## Quick Reference

WebGPU 1.0-stable baseline: Chrome 113+, Safari 26+, Firefox 141+.

`device.createBindGroupLayout({ label?, entries })` defines the shape.
`device.createBindGroup({ label?, layout, entries })` binds concrete resources.
Each layout entry has `binding` (matches WGSL `@binding(n)`), `visibility` (a
`GPUShaderStage` bitmask), and exactly ONE resource layout object.

| Layout object | Resource in the bind group | WGSL declaration |
|---------------|----------------------------|------------------|
| `buffer: { type: "uniform" }` | `GPUBufferBinding` (`{ buffer, offset?, size? }`) | `var<uniform>` |
| `buffer: { type: "storage" }` | `GPUBufferBinding` | `var<storage, read_write>` |
| `buffer: { type: "read-only-storage" }` | `GPUBufferBinding` | `var<storage, read>` |
| `sampler: { type: "filtering" }` | `GPUSampler` | `sampler` |
| `sampler: { type: "comparison" }` | `GPUSampler` (with `compare`) | `sampler_comparison` |
| `texture: { sampleType: "float" }` | `GPUTextureView` | `texture_2d<f32>` |
| `texture: { sampleType: "depth" }` | `GPUTextureView` | `texture_depth_2d` |
| `storageTexture: { access, format }` | `GPUTextureView` | `texture_storage_2d<format, access>` |
| `externalTexture: {}` | `GPUExternalTexture` | `texture_external` |

Defaults (verified against the spec): `buffer.type` `"uniform"`,
`sampler.type` `"filtering"`, `texture.sampleType` `"float"`, `texture`/`storageTexture`
`viewDimension` `"2d"`, `storageTexture.access` `"write-only"`,
`buffer.hasDynamicOffset` `false`.

Dynamic offset alignment numbers (the 256-byte rule) live in
`webgpu-core-memory-model`. This skill states the rule but does not duplicate it.

## Decision Tree

```
Which layout object does this binding need?
├── A buffer the shader only reads, small, fixed size (camera, lights)?
│   └── buffer: { type: "uniform" }                -> WGSL var<uniform>
├── A buffer the shader reads AND writes (compute output, particles)?
│   └── buffer: { type: "storage" }                -> WGSL var<storage, read_write>
├── A buffer the shader only reads, large or runtime-sized array?
│   └── buffer: { type: "read-only-storage" }      -> WGSL var<storage, read>
├── A sampler used with textureSampleCompare (shadow maps)?
│   └── sampler: { type: "comparison" }            -> WGSL sampler_comparison
├── Any other sampler?
│   └── sampler: { type: "filtering" | "non-filtering" }
├── A texture sampled via textureSample / textureLoad?
│   └── texture: { sampleType, viewDimension }     -> WGSL texture_2d<T> / texture_depth_2d
├── A texture written from a compute shader via textureStore?
│   └── storageTexture: { access, format }         -> NEVER viewDimension "cube"
└── An HTMLVideoElement / VideoFrame frame?
    └── externalTexture: {}                        -> WGSL texture_external

Reusing one bind group across multiple pipelines?
├── YES -> create an explicit GPUPipelineLayout from your GPUBindGroupLayout
└── NO  -> pipeline.getBindGroupLayout(i) from "auto" layout is acceptable
```

## Core Patterns

### Pattern 1: ALWAYS make layout binding numbers match WGSL @binding

The `binding` number in a `GPUBindGroupLayoutEntry`, the `binding` in the
`GPUBindGroup` entry, and the WGSL `@binding(n)` MUST be the same integer. The
bind group index passed to `setBindGroup(index, ...)` MUST match WGSL `@group(n)`.

```js
const layout = device.createBindGroupLayout({
  entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX,
              buffer: { type: "uniform" } }],
});
// WGSL: @group(0) @binding(0) var<uniform> camera : Camera;
const group = device.createBindGroup({
  layout,
  entries: [{ binding: 0, resource: { buffer: cameraBuffer } }],
});
pass.setBindGroup(0, group);   // index 0 == WGSL @group(0)
```

### Pattern 2: ALWAYS set every stage that reads the binding in visibility

`visibility` is a `GPUShaderStage` bitmask. A binding read from two stages MUST
list both, OR-combined. NEVER omit a stage the shader actually uses.

```js
{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
  buffer: { type: "uniform" } }
```

### Pattern 3: ALWAYS provide exactly one resource layout object per entry

Each `GPUBindGroupLayoutEntry` carries exactly ONE of `buffer`, `sampler`,
`texture`, `storageTexture`, or `externalTexture`. Zero objects or two objects
fails `createBindGroupLayout` validation.

```js
{ binding: 1, visibility: GPUShaderStage.FRAGMENT,
  texture: { sampleType: "float", viewDimension: "2d" } }   // exactly one
```

### Pattern 4: ALWAYS use a GPUBufferBinding object for buffer resources

In `createBindGroup`, a buffer binding's `resource` is a `GPUBufferBinding`
object `{ buffer, offset?, size? }`, NEVER the bare `GPUBuffer`. A sampler,
texture view, or external texture is passed directly.

```js
entries: [
  { binding: 0, resource: { buffer: uniformBuffer } },          // GPUBufferBinding
  { binding: 1, resource: textureView },                        // GPUTextureView direct
  { binding: 2, resource: sampler },                            // GPUSampler direct
]
```

### Pattern 5: ALWAYS set hasDynamicOffset and pass a 256-aligned offset

For a buffer rebound at many offsets per frame, set `hasDynamicOffset: true` in
the layout and supply the offset at draw time as the third `setBindGroup`
argument. Each dynamic offset MUST be a multiple of 256.

```js
// layout: buffer: { type: "uniform", hasDynamicOffset: true }
const STRIDE = 256;                       // struct padded to 256, NOT its raw size
pass.setBindGroup(0, group, [i * STRIDE]); // dynamicOffsets array, each % 256 == 0
```

### Pattern 6: NEVER reuse an auto-layout bind group across pipelines

`pipeline.getBindGroupLayout(index)` retrieves an implicit layout from a pipeline
created with `layout: "auto"`. A bind group built from it is bound to THAT
pipeline only. For shared resources, create an explicit `GPUPipelineLayout`.

```js
// auto layout: per-pipeline only
const g = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
// shared: explicit layout reused by every pipeline
const bgl = device.createBindGroupLayout({ entries: [...] });
const pl  = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
```

## Common Anti-Patterns

1. Passing a dynamic offset that is not a multiple of 256, computed as
   `i * structSize` where `structSize` is e.g. 192 bytes. WHY it fails: dynamic
   offsets MUST be multiples of `minUniformBufferOffsetAlignment` /
   `minStorageBufferOffsetAlignment` (both 256). Pad the struct to a 256-byte
   stride and index by that stride.

2. Binding a bind group from `pipelineA.getBindGroupLayout(0)` to `pipelineB`.
   WHY it fails: auto-layout produces a distinct implicit layout per pipeline; a
   bind group is only compatible with its origin pipeline. Use an explicit
   `GPUPipelineLayout` for cross-pipeline sharing.

3. Layout `binding` numbers that do not match the WGSL `@binding(n)`. WHY it
   fails: WebGPU matches resources by binding index; a mismatch produces a
   "bind group is not compatible" validation error at draw time.

## Critical Warnings

- NEVER pass a dynamic offset that is not a multiple of 256. The struct stride
  MUST be padded to 256, not left at its raw byte size.
- NEVER reuse a bind group from `getBindGroupLayout` across pipelines. Auto
  layouts are per-pipeline. Use an explicit `GPUPipelineLayout` to share.
- NEVER use a `binding` number in the layout or bind group that differs from the
  WGSL `@binding(n)`, or a `setBindGroup` index that differs from `@group(n)`.
- NEVER omit a shader stage from `visibility` that the shader reads the binding
  from. The binding is invisible to the missing stage and validation fails.
- NEVER set `viewDimension: "cube"` or `"cube-array"` on a `storageTexture`
  entry. Storage textures do not support cube view dimensions.
- NEVER provide zero or two resource layout objects in one entry. Exactly one of
  `buffer` / `sampler` / `texture` / `storageTexture` / `externalTexture`.
- NEVER pass a bare `GPUBuffer` as a bind group `resource`. Wrap it in a
  `GPUBufferBinding` object `{ buffer, offset?, size? }`.

## Reference Files

- `methods.md` : `createBindGroupLayout` and the five entry layout
  types, `createBindGroup`, `GPUShaderStage` flags, `GPUBufferBinding`, and the
  dynamic offset rules.
- `examples.md` : verified code for a uniform + texture + sampler
  bind group, a storage buffer bind group, and a dynamic offset bind group.
- `anti-patterns.md` : bind group mistakes with WHY-it-fails
  explanations.

## Related Skills

- `webgpu-core-pipeline-architecture` : `layout: "auto"` vs explicit
  `GPUPipelineLayout`, and why auto-layout bind groups are per-pipeline.
- `webgpu-core-memory-model` : the exact 256-byte dynamic offset alignment
  numbers and uniform struct padding rules referenced here.
- `webgpu-syntax-buffers` : creating the `UNIFORM` and `STORAGE` buffers that
  feed `GPUBufferBinding` entries.
- `webgpu-syntax-textures` : creating the `GPUTexture` and `GPUTextureView`
  objects and `GPUSampler` objects bound here.
- `webgpu-syntax-render-pipeline` : the render pipeline that the bind group's
  `GPUPipelineLayout` connects to.
