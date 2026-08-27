# Anti-Patterns: WebGPU in Web Workers

Each anti-pattern lists the broken code, WHY it fails, and the correct fix.
Verified against the W3C WebGPU specification, MDN, and the WebGPU Explainer.
Baseline: WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## Anti-Pattern 1: Accessing a DOM canvas from inside a worker

```js
// render-worker.js  -- WRONG
const canvas = document.getElementById("gpu-canvas");
const context = canvas.getContext("webgpu");
```

WHY IT FAILS: A dedicated worker has no DOM. `document` and `window` do not exist
in the `DedicatedWorkerGlobalScope`. The first line throws
`ReferenceError: document is not defined`, and the worker never starts. A worker
cannot reach any DOM element, including a `<canvas>`.

FIX: The main thread transfers the canvas. The worker only ever uses the
OffscreenCanvas it receives through the `message` event.

```js
// main.js
const offscreen = document.getElementById("gpu-canvas").transferControlToOffscreen();
worker.postMessage({ canvas: offscreen }, [offscreen]);

// render-worker.js  -- CORRECT
self.onmessage = (event) => {
  const canvas = event.data.canvas;          // the transferred OffscreenCanvas
  const context = canvas.getContext("webgpu");
};
```

## Anti-Pattern 2: Omitting the OffscreenCanvas from the postMessage transfer list

```js
// main.js  -- WRONG
const offscreen = canvas.transferControlToOffscreen();
worker.postMessage({ canvas: offscreen });   // no transfer list
```

WHY IT FAILS: `OffscreenCanvas` is a transferable object, not a
structured-cloneable one. When it is not listed in the transfer array, the
structured-clone algorithm runs over it and throws `DataCloneError`. The
`postMessage` call fails and the worker receives nothing usable.

FIX: Pass the OffscreenCanvas in the second argument, the transfer list.

```js
// main.js  -- CORRECT
const offscreen = canvas.transferControlToOffscreen();
worker.postMessage({ canvas: offscreen }, [offscreen]);
//                  payload               ^ transfer list
```

## Anti-Pattern 3: Calling transferControlToOffscreen twice on the same canvas

```js
// WRONG
const offscreenA = canvas.transferControlToOffscreen();
// ... later, elsewhere in the code ...
const offscreenB = canvas.transferControlToOffscreen();   // throws
```

WHY IT FAILS: Once a DOM canvas has transferred its rendering control, that
transfer is permanent. A second `transferControlToOffscreen()` call on the same
canvas throws `InvalidStateError`. The same exception is thrown if
`canvas.getContext()` was already called on that DOM canvas before the transfer,
because the canvas already has a context mode set.

FIX: Call `transferControlToOffscreen()` exactly once per canvas, and never call
`getContext()` on a canvas that will be transferred. Store the returned
OffscreenCanvas reference if it is needed in more than one place.

```js
// CORRECT
const offscreen = canvas.transferControlToOffscreen();   // exactly once
// reuse the `offscreen` reference instead of calling the method again
```

## Anti-Pattern 4: Resizing the canvas from the worker by reading layout

```js
// render-worker.js  -- WRONG
const rect = canvas.getBoundingClientRect();   // no such method here
canvas.width = rect.width;
canvas.height = rect.height;
```

WHY IT FAILS: An `OffscreenCanvas` has no DOM layout. It has no
`getBoundingClientRect`, no CSS box, and no `ResizeObserver` target. The worker
cannot observe how large the visible `<canvas>` is rendered on screen. Reading
layout from the worker is impossible, so the swap-chain size drifts out of sync
with the on-screen element, producing a blurry or wrongly scaled image.

FIX: Run the `ResizeObserver` on the main thread, then message the new size to
the worker. The worker applies it by writing `width` and `height` on the
OffscreenCanvas.

```js
// main.js  -- CORRECT
new ResizeObserver((entries) => {
  const box = entries[0].contentBoxSize[0];
  worker.postMessage({
    type: "resize",
    width: Math.round(box.inlineSize),
    height: Math.round(box.blockSize),
  });
}).observe(canvas);

// render-worker.js  -- CORRECT
self.onmessage = (event) => {
  if (event.data.type === "resize") {
    offscreenCanvas.width = event.data.width;
    offscreenCanvas.height = event.data.height;
  }
};
```

## Anti-Pattern 5: Expecting WebGPU rendering inside a service worker

```js
// service-worker.js  -- WRONG
self.addEventListener("fetch", async () => {
  const adapter = await navigator.gpu.requestAdapter();
  // ... run a render loop ...
});
```

WHY IT FAILS: A service worker is event-driven, short-lived, and has no
persistent rendering surface. It is not the supported target for a WebGPU render
loop. The supported worker target is the dedicated worker created with
`new Worker(...)`, which has a stable lifetime and can hold an OffscreenCanvas.

FIX: Run WebGPU inside a dedicated worker. For shared workers and other worker
types, verify support against current docs before relying on them.

```js
// main.js  -- CORRECT
const worker = new Worker("render-worker.js", { type: "module" });
```

## Anti-Pattern 6: Serving the worker over an insecure origin

```js
// http://example.com served over plain HTTP  -- WRONG
const adapter = await navigator.gpu.requestAdapter();   // navigator.gpu is undefined
```

WHY IT FAILS: WebGPU requires a secure context. On an insecure origin
`navigator.gpu` is `undefined`, inside a worker as well as on the main thread.
`navigator.gpu.requestAdapter()` then throws `TypeError: Cannot read properties
of undefined`.

FIX: Serve the page and the worker over HTTPS, or use `localhost` during
development. ALWAYS check `if (!navigator.gpu)` before requesting an adapter.

```js
// render-worker.js  -- CORRECT
if (!navigator.gpu) {
  throw new Error("WebGPU is not available. Requires a secure context (HTTPS or localhost).");
}
const adapter = await navigator.gpu.requestAdapter();
```

## Verified Sources

- https://developer.mozilla.org/en-US/docs/Web/API/WorkerNavigator/gpu
- https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas
- https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas/getContext
- https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/transferControlToOffscreen
- https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API
- https://www.w3.org/TR/webgpu/
