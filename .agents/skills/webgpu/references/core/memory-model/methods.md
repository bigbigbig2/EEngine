# Host-Side Alignment Rules : Reference

WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+.

This file lists every host-side alignment rule, its exact numeric constraint,
the affected API, and the spec source. Every value is verified against the W3C
WebGPU specification (https://www.w3.org/TR/webgpu/).

WebGPU validates each rule at API-call time and rejects misaligned values. There
is NO silent rounding anywhere in this API. ALWAYS compute aligned values on the
host first.

---

## 1. Buffer size when mappedAtCreation is true

| Property | Value |
|----------|-------|
| Rule | `size` MUST be a multiple of 4 |
| Affected API | `device.createBuffer({ label?, size, usage, mappedAtCreation })` |
| Trigger | only when `mappedAtCreation: true` |
| Spec | W3C WebGPU, `#dom-gpudevicedescriptor` / buffer creation validation |

Signature:

```ts
GPUDevice.createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer
// GPUBufferDescriptor: { label?, size: GPUSize64, usage: GPUBufferUsageFlags,
//                        mappedAtCreation?: boolean }
```

`createBuffer` returns immediately. When `mappedAtCreation` is `true` the buffer
is returned already mapped for writing, and `size` MUST be a multiple of 4. When
`mappedAtCreation` is `false` (the default) the size-multiple-of-4 rule does NOT
apply to creation, but later operations on the buffer still carry their own
alignment rules (rows 2 to 4 below).

Fix: `const size = (rawSize + 3) & ~3;` rounds any byte count up to a multiple
of 4.

---

## 2. queue.writeBuffer offset and size

| Property | Value |
|----------|-------|
| Rule | `bufferOffset` MUST be a multiple of 4; the written byte count MUST be a multiple of 4 |
| Affected API | `queue.writeBuffer(buffer, bufferOffset, data, dataOffset?, size?)` |
| Spec | W3C WebGPU, `#dom-gpuqueue-writebuffer` |

Signature:

```ts
GPUQueue.writeBuffer(
  buffer: GPUBuffer,
  bufferOffset: GPUSize64,            // MUST be multiple of 4
  data: BufferSource | SharedArrayBuffer,
  dataOffset?: GPUSize64,             // element offset into `data`
  size?: GPUSize64,                   // element count; written bytes MUST be /4
): undefined
```

The number of bytes written is `size` (when given) scaled by the element size
of `data`, otherwise the remaining length of `data` after `dataOffset`. That
written byte count MUST be a multiple of 4. `bufferOffset` MUST be a multiple
of 4. The destination `buffer` MUST include `GPUBufferUsage.COPY_DST`.

Fix: pad the source to a 4-byte boundary before writing; see
`references/examples.md`.

---

## 3. mapAsync offset and size

| Property | Value |
|----------|-------|
| Rule | `offset` MUST be a multiple of 8; `size` MUST be a multiple of 4 |
| Affected API | `buffer.mapAsync(mode, offset?, size?)` |
| Spec | W3C WebGPU, `#dom-gpubuffer-mapasync`, `#buffer-mapping` |

Signature:

```ts
GPUBuffer.mapAsync(
  mode: GPUMapModeFlags,              // GPUMapMode.READ | GPUMapMode.WRITE
  offset?: GPUSize64,                 // default 0; MUST be multiple of 8
  size?: GPUSize64,                   // default rest of buffer; MUST be /4
): Promise<undefined>
```

`mapAsync` resolves when the GPU has finished prior work on the buffer and the
range is host-visible. `GPUMapMode.READ` requires the buffer usage to include
`MAP_READ`; `GPUMapMode.WRITE` requires `MAP_WRITE`. The buffer mapping state
machine is `unmapped -> pending -> mapped`.

Omitting `offset` and `size` maps the whole buffer and is always alignment-safe
provided the buffer size itself is a multiple of 4.

---

## 4. getMappedRange offset and size

| Property | Value |
|----------|-------|
| Rule | `offset` MUST be a multiple of 8; `size` MUST be a multiple of 4 |
| Affected API | `buffer.getMappedRange(offset?, size?)` |
| Spec | W3C WebGPU, `#dom-gpubuffer-getmappedrange` |

Signature:

```ts
GPUBuffer.getMappedRange(
  offset?: GPUSize64,                 // default 0; MUST be multiple of 8
  size?: GPUSize64,                   // default rest of buffer; MUST be /4
): ArrayBuffer
```

`getMappedRange` is callable only while the buffer is in the `mapped` state and
the requested range MUST lie inside a range previously passed to `mapAsync` (or
the whole buffer for a `mappedAtCreation` buffer). `unmap()` detaches every
`ArrayBuffer` returned by `getMappedRange`; reads or writes through a detached
`ArrayBuffer` throw.

---

## 5. Dynamic buffer binding offsets

| Property | Value |
|----------|-------|
| Rule, uniform | offset MUST be a multiple of `minUniformBufferOffsetAlignment` (default 256) |
| Rule, storage | offset MUST be a multiple of `minStorageBufferOffsetAlignment` (default 256) |
| Affected API | `passEncoder.setBindGroup(index, bindGroup, dynamicOffsets)` |
| Enabled by | bind-group-layout entry with `buffer.hasDynamicOffset: true` |
| Spec | W3C WebGPU, `#dom-gpurenderpassencoder-setbindgroup`, `#limits` |

A bind-group-layout buffer entry with `hasDynamicOffset: true` does not bake the
offset into the bind group. The offset is supplied per draw or dispatch:

```ts
GPURenderPassEncoder.setBindGroup(
  index: GPUIndex32,
  bindGroup: GPUBindGroup,
  dynamicOffsets?: Iterable<GPUBufferDynamicOffset>,
): undefined
// also on GPUComputePassEncoder and GPURenderBundleEncoder
```

Each value in `dynamicOffsets` applies, in declaration order, to the dynamic
buffer entries of the bind group. For a `"uniform"` buffer entry the offset MUST
be a multiple of `device.limits.minUniformBufferOffsetAlignment`. For a
`"storage"` or `"read-only-storage"` entry the offset MUST be a multiple of
`device.limits.minStorageBufferOffsetAlignment`.

Both limits are `alignment`-class, `minimum`-class limits. The spec default is
256. An adapter MAY report a smaller (better) value, but for `minimum`-class
alignment limits the spec mandates a default of 256 and adapters do NOT report
above it in practice; ALWAYS treat 256 as the value to align to, and NEVER
assume a value below 256. Reading `device.limits.minUniformBufferOffsetAlignment`
gives the negotiated value when exact targeting is needed.

The dynamic-offset stride is independent of the WGSL struct size. A WGSL uniform
struct that is 192 bytes still needs a 256-byte stride between consecutive
dynamic offsets, because every offset MUST be a multiple of 256.

---

## 6. bytesPerRow in buffer-texture copies

| Property | Value |
|----------|-------|
| Rule | `bytesPerRow` MUST be a multiple of 256 |
| Affected API | `copyBufferToTexture`, `copyTextureToBuffer`, `queue.writeTexture` |
| Required when | the copy spans more than one row (`copySize` height > 1 or depth > 1) |
| Spec | W3C WebGPU, `#dom-gpucommandencoder-copybuffertotexture`, `#gputexeldatabufferlayout` |

The buffer side of a buffer-texture copy is a `GPUTexelCopyBufferInfo`:

```ts
// GPUTexelCopyBufferInfo
{ buffer: GPUBuffer, offset?: GPUSize64, bytesPerRow?: GPUSize32,
  rowsPerImage?: GPUSize32 }
```

`bytesPerRow` is the stride in bytes from the start of one texel row to the next
in the buffer. It MUST be a multiple of 256. This is the fixed "256-byte row
pitch" rule; it does NOT vary by adapter and is NOT a queryable limit.

`bytesPerRow` is required whenever the copy has more than one row to lay out
(texture height greater than 1, or `rowsPerImage` greater than 1, or array depth
greater than 1). For a strictly single-row copy it MAY be omitted.

The unpadded row width is `copyWidthInTexelBlocks * blockSizeInBytes`. When that
value is not a multiple of 256, `bytesPerRow` MUST be the next multiple of 256,
and the buffer carries `bytesPerRow - unpadded` pad bytes per row.

`rowsPerImage` is the number of texel rows from one image (array layer or depth
slice) to the next; it is in rows, NOT bytes, and has no 256 constraint.

Texel block sizes for the common formats:

| Format | Block dimensions | Bytes per block |
|--------|------------------|-----------------|
| r8unorm | 1x1 | 1 |
| rg8unorm | 1x1 | 2 |
| rgba8unorm / bgra8unorm | 1x1 | 4 |
| r16float | 1x1 | 2 |
| rgba16float | 1x1 | 8 |
| r32float | 1x1 | 4 |
| rgba32float | 1x1 | 16 |
| bc1-rgba-unorm | 4x4 | 8 |
| bc3-rgba-unorm / bc7-rgba-unorm | 4x4 | 16 |

For a non-block (1x1) format the unpadded row width is `width * bytesPerBlock`.
For a block-compressed format it is `ceil(width / 4) * bytesPerBlock`.

---

## 7. Texel-block origin alignment in copies

| Property | Value |
|----------|-------|
| Rule | `origin.x` and `origin.y` MUST be multiples of the format texel-block dimensions |
| Affected API | the texture side (`GPUTexelCopyTextureInfo`) of every texture copy |
| Spec | W3C WebGPU, `#gputexelcopytextureinfo`, copy validation |

The texture side of a copy is a `GPUTexelCopyTextureInfo`:

```ts
// GPUTexelCopyTextureInfo
{ texture: GPUTexture, mipLevel?: GPUIntegerCoordinate,
  origin?: GPUOrigin3D, aspect?: GPUTextureAspect }
```

`origin` is `{ x?, y?, z? }` or `[x, y, z]` (defaults 0). For a non-block (1x1)
format every integer origin is valid. For a block-compressed format `origin.x`
MUST be a multiple of the block width and `origin.y` a multiple of the block
height (4 and 4 for the BC formats), because a copy cannot start partway into a
compressed block. The same rule applies to the `copySize` width and height for
block formats, except where the dimension reaches the edge of the mip level.

---

## 8. Summary table

| # | Rule | Constraint | API |
|---|------|-----------|-----|
| 1 | Buffer size, mappedAtCreation | multiple of 4 | `createBuffer` |
| 2 | writeBuffer offset | multiple of 4 | `queue.writeBuffer` |
| 2 | writeBuffer written size | multiple of 4 | `queue.writeBuffer` |
| 3 | mapAsync offset | multiple of 8 | `buffer.mapAsync` |
| 3 | mapAsync size | multiple of 4 | `buffer.mapAsync` |
| 4 | getMappedRange offset | multiple of 8 | `buffer.getMappedRange` |
| 4 | getMappedRange size | multiple of 4 | `buffer.getMappedRange` |
| 5 | Dynamic uniform offset | multiple of `minUniformBufferOffsetAlignment` (256) | `setBindGroup` |
| 5 | Dynamic storage offset | multiple of `minStorageBufferOffsetAlignment` (256) | `setBindGroup` |
| 6 | bytesPerRow | multiple of 256 | buffer-texture copies, `writeTexture` |
| 7 | Copy origin x / y | multiple of format block dimensions | texture copies |

## Sources

- W3C WebGPU specification : https://www.w3.org/TR/webgpu/
- W3C WebGPU, buffer mapping : https://www.w3.org/TR/webgpu/#buffer-mapping
- W3C WebGPU, GPUQueue : https://www.w3.org/TR/webgpu/#gpuqueue
- W3C WebGPU, limits : https://www.w3.org/TR/webgpu/#limits
- MDN GPUCommandEncoder.copyBufferToTexture :
  https://developer.mozilla.org/en-US/docs/Web/API/GPUCommandEncoder/copyBufferToTexture
- MDN GPUBuffer.mapAsync :
  https://developer.mozilla.org/en-US/docs/Web/API/GPUBuffer/mapAsync
