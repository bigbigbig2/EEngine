# Async Patterns Examples

Working code for WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). Every API
name is verified against the W3C WebGPU specification, MDN, and the gpuweb explainer.

## Example 1: A complete requestAnimationFrame render loop

Initialization runs once and awaits freely. The frame callback never awaits.

```js
async function main(canvas) {
  // --- Initialization: awaiting is fine here, no frame is in flight. ---
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter.");
  const device = await adapter.requestDevice();
  const queue = device.queue;

  const context = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const shader = device.createShaderModule({
    label: "triangle-shader",
    code: `
      @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
        let p = array(vec2f(0, 0.5), vec2f(-0.5, -0.5), vec2f(0.5, -0.5));
        return vec4f(p[i], 0, 1);
      }
      @fragment fn fs() -> @location(0) vec4f { return vec4f(1, 0.4, 0.1, 1); }
    `,
  });

  // Async pipeline creation, awaited before the loop starts.
  const pipeline = await device.createRenderPipelineAsync({
    label: "triangle-pipeline",
    layout: "auto",
    vertex: { module: shader, entryPoint: "vs" },
    fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  // --- Frame loop: NEVER await GPU completion in here. ---
  function frame() {
    const encoder = device.createCommandEncoder({ label: "frame-encoder" });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(), // fresh every frame
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    queue.submit([encoder.finish()]); // submit, do not await
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
```

## Example 2: Updating uniforms per frame without stalling

`queue.writeBuffer` schedules the upload on the queue timeline. It does not block and
needs no `await`. `offset` and the data byte length MUST be multiples of 4.

```js
const uniformBuffer = device.createBuffer({
  label: "frame-uniforms",
  size: 64, // multiple of 4
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
const uniformData = new Float32Array(16); // a 4x4 matrix

function frame(timeMs) {
  updateMatrix(uniformData, timeMs); // CPU-side math
  queue.writeBuffer(uniformBuffer, 0, uniformData); // non-blocking upload

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
  queue.submit([encoder.finish()]);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

## Example 3: Loading multiple pipelines in parallel

`Promise.all` over the async variants compiles every shader concurrently, then the loop
starts only once all pipelines exist.

```js
async function loadPipelines(device, format) {
  const desc = (label, module) => ({
    label,
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  const [opaque, transparent, shadow] = await Promise.all([
    device.createRenderPipelineAsync(desc("opaque", opaqueModule)),
    device.createRenderPipelineAsync(desc("transparent", transparentModule)),
    device.createRenderPipelineAsync(desc("shadow", shadowModule)),
  ]);

  return { opaque, transparent, shadow }; // start the frame loop after this resolves
}
```

## Example 4: One-off readback outside the loop

Acceptable to stall here: no frame is in flight. The buffer needs `COPY_DST | MAP_READ`.

```js
async function readbackOnce(device, queue, sourceBuffer, byteSize) {
  const staging = device.createBuffer({
    label: "one-off-readback",
    size: byteSize, // multiple of 4
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(sourceBuffer, 0, staging, 0, byteSize);
  queue.submit([encoder.finish()]);

  await queue.onSubmittedWorkDone();            // GPU has finished the copy
  await staging.mapAsync(GPUMapMode.READ);      // offset 0 (multiple of 8), size = byteSize
  const result = new Float32Array(staging.getMappedRange().slice(0)); // copy out first
  staging.unmap();                              // ArrayBuffer now detached
  staging.destroy();
  return result;
}
```

## Example 5: Non-blocking readback with a rotating staging buffer

For continuous readback inside the loop. The `mapAsync` call is fire-and-forget: its
`.then` resolves a frame or two later. Results lag the GPU by a few frames, which is
correct for picking, histograms, or statistics overlays.

```js
const RING = 3;
const READBACK_BYTES = 256; // multiple of 4

const staging = Array.from({ length: RING }, (_, i) =>
  device.createBuffer({
    label: `readback-ring-${i}`,
    size: READBACK_BYTES,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  }));

let frameIndex = 0;
let latestReadback = null;

function frame() {
  // --- Render the scene (encoder + pass omitted for brevity). ---
  const encoder = device.createCommandEncoder({ label: "frame-encoder" });
  // ... encode the render pass, write into computeResultBuffer ...

  // --- Schedule a readback into the current ring slot. ---
  const slot = staging[frameIndex % RING];
  if (slot.mapState === "unmapped") {
    encoder.copyBufferToBuffer(computeResultBuffer, 0, slot, 0, READBACK_BYTES);
    queue.submit([encoder.finish()]);

    // Fire-and-forget: resolves on a LATER frame, never blocks this one.
    slot.mapAsync(GPUMapMode.READ).then(() => {
      latestReadback = new Float32Array(slot.getMappedRange().slice(0));
      slot.unmap(); // returns the slot to "unmapped" for reuse
    });
  } else {
    // Slot still pending: skip its readback this frame, render continues.
    queue.submit([encoder.finish()]);
  }

  if (latestReadback) updateHud(latestReadback); // consume the lagged result

  frameIndex++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

The `mapState === "unmapped"` guard is mandatory: it skips a slot that has not finished
its previous `mapAsync`/`unmap` cycle, which prevents the `"buffer is already mapped"`
error. With `RING = 3` the GPU has three frames of slack before any slot is reused.

## Verified sources

- https://www.w3.org/TR/webgpu/#buffer-mapping
- https://www.w3.org/TR/webgpu/#gpuqueue
- https://developer.mozilla.org/en-US/docs/Web/API/GPUBuffer/mapAsync
- https://webgpu.github.io/webgpu-samples/
