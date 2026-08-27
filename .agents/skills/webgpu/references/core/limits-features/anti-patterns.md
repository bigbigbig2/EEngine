# WebGPU Limits and Features: Anti-Patterns

Each anti-pattern lists the broken code, WHY it fails, and the fix. Verified
against the WebGPU 1.0-stable specification and the vooronderzoek research base.

## Anti-Pattern 1: Optional feature in requiredFeatures without detection

```js
// BROKEN
const device = await adapter.requestDevice({
  requiredFeatures: ["timestamp-query"],
});
```

WHY IT FAILS: `requestDevice` validates every name in `requiredFeatures` against
`adapter.features`. When the adapter does not list `timestamp-query`, the Promise
rejects. The app then has no device at all. This passes in Chrome on a desktop
GPU and breaks in Safari, on Firefox, and on integrated GPUs that omit the
feature, so the bug ships unnoticed.

FIX: Gate every optional feature on `adapter.features.has`.

```js
const device = await adapter.requestDevice({
  requiredFeatures: adapter.features.has("timestamp-query")
    ? ["timestamp-query"]
    : [],
});
// Then branch the code: only use timestamp queries when
// device.features.has("timestamp-query") is true.
```

## Anti-Pattern 2: Assuming a feature exists because Chrome has it

```js
// BROKEN: shader-f16 shipped in Chrome 120, so the developer hard-codes it.
const device = await adapter.requestDevice({
  requiredFeatures: ["shader-f16"],
});
```

WHY IT FAILS: Chrome leads WebGPU feature rollout. `shader-f16` arrived in
Chrome 120, `dual-source-blending` in Chrome 130, `subgroups` in Chrome 134.
Safari 26.0 to 26.5 and Firefox expose smaller, different optional-feature sets,
and older or integrated adapters omit features even in Chrome. Hard-coding any
feature ties the app to one browser-and-hardware combination.

FIX: Detect per adapter. Optional features are per-adapter, never per-browser.

```js
const hasF16 = adapter.features.has("shader-f16");
const device = await adapter.requestDevice({
  requiredFeatures: hasF16 ? ["shader-f16"] : [],
});
```

## Anti-Pattern 3: Requesting an unnecessarily high limit

```js
// BROKEN: requesting the largest value the developer can imagine.
const device = await adapter.requestDevice({
  requiredLimits: { maxBufferSize: 4 * 1024 * 1024 * 1024 }, // 4 GiB
});
```

WHY IT FAILS: `maxBufferSize` is a `maximum`-class limit. When the requested
value exceeds `adapter.limits.maxBufferSize`, `requestDevice` rejects. There is
NO silent clamp to the adapter maximum. A 4 GiB request rejects on most adapters,
so the app fails to start even though the real workload may only need 200 MiB.
Over-requesting also locks out adapters that could have run the actual workload.

FIX: Read `adapter.limits` first; request only what the code needs.

```js
const needed = computeRealBufferBudget(); // e.g. 200 MiB
if (adapter.limits.maxBufferSize < needed) {
  throw new Error("Adapter cannot meet the buffer budget");
}
const device = await adapter.requestDevice({
  requiredLimits: { maxBufferSize: needed },
});
```

## Anti-Pattern 4: Assuming limits are uniform across browsers

```js
// BROKEN: hard-coding the spec default as if every adapter reports it.
const MAX_STORAGE_BINDING = 134217728; // assumed everywhere
const buffer = device.createBuffer({
  size: MAX_STORAGE_BINDING,
  usage: GPUBufferUsage.STORAGE,
});
```

WHY IT FAILS: The spec default is the FLOOR, the worst value a conformant
adapter may report, not the value every adapter reports. Real adapters report
higher `maximum`-class limits and finer `alignment`-class limits, and the
compatibility tier reports lower limits. Some Chrome builds report
`maxStorageBuffersPerShaderStage` 10 instead of the default 8. Code built on the
hard-coded default either wastes capability the adapter offers or, after a
`requiredLimits` request, exceeds the negotiated set and fails validation.

FIX: Query `adapter.limits` (before `requestDevice`) and `device.limits` (after),
and size resources against the negotiated `device.limits`.

```js
const cap = device.limits.maxStorageBufferBindingSize; // negotiated value
const buffer = device.createBuffer({
  label: "storage",
  size: Math.min(myDataSize, cap),
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});
```

## Anti-Pattern 5: Sizing resources against adapter.limits after device creation

```js
// BROKEN: the device negotiated the default, but code reads the adapter.
const device = await adapter.requestDevice(); // no requiredLimits
const big = adapter.limits.maxComputeWorkgroupsPerDimension; // adapter value
pass.dispatchWorkgroups(big);
```

WHY IT FAILS: The device validates every call against the NEGOTIATED limits in
`device.limits`, not against `adapter.limits`. With no `requiredLimits`, the
device negotiated the spec default. When `adapter.limits` reports a higher value
than the default, `dispatchWorkgroups(adapter.limits.maxComputeWorkgroupsPerDimension)`
can exceed `device.limits.maxComputeWorkgroupsPerDimension` and fails validation.

FIX: ALWAYS read `device.limits` after `requestDevice`. To use a higher value,
request it explicitly in `requiredLimits`.

```js
const maxDim = device.limits.maxComputeWorkgroupsPerDimension; // negotiated
pass.dispatchWorkgroups(Math.min(wantCount, maxDim));
```

## Anti-Pattern 6: Inventing or misspelling a feature name

```js
// BROKEN: not a real GPUFeatureName.
const device = await adapter.requestDevice({
  requiredFeatures: ["timestamp-queries", "f16-shaders"],
});
```

WHY IT FAILS: `requiredFeatures` accepts only valid `GPUFeatureName` enum
values. An unrecognised string (a plural, a typo, a made-up name) makes
`requestDevice` reject. The correct names are `timestamp-query` (singular) and
`shader-f16`, not `timestamp-queries` or `f16-shaders`.

FIX: Use exact enum values from the `GPUFeatureName` table in `methods.md`.

```js
const wishlist = ["timestamp-query", "shader-f16"]; // exact enum values
const device = await adapter.requestDevice({
  requiredFeatures: wishlist.filter((f) => adapter.features.has(f)),
});
```

## Anti-Pattern 7: shader-f16 feature without the enable directive

```js
// BROKEN: device has the feature, but the WGSL omits the directive.
const device = await adapter.requestDevice({
  requiredFeatures: ["shader-f16"],
});
const module = device.createShaderModule({
  code: `@compute @workgroup_size(64) fn main() { var x: f16 = 1.0h; }`,
});
```

WHY IT FAILS: `shader-f16` has two requirements that must both hold. The device
must be created with the `shader-f16` feature, AND the WGSL source must begin
with `enable f16;`. Using the `f16` type or the `h` literal suffix without the
directive is a shader-creation error, even on a device that has the feature.

FIX: Emit `enable f16;` as the first line of the WGSL source when the feature
was negotiated.

```js
const module = device.createShaderModule({
  code: `enable f16;
@compute @workgroup_size(64) fn main() { var x: f16 = 1.0h; }`,
});
```

## Anti-Pattern 8: Reading features on a null adapter

```js
// BROKEN: no null-check before touching .features.
const adapter = await navigator.gpu.requestAdapter();
const hasF16 = adapter.features.has("shader-f16"); // TypeError when null
```

WHY IT FAILS: `requestAdapter` resolves to `null` (not a rejection) when no
compatible GPU exists. Reading `.features` or `.limits` on `null` throws a
`TypeError`, crashing initialization with an error unrelated to the real cause.

FIX: Branch on `adapter !== null` before any property access.

```js
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) {
  showFallbackUI();
  return;
}
const hasF16 = adapter.features.has("shader-f16");
```
