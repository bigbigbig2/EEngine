# Pipeline Architecture: Anti-Patterns

Each anti-pattern lists the broken code, WHY it fails, and the fix. Verified against the W3C WebGPU specification and MDN on 2026-05-20. Baseline: WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## 1. Binding an auto-layout bind group to a different pipeline

```js
// BROKEN
const pipelineA = device.createRenderPipeline({ layout: "auto", vertex, fragment: fragA });
const pipelineB = device.createRenderPipeline({ layout: "auto", vertex, fragment: fragB });

const group = device.createBindGroup({
  layout: pipelineA.getBindGroupLayout(0),
  entries: [{ binding: 0, resource: { buffer: cameraBuffer } }],
});

pass.setPipeline(pipelineB);
pass.setBindGroup(0, group); // validation error
```

WHY it fails: a pipeline created with `layout: "auto"` generates its own private, implicit `GPUBindGroupLayout` for each group. The layout from `pipelineA.getBindGroupLayout(0)` is not the same object, and is not "group-equivalent", to the one `pipelineB` generated. Setting a bind group whose layout does not match the bound pipeline's layout fails render-pass validation.

Fix: build an explicit `GPUPipelineLayout` from explicit `GPUBindGroupLayout` objects and pass that same layout to both pipelines. A bind group built from the shared `GPUBindGroupLayout` is then valid for every pipeline that uses that pipeline layout.

```js
// FIXED
const sharedLayout = device.createBindGroupLayout({
  entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
});
const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [sharedLayout] });

const pipelineA = device.createRenderPipeline({ layout: pipelineLayout, vertex, fragment: fragA });
const pipelineB = device.createRenderPipeline({ layout: pipelineLayout, vertex, fragment: fragB });

const group = device.createBindGroup({
  layout: sharedLayout,
  entries: [{ binding: 0, resource: { buffer: cameraBuffer } }],
});
// group is now valid for both pipelineA and pipelineB
```

## 2. Synchronous pipeline creation for heavy shaders during a frame

```js
// BROKEN
function onLevelStream() {
  // Several heavy shaders compiled synchronously while the game renders.
  for (const desc of newMaterialDescriptors) {
    materials.push(device.createRenderPipeline(desc)); // blocks the main thread
  }
}
```

WHY it fails: `createRenderPipeline` and `createComputePipeline` are synchronous. Each call blocks the JavaScript main thread while the WGSL is compiled and the pipeline is validated by the backend. For heavy or numerous shaders this stalls the main thread for many milliseconds, the frame budget is blown, and the user sees a hitch or freeze.

Fix: use `createRenderPipelineAsync` / `createComputePipelineAsync`. They return a `Promise` and compile off the main thread, so the render loop keeps running while compilation happens.

```js
// FIXED
async function onLevelStream() {
  const built = await Promise.all(
    newMaterialDescriptors.map((desc) => device.createRenderPipelineAsync(desc)),
  );
  materials.push(...built);
}
```

## 3. Recreating pipelines every frame

```js
// BROKEN
function frame() {
  const pipeline = device.createRenderPipeline({ // rebuilt 60 times per second
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
  });
  const pass = encoder.beginRenderPass(passDesc);
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  requestAnimationFrame(frame);
}
```

WHY it fails: a `GPURenderPipeline` is immutable, so nothing about it changes between frames; recreating it is pure waste. Each call re-runs WGSL compilation and full descriptor validation, burning CPU every frame and producing constant garbage-collection pressure from discarded pipeline objects. None of this work changes a single pixel.

Fix: create each pipeline once at initialization or asset-load time, store the reference, and reuse the immutable object in the render loop.

```js
// FIXED
const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module, entryPoint: "vs" },
  fragment: { module, entryPoint: "fs", targets: [{ format }] },
});

function frame() {
  const pass = encoder.beginRenderPass(passDesc);
  pass.setPipeline(pipeline); // reuse
  pass.draw(3);
  pass.end();
  requestAnimationFrame(frame);
}
```

## 4. Mismatched fragment target format versus attachment format

```js
// BROKEN
const format = navigator.gpu.getPreferredCanvasFormat(); // e.g. "bgra8unorm"
context.configure({ device, format });

const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex,
  fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, // wrong
});

const pass = encoder.beginRenderPass({
  colorAttachments: [{
    view: context.getCurrentTexture().createView(), // texture is "bgra8unorm"
    loadOp: "clear", storeOp: "store",
  }],
});
pass.setPipeline(pipeline); // validation error: format mismatch
```

WHY it fails: the pipeline's `fragment.targets[i].format` declares the texture format the fragment stage writes. The render pass's color attachment at index `i` has its own texture format. WebGPU requires these to be equal so the backend can fix the output blend and write path at pipeline-creation time. When they differ the render pass rejects the pipeline.

Fix: use one `format` value for both. For the canvas, that value is always `navigator.gpu.getPreferredCanvasFormat()`. Never hardcode `"bgra8unorm"` or `"rgba8unorm"`, because the preferred format differs across platforms.

```js
// FIXED
const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format });

const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex,
  fragment: { module, entryPoint: "fs", targets: [{ format }] }, // same value
});
```

## 5. Assuming createShaderModule throws on a WGSL error

```js
// BROKEN ASSUMPTION
try {
  const module = device.createShaderModule({ code: brokenWgsl });
  // expecting this to throw on a syntax error
} catch (e) {
  console.error("shader failed", e);
}
// catch never runs; `module` looks fine but is invalid
```

WHY it fails: `createShaderModule` always returns a `GPUShaderModule` synchronously and does not throw on a WGSL compilation error. The diagnostics are delivered asynchronously through `module.getCompilationInfo()`, and the error surfaces again when the module is used to create a pipeline. Code that relies on a thrown exception silently proceeds with an invalid module.

Fix: inspect `getCompilationInfo()` during development, and wrap pipeline creation in an error scope (or `await` the async variant and catch the `GPUPipelineError`) to detect the real failure.

```js
// FIXED
const module = device.createShaderModule({ code });
for (const m of (await module.getCompilationInfo()).messages) {
  if (m.type === "error") {
    console.error(`WGSL ${m.lineNum}:${m.linePos} ${m.message}`);
  }
}
```
