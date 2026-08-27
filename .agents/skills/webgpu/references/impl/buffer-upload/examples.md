# Examples: Buffer Upload and Readback

Working code for WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). Every
example is verified against the W3C WebGPU spec, MDN, and toji.dev WebGPU best
practices. Each example assumes a valid `device` from `adapter.requestDevice()`.

## Example 1: writeBuffer upload (the default path)

```js
// Upload a uniform block every frame with the safe default path.
const uniformData = new Float32Array(16);          // a 4x4 matrix, 64 bytes
const uniformBuffer = device.createBuffer({
  label: "camera-uniforms",
  size: uniformData.byteLength,                     // 64, a multiple of 4
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});

function uploadUniforms(matrix) {
  uniformData.set(matrix);
  device.queue.writeBuffer(uniformBuffer, 0, uniformData);   // bufferOffset 0
}
```

`writeBuffer` accepts an `ArrayBuffer`, a `TypedArray`, or a `DataView`. The
destination MUST carry `COPY_DST`. `bufferOffset` and the byte size MUST both be
multiples of 4 (64 satisfies this).

## Example 2: mappedAtCreation for initial vertex data

```js
// Two triangles, position (x, y) + color (r, g, b) per vertex.
const vertices = new Float32Array([
  -0.5, -0.5,  1, 0, 0,
   0.5, -0.5,  0, 1, 0,
   0.0,  0.5,  0, 0, 1,
]);

const vertexBuffer = device.createBuffer({
  label: "triangle-vertices",
  size: vertices.byteLength,                        // 60, a multiple of 4
  usage: GPUBufferUsage.VERTEX,                     // no COPY_DST: not needed here
  mappedAtCreation: true,
});

new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
vertexBuffer.unmap();                               // buffer is now GPU-owned
// vertexBuffer.getMappedRange() would now throw: the range is detached
```

`mappedAtCreation` skips `COPY_DST` and an internal copy. `size` MUST be a multiple
of 4.

## Example 3: staging-buffer ring for a large per-frame upload

```js
// A 2-buffer ring for a large buffer rewritten every frame.
// ONLY use this when writeBuffer profiles as a bottleneck.
const RING_SIZE = 2;
const UPLOAD_BYTES = 4 * 1024 * 1024;               // 4 MiB per frame

const destination = device.createBuffer({
  label: "frame-storage",
  size: UPLOAD_BYTES,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});

const freeStaging = [];
for (let i = 0; i < RING_SIZE; i++) {
  freeStaging.push(device.createBuffer({
    label: `staging-${i}`,
    size: UPLOAD_BYTES,
    usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
    mappedAtCreation: true,                         // first use needs no mapAsync
  }));
}

function uploadFrame(frameData) {                   // frameData: Float32Array
  if (freeStaging.length === 0) {
    // No slot ready this frame: fall back to writeBuffer rather than stalling.
    device.queue.writeBuffer(destination, 0, frameData);
    return;
  }
  const staging = freeStaging.pop();
  new Float32Array(staging.getMappedRange()).set(frameData);
  staging.unmap();

  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(staging, 0, destination, 0, UPLOAD_BYTES);
  device.queue.submit([encoder.finish()]);

  // Re-map for a future frame. Do NOT await: the slot returns asynchronously.
  staging.mapAsync(GPUMapMode.WRITE).then(() => freeStaging.push(staging));
}
```

The ring keeps each staging buffer single-mapped: a slot is only re-`mapAsync`-ed
after its `unmap()`, and only returns to `freeStaging` once the map promise
resolves.

## Example 4: storage buffer readback (GPU compute result to CPU)

```js
// Read back a storage buffer written by a compute pass.
async function readStorageBuffer(storageBuffer, byteLength) {
  const readback = device.createBuffer({
    label: "compute-readback",
    size: byteLength,                               // multiple of 4
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(storageBuffer, 0, readback, 0, byteLength);
  device.queue.submit([encoder.finish()]);

  await readback.mapAsync(GPUMapMode.READ);         // resolves after the copy finishes
  const result = new Float32Array(readback.getMappedRange()).slice();  // copy OUT
  readback.unmap();                                 // mapped range detaches here
  return result;                                    // safe: it is a detached copy
}
```

The storage buffer itself cannot be mapped: `MAP_READ` only combines with
`COPY_DST`. The `.slice()` produces an independent copy that survives `unmap()`.

## Example 5: full GPU to CPU texture readback with 256-byte padding

```js
// Download a rendered texture to a tight RGBA8 byte array.
// width = 100 -> width*4 = 400 bytes/row, NOT a multiple of 256.
async function readTexturePixels(texture, width, height) {
  const bytesPerPixel = 4;                          // rgba8unorm
  const unpaddedBytesPerRow = width * bytesPerPixel;                 // 400
  const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;  // 512

  const readback = device.createBuffer({
    label: "texture-readback",
    size: paddedBytesPerRow * height,               // 512 * height, NOT 400 * height
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture },                                    // GPUTexelCopyTextureInfo
    { buffer: readback, bytesPerRow: paddedBytesPerRow, rowsPerImage: height },
    { width, height },                              // copySize
  );
  device.queue.submit([encoder.finish()]);

  await readback.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(readback.getMappedRange());

  // Strip the per-row padding into a contiguous buffer.
  const tight = new Uint8Array(unpaddedBytesPerRow * height);
  for (let y = 0; y < height; y++) {
    const srcStart = y * paddedBytesPerRow;
    tight.set(
      padded.subarray(srcStart, srcStart + unpaddedBytesPerRow),
      y * unpaddedBytesPerRow,
    );
  }
  readback.unmap();                                 // copy was done BEFORE this
  return tight;                                     // width*height*4 contiguous bytes
}
```

If `width * 4` were already a multiple of 256, `paddedBytesPerRow` would equal
`unpaddedBytesPerRow` and the loop would be a straight copy. The code is correct in
both cases, so ALWAYS pad rather than special-casing.

Use the result to build an `ImageData`:

```js
const pixels = await readTexturePixels(texture, 100, 100);
const imageData = new ImageData(new Uint8ClampedArray(pixels.buffer), 100, 100);
```

## Example 6: confirming an unrelated submission finished

```js
// Render to an offscreen texture, then read a DIFFERENT diagnostic buffer.
device.queue.submit([renderEncoder.finish()]);
await device.queue.onSubmittedWorkDone();           // all prior work is now done

const encoder = device.createCommandEncoder();
encoder.copyBufferToBuffer(diagnosticBuffer, 0, readback, 0, byteLength);
device.queue.submit([encoder.finish()]);
await readback.mapAsync(GPUMapMode.READ);
const stats = new Uint32Array(readback.getMappedRange()).slice();
readback.unmap();
```

When the copy and the `mapAsync` target the same buffer, the `mapAsync` promise
already gates correctness and the explicit `onSubmittedWorkDone` is not required.

## Sources

- W3C WebGPU spec : https://www.w3.org/TR/webgpu/
- MDN GPUQueue.writeBuffer : https://developer.mozilla.org/en-US/docs/Web/API/GPUQueue/writeBuffer
- MDN GPUCommandEncoder.copyTextureToBuffer : https://developer.mozilla.org/en-US/docs/Web/API/GPUCommandEncoder/copyBufferToTexture
- toji.dev WebGPU buffer uploads : https://toji.dev/webgpu-best-practices/buffer-uploads.html
- WebGPU Samples : https://webgpu.github.io/webgpu-samples/
