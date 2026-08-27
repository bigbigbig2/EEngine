# Methods and API Surface: WebGPU in Web Workers

All API names, signatures, return types, and exception names below are verified
against the W3C WebGPU specification, MDN, and the WebGPU Explainer. Baseline:
WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## WorkerNavigator.gpu

The `gpu` property of the `WorkerNavigator` interface.

```js
// Inside a dedicated worker, `navigator` is a WorkerNavigator.
const gpu = navigator.gpu;   // resolves to WorkerNavigator.gpu
```

| Member | Type | Notes |
|--------|------|-------|
| `WorkerNavigator.gpu` | `GPU` | Read-only. Entry point for the WebGPU API inside a worker. |

- Returns the same `GPU` interface object that `Navigator.gpu` returns on the main thread.
- The `GPU` object exposes `requestAdapter(options?)` and `getPreferredCanvasFormat()`.
- Available only inside Web Workers. It is exposed on the `WorkerNavigator` interface, not on `Navigator`.
- Requires a secure context (HTTPS or `localhost`). On an insecure origin `navigator.gpu` is `undefined`.
- In a dedicated worker the global scope is `DedicatedWorkerGlobalScope`, and `self.navigator` is a `WorkerNavigator`. Plain `navigator.gpu` therefore reaches `WorkerNavigator.gpu`.
- Service workers do not run WebGPU render loops. The supported worker target is the dedicated worker. For shared workers, verify support against current docs.

The `GPU` interface (same as the main thread):

```js
const adapter = await navigator.gpu.requestAdapter(options?);  // Promise<GPUAdapter | null>
const device  = await adapter.requestDevice(descriptor?);       // Promise<GPUDevice>
const format  = navigator.gpu.getPreferredCanvasFormat();       // "bgra8unorm" | "rgba8unorm"
```

`requestAdapter()` can resolve to `null`, so the adapter MUST be null-checked.
See `webgpu-core-architecture` for the full adapter / device / queue model.

## OffscreenCanvas

A canvas surface that is decoupled from the DOM and can be used on the main thread
or transferred to a worker. It is a transferable object.

### Constructor

```js
new OffscreenCanvas(width, height)
```

| Parameter | Type | Notes |
|-----------|------|-------|
| `width` | number | Initial width of the offscreen canvas, in pixels. |
| `height` | number | Initial height of the offscreen canvas, in pixels. |

Use the constructor directly when no visible DOM canvas is needed (compute output,
image encoding, headless rendering inside the worker).

### Instance properties

| Property | Type | Notes |
|----------|------|-------|
| `OffscreenCanvas.width` | number | Width in pixels. Setting it resizes the surface. |
| `OffscreenCanvas.height` | number | Height in pixels. Setting it resizes the surface. |

The worker resizes the WebGPU swap-chain by assigning `offscreenCanvas.width` and
`offscreenCanvas.height`. The worker cannot observe DOM layout, so the main thread
MUST message the target size to the worker.

### Instance methods

| Method | Returns | Notes |
|--------|---------|-------|
| `OffscreenCanvas.getContext(contextType, options?)` | rendering context or `null` | See the table below. |
| `OffscreenCanvas.transferToImageBitmap()` | `ImageBitmap` | Snapshot of the most recently rendered image. |
| `OffscreenCanvas.convertToBlob(options?)` | `Promise<Blob>` | Encodes the canvas image to a `Blob`. |

`getContext(contextType)` supported `contextType` values and return types:

| `contextType` | Return type |
|---------------|-------------|
| `"2d"` | `OffscreenCanvasRenderingContext2D` |
| `"webgl"` | `WebGLRenderingContext` |
| `"webgl2"` | `WebGL2RenderingContext` |
| `"webgpu"` | `GPUCanvasContext` |
| `"bitmaprenderer"` | `ImageBitmapRenderingContext` |

`getContext("webgpu")` returns a `GPUCanvasContext`, the same context interface a
DOM `<canvas>` produces. The WebGPU specification defines no context attributes for
`getContext()`; configuration is supplied through `GPUCanvasContext.configure()`.
`getContext()` returns `null` if the context type is not supported, or if the
canvas was already set to a different context mode.

## HTMLCanvasElement.transferControlToOffscreen()

Transfers rendering control of a DOM `<canvas>` to an `OffscreenCanvas`.

```js
transferControlToOffscreen()
```

| Aspect | Value |
|--------|-------|
| Parameters | None. |
| Returns | `OffscreenCanvas` |
| Exception | `InvalidStateError` (a `DOMException`). |

`InvalidStateError` is thrown if:

- A context mode was already set on the canvas by calling `HTMLCanvasElement.getContext()`.
- The canvas has already transferred its control to an OffscreenCanvas (a second call).

After the call, the original DOM canvas element can no longer be used for
rendering. Its on-screen pixels are now driven by the returned OffscreenCanvas.
This method runs on the main thread, because it operates on a DOM element.

## postMessage transfer of an OffscreenCanvas

`OffscreenCanvas` is a transferable object, not a structured-cloneable object. It
MUST be listed in the transfer array of `postMessage`.

```js
// Main thread
worker.postMessage({ canvas: offscreen }, [offscreen]);
//                  ^ message payload      ^ transfer list (mandatory)
```

| Argument | Role |
|----------|------|
| First argument | The message payload. The OffscreenCanvas is referenced inside it. |
| Second argument | The transfer list. The OffscreenCanvas MUST appear here. |

- Omitting the OffscreenCanvas from the transfer list throws `DataCloneError`, because it cannot be structured-cloned.
- After transfer, the OffscreenCanvas is neutered on the sending side: it is no longer usable by the main thread. Ownership moves to the worker.
- The worker receives the OffscreenCanvas through the `message` event: `event.data.canvas`.

## Worker-side WebGPU context setup

Inside the worker, after receiving the OffscreenCanvas:

```js
const context = offscreenCanvas.getContext("webgpu");   // GPUCanvasContext
context.configure({
  device,                                               // GPUDevice
  format: navigator.gpu.getPreferredCanvasFormat(),      // "bgra8unorm" | "rgba8unorm"
  alphaMode: "opaque",                                   // "opaque" (default) | "premultiplied"
});
```

| Call | Notes |
|------|-------|
| `offscreenCanvas.getContext("webgpu")` | Returns `GPUCanvasContext`. |
| `GPUCanvasContext.configure(config)` | Binds the device and format. MUST run before `getCurrentTexture()`. |
| `GPUCanvasContext.getCurrentTexture()` | Returns the `GPUTexture` for the current frame. Throws `InvalidStateError` if called before `configure()`. |
| `GPUCanvasContext.unconfigure()` | Detaches the device from the context. |

The `GPUCanvasContext` API is identical between a worker OffscreenCanvas and a
main-thread DOM canvas. See `webgpu-syntax-canvas-context` for the full
`GPUCanvasConfiguration` surface.

## Verified Sources

- https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API
- https://developer.mozilla.org/en-US/docs/Web/API/WorkerNavigator/gpu
- https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas
- https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas/getContext
- https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/transferControlToOffscreen
- https://www.w3.org/TR/webgpu/
- https://gpuweb.github.io/gpuweb/explainer/
