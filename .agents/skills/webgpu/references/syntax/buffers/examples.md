# WebGPU Buffers: Verified Examples

WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+.

Every example below is verified against the W3C WebGPU specification and the
vooronderzoek (PART A section 4 Buffers, PART C section 4 Async Patterns). Each
example assumes a `device` and `queue` already obtained via
`navigator.gpu.requestAdapter()` / `adapter.requestDevice()`.

## Example 1: Vertex buffer via mappedAtCreation

`mappedAtCreation: true` is the idiomatic way to upload static initial data. The
buffer is returned mapped, so `getMappedRange` works immediately and NO
`COPY_DST` flag is needed. The `size` MUST be a multiple of 4.

```js
// A single triangle: three 2D positions, six f32 values, 24 bytes.
const vertexData = new Float32Array([
  0.0,  0.5,   // top
  -0.5, -0.5,  // bottom-left
  0.5, -0.5,   // bottom-right
]);

const vertexBuffer = device.createBuffer({
  label: "triangle-vertex-buffer",
  size: vertexData.byteLength,                 // 24, a multiple of 4
  usage: GPUBufferUsage.VERTEX,                // VERTEX only; no COPY_DST
  mappedAtCreation: true,
});

// The buffer starts in mapState "mapped". Write the data, then unmap.
new Float32Array(vertexBuffer.getMappedRange()).set(vertexData);
vertexBuffer.unmap();                          // hands the buffer to the GPU

// Later, inside a render pass:
// passEncoder.setVertexBuffer(0, vertexBuffer);
// passEncoder.draw(3);
```

The same pattern uploads an index buffer; swap `GPUBufferUsage.VERTEX` for
`GPUBufferUsage.INDEX` and use a `Uint16Array` or `Uint32Array`.

## Example 2: Uniform buffer with queue.writeBuffer

A uniform buffer that changes every frame uses `queue.writeBuffer`. The buffer
MUST include `COPY_DST`. No mapping is involved, so there is no `mapState` to
manage. NEVER add `MAP_WRITE` for this case.

```js
// One mat4x4<f32> is 16 floats = 64 bytes.
const uniformBuffer = device.createBuffer({
  label: "camera-uniform-buffer",
  size: 64,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});

function frame(viewProjectionMatrix /* Float32Array, 16 elements */) {
  // bufferOffset 0 and the 64-byte write are both multiples of 4.
  queue.writeBuffer(uniformBuffer, 0, viewProjectionMatrix);
  // ... encode the render pass that binds uniformBuffer ...
}
```

`writeBuffer` snapshots the data immediately, so `viewProjectionMatrix` can be
mutated again right after the call.

### Sub-range write with dataOffset and size

`dataOffset` and `size` count in TypedArray elements when `data` is a typed
array. This uploads only the second half of a source array.

```js
const source = new Float32Array(32);          // 128 bytes total
// Write 16 elements starting at source element 16, into buffer offset 0.
queue.writeBuffer(uniformBuffer, 0, source, 16, 16);
```

## Example 3: GPU-to-CPU readback via mapAsync

A `STORAGE` buffer CANNOT be mapped. To read GPU output, copy it into a separate
staging buffer created with `COPY_DST | MAP_READ`, submit the copy, then map the
staging buffer. The full end-to-end workflow lives in
`webgpu-impl-buffer-upload`; this is the buffer-side mechanics.

```js
// `storageBuffer` was written by a compute pass. It has STORAGE | COPY_SRC.
const byteLength = storageBuffer.size;        // a multiple of 4

// MAP_READ is legal ONLY with COPY_DST. This is the only valid readback combo.
const stagingBuffer = device.createBuffer({
  label: "readback-staging-buffer",
  size: byteLength,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});

// Copy storage -> staging on the GPU timeline.
const encoder = device.createCommandEncoder({ label: "readback-encoder" });
encoder.copyBufferToBuffer(storageBuffer, 0, stagingBuffer, 0, byteLength);
queue.submit([encoder.finish()]);

// mapAsync transitions stagingBuffer: unmapped -> pending -> mapped.
// The promise resolves only after the GPU finishes the copy above.
await stagingBuffer.mapAsync(GPUMapMode.READ);

// getMappedRange is valid now that mapState === "mapped".
const mapped = stagingBuffer.getMappedRange();

// ALWAYS copy the data out BEFORE unmap; unmap detaches `mapped`.
const result = new Float32Array(mapped.slice(0));

stagingBuffer.unmap();                         // `mapped` is now detached
// `result` survives unmap and holds the GPU output.
console.log(result);
```

## Example 4: Guard mapAsync with the mapState lifecycle

Calling `mapAsync` on a buffer that is already `"pending"` or `"mapped"` rejects
with "buffer is already mapped". Reading `mapState` guarantees the buffer is
`"unmapped"` before the call. ALWAYS pair every `mapAsync` with exactly one
`unmap`.

```js
async function readBuffer(buffer) {
  if (buffer.mapState !== "unmapped") {
    throw new Error("readBuffer: buffer is not unmapped, cannot mapAsync");
  }
  await buffer.mapAsync(GPUMapMode.READ);      // unmapped -> pending -> mapped
  const copy = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();                              // mapped -> unmapped
  return copy;
}
```

## Example 5: Free GPU memory with destroy

`destroy()` releases the GPU memory. Use it when a buffer is no longer needed,
for example a one-shot staging buffer. The buffer becomes unusable afterwards.

```js
const result = new Float32Array(stagingBuffer.getMappedRange().slice(0));
stagingBuffer.unmap();
stagingBuffer.destroy();                       // staging buffer no longer needed
```

## Sources

- W3C WebGPU spec, buffer mapping: https://www.w3.org/TR/webgpu/#buffer-mapping
- W3C WebGPU spec, GPUQueue: https://www.w3.org/TR/webgpu/#gpuqueue
- MDN GPUDevice.createBuffer: https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createBuffer
- WebGPU Samples: https://webgpu.github.io/webgpu-samples/
- vooronderzoek-webgpu.md PART A section 4, PART C section 4
