# WGSL Vertex Shaders

Write a `@vertex` entry point that reads vertex attributes, produces a correct
clip-space position, and passes inter-stage varyings to the fragment stage without
triggering pipeline or shader-creation errors.

## Quick Reference

WGSL is the shading language of WebGPU 1.0-stable (Chrome 113+, Safari 26+,
Firefox 141+). A vertex shader runs once per vertex. It ALWAYS outputs a clip-space
`@builtin(position): vec4f`; the host divides that by `w` to get normalized device
coordinates.

### Vertex shader IO

| Element | Attribute | Type | Direction | Notes |
|---------|-----------|------|-----------|-------|
| Vertex attribute | `@location(n)` parameter | scalar/vector | input | Matched to `GPUVertexBufferLayout` `shaderLocation` |
| Vertex index | `@builtin(vertex_index)` | `u32` | input | Index of the current vertex |
| Instance index | `@builtin(instance_index)` | `u32` | input | Includes the draw's `firstInstance` base |
| Clip position | `@builtin(position)` | `vec4f` | output | Mandatory; clip space, host divides by `w` |
| Varying | `@location(n)` return member | scalar/vector | output | Interpolated by the rasterizer |
| Clip distances | `@builtin(clip_distances)` | `array<f32, N>` | output | Requires the `clip-distances` feature |

### Entry point forms

```wgsl
// Form 1: single output value (only @builtin(position), no varyings)
@vertex fn vs(@location(0) pos: vec2f) -> @builtin(position) vec4f {
  return vec4f(pos, 0.0, 1.0);
}

// Form 2: struct output (position + varyings) — the common case
struct VSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) uv: vec2f,
}
@vertex fn vs(@location(0) pos: vec2f, @location(1) uv: vec2f) -> VSOut {
  return VSOut(vec4f(pos, 0.0, 1.0), uv);
}
```

### @interpolate cheatsheet

`@interpolate(type, sampling)` on a `@location` varying. `type`: `perspective`
(default), `linear`, `flat`. `sampling`: `center` (default), `centroid`, `sample`
for `perspective`/`linear`; `first` or `either` for `flat`.

| Varying value type | Required interpolation |
|--------------------|------------------------|
| Float (`f32`, `vecNf`) | `perspective` (default) or `linear` |
| Integer (`i32`, `u32`, `vecN<i32>`) | `@interpolate(flat)` MANDATORY |

## Decision Tree

```
Where does per-vertex data come from?
|
+-- Bound vertex buffers (GPUVertexBufferLayout)
|   -> declare @location(n) parameters on the @vertex fn
|   -> each n MUST equal a shaderLocation in the host buffer layout
|   -> per-instance data: a buffer with stepMode "instance"
|
+-- A storage buffer indexed in the shader (vertex pulling)
    -> declare NO @location parameters
    -> take @builtin(vertex_index) and/or @builtin(instance_index)
    -> read @group(g) @binding(b) var<storage, read> data, index by those builtins
    -> use when geometry is GPU-generated, layouts are dynamic, or you skip
       vertex-buffer plumbing entirely
```

Both forms ALWAYS output `@builtin(position): vec4f`.

## Core Patterns

### Pattern 1: ALWAYS output @builtin(position) as vec4f in clip space

Every `@vertex` entry point MUST produce `@builtin(position): vec4f`. The position
is in clip space; the host performs the perspective divide by `w`.

```wgsl
@vertex fn vs(@location(0) pos: vec3f) -> @builtin(position) vec4f {
  return vec4f(pos, 1.0); // w = 1.0 for an already-projected position
}
```

NEVER omit `@builtin(position)` from the output. A `@vertex` function without it is
a shader-creation error.

### Pattern 2: ALWAYS match @location(n) to the host shaderLocation

Each `@location(n)` parameter is fed by the `GPUVertexBufferLayout` attribute whose
`shaderLocation` equals `n`. The attribute `format` (for example `float32x3`) MUST
be assignment-compatible with the WGSL parameter type (`vec3f`).

```wgsl
// Host layout declares shaderLocation 0 (float32x3) and 1 (float32x2).
@vertex fn vs(@location(0) position: vec3f,
              @location(1) uv: vec2f) -> VSOut { /* ... */ }
```

The host-side `GPUVertexBufferLayout` (`arrayStride`, `offset`, `stepMode`,
`format`) is defined in `webgpu-syntax-render-pipeline`. NEVER duplicate that
descriptor here; only the `shaderLocation` numbers and formats must agree.

### Pattern 3: ALWAYS mark integer varyings @interpolate(flat)

Inter-stage `@location` members of a vertex output struct are interpolated by the
rasterizer. Integer values cannot be interpolated, so an integer varying MUST be
`@interpolate(flat)`.

```wgsl
struct VSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) uv: vec2f,                       // float: default perspective
  @location(1) @interpolate(flat) mat_id: u32,  // integer: flat is mandatory
}
```

### Pattern 4: ALWAYS use vertex_index / instance_index for vertex pulling

To index a storage buffer instead of using vertex buffers, declare no `@location`
parameters and read `@builtin(vertex_index)` and/or `@builtin(instance_index)`.
Both are `u32`. `instance_index` already includes the draw call's `firstInstance`.

```wgsl
@group(0) @binding(0) var<storage, read> positions: array<vec3f>;

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  return vec4f(positions[vi], 1.0);
}
```

### Pattern 5: ALWAYS use @invariant for bit-stable multi-pass depth

`@invariant` on the `@builtin(position)` output forces bit-identical transform
results across pipelines. Apply it when a depth pre-pass and a later pass must
produce exactly equal depth so a `depth-equal` test passes.

```wgsl
struct VSOut {
  @builtin(position) @invariant clip_pos: vec4f,
}
```

### Pattern 6: NEVER assume WebGL clip-space conventions

WebGPU clip space uses a Z range of 0 to 1 and Y pointing up, unlike WebGL's Z
range of -1 to 1. Projection matrices ported from WebGL/OpenGL produce wrong depth
unless rebuilt for the 0-to-1 range.

```wgsl
// Z must land in [0, 1] after the divide by w, not [-1, 1].
return projection * view * vec4f(pos, 1.0);
```

## Common Anti-Patterns

1. Integer varying without `@interpolate(flat)`. A `u32`/`i32` `@location` member
   that omits `flat` is a shader-creation error: integers have no interpolation.
2. `@location(n)` not matching the `GPUVertexBufferLayout` `shaderLocation`. The
   pipeline reads the attribute at the wrong slot or fails validation; vertices
   read garbage or rendering is blank.
3. Forgetting `@builtin(position)` in the output. A `@vertex` function with no
   position output is a shader-creation error; the rasterizer has no clip-space
   vertex.

## Critical Warnings

- NEVER omit `@builtin(position): vec4f` from a `@vertex` output.
- NEVER put both `@location` and `@builtin` on one struct member or parameter.
- NEVER leave an integer inter-stage varying without `@interpolate(flat)`.
- NEVER let a `@location(n)` number disagree with the host `shaderLocation`.
- NEVER assume a WebGL Z clip range of -1 to 1; WebGPU uses 0 to 1.
- NEVER call `discard`, `textureSample`, `dpdx`, or `dpdy` from `@vertex`; those
  are fragment-stage only. Use `textureSampleLevel` or `textureLoad` instead.

## Reference Files

- `methods.md`: the `@vertex` entry point form, vertex IO attributes,
  builtins, interpolation, and the `GPUVertexBufferLayout` correspondence.
- `examples.md`: verified WGSL vertex shaders, including a
  vertex-pulling shader using `vertex_index`.
- `anti-patterns.md`: vertex-shader mistakes with WHY-it-fails analysis.

Related skills: `webgpu-wgsl-syntax` (WGSL types, declarations, attributes),
`webgpu-wgsl-fragment-shaders` (the fragment stage that consumes these varyings),
`webgpu-wgsl-builtins` (full builtin value table), `webgpu-syntax-render-pipeline`
(the host-side `GPUVertexBufferLayout` and pipeline descriptor).
