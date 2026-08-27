# Compute Pipeline Anti-Patterns

WebGPU 1.0-stable. Each anti-pattern lists the WRONG code, WHY it fails, and the
CORRECT replacement. Verified against the W3C WebGPU specification and the
project vooronderzoek (PART A section 3, PART C sections 3 and 6).

## 1. Passing invocation counts to dispatchWorkgroups

### Wrong

```js
const elementCount = 100_000;
pass.dispatchWorkgroups(elementCount);   // launches 100000 workgroups
```

### Why it fails

`dispatchWorkgroups` arguments are WORKGROUP counts, not invocation counts. With
a WGSL `@workgroup_size(64)`, this launches `100000 * 64 = 6,400,000`
invocations. The shader's `global_invocation_id.x` ranges far past `100000`, so
all but the first 100000 invocations read and write out of bounds. The result is
corrupt data, a robustness clamp, or a validation failure, plus a 64x compute
overcost.

### Correct

```js
const WG = 64;
const elementCount = 100_000;
const workgroupCount = Math.ceil(elementCount / WG);   // 1563
pass.dispatchWorkgroups(workgroupCount);
```

Total invocations = `1563 * 64 = 100,032`, which covers all 100000 elements with
a 32-invocation remainder that the shader guards.

## 2. No remainder guard when dataSize is not a multiple of workgroup size

### Wrong

```wgsl
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  data[gid.x] = data[gid.x] * 2.0;   // no bounds check
}
```

### Why it fails

`Math.ceil(dataSize / 64)` rounds the workgroup count up so every element is
covered. The cost is that the final workgroup still launches a full 64
invocations. For `dataSize = 100`, the dispatch launches `ceil(100/64) * 64 =
128` invocations; invocations 100..127 have no valid element. Without a guard,
`data[gid.x]` for `gid.x >= 100` writes past the array. WebGPU's bounds-checking
clamps or discards the access, but the logic is still wrong and neighboring data
or other buffers can be corrupted depending on the binding.

### Correct

```wgsl
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&data)) { return; }   // guard the ceil remainder
  data[i] = data[i] * 2.0;
}
```

ALWAYS add the `if (index >= dataSize) { return; }` guard. Use `arrayLength` for
runtime-sized storage arrays, or a uniform that carries the explicit count.

## 3. Exceeding maxComputeWorkgroupsPerDimension

### Wrong

```js
// 20 million elements, @workgroup_size(64)
const workgroupCount = Math.ceil(20_000_000 / 64);   // 312500
pass.dispatchWorkgroups(workgroupCount);             // 312500 > 65535
```

### Why it fails

Each of `dispatchWorkgroups`'s `x`, `y`, `z` arguments MUST NOT exceed
`device.limits.maxComputeWorkgroupsPerDimension` (spec default 65535). A 1D
dispatch of 312500 workgroups exceeds the limit on the X axis and produces a
`GPUValidationError`; the dispatch does not run.

### Correct

```js
const max = device.limits.maxComputeWorkgroupsPerDimension;   // 65535
const total = Math.ceil(20_000_000 / 64);                     // 312500
if (total <= max) {
  pass.dispatchWorkgroups(total);
} else {
  const x = max;
  const y = Math.ceil(total / max);            // 5
  pass.dispatchWorkgroups(x, y);               // 65535 x 5
}
```

The shader then linearizes the 2D workgroup grid:
`workgroupIndex = workgroup_id.x + workgroup_id.y * x`. ALWAYS read the limit
from `device.limits`; an adapter may report a higher maximum.

## 4. Wrong indirect buffer stride for dispatchWorkgroupsIndirect

### Wrong

```js
// reusing a draw-indirect layout (16 bytes, 4 u32) for a dispatch
const indirectBuffer = device.createBuffer({
  size: 16,
  usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(
  indirectBuffer, 0,
  new Uint32Array([countX, countY, countZ, 0]),   // 4 values
);
pass.dispatchWorkgroupsIndirect(indirectBuffer, 0);
```

### Why it fails

`dispatchWorkgroupsIndirect` reads exactly 3 consecutive `u32` values (12 bytes):
`workgroupCountX`, `workgroupCountY`, `workgroupCountZ`. A 16-byte draw-indirect
layout (`vertexCount, instanceCount, firstVertex, firstInstance`) or a 20-byte
indexed-draw layout puts the wrong values into the three workgroup counts. If a
later read uses `indirectOffset` assuming a 16-byte stride, the GPU reads the
wrong 12 bytes entirely. The dispatch then runs the wrong number of workgroups or
fails validation against `maxComputeWorkgroupsPerDimension`.

### Correct

```js
const indirectBuffer = device.createBuffer({
  label: "dispatch-args",
  size: 12,                                       // exactly 3 * u32
  usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(
  indirectBuffer, 0,
  new Uint32Array([countX, countY, countZ]),      // exactly 3 values
);
pass.dispatchWorkgroupsIndirect(indirectBuffer, 0);
```

The dispatch-indirect payload is 12 bytes. The draw-indirect (16 bytes) and
indexed-draw-indirect (20 bytes) layouts are different and NEVER interchangeable.

## 5. indirectOffset not a multiple of 4, or missing INDIRECT usage

### Wrong

```js
const buffer = device.createBuffer({
  size: 64,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,   // no INDIRECT
});
pass.dispatchWorkgroupsIndirect(buffer, 6);                  // 6 not multiple of 4
```

### Why it fails

Two distinct validation errors. First, `indirectBuffer` MUST carry the
`GPUBufferUsage.INDIRECT` flag; a buffer without it cannot be the source of an
indirect dispatch. Second, `indirectOffset` MUST be a multiple of 4 because the
payload is `u32`-aligned; an offset of 6 is rejected.

### Correct

```js
const buffer = device.createBuffer({
  size: 64,
  usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});
pass.dispatchWorkgroupsIndirect(buffer, 8);   // INDIRECT set, offset multiple of 4
```

## 6. Recreating the compute pipeline every frame

### Wrong

```js
function frame() {
  const pipeline = device.createComputePipeline({   // rebuilt every frame
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });
  // ... encode and dispatch
  requestAnimationFrame(frame);
}
```

### Why it fails

`GPUComputePipeline` is immutable and expensive to build: it compiles and
translates the shader. Recreating it per frame burns CPU on redundant
compilation and causes visible jank. The synchronous `createComputePipeline`
also blocks the content timeline.

### Correct

```js
// Create once at load time, off the content timeline.
const pipeline = await device.createComputePipelineAsync({
  label: "sim-pipeline",
  layout: "auto",
  compute: { module, entryPoint: "main" },
});

function frame() {
  // reuse the cached pipeline; only the encoder and pass are per-frame
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(workgroupCount);
  pass.end();
  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(frame);
}
```

ALWAYS create pipelines once and reuse them. See webgpu-core-pipeline-architecture.

## 7. Dispatching before setting the pipeline or bind groups

### Wrong

```js
const pass = encoder.beginComputePass();
pass.dispatchWorkgroups(workgroupCount);   // no pipeline set
pass.end();
```

### Why it fails

A dispatch requires an active `GPUComputePipeline` and every bind group its
layout declares. Dispatching with no pipeline set, or with a required bind group
unbound, is a `GPUValidationError`.

### Correct

```js
const pass = encoder.beginComputePass({ label: "sim-pass" });
pass.setPipeline(pipeline);                 // first
pass.setBindGroup(0, bindGroup0);           // every required group
pass.setBindGroup(1, bindGroup1);
pass.dispatchWorkgroups(workgroupCount);    // then dispatch
pass.end();
```

## 8. Confusing @workgroup_size with the dispatch count

### Wrong

```wgsl
@compute @workgroup_size(1)         // workgroup of 1 invocation
fn main(@builtin(global_invocation_id) gid: vec3<u32>) { /* ... */ }
```

```js
pass.dispatchWorkgroups(elementCount);   // one workgroup per element
```

### Why it fails

Setting `@workgroup_size(1)` and dispatching one workgroup per element launches
one invocation per workgroup. GPUs execute invocations in subgroups (commonly 32
or 64 wide); a workgroup of 1 wastes most of every subgroup lane and runs far
slower than a properly sized workgroup. The `@workgroup_size` and the dispatch
count are SEPARATE: the workgroup size is fixed in the shader, the dispatch count
is `ceil(dataSize / workgroupSize)`.

### Correct

```wgsl
@compute @workgroup_size(64)        // 64 invocations per workgroup
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= arrayLength(&data)) { return; }
  // ...
}
```

```js
const workgroupCount = Math.ceil(elementCount / 64);
pass.dispatchWorkgroups(workgroupCount);
```

Choose `@workgroup_size` so its product is a multiple of the hardware subgroup
width; 64 is a robust portable default. See webgpu-wgsl-compute-shaders.

## 9. Reading a compute-written buffer on the CPU without ordering

### Wrong

```js
const encoder = device.createCommandEncoder();
const pass = encoder.beginComputePass();
pass.setPipeline(pipeline);
pass.setBindGroup(0, bindGroup);
pass.dispatchWorkgroups(workgroupCount);
pass.end();
device.queue.submit([encoder.finish()]);

await readBuffer.mapAsync(GPUMapMode.READ);   // may map before the GPU finishes
const result = new Float32Array(readBuffer.getMappedRange());
```

### Why it fails

`mapAsync` resolves when the buffer is mappable, but if the staging copy was not
itself submitted and ordered after the compute pass, the mapped data can be
stale. The fix is to issue the `copyBufferToBuffer` into the `MAP_READ` staging
buffer inside (or after) the same submission, so the encoder orders the copy
after the dispatch.

### Correct

```js
const encoder = device.createCommandEncoder();
const pass = encoder.beginComputePass();
pass.setPipeline(pipeline);
pass.setBindGroup(0, bindGroup);
pass.dispatchWorkgroups(workgroupCount);
pass.end();
encoder.copyBufferToBuffer(dataBuffer, 0, readBuffer, 0, byteSize);   // ordered after the pass
device.queue.submit([encoder.finish()]);

await readBuffer.mapAsync(GPUMapMode.READ);
const result = new Float32Array(readBuffer.getMappedRange().slice(0));
readBuffer.unmap();
```

Storage buffers cannot be mapped directly; ALWAYS copy into a separate
`COPY_DST | MAP_READ` staging buffer. See webgpu-impl-compute-usecases.
