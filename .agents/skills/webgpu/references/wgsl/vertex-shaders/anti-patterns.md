# WGSL Vertex Shaders: Anti-Patterns

Each entry is a real mistake, the symptom it produces, WHY it fails against the
WGSL and WebGPU specifications, and the correct fix. Verified against
https://www.w3.org/TR/WGSL/, https://www.w3.org/TR/webgpu/, and
`docs/research/vooronderzoek-webgpu.md` PART B sections 5, 6, 9.

## Anti-pattern 1: Integer inter-stage variable without @interpolate(flat)

```wgsl
// WRONG: u32 varying with no @interpolate.
struct VSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) material_id: u32,
}
```

WHY it fails: inter-stage `@location` variables are interpolated by the rasterizer
across each primitive. Integer types (`i32`, `u32`, and vectors of them) have no
meaningful interpolation, so the WGSL specification requires every integer varying
to be `@interpolate(flat)`. An integer varying without `flat` is rejected at shader
creation; `device.createShaderModule` reports a compilation error.

FIX: add `@interpolate(flat)` to every integer varying.

```wgsl
struct VSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) @interpolate(flat) material_id: u32,
}
```

## Anti-pattern 2: @location(n) not matching the host shaderLocation

```wgsl
// WRONG: the @vertex fn declares @location(0) and @location(1),
// but the host GPUVertexBufferLayout only declares shaderLocation 0 and 2.
@vertex fn vs(@location(0) position: vec3f,
              @location(1) uv: vec2f) -> VSOut { /* ... */ }
```

WHY it fails: the WebGPU specification matches each WGSL `@location(n)` vertex input
to the `GPUVertexBufferLayout` attribute whose `shaderLocation` equals `n`. If the
shader declares a `@location` that no buffer layout provides, pipeline creation
fails validation with a message that the vertex input at that location is not
supplied. If a number is provided but the `format` is incompatible with the WGSL
type (for example `uint32` feeding a `vec3f` parameter), validation also fails.
Even when validation passes, a mismatched layout makes the shader read the wrong
bytes, producing distorted geometry or a blank canvas.

FIX: keep the WGSL `@location(n)` numbers and the host `shaderLocation` numbers
identical, and keep each attribute `format` compatible with its WGSL parameter type.
The host layout is owned by `webgpu-syntax-render-pipeline`; verify the two sides
agree.

## Anti-pattern 3: Forgetting @builtin(position) in the output

```wgsl
// WRONG: the output struct has no @builtin(position).
struct VSOut {
  @location(0) uv: vec2f,
}
@vertex fn vs(@location(0) pos: vec3f, @location(1) uv: vec2f) -> VSOut {
  return VSOut(uv);
}
```

WHY it fails: the WGSL specification requires every `@vertex` entry point to output
`@builtin(position): vec4f`. The rasterizer has no clip-space vertex without it, so
there is nothing to rasterize. `device.createShaderModule` reports a compilation
error that the vertex stage is missing the `position` builtin.

FIX: include `@builtin(position): vec4f` in the output, computed in clip space.

```wgsl
struct VSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) uv: vec2f,
}
@vertex fn vs(@location(0) pos: vec3f, @location(1) uv: vec2f) -> VSOut {
  return VSOut(vec4f(pos, 1.0), uv);
}
```

## Anti-pattern 4: Assuming a WebGL clip-space Z range of -1 to 1

```wgsl
// WRONG: a projection matrix built for OpenGL/WebGL clip space.
// OpenGL maps the near plane to z = -1 and the far plane to z = +1.
out.clip_pos = opengl_style_projection * vec4f(position, 1.0);
```

WHY it fails: WebGPU clip space uses a Z range of 0 to 1, not -1 to 1. A projection
matrix copied from WebGL/OpenGL maps the near plane to `z = -w` instead of `z = 0`.
After the host divides by `w`, half the depth range is below 0 and gets clipped, so
near geometry disappears, the depth buffer is wrong, and depth testing produces
incorrect occlusion. The shader compiles, so the failure is silent and visual.

FIX: build the projection matrix for the WebGPU 0-to-1 Z range, or apply a
correction matrix that remaps `[-1, 1]` to `[0, 1]`. WebGPU also uses Y up in
normalized device coordinates; account for that when porting.

## Anti-pattern 5: Putting @location and @builtin on the same member

```wgsl
// WRONG: a member cannot carry both @location and @builtin.
struct VSOut {
  @builtin(position) @location(0) clip_pos: vec4f,
}
```

WHY it fails: `@location` declares a user IO slot and `@builtin` binds a system
value. They are mutually exclusive on one struct member or parameter. The WGSL
specification rejects a member carrying both as a shader-creation error.

FIX: give the builtin and each user varying their own member.

```wgsl
struct VSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) uv: vec2f,
}
```

## Anti-pattern 6: Calling fragment-only builtins from @vertex

```wgsl
// WRONG: textureSample and dpdx are fragment-stage only.
@vertex fn vs(@location(0) pos: vec3f) -> @builtin(position) vec4f {
  let h = textureSample(heightMap, samp, pos.xy).r; // invalid in @vertex
  return vec4f(pos.x, h, pos.z, 1.0);
}
```

WHY it fails: `textureSample`, `textureSampleBias`, `dpdx`, `dpdy`, and `fwidth`
compute implicit derivatives, which only exist in the fragment stage. The WGSL
specification restricts them to `@fragment`. Using them in `@vertex` is a
shader-creation error.

FIX: from a vertex shader, sample with an explicit level using `textureSampleLevel`
or fetch a texel directly with `textureLoad`.

```wgsl
@vertex fn vs(@location(0) pos: vec3f) -> @builtin(position) vec4f {
  let h = textureSampleLevel(heightMap, samp, pos.xy, 0.0).r;
  return vec4f(pos.x, h, pos.z, 1.0);
}
```

## Anti-pattern 7: Vertex output and fragment input that disagree

```wgsl
// WRONG: vertex outputs @location(0) as vec2f,
// but the fragment shader reads @location(0) as vec3f with @interpolate(flat).
struct VSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) uv: vec2f,
}
// fragment input declared elsewhere: @location(0) @interpolate(flat) data: vec3f
```

WHY it fails: an inter-stage variable forms a contract between the vertex output and
the fragment input. The WebGPU specification requires the `@location` number, the
type, and the `@interpolate` attribute to match on both sides. A type or
interpolation mismatch fails pipeline creation.

FIX: declare each varying with the identical `@location`, type, and `@interpolate`
on both the vertex output struct and the fragment input. See
`webgpu-wgsl-fragment-shaders` for the consuming side.
