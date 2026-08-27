# WGSL Vertex Shaders: Verified Examples

All WGSL below is for WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+) and
is verified against the W3C WGSL specification (https://www.w3.org/TR/WGSL/) and the
research base (`docs/research/vooronderzoek-webgpu.md`, PART B sections 5, 6, 9).

## Example 1: Vertex shader with attributes and varyings

A vertex shader fed by bound vertex buffers. It reads three `@location` attributes,
transforms the position with a uniform matrix, and passes a float varying and an
integer (flat) varying to the fragment stage.

```wgsl
// Uniform block: a model-view-projection matrix.
struct Uniforms {
  mvp: mat4x4f,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

// Vertex output: clip-space position plus inter-stage varyings.
struct VSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) uv: vec2f,                          // float varying: perspective
  @location(1) @interpolate(flat) material_id: u32, // integer varying: flat
}

@vertex
fn vs_main(
  @location(0) position:    vec3f,
  @location(1) uv:          vec2f,
  @location(2) material_id: u32,
) -> VSOut {
  var out: VSOut;
  // Transform into clip space. The host divides clip_pos by its w component.
  out.clip_pos = u.mvp * vec4f(position, 1.0);
  out.uv = uv;
  out.material_id = material_id;
  return out;
}
```

Host-side correspondence (defined in `webgpu-syntax-render-pipeline`): the
`GPUVertexBufferLayout` attributes carry `shaderLocation: 0` with `format:
"float32x3"`, `shaderLocation: 1` with `format: "float32x2"`, and `shaderLocation:
2` with `format: "uint32"`. The `shaderLocation` numbers match the `@location`
numbers in `vs_main`, and the formats match the WGSL parameter types.

Why this is correct:

- `@builtin(position): vec4f` is present, so the rasterizer has a clip-space
  vertex.
- The float varying `uv` uses the default `perspective` interpolation.
- The integer varying `material_id` is `@interpolate(flat)`, which is mandatory for
  integers.
- Each `@location(n)` parameter matches a host `shaderLocation`.

## Example 2: Vertex-pulling shader using vertex_index

This shader uses NO vertex buffers. It reads per-vertex data from a storage buffer,
indexing it with `@builtin(vertex_index)`. This is the vertex-pulling pattern: the
geometry is laid out by the application or generated on the GPU.

```wgsl
struct Vertex {
  position: vec3f,
  uv: vec2f,
}

// A storage buffer holding every vertex. read-only access.
@group(0) @binding(0) var<storage, read> vertices: array<Vertex>;

struct Uniforms {
  mvp: mat4x4f,
}
@group(0) @binding(1) var<uniform> u: Uniforms;

struct VSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_pull(@builtin(vertex_index) vi: u32) -> VSOut {
  let v = vertices[vi];
  var out: VSOut;
  out.clip_pos = u.mvp * vec4f(v.position, 1.0);
  out.uv = v.uv;
  return out;
}
```

Why this is correct:

- No `@location` parameters: there is no vertex buffer to match. The host
  `GPURenderPipelineDescriptor.vertex.buffers` array is empty or omitted.
- `@builtin(vertex_index)` is `u32` and indexes the storage array.
- The storage buffer is declared `var<storage, read>`: a vertex shader reads it but
  does not write it.
- `@builtin(position): vec4f` is still mandatory and present.

## Example 3: Instanced vertex pulling with instance_index

Per-instance transforms live in a storage buffer indexed by
`@builtin(instance_index)`, while per-vertex positions come from a vertex buffer.
`instance_index` already includes the draw's `firstInstance` base.

```wgsl
struct Instance {
  model: mat4x4f,
  tint: vec4f,
}
@group(0) @binding(0) var<storage, read> instances: array<Instance>;

struct Camera {
  view_proj: mat4x4f,
}
@group(0) @binding(1) var<uniform> cam: Camera;

struct VSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) tint: vec4f,
}

@vertex
fn vs_instanced(
  @location(0) position: vec3f,
  @builtin(instance_index) ii: u32,
) -> VSOut {
  let inst = instances[ii];
  var out: VSOut;
  out.clip_pos = cam.view_proj * inst.model * vec4f(position, 1.0);
  out.tint = inst.tint;
  return out;
}
```

Why this is correct:

- `@builtin(instance_index)` selects the per-instance struct; `@location(0)`
  selects per-vertex data. Both forms compose in one entry point.
- For a draw with a non-zero `firstInstance`, `instance_index` starts at
  `firstInstance`, so `instances[ii]` indexes the intended element.

## Example 4: @invariant position for a multi-pass depth pre-pass

When a depth pre-pass and a color pass must produce bit-identical depth so a
`depth-equal` test passes, mark the position output `@invariant` in both shaders
and use the same transform expression.

```wgsl
struct Uniforms {
  mvp: mat4x4f,
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
  @builtin(position) @invariant clip_pos: vec4f,
}

@vertex
fn vs_depth(@location(0) position: vec3f) -> VSOut {
  var out: VSOut;
  out.clip_pos = u.mvp * vec4f(position, 1.0);
  return out;
}
```

Why this is correct:

- `@invariant` on `@builtin(position)` forces the compiler to produce bit-identical
  results for the same input across pipelines.
- The depth pre-pass and the later color pass use the identical
  `u.mvp * vec4f(position, 1.0)` expression so the depth values match exactly.

## Example 5: Single-value output (no varyings)

When the fragment shader needs only the screen-space position, the vertex shader
returns `@builtin(position)` directly without a struct.

```wgsl
@vertex
fn vs_point(@location(0) pos: vec2f) -> @builtin(position) vec4f {
  // pos is already in normalized device coordinates; w = 1.0.
  return vec4f(pos, 0.0, 1.0);
}
```

Why this is correct: `@builtin(position): vec4f` is the entire output, which is a
valid `@vertex` return form. There are no `@location` varyings to interpolate.
