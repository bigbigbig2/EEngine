# WGSL Textures and Samplers

Declare WGSL texture and sampler handle types and call the texture builtin functions
correctly per shader stage in WebGPU 1.0-stable.

## Quick Reference

### Texture handle types

All texture and sampler variables live in the `handle` address space. They are declared
at module scope with `@group(g) @binding(b)` and have access mode `read` (storage
textures have a parameterized access mode).

| WGSL type | Purpose | Sample type `T` |
|-----------|---------|-----------------|
| `texture_1d<T>` | 1D sampled texture | `f32`, `i32`, `u32` |
| `texture_2d<T>` | 2D sampled texture | `f32`, `i32`, `u32` |
| `texture_2d_array<T>` | 2D array sampled texture | `f32`, `i32`, `u32` |
| `texture_3d<T>` | 3D sampled texture | `f32`, `i32`, `u32` |
| `texture_cube<T>` | Cube sampled texture | `f32`, `i32`, `u32` |
| `texture_cube_array<T>` | Cube array sampled texture | `f32`, `i32`, `u32` |
| `texture_multisampled_2d<T>` | MSAA 2D texture (load only) | `f32`, `i32`, `u32` |
| `texture_depth_2d` | 2D depth texture | implicit `f32` |
| `texture_depth_2d_array` | 2D array depth texture | implicit `f32` |
| `texture_depth_cube` | Cube depth texture | implicit `f32` |
| `texture_depth_cube_array` | Cube array depth texture | implicit `f32` |
| `texture_depth_multisampled_2d` | MSAA depth texture (load only) | implicit `f32` |
| `texture_storage_1d<F, A>` | 1D storage texture | format `F`, access `A` |
| `texture_storage_2d<F, A>` | 2D storage texture | format `F`, access `A` |
| `texture_storage_2d_array<F, A>` | 2D array storage texture | format `F`, access `A` |
| `texture_storage_3d<F, A>` | 3D storage texture | format `F`, access `A` |
| `texture_external` | Imported video / external frame | implicit |

Storage access `A` is one of `read`, `write`, `read_write`. Storage format `F` MUST be a
storage-capable format (for example `rgba8unorm`, `rgba16float`, `r32float`, `rgba32uint`).

### Sampler types

| WGSL type | Use with | Host bind-group `sampler.type` |
|-----------|----------|--------------------------------|
| `sampler` | `texture_*<f32>` color textures | `"filtering"` or `"non-filtering"` |
| `sampler_comparison` | `texture_depth_*` for shadow lookups | `"comparison"` |

### Texture builtin functions

| Builtin | Returns | Legal stages | Derivatives |
|---------|---------|--------------|-------------|
| `textureSample` | `vec4<f32>` / `f32` (depth) | fragment only | implicit |
| `textureSampleBias` | `vec4<f32>` | fragment only | implicit |
| `textureSampleGrad` | `vec4<f32>` | fragment only | explicit grad |
| `textureSampleCompare` | `f32` | fragment only | implicit |
| `textureSampleLevel` | `vec4<f32>` / `f32` (depth) | any stage | explicit level |
| `textureSampleCompareLevel` | `f32` | any stage | explicit level 0 |
| `textureSampleBaseClampToEdge` | `vec4<f32>` | any stage | base level |
| `textureLoad` | `vec4<T>` / `f32` (depth) | any stage | none |
| `textureStore` | nothing | any stage | none |
| `textureGather` | `vec4<f32>` / `vec4<T>` | any stage | none |
| `textureGatherCompare` | `vec4<f32>` | any stage | none |
| `textureDimensions` | `u32` / `vec2<u32>` / `vec3<u32>` | any stage | none |
| `textureNumLayers` | `u32` | any stage | none |
| `textureNumLevels` | `u32` | any stage | none |
| `textureNumSamples` | `u32` | any stage | none |

Full signatures and per-overload coordinate types are in `methods.md`.

## Decision Tree

```
Need a texel value in a shader?
|
+- In a @fragment entry, mip selected automatically by screen-space derivatives?
|    +- Color texture + sampler          -> textureSample
|    +- With LOD bias                    -> textureSampleBias
|    +- With explicit ddx/ddy gradients  -> textureSampleGrad
|    +- Depth texture, shadow comparison -> textureSampleCompare (sampler_comparison)
|
+- In @vertex or @compute (no implicit derivatives available)?
|    +- Filtered sample, you supply the mip level -> textureSampleLevel
|    +- Depth comparison, you supply level 0      -> textureSampleCompareLevel
|    +- Exact texel, integer coords, no filter    -> textureLoad
|
+- Reading a texture_multisampled_2d or texture_storage_* read texture?
|    +- textureLoad  (textureSample is illegal on these types)
|
+- Writing a texel into a texture_storage_* write/read_write texture?
|    +- textureStore
|
+- Need 4-texel footprint for soft shadows / custom filtering?
     +- Color  -> textureGather
     +- Depth  -> textureGatherCompare
```

## Core Patterns

### Pattern 1: ALWAYS use textureSampleLevel or textureLoad outside the fragment stage

`textureSample`, `textureSampleBias`, `textureSampleGrad`, and `textureSampleCompare`
compute screen-space derivatives implicitly. Derivatives only exist in the fragment
stage. ALWAYS replace them with an explicit-level builtin in `@vertex` and `@compute`.

```wgsl
// NEVER in @compute / @vertex: textureSample has no derivatives there.
@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) id : vec3u) {
  // ALWAYS supply the level explicitly outside the fragment stage.
  let texel = textureSampleLevel(srcTex, srcSampler, uv, 0.0);
  // OR: integer-coordinate fetch, no sampler needed.
  let exact = textureLoad(srcTex, vec2i(id.xy), 0);
}
```

### Pattern 2: ALWAYS call textureSample in uniform control flow

`textureSample` requires uniform control flow because all invocations in a quad must
agree on whether the call executes, or derivatives are undefined. NEVER call it inside
an `if`/`switch`/`loop` whose condition varies per invocation. Hoist the sample out, or
use `textureSampleLevel`.

```wgsl
@fragment
fn fs(@location(0) uv : vec2f) -> @location(0) vec4f {
  let color = textureSample(colorTex, colorSampler, uv); // hoisted, uniform
  if (uv.x > someNonUniformValue) {
    return color * 0.5;
  }
  return color;
}
```

### Pattern 3: ALWAYS pair texture_depth_* with sampler_comparison for shadows

A depth texture sampled for shadow comparison MUST use `sampler_comparison` and
`textureSampleCompare`. The host bind-group entry MUST set `sampler.type: "comparison"`
and `texture.sampleType: "depth"`. Using a plain `sampler` with a depth texture is a
shader-creation error.

```wgsl
@group(0) @binding(0) var shadowMap : texture_depth_2d;
@group(0) @binding(1) var shadowSampler : sampler_comparison;

@fragment
fn fs(@location(0) shadowCoord : vec3f) -> @location(0) vec4f {
  // returns 1.0 if shadowCoord.z <= stored depth, else 0.0 (filtered)
  let visible = textureSampleCompare(
    shadowMap, shadowSampler, shadowCoord.xy, shadowCoord.z);
  return vec4f(vec3f(visible), 1.0);
}
```

### Pattern 4: ALWAYS match the storage-texture format and access to the host layout

A `texture_storage_2d<F, A>` declaration MUST use the exact `F` and `A` that the
host `storageTexture` bind-group-layout entry specifies. Write with `textureStore`.
`textureSample` and a sampler are illegal on storage textures.

```wgsl
// Host layout: storageTexture { access: "write-only", format: "rgba8unorm" }
@group(0) @binding(0) var outImg : texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn cs(@builtin(global_invocation_id) id : vec3u) {
  textureStore(outImg, vec2i(id.xy), vec4f(1.0, 0.0, 0.0, 1.0));
}
```

### Pattern 5: ALWAYS make the WGSL handle type match the bind-group-layout entry

The WGSL texture handle type at `@group(g) @binding(b)` MUST correspond to the host
`texture` / `storageTexture` / `externalTexture` entry at the same slot. Mismatches
(dimension, sample type, multisampled flag) fail pipeline validation. See
`webgpu-syntax-bind-groups` for the host side.

| WGSL handle type | Host bind-group-layout entry |
|------------------|------------------------------|
| `texture_2d<f32>` | `texture: { sampleType: "float", viewDimension: "2d" }` |
| `texture_2d<u32>` | `texture: { sampleType: "uint", viewDimension: "2d" }` |
| `texture_depth_2d` | `texture: { sampleType: "depth", viewDimension: "2d" }` |
| `texture_multisampled_2d<f32>` | `texture: { sampleType:"float", multisampled:true }` |
| `texture_storage_2d<rgba8unorm, write>` | `storageTexture: { access:"write-only", format:"rgba8unorm" }` |
| `texture_external` | `externalTexture: {}` |
| `sampler` | `sampler: { type: "filtering" }` |
| `sampler_comparison` | `sampler: { type: "comparison" }` |

### Pattern 6: ALWAYS use textureLoad for multisampled and external textures

`texture_multisampled_2d<T>` and `texture_depth_multisampled_2d` support only
`textureLoad` with an explicit `sample_index`. `texture_external` supports
`textureSampleBaseClampToEdge`, `textureLoad`, and `textureDimensions`.

```wgsl
@group(0) @binding(0) var msaaTex : texture_multisampled_2d<f32>;

@fragment
fn resolve(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  let coord = vec2i(pos.xy);
  // textureLoad takes a sample index for multisampled textures.
  return (textureLoad(msaaTex, coord, 0) + textureLoad(msaaTex, coord, 1)) * 0.5;
}
```

## Common Anti-Patterns

1. Calling `textureSample` from a `@vertex` or `@compute` entry point. It needs
   screen-space derivatives that only the fragment stage has. Use `textureSampleLevel`
   or `textureLoad` instead. Shader-creation error.
2. Using `sampler` instead of `sampler_comparison` with a `texture_depth_*` texture in
   `textureSampleCompare`. The comparison family requires a comparison sampler.
   Shader-creation error.
3. Declaring a storage-texture format or access mode that does not match the host
   `storageTexture` layout entry, or calling `textureSample` on a storage texture.
   Pipeline-creation / shader-creation error.

Full anti-pattern analysis with WHY explanations is in `anti-patterns.md`.

## Critical Warnings

- NEVER call `textureSample`, `textureSampleBias`, `textureSampleGrad`, or
  `textureSampleCompare` outside the fragment stage. Derivatives do not exist there.
- NEVER call `textureSample` in non-uniform control flow. The uniformity analysis
  rejects it or emits a `derivative_uniformity` diagnostic.
- NEVER use a plain `sampler` with `textureSampleCompare`; it requires
  `sampler_comparison`.
- NEVER call `textureStore` on a `texture_storage_*<F, read>` texture; the access mode
  must include `write`.
- NEVER call `textureSample` on `texture_multisampled_2d`, `texture_storage_*`, or
  `texture_external`; only the builtins listed for each type apply.
- NEVER let the WGSL handle type drift from the bind-group-layout entry; dimension,
  sample type, and multisampled flag all MUST match.

## Reference Files

- `methods.md` — every texture handle type, sampler type, and texture
  builtin signature with per-overload coordinate types and stage legality.
- `examples.md` — verified WGSL: fragment sampling, `textureLoad` in compute,
  storage-texture write, depth comparison shadow lookup.
- `anti-patterns.md` — texture mistakes with WHY-it-fails explanations.

### Cross-links

- `webgpu-wgsl-builtins` — full builtin-function and builtin-value catalogue.
- `webgpu-wgsl-uniformity` — uniform control flow and the `derivative_uniformity`
  diagnostic.
- `webgpu-syntax-textures` — host-side `createTexture`, `createSampler`, texture views.
- `webgpu-syntax-bind-groups` — host-side bind-group-layout `texture` / `sampler` /
  `storageTexture` / `externalTexture` entries.
