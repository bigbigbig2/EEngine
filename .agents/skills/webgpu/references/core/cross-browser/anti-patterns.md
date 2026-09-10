# Cross-Browser WebGPU Anti-Patterns

Snapshot: 2026-09-10. Each entry states the mistake, why it fails across
implementations, and the fix.

## 1. Optional feature in requiredFeatures without checking adapter.features

```js
// WRONG
const device = await adapter.requestDevice({
  requiredFeatures: ["timestamp-query", "shader-f16"],
});
```

WHY it fails: `requestDevice` rejects when `requiredFeatures` names a feature the
adapter does not list. The set varies by browser, backend, driver, and adapter,
so the same descriptor can succeed on one machine and reject on another.

```js
// CORRECT
const wanted = ["timestamp-query", "shader-f16"];
const requiredFeatures = wanted.filter((f) => adapter.features.has(f));
const device = await adapter.requestDevice({ requiredFeatures });
```

## 2. Hard-coding the canvas format

```js
// WRONG
context.configure({ device, format: "bgra8unorm" });
```

WHY it fails: the preferred canvas format is platform-dependent.
`getPreferredCanvasFormat()` returns `"bgra8unorm"` on some platforms and
`"rgba8unorm"` on others, and Safari can differ from Chrome on the same device.
A hard-coded format costs a composition-time conversion at best, and at worst
mismatches the swap chain so the canvas renders wrong colors or fails to
configure.

```js
// CORRECT
const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format });
// The render pipeline fragment target must use the same `format`.
```

## 3. Assuming a feature exists because Chrome supports it

```js
// WRONG
// Built and tested on one implementation that exposes subgroups.
const code = `enable subgroups; ...`;
const module = device.createShaderModule({ code });
```

WHY it fails: optional features vary across implementations and adapters. Code
built on one feature set can emit an `enable` directive that another device
cannot compile, producing a shader-creation error.

```js
// CORRECT
const hasSubgroups = device.features.has("subgroups");
const code = hasSubgroups ? subgroupShader : fallbackShader;
const module = device.createShaderModule({ code });
```

## 4. Depending on implementation timing or work batching

```js
// WRONG
device.queue.submit([encoder.finish()]);
const data = staging.getMappedRange(); // assumes the copy already finished
```

WHY it fails: WebGPU runs on the GPU timeline. Chrome, Safari, and Firefox batch
and flush submitted work at different points, and a buffer is not mappable until
its GPU work completes. Reading without explicit synchronization gives stale data
on a browser that batches more aggressively, or throws because the buffer is not
in the `mapped` state. The code happens to work in the browser it was tested in
and breaks elsewhere.

```js
// CORRECT
device.queue.submit([encoder.finish()]);
await device.queue.onSubmittedWorkDone();
await staging.mapAsync(GPUMapMode.READ);
const data = staging.getMappedRange();
```

## 5. Confusing enable extensions with WGSL language features

```js
// WRONG
const code = `enable f16; ...`;
```

WHY it fails: `f16` is a device-feature-backed enable extension, not a member
that must be queried through `wgslLanguageFeatures`. The two namespaces have
different names and gating rules.

```js
// CORRECT
const useF16 = device.features.has("shader-f16");
const code = useF16 ? `enable f16; ...` : `/* f32 variant */`;
```

`shader-f16` needs BOTH the host-side device feature AND the WGSL-side `enable
f16;` directive. Detect the host feature and emit the directive together.

## 6. Sizing resources against adapter.limits

```js
// WRONG
const size = adapter.limits.maxStorageBufferBindingSize;
const buffer = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE });
```

WHY it fails: the device validates every call against `device.limits`, the
negotiated set, not `adapter.limits`. Default limits also differ by browser and
adapter, so a value valid on a Chrome adapter can exceed what a Safari or Firefox
device negotiated. Sizing against `adapter.limits` causes a validation error on
the device.

```js
// CORRECT
const size = device.limits.maxStorageBufferBindingSize;
const buffer = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE });
```

## 7. Skipping the null check on requestAdapter

```js
// WRONG
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice(); // throws if adapter is null
```

WHY it fails: `requestAdapter` resolves to `null` when no compatible GPU exists.
`null` is a valid resolution, not a rejection. Calling `requestDevice` or reading
`.features` on `null` throws a `TypeError`. This happens on machines without a
suitable GPU and on browsers where WebGPU is present but no adapter is available.

```js
// CORRECT
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) {
  // Show a fallback UI. Do not touch adapter.
  return;
}
const device = await adapter.requestDevice();
```

## 8. Treating a browser version as a capability test

WHY it fails: shipping status can differ by operating system, backend, driver,
feature level, adapter, flag, and enterprise policy within the same browser
version. A user-agent check cannot prove that a device feature, limit, WGSL
language feature, or newly merged method is usable.

Fix: guard `navigator.gpu`, null-check the adapter, negotiate device features and
limits, query WGSL language features, and validate newly merged core paths.
