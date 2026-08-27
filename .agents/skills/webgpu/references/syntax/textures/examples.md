# Examples: WebGPU Textures, Views and Samplers

Verified working code. Every example targets WebGPU 1.0-stable
(Chrome 113+, Safari 26+, Firefox 141+) and assumes an initialized `device`.
All API names verified against the W3C WebGPU spec and MDN on 2026-05-20.

## 1. Sampled texture: upload an image and bind it

Create a texture with `COPY_DST | TEXTURE_BINDING`, upload pixels with
`queue.copyExternalImageToTexture`, then create a sampler and a bind group.

```js
async function loadTexture(device, url) {
  const response = await fetch(url);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" });

  const texture = device.createTexture({
    label: url,
    size: [bitmap.width, bitmap.height, 1],
    format: "rgba8unorm-srgb",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });

  // RENDER_ATTACHMENT is required by copyExternalImageToTexture.
  device.queue.copyExternalImageToTexture(
    { source: bitmap },
    { texture },
    [bitmap.width, bitmap.height],
  );

  return texture;
}

const texture = await loadTexture(device, "/assets/wood.png");

const sampler = device.createSampler({
  addressModeU: "repeat",
  addressModeV: "repeat",
  magFilter: "linear",
  minFilter: "linear",
});

const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: sampler },
    { binding: 1, resource: texture.createView() },
  ],
});
```

## 2. Render-target texture: render to an offscreen texture

A texture used as a render-pass color attachment and later sampled needs both
`RENDER_ATTACHMENT` and `TEXTURE_BINDING`.

```js
const sceneTexture = device.createTexture({
  label: "scene-color",
  size: [canvas.width, canvas.height],
  format: "rgba16float", // HDR intermediate target
  usage:
    GPUTextureUsage.RENDER_ATTACHMENT |
    GPUTextureUsage.TEXTURE_BINDING,
});

const sceneView = sceneTexture.createView();

const encoder = device.createCommandEncoder();
const pass = encoder.beginRenderPass({
  colorAttachments: [{
    view: sceneView,
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
    loadOp: "clear",
    storeOp: "store",
  }],
});
// ...draw the scene into sceneTexture...
pass.end();
device.queue.submit([encoder.finish()]);
// sceneTexture can now be sampled by a post-process pass.
```

## 3. Mipmapped texture and a single-level view

`mipLevelCount > 1` allocates the levels. WebGPU does NOT generate them; each
level MUST be written. After the chain is filled, a view can target one level.

```js
function mipLevelCountFor(width, height) {
  return 1 + Math.floor(Math.log2(Math.max(width, height)));
}

const w = 512, h = 512;
const mipped = device.createTexture({
  label: "mipped-albedo",
  size: [w, h],
  mipLevelCount: mipLevelCountFor(w, h), // 10 for 512x512
  format: "rgba8unorm-srgb",
  usage:
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.COPY_DST |
    GPUTextureUsage.RENDER_ATTACHMENT, // needed if generating mips by rendering
});

// Upload level 0 explicitly; higher levels must be filled separately
// (for example by a render-based downsample pass).
device.queue.writeTexture(
  { texture: mipped, mipLevel: 0 },
  level0Pixels,
  { bytesPerRow: w * 4, rowsPerImage: h },
  [w, h],
);

// A view of just mip level 3:
const oneLevel = mipped.createView({ baseMipLevel: 3, mipLevelCount: 1 });

// A full-chain view for sampling with a mipmapping sampler:
const fullView = mipped.createView();
```

A sampler that uses the mip chain sets `mipmapFilter`:

```js
const mipSampler = device.createSampler({
  magFilter: "linear",
  minFilter: "linear",
  mipmapFilter: "linear", // trilinear filtering across mip levels
});
```

## 4. Sampler creation: filtering, non-filtering, comparison, anisotropic

```js
// Filtering sampler for normal color textures.
const filtering = device.createSampler({
  magFilter: "linear",
  minFilter: "linear",
});

// Non-filtering sampler for data textures sampled point-wise.
const nonFiltering = device.createSampler({
  magFilter: "nearest",
  minFilter: "nearest",
  mipmapFilter: "nearest",
});

// Comparison sampler for shadow maps. Binds to sampler { type: "comparison" }
// and is sampled in WGSL with textureSampleCompare.
const shadowSampler = device.createSampler({
  compare: "less",
  magFilter: "linear",
  minFilter: "linear",
});

// Anisotropic sampler. maxAnisotropy > 1 requires all three filters "linear".
const anisotropic = device.createSampler({
  magFilter: "linear",
  minFilter: "linear",
  mipmapFilter: "linear",
  maxAnisotropy: 16,
});
```

Matching bind-group layout entries:

```js
const layout = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: "filtering" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: "comparison" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float", viewDimension: "2d" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "depth", viewDimension: "2d" } },
  ],
});
```

## 5. External texture from a video element

`importExternalTexture` with an `HTMLVideoElement` source produces a
single-frame `GPUExternalTexture`. Re-import and rebuild the bind group every
frame inside the render loop.

```js
const video = document.createElement("video");
video.src = "/assets/clip.mp4";
video.loop = true;
video.muted = true;
await video.play();

const videoSampler = device.createSampler({
  magFilter: "linear",
  minFilter: "linear",
});

// Layout entry for an external texture is externalTexture: {}.
const videoLayout = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: "filtering" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT,
      externalTexture: {} },
  ],
});

function frame() {
  // Re-import every frame: the external texture from a video element
  // expires after the task that first uses it.
  const externalTexture = device.importExternalTexture({ source: video });

  const bindGroup = device.createBindGroup({
    layout: videoLayout,
    entries: [
      { binding: 0, resource: videoSampler },
      { binding: 1, resource: externalTexture },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
  pass.setPipeline(videoPipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(6); // full-screen quad
  pass.end();
  device.queue.submit([encoder.finish()]);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

For a `VideoFrame` source the external texture stays valid until
`VideoFrame.close()`, so it can be reused within that frame's lifetime.

## 6. MSAA texture and resolve

A 4x multisample color texture has `RENDER_ATTACHMENT` usage only and resolves
into a single-sample target.

```js
const msaaTexture = device.createTexture({
  size: [canvas.width, canvas.height],
  sampleCount: 4,
  format: presentationFormat,
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});

const pass = encoder.beginRenderPass({
  colorAttachments: [{
    view: msaaTexture.createView(),
    resolveTarget: context.getCurrentTexture().createView(),
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
    loadOp: "clear",
    storeOp: "store",
  }],
});
// The render pipeline must set multisample: { count: 4 }.
```

## Cross-references

- `webgpu-syntax-canvas-context` : canvas format and per-frame texture.
- `webgpu-syntax-bind-groups` : bind-group and layout entry shapes.
- `webgpu-wgsl-textures` : WGSL `texture_2d`, `texture_external`, sampling.
- `webgpu-impl-render-targets` : full MSAA and mipmap-generation workflows.
