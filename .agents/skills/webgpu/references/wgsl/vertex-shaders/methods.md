# WGSL Vertex Shaders: Methods and Syntax

WGSL is the shading language of WebGPU 1.0-stable (Chrome 113+, Safari 26+,
Firefox 141+). All syntax below is verified against the W3C WGSL specification
(https://www.w3.org/TR/WGSL/) and the WebGPU specification
(https://www.w3.org/TR/webgpu/).

## 1. The @vertex entry point form

A vertex shader is a function annotated `@vertex`. It is an entry point and ALWAYS
runs once per vertex processed by a draw call.

```wgsl
@vertex fn name(<inputs>) -> <output> {
  // ...
  return <output value>;
}
```

Rules for the `@vertex` entry point:

- The function name is referenced by the host as `vertex.entryPoint` in the
  `GPURenderPipelineDescriptor`. If a shader module has exactly one `@vertex`
  function, `entryPoint` MAY be omitted on the host side.
- An entry point MUST NOT be called from other WGSL code; it is an entry point
  only.
- Recursion is forbidden across the whole call graph. A `@vertex` function and any
  helper it calls form an acyclic graph.
- Every non-void control path MUST `return` a value of the declared output type.
- `discard` is fragment-stage only. NEVER use it in a `@vertex` function.
- `textureSample`, `textureSampleBias`, `dpdx`, `dpdy`, and `fwidth` compute
  implicit derivatives and are fragment-stage only. From `@vertex`, use
  `textureSampleLevel` or `textureLoad`.

## 2. Vertex inputs

A `@vertex` function receives two kinds of input, each declared as a parameter.

### 2.1 Vertex attributes via @location(n)

A parameter marked `@location(n)` is a vertex attribute. Its value is fetched per
vertex from a bound vertex buffer.

```wgsl
@vertex fn vs(@location(0) position: vec3f,
              @location(1) normal:   vec3f,
              @location(2) uv:       vec2f) -> VSOut { /* ... */ }
```

- `n` is a non-negative integer slot. Each `n` MUST be unique within the entry
  point's parameters.
- Allowed attribute types are scalars (`f32`, `i32`, `u32`, `f16`) and vectors of
  them (`vec2f`, `vec3f`, `vec4f`, `vec2u`, and so on). Matrices, structs, and
  arrays are NOT valid `@location` attribute types directly.
- The host `GPUVertexBufferLayout` attribute with the same `shaderLocation`
  supplies the data. See section 6.

### 2.2 Builtin inputs

| Builtin | Type | Meaning |
|---------|------|---------|
| `@builtin(vertex_index)` | `u32` | Index of the current vertex within the draw |
| `@builtin(instance_index)` | `u32` | Index of the current instance; includes the draw's `firstInstance` base offset |

Both are inputs only and both are `u32`.

```wgsl
@vertex fn vs(@builtin(vertex_index) vi: u32,
              @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  // ...
}
```

For a non-indexed `draw(vertexCount, instanceCount, firstVertex, firstInstance)`,
`vertex_index` runs over `[firstVertex, firstVertex + vertexCount)`. For
`drawIndexed`, `vertex_index` is the index value read from the index buffer plus
`baseVertex`. `instance_index` runs over
`[firstInstance, firstInstance + instanceCount)`.

A `@vertex` parameter MAY be a struct whose members each carry `@location` or
`@builtin`. Mixing parameters and a struct parameter is allowed as long as every
`@location` slot and every builtin appears at most once.

## 3. Vertex output

The output of a `@vertex` function MUST include the clip-space position.

### 3.1 @builtin(position): vec4f (mandatory)

```wgsl
struct VSOut {
  @builtin(position) clip_pos: vec4f,
}
```

- The output `@builtin(position)` is `vec4<f32>` (`vec4f`). It is an output for the
  vertex stage and an input for the fragment stage.
- It is in clip space. The host performs the perspective divide: normalized device
  coordinates are `position.xyz / position.w`.
- WebGPU clip space: the Z range is 0 to 1 (not -1 to 1), and Y points up.
- Omitting `@builtin(position)` from a `@vertex` output is a shader-creation error.

A `@vertex` function MAY return `@builtin(position) vec4f` directly when there are
no varyings:

```wgsl
@vertex fn vs(@location(0) pos: vec2f) -> @builtin(position) vec4f {
  return vec4f(pos, 0.0, 1.0);
}
```

### 3.2 Inter-stage varyings via @location(n)

Additional `@location(n)` members of the output struct are inter-stage variables
(varyings). The rasterizer interpolates them across each primitive before the
fragment shader reads them.

```wgsl
struct VSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) uv:     vec2f,
  @location(1) normal: vec3f,
}
```

- A varying `@location(n)` on the vertex output MUST be matched by a `@location(n)`
  input of the same type in the fragment shader.
- Allowed varying types are scalars and vectors of `f32`, `f16`, `i32`, `u32`.
- The total inter-stage variable count is bounded by the
  `maxInterStageShaderVariables` device limit.

### 3.3 @builtin(clip_distances)

`@builtin(clip_distances): array<f32, N>` is an optional vertex output that enables
user clip planes. It requires the `clip-distances` device feature. Without that
feature, declaring it is invalid.

## 4. @interpolate

`@interpolate(type)` or `@interpolate(type, sampling)` controls how a `@location`
varying is interpolated. It is placed on both the vertex output member and the
matching fragment input; the two MUST agree.

### 4.1 Interpolation type

| Type | Behavior |
|------|----------|
| `perspective` | Perspective-correct interpolation. The default when `@interpolate` is absent on a float varying. |
| `linear` | Linear interpolation in screen space, no perspective correction. |
| `flat` | No interpolation; the value of one provoking vertex is used for the whole primitive. |

### 4.2 Interpolation sampling

| Sampling | Valid with | Meaning |
|----------|------------|---------|
| `center` | `perspective`, `linear` | Sampled at the pixel center. Default for `perspective`/`linear`. |
| `centroid` | `perspective`, `linear` | Sampled at a covered location inside the primitive. |
| `sample` | `perspective`, `linear` | Per-sample; triggers sample-rate shading. |
| `first` | `flat` | Uses the first vertex of the primitive as the provoking vertex. |
| `either` | `flat` | The implementation may use the first or last vertex. |

When `sampling` is omitted, `perspective`/`linear` default to `center` and `flat`
defaults to `first`.

### 4.3 Integer varyings rule

Integer-typed varyings (`i32`, `u32`, and vectors of them) CANNOT be interpolated.
Any integer `@location` varying MUST be `@interpolate(flat)`. Omitting `flat` on an
integer varying is a shader-creation error.

```wgsl
struct VSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) @interpolate(flat) instance_id: u32,
}
```

## 5. @invariant

`@invariant` placed on the `@builtin(position)` vertex output guarantees that the
position computation is bit-identical when the same inputs and the same expression
are used across different pipelines.

```wgsl
struct VSOut {
  @builtin(position) @invariant clip_pos: vec4f,
}
```

Use `@invariant` for multi-pass rendering where a depth pre-pass and a later pass
must produce exactly equal depth values so a `depth-equal` comparison succeeds.
Without `@invariant`, compilers MAY reorder floating-point operations between
pipelines and produce depth values that differ by one bit, causing depth-test
flicker. `@invariant` is valid only on the `@builtin(position)` output.

## 6. The GPUVertexBufferLayout correspondence

The host describes vertex buffers in `GPURenderPipelineDescriptor.vertex.buffers`,
an array of `GPUVertexBufferLayout`. Each layout has `arrayStride`, `stepMode`
(`"vertex"` or `"instance"`), and `attributes`. Each attribute has `shaderLocation`,
`offset`, and `format`.

The contract between the host layout and the WGSL `@vertex` parameters:

- A WGSL `@location(n)` parameter is fed by the `GPUVertexBufferLayout` attribute
  whose `shaderLocation` equals `n`. The numbers MUST agree.
- The attribute `format` MUST be compatible with the WGSL parameter type. For
  example `format: "float32x3"` matches `vec3f`; `"uint32"` matches `u32`;
  `"sint32x2"` matches `vec2i`.
- `stepMode: "vertex"` advances the attribute once per vertex; `stepMode:
  "instance"` advances once per instance.

The full `GPUVertexBufferLayout` descriptor (`arrayStride`, `offset`, all `format`
values, `stepMode`) is owned by the `webgpu-syntax-render-pipeline` skill. This
skill specifies only the WGSL side: which `@location` numbers and which WGSL types
the entry point declares. NEVER duplicate the host descriptor here.

## Verified sources

- W3C WGSL specification: https://www.w3.org/TR/WGSL/ (entry points, attributes,
  builtin values, `@interpolate`, `@invariant`, inter-stage variables).
- WGSL editor's draft: https://gpuweb.github.io/gpuweb/wgsl/.
- W3C WebGPU specification: https://www.w3.org/TR/webgpu/ (`GPUVertexBufferLayout`,
  vertex state, clip space).
- Vooronderzoek WebGPU PART B sections 5, 6, 9 (`docs/research/vooronderzoek-webgpu.md`).
