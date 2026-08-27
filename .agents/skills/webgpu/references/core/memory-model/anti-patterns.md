# Host-Side Alignment : Anti-Patterns

WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+.

Each anti-pattern below shows the WRONG code, WHY it fails, and the CORRECT fix.
Every alignment value is verified against the W3C WebGPU specification
(https://www.w3.org/TR/webgpu/).

---

## AP-1 : Sizing a readback buffer as width * height * 4

WRONG:

```js
// width = 100, height = 100, rgba8unorm
const readback = device.createBuffer({
  size: width * height * 4,                  // 40000 bytes
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
encoder.copyTextureToBuffer(
  { texture },
  { buffer: readback, bytesPerRow: width * 4 }, // 400, NOT a multiple of 256
  { width, height },
);
```

WHY IT FAILS: `bytesPerRow` MUST be a multiple of 256. `width * 4` is 400, which
is not a multiple of 256, so `copyTextureToBuffer` fails validation outright. A
second, compounding error: even with a valid `bytesPerRow` of 512, the GPU lays
out 512 padded bytes per row, so the destination buffer needs `512 * 100 =
51200` bytes. A buffer sized `40000` is too small and the copy is rejected.

CORRECT:

```js
const unpaddedBytesPerRow = width * 4;                          // 400
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256; // 512
const readback = device.createBuffer({
  size: bytesPerRow * height,                                   // 51200
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
encoder.copyTextureToBuffer(
  { texture },
  { buffer: readback, bytesPerRow, rowsPerImage: height },
  { width, height },
);
// After mapping, strip the 112 pad bytes per row before using the pixels.
```

---

## AP-2 : Computing dynamic offsets as i * structSize

WRONG:

```js
// WGSL uniform struct is 192 bytes.
const structSize = 192;
const buffer = device.createBuffer({
  size: objectCount * structSize,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
// ...
pass.setBindGroup(0, bindGroup, [i * structSize]);  // 0, 192, 384, 576 ...
```

WHY IT FAILS: a dynamic uniform offset MUST be a multiple of
`minUniformBufferOffsetAlignment`, whose spec default is 256. The offsets
`0, 192, 384, 576` are not multiples of 256, so `setBindGroup` rejects every
draw after the first. The WGSL struct size (192) and the dynamic-offset stride
are different numbers: the stride MUST be rounded up to 256.

CORRECT:

```js
const structSize = 192;
const ALIGN = 256;                              // minUniformBufferOffsetAlignment
const stride = Math.ceil(structSize / ALIGN) * ALIGN;  // 256
const buffer = device.createBuffer({
  size: objectCount * stride,                   // objectCount * 256
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
// ...
pass.setBindGroup(0, bindGroup, [i * stride]);  // 0, 256, 512, 768 ...
```

---

## AP-3 : Non-multiple-of-4 writeBuffer size or offset

WRONG:

```js
const data = new Uint8Array([1, 2, 3]);         // 3 bytes
device.queue.writeBuffer(buffer, 0, data);       // written size 3, not /4

const tail = new Uint8Array([9, 9]);             // 2 bytes
device.queue.writeBuffer(buffer, 6, tail);       // offset 6 not /4, size 2 not /4
```

WHY IT FAILS: `queue.writeBuffer` requires `bufferOffset` and the written byte
count to each be a multiple of 4. A 3-byte write, a 2-byte write, and an offset
of 6 all fail validation; the buffer is never updated and the call throws.

CORRECT:

```js
function writeAligned(buffer, offset, bytes) {
  if (offset % 4 !== 0) throw new Error("offset must be a multiple of 4");
  const padded = (bytes.byteLength + 3) & ~3;
  const src = new Uint8Array(padded);
  src.set(bytes);
  device.queue.writeBuffer(buffer, offset, src);  // offset /4, size /4
}
writeAligned(buffer, 0, new Uint8Array([1, 2, 3]));   // writes 4 bytes
writeAligned(buffer, 8, new Uint8Array([9, 9]));      // offset 8, writes 4 bytes
```

---

## AP-4 : Assuming 256-byte alignment can be lower on some adapter

WRONG:

```js
// "This high-end discrete GPU surely allows 64-byte uniform offsets."
const stride = 64;
pass.setBindGroup(0, bindGroup, [i * stride]);   // 0, 64, 128, 192 ...
```

WHY IT FAILS: `minUniformBufferOffsetAlignment` and
`minStorageBufferOffsetAlignment` are `minimum`-class limits. The spec default
is 256, and adapters do NOT report a value below 256. Hardcoding 64 produces
offsets that are not multiples of the real alignment, and `setBindGroup` rejects
them. Hardware capability does NOT lower this limit; it is a portability floor.
The 256-byte `bytesPerRow` rule is likewise fixed and not adapter-dependent.

CORRECT:

```js
// Treat 256 as the alignment everywhere.
const ALIGN = 256;
const stride = Math.ceil(structSize / ALIGN) * ALIGN;
// To target the negotiated value exactly, read it from the device:
const exact = device.limits.minUniformBufferOffsetAlignment;  // >= 256
```

---

## AP-5 : Misaligned mapAsync or getMappedRange sub-range

WRONG:

```js
// Map a 100-byte sub-range starting at byte 4.
await buffer.mapAsync(GPUMapMode.READ, 4, 100);  // offset 4 not /8
const view = buffer.getMappedRange(4, 100);      // offset 4 not /8
```

WHY IT FAILS: `mapAsync` and `getMappedRange` require `offset` to be a multiple
of 8 and `size` a multiple of 4. An offset of 4 is not a multiple of 8, so both
calls fail validation.

CORRECT:

```js
// Map the whole buffer (always alignment-safe), or align the sub-range.
await buffer.mapAsync(GPUMapMode.READ);                 // whole buffer
const all = buffer.getMappedRange();

// Or an aligned sub-range: offset multiple of 8, size multiple of 4.
await buffer.mapAsync(GPUMapMode.READ, 8, 104);
const sub = buffer.getMappedRange(8, 104);
```

---

## AP-6 : Using a mapped ArrayBuffer after unmap

WRONG:

```js
await readback.mapAsync(GPUMapMode.READ);
const mapped = new Uint8Array(readback.getMappedRange());
readback.unmap();
const first = mapped[0];                          // throws: detached buffer
```

WHY IT FAILS: `unmap()` detaches every `ArrayBuffer` returned by
`getMappedRange`. A `TypedArray` view over a detached buffer has length 0 and
any access throws. The data MUST be copied out before `unmap()`.

CORRECT:

```js
await readback.mapAsync(GPUMapMode.READ);
const mapped = new Uint8Array(readback.getMappedRange());
const copy = mapped.slice(0);                     // own the data first
readback.unmap();
const first = copy[0];                            // safe
```

---

## AP-7 : Omitting bytesPerRow on a multi-row copy

WRONG:

```js
encoder.copyTextureToBuffer(
  { texture },
  { buffer: readback },                           // no bytesPerRow
  { width, height },                              // height > 1
);
```

WHY IT FAILS: `bytesPerRow` is required whenever the copy spans more than one
texel row. Without it WebGPU cannot place row 1, row 2, and so on, so the copy
fails validation. `bytesPerRow` may only be omitted for a strictly single-row
copy.

CORRECT:

```js
const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
encoder.copyTextureToBuffer(
  { texture },
  { buffer: readback, bytesPerRow, rowsPerImage: height },
  { width, height },
);
```

## Sources

- W3C WebGPU specification : https://www.w3.org/TR/webgpu/
- W3C WebGPU, buffer mapping : https://www.w3.org/TR/webgpu/#buffer-mapping
- W3C WebGPU, limits : https://www.w3.org/TR/webgpu/#limits
- MDN GPUCommandEncoder.copyTextureToBuffer :
  https://developer.mozilla.org/en-US/docs/Web/API/GPUCommandEncoder
