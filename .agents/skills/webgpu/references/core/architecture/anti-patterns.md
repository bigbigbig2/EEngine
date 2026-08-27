# WebGPU Core Architecture: Anti-Patterns

Initialization mistakes, each with the symptom and a WHY-it-fails explanation. Baseline: WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## Anti-pattern 1: Not null-checking the adapter

```js
// WRONG
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();
```

WHY IT FAILS: `requestAdapter()` returns `Promise<GPUAdapter | null>`. `null` is a valid resolution, not a rejection. It happens whenever no compatible GPU is available, for example on a machine with a blocklisted driver or when `forceFallbackAdapter: true` finds no fallback. On those machines `adapter` is `null` and `adapter.requestDevice()` throws `TypeError: Cannot read properties of null (reading 'requestDevice')`. The page breaks for a real subset of users while working on the developer's machine.

```js
// CORRECT
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) {
  throw new Error("No WebGPU adapter found.");
}
const device = await adapter.requestDevice();
```

## Anti-pattern 2: Calling device.queue as a method

```js
// WRONG
const queue = device.queue();
device.queue().submit([commandBuffer]);
```

WHY IT FAILS: `device.queue` is a read-only `GPUQueue` property, not a method. Calling it throws `TypeError: device.queue is not a function`. This mistake commonly comes from APIs where queue acquisition is a call, such as Vulkan's `vkGetDeviceQueue`. In WebGPU the queue already exists as a property the moment the device exists.

```js
// CORRECT
const queue = device.queue;
device.queue.submit([commandBuffer]);
```

## Anti-pattern 3: Assuming requestDevice rejects on failure

```js
// WRONG
let device;
try {
  device = await adapter.requestDevice();
} catch (e) {
  // This catch almost never runs for runtime failures.
  showError();
}
// Code proceeds with a device that may already be dead.
```

WHY IT FAILS: per the gpuweb explainer, `requestDevice()` never throws for runtime failures. It always resolves to a `GPUDevice`. When device creation fails at runtime, the returned device has *already been lost*: its `lost` promise is already resolved. A `try/catch` only catches descriptor-validation rejections, such as requesting an unsupported feature. Code that relies on the `catch` proceeds with a dead device, and every subsequent call silently produces validation errors against a non-functional device.

```js
// CORRECT
const device = await adapter.requestDevice();
device.lost.then((info) => {
  console.error(`Device lost: ${info.reason} : ${info.message}`);
  // Handle loss here. See webgpu-errors-device-loss.
});
```

ALWAYS register `device.lost` immediately after `requestDevice` resolves and before creating any resource. The handler observes both an already-lost device and a later transient loss.

## Anti-pattern 4: Reusing a stale adapter after device loss

```js
// WRONG
let adapter = await navigator.gpu.requestAdapter();
let device = await adapter.requestDevice();
device.lost.then(async () => {
  // Reusing the same adapter object.
  device = await adapter.requestDevice();
});
```

WHY IT FAILS: a device loss can be caused by the GPU being physically removed, a driver update, or a GPU-process crash. In those cases the adapter that produced the lost device is itself invalid. Additionally, an adapter is consumed by its first successful `requestDevice`. A second `requestDevice` on the same adapter resolves to an already-lost device. Recovery that reuses the old adapter therefore yields another dead device.

```js
// CORRECT
async function init() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No WebGPU adapter found.");
  }
  const device = await adapter.requestDevice();
  device.lost.then((info) => {
    if (info.reason !== "destroyed") {
      init();   // re-request a fresh adapter AND a fresh device
    }
  });
}
```

ALWAYS re-request the adapter on recovery. See `webgpu-errors-device-loss` for the complete recovery procedure, including recreating every GPU resource.

## Anti-pattern 5: Skipping the navigator.gpu guard

```js
// WRONG
const adapter = await navigator.gpu.requestAdapter();
```

WHY IT FAILS: WebGPU requires a secure context. On an HTTP origin other than `localhost`, and in any browser without WebGPU, `navigator.gpu` is `undefined`. Accessing `.requestAdapter` on `undefined` throws `TypeError: Cannot read properties of undefined (reading 'requestAdapter')` before any async work begins. The app crashes instead of showing a graceful fallback.

```js
// CORRECT
if (!navigator.gpu) {
  throw new Error("WebGPU is not available. Use HTTPS or localhost, and a supporting browser.");
}
const adapter = await navigator.gpu.requestAdapter();
```

## Anti-pattern 6: Requesting features without feature-detection

```js
// WRONG
const device = await adapter.requestDevice({
  requiredFeatures: ["shader-f16", "timestamp-query"],
});
```

WHY IT FAILS: when a name in `requiredFeatures` is not present in `adapter.features`, `requestDevice` fails. WebGPU does not silently drop the unsupported feature. Optional-feature sets differ across Chrome, Safari, and Firefox and across adapters, so a hardcoded list breaks the app on every machine that lacks one entry.

```js
// CORRECT
const wanted = ["shader-f16", "timestamp-query"];
const device = await adapter.requestDevice({
  requiredFeatures: wanted.filter((f) => adapter.features.has(f)),
});
```

See `webgpu-core-limits-features` for negotiating `requiredFeatures` and `requiredLimits`.

## Anti-pattern 7: Caching the adapter and assuming it stays current

```js
// WRONG
const cachedAdapter = await navigator.gpu.requestAdapter();
// ... much later, after a device loss or a GPU change ...
const device = await cachedAdapter.requestDevice();
```

WHY IT FAILS: an adapter reflects the GPU state at the moment it was requested. The set of available GPUs can change while the page lives, for example when a laptop switches between integrated and discrete GPUs or an external GPU is unplugged. A long-cached adapter can become stale, and it is also single-use for `requestDevice`. ALWAYS request a fresh adapter at the start of initialization and at the start of recovery.
