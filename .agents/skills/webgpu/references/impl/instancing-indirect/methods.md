# Methods: Instancing and Indirect Draws

WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). Every signature and layout
below is verified against the W3C WebGPU specification and MDN.

## Direct Draw Methods

These are methods on `GPURenderPassEncoder` and `GPURenderBundleEncoder`. They take all
draw parameters as JavaScript arguments.

### draw

```
draw(vertexCount, instanceCount = 1, firstVertex = 0, firstInstance = 0)
```

| Argument | Type | Meaning |
|---|---|---|
| `vertexCount` | `GPUSize32` | Number of vertices processed per instance |
| `instanceCount` | `GPUSize32` | Number of instances drawn |
| `firstVertex` | `GPUSize32` | Index of the first vertex; offsets vertex-buffer reads |
| `firstInstance` | `GPUSize32` | Index of the first instance; becomes the base of `@builtin(instance_index)` |

For a non-indexed instanced draw of N copies, set `instanceCount = N`. A direct
`draw()` accepts any `firstInstance` with NO feature requirement.

### drawIndexed

```
drawIndexed(indexCount, instanceCount = 1, firstIndex = 0, baseVertex = 0, firstInstance = 0)
```

| Argument | Type | Meaning |
|---|---|---|
| `indexCount` | `GPUSize32` | Number of indices processed per instance |
| `instanceCount` | `GPUSize32` | Number of instances drawn |
| `firstIndex` | `GPUSize32` | Offset into the bound index buffer |
| `baseVertex` | `GPUSignedOffset32` | Value added to every index before fetching the vertex |
| `firstInstance` | `GPUSize32` | Base of `@builtin(instance_index)` |

`drawIndexed` requires an index buffer bound via
`setIndexBuffer(buffer, indexFormat, offset?, size?)` where `indexFormat` is
`"uint16"` or `"uint32"`. `baseVertex` lets multiple meshes share one large vertex
buffer; it is signed.

## Indirect Draw Methods

Indirect methods read their draw parameters from a `GPUBuffer` instead of from
JavaScript. This is what enables GPU-driven rendering: a compute shader can compute the
counts and write them into the buffer, and the render pass never needs the values on
the CPU.

### Common requirements for every indirect call

- The `indirectBuffer` usage MUST include `GPUBufferUsage.INDIRECT`.
  - CPU-written record: `GPUBufferUsage.COPY_DST | GPUBufferUsage.INDIRECT`.
  - GPU-written record: add `GPUBufferUsage.STORAGE` so a compute shader can write it,
    typically `INDIRECT | STORAGE | COPY_DST`.
- `indirectOffset` MUST be a multiple of 4.
- `indirectOffset + recordSize` MUST be less than or equal to `indirectBuffer.size`.
- Violating any rule produces a `GPUValidationError` and invalidates the pass encoder.

### drawIndirect

```
drawIndirect(indirectBuffer, indirectOffset)
```

Reads a 16-byte record of 4 tightly packed little-endian `u32` values:

| Byte offset | u32 index | Field | Equivalent direct argument |
|---|---|---|---|
| 0 | 0 | `vertexCount` | `vertexCount` |
| 4 | 1 | `instanceCount` | `instanceCount` |
| 8 | 2 | `firstVertex` | `firstVertex` |
| 12 | 3 | `firstInstance` | `firstInstance` |

Validation: `indirectOffset` multiple of 4; `indirectOffset + 16` within buffer size;
usage contains `INDIRECT`.

### drawIndexedIndirect

```
drawIndexedIndirect(indirectBuffer, indirectOffset)
```

Reads a 20-byte record of 5 tightly packed little-endian `u32` values:

| Byte offset | u32 index | Field | Equivalent direct argument |
|---|---|---|---|
| 0 | 0 | `indexCount` | `indexCount` |
| 4 | 1 | `instanceCount` | `instanceCount` |
| 8 | 2 | `firstIndex` | `firstIndex` |
| 12 | 3 | `baseVertex` | `baseVertex` (signed; stored as the raw u32 bit pattern) |
| 16 | 4 | `firstInstance` | `firstInstance` |

Validation: `indirectOffset` multiple of 4; `indirectOffset + 20` within buffer size;
usage contains `INDIRECT`. An index buffer must be bound with `setIndexBuffer`.

`baseVertex` is a signed value. To encode a negative `baseVertex` from JavaScript,
write it through an `Int32Array` view aliasing the same `ArrayBuffer` as the
`Uint32Array`, because `Uint32Array` cannot hold negatives directly.

### dispatchWorkgroupsIndirect

Method on `GPUComputePassEncoder`.

```
dispatchWorkgroupsIndirect(indirectBuffer, indirectOffset)
```

Reads a 12-byte record of 3 tightly packed little-endian `u32` values, in the same
order as the arguments of `dispatchWorkgroups(x, y, z)`:

| Byte offset | u32 index | Field |
|---|---|---|
| 0 | 0 | `workgroupCountX` |
| 4 | 1 | `workgroupCountY` |
| 8 | 2 | `workgroupCountZ` |

Validation: `indirectOffset` multiple of 4; `indirectOffset + 12` within buffer size;
usage contains `INDIRECT`. Each count is clamped by
`device.limits.maxComputeWorkgroupsPerDimension`.

## The indirect-first-instance Feature

`firstInstance` behaves differently for direct and indirect draws.

| Path | Non-zero `firstInstance` |
|---|---|
| Direct `draw` / `drawIndexed` | Always works, no feature needed |
| `drawIndirect` / `drawIndexedIndirect` | Requires the `indirect-first-instance` feature |

When the `indirect-first-instance` feature is NOT enabled and the indirect record's
`firstInstance` field is non-zero, the indirect draw is treated as a no-op. No
validation error is raised, so this can look like missing geometry.

Request the feature conditionally:

```js
const adapter = await navigator.gpu.requestAdapter();
const hasFirstInstance = adapter.features.has("indirect-first-instance");
const device = await adapter.requestDevice({
  requiredFeatures: hasFirstInstance ? ["indirect-first-instance"] : [],
});
```

If `hasFirstInstance` is false, keep every indirect record's `firstInstance` at 0 and
offset per-instance data by other means (a uniform base index, or a different storage
buffer slice).

## Multi-draw-indirect boundary

`multiDrawIndirect` and `multiDrawIndexedIndirect` are not in the 2026-09 WebGPU
normative API or `GPUFeatureName` enum. Do not generate these methods or a
vendor-prefixed feature string in production WebGPU code.

```js
for (let i = 0; i < drawCount; i++) {
  pass.drawIndexedIndirect(indirectBuffer, i * 20);
}
```

If a project deliberately experiments with a non-standard implementation,
isolate it behind project-owned types, runtime probes, and a standard path. Do
not describe it as WebGPU capability.

## Verified Sources

- https://gpuweb.github.io/gpuweb/ (current WebGPU Editor's Draft)
- https://developer.mozilla.org/en-US/docs/Web/API/GPURenderPassEncoder/drawIndirect
- https://developer.mozilla.org/en-US/docs/Web/API/GPURenderPassEncoder/drawIndexedIndirect
- https://developer.mozilla.org/en-US/docs/Web/API/GPUComputePassEncoder/dispatchWorkgroupsIndirect
- ../../core/webgpu-2026/guidance.md
