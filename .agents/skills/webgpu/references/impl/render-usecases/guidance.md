# WebGPU Render Use Cases

API-level setup for common render workloads: PBR materials, full-screen passes,
post-processing, and screen-space effects on WebGPU 1.0-stable (Chrome 113+,
Safari 26+, Firefox 141+).

## Quick Reference

| Use case | API resources needed | Key technique |
|----------|----------------------|---------------|
| PBR material | 2 uniform buffers (matrices, material params), 3 `texture_2d<f32>`, 1 filtering sampler, 1 bind group | Cook-Torrance BRDF in WGSL fragment shader |
| Full-screen pass | NO vertex buffer, 1 sampled `texture_2d<f32>`, 1 sampler | Generate 3 vertices from `@builtin(vertex_index)` |
| Post-processing | Offscreen color texture, full-screen pass per effect | Sample previous result, write next (cross-link `webgpu-impl-multipass`) |
| Screen-space effects (SSAO, SSR) | G-buffer textures, depth as `texture_depth_2d`, inverse projection matrix | Full-screen pass reconstructs position from depth |

ALWAYS generate a full-screen pass from three shader-built vertices. NEVER bind a
vertex buffer for a full-screen pass. WebGPU clip-space Z is `0` to `1` (not `-1` to
`1` like WebGL); the framebuffer is Y-down while clip space is Y-up.

## Decision Tree

```
What render workload are you building?
├── Surface shading with realistic light response
│     -> PBR material. One uniform buffer for camera/transform matrices, one for
│        material parameters (albedo, metallic, roughness). Bind albedo, normal, and
│        metallic-roughness textures plus a filtering sampler. Implement the
│        Cook-Torrance BRDF in the WGSL fragment shader.
│
├── Apply one effect across the whole viewport (copy, tone-map, color grade)
│     -> Full-screen pass. Generate an oversized triangle from
│        @builtin(vertex_index); bind NO vertex buffer. The fragment shader samples
│        the input texture.
│
├── Chain several effects on a finished image (bloom, FXAA, tone-map)
│     -> Post-processing chain. Render the scene to an offscreen texture, then run
│        one full-screen pass per effect. See webgpu-impl-multipass for the pass
│        mechanics and ping-pong buffers.
│
└── Depth/normal-driven effects (SSAO, screen-space reflections)
      -> Render scene depth and normals to a G-buffer (see webgpu-impl-multipass),
         then a full-screen pass samples those textures. Bind the depth texture as
         texture_depth_2d and reconstruct view-space position from depth and the
         inverse projection matrix.
```

## Core Patterns

### Pattern 1: Full-screen pass uses NO vertex buffer

ALWAYS generate a full-screen pass from three vertices in the vertex shader, indexed
by `@builtin(vertex_index)`. NEVER bind a vertex buffer or define a vertex buffer
layout for a full-screen pass. The oversized triangle covers the whole viewport with
one primitive and no internal seam.

```wgsl
@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  // Indices 0,1,2 -> clip-space corners of a triangle 2x the viewport.
  let x = f32((i << 1u) & 2u);   // 0, 2, 0
  let y = f32(i & 2u);           // 0, 0, 2
  return vec4f(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
}
```

Draw it with `pass.draw(3)`. The render pipeline omits the `vertex.buffers` field.

### Pattern 2: Y-flip for UVs derived from clip-space position

The framebuffer is Y-down while clip space is Y-up. ALWAYS flip the Y component when
deriving texture UVs from the clip-space position so sampled images are not upside
down.

```wgsl
// pos.xy is clip-space [-1,1]; uv must be framebuffer-space [0,1].
let uv = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
```

### Pattern 3: PBR material uses a fixed bind-group split

ALWAYS split PBR resources into one uniform buffer for camera/transform matrices and
one uniform buffer for material parameters (albedo factor, metallic, roughness). Bind
the albedo, normal, and metallic-roughness textures as `texture_2d<f32>` plus one
filtering sampler. No API feature beyond `sampler` and `texture_2d<f32>` entries is
needed. The Cook-Torrance BRDF lives entirely in the WGSL fragment shader.

```js
// Bind group layout: matrices, material, 3 textures, 1 sampler.
const layout = device.createBindGroupLayout({
  label: "pbr-bgl",
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" } },                       // camera + transform
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // albedo
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // normal
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // metallic-rough
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
  ],
});
```

### Pattern 4: Correct color space per PBR texture

ALWAYS create the albedo texture with an sRGB format (`rgba8unorm-srgb`) so the GPU
decodes it to linear on sample. ALWAYS create the normal map and metallic-roughness
texture with a linear format (`rgba8unorm`). Those textures store raw data, not
perceptual color; an sRGB format would apply a wrong gamma curve to them.

### Pattern 5: Screen-space effects sample depth via texture_depth_2d

ALWAYS bind the depth buffer for SSAO or SSR as `texture_depth_2d` in WGSL and pass
the inverse projection matrix in a uniform buffer. Reconstruct view-space position
from the sampled non-linear depth and the inverse projection matrix; do not assume
depth is a linear distance.

```wgsl
@group(0) @binding(0) var depth_tex: texture_depth_2d;
// Sample with textureLoad (integer coords) or a non-filtering sampler.
let raw_depth = textureLoad(depth_tex, vec2i(frag_coord.xy), 0);
let ndc = vec4f(uv * 2.0 - 1.0, raw_depth, 1.0);
let view_pos_h = inv_proj * ndc;
let view_pos = view_pos_h.xyz / view_pos_h.w;
```

### Pattern 6: Use a [0,1]-Z projection matrix

ALWAYS build the projection matrix for WebGPU's `0` to `1` clip-space Z range. NEVER
reuse a WebGL `[-1,1]`-Z projection matrix. A WebGL matrix maps the near plane to
`-1`, so half the depth range falls outside `[0,1]` and is clipped, breaking depth
testing. See `webgpu-impl-webgl-migration` for the matrix conversion.

## Common Anti-Patterns

1. **Full-screen quad from a 4-vertex triangle-strip vertex buffer.** WHY it fails:
   it adds an unnecessary vertex buffer and layout, and the two triangles meet on a
   diagonal seam that can cause sampling artefacts. The shader-generated oversized
   triangle is strictly better. Fix: generate 3 vertices from `@builtin(vertex_index)`
   and `draw(3)`.

2. **Reusing a WebGL `[-1,1]`-Z projection matrix.** WHY it fails: WebGPU clip-space Z
   is `[0,1]`; a WebGL matrix clips the near half of the scene and corrupts depth
   testing. Fix: build the projection for a `[0,1]` Z range.

3. **Marking the metallic-roughness or normal texture as sRGB.** WHY it fails: those
   textures store linear data (roughness, metalness, packed normals); an sRGB format
   applies a gamma curve on sample and produces wrong lighting. Fix: use `rgba8unorm`
   (linear) for normal and metallic-roughness, `rgba8unorm-srgb` only for albedo.

## Critical Warnings

- NEVER bind a vertex buffer for a full-screen pass; generate 3 vertices in the shader.
- NEVER reuse a WebGL `[-1,1]`-Z projection matrix; WebGPU clip-space Z is `[0,1]`.
- NEVER sample a depth texture with a filtering sampler; depth needs `textureLoad`,
  a `non-filtering` sampler, or a `comparison` sampler.
- NEVER create the normal or metallic-roughness texture with an sRGB format.
- NEVER sample a texture in the same render pass that still has it bound as an
  attachment; split the passes (see `webgpu-impl-multipass`).

## Reference Files

- `methods.md` : per-use-case recipes for PBR materials, full-screen
  passes, and screen-space effects.
- `examples.md` : verified code for an oversized-triangle pass, a PBR
  bind-group layout, and an SSAO-style depth-sampling pass.
- `anti-patterns.md` : render-workload mistakes with WHY-it-fails analysis.

Related skills: `webgpu-impl-multipass` (pass chaining, G-buffers, ping-pong),
`webgpu-syntax-render-pipeline` (pipeline descriptors), `webgpu-wgsl-fragment-shaders`
(fragment-stage WGSL), `webgpu-syntax-bind-groups` (bind group layouts),
`webgpu-impl-webgl-migration` (WebGL-to-WebGPU porting).
