# Command Encoder Methods Reference

All signatures below are verified against the W3C WebGPU specification
(https://www.w3.org/TR/webgpu/), MDN, and the WebGPU Explainer. Version baseline:
WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+.

## device.createCommandEncoder

```js
device.createCommandEncoder(descriptor?) -> GPUCommandEncoder
```

`GPUCommandEncoderDescriptor` fields:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `label` | string | No | Quoted verbatim in `GPUError` messages. ALWAYS set it. |

The encoder records commands on the CPU. It produces a `GPUCommandBuffer` exactly
once via `finish()`; after `finish()` the encoder is locked and rejects further
calls.

## encoder.beginRenderPass

```js
encoder.beginRenderPass(descriptor) -> GPURenderPassEncoder
```

`GPURenderPassDescriptor` field overview:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `label` | string | No | Debug label. |
| `colorAttachments` | `(GPURenderPassColorAttachment \| null)[]` | Yes | One entry per color target. |
| `depthStencilAttachment` | `GPURenderPassDepthStencilAttachment` | No | Depth and stencil target. |
| `occlusionQuerySet` | `GPUQuerySet` | No | Query set of type `"occlusion"` for `beginOcclusionQuery` / `endOcclusionQuery`. |
| `timestampWrites` | `GPURenderPassTimestampWrites` | No | Requires the `timestamp-query` feature. |
| `maxDrawCount` | number | No | Default 50000000. Upper bound on draw calls in the pass. |

`GPURenderPassColorAttachment` fields: `view` (`GPUTextureView`, required),
`depthSlice` (number, for 3D textures), `resolveTarget` (`GPUTextureView`, single
sample, for MSAA resolve), `clearValue` (RGBA dictionary or array), `loadOp`
(`"clear"` or `"load"`, required), `storeOp` (`"store"` or `"discard"`, required).

`GPURenderPassDepthStencilAttachment` fields: `view` (`GPUTextureView`, required),
`depthClearValue`, `depthLoadOp` (`"clear"` or `"load"`), `depthStoreOp`
(`"store"` or `"discard"`), `depthReadOnly` (boolean), `stencilClearValue`,
`stencilLoadOp`, `stencilStoreOp`, `stencilReadOnly`.

Attachment detail (formats, MSAA, MRT) belongs to `webgpu-impl-render-targets`.
The `GPURenderPassEncoder` returned MUST call `end()`.

## encoder.beginComputePass

```js
encoder.beginComputePass(descriptor?) -> GPUComputePassEncoder
```

`GPUComputePassDescriptor` fields:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `label` | string | No | Debug label. |
| `timestampWrites` | `GPUComputePassTimestampWrites` | No | Requires the `timestamp-query` feature. |

The `GPUComputePassEncoder` returned MUST call `end()`.

## timestampWrites structure

For both render and compute passes, `timestampWrites` is one object:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `querySet` | `GPUQuerySet` | Yes | Must be type `"timestamp"`. |
| `beginningOfPassWriteIndex` | number | No | Query index written at pass start. |
| `endOfPassWriteIndex` | number | No | Query index written at pass end. |

At least one of the two write indices must be present and they must differ from
each other. Indices must be less than the query set `count`.

## Copy methods

All copy methods are recorded directly on `GPUCommandEncoder`, NEVER inside an
open pass.

### copyBufferToBuffer

```js
encoder.copyBufferToBuffer(source, destination)
encoder.copyBufferToBuffer(source, destination, size)
encoder.copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size)
```

- `source` (`GPUBuffer`) MUST include `GPUBufferUsage.COPY_SRC`.
- `destination` (`GPUBuffer`) MUST include `GPUBufferUsage.COPY_DST`.
- `sourceOffset`, `destinationOffset`, `size` are bytes and MUST each be multiples
  of 4.
- Omitting `sourceOffset` and `destinationOffset` copies from offset 0 in both.
- Omitting all three copies the entire source buffer.
- `source` and `destination` MUST be different buffers.

### copyBufferToTexture

```js
encoder.copyBufferToTexture(source, destination, copySize)
```

- `source` is a `GPUTexelCopyBufferInfo`: `{ buffer, offset?, bytesPerRow?, rowsPerImage? }`.
- `destination` is a `GPUTexelCopyTextureInfo`: `{ texture, mipLevel?, origin?, aspect? }`.
- `copySize` is `[w, h, depthOrArrayLayers]` or a `{ width, height, depthOrArrayLayers }` object.
- `bytesPerRow` MUST be a multiple of 256. See `webgpu-core-memory-model`.
- The buffer needs `COPY_SRC`; the texture needs `COPY_DST`.

### copyTextureToBuffer

```js
encoder.copyTextureToBuffer(source, destination, copySize)
```

- `source` is a `GPUTexelCopyTextureInfo`; `destination` is a `GPUTexelCopyBufferInfo`.
- `bytesPerRow` on the buffer side MUST be a multiple of 256.
- The texture needs `COPY_SRC`; the buffer needs `COPY_DST`.

### copyTextureToTexture

```js
encoder.copyTextureToTexture(source, destination, copySize)
```

- `source` and `destination` are both `GPUTexelCopyTextureInfo` objects.
- The source texture needs `COPY_SRC`; the destination needs `COPY_DST`.
- The two textures MUST have compatible formats and the same sample count.

### clearBuffer

```js
encoder.clearBuffer(buffer, offset?, size?)
```

- Fills a region of `buffer` with zeroes.
- `buffer` MUST include `GPUBufferUsage.COPY_DST`.
- `offset` and `size` MUST be multiples of 4. Omitting `size` clears to the end.

## encoder.finish

```js
encoder.finish(descriptor?) -> GPUCommandBuffer
```

- `GPUCommandBufferDescriptor` has one optional field: `label`.
- Throws if any pass started on the encoder is still open.
- After `finish()` the encoder is locked. Any further command call is invalid.
- The returned `GPUCommandBuffer` is single-use.

## device.queue.submit

```js
device.queue.submit(commandBuffers) -> undefined
```

- `commandBuffers` is an array of `GPUCommandBuffer` objects.
- Each command buffer is consumed by the submit and MUST NOT be submitted again.
- Buffers in the array execute in array order.

## device.queue.onSubmittedWorkDone

```js
device.queue.onSubmittedWorkDone() -> Promise<undefined>
```

- The promise resolves when all work submitted before the call has completed on
  the GPU. It never rejects for normal completion.
- Promises settle in submission order.
- Use at load time or for readback synchronisation. NEVER `await` it inside the
  per-frame render loop because it forces a CPU-GPU stall.

## device.createQuerySet

```js
device.createQuerySet(descriptor) -> GPUQuerySet
```

`GPUQuerySetDescriptor` fields:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | `"occlusion"` or `"timestamp"` | Yes | `"timestamp"` requires the `timestamp-query` feature. |
| `count` | number | Yes | Number of queries. MUST be less than or equal to 4096. |
| `label` | string | No | Debug label. |

`GPUQuerySet` properties: `type` (read-only), `count` (read-only). Method:
`destroy()`. A `count` greater than 4096 yields a `GPUValidationError` and an
invalid query set.

A `"timestamp"` query set records GPU timestamps in nanoseconds. An `"occlusion"`
query set counts fragment samples that pass per-fragment tests.

## encoder.resolveQuerySet

```js
encoder.resolveQuerySet(querySet, firstQuery, queryCount, destination, destinationOffset)
```

| Parameter | Type | Notes |
|-----------|------|-------|
| `querySet` | `GPUQuerySet` | The query set to resolve. |
| `firstQuery` | number | Index of the first query to copy. |
| `queryCount` | number | Number of queries to copy starting at `firstQuery`. |
| `destination` | `GPUBuffer` | MUST include `GPUBufferUsage.QUERY_RESOLVE`. |
| `destinationOffset` | number | Bytes from buffer start. MUST be a multiple of 256. |

Each query resolves to a 64-bit unsigned integer (8 bytes). Timestamp values are
nanoseconds and are read back as a `BigUint64Array`. To read the values on the
CPU, copy the `QUERY_RESOLVE` buffer into a separate `COPY_DST | MAP_READ` buffer
and map that, because a `QUERY_RESOLVE` buffer cannot also have `MAP_READ`.

## Debug group methods

```js
encoder.pushDebugGroup(groupLabel)   // groupLabel: string
encoder.popDebugGroup()              // closes the most recent group
encoder.insertDebugMarker(markerLabel) // markerLabel: string
```

- `pushDebugGroup` and `popDebugGroup` MUST be balanced; every push needs a pop on
  the same encoder before `finish()`.
- These names appear in GPU frame captures (PIX, RenderDoc-style tooling).
- The same three methods also exist on `GPURenderPassEncoder` and
  `GPUComputePassEncoder` to annotate inside a pass.

## Note on writeTimestamp

`encoder.writeTimestamp(querySet, queryIndex)` was an early single-timestamp API.
It was removed from WebGPU 1.0-stable. ALWAYS use `timestampWrites` on a render or
compute pass descriptor to record timestamps in the stable API.
