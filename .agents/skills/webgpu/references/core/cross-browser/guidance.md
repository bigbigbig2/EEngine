# WebGPU Cross-Browser Compatibility

Write WebGPU code that runs on Chrome, Safari, and Firefox by feature-detecting
every optional capability instead of assuming the Chrome feature set everywhere.

## Quick Reference

WebGPU 1.0-stable baseline: Chrome 113+, Safari 26+, Firefox 141+.

Browser support matrix (verified against caniuse and the Chrome WebGPU blog,
2026-05):

| Browser | WebGPU support | Engine | Notes |
|---------|----------------|--------|-------|
| Chrome / Edge desktop | 113+ | Dawn | Leads feature rollout. Full core support. |
| Chrome for Android | 121+ | Dawn | Broadly available on 148+. |
| Safari / WebKit desktop | 26.0+ | WebKit | Shipped mid-2025. 26.0-26.5 reported as partial: optional features and formats lag Chrome. |
| Safari iOS | 26.0+ | WebKit | Full support on iOS 26.0+. |
| Firefox desktop | 141+ | wgpu | Shipped enabled on 141 on Windows first. caniuse reports it disabled by default through 153 on other desktop platforms. |
| Firefox for Android | not enabled | wgpu | Disabled by default through 150. |

The masterplan label "Safari 18" was wrong: WebKit shipped WebGPU in the Safari
26 / iOS 26 family. NEVER cite "Safari 18" as the WebGPU baseline.

Dawn (Chrome) optional-feature timeline. Safari and Firefox lag these dates and
may never expose some entries:

| Capability | Chrome version |
|------------|----------------|
| shader-f16 | 120 |
| multi-draw-indirect (experimental) | 131 |
| clip distances | 131 |
| subgroups | 134 |
| subgroup_id / num_subgroups | 144 |
| subgroup_uniformity | 145 |

Three feature-detection surfaces (full signatures in `methods.md`):

| Check | What it gates |
|-------|---------------|
| `adapter.features.has(name)` | Whether a `GPUFeatureName` may go in `requiredFeatures`. |
| `device.features.has(name)` | What the negotiated device actually enabled. |
| `navigator.gpu.wgslLanguageFeatures.has(name)` | Optional WGSL language features. |
| `navigator.gpu.getPreferredCanvasFormat()` | The portable canvas texture format. |

## Decision Tree

```
Code uses a capability beyond the WebGPU 1.0 core set?
├── It is a host-side optional FEATURE (shader-f16, timestamp-query,
│   texture-compression-bc, subgroups, ...)?
│   ├── adapter.features.has("<name>") === true?
│   │   └── Add "<name>" to requiredFeatures. After requestDevice,
│   │       confirm device.features.has("<name>").
│   └── adapter.features.has("<name>") === false?
│       └── OMIT it. Run a degraded code path that does not need it.
│
├── It is an optional WGSL language feature?
│   ├── navigator.gpu.wgslLanguageFeatures.has("<name>") === true?
│   │   └── Emit shader code that uses it.
│   └── false?
│       └── Emit the baseline-WGSL shader variant instead.
│
├── It is the canvas texture format?
│   └── ALWAYS navigator.gpu.getPreferredCanvasFormat(). NEVER hard-code.
│
├── It needs a non-default LIMIT?
│   └── Read adapter.limits.<name>. Request via requiredLimits only if the
│       adapter reports a good-enough value; otherwise reduce the workload.
│
└── It is a featureLevel tier?
    └── Default "core". Use "compatibility" only to deliberately target
        OpenGL ES 3.1 / D3D11-class hardware (reduced limits and features).
```

## Core Patterns

### Pattern 1: ALWAYS feature-detect on the adapter before requiredFeatures

`requestDevice` rejects when `requiredFeatures` names a feature the adapter does
not list. Chrome exposes a feature; Safari or Firefox may not. ALWAYS filter the
wanted features against `adapter.features.has` so the same code degrades instead
of breaking.

```js
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error("No WebGPU adapter");

const wanted = ["timestamp-query", "shader-f16", "texture-compression-bc"];
const requiredFeatures = wanted.filter((f) => adapter.features.has(f));
const device = await adapter.requestDevice({ requiredFeatures });
```

### Pattern 2: ALWAYS confirm enabled features on device.features

`adapter.features` is what the adapter could grant. `device.features` is what
the negotiated device actually has. ALWAYS branch runtime code paths on
`device.features.has(name)`, NEVER on `adapter.features`, because a feature is
usable only when it was both supported and requested.

```js
const useF16 = device.features.has("shader-f16");
const shaderCode = useF16 ? shaderF16Variant : shaderF32Variant;
```

### Pattern 3: ALWAYS detect optional WGSL features before emitting them

Optional WGSL language features are reported by
`navigator.gpu.wgslLanguageFeatures`, a set-like object. An `enable` or
`requires` directive for a feature the browser lacks is a shader-creation error.
ALWAYS gate the shader variant on `wgslLanguageFeatures.has(name)`.

```js
const wgsl = navigator.gpu.wgslLanguageFeatures;
const hasReadonlyWriteable =
  wgsl.has("readonly_and_readwrite_storage_textures");
// Emit the shader variant that matches what this browser supports.
```

### Pattern 4: ALWAYS use getPreferredCanvasFormat for the canvas

`navigator.gpu.getPreferredCanvasFormat()` returns `"bgra8unorm"` or
`"rgba8unorm"` depending on the platform. Safari can differ from Chrome. ALWAYS
configure the canvas with this value. NEVER hard-code a format string.

```js
const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format, alphaMode: "premultiplied" });
```

### Pattern 5: ALWAYS query adapter.limits, request only what you need

Default limits differ by browser and adapter. `requiredLimits` starts from the
spec defaults. ALWAYS read `adapter.limits.<name>` before requesting a higher
value, and request only the limits the code actually needs so the app stays
portable to weaker adapters.

```js
const needed = 256 * 1024 * 1024;
const requiredLimits =
  adapter.limits.maxStorageBufferBindingSize >= needed
    ? { maxStorageBufferBindingSize: needed }
    : {};
const device = await adapter.requestDevice({ requiredLimits });
```

### Pattern 6: NEVER depend on timeline or batching timing side effects

Browsers batch and schedule GPU work differently. Chrome, Safari, and Firefox
flush the queue at different points. ALWAYS synchronize explicitly with
`queue.onSubmittedWorkDone()` or `buffer.mapAsync()`. NEVER assume work has
completed because a later call appeared to see its result in one browser.

```js
queue.submit([commandBuffer]);
await queue.onSubmittedWorkDone(); // explicit, portable synchronization
await stagingBuffer.mapAsync(GPUMapMode.READ);
```

## Common Anti-Patterns

1. Putting an optional feature in `requiredFeatures` without checking
   `adapter.features`. WHY it fails: `requestDevice` rejects on every browser
   lacking the feature, so the app runs in Chrome and breaks in Safari and
   Firefox.

2. Hard-coding `"bgra8unorm"` (or `"rgba8unorm"`) as the canvas format. WHY it
   fails: the preferred format is platform-dependent. A hard-coded format costs a
   conversion on some devices and can mismatch the swap chain on Safari.

3. Assuming a capability exists because Chrome supports it. WHY it fails: Dawn
   ships features first (`shader-f16` Chrome 120, `subgroups` Chrome 134). Safari
   26.0-26.5 is partial and Firefox lags on compression sets, timestamp queries,
   and new WGSL extensions. Code built on Chrome-only assumptions throws or
   produces wrong output on the other engines.

## Critical Warnings

- NEVER add a `GPUFeatureName` to `requiredFeatures` without
  `adapter.features.has(name)` returning `true` first.
- NEVER hard-code the canvas format. ALWAYS call
  `navigator.gpu.getPreferredCanvasFormat()`.
- NEVER emit an `enable` or `requires` WGSL directive without checking
  `navigator.gpu.wgslLanguageFeatures.has(name)`.
- NEVER assume Safari ships every feature Chrome ships. Safari 26.0-26.5 is
  partial support; Firefox is disabled by default on most platforms.
- NEVER cite "Safari 18" as the WebGPU baseline. WebGPU shipped in Safari 26 /
  iOS 26.
- NEVER depend on how aggressively a browser batches GPU work. Synchronize with
  `onSubmittedWorkDone()` or `mapAsync()`.
- NEVER size resources against `adapter.limits`. Default limits differ per
  browser; request via `requiredLimits` and size against `device.limits`.

## Reference Files

- `methods.md` : the feature-detection API surface, including
  `adapter.features.has`, `device.features.has`,
  `navigator.gpu.wgslLanguageFeatures`, and `getPreferredCanvasFormat`.
- `examples.md` : verified feature-detection and graceful-degradation
  code for cross-browser WebGPU apps.
- `anti-patterns.md` : cross-browser mistakes with WHY-it-fails
  explanations.

## Related Skills

- `webgpu-core-limits-features` : the limit and feature negotiation algorithm.
- `webgpu-core-architecture` : the adapter / device / queue initialization chain.
- `webgpu-syntax-canvas-context` : configuring `GPUCanvasContext` and the canvas
  texture format.
