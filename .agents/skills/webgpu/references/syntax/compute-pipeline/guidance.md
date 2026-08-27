# WebGPU Compute Pipeline

Create a compute pipeline, encode a compute pass, and dispatch workgroups with
correct workgroup-count math. WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## Quick Reference

### GPUComputePipelineDescriptor (`device.createComputePipeline(descriptor)`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `label` | string | No | ALWAYS set it. Appears in `GPUError` messages. |
| `layout` | `GPUPipelineLayout` or `"auto"` | Yes | `"auto"` layouts bind to this pipeline ONLY. |
| `compute` | object | Yes | The single `@compute` stage. |
| `compute.module` | `GPUShaderModule` | Yes | WGSL module with a `@compute` entry point. |
| `compute.entryPoint` | string | No | Omit only when the module has exactly one `@compute` function. |
| `compute.constants` | record | No | Override values for WGSL `override` constants, keyed by `@id` or name. |

`createComputePipelineAsync(descriptor)` returns `Promise<GPUComputePipeline>` and
compiles off the content timeline. `createComputePipeline(descriptor)` returns a
`GPUComputePipeline` synchronously.

### GPUComputePassEncoder methods (from `encoder.beginComputePass({ label?, timestampWrites? })`)

| Method | Signature | Notes |
|--------|-----------|-------|
| `setPipeline` | `setPipeline(pipeline)` | Set the active `GPUComputePipeline` before dispatching. |
| `setBindGroup` | `setBindGroup(index, bindGroup, dynamicOffsets?)` | Bind resources at a group index. |
| `dispatchWorkgroups` | `dispatchWorkgroups(x, y?, z?)` | `y` and `z` default to 1. Arguments are WORKGROUP counts. |
| `dispatchWorkgroupsIndirect` | `dispatchWorkgroupsIndirect(buffer, offset?)` | `offset` defaults to 0, MUST be a multiple of 4. |
| `end` | `end()` | Closes the pass. Returns nothing. Call before `encoder.finish()`. |

## Decision Tree

### Direct vs indirect dispatch

```
Is the workgroup count known on the CPU when you encode the command?
├── YES (count is a JS number or a known constant)
│      ALWAYS use dispatchWorkgroups(x, y, z).
└── NO (count is produced by an earlier GPU pass, e.g. live particle count)
       ALWAYS use dispatchWorkgroupsIndirect(buffer, offset).
       The buffer holds 3 u32: workgroupCountX, Y, Z (12 bytes).
       Avoids a CPU readback round-trip.
```

### Sizing the dispatch grid

```
You have N data elements and a WGSL @workgroup_size(WG).
├── dispatchWorkgroups arguments are WORKGROUP counts, NEVER element counts.
├── workgroupCount = Math.ceil(N / WG)
├── total invocations launched = workgroupCount * WG  (>= N, with a remainder)
└── The shader MUST guard: if (global_invocation_id.x >= N) { return; }
        because the last workgroup launches WG invocations even when N is not
        a multiple of WG.
```

## Core Patterns

### Pattern 1: ALWAYS pass workgroup counts to dispatchWorkgroups, NEVER invocation counts

`dispatchWorkgroups(x, y, z)` arguments are the number of WORKGROUPS, not the
number of shader invocations. Total invocations = `x * y * z * (@workgroup_size product)`.

```js
const WG = 64;                          // matches WGSL @workgroup_size(64)
const elementCount = 100_000;
const workgroupCount = Math.ceil(elementCount / WG);   // 1563, NOT 100000
pass.dispatchWorkgroups(workgroupCount);
```

NEVER write `dispatchWorkgroups(elementCount)`. That launches `elementCount`
workgroups, each running 64 invocations, which is 64x too much work and reads
far out of bounds.

### Pattern 2: ALWAYS compute the grid with ceil and guard the remainder in the shader

`Math.ceil(N / WG)` rounds up so every element is covered. The final workgroup
then launches invocations past `N`. The WGSL shader MUST bounds-check.

```wgsl
@group(0) @binding(0) var<storage, read_write> data: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&data)) { return; }   // guard the ceil remainder
  data[i] = data[i] * 2.0;
}
```

NEVER omit the index guard. Without it the extra invocations write out of bounds.

### Pattern 3: ALWAYS check maxComputeWorkgroupsPerDimension before a large dispatch

Each of `x`, `y`, `z` MUST NOT exceed `device.limits.maxComputeWorkgroupsPerDimension`
(spec default 65535). A 1D dispatch over a large array can exceed it.

```js
const max = device.limits.maxComputeWorkgroupsPerDimension;
let count = Math.ceil(elementCount / WG);
if (count > max) {
  // spread the count across the X and Y dimensions
  const x = max;
  const y = Math.ceil(count / max);
  pass.dispatchWorkgroups(x, y);          // shader must linearize x + y * x
} else {
  pass.dispatchWorkgroups(count);
}
```

### Pattern 4: ALWAYS set pipeline and bind groups before dispatching

The encoder validates that a pipeline is set and that every bind group required
by the pipeline layout is bound at dispatch time.

```js
const pass = encoder.beginComputePass({ label: "double-pass" });
pass.setPipeline(computePipeline);        // first
pass.setBindGroup(0, bindGroup);          // then every required group
pass.dispatchWorkgroups(workgroupCount);  // then dispatch
pass.end();                               // then end, before encoder.finish()
```

### Pattern 5: ALWAYS give the indirect buffer INDIRECT usage and a 12-byte payload

`dispatchWorkgroupsIndirect` reads exactly 3 consecutive `u32` values
(`workgroupCountX`, `workgroupCountY`, `workgroupCountZ` = 12 bytes) starting at
`indirectOffset`. The buffer MUST be created with `GPUBufferUsage.INDIRECT`.

```js
const indirectBuffer = device.createBuffer({
  label: "dispatch-args",
  size: 12,                                       // 3 * u32
  usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});
// a prior compute pass writes [countX, countY, countZ] into this buffer
pass.dispatchWorkgroupsIndirect(indirectBuffer, 0);   // offset multiple of 4
```

### Pattern 6: ALWAYS use createComputePipelineAsync for heavy compilation at load time

`createComputePipelineAsync` compiles off the content timeline so the frame loop
does not stall. Use it during loading. See webgpu-core-pipeline-architecture.

```js
const pipeline = await device.createComputePipelineAsync({
  label: "physics-step",
  layout: "auto",
  compute: { module, entryPoint: "main" },
});
```

## Common Anti-Patterns

1. **Passing invocation counts to `dispatchWorkgroups`.** Writing
   `dispatchWorkgroups(elementCount)` instead of `dispatchWorkgroups(ceil(elementCount / WG))`
   launches `WG` times too many workgroups. WHY it fails: total invocations =
   `workgroupCount * @workgroup_size`, so the GPU runs `elementCount * WG` invocations.

2. **No remainder guard in the shader.** `Math.ceil(N / WG)` makes the last
   workgroup launch invocations past `N`. WHY it fails: without
   `if (gid.x >= N) { return; }` those invocations write out of bounds and corrupt
   data or trigger a robustness clamp.

3. **Wrong indirect buffer stride.** Using a 16-byte or 20-byte payload for
   `dispatchWorkgroupsIndirect`. WHY it fails: the GPU reads exactly 12 bytes
   (3 u32); a draw-indirect layout (16 or 20 bytes) puts the wrong values into
   `workgroupCountX/Y/Z`.

## Critical Warnings

- NEVER pass shader-invocation counts to `dispatchWorkgroups`. The arguments are
  WORKGROUP counts. Total invocations = `workgroupCount * @workgroup_size`.
- NEVER omit the `if (index >= dataSize) { return; }` guard in the WGSL shader
  when the data size is not a multiple of `@workgroup_size`.
- NEVER let any of `x`, `y`, `z` exceed `device.limits.maxComputeWorkgroupsPerDimension`.
  It is a validation error.
- NEVER use a 16-byte or 20-byte indirect payload for `dispatchWorkgroupsIndirect`.
  It reads exactly 3 u32 (12 bytes).
- NEVER call `dispatchWorkgroupsIndirect` with an `indirectOffset` that is not a
  multiple of 4, or with a buffer that lacks `GPUBufferUsage.INDIRECT`.
- NEVER confuse the WGSL `@workgroup_size` with the dispatch count. They are
  separate. `@workgroup_size` is fixed in the shader; the dispatch count is the
  number of workgroups. See webgpu-wgsl-compute-shaders.
- NEVER call `encoder.finish()` while a compute pass is still open. Call
  `pass.end()` first.

## Reference Files

- `methods.md` : `createComputePipeline`, `GPUComputePipelineDescriptor`,
  and every `GPUComputePassEncoder` method with full signatures and constraints.
- `examples.md` : verified end-to-end compute pipeline, indirect
  dispatch, and workgroup-count computation code.
- `anti-patterns.md` : compute-pipeline mistakes with WHY-it-fails
  explanations.

### Related Skills

- `webgpu-core-pipeline-architecture` : pipeline layouts, `"auto"` vs explicit, async compilation.
- `webgpu-syntax-bind-groups` : bind group layouts and resource binding for compute.
- `webgpu-wgsl-compute-shaders` : `@compute`, `@workgroup_size`, compute builtins.
- `webgpu-impl-compute-usecases` : particle systems, reductions, image processing.
