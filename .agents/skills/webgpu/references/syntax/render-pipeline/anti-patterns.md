# Render Pipeline: Anti-Patterns

WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+. Each entry states the
mistake, WHY it fails, and the fix. Verified against the W3C WebGPU specification
and `docs/research/vooronderzoek-webgpu.md` PART A section 3 and PART C section 1.

## 1. Fragment target format not matching the attachment format

```js
// WRONG: hardcoded canvas format
context.configure({ device, format: "bgra8unorm" });
const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module },
  fragment: { module, targets: [{ format: "rgba8unorm" }] },
});
```

WHY it fails: `createRenderPipeline` succeeds because the format is a valid
texture format in isolation. The failure surfaces later: `beginRenderPass` or the
draw call rejects with a validation error because the pipeline target format does
not equal the color attachment view format. On Safari and some platforms the
preferred canvas format is `"rgba8unorm"` rather than `"bgra8unorm"`, so a
hardcoded value silently breaks cross-platform.

```js
// CORRECT
const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format });
const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module },
  fragment: { module, targets: [{ format }] },
});
```

The same rule applies to offscreen targets: `fragment.targets[i].format` MUST
equal the texture format of `colorAttachments[i]`, and the target count MUST
equal the attachment count.

## 2. Vertex attribute offset or shaderLocation not matching the WGSL @location

```wgsl
// WGSL vertex input
@vertex fn vs(@location(0) pos : vec3f, @location(1) uv : vec2f) -> ...
```

```js
// WRONG: offset and shaderLocation do not match the WGSL layout
buffers: [{
  arrayStride: 20,
  attributes: [
    { shaderLocation: 0, offset: 0,  format: "float32x2" }, // should be x3
    { shaderLocation: 2, offset: 16, format: "float32x2" }, // no @location(2)
  ],
}]
```

WHY it fails: a `shaderLocation` with no matching WGSL `@location` fails pipeline
validation outright. A wrong `format` (here `float32x2` for a `vec3f` input) or a
wrong `offset` does not always fail validation; it reads the wrong bytes, so the
mesh renders as garbage geometry with no error reported. The bug is invisible
until the screen output is wrong.

```js
// CORRECT: format, offset, and shaderLocation all match WGSL
buffers: [{
  arrayStride: 20, // 3*4 + 2*4
  attributes: [
    { shaderLocation: 0, offset: 0,  format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "float32x2" },
  ],
}]
```

`arrayStride` MUST equal the byte size of one vertex; each `offset` plus its
format size MUST not exceed `arrayStride`.

## 3. depthStencil format not matching the depth attachment

```js
// WRONG: pipeline depth format differs from the depth texture format
const depthTexture = device.createTexture({
  size: [w, h], format: "depth24plus",
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});
const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module },
  fragment: { module, targets: [{ format }] },
  depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" },
});
```

WHY it fails: `beginRenderPass` with this pipeline's draw rejects with a
validation error because the `depthStencilAttachment` view format
(`"depth24plus"`) does not equal `depthStencil.format` (`"depth32float"`). A
related failure is omitting `depthStencil` entirely when the render pass declares
a `depthStencilAttachment`: the pipeline-versus-pass depth mismatch also fails
validation.

```js
// CORRECT: identical format in the texture and the pipeline
const depthTexture = device.createTexture({
  size: [w, h], format: "depth24plus",
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});
const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module },
  fragment: { module, targets: [{ format }] },
  depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
});
```

## 4. Recreating the pipeline every frame

```js
// WRONG: createRenderPipeline inside the render loop
function frame() {
  const pipeline = device.createRenderPipeline(descriptor); // rebuilt every frame
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass(passDescriptor);
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(frame);
}
```

WHY it fails: `GPURenderPipeline` objects are immutable and expensive to build.
This is not a validation error, so it produces no message, but each call
re-validates the descriptor and recompiles or re-links the shader and fixed-state
pipeline. The result is severe per-frame jank and dropped frames that worsens with
shader complexity.

```js
// CORRECT: build once at load time, reuse every frame
const pipeline = device.createRenderPipeline(descriptor); // built once
function frame() {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass(passDescriptor);
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(frame);
}
```

For heavy shaders during loading, use `createRenderPipelineAsync` so compilation
does not block the content timeline.

## 5. Wrong stripIndexFormat for a strip topology

```js
// WRONG: triangle-strip drawn with drawIndexed but no stripIndexFormat,
// or a stripIndexFormat that disagrees with setIndexBuffer
const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module, buffers: [vbLayout] },
  fragment: { module, targets: [{ format }] },
  primitive: { topology: "triangle-strip", stripIndexFormat: "uint32" },
});
pass.setIndexBuffer(indexBuffer, "uint16"); // disagrees with the pipeline
pass.drawIndexed(count);
```

WHY it fails: for a strip topology, the GPU needs the index format to know the
primitive-restart value. If `stripIndexFormat` is omitted, an indexed draw with a
strip topology fails validation. If it is set but disagrees with `setIndexBuffer`,
the draw fails validation because the pipeline and the bound index buffer report
different index widths.

```js
// CORRECT: stripIndexFormat equals the setIndexBuffer format
const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module, buffers: [vbLayout] },
  fragment: { module, targets: [{ format }] },
  primitive: { topology: "triangle-strip", stripIndexFormat: "uint16" },
});
pass.setIndexBuffer(indexBuffer, "uint16");
pass.drawIndexed(count);
```

For list topologies (`"triangle-list"`, `"line-list"`, `"point-list"`), omit
`stripIndexFormat`; setting it on a list topology fails validation.

## 6. Mismatched multisample count between pipeline and attachments

```js
// WRONG: 4x MSAA color texture but a single-sample pipeline
const msaaTexture = device.createTexture({
  size: [w, h], sampleCount: 4, format,
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});
const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module },
  fragment: { module, targets: [{ format }] },
  multisample: { count: 1 }, // does not match sampleCount 4
});
```

WHY it fails: the draw call rejects with a validation error because
`multisample.count` MUST equal the `sampleCount` of every attachment texture. The
only valid sample counts are 1 and 4.

```js
// CORRECT: pipeline count equals the attachment sampleCount
const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module },
  fragment: { module, targets: [{ format }] },
  multisample: { count: 4 },
});
```

When resolving MSAA, the color attachment `resolveTarget` MUST be a single-sample
view (`sampleCount: 1`) with a format matching the multisampled attachment.

## 7. Reusing an auto-layout bind group across pipelines

WHY it fails: when `layout` is `"auto"`, the implicit bind-group layouts from
`pipelineA.getBindGroupLayout(0)` belong only to `pipelineA`. A bind group made
from that layout cannot be used with `pipelineB`; the draw fails validation. For
resources shared across multiple pipelines, create an explicit `GPUPipelineLayout`
and pass it as the `layout` field. See `webgpu-core-pipeline-architecture`.

## Reference sources

- https://www.w3.org/TR/webgpu/ (W3C WebGPU specification)
- https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createRenderPipeline
- `docs/research/vooronderzoek-webgpu.md` PART A section 3, PART C section 1,
  Anti-Patterns Catalog entries 8, 11, 12, 13
