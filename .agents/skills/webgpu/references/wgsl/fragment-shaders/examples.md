# WGSL Fragment Shaders : Examples

Verified WGSL for WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).
Every example is verified against the W3C WGSL specification
(https://www.w3.org/TR/WGSL/), 2026-05-20.

## Example 1 : Single color-output fragment shader

A textured fragment shader writing one `@location(0)` color target. The varying
struct `VSOut` is produced by the vertex stage.

```wgsl
struct VSOut {
  @builtin(position) clip_pos : vec4<f32>,
  @location(0)       uv       : vec2<f32>,
  @location(1)       normal   : vec3<f32>,
}

@group(0) @binding(0) var base_tex  : texture_2d<f32>;
@group(0) @binding(1) var base_samp : sampler;

@fragment
fn fs_main(in : VSOut, @builtin(front_facing) front : bool) -> @location(0) vec4<f32> {
  // Flip the normal for back faces of a double-sided material.
  let n = select(-in.normal, in.normal, front);
  let light_dir = normalize(vec3<f32>(0.4, 0.8, 0.3));
  let diffuse = max(dot(normalize(n), light_dir), 0.0);

  // textureSample is fragment-stage only and needs uniform control flow.
  let albedo = textureSample(base_tex, base_samp, in.uv);
  return vec4<f32>(albedo.rgb * (0.2 + 0.8 * diffuse), albedo.a);
}
```

The matching pipeline declares exactly one `fragment.targets` entry whose `format`
is a 4-component color format (for example `rgba8unorm`), so the `vec4<f32>`
output is valid.

### Alpha-cutout variant with discard

```wgsl
@fragment
fn fs_cutout(in : VSOut) -> @location(0) vec4<f32> {
  let albedo = textureSample(base_tex, base_samp, in.uv);
  // discard demotes the invocation; it keeps running so derivatives stay valid.
  if (albedo.a < 0.5) {
    discard;
  }
  return albedo;
}
```

## Example 2 : MRT G-buffer fragment shader

A deferred-shading geometry pass writes three color attachments in one render
pass. Each `@location(n)` member maps to `pipeline.fragment.targets[n]`.

```wgsl
struct VSOut {
  @builtin(position) clip_pos    : vec4<f32>,
  @location(0)       world_pos   : vec3<f32>,
  @location(1)       world_norm  : vec3<f32>,
  @location(2)       uv          : vec2<f32>,
}

struct GBuffer {
  @location(0) albedo   : vec4<f32>,   // target 0 : rgba8unorm
  @location(1) normal   : vec4<f32>,   // target 1 : rgba16float
  @location(2) position : vec4<f32>,   // target 2 : rgba16float
}

@group(0) @binding(0) var albedo_tex : texture_2d<f32>;
@group(0) @binding(1) var albedo_smp : sampler;

@fragment
fn fs_gbuffer(in : VSOut) -> GBuffer {
  var out : GBuffer;
  out.albedo   = textureSample(albedo_tex, albedo_smp, in.uv);
  out.normal   = vec4<f32>(normalize(in.world_norm), 0.0);
  out.position = vec4<f32>(in.world_pos, 1.0);
  return out;
}
```

The pipeline's `fragment.targets` array has exactly three entries, in the same
order, with formats that accept `vec4<f32>` outputs. A count or format mismatch
fails pipeline creation.

## Example 3 : Depth-output fragment shader

A fragment shader that overrides depth via `@builtin(frag_depth)`, used for
impostors, soft particles, or raymarched surfaces. Writing `frag_depth` disables
early depth testing for the draw.

```wgsl
struct VSOut {
  @builtin(position) clip_pos : vec4<f32>,
  @location(0)       uv       : vec2<f32>,
}

struct FSOut {
  @location(0)         color : vec4<f32>,
  @builtin(frag_depth) depth : f32,
}

struct Camera {
  near : f32,
  far  : f32,
}
@group(0) @binding(0) var<uniform> cam : Camera;

@fragment
fn fs_depth(in : VSOut) -> FSOut {
  var out : FSOut;

  // Round impostor: discard outside the disc.
  let centered = in.uv * 2.0 - vec2<f32>(1.0, 1.0);
  let r2 = dot(centered, centered);
  if (r2 > 1.0) {
    discard;
  }

  // Push depth back by the sphere bulge, mapped into the [0, 1] depth range.
  let bulge = sqrt(1.0 - r2);
  let view_z = mix(cam.near, cam.far, 0.5) - bulge;
  out.depth = clamp((view_z - cam.near) / (cam.far - cam.near), 0.0, 1.0);

  out.color = vec4<f32>(vec3<f32>(bulge), 1.0);
  return out;
}
```

The matching pipeline MUST declare a `depthStencil` state with a depth format and
`depthWriteEnabled: true` for the `frag_depth` write to take effect.

## Example 4 : Sample-rate shading fragment shader

Reading `@builtin(sample_index)` triggers per-sample shading. The pipeline must
declare `multisample.count: 4` and render into a 4-sample color attachment.

```wgsl
struct VSOut {
  @builtin(position) clip_pos : vec4<f32>,
  @location(0)       uv       : vec2<f32>,
}

@fragment
fn fs_persample(
  in : VSOut,
  @builtin(sample_index) sample : u32,
) -> @location(0) vec4<f32> {
  // Reading sample_index makes the shader run once per MSAA sample.
  let tint = f32(sample) / 3.0;
  return vec4<f32>(in.uv, tint, 1.0);
}
```

## Example 5 : Coverage control via @builtin(sample_mask) output

Writing `@builtin(sample_mask)` drops samples without `discard`. The hardware ANDs
the written mask with the existing coverage.

```wgsl
struct FSOut {
  @location(0)            color : vec4<f32>,
  @builtin(sample_mask)   mask  : u32,
}

@fragment
fn fs_coverage(@builtin(position) pos : vec4<f32>) -> FSOut {
  var out : FSOut;
  out.color = vec4<f32>(1.0, 0.5, 0.2, 1.0);
  // Keep every sample. Clearing a bit drops that sample.
  out.mask = 0xFFFFFFFFu;
  return out;
}
```

## Example 6 : Depth-only fragment pass (shadow map)

A shadow-map depth pass renders only depth, so the `@fragment` function has no
color or depth output and returns nothing. The pipeline declares an empty
`fragment.targets` array (or omits `fragment` entirely) and a `depthStencil`
state.

```wgsl
struct VSOut {
  @builtin(position) clip_pos : vec4<f32>,
}

@fragment
fn fs_shadow(in : VSOut) {
  // No output. Depth is written from the rasterizer-interpolated position.
}
```
