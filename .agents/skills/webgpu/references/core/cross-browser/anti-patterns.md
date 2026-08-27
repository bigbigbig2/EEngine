# Cross-Browser WebGPU Anti-Patterns

WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+. Each entry states the
mistake, WHY it fails across browsers, and the fix.

## 1. Optional feature in requiredFeatures without checking adapter.features

```js
// WRONG
const device = await adapter.requestDevice({
  requiredFeatures: ["timestamp-query", "shader-f16"],
});
```

WHY it fails: `requestDevice` rejects when `requiredFeatures` names a feature the
adapter does not list. Chrome may expose both features; Safari 26.0-26.5 is
partial support and Firefox lags on optional features. The promise rejects on
those browsers, so the app initializes in Chrome and throws on Safari and
Firefox.

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
// Built and tested only in Chrome, which shipped subgroups at 134.
const code = `enable subgroups; ...`;
const module = device.createShaderModule({ code });
```

WHY it fails: Dawn ships features first. `shader-f16` landed in Chrome 120,
`subgroups` in Chrome 134, `subgroup_uniformity` in Chrome 145. Safari 26.0-26.5
is partial and Firefox lags on compression sets, timestamp queries, and the
newest WGSL extensions. Code built on a Chrome-only assumption emits an `enable`
directive Safari or Firefox cannot compile, producing a shader-creation error.

```js
// CORRECT
const hasSubgroups =
  device.features.has("subgroups") &&
  navigator.gpu.wgslLanguageFeatures.has("subgroups");
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

## 5. Emitting an enable directive without checking wgslLanguageFeatures

```js
// WRONG
const code = `enable f16; ...`;
```

WHY it fails: an optional WGSL language feature must be supported by the
browser's shader compiler. An `enable` or `requires` directive for a feature the
browser lacks is a shader-creation error. `wgslLanguageFeatures` reflects the
browser, and the set differs across Chrome, Safari, and Firefox.

```js
// CORRECT
const useF16 =
  device.features.has("shader-f16") &&
  navigator.gpu.wgslLanguageFeatures.has("f16");
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

## 8. Citing "Safari 18" as the WebGPU baseline

WHY it is wrong: WebGPU did not ship in the Safari 18 family. WebKit shipped
WebGPU in the Safari 26 / iOS 26 family in mid-2025. Versions 26.0-26.5 are
reported as partial support. Documentation, version gates, or capability checks
written against "Safari 18" target a version that never had WebGPU, so the gate
either rejects all real Safari users or admits a version with no WebGPU.

Fix: the WebGPU baseline is Chrome 113+, Safari 26+, Firefox 141+.

## 9. Treating Firefox WebGPU as universally enabled

WHY it fails: Firefox shipped WebGPU enabled on Firefox 141 on Windows first.
caniuse reports it still disabled by default through 153 on other desktop
platforms and on Firefox for Android (150). Code that assumes any Firefox 141+
has WebGPU breaks on macOS, Linux, and Android Firefox where `navigator.gpu`
may be absent.

Fix: guard with `"gpu" in navigator` and null-check the adapter on every
browser. Never assume WebGPU presence from the Firefox version number alone.
