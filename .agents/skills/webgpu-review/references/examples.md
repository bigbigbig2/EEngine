# Examples: Flawed WebGPU Code and the Corrected Version

Each case shows a BEFORE block with a defect a reviewer must catch, the detection cue,
and an AFTER block with the corrected code. Version baseline: WebGPU 1.0-stable
(Chrome 113+, Safari 26+, Firefox 141+). All API names verified against the WebGPU and
WGSL specifications.

---

## Case 1: Hallucinated API

A reviewer must flag any API not in the 1.0-stable surface.

### BEFORE (flawed)

```js
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.createDevice();          // hallucinated method
const buffer = device.createBufferSync({ size: 256 }); // hallucinated method
buffer.update(0, data);                                // hallucinated method
```

Detection cue: `adapter.createDevice`, `device.createBufferSync`, and `buffer.update`
are not in the WebGPU 1.0 spec. The real methods are `adapter.requestDevice`,
`device.createBuffer`, and `queue.writeBuffer`.

### AFTER (corrected)

```js
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error("No WebGPU adapter.");
const device = await adapter.requestDevice();
const buffer = device.createBuffer({
  label: "vertex-data",
  size: 256,
  usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(buffer, 0, data);
```

Routing: cross-check against `references/methods.md` Part 2; route initialization to
`webgpu-core-architecture` and buffers to `webgpu-syntax-buffers`.

---

## Case 2: Missing adapter null-check and device-loss handler

### BEFORE (flawed)

```js
async function init() {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();   // adapter may be null
  // no device.lost handler
  return device;
}
```

Detection cue: `adapter.requestDevice()` is called with no `if (!adapter)` guard, and
no `device.lost.then(...)` is attached. `requestAdapter()` resolves to `null` on no
compatible GPU.

### AFTER (corrected)

```js
async function init() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter available.");
  const device = await adapter.requestDevice();

  device.lost.then((info) => {
    console.error(`Device lost: ${info.reason} : ${info.message}`);
    if (info.reason !== "destroyed") {
      init(); // re-request adapter and device, recreate ALL resources
    }
  });
  return device;
}
```

Routing: `webgpu-core-architecture` for the null-check, `webgpu-errors-device-loss`
for the recovery pattern.

---

## Case 3: Alignment error in texture readback

### BEFORE (flawed)

```js
const width = 100, height = 100;
const readback = device.createBuffer({
  size: width * height * 4,                       // 40000 bytes
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
encoder.copyTextureToBuffer(
  { texture },
  { buffer: readback, bytesPerRow: width * 4 },   // 400, NOT a multiple of 256
  { width, height },
);
```

Detection cue: `bytesPerRow` is `400`, which is not a multiple of 256. The copy fails
validation.

### AFTER (corrected)

```js
const width = 100, height = 100;
const bytesPerRow = Math.ceil((width * 4) / 256) * 256;  // 512
const readback = device.createBuffer({
  label: "texture-readback",
  size: bytesPerRow * height,                            // padded size
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
encoder.copyTextureToBuffer(
  { texture },
  { buffer: readback, bytesPerRow },
  { width, height },
);
// After mapAsync, strip the 112 bytes of padding per row on the CPU.
```

Routing: `webgpu-core-memory-model` and `webgpu-impl-buffer-upload`.

---

## Case 4: Bind-group binding mismatch

### BEFORE (flawed)

WGSL:

```wgsl
@group(0) @binding(0) var<uniform> camera : Camera;
@group(0) @binding(1) var<uniform> model  : Model;
```

Host:

```js
const layout = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
    // binding 1 is missing
  ],
});
```

Detection cue: WGSL declares `@binding(1)` but the layout has no entry with
`binding: 1`. WebGPU binds by index; the missing entry fails pipeline creation.

### AFTER (corrected)

```js
const layout = device.createBindGroupLayout({
  label: "scene-bgl",
  entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
    { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
  ],
});
```

Routing: `webgpu-syntax-bind-groups`.

---

## Case 5: Uniform struct layout mismatch (vec3 16-byte trap)

### BEFORE (flawed)

WGSL:

```wgsl
struct Params {
  scale  : f32,
  offset : vec3f,
}
@group(0) @binding(0) var<uniform> params : Params;
```

Host:

```js
// Assumes offset starts at byte 4. WRONG.
const data = new Float32Array(4);
data[0] = scale;          // offset 0
data[1] = ox; data[2] = oy; data[3] = oz;  // offsets 4, 8, 12
```

Detection cue: `vec3f` aligns to 16 bytes, so `offset` starts at byte 16, not byte 4.
The shader reads garbage for `offset`.

### AFTER (corrected)

```js
// Params: scale at 0, padding 4..15, offset (vec3f) at 16. Total size 32.
const data = new Float32Array(8);
data[0] = scale;          // offset 0
data[4] = ox;             // offset 16
data[5] = oy;             // offset 20
data[6] = oz;             // offset 24
```

Routing: `webgpu-wgsl-memory-layout`.

---

## Case 6: WGSL switch without default

### BEFORE (flawed)

```wgsl
fn pick(i : i32) -> f32 {
  switch i {
    case 0: { return 0.0; }
    case 1: { return 1.0; }
  }
}
```

Detection cue: the `switch` has no `default:` clause. WGSL requires a mandatory
`default:`; this is a shader-creation error.

### AFTER (corrected)

```wgsl
fn pick(i : i32) -> f32 {
  switch i {
    case 0: { return 0.0; }
    case 1: { return 1.0; }
    default: { return -1.0; }
  }
}
```

Routing: `webgpu-wgsl-syntax`.

---

## Case 7: Compute shader missing @workgroup_size and barrier

### BEFORE (flawed)

```wgsl
var<workgroup> tile : array<f32, 64>;

@compute                                    // missing @workgroup_size
fn main(@builtin(local_invocation_index) li : u32) {
  tile[li] = f32(li);
  let sum = tile[0] + tile[63];             // reads other invocations, no barrier
}
```

Detection cue: the `@compute` entry point has no `@workgroup_size`, and the read of
`tile` written by other invocations has no `workgroupBarrier()` before it.

### AFTER (corrected)

```wgsl
var<workgroup> tile : array<f32, 64>;

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) li : u32) {
  tile[li] = f32(li);
  workgroupBarrier();                        // all writes visible after this
  let sum = tile[0] + tile[63];
}
```

Routing: `webgpu-wgsl-compute-shaders`.

---

## Case 8: Render-loop stall

### BEFORE (flawed)

```js
function frame() {
  encoder.copyBufferToBuffer(src, 0, staging, 0, size);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();   // stalls every frame
  await staging.mapAsync(GPUMapMode.READ);    // stalls every frame
  requestAnimationFrame(frame);
}
```

Detection cue: the frame loop `await`s `onSubmittedWorkDone` and `mapAsync`, forcing a
CPU-GPU sync that collapses frame pipelining.

### AFTER (corrected)

```js
function frame() {
  const encoder = device.createCommandEncoder({ label: "frame" });
  encoder.copyBufferToBuffer(src, 0, stagingRing[writeIndex], 0, size);
  device.queue.submit([encoder.finish()]);
  // Read a staging buffer that was filled one or two frames earlier; never await here.
  requestAnimationFrame(frame);
}
```

Routing: `webgpu-impl-async-patterns` and `webgpu-impl-performance`.

---

## Case 9: Pipeline target format mismatch

### BEFORE (flawed)

```js
const format = navigator.gpu.getPreferredCanvasFormat(); // e.g. "bgra8unorm"
context.configure({ device, format });

const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module },
  fragment: { module, targets: [{ format: "rgba8unorm" }] }, // mismatch
});
```

Detection cue: the canvas is configured with the preferred format but the pipeline
`fragment.targets[0].format` is hard-coded to a different format. Pipeline creation or
the render pass fails validation.

### AFTER (corrected)

```js
const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format });

const pipeline = device.createRenderPipeline({
  label: "main-pipeline",
  layout: "auto",
  vertex: { module },
  fragment: { module, targets: [{ format }] }, // matches the canvas format
});
```

Routing: `webgpu-syntax-render-pipeline`.

---

## Case 10: Caching getCurrentTexture across frames

### BEFORE (flawed)

```js
const view = context.getCurrentTexture().createView(); // captured once

function frame() {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view, loadOp: "clear", storeOp: "store" }], // stale view
  });
  pass.end();
  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(frame);
}
```

Detection cue: `getCurrentTexture()` and its view are captured once outside the loop.
The swap-chain rotates textures each frame; a stale view produces a black canvas or a
validation error.

### AFTER (corrected)

```js
function frame() {
  const view = context.getCurrentTexture().createView(); // fresh every frame
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view, loadOp: "clear", storeOp: "store" }],
  });
  pass.end();
  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(frame);
}
```

Routing: `webgpu-syntax-canvas-context` and `webgpu-impl-render-targets`.

---

## Case 11: Optional feature requested without detection

### BEFORE (flawed)

```js
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice({
  requiredFeatures: ["shader-f16", "timestamp-query"], // hard-coded
});
```

Detection cue: `requiredFeatures` lists optional features with no
`adapter.features.has(...)` guard. `requestDevice` rejects on a browser lacking either
feature, breaking the app cross-browser.

### AFTER (corrected)

```js
const adapter = await navigator.gpu.requestAdapter();
const wanted = ["shader-f16", "timestamp-query"];
const requiredFeatures = wanted.filter((f) => adapter.features.has(f));
const device = await adapter.requestDevice({ requiredFeatures });
// The app degrades gracefully when a feature is absent.
```

Routing: `webgpu-core-limits-features` and `webgpu-core-cross-browser`.

---

## Case 12: Sampling a texture bound as an attachment in the same pass

### BEFORE (flawed)

```js
const pass = encoder.beginRenderPass({
  colorAttachments: [{ view: sceneView, loadOp: "clear", storeOp: "store" }],
});
pass.setBindGroup(0, bindGroupSamplingScene); // sceneView also sampled here
pass.draw(3);
pass.end();
```

Detection cue: `sceneView` is both a color attachment and a sampled resource in the
same render pass. Read/write ordering is undefined; validation rejects the bind group.

### AFTER (corrected)

```js
// Pass 1: render the scene into an offscreen texture.
const pass1 = encoder.beginRenderPass({
  colorAttachments: [{ view: offscreenView, loadOp: "clear", storeOp: "store" }],
});
pass1.end();

// Pass 2: sample the offscreen result while drawing into the canvas.
const pass2 = encoder.beginRenderPass({
  colorAttachments: [{ view: canvasView, loadOp: "clear", storeOp: "store" }],
});
pass2.setBindGroup(0, bindGroupSamplingOffscreen);
pass2.draw(3);
pass2.end();
```

Routing: `webgpu-impl-multipass`.
