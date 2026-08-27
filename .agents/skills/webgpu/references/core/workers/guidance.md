# WebGPU in Web Workers

Run the WebGPU render or compute loop inside a dedicated Web Worker and render to an OffscreenCanvas so the main thread stays free of jank. Baseline: WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## Quick Reference

| Step | Where | API |
|------|-------|-----|
| 1. Obtain an OffscreenCanvas from a DOM `<canvas>` | Main thread | `canvas.transferControlToOffscreen()` |
| 2. Send the OffscreenCanvas to the worker | Main thread | `worker.postMessage({ canvas }, [canvas])` |
| 3. Receive the OffscreenCanvas | Worker | `event.data.canvas` |
| 4. Access the GPU entry point | Worker | `navigator.gpu` (resolves to `WorkerNavigator.gpu`) |
| 5. Request adapter and device | Worker | `await navigator.gpu.requestAdapter()`, `await adapter.requestDevice()` |
| 6. Get the WebGPU context | Worker | `offscreenCanvas.getContext("webgpu")` returns `GPUCanvasContext` |
| 7. Configure and render | Worker | `context.configure({ device, format })`, then the render loop |
| 8. Resize | Main thread sends, worker applies | `postMessage` size, worker sets `offscreenCanvas.width/height` |

Key facts:

- `navigator.gpu` inside a dedicated worker is the `WorkerNavigator.gpu` property. It returns the same `GPU` interface as on the main thread.
- `OffscreenCanvas.getContext("webgpu")` returns a `GPUCanvasContext`, identical to a DOM canvas context.
- `OffscreenCanvas` is a transferable object. It MUST appear in the `postMessage` transfer list.
- WebGPU ALWAYS requires a secure context (HTTPS or `localhost`). This applies inside workers too.
- The supported worker target is the **dedicated worker** (`new Worker(...)`). See Critical Warnings for unsupported contexts.

## Decision Tree

```
Is the WebGPU render or compute loop causing main-thread jank?
├── No, frame work is light and the main thread stays responsive
│   └── Keep WebGPU on the main thread. A worker adds postMessage and
│       transfer complexity for no benefit.
└── Yes, OR heavy CPU work runs alongside rendering on the main thread
    └── Move WebGPU to a dedicated worker.
        Does the result need to appear in a visible DOM <canvas>?
        ├── Yes
        │   └── Main thread: canvas.transferControlToOffscreen(),
        │       postMessage the OffscreenCanvas in the transfer list.
        │       Worker: offscreenCanvas.getContext("webgpu") and render.
        └── No, output is read back to CPU or encoded to an image
            └── Worker: new OffscreenCanvas(w, h) directly. No DOM canvas
                and no transferControlToOffscreen needed.
```

## Core Patterns

### Pattern 1: ALWAYS transfer the OffscreenCanvas in the postMessage transfer list

ALWAYS pass the OffscreenCanvas as the second argument of `postMessage`:

```js
const offscreen = canvas.transferControlToOffscreen();
worker.postMessage({ canvas: offscreen }, [offscreen]);
```

NEVER call `worker.postMessage({ canvas: offscreen })` without the transfer list. An OffscreenCanvas is a transferable object, not a structured-cloneable one. Omitting it from the transfer array throws a `DataCloneError` and the worker receives nothing usable.

### Pattern 2: ALWAYS call transferControlToOffscreen exactly once per canvas

ALWAYS call `canvas.transferControlToOffscreen()` a single time on a given DOM canvas. The second call throws `InvalidStateError`. Store the returned OffscreenCanvas reference if it is needed again. The same `InvalidStateError` is thrown if `getContext()` was already called on that DOM canvas before transfer.

### Pattern 3: ALWAYS get the GPU through navigator.gpu inside the worker

ALWAYS use `navigator.gpu` inside the worker. In a dedicated worker the global scope is `DedicatedWorkerGlobalScope`, and its `navigator` is a `WorkerNavigator`, so `navigator.gpu` is the `WorkerNavigator.gpu` property. NEVER reference `window` or `document` in a worker: those globals do not exist there and produce a `ReferenceError`.

### Pattern 4: NEVER access a DOM canvas element from inside a worker

NEVER call `document.querySelector`, `document.getElementById`, or any DOM API from a worker. The worker has no DOM. The worker only ever holds the OffscreenCanvas that the main thread transferred to it. All DOM interaction (creating the `<canvas>`, reading layout size, attaching events) stays on the main thread.

### Pattern 5: ALWAYS message resize requests from the main thread to the worker

The worker cannot observe DOM layout, so it cannot detect a canvas resize. ALWAYS run the `ResizeObserver` on the main thread, then `postMessage` the new dimensions to the worker. The worker applies them by setting `offscreenCanvas.width` and `offscreenCanvas.height`. NEVER attempt to read display size from the worker.

### Pattern 6: ALWAYS configure the context inside the worker before rendering

ALWAYS call `context.configure({ device, format, alphaMode })` inside the worker after the device is created and before the first `getCurrentTexture()`. The `format` ALWAYS comes from `navigator.gpu.getPreferredCanvasFormat()`, which is available on the worker `GPU` object. Calling `getCurrentTexture()` before `configure()` throws `InvalidStateError`.

## Common Anti-Patterns

1. **Accessing a DOM canvas from the worker.** Calling `document.getElementById("canvas")` inside a worker throws `ReferenceError: document is not defined`. The worker has no DOM. Only the transferred OffscreenCanvas is available there.

2. **Omitting the OffscreenCanvas from the transfer list.** `worker.postMessage({ canvas })` without the `[canvas]` transfer array throws `DataCloneError`, because an OffscreenCanvas cannot be structured-cloned. It MUST be transferred.

3. **Calling transferControlToOffscreen twice.** A second `canvas.transferControlToOffscreen()` on the same DOM canvas throws `InvalidStateError`. Control is transferred once and is permanent.

## Critical Warnings

- NEVER call `transferControlToOffscreen()` more than once on a DOM canvas. The second call throws `InvalidStateError`.
- NEVER call `transferControlToOffscreen()` after `getContext()` was already called on that DOM canvas. It throws `InvalidStateError`.
- NEVER omit the OffscreenCanvas from the `postMessage` transfer list. It throws `DataCloneError`.
- NEVER use `window`, `document`, or any DOM element inside a worker. The worker scope has none of them.
- NEVER resize the canvas by reading layout from the worker. Layout information lives only on the main thread.
- WebGPU in workers targets the **dedicated worker** created with `new Worker(...)`. Service workers do not run WebGPU render loops. For shared workers and other worker types, verify support against current docs before relying on them.
- NEVER serve the worker page over an insecure origin. WebGPU requires a secure context (HTTPS or `localhost`) inside workers as well; `navigator.gpu` is `undefined` otherwise.

## Reference Files

- `methods.md` : WorkerNavigator.gpu, OffscreenCanvas, transferControlToOffscreen, getContext("webgpu") in a worker, postMessage transfer semantics.
- `examples.md` : verified main-thread transfer code and worker-side WebGPU render setup.
- `anti-patterns.md` : worker mistakes with WHY-it-fails explanations.

Related skills:

- `webgpu-core-architecture` : the adapter / device / queue model used inside the worker.
- `webgpu-syntax-canvas-context` : `getContext("webgpu")`, `configure`, `getCurrentTexture`.
- `webgpu-impl-async-patterns` : async initialization and the render loop.
