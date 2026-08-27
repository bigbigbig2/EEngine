# WebGPU Buffers: Anti-Patterns

WebGPU 1.0-stable. Chrome 113+, Safari 26+, Firefox 141+.

Each anti-pattern below states the mistake, WHY it fails, and the correct
approach. Verified against the W3C WebGPU specification and the vooronderzoek
(PART A section 4, PART C section 4).

## Anti-Pattern 1: Combining MAP_READ or MAP_WRITE with render or compute usage

### The mistake

```js
// WRONG: MAP_READ mixed with STORAGE
const buffer = device.createBuffer({
  size: 1024,
  usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.STORAGE,
});
// Equally wrong: MAP_READ | UNIFORM, MAP_READ | VERTEX, MAP_WRITE | UNIFORM, etc.
```

### WHY it fails

The WebGPU spec restricts the `MAP_*` flags so a mappable buffer carries no
GPU-side render or compute usage. `MAP_READ` is legal ONLY in the combination
`MAP_READ | COPY_DST`, and `MAP_WRITE` ONLY in `MAP_WRITE | COPY_SRC`. Every
other pairing is rejected, so `createBuffer` produces an invalid buffer and emits
a `GPUValidationError`. The restriction exists because a mapped buffer is owned
by the CPU; allowing it to also be a live storage or uniform binding would create
an unresolvable CPU-GPU ownership conflict.

### The correct approach

A buffer is EITHER a GPU-side resource (`STORAGE`, `UNIFORM`, `VERTEX`, ...) OR a
mappable transfer buffer (`MAP_READ | COPY_DST` or `MAP_WRITE | COPY_SRC`), never
both. To move data between them, use two buffers and a copy command.

```js
// CORRECT: a dedicated staging buffer for readback
const staging = device.createBuffer({
  size: 1024,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
```

## Anti-Pattern 2: Mapping a storage buffer directly to read GPU output

### The mistake

```js
// WRONG: storageBuffer has STORAGE usage and no MAP_READ flag
await storageBuffer.mapAsync(GPUMapMode.READ);
const data = storageBuffer.getMappedRange();
```

### WHY it fails

Storage buffers are created with `STORAGE` (often `STORAGE | COPY_SRC`) and have
no `MAP_READ` flag, because `MAP_READ` cannot be combined with `STORAGE` (see
Anti-Pattern 1). A buffer without `MAP_READ` cannot be mapped: `mapAsync`
rejects. There is no synchronous way to read GPU output either; the GPU may still
be executing operations on the buffer when the CPU asks for the data.

### The correct approach

Copy the storage buffer into a separate staging buffer created with
`COPY_DST | MAP_READ`, submit the copy, then map the staging buffer. `mapAsync`
on the staging buffer resolves only after the GPU finishes the copy, so the data
is guaranteed current.

```js
const staging = device.createBuffer({
  size: storageBuffer.size,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
const encoder = device.createCommandEncoder();
encoder.copyBufferToBuffer(storageBuffer, 0, staging, 0, storageBuffer.size);
queue.submit([encoder.finish()]);
await staging.mapAsync(GPUMapMode.READ);
const result = new Float32Array(staging.getMappedRange().slice(0));
staging.unmap();
```

The complete end-to-end readback workflow lives in `webgpu-impl-buffer-upload`.

## Anti-Pattern 3: Using a getMappedRange ArrayBuffer after unmap

### The mistake

```js
await staging.mapAsync(GPUMapMode.READ);
const view = new Float32Array(staging.getMappedRange());
staging.unmap();
console.log(view[0]);                          // throws TypeError
```

### WHY it fails

`unmap()` detaches every `ArrayBuffer` returned by `getMappedRange`. A detached
`ArrayBuffer` has zero byte length and no backing memory; any typed view over it
throws `TypeError` on access. The `ArrayBuffer` aliases GPU memory only while the
buffer is mapped, and `unmap()` hands that memory back to the GPU.

### The correct approach

Copy the data out of the mapped range BEFORE calling `unmap`. `ArrayBuffer.slice`
or a `TypedArray` copy produces an independent CPU-side array that survives the
unmap.

```js
await staging.mapAsync(GPUMapMode.READ);
const result = new Float32Array(staging.getMappedRange().slice(0));  // copy first
staging.unmap();
console.log(result[0]);                         // safe: result is independent
```

## Anti-Pattern 4: Calling mapAsync on an already-mapped or pending buffer

### The mistake

```js
buffer.mapAsync(GPUMapMode.READ);                // no await; state -> pending
await buffer.mapAsync(GPUMapMode.READ);          // rejects: already mapped
```

Or re-mapping after a previous map without an intervening `unmap`:

```js
await buffer.mapAsync(GPUMapMode.READ);          // state -> mapped
// ... read ...
await buffer.mapAsync(GPUMapMode.READ);          // rejects: already mapped
```

### WHY it fails

A buffer moves through the lifecycle `unmapped -> pending -> mapped`. `mapAsync`
is legal ONLY when `mapState` is `"unmapped"`. Calling it while the buffer is
`"pending"` (a prior `mapAsync` has not resolved) or `"mapped"` (mapped and not
yet unmapped) rejects the promise with a validation error: "buffer is already
mapped". WebGPU forbids two concurrent maps because each map hands CPU ownership
of the buffer, and two owners would race.

### The correct approach

Sequence map and unmap strictly: exactly one `unmap` per `mapAsync`, and never
start a second `mapAsync` before the previous cycle completes. Reading
`buffer.mapState` confirms the buffer is `"unmapped"` before mapping.

```js
if (buffer.mapState === "unmapped") {
  await buffer.mapAsync(GPUMapMode.READ);        // unmapped -> pending -> mapped
  const result = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();                                // mapped -> unmapped
}
```

Inside a render loop, NEVER `await mapAsync` per frame; it stalls GPU-CPU
pipelining. Use a rotating set of staging buffers and read results one or two
frames late. See `webgpu-impl-async-patterns`.

## Anti-Pattern 5: mappedAtCreation with a size that is not a multiple of 4

### The mistake

```js
// WRONG: 30 is not a multiple of 4
const buffer = device.createBuffer({
  size: 30,
  usage: GPUBufferUsage.VERTEX,
  mappedAtCreation: true,
});
```

### WHY it fails

When `mappedAtCreation` is `true`, the spec requires `size` to be a multiple of
4. A non-multiple-of-4 size fails `createBuffer` validation and emits a
`GPUValidationError`. The constraint exists because the mapped range is exposed
to the CPU as 4-byte-aligned typed-array memory.

### The correct approach

Round the buffer size up to the next multiple of 4. Source data such as a
`Float32Array` or `Uint32Array` is already a multiple of 4 bytes; a packed
`Uint8Array` of arbitrary length needs explicit rounding.

```js
const padded = (data.byteLength + 3) & ~3;       // round up to a multiple of 4
const buffer = device.createBuffer({
  size: padded,
  usage: GPUBufferUsage.VERTEX,
  mappedAtCreation: true,
});
new Uint8Array(buffer.getMappedRange()).set(data);
buffer.unmap();
```

The full set of buffer alignment numbers is documented in
`webgpu-core-memory-model`.

## Sources

- W3C WebGPU spec, GPUBuffer: https://www.w3.org/TR/webgpu/#buffer-interface
- W3C WebGPU spec, buffer mapping: https://www.w3.org/TR/webgpu/#buffer-mapping
- MDN GPUDevice.createBuffer: https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createBuffer
- vooronderzoek-webgpu.md PART A section 4, PART C section 4
