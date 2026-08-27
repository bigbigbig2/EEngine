# WebGPU Instancing and Indirect Draws

Draw one mesh thousands of times in a single call, and let the GPU itself decide how
many vertices, instances, or workgroups to process by reading draw parameters from a
buffer instead of from JavaScript.

## Quick Reference

WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

| Indirect call | Buffer size | u32 values, in exact order |
|---|---|---|
| `drawIndirect` | 16 bytes | `vertexCount, instanceCount, firstVertex, firstInstance` |
| `drawIndexedIndirect` | 20 bytes | `indexCount, instanceCount, firstIndex, baseVertex, firstInstance` |
| `dispatchWorkgroupsIndirect` | 12 bytes | `workgroupCountX, workgroupCountY, workgroupCountZ` |

All values are tightly packed little-endian `u32`. The GPU reads EXACTLY this many
bytes starting at `indirectOffset`.

| Method | Signature |
|---|---|
| Non-indexed instanced | `draw(vertexCount, instanceCount, firstVertex, firstInstance)` |
| Indexed instanced | `drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance)` |
| Non-indexed indirect | `drawIndirect(indirectBuffer, indirectOffset)` |
| Indexed indirect | `drawIndexedIndirect(indirectBuffer, indirectOffset)` |
| Indirect dispatch | `dispatchWorkgroupsIndirect(indirectBuffer, indirectOffset)` |

Rules that ALWAYS hold:

- Indirect buffer usage MUST include `GPUBufferUsage.INDIRECT`. The common combination
  is `COPY_DST | INDIRECT`. For a GPU-written buffer, add `STORAGE`.
- `indirectOffset` MUST be a multiple of 4.
- A non-zero `firstInstance` in an INDIRECT draw requires the `indirect-first-instance`
  feature. Without it the value is forced to 0 (silent no-op, not an error).
- `firstInstance` in a DIRECT `draw` / `drawIndexed` call works without any feature.

## Decision Tree

```
Drawing many copies of one mesh?
├─ Counts and per-instance data known on the CPU
│  └─ Direct instanced draw: draw / drawIndexed with instanceCount.
│     Per-instance data → vertex buffer stepMode "instance"
│     OR storage buffer indexed by @builtin(instance_index).
│
├─ Counts decided on the GPU (culling, particle spawn, LOD)
│  └─ Indirect draw: a compute pass writes the indirect buffer,
│     the render pass reads it with drawIndirect / drawIndexedIndirect.
│     No CPU readback of the count.
│
├─ Compute dispatch size decided on the GPU
│  └─ dispatchWorkgroupsIndirect, buffer written by a prior pass.
│
└─ Hundreds of distinct meshes, each with its own indirect record
   └─ One indirect record per mesh in an array buffer; loop
      drawIndexedIndirect with a stepping indirectOffset.
      Chrome 131+ only: multiDrawIndexedIndirect collapses the loop
      into one call. Feature-gate it, never assume availability.
```

Instancing answers "how do I draw the same thing many times". Indirect answers "how do
I draw without the CPU knowing the count". GPU-driven rendering combines both.

## Core Patterns

### Pattern 1: ALWAYS pass instanceCount, never loop draw calls

NEVER call `draw()` once per object in a loop when the objects share a mesh. ALWAYS
issue one instanced draw.

```js
// 5000 copies of a 36-vertex cube in ONE call.
pass.setPipeline(pipeline);
pass.setVertexBuffer(0, cubeVertices);
pass.draw(36, 5000, 0, 0); // vertexCount, instanceCount, firstVertex, firstInstance
```

### Pattern 2: ALWAYS choose one per-instance data path

Per-instance attributes (model matrix, color) live EITHER in a vertex buffer with
`stepMode: "instance"` OR in a storage buffer read by `@builtin(instance_index)`.

```js
// Vertex-buffer path: advances once per instance, not per vertex.
const layout = {
  arrayStride: 16,           // one vec4 per instance
  stepMode: "instance",      // NEVER "vertex" for per-instance data
  attributes: [{ shaderLocation: 2, offset: 0, format: "float32x4" }],
};
```

```wgsl
// Storage-buffer path: index the buffer by the instance.
@group(0) @binding(0) var<storage, read> instances: array<mat4x4f>;
@vertex fn vs(@builtin(instance_index) i: u32, @location(0) pos: vec3f)
  -> @builtin(position) vec4f {
  return instances[i] * vec4f(pos, 1.0);
}
```

`instance_index` ALWAYS includes the draw's `firstInstance` base offset.

### Pattern 3: ALWAYS write the full indirect record

NEVER leave indirect buffer bytes uninitialized. The GPU reads every byte of the
record. Write all 4 (or 5, or 3) `u32` values, including zeros.

```js
// drawIndirect: 4 values, 16 bytes. All four MUST be written.
const params = new Uint32Array([36, 5000, 0, 0]);
const indirectBuffer = device.createBuffer({
  size: 16,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.INDIRECT,
});
device.queue.writeBuffer(indirectBuffer, 0, params);
pass.drawIndirect(indirectBuffer, 0); // offset MUST be a multiple of 4
```

### Pattern 4: ALWAYS match the stride to the draw kind

A non-indexed `drawIndirect` record is 16 bytes. An indexed `drawIndexedIndirect`
record is 20 bytes. NEVER reuse one stride for the other call.

```js
// Indexed indirect: 5 values, 20 bytes.
const indexed = new Uint32Array([indexCount, 5000, 0, 0, 0]);
const buf = device.createBuffer({ size: 20,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.INDIRECT });
device.queue.writeBuffer(buf, 0, indexed);
pass.setIndexBuffer(indexBuffer, "uint32");
pass.drawIndexedIndirect(buf, 0);
```

### Pattern 5: ALWAYS feature-gate firstInstance in indirect draws

A non-zero `firstInstance` inside an indirect record requires the
`indirect-first-instance` feature. ALWAYS request it conditionally and keep
`firstInstance` at 0 when it is absent.

```js
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice({
  requiredFeatures: adapter.features.has("indirect-first-instance")
    ? ["indirect-first-instance"] : [],
});
```

### Pattern 6: ALWAYS let the GPU write the indirect buffer for GPU-driven rendering

A compute pass culls and writes the indirect buffer. The render pass in the SAME
`queue.submit` reads it. NEVER read the count back to the CPU.

```js
const indirectBuffer = device.createBuffer({
  size: 20, // drawIndexedIndirect record
  usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});
const encoder = device.createCommandEncoder();
const cull = encoder.beginComputePass();
cull.setPipeline(cullPipeline);   // shader writes instanceCount into the buffer
cull.setBindGroup(0, cullBindGroup);
cull.dispatchWorkgroups(Math.ceil(objectCount / 64));
cull.end();
const draw = encoder.beginRenderPass(renderPassDesc);
draw.setPipeline(drawPipeline);
draw.setIndexBuffer(indexBuffer, "uint32");
draw.drawIndexedIndirect(indirectBuffer, 0);
draw.end();
device.queue.submit([encoder.finish()]); // encoder orders compute before render
```

## Common Anti-Patterns

1. **Using a 20-byte stride for a non-indexed `drawIndirect` (or 16 for indexed).**
   WHY it fails: the GPU reads exactly 16 bytes for `drawIndirect` and exactly 20 for
   `drawIndexedIndirect`. A wrong stride misaligns the next record, so `firstVertex` /
   `baseVertex` / `firstInstance` are read from garbage, producing corrupt geometry or
   a validation error.

2. **Leaving indirect buffer bytes uninitialized.** WHY it fails: writing only
   `vertexCount` and `instanceCount` leaves `firstVertex` and `firstInstance` as
   undefined memory; the GPU still reads them, causing out-of-range vertex fetches.

3. **A non-zero `firstInstance` in an indirect draw without the
   `indirect-first-instance` feature.** WHY it fails: the value is silently forced to
   0. The draw renders, no error fires, and instances appear at the wrong base offset
   with no diagnostic.

## Critical Warnings

- NEVER call `draw()` in a per-object CPU loop for objects that share a mesh. Use
  `instanceCount`.
- NEVER pass an `indirectOffset` that is not a multiple of 4. It fails validation and
  invalidates the pass encoder.
- NEVER reuse a 16-byte stride for `drawIndexedIndirect` or a 20-byte stride for
  `drawIndirect`.
- NEVER omit any `u32` field from an indirect record. Write zeros explicitly.
- NEVER assume `multiDrawIndirect` / `multiDrawIndexedIndirect` exist. They are
  experimental, Chrome 131+, behind the `chromium-experimental-multi-draw-indirect`
  feature. Always feature-detect and provide the loop-of-drawIndirect path.
- NEVER read the GPU-written indirect count back to the CPU in the render frame. The
  command encoder already orders the compute pass before the render pass.
- NEVER set `stepMode: "vertex"` on a vertex buffer that holds per-instance data. The
  attribute would advance per vertex and every instance would look identical.

## Reference Files

- `methods.md` : full signatures for `draw`, `drawIndexed`, `drawIndirect`,
  `drawIndexedIndirect`, `dispatchWorkgroupsIndirect`, exact buffer layouts, the
  `indirect-first-instance` feature, and experimental `multiDrawIndirect`.
- `examples.md` : verified working code for instanced draw, indirect draw
  with a populated buffer, and a GPU-driven cull plus indirect render.
- `anti-patterns.md` : mistakes with WHY-it-fails analysis.

Related skills: `webgpu-syntax-render-pipeline` (vertex buffer layouts, stepMode),
`webgpu-syntax-compute-pipeline` (compute passes that write indirect buffers),
`webgpu-wgsl-vertex-shaders` (`@builtin(instance_index)`, per-instance attributes),
`webgpu-impl-performance` (when GPU-driven rendering pays off, render bundles),
`webgpu-impl-compute-usecases` (particle systems feeding indirect draws).
