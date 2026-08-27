# WGSL Texture and Sampler Methods Reference

All types and builtins below are part of WGSL, the shading language of WebGPU
1.0-stable. Verified against the W3C WGSL specification (https://www.w3.org/TR/WGSL/)
and the gpuweb editor's draft (https://gpuweb.github.io/gpuweb/wgsl/).

In the signatures below `texel` types use these conventions:
- `T` is the sampled type: `f32`, `i32`, or `u32`.
- `coords` are floating-point for the `textureSample*` family and signed/unsigned
  integers for `textureLoad` / `textureStore`.
- `level` is the mip level; `array_index` selects an array layer; `sample_index`
  selects an MSAA sample.

## 1. Texture handle types

Texture variables are declared at module scope in the `handle` address space with
`@group` and `@binding`. The address space and access mode are not written; sampled and
depth textures are implicitly `read`, storage textures carry an explicit access mode.

### Sampled (color) textures

| Type | Coordinate dimension | Notes |
|------|----------------------|-------|
| `texture_1d<T>` | 1 (`f32` / `i32` / `u32`) | No mipmaps in `textureSample` (1D has level 0 only) |
| `texture_2d<T>` | 2 | Most common color texture |
| `texture_2d_array<T>` | 2 + `array_index` | Texture array |
| `texture_3d<T>` | 3 | Volume texture |
| `texture_cube<T>` | 3 (direction vector) | Cubemap |
| `texture_cube_array<T>` | 3 + `array_index` | Cubemap array |
| `texture_multisampled_2d<T>` | 2 | Load only, requires `sample_index` |

`T` MUST be `f32`, `i32`, or `u32`. A `texture_2d<f32>` returns `vec4<f32>`;
`texture_2d<u32>` returns `vec4<u32>`. `texture_multisampled_2d<T>` supports
`textureLoad`, `textureDimensions`, and `textureNumSamples` only.

### Depth textures

| Type | Coordinate dimension | Notes |
|------|----------------------|-------|
| `texture_depth_2d` | 2 | Shadow map; sampled type is implicit `f32` |
| `texture_depth_2d_array` | 2 + `array_index` | Cascaded / array shadow maps |
| `texture_depth_cube` | 3 (direction) | Point-light shadow cube |
| `texture_depth_cube_array` | 3 + `array_index` | Cube shadow array |
| `texture_depth_multisampled_2d` | 2 | Load only, requires `sample_index` |

Depth textures have no `<T>` parameter. They return scalar `f32` (not `vec4`) from
sampling and load builtins. They work with `sampler_comparison` and the
`textureSampleCompare` / `textureSampleCompareLevel` / `textureGatherCompare` builtins,
and also accept a plain `sampler` with `textureSampleLevel` / `textureGather` for a
non-comparison depth read.

### Storage textures

| Type | Coordinate dimension |
|------|----------------------|
| `texture_storage_1d<F, A>` | 1 |
| `texture_storage_2d<F, A>` | 2 |
| `texture_storage_2d_array<F, A>` | 2 + `array_index` |
| `texture_storage_3d<F, A>` | 3 |

- `F` is a storage-capable `GPUTextureFormat`, written as a bare identifier (for
  example `rgba8unorm`, `rgba16float`, `r32float`, `rgba32uint`, `rgba32sint`).
- `A` is the access mode: `read`, `write`, or `read_write`.
- `textureStore` requires `A` to include `write` (`write` or `read_write`).
- `textureLoad` on a storage texture requires `A` to include `read` (`read` or
  `read_write`).
- There is no `texture_storage_cube`; cube storage textures do not exist.

### External textures

| Type | Notes |
|------|-------|
| `texture_external` | An imported video frame or `VideoFrame`. Implicit sample type. |

`texture_external` supports `textureSampleBaseClampToEdge`, `textureLoad`, and
`textureDimensions`. It does not support `textureSample`, mip levels, or array layers.

## 2. Sampler types

| Type | Used for | Builtins |
|------|----------|----------|
| `sampler` | Filtering / non-filtering of color and (non-comparison) depth reads | `textureSample`, `textureSampleLevel`, `textureSampleBias`, `textureSampleGrad`, `textureSampleBaseClampToEdge`, `textureGather` |
| `sampler_comparison` | Depth comparison (shadow maps) | `textureSampleCompare`, `textureSampleCompareLevel`, `textureGatherCompare` |

A `sampler_comparison` carries a comparison function; on the host it is created with
`GPUSamplerDescriptor.compare` set, and its bind-group-layout entry uses
`sampler: { type: "comparison" }`.

## 3. Host bind-group-layout correspondence

The WGSL handle type at `@group(g) @binding(b)` MUST match the host
`GPUBindGroupLayoutEntry` resource object at the same `binding`. See
`webgpu-syntax-bind-groups` for the host API.

| WGSL handle type | Host layout entry |
|------------------|-------------------|
| `texture_2d<f32>` | `texture: { sampleType: "float", viewDimension: "2d" }` |
| `texture_2d<f32>` (non-filtering) | `texture: { sampleType: "unfilterable-float" }` |
| `texture_2d<i32>` | `texture: { sampleType: "sint" }` |
| `texture_2d<u32>` | `texture: { sampleType: "uint" }` |
| `texture_2d_array<f32>` | `texture: { sampleType:"float", viewDimension:"2d-array" }` |
| `texture_3d<f32>` | `texture: { sampleType:"float", viewDimension:"3d" }` |
| `texture_cube<f32>` | `texture: { sampleType:"float", viewDimension:"cube" }` |
| `texture_depth_2d` | `texture: { sampleType: "depth", viewDimension: "2d" }` |
| `texture_multisampled_2d<f32>` | `texture: { sampleType:"float", multisampled:true }` |
| `texture_storage_2d<F, write>` | `storageTexture: { access:"write-only", format:F }` |
| `texture_storage_2d<F, read>` | `storageTexture: { access:"read-only", format:F }` |
| `texture_storage_2d<F, read_write>` | `storageTexture: { access:"read-write", format:F }` |
| `texture_external` | `externalTexture: {}` |
| `sampler` | `sampler: { type: "filtering" }` or `{ type: "non-filtering" }` |
| `sampler_comparison` | `sampler: { type: "comparison" }` |

## 4. Texture builtin functions

Stage legality column: `fragment` means the builtin computes screen-space derivatives
implicitly and is restricted to the fragment stage; `any` means it is legal in vertex,
fragment, and compute stages.

### Sampling builtins

| Builtin | Signature (representative 2D overload) | Stage |
|---------|----------------------------------------|-------|
| `textureSample` | `textureSample(t: texture_2d<f32>, s: sampler, coords: vec2f) -> vec4f` | fragment |
| `textureSample` (array) | `textureSample(t: texture_2d_array<f32>, s: sampler, coords: vec2f, array_index: i32) -> vec4f` | fragment |
| `textureSample` (depth) | `textureSample(t: texture_depth_2d, s: sampler, coords: vec2f) -> f32` | fragment |
| `textureSample` (offset) | `textureSample(t, s, coords, offset: vec2<i32>) -> vec4f` (const offset) | fragment |
| `textureSampleBias` | `textureSampleBias(t: texture_2d<f32>, s: sampler, coords: vec2f, bias: f32) -> vec4f` | fragment |
| `textureSampleGrad` | `textureSampleGrad(t: texture_2d<f32>, s: sampler, coords: vec2f, ddx: vec2f, ddy: vec2f) -> vec4f` | fragment |
| `textureSampleLevel` | `textureSampleLevel(t: texture_2d<f32>, s: sampler, coords: vec2f, level: f32) -> vec4f` | any |
| `textureSampleLevel` (depth) | `textureSampleLevel(t: texture_depth_2d, s: sampler, coords: vec2f, level: i32) -> f32` | any |
| `textureSampleBaseClampToEdge` | `textureSampleBaseClampToEdge(t: texture_2d<f32>, s: sampler, coords: vec2f) -> vec4f` (also `texture_external`) | any |

`textureSample`, `textureSampleBias`, and `textureSampleGrad` are fragment-only and
require uniform control flow. `textureSampleGrad` takes explicit gradients but still
participates in implicit derivative uniformity, so it stays fragment-only.
`textureSampleLevel` and `textureSampleBaseClampToEdge` take an explicit level (the
latter samples the base level) and are legal in any stage.

A constant `offset` argument (a `vec` of const-expression `i32` in the range -8..7) is
accepted as the last parameter by most sampling builtins for 2D / 2D-array / 3D
textures.

### Comparison (depth) sampling builtins

| Builtin | Signature (representative depth_2d overload) | Stage |
|---------|----------------------------------------------|-------|
| `textureSampleCompare` | `textureSampleCompare(t: texture_depth_2d, s: sampler_comparison, coords: vec2f, depth_ref: f32) -> f32` | fragment |
| `textureSampleCompareLevel` | `textureSampleCompareLevel(t: texture_depth_2d, s: sampler_comparison, coords: vec2f, depth_ref: f32) -> f32` | any |

`textureSampleCompare` samples and filters comparison results across the mip chosen by
implicit derivatives, so it is fragment-only and uniform. `textureSampleCompareLevel`
always samples mip level 0 and is legal in any stage. Both return `f32` in `[0.0, 1.0]`
(filtered fraction of texels passing the comparison). Both REQUIRE `sampler_comparison`.

### Load and store builtins

| Builtin | Signature | Stage |
|---------|-----------|-------|
| `textureLoad` (2d color) | `textureLoad(t: texture_2d<T>, coords: vec2<i32>, level: i32) -> vec4<T>` | any |
| `textureLoad` (2d array) | `textureLoad(t: texture_2d_array<T>, coords: vec2<i32>, array_index: i32, level: i32) -> vec4<T>` | any |
| `textureLoad` (depth) | `textureLoad(t: texture_depth_2d, coords: vec2<i32>, level: i32) -> f32` | any |
| `textureLoad` (multisampled) | `textureLoad(t: texture_multisampled_2d<T>, coords: vec2<i32>, sample_index: i32) -> vec4<T>` | any |
| `textureLoad` (storage) | `textureLoad(t: texture_storage_2d<F, read>, coords: vec2<i32>) -> vec4<f32>` | any |
| `textureLoad` (external) | `textureLoad(t: texture_external, coords: vec2<i32>) -> vec4<f32>` | any |
| `textureStore` (2d) | `textureStore(t: texture_storage_2d<F, write>, coords: vec2<i32>, value: vec4<f32>)` | any |
| `textureStore` (2d array) | `textureStore(t: texture_storage_2d_array<F, write>, coords: vec2<i32>, array_index: i32, value: vec4<f32>)` | any |

`textureLoad` performs no filtering: integer coordinates index exact texels and
out-of-bounds coordinates are handled per spec (the read returns a zero / boundary
value rather than sampling neighbours). `coords`, `level`, `array_index`, and
`sample_index` accept either `i32` or `u32`. Multisampled and storage textures have a
single mip level, so their `textureLoad` overloads omit the `level` parameter.
`textureStore` returns nothing and writes the texel; the `value` element type matches
the storage format channel kind (`vec4<f32>` for unorm/snorm/float formats, `vec4<u32>`
or `vec4<i32>` for integer formats).

### Gather builtins

| Builtin | Signature (representative 2D overload) | Stage |
|---------|----------------------------------------|-------|
| `textureGather` (color) | `textureGather(component: i32, t: texture_2d<T>, s: sampler, coords: vec2f) -> vec4<T>` | any |
| `textureGather` (depth) | `textureGather(t: texture_depth_2d, s: sampler, coords: vec2f) -> vec4f` | any |
| `textureGatherCompare` | `textureGatherCompare(t: texture_depth_2d, s: sampler_comparison, coords: vec2f, depth_ref: f32) -> vec4f` | any |

`textureGather` returns the selected `component` of the four texels in the
2x2 neighbourhood that bilinear filtering would use, in a fixed counter-clockwise
order. For a color texture the first argument is the channel index (0..3); for a depth
texture the `component` argument is omitted. `textureGatherCompare` gathers the four
comparison results against `depth_ref` and requires `sampler_comparison`. All gather
builtins are legal in any stage because they do not need a derivative-selected mip.

### Query builtins

| Builtin | Signature | Returns |
|---------|-----------|---------|
| `textureDimensions` | `textureDimensions(t [, level: i32])` | `u32` (1D) / `vec2<u32>` (2D, cube) / `vec3<u32>` (3D) |
| `textureNumLayers` | `textureNumLayers(t)` | `u32` |
| `textureNumLevels` | `textureNumLevels(t)` | `u32` |
| `textureNumSamples` | `textureNumSamples(t)` | `u32` |

`textureDimensions` accepts an optional mip `level` for textures that have mipmaps
(omitting it queries level 0); it returns the size in texels for that level.
`textureNumLayers` applies only to array textures (`*_2d_array`, `*_cube_array`).
`textureNumLevels` applies to textures with a mip chain (not multisampled, not storage,
not external). `textureNumSamples` applies only to `texture_multisampled_2d` and
`texture_depth_multisampled_2d`. All four query builtins are legal in any stage.

## 5. Stage legality summary

| Builtin | Vertex | Fragment | Compute | Reason |
|---------|--------|----------|---------|--------|
| `textureSample` | no | yes | no | implicit derivatives |
| `textureSampleBias` | no | yes | no | implicit derivatives |
| `textureSampleGrad` | no | yes | no | implicit derivative uniformity |
| `textureSampleCompare` | no | yes | no | implicit derivatives |
| `textureSampleLevel` | yes | yes | yes | explicit level |
| `textureSampleCompareLevel` | yes | yes | yes | explicit level 0 |
| `textureSampleBaseClampToEdge` | yes | yes | yes | base level |
| `textureLoad` | yes | yes | yes | no derivatives |
| `textureStore` | yes | yes | yes | no derivatives |
| `textureGather` | yes | yes | yes | no derivative-selected mip |
| `textureGatherCompare` | yes | yes | yes | no derivative-selected mip |
| `textureDimensions` | yes | yes | yes | pure query |
| `textureNumLayers` | yes | yes | yes | pure query |
| `textureNumLevels` | yes | yes | yes | pure query |
| `textureNumSamples` | yes | yes | yes | pure query |

The fragment-only builtins additionally require uniform control flow. Calling them in
control flow whose condition is non-uniform triggers the WGSL uniformity analysis,
producing a shader-creation error or a `derivative_uniformity` diagnostic depending on
configuration. See `webgpu-wgsl-uniformity`.
