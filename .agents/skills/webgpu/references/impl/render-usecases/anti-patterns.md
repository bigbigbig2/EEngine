# Render Use Cases: Anti-Patterns

Render-workload mistakes for WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox
141+), each with a WHY-it-fails analysis and a fix.

## 1. Full-screen quad from a 4-vertex triangle-strip vertex buffer

**Mistake**: building a vertex buffer with four corner positions, a vertex buffer
layout, and a `triangle-strip` topology to draw a full-screen quad, instead of
generating three vertices in the vertex shader.

**WHY it fails**: functionally it does render the whole viewport, but it is strictly
worse. It allocates an unnecessary vertex buffer and an unnecessary
`GPUVertexBufferLayout`, and the two triangles of the quad meet on a diagonal. That
diagonal is an internal edge where the rasterizer evaluates two adjacent primitives;
on that seam, derivative-based sampling and interpolation can produce visible
artefacts. The shader-generated oversized triangle covers every pixel with a single
primitive and no internal seam.

**Fix**: generate three clip-space corners from `@builtin(vertex_index)`, omit the
`vertex.buffers` field from the pipeline, and call `pass.draw(3)`. Never call
`setVertexBuffer` for a full-screen pass.

## 2. Reusing a WebGL `[-1,1]`-Z projection matrix

**Mistake**: porting a projection matrix (or matrix-library call such as a default
`perspective()`) from WebGL straight into WebGPU without changing the depth range.

**WHY it fails**: WebGL clip-space Z runs from `-1` (near) to `1` (far). WebGPU
clip-space Z runs from `0` (near) to `1` (far). A WebGL matrix maps the near plane to
NDC Z `-1`; on WebGPU everything with NDC Z below `0` is clipped, so the near half of
the view frustum disappears, and the surviving geometry has a compressed,
non-monotonic depth distribution that breaks the depth test and z-ordering.

**Fix**: build the projection matrix for a `[0,1]` Z range. Most matrix libraries
offer a `*ZO` variant (zero-to-one), for example `mat4.perspectiveZO`. See
`webgpu-impl-webgl-migration` for the full conversion.

## 3. Sampling a depth texture with a filtering sampler

**Mistake**: binding a `sampler` with `type: "filtering"` (or a sampler created with
`magFilter: "linear"`) to sample a depth texture in an SSAO or SSR pass, and reading
it with `textureSample`.

**WHY it fails**: depth-format textures (`depth24plus`, `depth32float`) are not
filterable. WebGPU validation rejects a bind group that pairs a filtering sampler with
a non-filterable texture, and the pipeline or bind-group creation throws. Even when a
driver tolerates it, linear-filtering raw non-linear depth values is meaningless: the
interpolated value is not a valid depth.

**Fix**: read depth with `textureLoad` and integer pixel coordinates (no sampler at
all), or bind a `non-filtering` sampler, or a `comparison` sampler when doing shadow
comparison. Bind the texture as `texture_depth_2d` in WGSL.

## 4. Marking the metallic-roughness or normal texture as sRGB

**Mistake**: creating every PBR texture with an `-srgb` format because the albedo
texture uses one.

**WHY it fails**: an sRGB texture format makes the GPU apply the sRGB-to-linear
transfer function (a gamma curve) when the texture is sampled. That is correct for
albedo, which stores perceptual color authored in sRGB. It is wrong for the normal map
and the metallic-roughness texture: those store raw linear data (packed normal vectors,
a roughness scalar, a metalness scalar). Applying a gamma curve to that data shifts
every value, so normals point the wrong way and roughness/metalness read incorrectly,
producing visibly wrong lighting.

**Fix**: use `rgba8unorm-srgb` for the albedo texture only. Use `rgba8unorm` (linear)
for the normal texture and the metallic-roughness texture.

## 5. Forgetting to Y-flip UVs derived from clip-space position

**Mistake**: in a full-screen pass, computing the texture UV as
`uv = pos.xy * 0.5 + 0.5` directly from the clip-space position.

**WHY it fails**: WebGPU clip space is Y-up (positive Y is the top of the screen) but
the framebuffer and texture coordinate space are Y-down (UV `(0,0)` is the top-left).
Without flipping Y, the sampled image is rendered upside down.

**Fix**: flip the Y component when converting clip-space position to UV:
`uv = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5)`.

## 6. Remapping reconstructed depth as if NDC Z were `[-1,1]`

**Mistake**: in an SSAO or SSR pass, reconstructing position with a WebGL-style
formula that does `ndc_z = raw_depth * 2.0 - 1.0` before multiplying by the inverse
projection matrix.

**WHY it fails**: WebGPU NDC Z is already `[0,1]`. The depth value read from the depth
buffer is in `[0,1]` and maps directly into the NDC Z slot. The extra `* 2 - 1`
double-remaps it, so every reconstructed view-space position is wrong, and the SSAO or
SSR result is offset and distorted across the whole frame.

**Fix**: place the raw sampled depth straight into the NDC vector:
`vec4f(uv * 2 - 1, raw_depth, 1)`. Only the X and Y components need the `* 2 - 1`
remap.

## 7. Sampling a render target still bound as an attachment

**Mistake**: in a post-processing or screen-space pass, binding a texture as a sampled
input while the same texture is still a color or depth attachment of the active render
pass.

**WHY it fails**: WebGPU validation rejects a bind group whose resource is also a
writable attachment of the active pass, because the read/write ordering within a pass
is undefined.

**Fix**: end the writing pass before the pass that samples its output, or ping-pong
two textures. The pass-splitting and ping-pong mechanics are covered by
`webgpu-impl-multipass`.
