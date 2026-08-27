# WGSL Fragment Shaders : Anti-Patterns

Each entry states the mistake, WHY it fails, and the fix. Verified against the
W3C WGSL specification (https://www.w3.org/TR/WGSL/) and the W3C WebGPU
specification (https://www.w3.org/TR/webgpu/), 2026-05-20. Baseline: WGSL of
WebGPU 1.0-stable.

## 1. @location output count or format not matching the pipeline targets

```wgsl
// Shader writes two color outputs.
struct FSOut {
  @location(0) a : vec4<f32>,
  @location(1) b : vec4<f32>,
}
@fragment fn fs(in : VSOut) -> FSOut { ... }
```

```js
// Pipeline declares only one target.
fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }
```

WHY IT FAILS: WebGPU validates the fragment shader IO against the render pipeline
state at pipeline creation. The shader writes `@location(1)` but the pipeline has
no target 1, so `createRenderPipeline` throws a `GPUValidationError`. The same
failure occurs when an output type does not match a target format: a `vec4<f32>`
output for a `uint` format, a `vec3<f32>` output for a 4-component format, or a
missing `@location` for a declared target.

FIX: Keep the `@location` output set identical to `fragment.targets` in count and
order. Match each output's scalar base to the target format class: `f32`-based
output for float/unorm/snorm formats, `u32`-based output for `uint` formats,
`i32`-based output for `sint` formats. Use the channel count the format requires.

## 2. Writing @builtin(frag_depth) and expecting early depth-test optimization

```wgsl
struct FSOut {
  @location(0)         color : vec4<f32>,
  @builtin(frag_depth) depth : f32,
}
@fragment fn fs(in : VSOut) -> FSOut {
  var o : FSOut;
  o.color = shade(in);
  o.depth = in.clip_pos.z;   // writing the same depth the rasterizer already had
  return o;
}
```

WHY IT FAILS: The early depth test rejects occluded fragments BEFORE the fragment
shader runs. The GPU can only do that when it knows the fragment's final depth in
advance. The instant the shader declares a `@builtin(frag_depth)` output, the GPU
must assume the shader can produce any depth, so it moves the depth test to AFTER
the shader. Early-Z is disabled for the whole draw and every overdrawn fragment
pays full shading cost. Writing back the rasterizer depth gains nothing and still
pays the early-Z loss.

FIX: NEVER declare a `frag_depth` output unless the shader genuinely computes a
non-default depth (raymarching, impostors, soft particles). When the rasterizer
depth is correct, omit `frag_depth` entirely and let early-Z work. When a custom
depth is unavoidable, accept the early-Z loss and keep the draw's overdraw low.

## 3. Calling discard from a non-fragment stage

```wgsl
@compute @workgroup_size(64)
fn cs(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= count) {
    discard;   // wrong
  }
  ...
}
```

WHY IT FAILS: `discard` is defined only for the fragment stage. It demotes a
fragment invocation so it produces no color or depth output. A `@compute` or
`@vertex` invocation has no fragment to demote, so `discard` has no meaning there
and is a shader-creation error. The shader module fails to compile.

FIX: In a compute shader, use `return;` to exit the invocation early, or guard the
work with an `if`. In a vertex shader there is no per-vertex discard; cull the
primitive on the host or move it offscreen. Reserve `discard` for `@fragment`
entry points and functions reachable only from them.

## 4. Assuming front_facing depends on winding without the pipeline frontFace

```wgsl
@fragment
fn fs(in : VSOut, @builtin(front_facing) ff : bool) -> @location(0) vec4<f32> {
  // Code assumes ff is true for counter-clockwise triangles, always.
  let n = select(in.back_normal, in.front_normal, ff);
  return shade(n);
}
```

WHY IT FAILS: `@builtin(front_facing)` is `true` when the primitive faces the
viewer per the pipeline's `primitive.frontFace` setting. `frontFace` can be
`"ccw"` or `"cw"`. The same triangle gives the opposite `front_facing` value if a
second pipeline sets the other `frontFace`, or if the geometry is mirrored by a
negative-scale model matrix. Code that hardcodes the winding-to-facing mapping
picks the wrong normal in those cases, producing inverted lighting.

FIX: Treat `front_facing` as the single source of truth and never re-derive
facing from winding. Keep the pipeline `primitive.frontFace` consistent with the
mesh data, and where mirrored instances exist, rely on `front_facing` rather than
the winding so the normal flip stays correct.

## 5. Reading @builtin(position) as clip space in the fragment stage

```wgsl
@fragment
fn fs(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> {
  let ndc = pos.xy / pos.w;   // wrong: pos is already in framebuffer space
  return vec4<f32>(ndc, 0.0, 1.0);
}
```

WHY IT FAILS: The vertex-stage `@builtin(position)` is in clip space, but the
fragment-stage `@builtin(position)` is the framebuffer-space pixel coordinate. The
host already performed the perspective divide. Dividing by `.w` again (where `.w`
is `1.0 / clip.w`) corrupts the coordinate.

FIX: Use the fragment `@builtin(position).xy` directly as the pixel coordinate.
Divide by the render-target size to get `[0, 1]` UVs. Do not perform a perspective
divide on the fragment-stage position.

## 6. Calling textureSample or a derivative in non-uniform control flow

```wgsl
@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  if (in.uv.x > 0.5) {
    return textureSample(tex, samp, in.uv);   // non-uniform branch
  }
  return vec4<f32>(0.0);
}
```

WHY IT FAILS: `textureSample`, `dpdx`, `dpdy`, and `fwidth` compute screen-space
derivatives from neighboring fragment invocations in a 2x2 quad. When the call
sits inside a branch whose condition varies across the quad, some neighbors are
not running the call, so the derivative is undefined. WGSL reports this as a
`derivative_uniformity` diagnostic and the implementation may treat it as an
error.

FIX: Hoist the `textureSample` or derivative call out of the non-uniform branch so
it always executes, then select the result with `select` or a uniform branch. If
a per-branch sample is unavoidable, use `textureSampleLevel` with an explicit LOD,
which computes no derivative. See `webgpu-wgsl-uniformity`.
