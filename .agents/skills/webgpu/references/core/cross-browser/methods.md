# Cross-Browser Feature-Detection API Surface

WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+. All signatures
verified against the W3C WebGPU specification, MDN, and caniuse (2026-05-20).

## navigator.gpu

`navigator.gpu` is the `GPU` interface and the entry point. Inside a Web Worker
the equivalent is `self.navigator.gpu` on `WorkerNavigator`. WebGPU requires a
secure context (HTTPS or `localhost`): on an insecure origin `navigator.gpu` is
`undefined`. ALWAYS guard the entry point first:

```js
if (!("gpu" in navigator)) {
  // WebGPU unavailable in this browser or this insecure context.
}
```

### navigator.gpu.getPreferredCanvasFormat()

```
getPreferredCanvasFormat() -> GPUTextureFormat
```

Returns the canvas texture format the platform composites most efficiently.
The returned value is `"bgra8unorm"` or `"rgba8unorm"`. The value is
platform-dependent and can differ between Chrome and Safari on the same site.
It takes no arguments and is synchronous. The result is the `format` to pass to
`GPUCanvasContext.configure({ device, format })`.

### navigator.gpu.wgslLanguageFeatures

```
wgslLanguageFeatures : WGSLLanguageFeatures   (set-like, read-only)
```

A set-like object listing optional WGSL language features the browser's shader
compiler supports. It exposes `has(name)`, `size`, and is iterable. It reflects
the browser, NOT a specific adapter or device. Use it before emitting a shader
that relies on an optional WGSL feature; an `enable` or `requires` directive for
an unsupported feature is a shader-creation error.

```js
navigator.gpu.wgslLanguageFeatures.has("readonly_and_readwrite_storage_textures");
for (const feature of navigator.gpu.wgslLanguageFeatures) { /* iterate */ }
```

The set of language features is implementation-defined and grows over time.
NEVER assume a specific feature name is present. ALWAYS call `has()`.

### navigator.gpu.requestAdapter(options?)

```
requestAdapter(options?: GPURequestAdapterOptions) -> Promise<GPUAdapter | null>
```

`GPURequestAdapterOptions` fields relevant to cross-browser targeting:

| Field | Type | Notes |
|-------|------|-------|
| `powerPreference` | `"low-power"` \| `"high-performance"` | Optional. Omit to let the UA choose. |
| `forceFallbackAdapter` | `boolean` | Optional. Requests a software adapter. |
| `featureLevel` | `"core"` \| `"compatibility"` | Optional. Default `"core"`. |

`requestAdapter` resolves to `null` when no compatible GPU exists. `null` is a
valid resolution, not a rejection. ALWAYS null-check the adapter before reading
`.features` or `.limits`.

`featureLevel: "compatibility"` selects an adapter mapped to OpenGL ES 3.1 /
D3D11-class hardware with reduced limits and a smaller feature set. The default
`"core"` tier exposes the full WebGPU feature set. Use `"compatibility"` only
when deliberately targeting that older-hardware tier.

## GPUAdapter

### adapter.features

```
adapter.features : GPUSupportedFeatures   (set-like, read-only)
```

A set-like object of `GPUFeatureName` strings the adapter can grant. Methods:
`has(name)`, `entries()`, `keys()`, `values()`, `forEach()`, plus `size`. It is
iterable. `adapter.features.has(name)` is the gate for whether `name` may appear
in `requiredFeatures`.

### adapter.limits

```
adapter.limits : GPUSupportedLimits   (read-only)
```

Reports the best limits this adapter can be negotiated to. Default limit values
differ by browser and adapter, so ALWAYS read `adapter.limits.<name>` before
requesting a higher value through `requiredLimits`.

### adapter.info

```
adapter.info : GPUAdapterInfo   (read-only)
```

Carries `vendor`, `architecture`, `device`, and `description` strings. The
values are intentionally coarse for privacy and differ across browsers. NEVER
branch feature logic on `adapter.info`; branch on `adapter.features` and
`adapter.limits` instead.

### adapter.requestDevice(descriptor?)

```
requestDevice(descriptor?: GPUDeviceDescriptor) -> Promise<GPUDevice>
```

`GPUDeviceDescriptor` fields relevant to cross-browser targeting:

| Field | Type | Default |
|-------|------|---------|
| `label` | `string` | `""` |
| `requiredFeatures` | `GPUFeatureName[]` | `[]` |
| `requiredLimits` | `Record<string, number>` | `{}` |
| `defaultQueue` | `GPUQueueDescriptor` | `{}` |

`requestDevice` rejects when `requiredFeatures` names a feature the adapter does
not list, or when `requiredLimits` requests a value the adapter cannot grant.
There is no silent clamping. `requestDevice` never throws for runtime device
failure: on runtime failure it resolves to a `GPUDevice` that is already lost.

## GPUDevice

### device.features

```
device.features : GPUSupportedFeatures   (set-like, read-only)
```

The features the negotiated device actually enabled, equal to the subset of
`requiredFeatures` the adapter supported. ALWAYS branch runtime code on
`device.features.has(name)`. A feature is usable only when it was both supported
by the adapter and named in `requiredFeatures`.

### device.limits

```
device.limits : GPUSupportedLimits   (read-only)
```

The negotiated limits. The device validates every API call against
`device.limits`, not against `adapter.limits`. ALWAYS size buffers, textures,
workgroups, and bind groups against `device.limits`.

## GPUFeatureName enum

The complete `GPUFeatureName` enum, with the Chrome version that first shipped
it. Safari and Firefox lag these dates and may never expose some entries; ALWAYS
detect with `adapter.features.has`:

| Feature | First Chrome version |
|---------|----------------------|
| `depth-clip-control` | 113 (baseline) |
| `depth32float-stencil8` | 113 (baseline) |
| `texture-compression-bc` | 113 (baseline) |
| `texture-compression-etc2` | 113 (baseline) |
| `texture-compression-astc` | 113 (baseline) |
| `timestamp-query` | 113 (baseline) |
| `indirect-first-instance` | 113 (baseline) |
| `rg11b10ufloat-renderable` | 113 (baseline) |
| `bgra8unorm-storage` | 113 (baseline) |
| `float32-filterable` | 113 (baseline) |
| `shader-f16` | 120 |
| `clip-distances` | 131 |
| `dual-source-blending` | 130 |
| `float32-blendable` | shipped after baseline |
| `subgroups` | 134 |

"Baseline" means the feature is part of the WebGPU 1.0-stable optional set that
Chrome shipped at 113. Baseline status does NOT mean Safari or Firefox expose it;
texture-compression sets and `timestamp-query` are known to lag in Firefox.

## GPUSupportedFeatures and GPUSupportedLimits

Both `adapter.features`/`device.features` (`GPUSupportedFeatures`) are set-like:
`has(name)`, iteration, `size`. `GPUSupportedLimits` is a plain read-only object
of named numeric properties. Treat any limit value as adapter-specific: query it,
never hard-code it.

## Sources

- https://www.w3.org/TR/webgpu/ : `GPU`, `GPUAdapter`, `GPUDevice`,
  `GPUSupportedFeatures`, `GPUSupportedLimits`, `getPreferredCanvasFormat`,
  `wgslLanguageFeatures`, `GPUFeatureName`, `featureLevel`.
- https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API : adapter and
  device feature-detection overview, optional features list.
- https://caniuse.com/webgpu : Chrome 113+, Safari 26.0+, Firefox disabled by
  default through 153 on most platforms.
- https://developer.chrome.com/blog/ (WebGPU posts) : Chrome feature timeline.
