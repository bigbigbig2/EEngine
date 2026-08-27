# WebGPU Memory Model and Alignment

Compute host-side buffer sizes, copy offsets, `bytesPerRow`, and dynamic
bind-group offsets that satisfy WebGPU validation on the first call.

## Quick Reference

WebGPU 1.0-stable baseline: Chrome 113+, Safari 26+, Firefox 141+.

WebGPU rejects every misaligned size and offset at validation time. There is NO
silent rounding. ALWAYS compute aligned values on the host before the API call.

| Rule | Constraint | Affected API |
|------|-----------|--------------|
| Buffer size, mappedAtCreation | `size` multiple of 4 | `device.createBuffer({ size, mappedAtCreation: true })` |
| writeBuffer offset | `bufferOffset` multiple of 4 | `queue.writeBuffer(buffer, bufferOffset, data, ...)` |
| writeBuffer size | written `size` multiple of 4 | `queue.writeBuffer(buffer, ..., data, dataOffset, size)` |
| mapAsync offset | `offset` multiple of 8 | `buffer.mapAsync(mode, offset, size)` |
| mapAsync size | `size` multiple of 4 | `buffer.mapAsync(mode, offset, size)` |
| getMappedRange offset | `offset` multiple of 8 | `buffer.getMappedRange(offset, size)` |
| getMappedRange size | `size` multiple of 4 | `buffer.getMappedRange(offset, size)` |
| Dynamic uniform offset | multiple of `minUniformBufferOffsetAlignment` (256) | `pass.setBindGroup(i, group, [offsets])` |
| Dynamic storage offset | multiple of `minStorageBufferOffsetAlignment` (256) | `pass.setBindGroup(i, group, [offsets])` |
| bytesPerRow | multiple of 256 | `copyBufferToTexture`, `copyTextureToBuffer`, `queue.writeTexture` |
| Copy origin | `origin.x` / `origin.y` multiple of the format texel-block size | all texture copies |

`minUniformBufferOffsetAlignment` and `minStorageBufferOffsetAlignment` are
`minimum`-class limits: an adapter reports 256 and NEVER lower. The 256-byte
`bytesPerRow` rule is fixed by the spec and NEVER varies by adapter.

This skill is host-side alignment only. WGSL struct field layout (the `vec3`
16-byte trap, `@align`, `@size`) belongs to `webgpu-wgsl-memory-layout`.

## Decision Tree

```
Computing bytesPerRow for a buffer<->texture copy?
├── unpaddedBytesPerRow = width * bytesPerTexel
│   (RGBA8 = 4, RGBA16F = 8, R8 = 1, BC1 block = 8 per 4x4 block)
├── unpaddedBytesPerRow already a multiple of 256?
│   └── bytesPerRow = unpaddedBytesPerRow. No padding needed.
└── not a multiple of 256?
    ├── bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256
    ├── buffer size = bytesPerRow * height   (NOT width * height * 4)
    └── after readback: copy each row's first unpaddedBytesPerRow bytes,
        skip the trailing pad bytes per row.

Computing a dynamic bind-group offset for element i?
├── align = 256  (minUniform/minStorageBufferOffsetAlignment)
├── stride = Math.ceil(structByteSize / align) * align
│   (a 192-byte struct still needs a 256-byte stride)
├── offset[i] = i * stride        <- ALWAYS use stride, NEVER structByteSize
└── total buffer size = numElements * stride

Sizing or offsetting any other buffer operation?
├── createBuffer with mappedAtCreation -> size multiple of 4
├── writeBuffer -> bufferOffset and size multiple of 4
└── mapAsync / getMappedRange -> offset multiple of 8, size multiple of 4
```

## Core Patterns

### Pattern 1: ALWAYS round bytesPerRow up to a multiple of 256

A buffer-texture copy requires `bytesPerRow` to be a multiple of 256. ALWAYS
round the unpadded row width up; NEVER pass `width * bytesPerTexel` directly
unless it already divides 256.

```js
const ALIGN = 256;
const unpadded = width * 4;                       // RGBA8: 4 bytes/texel
const bytesPerRow = Math.ceil(unpadded / ALIGN) * ALIGN;
// 100x100 RGBA8: unpadded 400 -> bytesPerRow 512 (112 pad bytes/row)
```

### Pattern 2: ALWAYS size a readback buffer as bytesPerRow * height

The readback buffer holds padded rows, NOT tight rows. NEVER size it as
`width * height * bytesPerTexel`; that buffer is too small once `bytesPerRow`
includes padding, and the copy fails validation.

```js
const bufferSize = bytesPerRow * height;          // padded, correct
const readback = device.createBuffer({
  size: bufferSize,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
```

### Pattern 3: ALWAYS strip row padding on the CPU after mapping

After `mapAsync`, the mapped `ArrayBuffer` still contains the pad bytes. ALWAYS
copy `unpaddedBytesPerRow` bytes per row into a tightly-packed output array.

```js
await readback.mapAsync(GPUMapMode.READ);
const padded = new Uint8Array(readback.getMappedRange());
const tight = new Uint8Array(unpadded * height);
for (let row = 0; row < height; row++) {
  tight.set(
    padded.subarray(row * bytesPerRow, row * bytesPerRow + unpadded),
    row * unpadded,
  );
}
readback.unmap();                                  // invalidates `padded`
```

### Pattern 4: ALWAYS compute dynamic offsets from a 256-aligned stride

A dynamic uniform or storage offset MUST be a multiple of 256. NEVER compute
`offset = i * structByteSize`; round the struct size up to a 256-byte stride
first. A 192-byte WGSL uniform struct still occupies a 256-byte slot.

```js
const ALIGN = 256;
const stride = Math.ceil(structByteSize / ALIGN) * ALIGN;  // 192 -> 256
const buffer = device.createBuffer({
  size: count * stride,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
// per draw: a 256-aligned offset selects element i
pass.setBindGroup(0, group, [i * stride]);
```

### Pattern 5: ALWAYS keep writeBuffer offset and size multiples of 4

`queue.writeBuffer` requires `bufferOffset` and the written byte count to each
be a multiple of 4. NEVER write an odd-length `Uint8Array` slice at an odd
offset. Pad the source data to a 4-byte boundary.

```js
const padded = (data.byteLength + 3) & ~3;         // round up to /4
const src = new Uint8Array(padded);
src.set(data);
queue.writeBuffer(buffer, 0, src);                 // offset 0, size padded
```

### Pattern 6: ALWAYS keep mapAsync and getMappedRange offsets aligned

`mapAsync` and `getMappedRange` require `offset` to be a multiple of 8 and
`size` a multiple of 4. ALWAYS map the whole buffer (omit `offset` and `size`)
unless a sub-range is needed; when a sub-range is needed, align it.

```js
await buffer.mapAsync(GPUMapMode.READ);            // full buffer, always valid
// sub-range: offset must be /8, size must be /4
await buffer.mapAsync(GPUMapMode.READ, 8, 64);
```

## Common Anti-Patterns

1. Sizing a readback buffer as `width * height * 4` and copying with
   `bytesPerRow = width * 4`. When `width * 4` is not a multiple of 256 the copy
   fails validation, because `bytesPerRow` is invalid and the buffer is too
   small for the padded layout the GPU writes.

2. Computing dynamic offsets as `i * structSize` where `structSize` is not a
   multiple of 256 (for example 192). `setBindGroup` rejects every offset that
   is not a multiple of `minUniformBufferOffsetAlignment` (256).

3. Calling `queue.writeBuffer` with a `bufferOffset` or write size that is not a
   multiple of 4. WebGPU validation rejects the call; the buffer is not updated.

## Critical Warnings

- NEVER pass a `bytesPerRow` that is not a multiple of 256 to
  `copyBufferToTexture`, `copyTextureToBuffer`, or `queue.writeTexture`.
- NEVER size a readback buffer with the unpadded `width * height * bytesPerTexel`
  formula. Use `bytesPerRow * height`.
- NEVER use `structByteSize` as a dynamic offset stride. Use a 256-aligned
  stride; the WGSL struct size and the dynamic-offset stride are different.
- NEVER assume `minUniformBufferOffsetAlignment` or
  `minStorageBufferOffsetAlignment` can be below 256. They are `minimum`-class
  limits; an adapter reports 256 or higher, NEVER lower.
- NEVER call `queue.writeBuffer` with a `bufferOffset` or size not a multiple
  of 4, or `mapAsync` / `getMappedRange` with an offset not a multiple of 8.
- NEVER read a mapped `ArrayBuffer` after `unmap()`; `unmap()` detaches it.

## Reference Files

- `methods.md` : every host-side alignment rule with its exact
  numeric constraint, the affected API signature, and the spec source.
- `examples.md` : verified code for `bytesPerRow` padding, the
  staging-buffer readback with padding stripping, and correct dynamic offsets.
- `anti-patterns.md` : alignment mistakes with WHY-it-fails
  explanations.

## Related Skills

- `webgpu-syntax-buffers` : `createBuffer`, usage flags, the buffer mapping
  state machine.
- `webgpu-impl-buffer-upload` : `writeBuffer` vs `mappedAtCreation` vs staging
  ring for CPU-to-GPU uploads.
- `webgpu-wgsl-memory-layout` : device-side WGSL struct layout, `@align` /
  `@size`, the `vec3` 16-byte trap that interacts with these host offsets.
