# Host-Side Alignment : Verified Examples

WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+.

Every example here satisfies WebGPU validation. The alignment values are
verified against the W3C WebGPU specification (https://www.w3.org/TR/webgpu/).

---

## 1. Correct bytesPerRow padding helper

`bytesPerRow` MUST be a multiple of 256. This helper computes the padded row
stride and the buffer size for any non-block texture format.

```js
const COPY_BYTES_PER_ROW_ALIGNMENT = 256;

function align(value, multiple) {
  return Math.ceil(value / multiple) * multiple;
}

// width/height in texels, bytesPerTexel from the format (RGBA8 = 4)
function planTextureBufferCopy(width, height, bytesPerTexel) {
  const unpaddedBytesPerRow = width * bytesPerTexel;
  const bytesPerRow = align(unpaddedBytesPerRow, COPY_BYTES_PER_ROW_ALIGNMENT);
  const bufferSize = bytesPerRow * height;
  return { unpaddedBytesPerRow, bytesPerRow, bufferSize };
}

// 100x100 RGBA8:
// unpaddedBytesPerRow = 400
// bytesPerRow         = 512   (next multiple of 256)
// bufferSize          = 512 * 100 = 51200 bytes
const plan = planTextureBufferCopy(100, 100, 4);
```

---

## 2. Staging-buffer readback : texture to CPU with padding stripping

The full GPU-to-CPU readback path. The readback buffer is sized with the padded
`bytesPerRow`, the copy uses that same `bytesPerRow`, and the padding is removed
on the CPU after mapping.

```js
async function readTexturePixels(device, texture, width, height) {
  const bytesPerTexel = 4;                       // rgba8unorm
  const { unpaddedBytesPerRow, bytesPerRow, bufferSize } =
    planTextureBufferCopy(width, height, bytesPerTexel);

  // Readback buffer: sized for PADDED rows, never width*height*4.
  const readback = device.createBuffer({
    label: "texture-readback",
    size: bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer: readback, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);

  // mapAsync waits for the GPU; omitting offset/size maps the whole buffer.
  await readback.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(readback.getMappedRange());

  // Strip the per-row padding into a tightly packed result.
  const tight = new Uint8Array(unpaddedBytesPerRow * height);
  for (let row = 0; row < height; row++) {
    const srcStart = row * bytesPerRow;
    tight.set(
      padded.subarray(srcStart, srcStart + unpaddedBytesPerRow),
      row * unpaddedBytesPerRow,
    );
  }

  readback.unmap();                              // detaches `padded`
  return tight;                                  // width*height*4 tight bytes
}
```

---

## 3. Storage-buffer readback : GPU compute output to CPU

A `STORAGE` buffer cannot be mapped. The result is copied into a separate
`COPY_DST | MAP_READ` staging buffer first. The byte count is a multiple of 4,
so no row padding is involved here, but the staging pattern is mandatory.

```js
async function readStorageBuffer(device, storageBuffer, byteLength) {
  // byteLength must be a multiple of 4 for the copy and the mapped view.
  const size = (byteLength + 3) & ~3;

  const staging = device.createBuffer({
    label: "storage-readback",
    size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();
  // copyBufferToBuffer copies `size` bytes; size is a multiple of 4.
  encoder.copyBufferToBuffer(storageBuffer, 0, staging, 0, size);
  device.queue.submit([encoder.finish()]);

  await staging.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  return result;
}
```

---

## 4. Correct dynamic offset : 256-aligned stride per element

A WGSL uniform struct of 192 bytes still needs a 256-byte stride between
consecutive dynamic offsets. The buffer is sized `count * stride`, the
bind-group layout sets `hasDynamicOffset: true`, and each draw passes a
256-aligned offset.

```js
const DYNAMIC_OFFSET_ALIGN = 256;                // minUniformBufferOffsetAlignment

// WGSL struct is 192 bytes; the dynamic-offset stride is rounded up to 256.
const structByteSize = 192;
const stride = align(structByteSize, DYNAMIC_OFFSET_ALIGN);   // -> 256
const objectCount = 8;

const uniformBuffer = device.createBuffer({
  label: "per-object-uniforms",
  size: objectCount * stride,                    // 8 * 256 = 2048 bytes
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});

const bindGroupLayout = device.createBindGroupLayout({
  entries: [{
    binding: 0,
    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
    buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: structByteSize },
  }],
});

const bindGroup = device.createBindGroup({
  layout: bindGroupLayout,
  entries: [{
    binding: 0,
    // The bound range size is the actual struct size, not the stride.
    resource: { buffer: uniformBuffer, offset: 0, size: structByteSize },
  }],
});

// Per draw: offset i*stride is always a multiple of 256.
function drawObject(pass, i) {
  pass.setBindGroup(0, bindGroup, [i * stride]);
  pass.draw(3);
}
```

To exactly target the negotiated alignment instead of the spec default:

```js
const DYNAMIC_OFFSET_ALIGN = device.limits.minUniformBufferOffsetAlignment;
```

---

## 5. Writing per-object data into the 256-strided buffer

When uploading per-object uniform data, write each object's bytes at its strided
offset. The offset is a multiple of 256 (so also a multiple of 4) and the write
size is padded to a multiple of 4.

```js
function uploadObjectUniform(device, uniformBuffer, i, stride, floatData) {
  // floatData: a Float32Array of the object's uniform values.
  // bufferOffset i*stride is a multiple of 256; written byte count must be /4.
  const byteLength = floatData.byteLength;       // Float32Array -> always /4
  device.queue.writeBuffer(uniformBuffer, i * stride, floatData);
  return byteLength;
}
```

---

## 6. mappedAtCreation upload with a multiple-of-4 size

`mappedAtCreation` requires `size` to be a multiple of 4. The buffer is returned
already mapped; write into `getMappedRange()` then `unmap()`.

```js
function createVertexBuffer(device, vertices /* Float32Array */) {
  const rawSize = vertices.byteLength;
  const size = (rawSize + 3) & ~3;               // round up to a multiple of 4

  const buffer = device.createBuffer({
    label: "mesh-vertices",
    size,
    usage: GPUBufferUsage.VERTEX,
    mappedAtCreation: true,
  });

  new Float32Array(buffer.getMappedRange()).set(vertices);
  buffer.unmap();
  return buffer;
}
```

---

## 7. Safe writeBuffer for arbitrary byte data

`queue.writeBuffer` requires `bufferOffset` and the written byte count to each
be a multiple of 4. Pad the source to a 4-byte boundary before writing.

```js
function writeBytesAligned(device, buffer, bufferOffset, data /* Uint8Array */) {
  // bufferOffset must be a multiple of 4.
  if (bufferOffset % 4 !== 0) {
    throw new Error("bufferOffset must be a multiple of 4");
  }
  // Pad the written byte count up to a multiple of 4.
  const paddedLength = (data.byteLength + 3) & ~3;
  const src = paddedLength === data.byteLength
    ? data
    : (() => { const b = new Uint8Array(paddedLength); b.set(data); return b; })();
  device.queue.writeBuffer(buffer, bufferOffset, src);
}
```

## Sources

- W3C WebGPU specification : https://www.w3.org/TR/webgpu/
- W3C WebGPU, buffer mapping : https://www.w3.org/TR/webgpu/#buffer-mapping
- W3C WebGPU, GPUQueue : https://www.w3.org/TR/webgpu/#gpuqueue
- WebGPU Explainer (staging-buffer readback) :
  https://gpuweb.github.io/gpuweb/explainer/
- WebGPU Samples : https://webgpu.github.io/webgpu-samples/
