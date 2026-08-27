# Canvas Context Anti-Patterns

Common WebGPU canvas-context mistakes with root-cause analysis. Verified against the
W3C WebGPU specification, the gpuweb explainer, and MDN on 2026-05-20. Baseline:
WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## Caching getCurrentTexture() across frames

NEVER store the result of `getCurrentTexture()` or its `createView()` and reuse it on a
later frame.

```js
// WRONG: the texture and view are captured once and reused.
const texture = context.getCurrentTexture();
const view = texture.createView();
function frame() {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view, loadOp: "clear", storeOp: "store" }],
  });
  pass.end();
  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(frame);
}
```

WHY it fails: the canvas context owns a rotating set of swap-chain textures. Each frame
the browser composites the current texture and rotates to the next slot. A cached
texture points at a slot that is no longer the presentable one. The visible result is a
black or frozen canvas; some browsers raise a validation error reporting that the
texture is already in use or no longer current.

```js
// CORRECT: acquire the texture and view fresh inside the frame.
function frame() {
  const view = context.getCurrentTexture().createView();
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view, loadOp: "clear", storeOp: "store" }],
  });
  pass.end();
  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(frame);
}
```

## Setting only CSS size, not the width/height attributes

NEVER size a WebGPU canvas with CSS alone.

```js
// WRONG: CSS scales the element but the swap-chain stays at the default 300x150.
canvas.style.width = "1920px";
canvas.style.height = "1080px";
context.configure({ device, format });
```

WHY it fails: the swap-chain texture resolution is fixed by the `canvas.width` and
`canvas.height` integer attributes, which default to 300x150. CSS `width`/`height` only
stretch the displayed element. The GPU renders 300x150 pixels and the browser upscales
that to the CSS box, producing a visibly blurry, pixelated image. On high-DPI displays
the effect is worse because device pixels outnumber CSS pixels.

```js
// CORRECT: write the device-pixel size into the attributes.
const dpr = window.devicePixelRatio || 1;
canvas.width = Math.round(canvas.clientWidth * dpr);
canvas.height = Math.round(canvas.clientHeight * dpr);
context.configure({ device, format });
```

## Calling getCurrentTexture() before configure()

NEVER call `getCurrentTexture()` on a context that has not been configured.

```js
// WRONG: the context has no device and no swap-chain yet.
const context = canvas.getContext("webgpu");
const texture = context.getCurrentTexture(); // throws InvalidStateError
```

WHY it fails: `getContext("webgpu")` returns a context that is not yet bound to any
`GPUDevice`. The swap-chain textures only exist after `configure()` allocates them.
Calling `getCurrentTexture()` on an unconfigured context throws an `InvalidStateError`
`DOMException`. The same error returns after `unconfigure()` until `configure()` runs
again.

```js
// CORRECT: configure first, then acquire the texture.
const context = canvas.getContext("webgpu");
context.configure({
  device,
  format: navigator.gpu.getPreferredCanvasFormat(),
});
const texture = context.getCurrentTexture(); // valid
```

## Hardcoding the canvas format

NEVER hardcode `"bgra8unorm"` (or any literal) as the `configure()` format.

```js
// WRONG: assumes every platform prefers bgra8unorm.
context.configure({ device, format: "bgra8unorm" });
```

WHY it fails: the preferred canvas format is platform-dependent. Most desktop GPUs
prefer `"bgra8unorm"`, but some mobile and integrated GPUs prefer `"rgba8unorm"`.
Passing the non-preferred format is allowed but forces the browser to run a color
channel conversion on every composited frame, costing performance for no benefit. A
hardcoded format also desynchronizes from the render pipeline: the pipeline's
`fragment.targets[0].format` must equal the `configure()` format.

```js
// CORRECT: query the platform and reuse the value for the pipeline target.
const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format });
const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module: shaderModule, entryPoint: "vs" },
  fragment: {
    module: shaderModule,
    entryPoint: "fs",
    targets: [{ format }], // same format as the canvas
  },
});
```

## Forgetting that usage replaces the default

NEVER set `usage` to a single non-`RENDER_ATTACHMENT` flag expecting the default to
remain.

```js
// WRONG: the canvas texture can now be copied but NOT rendered into.
context.configure({
  device,
  format,
  usage: GPUTextureUsage.COPY_SRC,
});
```

WHY it fails: the `usage` field default is `GPUTextureUsage.RENDER_ATTACHMENT`, but
setting `usage` REPLACES the default rather than adding to it. With `usage` set to only
`COPY_SRC`, the canvas texture lacks `RENDER_ATTACHMENT`, so using it as a render-pass
color attachment fails validation.

```js
// CORRECT: OR in every flag the texture needs.
context.configure({
  device,
  format,
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});
```

## Reference sources

- https://developer.mozilla.org/en-US/docs/Web/API/GPUCanvasContext/configure
- https://developer.mozilla.org/en-US/docs/Web/API/GPUCanvasContext/getCurrentTexture
- https://www.w3.org/TR/webgpu/
- https://gpuweb.github.io/gpuweb/explainer/
