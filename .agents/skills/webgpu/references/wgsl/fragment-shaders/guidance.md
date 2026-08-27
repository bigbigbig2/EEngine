# WGSL Fragment Shaders

Write a WGSL `@fragment` entry point that produces color, depth, and coverage
outputs that match the render pipeline, without target mismatches or losing early-Z.

## Quick Reference

WGSL is the shading language of WebGPU 1.0-stable (Chrome 113+, Safari 26+,
Firefox 141+). A fragment shader runs once per rasterized fragment. It is marked
`@fragment` and may not be called from other WGSL code.

### Fragment IO

| Slot | Direction | `@builtin` / `@location` | Type | Notes |
|------|-----------|--------------------------|------|-------|
| Pixel coordinate | input | `@builtin(position)` | `vec4<f32>` | Framebuffer-space pixel coord, not clip space |
| Facing | input | `@builtin(front_facing)` | `bool` | Depends on pipeline `primitive.frontFace` |
| Sample index | input | `@builtin(sample_index)` | `u32` | Reading it triggers sample-rate shading |
| Sample mask | input | `@builtin(sample_mask)` | `u32` | Coverage mask delivered to the shader |
| Varyings | input | `@location(n)` | scalar/vec | Interpolated from the vertex stage |
| Color target | output | `@location(n)` | scalar/vec | One per pipeline `fragment.targets` entry |
| Depth | output | `@builtin(frag_depth)` | `f32` | Overrides rasterizer depth, disables early-Z |
| Sample mask | output | `@builtin(sample_mask)` | `u32` | ANDs with coverage to drop samples |

`@builtin(sample_mask)` is the one builtin that is both input and output.
The interpolated varying struct is described in `webgpu-wgsl-vertex-shaders`.

### Entry point form

```wgsl
@fragment fn fs(in : VSOut) -> @location(0) vec4<f32> { ... }
```

The fragment input struct is the SAME struct the vertex stage returns. Each
`@location` color output type and component count must match the format of the
matching `GPUColorTargetState` in `pipeline.fragment.targets`.

## Decision Tree

```
What does the fragment shader produce?
├── One color, no depth override
│   └── return @location(0) vec4<f32>            (single target)
├── Multiple color attachments (G-buffer, deferred shading)
│   └── return a struct with @location(0), @location(1), ...
│       one @location per colorAttachment, formats must match
├── Needs to override depth (raymarch, impostor, soft particles)
│   └── add @builtin(frag_depth) : f32 to the output struct
│       NOTE: this disables early depth testing for the whole draw
├── Needs to drop the fragment entirely (alpha cutout, clipping)
│   └── call discard;  (NEVER from @vertex or @compute)
└── Needs per-sample shading (MSAA edge AA on shaded result)
    └── read @builtin(sample_index) OR declare @interpolate(perspective, sample)
```

## Core Patterns

### ALWAYS match @location output count and format to the pipeline targets

Each `@location(n)` color output maps to `pipeline.fragment.targets[n]`. The output
type and component count must agree with that target's `format` (a `vec4<f32>`
output for an `rgba8unorm` target, a `vec4<u32>` output for an `rgba32uint`
target). A count or format mismatch fails pipeline creation.

```wgsl
@fragment fn fs(in : VSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(in.uv, 0.0, 1.0);   // target 0 must be a 4-component color format
}
```

### ALWAYS return a struct with one @location per attachment for MRT

Multiple render targets write several color attachments in one pass. The fragment
output struct holds one `@location(n)` member per attachment, in order.

```wgsl
struct GBuffer {
  @location(0) albedo : vec4<f32>,
  @location(1) normal : vec4<f32>,
}
@fragment fn fs(in : VSOut) -> GBuffer { ... }
```

### NEVER write @builtin(frag_depth) when you still want early depth testing

Writing `@builtin(frag_depth)` overrides the rasterizer-computed depth. The GPU
cannot know the final depth before running the shader, so it disables the early
depth test for the whole draw. Omit `frag_depth` unless the shader genuinely
computes a non-default depth.

```wgsl
struct FSOut {
  @location(0) color : vec4<f32>,
  @builtin(frag_depth) depth : f32,   // early-Z is now off for this draw
}
```

### ALWAYS treat front_facing as defined by the pipeline frontFace setting

`@builtin(front_facing)` is `true` when the primitive faces the viewer per the
pipeline's `primitive.frontFace` (`"ccw"` or `"cw"`). It is NOT a fixed function
of triangle winding alone. Use it to flip normals for double-sided materials.

```wgsl
@fragment fn fs(in : VSOut, @builtin(front_facing) ff : bool) -> @location(0) vec4<f32> {
  let n = select(-in.normal, in.normal, ff);
  return vec4<f32>(n * 0.5 + 0.5, 1.0);
}
```

### ALWAYS use discard to drop a fragment, knowing the invocation keeps running

`discard` demotes the invocation: no further memory writes and no color or depth
output occur. The invocation KEEPS running so neighboring derivatives stay valid.
`discard` is a fragment-stage statement only.

```wgsl
@fragment fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let texel = textureSample(tex, samp, in.uv);
  if (texel.a < 0.5) { discard; }    // derivatives still valid for non-discarded lanes
  return texel;
}
```

### ALWAYS trigger sample-rate shading by reading sample_index or @interpolate(..., sample)

Sample-rate shading runs the fragment shader once per MSAA sample instead of once
per pixel. It is triggered when the shader reads `@builtin(sample_index)` or
declares a varying with `@interpolate(perspective, sample)`. Use it only when
per-sample shading is needed, since it multiplies fragment cost by the sample count.

## Common Anti-Patterns

1. `@location` output count or format not matching `pipeline.fragment.targets`.
   WHY it fails: WebGPU validates the shader IO against the pipeline state at
   pipeline creation. A missing target, an extra `@location`, or a `vec3<f32>`
   output for a 4-component format makes pipeline creation throw a validation
   error.

2. Writing `@builtin(frag_depth)` and expecting early depth-test optimization.
   WHY it fails: explicit depth output forces the depth test after the fragment
   shader runs, so early-Z is disabled and overdrawn fragments still pay full
   shading cost.

3. Calling `discard` from a `@vertex` or `@compute` entry point. WHY it fails:
   `discard` is defined only for the fragment stage. There is no fragment to
   demote elsewhere, so it is a shader-creation error.

## Critical Warnings

- NEVER let the `@location` output set differ from the pipeline `fragment.targets`
  in count, order, or format.
- NEVER write `@builtin(frag_depth)` unless the depth-stencil state writes depth
  and you accept that early depth testing is disabled.
- NEVER call `discard` outside a `@fragment` entry point.
- NEVER assume `@builtin(front_facing)` depends on winding alone; it depends on
  the pipeline `primitive.frontFace`.
- NEVER read `@builtin(position)` in the fragment stage as clip space; it is the
  framebuffer-space pixel coordinate.
- NEVER call `textureSample`, `dpdx`, `dpdy`, or `fwidth` in non-uniform control
  flow; they are fragment-stage builtins that need uniform control flow. See
  `webgpu-wgsl-uniformity`.

## Reference Files

- `methods.md` : the `@fragment` entry point form, fragment builtins,
  MRT outputs, sample-rate shading, and the `discard` statement.
- `examples.md` : verified WGSL for a single-color fragment shader,
  an MRT G-buffer shader, and a depth-output shader.
- `anti-patterns.md` : fragment-shader mistakes with WHY-it-fails
  explanations.

## Related Skills

- `webgpu-wgsl-vertex-shaders` : the vertex stage that produces the varying struct.
- `webgpu-wgsl-uniformity` : uniform control flow for `textureSample` and
  derivatives.
- `webgpu-syntax-render-pipeline` : `fragment.targets`, `primitive.frontFace`,
  `multisample` state.
- `webgpu-impl-render-targets` : color attachments, MRT, depth attachments.
