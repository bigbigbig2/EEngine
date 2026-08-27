# Canvas Context Examples

Working code verified against the W3C WebGPU specification, the gpuweb explainer, and
MDN on 2026-05-20. Baseline: WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## Example 1: Context setup

Acquire the context, pick the preferred format, and configure with an opaque alpha mode.

```js
async function setupCanvas(canvas) {
  // Adapter and device acquisition: see webgpu-core-architecture.
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No WebGPU adapter available.");
  }
  const device = await adapter.requestDevice();

  // Get the context. It is created independent of the device.
  const context = canvas.getContext("webgpu");
  if (!context) {
    throw new Error("WebGPU canvas context unavailable.");
  }

  // ALWAYS get the format from the platform, never hardcode it.
  const format = navigator.gpu.getPreferredCanvasFormat();

  // configure() binds the device and allocates the swap-chain.
  context.configure({
    device,
    format,
    alphaMode: "opaque",
  });

  return { device, context, format };
}
```

## Example 2: Transparent canvas with premultiplied alpha

Use `alphaMode: "premultiplied"` when the canvas overlays HTML content. The fragment
shader output RGB MUST already be multiplied by its alpha.

```js
context.configure({
  device,
  format: navigator.gpu.getPreferredCanvasFormat(),
  alphaMode: "premultiplied",
});

// In the render pass, a clearValue with alpha < 1 lets the page show through.
const renderPassDescriptor = {
  colorAttachments: [
    {
      view: context.getCurrentTexture().createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 0 }, // fully transparent
      loadOp: "clear",
      storeOp: "store",
    },
  ],
};
```

## Example 3: Per-frame texture acquisition

Call `getCurrentTexture()` fresh every frame. NEVER cache the texture or its view.

```js
function frameLoop(device, context, pipeline) {
  function frame() {
    // Fresh texture every frame. The swap-chain rotates after composite.
    const texture = context.getCurrentTexture();
    // Fresh view every frame; do not hoist this out of the loop.
    const view = texture.createView();

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: 0.1, g: 0.1, b: 0.15, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.draw(3); // example: a single triangle
    pass.end();

    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
```

## Example 4: ResizeObserver resize handling

A responsive canvas resizes its swap-chain by writing the device-pixel size into the
`width`/`height` attributes. The size is clamped to `device.limits.maxTextureDimension2D`.

```js
function observeCanvasResize(canvas, device, drawFrame) {
  const maxDim = device.limits.maxTextureDimension2D; // default 8192

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      // devicePixelContentBoxSize gives the exact size in device pixels,
      // already accounting for devicePixelRatio.
      const box = entry.devicePixelContentBoxSize[0];
      const width = Math.max(1, Math.min(box.inlineSize, maxDim));
      const height = Math.max(1, Math.min(box.blockSize, maxDim));

      // Set the ATTRIBUTES, not CSS. This resizes the swap-chain.
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    }
    // Render at the new size. getCurrentTexture() now returns the new dimensions.
    drawFrame();
  });

  // contentBox is the broadly supported fallback box; devicePixelContentBox
  // gives exact device pixels where available.
  observer.observe(canvas, { box: "content-box" });
  return observer;
}
```

## Example 5: Full minimal end-to-end canvas render

A complete clear-to-color render combining setup, resize, and the frame loop.

```js
async function run(canvas) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter.");
  const device = await adapter.requestDevice();

  const context = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  function drawFrame() {
    const view = context.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: 0.2, g: 0.4, b: 0.8, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  const maxDim = device.limits.maxTextureDimension2D;
  const observer = new ResizeObserver((entries) => {
    const box = entries[0].devicePixelContentBoxSize?.[0]
      ?? entries[0].contentBoxSize[0];
    canvas.width = Math.max(1, Math.min(box.inlineSize, maxDim));
    canvas.height = Math.max(1, Math.min(box.blockSize, maxDim));
    drawFrame();
  });
  observer.observe(canvas);

  drawFrame();
}
```

## Example 6: Releasing the context

Call `unconfigure()` to free swap-chain memory when a canvas is hidden or destroyed.

```js
function teardownCanvas(context, observer) {
  observer.disconnect();
  context.unconfigure(); // frees swap-chain textures; getCurrentTexture now throws
}
```

## Reference sources

- https://developer.mozilla.org/en-US/docs/Web/API/GPUCanvasContext/configure
- https://developer.mozilla.org/en-US/docs/Web/API/GPUCanvasContext/getCurrentTexture
- https://www.w3.org/TR/webgpu/
- https://webgpu.github.io/webgpu-samples/
