# Examples: WebGPU Performance

Working, verified code for the optimization patterns in this skill. Every API name is
verified against the W3C WebGPU specification, MDN, and the toji.dev render-bundle page.
Targets WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## Render Bundle: Encode Once, Replay Every Frame

A static scene encoded into one bundle at load time, replayed unchanged per frame.
Per-object transforms still update through the shared uniform buffer.

```js
// ---- Load time: build the bundle once ----
const presentationFormat = navigator.gpu.getPreferredCanvasFormat();

const bundleEncoder = device.createRenderBundleEncoder({
  label: "static-scene-bundle",
  colorFormats: [presentationFormat],
  depthStencilFormat: "depth24plus",
  sampleCount: 1,
});

// Every bundle MUST set its own state; it inherits nothing from the render pass.
bundleEncoder.setPipeline(scenePipeline);
for (let i = 0; i < staticObjects.length; i++) {
  const obj = staticObjects[i];
  // Dynamic offset selects this object's slice of the shared uniform buffer.
  bundleEncoder.setBindGroup(0, sharedBindGroup, [i * 256]);
  bundleEncoder.setVertexBuffer(0, obj.vertexBuffer);
  bundleEncoder.setIndexBuffer(obj.indexBuffer, "uint32");
  bundleEncoder.drawIndexed(obj.indexCount);
}
const sceneBundle = bundleEncoder.finish();

// ---- Frame loop: update buffers, replay the same bundle ----
function frame() {
  // Per-object transforms change every frame; the bundle stays valid.
  for (let i = 0; i < staticObjects.length; i++) {
    device.queue.writeBuffer(uniformBuffer, i * 256, staticObjects[i].computeMatrix());
  }

  const encoder = device.createCommandEncoder({ label: "frame-encoder" });
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
    depthStencilAttachment: {
      view: depthView,
      depthLoadOp: "clear",
      depthStoreOp: "store",
      depthClearValue: 1.0,
    },
  });

  // One call replays the whole static scene with minimal CPU cost.
  pass.executeBundles([sceneBundle]);

  pass.end();
  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

State-reset note: after `executeBundles` returns, the render pass has no pipeline or
bind group set. Any direct draw after the bundle MUST call `setPipeline` and
`setBindGroup` again before drawing.

## Timestamp-Query Profiling

Measure the real GPU duration of a render pass. The `timestamp-query` feature is gated.

```js
// ---- Device creation: gate the feature ----
const adapter = await navigator.gpu.requestAdapter();
const hasTimestamp = adapter.features.has("timestamp-query");
const device = await adapter.requestDevice({
  label: "profiling-device",
  requiredFeatures: hasTimestamp ? ["timestamp-query"] : [],
});

// ---- Load time: create the query set and buffers ----
let querySet, resolveBuffer, readBuffer;
if (hasTimestamp) {
  querySet = device.createQuerySet({
    label: "frame-timestamps",
    type: "timestamp",
    count: 2, // slot 0 = pass start, slot 1 = pass end
  });
  // 2 timestamps, each a u64 = 8 bytes.
  resolveBuffer = device.createBuffer({
    label: "timestamp-resolve",
    size: 2 * 8,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });
  readBuffer = device.createBuffer({
    label: "timestamp-read",
    size: 2 * 8,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
}

// ---- Frame loop: attach timestampWrites, resolve, read ----
async function frame() {
  const encoder = device.createCommandEncoder({ label: "profiled-frame" });

  const passDescriptor = {
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  };
  // Only attach timestampWrites when the feature is available.
  if (hasTimestamp) {
    passDescriptor.timestampWrites = {
      querySet,
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
    };
  }

  const pass = encoder.beginRenderPass(passDescriptor);
  pass.setPipeline(scenePipeline);
  pass.setBindGroup(0, sceneBindGroup);
  pass.draw(3);
  pass.end();

  if (hasTimestamp && readBuffer.mapState === "unmapped") {
    encoder.resolveQuerySet(querySet, 0, 2, resolveBuffer, 0);
    encoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, 2 * 8);
  }

  device.queue.submit([encoder.finish()]);

  // Read the previous frame's result without stalling: only map when free.
  if (hasTimestamp && readBuffer.mapState === "unmapped") {
    readBuffer.mapAsync(GPUMapMode.READ).then(() => {
      const times = new BigUint64Array(readBuffer.getMappedRange().slice(0));
      const durationNs = Number(times[1] - times[0]);
      console.log(`GPU render pass: ${(durationNs / 1e6).toFixed(3)} ms`);
      readBuffer.unmap();
    });
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

The `mapAsync` here is NOT awaited inside the render path. The `.then` callback reads a
late result without stalling the frame. See `webgpu-impl-async-patterns`.

## Dynamic-Offset Sub-Allocation

Pack many per-object uniform structs into one buffer; select one per draw with a
dynamic offset. Avoids one `GPUBuffer` per object.

```js
const OBJECT_COUNT = 64;
// Per-object struct is 192 bytes of data, but the stride MUST be padded to 256
// (minUniformBufferOffsetAlignment) so each dynamic offset is 256-aligned.
const STRIDE = 256;

const uniformBuffer = device.createBuffer({
  label: "packed-object-uniforms",
  size: OBJECT_COUNT * STRIDE,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});

// The layout entry MUST declare hasDynamicOffset.
const bindGroupLayout = device.createBindGroupLayout({
  label: "object-bgl",
  entries: [{
    binding: 0,
    visibility: GPUShaderStage.VERTEX,
    buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 192 },
  }],
});

// One bind group covers all objects; the offset selects the slice.
const bindGroup = device.createBindGroup({
  label: "object-bg",
  layout: bindGroupLayout,
  entries: [{ binding: 0, resource: { buffer: uniformBuffer, size: 192 } }],
});

// Upload each object's data into its 256-byte slot.
function uploadObject(index, float32Data /* length 48 = 192 bytes */) {
  device.queue.writeBuffer(uniformBuffer, index * STRIDE, float32Data);
}

// Draw: the dynamic offset MUST be a multiple of 256.
function drawObjects(pass) {
  pass.setPipeline(objectPipeline);
  for (let i = 0; i < OBJECT_COUNT; i++) {
    pass.setBindGroup(0, bindGroup, [i * STRIDE]);
    pass.draw(objectVertexCount);
  }
}
```

## State-Sorted Draw Submission

Sort the draw list by pipeline, then bind group, to collapse redundant state switches.

```js
// drawList items: { pipeline, pipelineId, bindGroup, bindGroupId, vertexBuffer, count }
drawList.sort((a, b) =>
  a.pipelineId - b.pipelineId || a.bindGroupId - b.bindGroupId);

let lastPipelineId = -1;
let lastBindGroupId = -1;
for (const d of drawList) {
  if (d.pipelineId !== lastPipelineId) {
    pass.setPipeline(d.pipeline);
    lastPipelineId = d.pipelineId;
    lastBindGroupId = -1; // pipeline change can invalidate bind-group assumptions
  }
  if (d.bindGroupId !== lastBindGroupId) {
    pass.setBindGroup(0, d.bindGroup);
    lastBindGroupId = d.bindGroupId;
  }
  pass.setVertexBuffer(0, d.vertexBuffer);
  pass.draw(d.count);
}
```

## Portable Workgroup Size in WGSL

A compute shader sized for portability across 32-wide and 64-wide hardware.

```wgsl
// Product is 64: a multiple of both 32 and 64, under maxComputeInvocationsPerWorkgroup.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&data)) {
    return; // guard the tail when itemCount is not a multiple of 64
  }
  data[i] = data[i] * 2.0;
}
```

```js
// Host: dispatch ceil(itemCount / 64) workgroups.
const WORKGROUP_SIZE = 64;
const workgroupCount = Math.ceil(itemCount / WORKGROUP_SIZE);
pass.setPipeline(computePipeline);
pass.setBindGroup(0, computeBindGroup);
pass.dispatchWorkgroups(workgroupCount);
```

## Verified Sources

- https://www.w3.org/TR/webgpu/ — render bundle encoder, query sets, timestampWrites,
  resolveQuerySet, dynamic offsets, buffer usage flags.
- https://developer.mozilla.org/en-US/docs/Web/API/GPURenderBundleEncoder — encoder
  methods, descriptor, executeBundles.
- https://toji.dev/webgpu-best-practices/render-bundles.html — encode-once-replay
  pattern, state reset (cross-check only).
- docs/research/vooronderzoek-webgpu.md — PART C section 5, PART A section 2, PART C
  section 11 (timestamp profiling and async readback).
