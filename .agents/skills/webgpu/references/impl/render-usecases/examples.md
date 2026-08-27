# Render Use Cases: Verified Examples

Working code for WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). Every
example is verified against the WebGPU specification (https://www.w3.org/TR/webgpu/)
and the official WebGPU Samples (https://webgpu.github.io/webgpu-samples/).

## 1. Full-Screen Oversized-Triangle Pass

A full-screen pass that copies an input texture to the canvas. No vertex buffer is
bound; three vertices are generated from `@builtin(vertex_index)`.

### WGSL shader

```wgsl
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
  // Indices 0,1,2 -> clip-space corners (-1,-1), (3,-1), (-1,3).
  let x = f32((i << 1u) & 2u);   // 0, 2, 0
  let y = f32(i & 2u);           // 0, 0, 2
  var out: VsOut;
  out.pos = vec4f(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
  // Framebuffer is Y-down, clip space is Y-up: flip Y for the UV.
  out.uv = vec2f(x, 1.0 - y);
  return out;
}

@group(0) @binding(0) var src_tex: texture_2d<f32>;
@group(0) @binding(1) var src_sampler: sampler;

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  return textureSample(src_tex, src_sampler, in.uv);
}
```

### Host side

```js
const module = device.createShaderModule({ label: "fullscreen", code: wgsl });

// Pipeline omits vertex.buffers entirely: no vertex buffer for a full-screen pass.
const pipeline = device.createRenderPipeline({
  label: "fullscreen-pipeline",
  layout: "auto",
  vertex: { module, entryPoint: "vs_main" },
  fragment: {
    module,
    entryPoint: "fs_main",
    targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
  },
  primitive: { topology: "triangle-list" },
});

const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });

const bindGroup = device.createBindGroup({
  label: "fullscreen-bg",
  layout: pipeline.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: sceneTexture.createView() },
    { binding: 1, resource: sampler },
  ],
});

function drawFullScreen(encoder) {
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1],
    }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);              // 3 vertices, NEVER setVertexBuffer
  pass.end();
}
```

## 2. PBR Bind-Group Layout

The fixed six-entry layout for a PBR material: two uniform buffers, three textures,
one filtering sampler.

```js
// Bind group layout: matrices, material, albedo, normal, metallic-roughness, sampler.
const pbrLayout = device.createBindGroupLayout({
  label: "pbr-bgl",
  entries: [
    { binding: 0,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" } },                       // camera + transform
    { binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" } },                       // material params
    { binding: 2,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float", viewDimension: "2d" } },   // albedo
    { binding: 3,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float", viewDimension: "2d" } },   // normal
    { binding: 4,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float", viewDimension: "2d" } },   // metallic-roughness
    { binding: 5,
      visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: "filtering" } },
  ],
});

// Albedo: sRGB format so the GPU decodes to linear on sample.
const albedoTex = device.createTexture({
  label: "pbr-albedo",
  size: [w, h],
  format: "rgba8unorm-srgb",
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
         GPUTextureUsage.RENDER_ATTACHMENT,
});

// Normal and metallic-roughness: LINEAR format, they store raw data.
const normalTex = device.createTexture({
  label: "pbr-normal",
  size: [w, h],
  format: "rgba8unorm",
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
         GPUTextureUsage.RENDER_ATTACHMENT,
});
const metalRoughTex = device.createTexture({
  label: "pbr-metallic-roughness",
  size: [w, h],
  format: "rgba8unorm",
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
         GPUTextureUsage.RENDER_ATTACHMENT,
});

const pbrSampler = device.createSampler({
  label: "pbr-sampler",
  magFilter: "linear", minFilter: "linear", mipmapFilter: "linear",
  addressModeU: "repeat", addressModeV: "repeat",
});

const pbrBindGroup = device.createBindGroup({
  label: "pbr-bg",
  layout: pbrLayout,
  entries: [
    { binding: 0, resource: { buffer: matrixUniformBuffer } },
    { binding: 1, resource: { buffer: materialUniformBuffer } },
    { binding: 2, resource: albedoTex.createView() },
    { binding: 3, resource: normalTex.createView() },
    { binding: 4, resource: metalRoughTex.createView() },
    { binding: 5, resource: pbrSampler },
  ],
});
```

The Cook-Torrance BRDF lives in the WGSL fragment shader. Sketch of the structure:

```wgsl
struct Material {
  albedo: vec4f,
  metallic: f32,
  roughness: f32,
};
@group(0) @binding(1) var<uniform> material: Material;
@group(0) @binding(2) var albedo_tex: texture_2d<f32>;
@group(0) @binding(4) var mr_tex: texture_2d<f32>;
@group(0) @binding(5) var samp: sampler;

// glTF convention: green = roughness, blue = metallic.
fn read_mr(uv: vec2f) -> vec2f {
  let mr = textureSample(mr_tex, samp, uv);
  return vec2f(mr.g * material.roughness, mr.b * material.metallic);
}
```

## 3. SSAO-Style Depth-Sampling Pass

A full-screen pass that samples the depth buffer as `texture_depth_2d` and
reconstructs view-space position with the inverse projection matrix.

### WGSL shader

```wgsl
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  var out: VsOut;
  out.pos = vec4f(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(x, 1.0 - y);          // Y-flip for framebuffer-space UV
  return out;
}

struct Camera { inv_proj: mat4x4f };
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var depth_tex: texture_depth_2d;

// Reconstruct view-space position from non-linear depth.
fn view_pos_from_depth(uv: vec2f, raw_depth: f32) -> vec3f {
  // WebGPU NDC Z is [0,1], so raw_depth maps straight into the Z slot.
  let ndc = vec4f(uv.x * 2.0 - 1.0, uv.y * 2.0 - 1.0, raw_depth, 1.0);
  let h = camera.inv_proj * ndc;
  return h.xyz / h.w;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let dims = textureDimensions(depth_tex);
  let coord = vec2i(in.uv * vec2f(dims));
  // textureLoad reads depth with integer coords and NO sampler.
  let raw_depth = textureLoad(depth_tex, coord, 0);
  let view_pos = view_pos_from_depth(in.uv, raw_depth);

  // Simple SSAO term: compare neighbour depths to this fragment's depth.
  var occlusion = 0.0;
  for (var k = 0; k < 8; k = k + 1) {
    let offs = vec2i(k - 4, ((k * 3) % 7) - 3);
    let nd = textureLoad(depth_tex, coord + offs, 0);
    let np = view_pos_from_depth(in.uv, nd);
    if (np.z > view_pos.z + 0.02) { occlusion = occlusion + 1.0; }
  }
  let ao = 1.0 - occlusion / 8.0;
  return vec4f(ao, ao, ao, 1.0);
}
```

### Host side

```js
// Depth texture sampled by the SSAO pass needs TEXTURE_BINDING.
const depthTex = device.createTexture({
  label: "scene-depth",
  size: [canvas.width, canvas.height],
  format: "depth32float",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});

const ssaoLayout = device.createBindGroupLayout({
  label: "ssao-bgl",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" } },                       // inverse projection
    { binding: 1, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "depth", viewDimension: "2d" } },
  ],
});

const ssaoBindGroup = device.createBindGroup({
  label: "ssao-bg",
  layout: ssaoLayout,
  entries: [
    { binding: 0, resource: { buffer: cameraUniformBuffer } },
    { binding: 1, resource: depthTex.createView() },
  ],
});
// The geometry pass writes depthTex; a separate later pass runs the SSAO shader
// above. Pass chaining is covered by webgpu-impl-multipass.
```
