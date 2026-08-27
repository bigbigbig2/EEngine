# Methods: Buffer Upload and Readback

WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). All signatures verified
against the W3C WebGPU specification, MDN, and toji.dev WebGPU best practices.

## queue.writeBuffer

The safe default CPU to GPU upload path. The user agent selects the optimal
internal path and avoids allocating a mapped `ArrayBuffer` when the data already
exists in one.

```
device.queue.writeBuffer(buffer, bufferOffset, data, dataOffset?, size?)
```

| Parameter | Type | Units | Rule |
|-----------|------|-------|------|
| `buffer` | `GPUBuffer` | n/a | MUST have `GPUBufferUsage.COPY_DST`; MUST NOT be mapped or destroyed |
| `bufferOffset` | `number` | bytes | MUST be a multiple of 4 |
| `data` | `ArrayBuffer`, `TypedArray`, or `DataView` | n/a | Written byte size MUST be a multiple of 4 |
| `dataOffset` | `number` (optional) | elements for a `TypedArray`, bytes otherwise | Defaults to 0 |
| `size` | `number` (optional) | elements for a `TypedArray`, bytes otherwise | Defaults to the remainder of `data` after `dataOffset` |

Returns `undefined`. The write is queued on the GPU timeline; it is ordered before
any subsequently submitted command buffer.

Rules:
- ALWAYS create the destination buffer with `COPY_DST` in its `usage` mask.
- `dataOffset` and `size` are counted in ELEMENTS when `data` is a `TypedArray`
  (for example a `Float32Array` element is 4 bytes), and in BYTES when `data` is a
  plain `ArrayBuffer` or `DataView`.
- The write range `bufferOffset + writtenSize` MUST NOT exceed `buffer.size`.

## mappedAtCreation

Creates a buffer already mapped for writing, without requiring `COPY_DST`. ALWAYS
use this for buffers whose content is written once at creation (initial vertex,
index, or uniform data).

```
const buffer = device.createBuffer({
  size,                      // MUST be a multiple of 4 when mappedAtCreation is true
  usage,                     // no COPY_DST required for this path
  mappedAtCreation: true,
});
const range = buffer.getMappedRange(offset?, size?);   // ArrayBuffer, CPU-writable now
// write into a typed view over `range`
buffer.unmap();              // buffer becomes GPU-owned; `range` is detached
```

Rules:
- `size` MUST be a multiple of 4 when `mappedAtCreation` is true.
- The user agent zero-initializes the buffer before the mapped range is exposed.
- After `unmap()`, the `ArrayBuffer` from `getMappedRange()` is detached; any typed
  view over it throws `TypeError` on access.
- NEVER add `COPY_DST` just for this path; it is not needed.

## Staging-buffer ring

A pool of 2-3 `MAP_WRITE | COPY_SRC` buffers cycled across frames. ONLY worth the
complexity for large buffers rewritten every frame where `writeBuffer` profiles as
a bottleneck. The ring lets the CPU write the next frame's data while the GPU still
reads a previous frame's staging buffer.

Per-frame lifecycle for one ring slot:

```
1. Take an available (unmapped) staging buffer from the pool.
   If none is free, create one more (cap the pool at 3) or fall back to writeBuffer.
2. The buffer was already map-pending from a prior frame; await its mapAsync.
   For a freshly created buffer, create it with mappedAtCreation: true instead.
3. const range = staging.getMappedRange();
4. Write this frame's data into `range`.
5. staging.unmap();
6. encoder.copyBufferToBuffer(staging, 0, destination, 0, byteLength);
7. queue.submit([encoder.finish()]);
8. staging.mapAsync(GPUMapMode.WRITE)  // do NOT await in the frame path
      .then(() => returnToPool(staging));   // slot becomes available later
```

A staging buffer's usage is `GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC`.
The destination buffer's usage includes `COPY_DST` plus its real role flag
(`UNIFORM`, `VERTEX`, `STORAGE`, etc.).

Rules:
- `MAP_WRITE` ONLY combines with `COPY_SRC`. NEVER add `UNIFORM`/`STORAGE`/`VERTEX`
  to a staging buffer; that role belongs to the destination buffer.
- NEVER `await` the re-`mapAsync` in step 8 inside the render path; that
  reintroduces a CPU-GPU stall and defeats the ring. Let the `.then` callback
  return the slot to the pool asynchronously.
- NEVER call `mapAsync` on a buffer whose `mapState` is `"pending"` or `"mapped"`.
  The ring guarantees this by only re-mapping a slot after its `unmap()`.

## GPU to CPU readback workflow

Storage buffers and any GPU-written buffer not declared `MAP_READ` CANNOT be
mapped. ALWAYS copy the result into a separate `COPY_DST | MAP_READ` buffer.

### Buffer readback

```
const readback = device.createBuffer({
  size,                                                    // bytes to read
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
const encoder = device.createCommandEncoder();
encoder.copyBufferToBuffer(sourceBuffer, srcOffset, readback, 0, size);
device.queue.submit([encoder.finish()]);

await readback.mapAsync(GPUMapMode.READ, mapOffset?, mapSize?);
const range = readback.getMappedRange(getOffset?, getSize?);
const result = new Float32Array(range).slice();            // copy OUT before unmap
readback.unmap();
```

`copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size)` :
all four numeric arguments are byte counts. `size` MUST be a multiple of 4.

`mapAsync(mode, offset?, size?)` : `mode` is `GPUMapMode.READ` for readback.
`offset` MUST be a multiple of 8; `size` MUST be a multiple of 4. The returned
promise resolves only after all prior submitted work on the buffer completes,
which is the synchronization point that guarantees non-stale data.

`getMappedRange(offset?, size?)` : `offset` MUST be a multiple of 8, `size` a
multiple of 4. Returns an `ArrayBuffer`. After `unmap()` it is detached.

### Texture readback with bytesPerRow padding

`copyTextureToBuffer` writes texture texels into a buffer. The buffer side is a
`GPUTexelCopyBufferInfo`: `{ buffer, offset?, bytesPerRow?, rowsPerImage? }`. The
`bytesPerRow` field MUST be a multiple of 256.

```
const bytesPerPixel = 4;                                   // rgba8unorm
const unpaddedBytesPerRow = width * bytesPerPixel;
const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;

const readback = device.createBuffer({
  size: paddedBytesPerRow * height,                        // padded total, not width*height*4
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});

const encoder = device.createCommandEncoder();
encoder.copyTextureToBuffer(
  { texture },                                             // GPUTexelCopyTextureInfo
  { buffer: readback, bytesPerRow: paddedBytesPerRow, rowsPerImage: height },
  { width, height },                                       // copySize
);
device.queue.submit([encoder.finish()]);

await readback.mapAsync(GPUMapMode.READ);
const padded = new Uint8Array(readback.getMappedRange());
```

### Stripping the bytesPerRow padding on the CPU

Each row in the mapped buffer occupies `paddedBytesPerRow` bytes; only the first
`unpaddedBytesPerRow` bytes per row are real texels. Copy row by row into a tight
buffer:

```
const tight = new Uint8Array(unpaddedBytesPerRow * height);
for (let y = 0; y < height; y++) {
  const srcStart = y * paddedBytesPerRow;
  tight.set(
    padded.subarray(srcStart, srcStart + unpaddedBytesPerRow),
    y * unpaddedBytesPerRow,
  );
}
readback.unmap();                                          // do this AFTER copying out
```

`tight` is a contiguous `width * height * bytesPerPixel` byte array suitable for an
`ImageData`, a PNG encoder, or numeric analysis.

Rules:
- ALWAYS round `bytesPerRow` up to the next multiple of 256.
- ALWAYS size the readback buffer as `paddedBytesPerRow * height`.
- ALWAYS copy the mapped data out BEFORE `unmap()`; the `ArrayBuffer` detaches on
  `unmap()`.
- When `width * bytesPerPixel` is already a multiple of 256, padded equals
  unpadded and the strip loop is a straight copy; the code stays correct either
  way.

## onSubmittedWorkDone

```
await device.queue.onSubmittedWorkDone();   // Promise<undefined>
```

Resolves after ALL previously submitted work completes. Use it when you must
confirm an earlier submission finished before reading a DIFFERENT buffer that the
`mapAsync` of the current readback does not already gate. For a readback where the
copy and the `mapAsync` target the same buffer, `mapAsync` alone is sufficient.

NEVER `await` `onSubmittedWorkDone` or `mapAsync` inside the per-frame render path
for routine rendering; it forces a CPU-GPU stall. Readback that must run every
frame ALWAYS uses a rotating staging buffer and consumes results one or two frames
late instead.

## Buffer usage flag rules

| Flag | Combines with | Purpose |
|------|---------------|---------|
| `MAP_READ` | ONLY `COPY_DST` | CPU reads GPU output |
| `MAP_WRITE` | ONLY `COPY_SRC` | CPU writes data the GPU copies onward |
| `COPY_DST` | any | destination of a copy or `writeBuffer` |
| `COPY_SRC` | any | source of a copy |

Mixing a `MAP_*` flag with `STORAGE`, `UNIFORM`, `VERTEX`, `INDEX`, `INDIRECT`, or
`QUERY_RESOLVE` fails validation at `createBuffer`.

## Sources

- W3C WebGPU spec, GPUQueue and buffer mapping : https://www.w3.org/TR/webgpu/
- MDN GPUQueue.writeBuffer : https://developer.mozilla.org/en-US/docs/Web/API/GPUQueue/writeBuffer
- toji.dev WebGPU buffer uploads : https://toji.dev/webgpu-best-practices/buffer-uploads.html
