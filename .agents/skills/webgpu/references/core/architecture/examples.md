# WebGPU Core Architecture: Verified Examples

Working WebGPU initialization code. Baseline: WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). Every example is verified against the W3C WebGPU specification, the gpuweb explainer, and MDN.

## Example 1: Minimal correct initialization

The smallest correct WebGPU startup. It guards `navigator.gpu`, null-checks the adapter, and registers `device.lost` before any resource is created.

```js
async function initWebGPU() {
  if (!navigator.gpu) {
    throw new Error("WebGPU is not available. Use HTTPS or localhost, and a supporting browser.");
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No WebGPU adapter found.");
  }

  const device = await adapter.requestDevice();
  device.lost.then((info) => {
    console.error(`Device lost: ${info.reason} : ${info.message}`);
  });

  const queue = device.queue;   // property access, never a call
  return { adapter, device, queue };
}
```

## Example 2: Initialization with powerPreference and a labeled device

`powerPreference` is a hint. The `label` is quoted in validation messages, which makes debugging concrete.

```js
async function initHighPerformance() {
  if (!navigator.gpu) {
    throw new Error("WebGPU is not available.");
  }

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) {
    throw new Error("No WebGPU adapter found.");
  }

  const device = await adapter.requestDevice({
    label: "main-render-device",
  });
  device.lost.then((info) => {
    console.error(`Device lost: ${info.reason} : ${info.message}`);
  });

  return { adapter, device, queue: device.queue };
}
```

## Example 3: Feature negotiation against the adapter

ALWAYS test `adapter.features.has(...)` before adding a feature to `requiredFeatures`. Requesting an absent feature makes `requestDevice` fail.

```js
async function initWithOptionalFeatures() {
  if (!navigator.gpu) {
    throw new Error("WebGPU is not available.");
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No WebGPU adapter found.");
  }

  const wanted = ["shader-f16", "timestamp-query"];
  const requiredFeatures = wanted.filter((f) => adapter.features.has(f));

  const device = await adapter.requestDevice({
    label: "feature-aware-device",
    requiredFeatures,
  });
  device.lost.then((info) => {
    console.error(`Device lost: ${info.reason} : ${info.message}`);
  });

  console.log("Enabled features:", [...device.features]);
  return { adapter, device, queue: device.queue };
}
```

## Example 4: Reading adapter identification

`GPUAdapterInfo` fields are strings and may be empty for privacy. Treat empty strings as expected.

```js
async function logAdapterInfo() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No WebGPU adapter found.");
  }

  const info = adapter.info;   // GPUAdapterInfo
  console.log("vendor:", info.vendor || "(unspecified)");
  console.log("architecture:", info.architecture || "(unspecified)");
  console.log("device:", info.device || "(unspecified)");
  console.log("description:", info.description || "(unspecified)");
  return info;
}
```

## Example 5: Full initialization to first frame

Phase 1 (initialization) wired to the per-frame phases 2 through 4. Resource creation and pipeline setup are abbreviated; the focus is the architecture flow.

```js
async function initAndRender(canvas) {
  if (!navigator.gpu) {
    throw new Error("WebGPU is not available.");
  }

  // Phase 1: initialization, runs once.
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No WebGPU adapter found.");
  }
  const device = await adapter.requestDevice({ label: "app-device" });
  device.lost.then((info) => {
    console.error(`Device lost: ${info.reason} : ${info.message}`);
  });

  const context = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format });

  // ... create pipelines, buffers, bind groups here, once ...

  function frame() {
    // Phase 2: recording, a fresh encoder every frame.
    const encoder = device.createCommandEncoder({ label: "frame-encoder" });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    // ... pass.setPipeline(...), pass.draw(...) ...
    pass.end();

    // Phase 3: submission.
    device.queue.submit([encoder.finish()]);

    // Phase 4: validation and execution happen asynchronously on the GPU timeline.
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
```

## Example 6: Detecting an already-lost device after requestDevice

`requestDevice` resolves even on runtime failure, to a device that is already lost. Race the `lost` promise to detect this immediately.

```js
async function initAndVerifyDevice(adapter) {
  const device = await adapter.requestDevice({ label: "verified-device" });

  const lost = device.lost.then((info) => ({ lost: true, info }));
  const alive = Promise.resolve({ lost: false });
  const status = await Promise.race([lost, alive]);

  if (status.lost) {
    throw new Error(`Device was lost on creation: ${status.info.message}`);
  }
  // Register the long-lived handler now that the device is confirmed alive.
  device.lost.then((info) => {
    console.error(`Device lost: ${info.reason} : ${info.message}`);
  });
  return device;
}
```

## Example 7: Initialization inside a Web Worker

Inside a worker the entry point is `self.navigator.gpu` via `WorkerNavigator`. The chain is identical. Service workers do not support WebGPU.

```js
// worker.js
async function initInWorker() {
  if (!self.navigator.gpu) {
    throw new Error("WebGPU is not available in this worker.");
  }
  const adapter = await self.navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No WebGPU adapter found.");
  }
  const device = await adapter.requestDevice({ label: "worker-device" });
  device.lost.then((info) => {
    console.error(`Worker device lost: ${info.reason} : ${info.message}`);
  });
  return { adapter, device, queue: device.queue };
}
```
