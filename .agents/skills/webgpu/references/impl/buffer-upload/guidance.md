# WebGPU Buffer Upload and Readback

Moving data CPU to GPU (upload) and GPU to CPU (readback) in WebGPU 1.0-stable
(Chrome 113+, Safari 26+, Firefox 141+), with the alignment rules that cause the
most validation errors.

## Quick Reference

| Upload path | When to use | Needs COPY_DST | API |
|-------------|-------------|----------------|-----|
| `queue.writeBuffer` | Safe default for any CPU to GPU upload | yes | `device.queue.writeBuffer(buf, offset, data)` |
| `mappedAtCreation: true` | Initial vertex/index/uniform data, set once | no | `createBuffer({ mappedAtCreation: true })` |
| Staging-buffer ring (2-3 buffers) | Large uploads issued every frame | yes (on destination) | `mapAsync` + `copyBufferToBuffer` |

| Readback path | When to use | API |
|---------------|-------------|-----|
| Buffer readback | Read a storage/compute-written buffer | `copyBufferToBuffer` into a `COPY_DST \| MAP_READ` buffer |
| Texture readback | Read pixels / download a texture | `copyTextureToBuffer` with 256-byte `bytesPerRow` padding |

Alignment numbers in one place: `writeBuffer` `bufferOffset` and `size` multiples
of 4; `mappedAtCreation` `size` a multiple of 4; `mapAsync`/`getMappedRange`
`offset` a multiple of 8 and `size` a multiple of 4; `bytesPerRow` a multiple of
256. The per-rule rationale lives in `webgpu-core-memory-model`.

## Decision Tree

### Choosing an upload path

```
Uploading data to a buffer?
├─ Is this the buffer's initial content, written once at creation?
│   └─ YES → mappedAtCreation: true
│            (no COPY_DST needed, no extra copy, size MUST be multiple of 4)
├─ Is this a large buffer rewritten EVERY frame and writeBuffer profiles as a bottleneck?
│   └─ YES → staging-buffer ring (2-3 buffers, see methods.md)
└─ Anything else (per-frame uniforms, occasional updates, unknown)
    └─ queue.writeBuffer  ← ALWAYS the default
```

NEVER reach for a staging ring before `writeBuffer` is measured as the bottleneck.
The ring adds buffer pool management and async bookkeeping; `writeBuffer` lets the
user agent pick the optimal internal path with zero extra code.

### GPU to CPU readback steps

```
1. Create a destination buffer: usage = COPY_DST | MAP_READ
   (MAP_READ ALWAYS combines only with COPY_DST, never STORAGE/UNIFORM/VERTEX)
2. Encode the copy INTO that buffer:
   - source is a buffer  → encoder.copyBufferToBuffer(...)
   - source is a texture → encoder.copyTextureToBuffer(...) with padded bytesPerRow
3. queue.submit([encoder.finish()])
4. await readbackBuffer.mapAsync(GPUMapMode.READ)   ← waits for the GPU
5. const range = readbackBuffer.getMappedRange()    ← ArrayBuffer view
6. Copy bytes OUT now: new Uint8Array(range).slice() or .set() into your own array
7. readbackBuffer.unmap()   ← range is detached after this; copy BEFORE unmap
```

Step 4 is what guarantees the GPU finished. The `mapAsync` promise resolves only
after all prior submitted work touching the buffer completes, so readback never
sees stale data when the copy and the `mapAsync` are on the same buffer.

## Core Patterns

### Pattern 1: writeBuffer is the default upload

ALWAYS use `queue.writeBuffer` for routine CPU to GPU uploads. The destination
buffer MUST have `COPY_DST`.

```js
const buf = device.createBuffer({
  size: data.byteLength,                       // multiple of 4
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(buf, 0, data);        // bufferOffset 0, size = data.byteLength
```

NEVER call `writeBuffer` on a buffer that is currently mapped or destroyed; it
fails validation. `bufferOffset` and the data size MUST both be multiples of 4.

### Pattern 2: mappedAtCreation for initial data

ALWAYS use `mappedAtCreation: true` for vertex/index/uniform data written once.
It needs NO `COPY_DST` flag and avoids an internal copy.

```js
const vbuf = device.createBuffer({
  size: vertices.byteLength,                   // MUST be a multiple of 4
  usage: GPUBufferUsage.VERTEX,                // no COPY_DST required
  mappedAtCreation: true,
});
new Float32Array(vbuf.getMappedRange()).set(vertices);
vbuf.unmap();                                  // buffer is now GPU-owned
```

NEVER use the mapped range after `unmap()`; the `ArrayBuffer` is detached and any
view over it throws `TypeError`.

### Pattern 3: storage buffers cannot be mapped directly

A `STORAGE` buffer (and any GPU-written buffer not declared `MAP_READ`) CANNOT be
mapped. ALWAYS copy it into a separate `COPY_DST | MAP_READ` staging buffer first.

```js
const readback = device.createBuffer({
  size: storageBuffer.size,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
const enc = device.createCommandEncoder();
enc.copyBufferToBuffer(storageBuffer, 0, readback, 0, storageBuffer.size);
device.queue.submit([enc.finish()]);
await readback.mapAsync(GPUMapMode.READ);
const out = new Float32Array(readback.getMappedRange()).slice();  // copy OUT
readback.unmap();
```

`MAP_READ` is ONLY valid combined with `COPY_DST`. NEVER add `STORAGE`, `UNIFORM`,
or `VERTEX` to a `MAP_READ` buffer; that combination fails validation.

### Pattern 4: bytesPerRow MUST be a multiple of 256

For `copyTextureToBuffer`, `bytesPerRow` MUST round up to the next multiple of
256. ALWAYS size the destination buffer as `paddedBytesPerRow * height` and strip
the padding on the CPU after mapping.

```js
const unpaddedBytesPerRow = width * 4;                        // RGBA8 = 4 bytes/texel
const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
const readback = device.createBuffer({
  size: paddedBytesPerRow * height,                           // padded, not width*height*4
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
enc.copyTextureToBuffer(
  { texture },
  { buffer: readback, bytesPerRow: paddedBytesPerRow, rowsPerImage: height },
  { width, height },
);
```

After mapping, copy each logical row out of the padded buffer (full strip code in
`examples.md`). NEVER size the buffer as `width * height * 4` with
`bytesPerRow = width * 4` unless `width * 4` is already a multiple of 256.

### Pattern 5: sequence readback so it does not read stale data

ALWAYS encode the copy and call `mapAsync` on the SAME buffer in the SAME flow.
The `mapAsync` promise resolves only after prior submitted work finishes.

```js
device.queue.submit([enc.finish()]);
await readback.mapAsync(GPUMapMode.READ);   // resolves after the copy completes
```

When you must confirm an unrelated submission finished before reading a different
buffer, ALWAYS `await device.queue.onSubmittedWorkDone()`. NEVER assume data is
ready right after `submit()` returns; `submit()` only schedules the work.

### Pattern 6: never re-map a pending or mapped buffer

NEVER call `mapAsync` on a buffer whose `mapState` is `"pending"` or `"mapped"`;
it fails with "buffer is already mapped". ALWAYS `unmap()` first, or sequence
map/unmap strictly. A staging ring (see `methods.md`) keeps each buffer
single-mapped by rotating across 2-3 buffers.

## Common Anti-Patterns

1. **Unpadded readback buffer.** Sizing a `copyTextureToBuffer` destination as
   `width * height * 4` with `bytesPerRow = width * 4`. When `width * 4` is not a
   multiple of 256 the copy fails validation. Pad `bytesPerRow` to 256 and size the
   buffer as `paddedBytesPerRow * height`.
2. **Mapping a storage buffer directly.** Storage buffers cannot be mapped;
   `MAP_READ` only combines with `COPY_DST`. Copy into a separate staging buffer.
3. **Reading before the GPU finished.** Calling `getMappedRange` without awaiting
   `mapAsync` (or before its promise resolves) reads stale or undefined data. The
   `mapAsync` promise is the synchronization point.

## Critical Warnings

- NEVER combine `MAP_READ` with anything except `COPY_DST`, or `MAP_WRITE` with
  anything except `COPY_SRC`. Other combinations fail validation.
- NEVER use a `getMappedRange()` `ArrayBuffer` after `unmap()`; it is detached.
  ALWAYS copy bytes out with `.slice()` or `.set()` before `unmap()`.
- NEVER pass a `bytesPerRow` that is not a multiple of 256 to `copyTextureToBuffer`
  or `copyBufferToTexture`.
- NEVER call `writeBuffer` on a mapped or destroyed buffer.
- NEVER build a staging ring when `writeBuffer` is not measured as a bottleneck;
  it is added complexity with no benefit for non-per-frame uploads.

## Reference Files

- `methods.md` : `writeBuffer`, `mappedAtCreation`, the staging-buffer
  ring, and the full readback workflow with `bytesPerRow` padding.
- `examples.md` : verified working code for each upload path and a
  complete GPU to CPU texture readback with 256-byte padding stripping.
- `anti-patterns.md` : upload and readback mistakes with WHY-it-fails
  explanations.

Related skills: `webgpu-syntax-buffers` (buffer creation and usage flags),
`webgpu-core-memory-model` (the alignment numbers in detail),
`webgpu-impl-async-patterns` (`mapAsync`, `onSubmittedWorkDone`, frame loop),
`webgpu-syntax-command-encoder` (`copyBufferToBuffer`, `copyTextureToBuffer`).
