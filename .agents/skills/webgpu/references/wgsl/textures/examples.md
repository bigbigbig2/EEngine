# WGSL Texture Examples

All WGSL below targets WebGPU 1.0-stable (WGSL spec). Each example is verified against
the W3C WGSL specification and the WebGPU samples. Host-side bind-group-layout entries
are shown as comments so the WGSL handle type and the host layout stay in sync.

## Example 1: Sampling a color texture in the fragment stage

`textureSample` selects the mip level from screen-space derivatives. It is legal only
in `@fragment` and only in uniform control flow.

```wgsl
// Host bind-group-layout entries:
//   binding 0: texture: { sampleType: "float", viewDimension: "2d" }
//   binding 1: sampler: { type: "filtering" }
@group(0) @binding(0) var colorTex     : texture_2d<f32>;
@group(0) @binding(1) var colorSampler : sampler;

struct VSOut {
  @builtin(position) clip_pos : vec4f,
  @location(0)       uv       : vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  // Full-screen triangle.
  let p = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out : VSOut;
  out.clip_pos = vec4f(p[vi], 0.0, 1.0);
  out.uv       = p[vi] * 0.5 + 0.5;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  // textureSample: fragment-only, uniform control flow.
  return textureSample(colorTex, colorSampler, in.uv);
}
```

## Example 2: textureLoad in a compute shader

`textureSample` is illegal in `@compute`. `textureLoad` reads an exact texel by integer
coordinates with no sampler and no derivatives, so it is legal in any stage.

```wgsl
// Host bind-group-layout entries:
//   binding 0: texture: { sampleType: "float", viewDimension: "2d" }
//   binding 1: storageTexture: { access: "write-only", format: "rgba8unorm" }
@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var dstTex : texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn invert(@builtin(global_invocation_id) gid : vec3u) {
  let dims = textureDimensions(srcTex);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }
  let coord  = vec2i(gid.xy);
  // textureLoad: no sampler, explicit mip level 0.
  let texel  = textureLoad(srcTex, coord, 0);
  let result = vec4f(1.0 - texel.rgb, texel.a);
  textureStore(dstTex, coord, result);
}
```

## Example 3: Filtered sampling in a vertex shader with textureSampleLevel

A vertex shader has no derivatives. Displacement mapping must read the height texture
with an explicit mip level via `textureSampleLevel`.

```wgsl
// Host bind-group-layout entries (visibility includes VERTEX):
//   binding 0: texture: { sampleType: "float", viewDimension: "2d" }
//   binding 1: sampler: { type: "filtering" }
@group(0) @binding(0) var heightTex     : texture_2d<f32>;
@group(0) @binding(1) var heightSampler : sampler;

struct VSOut {
  @builtin(position) clip_pos : vec4f,
}

@vertex
fn vs(@location(0) pos : vec3f, @location(1) uv : vec2f) -> VSOut {
  // textureSampleLevel: explicit level, legal in the vertex stage.
  let height = textureSampleLevel(heightTex, heightSampler, uv, 0.0).r;
  var out : VSOut;
  out.clip_pos = vec4f(pos.x, pos.y + height, pos.z, 1.0);
  return out;
}
```

## Example 4: Writing a storage texture in a compute shader

A `texture_storage_2d<F, write>` is written with `textureStore`. The WGSL format and
access mode MUST match the host `storageTexture` layout entry.

```wgsl
// Host bind-group-layout entry:
//   binding 0: storageTexture: { access: "write-only", format: "rgba16float" }
@group(0) @binding(0) var output : texture_storage_2d<rgba16float, write>;

struct Params { time : f32 }
@group(0) @binding(1) var<uniform> params : Params;

@compute @workgroup_size(8, 8)
fn gradient(@builtin(global_invocation_id) gid : vec3u) {
  let dims = textureDimensions(output);
  if (gid.x >= dims.x || gid.y >= dims.y) {
    return;
  }
  let uv    = vec2f(gid.xy) / vec2f(dims);
  let color = vec4f(uv.x, uv.y, fract(params.time), 1.0);
  // textureStore: writes one texel, returns nothing.
  textureStore(output, vec2i(gid.xy), color);
}
```

## Example 5: Depth comparison for shadow mapping

A shadow map is a `texture_depth_2d` sampled with `sampler_comparison` via
`textureSampleCompare`. The host layout MUST use `sampleType: "depth"` and the sampler
entry MUST use `type: "comparison"`.

```wgsl
// Host bind-group-layout entries:
//   binding 0: texture: { sampleType: "depth", viewDimension: "2d" }
//   binding 1: sampler: { type: "comparison" }
@group(0) @binding(0) var shadowMap     : texture_depth_2d;
@group(0) @binding(1) var shadowSampler : sampler_comparison;

struct FSIn {
  @builtin(position) frag_pos    : vec4f,
  @location(0)       shadowCoord : vec3f, // xy = uv in [0,1], z = depth ref
}

@fragment
fn fs(in : FSIn) -> @location(0) vec4f {
  // textureSampleCompare returns the filtered fraction of texels that pass.
  // depth_ref (in.shadowCoord.z) is compared against the stored depth.
  let lit = textureSampleCompare(
    shadowMap, shadowSampler, in.shadowCoord.xy, in.shadowCoord.z);
  let baseColor = vec3f(0.8, 0.7, 0.6);
  return vec4f(baseColor * (0.2 + 0.8 * lit), 1.0);
}
```

### Compute-stage variant: textureSampleCompareLevel

Inside a compute pass (no derivatives), use `textureSampleCompareLevel`, which always
samples mip level 0 and is legal in any stage.

```wgsl
@group(0) @binding(0) var shadowMap     : texture_depth_2d;
@group(0) @binding(1) var shadowSampler : sampler_comparison;

@compute @workgroup_size(8, 8)
fn occlusion(@builtin(global_invocation_id) gid : vec3u) {
  let uv  = vec2f(gid.xy) / 1024.0;
  let ref = 0.5;
  // textureSampleCompareLevel: explicit level 0, legal in compute.
  let lit = textureSampleCompareLevel(shadowMap, shadowSampler, uv, ref);
  // ... write lit into a storage buffer or storage texture
}
```

## Example 6: Soft shadows with textureGatherCompare

`textureGatherCompare` returns the four comparison results of the 2x2 footprint, useful
for percentage-closer filtering. It is legal in any stage because it does not need a
derivative-selected mip.

```wgsl
@group(0) @binding(0) var shadowMap     : texture_depth_2d;
@group(0) @binding(1) var shadowSampler : sampler_comparison;

@fragment
fn fs(@location(0) shadowCoord : vec3f) -> @location(0) vec4f {
  // Four comparison results, one per texel in the 2x2 neighbourhood.
  let g = textureGatherCompare(
    shadowMap, shadowSampler, shadowCoord.xy, shadowCoord.z);
  let lit = (g.x + g.y + g.z + g.w) * 0.25;
  return vec4f(vec3f(lit), 1.0);
}
```

## Example 7: Reading a multisampled texture with textureLoad

`texture_multisampled_2d<T>` supports only `textureLoad` with an explicit
`sample_index`; `textureSample` is illegal on it.

```wgsl
// Host bind-group-layout entry:
//   binding 0: texture: { sampleType: "float", multisampled: true }
@group(0) @binding(0) var msaaTex : texture_multisampled_2d<f32>;

@fragment
fn manualResolve(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  let coord   = vec2i(pos.xy);
  let samples = textureNumSamples(msaaTex);
  var sum     = vec4f(0.0);
  for (var i : u32 = 0u; i < samples; i = i + 1u) {
    sum = sum + textureLoad(msaaTex, coord, i32(i));
  }
  return sum / f32(samples);
}
```

## Example 8: Sampling a texture array layer

`texture_2d_array<f32>` takes an extra `array_index` argument that selects the layer.

```wgsl
// Host bind-group-layout entry:
//   binding 0: texture: { sampleType: "float", viewDimension: "2d-array" }
@group(0) @binding(0) var atlas        : texture_2d_array<f32>;
@group(0) @binding(1) var atlasSampler : sampler;

@fragment
fn fs(@location(0) uv : vec2f, @location(1) @interpolate(flat) layer : u32)
  -> @location(0) vec4f {
  // array_index selects the layer; legal index range is [0, numLayers).
  return textureSample(atlas, atlasSampler, uv, layer);
}
```
