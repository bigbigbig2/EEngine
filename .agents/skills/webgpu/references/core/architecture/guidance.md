# WebGPU Core Architecture

Initialize WebGPU correctly through the navigator.gpu entry point and the adapter, device, queue model, and reason about the 4-phase application runtime. Baseline: WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## Quick Reference

| Type / Member | Kind | Purpose |
|---------------|------|---------|
| `navigator.gpu` | `GPU` | Entry point. `undefined` on insecure origins. |
| `navigator.gpu.requestAdapter(options?)` | method | Returns `Promise<GPUAdapter \| null>`. Null is a valid resolution. |
| `navigator.gpu.getPreferredCanvasFormat()` | method | Returns `"bgra8unorm"` or `"rgba8unorm"`. |
| `GPUAdapter` | interface | Physical implementation. Has `features`, `limits`, `info`. |
| `GPUAdapter.info` | `GPUAdapterInfo` | `vendor`, `architecture`, `device`, `description`. |
| `GPUAdapter.requestDevice(descriptor?)` | method | Returns `Promise<GPUDevice>`. Resolves even on failure. |
| `GPUDevice` | interface | Logical connection. Root owner of all child objects. |
| `GPUDevice.queue` | property | Read-only `GPUQueue`. NEVER call it. |
| `GPUDevice.lost` | property | Read-only `Promise<GPUDeviceLostInfo>`. |
| `GPUDevice.destroy()` | method | Releases the device and all child objects. |
| `GPUQueue.submit(buffers)` | method | Schedules command buffers for execution. |

WebGPU is a layered API. The entry point exposes the `GPU` interface. WebGPU ALWAYS requires a secure context (HTTPS or `localhost`). On insecure origins `navigator.gpu` is `undefined`.

The three-step async chain:

```js
const adapter = await navigator.gpu.requestAdapter(options?);  // Promise<GPUAdapter | null>
const device  = await adapter.requestDevice(descriptor?);       // Promise<GPUDevice>
const queue   = device.queue;                                   // GPUQueue property
```

## Decision Tree

```
Is navigator.gpu defined?
├─ NO  → page is not on a secure context, OR the browser lacks WebGPU.
│        ALWAYS show a fallback message. STOP. Do not call requestAdapter.
└─ YES → call navigator.gpu.requestAdapter(options)

Which powerPreference?
├─ Real-time 3D, games, heavy compute → "high-performance"
├─ UI effects, battery-sensitive, mobile → "low-power"
└─ Unsure → omit powerPreference entirely (the UA chooses)

Need to test the software/portability path?
├─ YES → set forceFallbackAdapter: true to request a fallback adapter
└─ NO  → omit forceFallbackAdapter

Did requestAdapter resolve to null?
├─ YES → no compatible GPU. ALWAYS show a fallback message. STOP.
└─ NO  → call adapter.requestDevice(descriptor)

After requestDevice resolves:
├─ ALWAYS register device.lost.then(...) BEFORE creating resources
└─ Access the queue as device.queue (property), then create resources
```

## Core Patterns

### Pattern 1: ALWAYS guard navigator.gpu before any WebGPU call

`navigator.gpu` is `undefined` on insecure origins and in browsers without WebGPU. Accessing `.requestAdapter` on `undefined` throws a `TypeError`.

```js
if (!navigator.gpu) {
  throw new Error("WebGPU is not available. Use HTTPS or localhost, and a supporting browser.");
}
```

### Pattern 2: ALWAYS null-check the adapter

`requestAdapter()` returns `Promise<GPUAdapter | null>`. `null` is a valid resolution, NOT a rejection. It means no compatible GPU was found.

```js
const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
if (!adapter) {
  throw new Error("No WebGPU adapter found.");
}
```

### Pattern 3: ALWAYS register device.lost before creating resources

`requestDevice()` never throws for runtime failures. It can resolve to a `GPUDevice` that has *already been lost*. Register the `lost` handler first so loss is observed even if it happens during initialization.

```js
const device = await adapter.requestDevice();
device.lost.then((info) => {
  console.error(`Device lost: ${info.reason} : ${info.message}`);
  // See webgpu-errors-device-loss for the full recovery pattern.
});
```

### Pattern 4: ALWAYS access device.queue as a property, NEVER as a call

`device.queue` is a read-only `GPUQueue` property. Calling `device.queue()` throws `TypeError: device.queue is not a function`.

```js
const queue = device.queue;            // correct
queue.submit([commandBuffer]);          // correct
// const queue = device.queue();        // WRONG, throws TypeError
```

### Pattern 5: Request only the features and limits you need

`requestDevice()` accepts a `GPUDeviceDescriptor` with `requiredFeatures` and `requiredLimits`. ALWAYS feature-detect against `adapter.features` first. Requesting an absent feature makes `requestDevice()` fail.

```js
const device = await adapter.requestDevice({
  label: "main-device",
  requiredFeatures: adapter.features.has("shader-f16") ? ["shader-f16"] : [],
});
```

### Pattern 6: The device is the root owner

The adapter is the *physical* implementation. The device is a *logical* connection that abstracts the implementation so the owner acts as if it is the sole user of the adapter. Every buffer, texture, pipeline, and bind group is created from the device and is owned by it. When the device is lost, all child objects are freed together. ALWAYS recreate every resource against a new device after recovery.

## Common Anti-Patterns

1. **Not null-checking the adapter.** `requestAdapter()` can resolve to `null`. Code that does `await navigator.gpu.requestAdapter()` then `adapter.requestDevice()` throws `TypeError: Cannot read properties of null` on machines with no compatible GPU.

2. **Calling `device.queue()` as a method.** `device.queue` is a read-only property. `device.queue()` throws `TypeError: device.queue is not a function`.

3. **Assuming `requestDevice()` rejects on failure.** It does not. It resolves to a `GPUDevice` that may already be lost. Code that omits a `device.lost` handler silently produces a dead device.

See `anti-patterns.md` for the full list with WHY-it-fails explanations, including reusing a stale adapter after device loss.

## Critical Warnings

- NEVER call `navigator.gpu.requestAdapter` without first checking `navigator.gpu` is defined. It is `undefined` on insecure origins.
- NEVER assume `requestAdapter()` rejects when no GPU is present. It resolves to `null`. ALWAYS null-check.
- NEVER call `device.queue` as a function. It is a read-only `GPUQueue` property.
- NEVER assume `requestDevice()` rejects on runtime failure. It can resolve to an already-lost device. ALWAYS register `device.lost`.
- NEVER reuse a stale `GPUAdapter` after a device loss. The adapter itself can become invalid. ALWAYS re-request the adapter. See `webgpu-errors-device-loss`.
- NEVER request a feature or limit without checking `adapter.features` and `adapter.limits` first. See `webgpu-core-limits-features`.
- NEVER hardcode the canvas format. Use `navigator.gpu.getPreferredCanvasFormat()`. See `webgpu-core-cross-browser`.

## Reference Files

- `methods.md` : complete API signatures for `GPU`, `GPUAdapter`, `GPUDevice`, `GPUQueue`, `GPUAdapterInfo`, `requestAdapter`, and `requestDevice`.
- `examples.md` : verified WebGPU initialization code, from minimal setup to feature negotiation and worker contexts.
- `anti-patterns.md` : initialization mistakes with WHY-it-fails explanations.

Related skills:
- `webgpu-core-limits-features` : negotiating `requiredFeatures` and `requiredLimits`.
- `webgpu-core-cross-browser` : browser differences, secure context, preferred canvas format.
- `webgpu-errors-device-loss` : the full device-loss recovery pattern.
