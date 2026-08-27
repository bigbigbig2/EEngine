# Command Encoder Examples

All examples target WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+) and
are verified against the W3C WebGPU specification and MDN. They assume `device`
and `context` are already initialized.

## Example 1: Encode a render pass and submit

A fresh encoder per frame, one render pass, the pass ended before `finish()`, and
a single-use command buffer submitted to the queue.

```js
function renderFrame(device, context, pipeline, vertexBuffer) {
  const encoder = device.createCommandEncoder({ label: "frame-encoder" });

  const pass = encoder.beginRenderPass({
    label: "main-pass",
    colorAttachments: [
      {
        view: context.getCurrentTexture().createView(), // fresh view each frame
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });

  pass.setPipeline(pipeline);
  pass.setVertexBuffer(0, vertexBuffer);
  pass.draw(3);
  pass.end(); // mandatory before finish()

  const commandBuffer = encoder.finish();
  device.queue.submit([commandBuffer]); // commandBuffer is now consumed
}
```

## Example 2: Encode a compute pass

A compute pass dispatches workgroups, then ends. The encoder produces one command
buffer.

```js
function runCompute(device, computePipeline, bindGroup, workgroupCount) {
  const encoder = device.createCommandEncoder({ label: "compute-encoder" });

  const pass = encoder.beginComputePass({ label: "compute-pass" });
  pass.setPipeline(computePipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(workgroupCount);
  pass.end();

  device.queue.submit([encoder.finish()]);
}
```

## Example 3: Buffer-to-buffer copy with CPU readback

A storage buffer cannot be mapped, so its result is copied into a separate
`COPY_DST | MAP_READ` staging buffer. The copy command is recorded on the encoder,
outside any pass.

```js
async function readBackStorageBuffer(device, storageBuffer, byteSize) {
  // byteSize must be a multiple of 4 for copyBufferToBuffer.
  const stagingBuffer = device.createBuffer({
    label: "readback-staging",
    size: byteSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder({ label: "readback-encoder" });
  // Recorded directly on the encoder, NOT inside a pass.
  encoder.copyBufferToBuffer(storageBuffer, 0, stagingBuffer, 0, byteSize);
  device.queue.submit([encoder.finish()]);

  await device.queue.onSubmittedWorkDone(); // safe here: not a render loop
  await stagingBuffer.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(stagingBuffer.getMappedRange().slice(0));
  stagingBuffer.unmap();
  return result;
}
```

## Example 4: Timestamp query setup and resolve

The `timestamp-query` feature is optional and MUST be gated. Two timestamps wrap
a pass via `timestampWrites`; `resolveQuerySet` writes the 64-bit results into a
`QUERY_RESOLVE` buffer, which is then copied into a mappable buffer.

```js
// Step 1: request the feature only if the adapter exposes it.
const adapter = await navigator.gpu.requestAdapter();
const canTimestamp = adapter.features.has("timestamp-query");
const device = await adapter.requestDevice({
  requiredFeatures: canTimestamp ? ["timestamp-query"] : [],
});

if (canTimestamp) {
  // Step 2: create a timestamp query set (count <= 4096).
  const querySet = device.createQuerySet({
    label: "frame-timing",
    type: "timestamp",
    count: 2,
  });

  // Step 3: a QUERY_RESOLVE buffer; 8 bytes per query.
  const resolveBuffer = device.createBuffer({
    label: "timestamp-resolve",
    size: querySet.count * 8,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });

  // Step 4: a separate mappable buffer; QUERY_RESOLVE cannot pair with MAP_READ.
  const readBuffer = device.createBuffer({
    label: "timestamp-readback",
    size: resolveBuffer.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder({ label: "timed-encoder" });

  // Step 5: timestampWrites wraps the pass with begin/end timestamps.
  const pass = encoder.beginComputePass({
    label: "timed-compute",
    timestampWrites: {
      querySet,
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
    },
  });
  // ... pass.setPipeline / setBindGroup / dispatchWorkgroups ...
  pass.end();

  // Step 6: resolve queries into the QUERY_RESOLVE buffer.
  // destinationOffset (0) must be a multiple of 256.
  encoder.resolveQuerySet(querySet, 0, querySet.count, resolveBuffer, 0);
  encoder.copyBufferToBuffer(resolveBuffer, readBuffer);
  device.queue.submit([encoder.finish()]);

  // Step 7: read the nanosecond timestamps as a BigUint64Array.
  await readBuffer.mapAsync(GPUMapMode.READ);
  const times = new BigUint64Array(readBuffer.getMappedRange().slice(0));
  const elapsedNs = times[1] - times[0];
  readBuffer.unmap();
  console.log(`GPU pass: ${Number(elapsedNs) / 1e6} ms`);
}
```

## Example 5: Debug groups around encoded work

`pushDebugGroup` and `popDebugGroup` MUST be balanced. The labels show up in GPU
frame captures.

```js
const encoder = device.createCommandEncoder({ label: "labelled-encoder" });

encoder.pushDebugGroup("shadow-phase");
const shadowPass = encoder.beginRenderPass(shadowPassDescriptor);
shadowPass.insertDebugMarker("draw-occluders");
// ... draws ...
shadowPass.end();
encoder.popDebugGroup(); // balances the push above

device.queue.submit([encoder.finish()]);
```
