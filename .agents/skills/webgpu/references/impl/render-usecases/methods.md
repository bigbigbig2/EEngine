# Render Use Cases: Methods

Per-use-case recipes for WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).
The multi-pass mechanics (pass chaining, G-buffers, ping-pong) belong to
`webgpu-impl-multipass`; this file covers the per-workload API setup.

## 1. PBR Material Setup

A physically based render (PBR) material shades a surface with the Cook-Torrance
bidirectional reflectance distribution function (BRDF). The host side is plain
WebGPU; no API feature is required beyond `sampler` and `texture_2d<f32>` bind-group
entries. The optional `shader-f16` feature lets the WGSL math run in `f16` for cheaper
arithmetic.

### Resource plan

ALWAYS split PBR resources into two uniform buffers and a texture group:

1. **Matrix uniform buffer** : view matrix, projection matrix, model matrix, and the
   normal matrix (inverse-transpose of the model matrix). Visible to the vertex stage,
   and to the fragment stage for view-position math.
2. **Material uniform buffer** : albedo factor (`vec4f`), metallic factor (`f32`),
   roughness factor (`f32`), and any emissive or occlusion scalars. Visible to the
   fragment stage.
3. **Texture group** : albedo texture, normal texture, metallic-roughness texture,
   each `texture_2d<f32>`, plus one filtering `sampler`.

### Step-by-step

1. Create the matrix uniform buffer with
   `GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST`. Size it to the std140-style
   layout of its WGSL struct (see `webgpu-wgsl-memory-layout`).
2. Create the material uniform buffer the same way.
3. Load the albedo texture with format `rgba8unorm-srgb` so the GPU decodes sRGB to
   linear on sample.
4. Load the normal and metallic-roughness textures with format `rgba8unorm` (linear);
   they store raw data, not perceptual color.
5. Create one filtering sampler:
   `device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat" })`.
6. Create the bind group layout with six entries (see `references/examples.md`).
7. Create the bind group binding the two buffers, three texture views, and the
   sampler.
8. Implement the Cook-Torrance BRDF in the WGSL fragment shader: normal distribution
   function (GGX/Trowbridge-Reitz), geometry term (Smith), and Fresnel term
   (Schlick). Sample albedo, perturb the geometric normal with the normal map, and
   read metallic and roughness from the metallic-roughness texture (green channel =
   roughness, blue channel = metallic, per the glTF convention).
9. Build the render pipeline against this bind group layout (see
   `webgpu-syntax-render-pipeline`).

### glTF channel convention

The metallic-roughness texture packs roughness in the green channel and metalness in
the blue channel. ALWAYS read `.g` for roughness and `.b` for metallic; do not assume
separate textures.

## 2. Full-Screen Pass

A full-screen pass runs the fragment shader once per viewport pixel. The idiomatic
WebGPU technique generates an oversized triangle entirely in the vertex shader, so NO
vertex buffer is bound.

### Why an oversized triangle, not a quad

A quad needs four vertices and two triangles that meet on a diagonal. That diagonal is
an internal edge where the rasterizer can produce sampling artefacts. A single
triangle scaled to twice the viewport covers every pixel with one primitive and no
internal seam. It also needs no vertex buffer and no vertex buffer layout.

### Step-by-step

1. Write a vertex shader that takes `@builtin(vertex_index)` and emits one of three
   clip-space corners. Indices `0,1,2` produce the corners `(-1,-1)`, `(3,-1)`,
   `(-1,3)`, which form a triangle whose inscribed `[-1,1]` region is the viewport.
2. Derive the texture UV from the clip-space position inside the vertex or fragment
   shader. ALWAYS flip Y: the framebuffer is Y-down while clip space is Y-up, so
   `uv.y = 0.5 - pos.y * 0.5`.
3. Write a fragment shader that samples the input texture at that UV.
4. Build a render pipeline that omits the `vertex.buffers` field entirely.
5. Create a bind group with the input texture view and a sampler.
6. In the render pass: `pass.setPipeline(p)`, `pass.setBindGroup(0, bg)`,
   `pass.draw(3)`. Never call `setVertexBuffer`.

### Post-processing chains

A post-processing chain is a sequence of full-screen passes. Render the scene to an
offscreen color texture, then run one full-screen pass per effect (tone-mapping,
bloom, FXAA), each sampling the previous result and writing the next, finally
presenting to the canvas. The pass-chaining, intermediate-texture usage flags, and
ping-pong mechanics belong to `webgpu-impl-multipass`; this skill only covers the
per-pass full-screen draw.

## 3. Screen-Space Effects (SSAO, SSR)

Screen-space ambient occlusion (SSAO) and screen-space reflections (SSR) compute a
shading term from data already on screen: scene depth and view-space normals.

### Step-by-step

1. In a geometry pass, render the scene depth and view-space normals to a G-buffer.
   The G-buffer construction (multiple render targets, attachment formats, usage
   flags) is owned by `webgpu-impl-multipass`.
2. Create the depth texture with a depth format (`depth24plus` or `depth32float`) and
   `GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING` so a later
   pass can sample it.
3. In a full-screen pass, bind the depth texture as `texture_depth_2d` and the normal
   texture as `texture_2d<f32>`.
4. Pass the inverse projection matrix in a uniform buffer.
5. In the fragment shader, sample the non-linear depth with `textureLoad` (integer
   pixel coords, no sampler) or a `non-filtering` sampler. NEVER use a filtering
   sampler on a depth texture: depth textures are not filterable and validation
   rejects a filtering sampler bound to one.
6. Reconstruct the view-space position: build the NDC vector
   `vec4f(uv * 2 - 1, raw_depth, 1)`, multiply by the inverse projection matrix, and
   divide by `w`. Remember WebGPU NDC Z is `[0,1]`, so `raw_depth` goes straight into
   the Z slot without remapping.
7. For SSAO: sample neighbouring depths in a hemisphere kernel around the
   reconstructed position and count how many occlude the fragment. For SSR: march a
   ray in view space and project each step back to screen space to test against the
   depth buffer.
8. Write the occlusion or reflection term, then combine it with the lit scene in a
   later full-screen pass.

### Depth reconstruction note

WebGPU clip-space Z is `0` to `1`, not `-1` to `1` like WebGL. When reconstructing
position, the sampled depth value is already in `[0,1]`, so it maps directly to the
NDC Z coordinate. A formula ported from WebGL that does `depth * 2 - 1` for Z is
wrong on WebGPU and shifts every reconstructed position.
