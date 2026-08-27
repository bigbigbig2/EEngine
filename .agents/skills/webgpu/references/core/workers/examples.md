# Examples: WebGPU in Web Workers

Every example below uses only API names verified against the W3C WebGPU
specification, MDN, and the WebGPU Explainer. Baseline: WebGPU 1.0-stable
(Chrome 113+, Safari 26+, Firefox 141+).

## Example 1: Main thread transfers a DOM canvas to a worker

The main thread owns the DOM. It creates the worker, transfers the canvas, and
runs the `ResizeObserver`. It never touches WebGPU itself.

```js
// main.js (runs on the main thread)

const canvas = document.getElementById("gpu-canvas");

// Transfer rendering control. This is permanent and runs exactly once.
const offscreen = canvas.transferControlToOffscreen();

// Start the dedicated worker (module worker so it can `import` if needed).
const worker = new Worker("render-worker.js", { type: "module" });

// Send the OffscreenCanvas. It MUST appear in the transfer list (2nd argument).
worker.postMessage(
  { type: "init", canvas: offscreen },
  [offscreen],
);

// The worker has no DOM, so layout changes are observed here and messaged over.
const observer = new ResizeObserver((entries) => {
  const entry = entries[0];
  const width = Math.round(entry.contentBoxSize[0].inlineSize);
  const height = Math.round(entry.contentBoxSize[0].blockSize);
  worker.postMessage({ type: "resize", width, height });
});
observer.observe(canvas);
```

Notes:

- `transferControlToOffscreen()` runs on the main thread because it is a method of `HTMLCanvasElement`.
- `[offscreen]` is the transfer list. Without it, `postMessage` throws `DataCloneError`.
- After transfer, `canvas` is no longer usable for rendering from the main thread.
- The `ResizeObserver` stays on the main thread; only the resulting size is sent to the worker.

## Example 2: Worker receives the canvas and runs the WebGPU render loop

The worker owns WebGPU. It accesses `navigator.gpu` (which is `WorkerNavigator.gpu`
inside a worker), gets the WebGPU context from the OffscreenCanvas, and renders.

```js
// render-worker.js (runs inside a dedicated worker)

let device;
let context;
let canvas;       // the transferred OffscreenCanvas
let format;
let pipeline;

self.onmessage = async (event) => {
  const msg = event.data;

  if (msg.type === "init") {
    canvas = msg.canvas;             // the transferred OffscreenCanvas
    await initWebGPU();
    requestAnimationFrame(frame);    // available inside a worker scope
  }

  if (msg.type === "resize") {
    // The worker resizes the swap-chain by writing width/height.
    canvas.width = msg.width;
    canvas.height = msg.height;
  }
};

async function initWebGPU() {
  // navigator.gpu inside a worker resolves to WorkerNavigator.gpu.
  if (!navigator.gpu) {
    throw new Error("WebGPU is not available in this worker.");
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No WebGPU adapter available.");
  }
  device = await adapter.requestDevice();

  // getContext("webgpu") on an OffscreenCanvas returns a GPUCanvasContext.
  context = canvas.getContext("webgpu");
  format = navigator.gpu.getPreferredCanvasFormat();

  // Configure before any getCurrentTexture() call.
  context.configure({
    device,
    format,
    alphaMode: "opaque",
  });

  const module = device.createShaderModule({
    code: `
      @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
        let p = array(vec2f(0, 0.5), vec2f(-0.5, -0.5), vec2f(0.5, -0.5));
        return vec4f(p[i], 0, 1);
      }
      @fragment fn fs() -> @location(0) vec4f {
        return vec4f(0.2, 0.6, 1.0, 1.0);
      }
    `,
  });

  pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
}

function frame() {
  // getCurrentTexture() is called fresh every frame, never cached.
  const view = context.getCurrentTexture().createView();

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view,
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: "clear",
      storeOp: "store",
    }],
  });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();

  device.queue.submit([encoder.finish()]);

  // The render loop runs entirely on the worker thread, off the main thread.
  requestAnimationFrame(frame);
}
```

Notes:

- `navigator.gpu` inside the worker is the `WorkerNavigator.gpu` property.
- The worker only ever holds the transferred OffscreenCanvas. It never calls `document` or `window`.
- `requestAnimationFrame` is available in a dedicated worker scope and drives the loop off the main thread.
- The resize handler writes `canvas.width` and `canvas.height`; it does not read any layout.

## Example 3: Worker-only OffscreenCanvas with no DOM canvas

When the output is read back to the CPU or encoded to an image, no DOM `<canvas>`
and no `transferControlToOffscreen()` are needed. The worker constructs the
OffscreenCanvas directly.

```js
// headless-worker.js (runs inside a dedicated worker)

async function renderHeadless() {
  // No DOM canvas. The worker creates the surface itself.
  const canvas = new OffscreenCanvas(512, 512);

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No WebGPU adapter available.");
  }
  const device = await adapter.requestDevice();

  const context = canvas.getContext("webgpu");
  context.configure({
    device,
    format: navigator.gpu.getPreferredCanvasFormat(),
  });

  // ... record and submit a render pass into context.getCurrentTexture() ...

  // Encode the rendered frame to a Blob and send it back to the main thread.
  const blob = await canvas.convertToBlob();
  self.postMessage({ type: "frame", blob });
}
```

Notes:

- `new OffscreenCanvas(512, 512)` builds the surface in the worker with no DOM involvement.
- `convertToBlob()` returns a `Promise<Blob>`; `transferToImageBitmap()` returns an `ImageBitmap` if a live texture handoff is preferred.
- This pattern suits compute-to-image, server-style rendering, and offscreen capture.

## Verified Sources

- https://developer.mozilla.org/en-US/docs/Web/API/WorkerNavigator/gpu
- https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas
- https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas/getContext
- https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/transferControlToOffscreen
- https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API
- https://www.w3.org/TR/webgpu/
