# WebGPU Canvas Context

A `GPUCanvasContext` is the bridge between a `<canvas>` element and the GPU. It produces
the per-frame `GPUTexture` that a render pass draws into and that the browser then
composites to the screen. This skill covers context creation, configuration, per-frame
texture acquisition, and resize handling for WebGPU 1.0-stable (Chrome 113+, Safari 26+,
Firefox 141+).

## Quick Reference

`GPUCanvasConfiguration` fields passed to `context.configure()`:

| Field | Required | Type | Default | Valid values |
|-------|----------|------|---------|--------------|
| `device` | Yes | `GPUDevice` | none | the `GPUDevice` to render with |
| `format` | Yes | `GPUTextureFormat` | none | `"bgra8unorm"`, `"rgba8unorm"`, `"rgba16float"` |
| `usage` | No | `GPUTextureUsage` bitmask | `RENDER_ATTACHMENT` | `RENDER_ATTACHMENT`, `COPY_SRC`, `COPY_DST`, `TEXTURE_BINDING`, `STORAGE_BINDING` |
| `alphaMode` | No | string | `"opaque"` | `"opaque"`, `"premultiplied"` |
| `colorSpace` | No | string | `"srgb"` | `"srgb"`, `"display-p3"` |
| `toneMapping` | No | object | `{ mode: "standard" }` | `{ mode: "standard" }`, `{ mode: "extended" }` |
| `viewFormats` | No | `GPUTextureFormat[]` | `[]` | extra formats allowed for `createView` |

Core methods:

| Call | Returns | Notes |
|------|---------|-------|
| `canvas.getContext("webgpu")` | `GPUCanvasContext` | independent of any device |
| `navigator.gpu.getPreferredCanvasFormat()` | `"bgra8unorm"` or `"rgba8unorm"` | the format to pass to `configure` |
| `context.configure(config)` | `undefined` | sets up the swap-chain |
| `context.getCurrentTexture()` | `GPUTexture` | the current frame texture; call once per frame |
| `context.unconfigure()` | `undefined` | detaches the device, frees swap-chain textures |

## Decision Tree

**Choosing `alphaMode`:**

```
Does the canvas need to blend with HTML content behind it?
├── No, canvas is fully opaque background
│   └── alphaMode: "opaque" (default) — alpha channel is ignored on composite
└── Yes, canvas overlays page content (transparent regions show through)
    └── alphaMode: "premultiplied" — fragment RGB MUST already be
        multiplied by alpha; output alpha < 1 lets the page show through
```

**Choosing how to handle resize:**

```
Does the canvas have a fixed pixel size that never changes?
├── Yes
│   └── Set canvas.width / canvas.height once before configure(); no observer
└── No, the canvas is responsive / CSS-sized / fullscreen
    └── Use a ResizeObserver:
        observe the canvas, on callback set canvas.width / canvas.height
        from devicePixelContentBoxSize, clamp to
        device.limits.maxTextureDimension2D, then draw a frame
```

## Core Patterns

**ALWAYS get `format` from `navigator.gpu.getPreferredCanvasFormat()`.** The preferred
format varies per platform (`"bgra8unorm"` on most desktops, `"rgba8unorm"` on some
mobile GPUs). Hardcoding `"bgra8unorm"` forces a per-frame format conversion on platforms
that prefer `"rgba8unorm"`.

```js
const context = canvas.getContext("webgpu");
const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format });
```

**ALWAYS call `context.configure()` before `context.getCurrentTexture()`.** Calling
`getCurrentTexture()` on an unconfigured context throws `InvalidStateError`. The context
returned by `getContext("webgpu")` has no device until `configure()` runs.

**ALWAYS call `getCurrentTexture()` once per frame and use the result immediately.** The
texture is valid only for the frame it was obtained in. After the browser composites the
canvas, the swap-chain rotates and the texture becomes invalid.

```js
function frame() {
  const texture = context.getCurrentTexture();   // fresh every frame
  const view = texture.createView();             // fresh view every frame
  // ... build and submit a render pass that targets `view` ...
  requestAnimationFrame(frame);
}
```

**NEVER cache `getCurrentTexture()` or its `createView()` result across frames.** A
stale texture or view points at a swap-chain slot that is no longer the presentable one,
producing a black canvas or a validation error that the texture is already in use.

**ALWAYS resize by setting `canvas.width` and `canvas.height` attributes, NEVER only
CSS.** The `width`/`height` attributes define the swap-chain texture resolution. CSS
`width`/`height` only stretch the rendered result. Setting CSS alone renders at the old
low resolution and upscales, producing a blurry image.

```js
const observer = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const box = entry.devicePixelContentBoxSize[0];
    const max = device.limits.maxTextureDimension2D;
    canvas.width = Math.max(1, Math.min(box.inlineSize, max));
    canvas.height = Math.max(1, Math.min(box.blockSize, max));
  }
  frame();
});
observer.observe(canvas);
```

**ALWAYS pass the same `usage` flags that downstream code needs.** The default `usage`
is `RENDER_ATTACHMENT` only. Setting `usage` to a different value REPLACES the default;
to also copy the canvas (for a screenshot) pass
`GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC` explicitly.

## Common Anti-Patterns

**Caching `getCurrentTexture()` across frames.** The swap-chain rotates textures every
frame. A cached texture or view targets a slot that is no longer presentable, so the
canvas stays black or validation fails. Fix: call `getCurrentTexture()` fresh each frame.

**Setting only CSS size, not `width`/`height` attributes.** CSS sizing stretches a
fixed-resolution swap-chain. Result: a blurry upscale on high-DPI or resized displays.
Fix: write the device-pixel size into `canvas.width` and `canvas.height`.

**Calling `getCurrentTexture()` before `configure()`.** An unconfigured context has no
swap-chain, so the call throws `InvalidStateError`. Fix: always `configure()` first.

## Critical Warnings

- NEVER cache a canvas texture or its view beyond the current frame.
- NEVER call `getCurrentTexture()` before `context.configure()` has run.
- NEVER hardcode `"bgra8unorm"`; ALWAYS use `navigator.gpu.getPreferredCanvasFormat()`.
- NEVER resize a WebGPU canvas with CSS alone; ALWAYS set `canvas.width`/`canvas.height`.
- NEVER set `canvas.width`/`canvas.height` above `device.limits.maxTextureDimension2D`;
  clamp first or texture allocation fails validation.
- NEVER assume the pipeline can target the canvas with any format; the render pipeline
  `fragment.targets[0].format` MUST equal the format passed to `configure()`.

## Reference Files

- `methods.md` — `getContext`, `GPUCanvasConfiguration` fields, `configure`,
  `getCurrentTexture`, `unconfigure`, `getPreferredCanvasFormat` signatures.
- `examples.md` — verified code: context setup, per-frame texture
  acquisition, `ResizeObserver` resize handling.
- `anti-patterns.md` — canvas-context mistakes with WHY-it-fails analysis.

Related skills:

- `webgpu-core-architecture` — `navigator.gpu`, adapter and device acquisition.
- `webgpu-syntax-textures` — `GPUTexture`, `createView`, texture formats and usage.
- `webgpu-impl-render-targets` — using the canvas texture as a render-pass attachment.
- `webgpu-core-cross-browser` — preferred-format and feature differences per browser.
