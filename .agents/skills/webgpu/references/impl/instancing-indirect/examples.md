# Examples: Instancing and Indirect Draws

WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). Every example is verified
against the W3C WebGPU specification, MDN, and the official WebGPU Samples.

## Example 1: Instanced Draw with a Per-Instance Vertex Buffer

Draws 4096 copies of a quad. The shared geometry advances per vertex; the per-instance
offset advances per instance via `stepMode: "instance"`.

```js
// Shared geometry: one quad, advances per vertex.
const quad = new Float32Array([
  -0.02, -0.02,  0.02, -0.02,  0.02, 0.02,
  -0.02, -0.02,  0.02,  0.02, -0.02, 0.02,
]);
const quadBuffer = device.createBuffer({
  size: quad.byteLength,
  usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(quadBuffer, 0, quad);

// Per-instance data: one vec2 offset per instance.
const COUNT = 4096;
const offsets = new Float32Array(COUNT * 2);
for (let i = 0; i < COUNT; i++) {
  offsets[i * 2 + 0] = (Math.random() * 2) - 1;
  offsets[i * 2 + 1] = (Math.random() * 2) - 1;
}
const offsetBuffer = device.createBuffer({
  size: offsets.byteLength,
  usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(offsetBuffer, 0, offsets);

const shader = device.createShaderModule({ code: `
  @vertex fn vs(@location(0) pos: vec2f, @location(1) offset: vec2f)
    -> @builtin(position) vec4f {
    return vec4f(pos + offset, 0.0, 1.0);
  }
  @fragment fn fs() -> @location(0) vec4f {
    return vec4f(0.3, 0.7, 1.0, 1.0);
  }
` });

const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: {
    module: shader,
    entryPoint: "vs",
    buffers: [
      // Slot 0: per-vertex geometry.
      { arrayStride: 8, stepMode: "vertex",
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
      // Slot 1: per-instance offset. stepMode "instance" advances once per instance.
      { arrayStride: 8, stepMode: "instance",
        attributes: [{ shaderLocation: 1, offset: 0, format: "float32x2" }] },
    ],
  },
  fragment: { module: shader, entryPoint: "fs",
    targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
  primitive: { topology: "triangle-list" },
});

function frame() {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: "clear", storeOp: "store",
    }],
  });
  pass.setPipeline(pipeline);
  pass.setVertexBuffer(0, quadBuffer);
  pass.setVertexBuffer(1, offsetBuffer);
  // 6 vertices per quad, COUNT instances, in ONE draw call.
  pass.draw(6, COUNT, 0, 0);
  pass.end();
  device.queue.submit([encoder.finish()]);
}
```

## Example 2: Instanced Draw with a Storage Buffer and instance_index

The same result, but per-instance data is read in the shader by indexing a storage
buffer with `@builtin(instance_index)`. Use this when per-instance data is large or
written by a compute pass.

```js
const COUNT = 4096;
const transforms = new Float32Array(COUNT * 4); // vec2 offset + vec2 padding
for (let i = 0; i < COUNT; i++) {
  transforms[i * 4 + 0] = (Math.random() * 2) - 1;
  transforms[i * 4 + 1] = (Math.random() * 2) - 1;
}
const storageBuffer = device.createBuffer({
  size: transforms.byteLength,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(storageBuffer, 0, transforms);

const shader = device.createShaderModule({ code: `
  @group(0) @binding(0) var<storage, read> instances: array<vec4f>;
  @vertex fn vs(@location(0) pos: vec2f, @builtin(instance_index) i: u32)
    -> @builtin(position) vec4f {
    let offset = instances[i].xy;
    return vec4f(pos + offset, 0.0, 1.0);
  }
  @fragment fn fs() -> @location(0) vec4f {
    return vec4f(1.0, 0.6, 0.2, 1.0);
  }
` });

const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module: shader, entryPoint: "vs",
    buffers: [{ arrayStride: 8, stepMode: "vertex",
      attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }] },
  fragment: { module: shader, entryPoint: "fs",
    targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
  primitive: { topology: "triangle-list" },
});

const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [{ binding: 0, resource: { buffer: storageBuffer } }],
});

// In the render pass:
pass.setPipeline(pipeline);
pass.setBindGroup(0, bindGroup);
pass.setVertexBuffer(0, quadBuffer);
pass.draw(6, COUNT, 0, 0); // instance_index runs 0 .. COUNT-1
```

## Example 3: Indexed Indirect Draw with a Populated Buffer

The draw count comes from a buffer, not from JavaScript. The full 20-byte
`drawIndexedIndirect` record is written, every field included.

```js
// Cube: 24 vertices, 36 indices (verified topology). Assume cubeVertexBuffer and
// cubeIndexBuffer are already created and populated.
const indexCount = 36;
const instanceCount = 1024;

// drawIndexedIndirect record: 5 u32 values, 20 bytes.
// [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
const record = new Uint32Array([indexCount, instanceCount, 0, 0, 0]);
const indirectBuffer = device.createBuffer({
  size: 20, // EXACTLY the indexed record size
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.INDIRECT,
});
device.queue.writeBuffer(indirectBuffer, 0, record);

// In the render pass:
pass.setPipeline(pipeline);
pass.setBindGroup(0, bindGroup);
pass.setVertexBuffer(0, cubeVertexBuffer);
pass.setIndexBuffer(cubeIndexBuffer, "uint32");
pass.drawIndexedIndirect(indirectBuffer, 0); // offset 0 is a multiple of 4
```

To draw a second mesh from the same buffer, append a second 20-byte record and call
`drawIndexedIndirect(indirectBuffer, 20)`. The offset 20 is a multiple of 4 and points
at the next record.

## Example 4: GPU-Driven Cull plus Indirect Render

A compute pass tests each object against the frustum, appends visible instances to a
storage buffer, and writes the live `instanceCount` into the indirect buffer. The
render pass reads that count. The CPU never learns how many objects survived culling.

```js
const MAX_OBJECTS = 8192;

// Indirect buffer: written by the compute shader, read by the render pass.
// instanceCount starts at 0; the cull shader atomically increments it.
const indirectInit = new Uint32Array([36, 0, 0, 0, 0]); // indexCount fixed, rest 0
const indirectBuffer = device.createBuffer({
  size: 20,
  usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});

// Visible-instance output: the cull shader writes surviving transforms here.
const visibleBuffer = device.createBuffer({
  size: MAX_OBJECTS * 64, // mat4x4f per instance
  usage: GPUBufferUsage.STORAGE,
});

const cullModule = device.createShaderModule({ code: `
  struct DrawArgs {
    indexCount: u32,
    instanceCount: atomic<u32>,
    firstIndex: u32,
    baseVertex: u32,
    firstInstance: u32,
  };
  @group(0) @binding(0) var<storage, read>       allObjects: array<mat4x4f>;
  @group(0) @binding(1) var<storage, read_write> visible: array<mat4x4f>;
  @group(0) @binding(2) var<storage, read_write> draw: DrawArgs;
  @group(0) @binding(3) var<uniform>             objectCount: u32;

  fn isVisible(m: mat4x4f) -> bool {
    // Placeholder frustum test: keep objects near the origin.
    let p = m[3].xyz;
    return abs(p.x) < 10.0 && abs(p.y) < 10.0 && abs(p.z) < 10.0;
  }

  @compute @workgroup_size(64)
  fn main(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    if (i >= objectCount) { return; }
    let m = allObjects[i];
    if (isVisible(m)) {
      // Reserve one slot in the visible list and bump instanceCount together.
      let slot = atomicAdd(&draw.instanceCount, 1u);
      visible[slot] = m;
    }
  }
` });

const cullPipeline = device.createComputePipeline({
  layout: "auto",
  compute: { module: cullModule, entryPoint: "main" },
});

const objectCountBuffer = device.createBuffer({
  size: 16, // a single u32, padded to 16 for a uniform binding
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(objectCountBuffer, 0, new Uint32Array([MAX_OBJECTS]));

const cullBindGroup = device.createBindGroup({
  layout: cullPipeline.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: { buffer: allObjectsBuffer } },
    { binding: 1, resource: { buffer: visibleBuffer } },
    { binding: 2, resource: { buffer: indirectBuffer } },
    { binding: 3, resource: { buffer: objectCountBuffer } },
  ],
});

function frame() {
  // Reset instanceCount to 0 each frame; the cull shader counts up from 0.
  device.queue.writeBuffer(indirectBuffer, 0, indirectInit);

  const encoder = device.createCommandEncoder();

  // Compute pass: cull and write the indirect buffer.
  const cull = encoder.beginComputePass();
  cull.setPipeline(cullPipeline);
  cull.setBindGroup(0, cullBindGroup);
  cull.dispatchWorkgroups(Math.ceil(MAX_OBJECTS / 64));
  cull.end();

  // Render pass: read the GPU-written instanceCount. No CPU readback.
  const draw = encoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: "clear", storeOp: "store",
    }],
  });
  draw.setPipeline(drawPipeline);
  draw.setBindGroup(0, drawBindGroup); // binds visibleBuffer for instance_index
  draw.setVertexBuffer(0, cubeVertexBuffer);
  draw.setIndexBuffer(cubeIndexBuffer, "uint32");
  draw.drawIndexedIndirect(indirectBuffer, 0);
  draw.end();

  // One submit: the encoder orders the compute pass before the render pass.
  device.queue.submit([encoder.finish()]);
}
```

The render shader indexes `visibleBuffer` with `@builtin(instance_index)` exactly as in
Example 2. The key property: the count flows compute → indirect buffer → render entirely
on the GPU timeline. There is no `mapAsync`, no `onSubmittedWorkDone`, no CPU stall.

## Example 5: dispatchWorkgroupsIndirect for a GPU-Decided Dispatch

A particle simulator writes the next dispatch size into a 12-byte buffer; the following
compute pass reads it.

```js
// 3 u32 values, 12 bytes: [workgroupCountX, workgroupCountY, workgroupCountZ].
const dispatchArgs = new Uint32Array([64, 1, 1]);
const dispatchBuffer = device.createBuffer({
  size: 12,
  usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(dispatchBuffer, 0, dispatchArgs);

const pass = encoder.beginComputePass();
pass.setPipeline(simulatePipeline);
pass.setBindGroup(0, simulateBindGroup);
pass.dispatchWorkgroupsIndirect(dispatchBuffer, 0); // offset multiple of 4
pass.end();
```

## Verified Sources

- https://www.w3.org/TR/webgpu/ (W3C WebGPU specification)
- https://developer.mozilla.org/en-US/docs/Web/API/GPURenderPassEncoder/drawIndexedIndirect
- https://developer.mozilla.org/en-US/docs/Web/API/GPUComputePassEncoder/dispatchWorkgroupsIndirect
- https://webgpu.github.io/webgpu-samples/ (instancing and compute samples)
- vooronderzoek-webgpu.md PART C section 3, section 6
