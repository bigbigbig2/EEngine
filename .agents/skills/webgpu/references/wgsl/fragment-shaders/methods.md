# WGSL Fragment Shaders : Methods Reference

Verified against the W3C WGSL specification (https://www.w3.org/TR/WGSL/) and the
WGSL editor's draft (https://gpuweb.github.io/gpuweb/wgsl/), 2026-05-20. Baseline:
WGSL of WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## The @fragment entry point

A fragment shader is a function marked `@fragment`. It runs once per rasterized
fragment (or once per sample under sample-rate shading). It may not be called from
other WGSL code. A shader module may hold one or many entry points; the pipeline
selects one by `fragment.entryPoint`.

### Entry point form

```wgsl
@fragment fn <name>(<inputs>) -> <output> { <body> }
```

- `<inputs>` : zero or more parameters carrying `@builtin(...)` or `@location(n)`,
  or a single struct whose members carry those attributes. The interpolated
  varying struct is the SAME struct the vertex stage returns.
- `<output>` : either a single value carrying one `@location(n)` or
  `@builtin(...)`, or a struct of such members. A `@fragment` function with no
  color or depth output returns nothing (used for depth-only or coverage-only
  passes).
- Attributes valid on fragment parameters and return members: `@builtin`,
  `@location`, `@interpolate`. NEVER place `@location` and `@builtin` on the same
  member.

### Input from the vertex stage

The fragment input is the interpolated varying struct produced by the vertex
stage. Each `@location(n)` member is interpolated across the primitive by the
rasterizer. Integer varyings MUST carry `@interpolate(flat)`. The vertex-stage
`@builtin(position)` (clip space) is consumed by the rasterizer and re-presented
to the fragment stage as `@builtin(position)` in framebuffer space.

## Fragment builtin values

`@builtin(name)` binds an entry-point parameter or return member to a system
value. Verified fragment-stage table:

| Builtin | Direction | Type | Meaning |
|---------|-----------|------|---------|
| `position` | input | `vec4<f32>` | Framebuffer-space pixel coordinate. `.xy` is the pixel center, `.z` is the interpolated depth, `.w` is `1.0 / clip.w`. NOT clip space. |
| `front_facing` | input | `bool` | `true` when the primitive faces the viewer per the pipeline `primitive.frontFace`. |
| `sample_index` | input | `u32` | Index of the current sample, in `0 .. sampleCount - 1`. Reading it triggers sample-rate shading. |
| `sample_mask` | input | `u32` | Coverage mask delivered to this invocation. Bit `i` is set when sample `i` is covered. |
| `frag_depth` | output | `f32` | Overrides the rasterizer-computed depth used for the depth test. |
| `sample_mask` | output | `u32` | Coverage mask written by the shader. The hardware ANDs it with the existing coverage. |

`@builtin(sample_mask)` is the only fragment builtin that is both an input and an
output. All core fragment builtins are part of WGSL 1.0 with no feature gate.

### @builtin(position) details

In the fragment stage `@builtin(position)` is the render-target coordinate of the
fragment, not clip space. The host already performed the perspective divide. Use
`position.xy` for screen-space effects and `position.z` to read the fragment's
pre-shader depth.

### @builtin(front_facing) details

`front_facing` depends on the pipeline `primitive.frontFace` setting (`"ccw"` or
`"cw"`), not on triangle winding in isolation. Flipping `frontFace` flips the
value for the same geometry. Use it to flip normals for double-sided materials.

### @builtin(frag_depth) details

Writing `frag_depth` overrides the depth produced by the rasterizer for the depth
test. It is meaningful ONLY when the pipeline has a `depthStencil` state with
`depthWriteEnabled: true` or a non-`"always"` `depthCompare`. Writing it disables
early depth testing: the GPU cannot determine the final depth before the fragment
shader runs, so the depth test moves after shading and overdrawn fragments still
pay shading cost.

### @builtin(sample_mask) details

As an input, `sample_mask` reports which MSAA samples this invocation covers.
As an output, the shader writes a mask; the hardware ANDs the written mask with
the coverage so a sample whose bit is cleared is not written. Writing
`sample_mask` is a way to implement custom coverage (alpha-to-coverage style
effects) without `discard`.

## MRT outputs

Multiple render targets write several color attachments in a single render pass.
The fragment output is a struct with one `@location(n)` member per color
attachment, in ascending order:

```wgsl
struct GBuffer {
  @location(0) albedo   : vec4<f32>,
  @location(1) normal   : vec4<f32>,
  @location(2) material : vec4<f32>,
}
@fragment fn fs(in : VSOut) -> GBuffer { ... }
```

Rules:

- The set of `@location` outputs must match `pipeline.fragment.targets` in count
  and order. Target `n` is written by `@location(n)`.
- Each output type and component count must agree with the matching target
  `format`. A floating-point format takes an `f32`-based output, a `uint` format
  takes a `u32`-based output, a `sint` format takes an `i32`-based output.
- The number of color attachments is bounded by `device.limits.maxColorAttachments`
  and the per-sample byte budget `maxColorAttachmentBytesPerSample`.
- Each target's `writeMask` (a `GPUColorWrite` bitmask) further gates which color
  channels are written, independent of the shader.

## Sample-rate shading

By default the fragment shader runs once per pixel and the result is broadcast to
all covered MSAA samples. Sample-rate shading runs the shader once per sample
instead. It is triggered when EITHER:

- the shader reads `@builtin(sample_index)`, OR
- the shader declares an inter-stage varying with `@interpolate(perspective, sample)`.

Under sample-rate shading the `@interpolate` `sample` sampling value evaluates the
varying at the exact sample location. The other sampling values are: `center`
(the default, pixel center), `centroid` (a location inside the covered area),
`first` and `either` (valid only with `@interpolate(flat)`). Only `sample`
forces per-sample evaluation. Sample-rate shading multiplies fragment cost by the
sample count; use it only when per-sample shading quality is required.

## The discard statement

`discard;` is a fragment-stage statement. It demotes the current invocation:

- No further memory writes occur for the invocation.
- No color outputs and no depth output are written.
- The invocation KEEPS running. It is not terminated. This keeps the invocation
  participating in derivative computation, so `dpdx` / `dpdy` / `fwidth` and
  `textureSample` in neighboring non-discarded invocations stay valid.

`discard` is legal ONLY inside a `@fragment` entry point or a function reachable
only from a `@fragment` entry point. Calling it from a `@vertex` or `@compute`
entry point is a shader-creation error.

## Fragment-stage-only builtins

These builtins are legal ONLY in the fragment stage and require uniform control
flow (see `webgpu-wgsl-uniformity`):

- Implicit-derivative texture builtins: `textureSample`, `textureSampleBias`,
  `textureSampleCompare`, `textureGather`, `textureGatherCompare`.
- Derivative builtins: `dpdx`, `dpdy`, `fwidth` and their `Coarse` / `Fine`
  variants.

From a `@vertex` or `@compute` entry point use `textureSampleLevel`,
`textureSampleGrad`, or `textureLoad` instead, which take an explicit level or
gradient and compute no derivative.
