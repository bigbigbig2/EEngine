# Canvas Context Methods Reference

API surface for WebGPU canvas presentation. Verified against the W3C WebGPU
specification, the gpuweb explainer, and MDN on 2026-05-20. Baseline: WebGPU 1.0-stable
(Chrome 113+, Safari 26+, Firefox 141+).

## HTMLCanvasElement.getContext("webgpu")

```js
const context = canvas.getContext("webgpu");
```

- Returns a `GPUCanvasContext`, or `null` if the browser does not support WebGPU.
- The context is created **independent of any `GPUDevice`**. The explainer notes any
  context can later be used with any device; the device is bound only by `configure()`.
- Works on `HTMLCanvasElement` and on `OffscreenCanvas` (the latter enables WebGPU
  rendering from a Web Worker).
- A canvas can only have one context type. Calling `getContext("2d")` or
  `getContext("webgl2")` on the same canvas after `getContext("webgpu")` returns `null`.

## navigator.gpu.getPreferredCanvasFormat()

```js
const format = navigator.gpu.getPreferredCanvasFormat();
```

- Returns a `GPUTextureFormat` string: `"bgra8unorm"` or `"rgba8unorm"`.
- The return value is the format the platform composites most efficiently. Passing a
  different format to `configure()` is allowed but costs a per-frame conversion.
- ALWAYS use this as the `format` argument to `context.configure()`.

## GPUCanvasConfiguration (the argument to configure)

| Field | Required | Type | Default | Description |
|-------|----------|------|---------|-------------|
| `device` | Yes | `GPUDevice` | none | the device that creates the swap-chain textures |
| `format` | Yes | `GPUTextureFormat` | none | `"bgra8unorm"`, `"rgba8unorm"`, or `"rgba16float"` |
| `usage` | No | `GPUTextureUsage` flags | `GPUTextureUsage.RENDER_ATTACHMENT` | how the canvas texture may be used |
| `viewFormats` | No | `GPUTextureFormat[]` | `[]` | additional formats permitted in `texture.createView({ format })` |
| `colorSpace` | No | `PredefinedColorSpace` | `"srgb"` | `"srgb"` or `"display-p3"` |
| `toneMapping` | No | `GPUCanvasToneMapping` | `{ mode: "standard" }` | `{ mode: "standard" }` or `{ mode: "extended" }` |
| `alphaMode` | No | `GPUCanvasAlphaMode` | `"opaque"` | `"opaque"` or `"premultiplied"` |

### usage flag values

`usage` is a bitmask of `GPUTextureUsage` constants combined with `|`:
`RENDER_ATTACHMENT`, `COPY_SRC`, `COPY_DST`, `TEXTURE_BINDING`, `STORAGE_BINDING`.

- The default is `RENDER_ATTACHMENT` alone.
- Setting `usage` REPLACES the default; it is not additive. To both render and copy the
  canvas pass `GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC`.

### alphaMode values

- `"opaque"` (default): the alpha channel of the canvas texture is ignored during
  compositing. The canvas is treated as fully opaque.
- `"premultiplied"`: the canvas blends with HTML content behind it. The fragment shader
  output RGB MUST already be multiplied by its alpha (premultiplied alpha). An output
  alpha below 1 lets the page show through.

### colorSpace values

- `"srgb"` (default): standard sRGB gamut.
- `"display-p3"`: the wider Display P3 gamut, for HDR-capable and wide-gamut displays.

### toneMapping mode values

- `"standard"` (default): colors are clamped to the SDR range.
- `"extended"`: permits HDR values beyond the SDR range on capable displays.

## GPUCanvasContext.configure(configuration)

```js
context.configure({
  device,
  format: navigator.gpu.getPreferredCanvasFormat(),
  alphaMode: "opaque",
});
```

- Returns `undefined`.
- Allocates the swap-chain textures and binds the context to `device`.
- MUST be called before `getCurrentTexture()`; otherwise `getCurrentTexture()` throws
  `InvalidStateError`.
- Calling `configure()` again replaces the configuration. After the canvas is resized
  via its `width`/`height` attributes, the next `getCurrentTexture()` returns a texture
  at the new size; re-calling `configure()` after a resize is not required.
- Throws `TypeError` if `usage` includes an invalid or transient-attachment bit.

## GPUCanvasContext.getCurrentTexture()

```js
const texture = context.getCurrentTexture();
```

- Returns a `GPUTexture` representing the next frame to be composited.
- The returned texture has the `format`, size, and `usage` set by `configure()` and the
  current `canvas.width`/`canvas.height`.
- Call it **once per frame** and use the result within that frame only. The texture is
  invalidated after the canvas is composited; a cached texture or its view targets a
  stale swap-chain slot.
- Throws `InvalidStateError` if called before `configure()`.
- Create the render-pass attachment view with `texture.createView()` each frame; do not
  cache the view.

## GPUCanvasContext.unconfigure()

```js
context.unconfigure();
```

- Returns `undefined`.
- Detaches the device from the context and frees the swap-chain textures.
- After `unconfigure()`, `getCurrentTexture()` throws `InvalidStateError` again until
  `configure()` is called once more.
- Use it to release GPU memory when a canvas is hidden or removed, or before
  reconfiguring with a different device after a device-loss recovery.

## Canvas resize mechanics

- The swap-chain texture resolution is defined by the `canvas.width` and `canvas.height`
  **attributes** (integers), not by CSS `width`/`height` (which only scale the displayed
  element).
- Assigning new values to `canvas.width`/`canvas.height` resizes the swap-chain. The
  next `getCurrentTexture()` returns a texture at the new dimensions.
- Both dimensions MUST be clamped to `device.limits.maxTextureDimension2D` (default
  8192) before assignment; a larger value causes texture allocation to fail validation.
- A `ResizeObserver` is the mechanism for responsive canvases: observe the canvas, and
  in the callback read `entry.devicePixelContentBoxSize[0]` (`inlineSize`, `blockSize`)
  to get the exact device-pixel size, then write the clamped values to
  `canvas.width`/`canvas.height` and render a frame.

## Reference sources

- https://www.w3.org/TR/webgpu/ — W3C WebGPU specification (canvas context interface).
- https://developer.mozilla.org/en-US/docs/Web/API/GPUCanvasContext — context overview.
- https://developer.mozilla.org/en-US/docs/Web/API/GPUCanvasContext/configure — `configure` and `GPUCanvasConfiguration`.
- https://developer.mozilla.org/en-US/docs/Web/API/GPUCanvasContext/getCurrentTexture — per-frame texture acquisition.
- https://gpuweb.github.io/gpuweb/explainer/ — device-independence of the context.
