# WebGPU Buffers

Create `GPUBuffer` objects, pick legal `GPUBufferUsage` flag combinations, and
upload or read back data without triggering WebGPU validation errors.

## Quick Reference

WebGPU 1.0-stable baseline: Chrome 113+, Safari 26+, Firefox 141+.

`device.createBuffer({ label?, size, usage, mappedAtCreation? })` returns a
`GPUBuffer`. `size` is in bytes. `usage` is a bitmask of `GPUBufferUsage` flags
combined with `|`.

| GPUBufferUsage flag | Purpose | Combines with |
|---------------------|---------|---------------|
| `MAP_READ` | CPU reads the buffer after `mapAsync` | ONLY `COPY_DST` |
| `MAP_WRITE` | CPU writes the buffer after `mapAsync` | ONLY `COPY_SRC` |
| `COPY_SRC` | Source of a GPU copy command | any flag |
| `COPY_DST` | Destination of a copy or `queue.writeBuffer` | any flag |
| `INDEX` | Bound as an index buffer | any except `MAP_*` |
| `VERTEX` | Bound as a vertex buffer | any except `MAP_*` |
| `UNIFORM` | Bound as a uniform buffer binding | any except `MAP_*` |
| `STORAGE` | Bound as a storage buffer binding | any except `MAP_*` |
| `INDIRECT` | Source of `drawIndirect` / `dispatchWorkgroupsIndirect` | any except `MAP_*` |
| `QUERY_RESOLVE` | Destination of `resolveQuerySet` | any except `MAP_*` |

Hard rule: `MAP_READ` may ONLY be combined with `COPY_DST`; `MAP_WRITE` may ONLY
be combined with `COPY_SRC`. Any other flag mixed with a `MAP_*` flag fails
`createBuffer` validation.

| GPUBuffer member | Signature | Notes |
|------------------|-----------|-------|
| `mapAsync` | `mapAsync(mode, offset?, size?)` -> `Promise<undefined>` | `mode` is `GPUMapMode.READ` or `GPUMapMode.WRITE` |
| `getMappedRange` | `getMappedRange(offset?, size?)` -> `ArrayBuffer` | Valid ONLY while `mapState === "mapped"` |
| `unmap` | `unmap()` -> `undefined` | Detaches every `getMappedRange` `ArrayBuffer` |
| `destroy` | `destroy()` -> `undefined` | Frees GPU memory; buffer becomes unusable |
| `mapState` | read-only property | `"unmapped"` \| `"pending"` \| `"mapped"` |
| `size` / `usage` | read-only properties | byte size and the usage bitmask |

`queue.writeBuffer(buffer, bufferOffset, data, dataOffset?, size?)` is the
simplest CPU-to-GPU upload path. The buffer needs `COPY_DST`.

Buffer alignment numbers (offset multiples, `size` multiple of 4, the 256-byte
rules) live in `webgpu-core-memory-model`. This skill does NOT duplicate them.

## Decision Tree

```
Need to get data into a GPUBuffer?
├── Data is known at creation time (static vertices, indices, constants)?
│   └── createBuffer({ mappedAtCreation: true }), write via getMappedRange,
│       then unmap. size MUST be a multiple of 4. No COPY_DST needed.
│
├── Data changes over time, CPU-side (per-frame uniforms, dynamic vertices)?
│   └── createBuffer with COPY_DST in usage, upload via
│       queue.writeBuffer(buffer, offset, data). No mapping involved.
│
└── Data must travel GPU -> CPU (compute result, screenshot, picking)?
    ├── The source is a STORAGE buffer -> it CANNOT be mapped.
    │   Create a separate staging buffer with COPY_DST | MAP_READ,
    │   copyBufferToBuffer into it, submit, THEN map the staging buffer.
    │   Full workflow: webgpu-impl-buffer-upload.
    └── On the staging buffer: await mapAsync(GPUMapMode.READ),
        getMappedRange, copy the data out, unmap.
```

## Core Patterns

### Pattern 1: ALWAYS use mappedAtCreation for static initial data

`mappedAtCreation: true` returns a buffer already mapped for writing, with NO
`COPY_DST` flag required. ALWAYS use it for vertex, index, and constant data
known up front. The `size` MUST be a multiple of 4.

```js
const vertices = new Float32Array([
  0.0, 0.5,  -0.5, -0.5,  0.5, -0.5,
]);
const vertexBuffer = device.createBuffer({
  label: "triangle-vertices",
  size: vertices.byteLength,                 // multiple of 4
  usage: GPUBufferUsage.VERTEX,              // no COPY_DST needed
  mappedAtCreation: true,
});
new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
vertexBuffer.unmap();                        // hand the buffer to the GPU
```

### Pattern 2: ALWAYS use queue.writeBuffer for CPU-driven updates

`queue.writeBuffer` is the simplest path for data that changes over time. The
buffer MUST include `COPY_DST`. NEVER add `MAP_WRITE` for this case.

```js
const uniformBuffer = device.createBuffer({
  label: "camera-uniforms",
  size: 64,                                  // one mat4x4<f32>
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
queue.writeBuffer(uniformBuffer, 0, cameraMatrix);   // bufferOffset 0
```

### Pattern 3: NEVER combine MAP_READ or MAP_WRITE with non-copy usage

`MAP_READ` is legal ONLY with `COPY_DST`; `MAP_WRITE` is legal ONLY with
`COPY_SRC`. NEVER write `MAP_READ | STORAGE`, `MAP_READ | VERTEX`, or
`MAP_WRITE | UNIFORM`. Such a combination fails `createBuffer` validation.

```js
// CORRECT: a readback staging buffer
const staging = device.createBuffer({
  size: 256,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
// WRONG: GPUBufferUsage.MAP_READ | GPUBufferUsage.STORAGE -> validation error
```

### Pattern 4: ALWAYS map a staging buffer to read GPU output

A `STORAGE` buffer CANNOT be mapped. To read GPU output, copy it into a separate
buffer created with `COPY_DST | MAP_READ`, submit the copy, then map.

```js
const stagingBuffer = device.createBuffer({
  size: storageBuffer.size,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
const encoder = device.createCommandEncoder();
encoder.copyBufferToBuffer(storageBuffer, 0, stagingBuffer, 0, storageBuffer.size);
queue.submit([encoder.finish()]);

await stagingBuffer.mapAsync(GPUMapMode.READ);
const result = new Float32Array(stagingBuffer.getMappedRange().slice(0));
stagingBuffer.unmap();                       // `result` was copied out first
```

### Pattern 5: NEVER use a getMappedRange ArrayBuffer after unmap

`unmap()` detaches every `ArrayBuffer` returned by `getMappedRange`. ALWAYS copy
the data out (`.slice(0)` or a typed-array copy) BEFORE calling `unmap`. Any
access to the detached buffer afterwards throws `TypeError`.

```js
await staging.mapAsync(GPUMapMode.READ);
const view = new Uint32Array(staging.getMappedRange());
const copy = view.slice();                   // copy BEFORE unmap
staging.unmap();
// `view` is now detached; reading view[0] throws TypeError. Use `copy`.
```

### Pattern 6: NEVER call mapAsync on a pending or mapped buffer

The buffer mapping lifecycle is `unmapped -> pending -> mapped`. `mapAsync`
transitions `unmapped -> pending`; the promise resolving transitions
`pending -> mapped`; `unmap()` returns it to `unmapped`. Calling `mapAsync`
again before `unmap()` rejects with "buffer is already mapped".

```js
if (buffer.mapState === "unmapped") {
  await buffer.mapAsync(GPUMapMode.READ);    // safe: only map an unmapped buffer
  // ... read via getMappedRange ...
  buffer.unmap();
}
```

## Common Anti-Patterns

1. `usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.STORAGE` (or `UNIFORM`, or
   `VERTEX`). WHY it fails: `MAP_READ` is legal ONLY with `COPY_DST`. The spec
   rejects every other pairing and `createBuffer` produces an invalid buffer.

2. Calling `mapAsync` (or attempting `getMappedRange`) directly on a `STORAGE`
   buffer to read a compute result. WHY it fails: storage buffers lack a `MAP_*`
   flag, so they cannot be mapped. The GPU output must be copied into a separate
   `COPY_DST | MAP_READ` staging buffer first.

3. Reading the `getMappedRange` `ArrayBuffer` after `unmap()`. WHY it fails:
   `unmap()` detaches the `ArrayBuffer`; any typed view over it throws
   `TypeError`. Copy the data out before unmapping.

## Critical Warnings

- NEVER combine `MAP_READ` with anything except `COPY_DST`, or `MAP_WRITE` with
  anything except `COPY_SRC`. Every other pairing fails `createBuffer` validation.
- NEVER pass a `size` that is not a multiple of 4 to `createBuffer` when
  `mappedAtCreation` is `true`.
- NEVER call `mapAsync` on a buffer whose `mapState` is `"pending"` or
  `"mapped"`. It rejects with "buffer is already mapped".
- NEVER use an `ArrayBuffer` from `getMappedRange` after `unmap()`. `unmap()`
  detaches it; reads and writes throw `TypeError`.
- NEVER try to map a `STORAGE` or `UNIFORM` buffer. They have no `MAP_*` flag.
  Read GPU output through a `COPY_DST | MAP_READ` staging buffer.
- NEVER `await mapAsync` or `onSubmittedWorkDone` inside the render loop. It
  stalls GPU-CPU pipelining; see `webgpu-impl-async-patterns`.

## Reference Files

- `methods.md` : `createBuffer` and its descriptor, the full
  `GPUBufferUsage` flag table, every `GPUBuffer` method, `GPUMapMode`, and the
  `queue.writeBuffer` signature.
- `examples.md` : verified code for a `mappedAtCreation` vertex
  buffer, a `writeBuffer` uniform buffer, and a `mapAsync` readback.
- `anti-patterns.md` : buffer mistakes with WHY-it-fails explanations.

## Related Skills

- `webgpu-core-memory-model` : the exact alignment numbers (size multiple of 4,
  offset multiples, the 256-byte `bytesPerRow` rule) referenced by this skill.
- `webgpu-impl-buffer-upload` : `writeBuffer` vs `mappedAtCreation` vs a staging
  ring, and the full staging-buffer GPU-to-CPU readback workflow.
- `webgpu-impl-async-patterns` : the `mapState` lifecycle in the frame loop and
  why never to block on `mapAsync` per frame.
- `webgpu-syntax-bind-groups` : binding `UNIFORM` and `STORAGE` buffers into a
  `GPUBindGroup`.
