# Render Targets : Verified Examples

Version: WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+.
Every example is verified against the W3C WebGPU specification, MDN
`GPUCommandEncoder/beginRenderPass`, and the official WebGPU Samples
(https://webgpu.github.io/webgpu-samples/), all fetched 2026-05-20.

## 1. Single color target onto the canvas

A render pass with one color attachment writing into the canvas swap-chain texture.
The color view is created fresh every frame.

```js
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();
const context = canvas.getContext("webgpu");
const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format: canvasFormat });

const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module: shaderModule, entryPoint: "vs" },
  fragment: {
    module: shaderModule,
    entryPoint: "fs",
    targets: [{ format: canvasFormat }], // matches the single color attachment
  },
  primitive: { topology: "triangle-list" },
});

function frame() {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(), // fresh each frame
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: 0.1, g: 0.2, b: 0.4, a: 1.0 },
    }],
  });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

## 2. Multiple render targets (MRT)

Two color attachments. The fragment shader writes `@location(0)` and `@location(1)`;
the pipeline `fragment.targets` has two entries with matching formats. This is the
shape of a deferred-shading G-buffer pass.

```js
const albedoTex = device.createTexture({
  size: [width, height],
  format: "rgba8unorm",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});
const normalTex = device.createTexture({
  size: [width, height],
  format: "rgba16float",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});

const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module: gbufferModule, entryPoint: "vs" },
  fragment: {
    module: gbufferModule,
    entryPoint: "fs",
    targets: [
      { format: "rgba8unorm" },  // matches albedoTex, @location(0)
      { format: "rgba16float" }, // matches normalTex, @location(1)
    ],
  },
  primitive: { topology: "triangle-list" },
});

const encoder = device.createCommandEncoder();
const pass = encoder.beginRenderPass({
  colorAttachments: [
    { view: albedoTex.createView(), loadOp: "clear", storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 1 } },
    { view: normalTex.createView(), loadOp: "clear", storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 1 } },
  ],
});
pass.setPipeline(pipeline);
pass.draw(36);
pass.end();
device.queue.submit([encoder.finish()]);
```

The matching fragment shader output struct:

```wgsl
struct GBufferOut {
  @location(0) albedo : vec4f,
  @location(1) normal : vec4f,
}
@fragment fn fs(/* inputs */) -> GBufferOut {
  return GBufferOut(vec4f(1.0, 0.5, 0.2, 1.0), vec4f(0.0, 0.0, 1.0, 1.0));
}
```

## 3. Color target plus a depth attachment

A depth-tested pass. The depth texture format equals the pipeline
`depthStencil.format`.

```js
const depthTexture = device.createTexture({
  size: [width, height],
  format: "depth24plus",
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});

const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module: shaderModule, entryPoint: "vs" },
  fragment: {
    module: shaderModule,
    entryPoint: "fs",
    targets: [{ format: canvasFormat }],
  },
  primitive: { topology: "triangle-list", cullMode: "back" },
  depthStencil: {
    format: "depth24plus",       // matches depthTexture
    depthWriteEnabled: true,
    depthCompare: "less",
  },
});

const encoder = device.createCommandEncoder();
const pass = encoder.beginRenderPass({
  colorAttachments: [{
    view: context.getCurrentTexture().createView(),
    loadOp: "clear",
    storeOp: "store",
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
  }],
  depthStencilAttachment: {
    view: depthTexture.createView(),
    depthClearValue: 1.0,
    depthLoadOp: "clear",
    depthStoreOp: "store",
  },
});
pass.setPipeline(pipeline);
pass.draw(36);
pass.end();
device.queue.submit([encoder.finish()]);
```

## 4. MSAA with resolveTarget

A multisampled color texture renders with `sampleCount: 4`, the pipeline declares
`multisample.count: 4`, and the GPU resolves into the single-sample canvas view.

```js
const sampleCount = 4;

const msaaTexture = device.createTexture({
  size: [width, height],
  sampleCount,                   // multisampled
  format: canvasFormat,
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});

const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module: shaderModule, entryPoint: "vs" },
  fragment: {
    module: shaderModule,
    entryPoint: "fs",
    targets: [{ format: canvasFormat }],
  },
  primitive: { topology: "triangle-list" },
  multisample: { count: sampleCount }, // SAME value as the texture
});

function frame() {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: msaaTexture.createView(),                          // sampleCount 4
      resolveTarget: context.getCurrentTexture().createView(), // sampleCount 1
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

When the canvas resizes, recreate `msaaTexture` (and any depth texture) at the new
size, because their dimensions MUST match the resolve target.

## 5. MSAA with a multisampled depth attachment

When MSAA is combined with depth testing, the depth texture also uses
`sampleCount: 4`. There is no resolve for depth; `storeOp: "discard"` drops the
multisampled depth after the pass.

```js
const sampleCount = 4;
const msaaColor = device.createTexture({
  size: [width, height], sampleCount, format: canvasFormat,
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});
const msaaDepth = device.createTexture({
  size: [width, height], sampleCount, format: "depth24plus",
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});

const encoder = device.createCommandEncoder();
const pass = encoder.beginRenderPass({
  colorAttachments: [{
    view: msaaColor.createView(),
    resolveTarget: context.getCurrentTexture().createView(),
    loadOp: "clear",
    storeOp: "store",
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
  }],
  depthStencilAttachment: {
    view: msaaDepth.createView(),
    depthClearValue: 1.0,
    depthLoadOp: "clear",
    depthStoreOp: "discard", // multisampled depth is transient
  },
});
pass.setPipeline(msaaDepthPipeline); // multisample.count 4, depthStencil depth24plus
pass.draw(36);
pass.end();
device.queue.submit([encoder.finish()]);
```

## 6. Depth-only pass (shadow map)

A pass with an empty `colorAttachments` array and only a depth attachment, writing
scene depth from the light's viewpoint. The pipeline declares no `fragment` stage.

```js
const shadowMap = device.createTexture({
  size: [2048, 2048],
  format: "depth32float",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});

const shadowPipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module: shadowModule, entryPoint: "vs" },
  // no fragment stage: depth-only
  primitive: { topology: "triangle-list" },
  depthStencil: {
    format: "depth32float",      // matches shadowMap
    depthWriteEnabled: true,
    depthCompare: "less",
  },
});

const encoder = device.createCommandEncoder();
const pass = encoder.beginRenderPass({
  colorAttachments: [],          // empty: no color targets
  depthStencilAttachment: {
    view: shadowMap.createView(),
    depthClearValue: 1.0,
    depthLoadOp: "clear",
    depthStoreOp: "store",
  },
});
pass.setPipeline(shadowPipeline);
pass.draw(sceneVertexCount);
pass.end();
device.queue.submit([encoder.finish()]);
```

The main pass then binds `shadowMap` with a comparison sampler. The full
offscreen-to-screen multi-pass workflow is covered by `webgpu-impl-multipass`.
