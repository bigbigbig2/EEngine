# WebGPU Buffers: Methods Reference

WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+.

All signatures verified against the W3C WebGPU specification
(https://www.w3.org/TR/webgpu/#buffer-interface,
https://www.w3.org/TR/webgpu/#buffer-mapping), the MDN
`GPUDevice/createBuffer` page, and the vooronderzoek (PART A section 4).

## device.createBuffer

```
device.createBuffer(descriptor: GPUBufferDescriptor) -> GPUBuffer
```

`GPUBufferDescriptor` fields:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `label` | `string` | No | Debug label. ALWAYS set it; it appears in validation error messages. |
| `size` | `number` (`GPUSize64`) | Yes | Byte size of the buffer. MUST be a multiple of 4 when `mappedAtCreation` is `true`. |
| `usage` | `number` (`GPUBufferUsageFlags`) | Yes | Bitmask of `GPUBufferUsage` flags combined with `\|`. MUST be non-zero. |
| `mappedAtCreation` | `boolean` | No | Default `false`. When `true`, the buffer is returned mapped for writing and `getMappedRange` is callable immediately, without a `COPY_DST` flag. |

`createBuffer` always returns a `GPUBuffer` synchronously. Validation failures
(illegal usage combination, `mappedAtCreation` size not a multiple of 4) surface
asynchronously as a `GPUValidationError`; capture them with
`pushErrorScope`/`popErrorScope`.

## GPUBufferUsage flags

`GPUBufferUsage` is a namespace of bitflag constants. Combine with `|`.

| Flag | Bit purpose | Combination rule |
|------|-------------|------------------|
| `GPUBufferUsage.MAP_READ` | Buffer can be mapped for CPU reading via `mapAsync(GPUMapMode.READ)`. | Legal ONLY together with `COPY_DST`. NEVER with any other flag. |
| `GPUBufferUsage.MAP_WRITE` | Buffer can be mapped for CPU writing via `mapAsync(GPUMapMode.WRITE)`. | Legal ONLY together with `COPY_SRC`. NEVER with any other flag. |
| `GPUBufferUsage.COPY_SRC` | Buffer can be the source of `copyBufferToBuffer` / `copyBufferToTexture`. | Combines with any flag. |
| `GPUBufferUsage.COPY_DST` | Buffer can be the destination of a copy command or `queue.writeBuffer`. | Combines with any flag. Required for `queue.writeBuffer`. |
| `GPUBufferUsage.INDEX` | Buffer can be bound as an index buffer via `setIndexBuffer`. | Combines with any non-`MAP_*` flag. |
| `GPUBufferUsage.VERTEX` | Buffer can be bound as a vertex buffer via `setVertexBuffer`. | Combines with any non-`MAP_*` flag. |
| `GPUBufferUsage.UNIFORM` | Buffer can be bound as a `"uniform"` buffer binding in a bind group. | Combines with any non-`MAP_*` flag. |
| `GPUBufferUsage.STORAGE` | Buffer can be bound as a `"storage"` or `"read-only-storage"` binding. | Combines with any non-`MAP_*` flag. |
| `GPUBufferUsage.INDIRECT` | Buffer can supply parameters for `drawIndirect`, `drawIndexedIndirect`, `dispatchWorkgroupsIndirect`. | Combines with any non-`MAP_*` flag. |
| `GPUBufferUsage.QUERY_RESOLVE` | Buffer can be the destination of `resolveQuerySet`. | Combines with any non-`MAP_*` flag. |

### The MAP restriction (the validation rule)

The WebGPU spec restricts `MAP_*` flags so that a mappable buffer carries no
GPU-side render or compute usage:

- `MAP_READ` is valid ONLY in the combination `MAP_READ | COPY_DST`.
- `MAP_WRITE` is valid ONLY in the combination `MAP_WRITE | COPY_SRC`.
- A buffer with both `MAP_READ` and `MAP_WRITE` is illegal.
- `MAP_READ` or `MAP_WRITE` mixed with `STORAGE`, `UNIFORM`, `VERTEX`, `INDEX`,
  `INDIRECT`, or `QUERY_RESOLVE` is illegal.

Any illegal combination makes `createBuffer` produce an invalid buffer and emits
a `GPUValidationError`.

## GPUBuffer methods

### buffer.mapAsync

```
buffer.mapAsync(mode: GPUMapModeFlags, offset?: number, size?: number)
  -> Promise<undefined>
```

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `mode` | `GPUMapModeFlags` | required | `GPUMapMode.READ` or `GPUMapMode.WRITE`. MUST match the buffer's `MAP_READ` / `MAP_WRITE` usage. |
| `offset` | `number` | `0` | Start of the mapped range, in bytes. MUST be a multiple of 8. |
| `size` | `number` | buffer size minus `offset` | Length of the mapped range, in bytes. MUST be a multiple of 4. |

`mapAsync` transitions the buffer from `mapState === "unmapped"` to `"pending"`.
The returned promise resolves once the GPU finishes any pending work on the
buffer, transitioning it to `"mapped"`. Calling `mapAsync` while `mapState` is
`"pending"` or `"mapped"` rejects with a validation error
("buffer is already mapped"). Exact alignment numbers: `webgpu-core-memory-model`.

### buffer.getMappedRange

```
buffer.getMappedRange(offset?: number, size?: number) -> ArrayBuffer
```

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `offset` | `number` | `0` | Start of the returned range, in bytes. MUST be a multiple of 8. |
| `size` | `number` | mapped size minus `offset` | Length of the returned range, in bytes. MUST be a multiple of 4. |

Returns a fresh `ArrayBuffer` that aliases the mapped GPU memory. Callable ONLY
while `mapState === "mapped"` (after a resolved `mapAsync`) or immediately after
`createBuffer({ mappedAtCreation: true })`. The returned range must lie within
the range passed to `mapAsync`. `unmap()` detaches every `ArrayBuffer` returned
by `getMappedRange`.

### buffer.unmap

```
buffer.unmap() -> undefined
```

Returns the buffer to `mapState === "unmapped"` and hands ownership back to the
GPU. Detaches every `ArrayBuffer` previously returned by `getMappedRange`; any
typed view over a detached `ArrayBuffer` throws `TypeError` on access. For a
`mappedAtCreation` buffer, `unmap()` is the step that makes the written data
visible to the GPU.

### buffer.destroy

```
buffer.destroy() -> undefined
```

Releases the GPU memory backing the buffer. The buffer becomes unusable; any
later use in a command or `mapAsync` call fails validation. `destroy()` is
idempotent. If the buffer is mapped, `destroy()` implicitly unmaps it.

### GPUBuffer read-only properties

| Property | Type | Notes |
|----------|------|-------|
| `buffer.size` | `number` | Byte size, as passed to `createBuffer`. |
| `buffer.usage` | `number` | The `GPUBufferUsage` bitmask. |
| `buffer.mapState` | `"unmapped"` \| `"pending"` \| `"mapped"` | Current point in the mapping lifecycle. |
| `buffer.label` | `string` | The debug label. |

## GPUMapMode

`GPUMapMode` is a namespace of bitflag constants passed as the `mode` argument
of `mapAsync`:

| Constant | Use | Required buffer usage |
|----------|-----|-----------------------|
| `GPUMapMode.READ` | Map the buffer so the CPU can read it. | Buffer MUST have `GPUBufferUsage.MAP_READ`. |
| `GPUMapMode.WRITE` | Map the buffer so the CPU can write it. | Buffer MUST have `GPUBufferUsage.MAP_WRITE`. |

Passing `GPUMapMode.READ` for a buffer without `MAP_READ` usage (or
`GPUMapMode.WRITE` without `MAP_WRITE`) fails validation.

## The mapState lifecycle

```
            mapAsync()              promise resolves
 unmapped  ───────────────▶ pending ───────────────▶ mapped
    ▲                                                   │
    │                       unmap()                     │
    └───────────────────────────────────────────────────┘
```

- `"unmapped"` : GPU owns the buffer. The CPU cannot read or write it. The
  buffer can be used in copy commands and bindings. This is the initial state
  unless `mappedAtCreation: true`.
- `"pending"` : `mapAsync` has been called; the promise has not resolved. A
  second `mapAsync` call in this state rejects.
- `"mapped"` : the CPU owns the buffer. `getMappedRange` is callable. The buffer
  MUST NOT be used in any GPU command while mapped.

A buffer created with `mappedAtCreation: true` starts directly in `"mapped"`.

## queue.writeBuffer

```
device.queue.writeBuffer(
  buffer: GPUBuffer,
  bufferOffset: number,
  data: BufferSource | SharedArrayBuffer,
  dataOffset?: number,
  size?: number
) -> undefined
```

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `buffer` | `GPUBuffer` | required | Destination. MUST have `GPUBufferUsage.COPY_DST`. MUST NOT be mapped. |
| `bufferOffset` | `number` | required | Byte offset into the destination buffer. MUST be a multiple of 4. |
| `data` | `BufferSource` | required | An `ArrayBuffer`, a `TypedArray`, or a `DataView`. |
| `dataOffset` | `number` | `0` | Start offset into `data`. In elements when `data` is a `TypedArray`, in bytes when `data` is an `ArrayBuffer` or `DataView`. |
| `size` | `number` | rest of `data` | Amount copied. In elements for a `TypedArray`, in bytes otherwise. The resulting byte count MUST be a multiple of 4. |

`queue.writeBuffer` copies CPU data into a buffer without any mapping. It is the
simplest CPU-to-GPU upload path and the safe default for per-frame uploads.
WebGPU snapshots `data` at call time, so the source array can be reused
immediately afterwards. The `bufferOffset` and write-size multiple-of-4
constraints are documented in `webgpu-core-memory-model`.

## Sources

- W3C WebGPU spec, GPUBuffer: https://www.w3.org/TR/webgpu/#buffer-interface
- W3C WebGPU spec, buffer mapping: https://www.w3.org/TR/webgpu/#buffer-mapping
- W3C WebGPU spec, GPUQueue.writeBuffer: https://www.w3.org/TR/webgpu/#gpuqueue
- MDN GPUDevice.createBuffer: https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createBuffer
- vooronderzoek-webgpu.md PART A section 4 (Buffers), PART C section 4 (Async Patterns)
