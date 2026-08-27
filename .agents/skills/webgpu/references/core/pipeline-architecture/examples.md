# Pipeline Architecture: Verified Examples

All examples verified against the W3C WebGPU specification, MDN, and the WebGPU Samples (https://webgpu.github.io/webgpu-samples/) on 2026-05-20. Baseline: WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+).

## Example 1: Auto layout render pipeline

Use `layout: "auto"` when a pipeline owns its resources and no bind group is shared with another pipeline. Bind-group layouts are read back from the pipeline.

```js
const module = device.createShaderModule({
  code: `
    @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
      let p = array(vec2f(0, 0.5), vec2f(-0.5, -0.5), vec2f(0.5, -0.5));
      return vec4f(p[i], 0, 1);
    }
    @group(0) @binding(0) var<uniform> color : vec4f;
    @fragment fn fs() -> @location(0) vec4f { return color; }
  `,
});

const format = navigator.gpu.getPreferredCanvasFormat();

const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module, entryPoint: "vs" },
  fragment: { module, entryPoint: "fs", targets: [{ format }] },
});

// The bind-group layout is auto-generated and pipeline-private.
const colorBuffer = device.createBuffer({
  size: 16,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});

const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0), // valid for THIS pipeline only
  entries: [{ binding: 0, resource: { buffer: colorBuffer } }],
});
```

## Example 2: Explicit pipeline layout shared across pipelines

Use an explicit `GPUPipelineLayout` when one `GPUBindGroup` must be bound to several pipelines. Build the bind-group layouts, build the pipeline layout, then pass the same pipeline layout to every pipeline.

```js
const format = navigator.gpu.getPreferredCanvasFormat();

// Shared bind-group layout: camera uniform, visible to vertex + fragment.
const frameLayout = device.createBindGroupLayout({
  entries: [{
    binding: 0,
    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
    buffer: { type: "uniform" },
  }],
});

// One pipeline layout, reused by every pipeline that shares the camera group.
const pipelineLayout = device.createPipelineLayout({
  bindGroupLayouts: [frameLayout],
});

const opaquePipeline = device.createRenderPipeline({
  layout: pipelineLayout,
  vertex: { module: meshModule, entryPoint: "vs" },
  fragment: { module: meshModule, entryPoint: "fsOpaque", targets: [{ format }] },
});

const wireframePipeline = device.createRenderPipeline({
  layout: pipelineLayout,
  vertex: { module: meshModule, entryPoint: "vs" },
  fragment: { module: meshModule, entryPoint: "fsWire", targets: [{ format }] },
  primitive: { topology: "line-list" },
});

// ONE bind group, valid for both pipelines because they share the layout.
const cameraBuffer = device.createBuffer({
  size: 64,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});

const frameGroup = device.createBindGroup({
  layout: frameLayout,
  entries: [{ binding: 0, resource: { buffer: cameraBuffer } }],
});

function drawFrame(pass) {
  pass.setBindGroup(0, frameGroup);
  pass.setPipeline(opaquePipeline);
  pass.draw(meshVertexCount);
  pass.setPipeline(wireframePipeline);
  pass.draw(meshVertexCount);
}
```

## Example 3: Async pipeline creation during loading

Use `createRenderPipelineAsync` / `createComputePipelineAsync` so heavy shader compilation runs off the main thread and never causes frame jank.

```js
async function buildPipelines(device, format) {
  // Both compile concurrently, off the main thread.
  const [scenePipeline, postPipeline] = await Promise.all([
    device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: sceneModule, entryPoint: "vs" },
      fragment: { module: sceneModule, entryPoint: "fs", targets: [{ format }] },
    }),
    device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: postModule, entryPoint: "vs" },
      fragment: { module: postModule, entryPoint: "fs", targets: [{ format }] },
    }),
  ]);
  return { scenePipeline, postPipeline };
}
```

## Example 4: Async compute pipeline

```js
const computeModule = device.createShaderModule({
  code: `
    @group(0) @binding(0) var<storage, read_write> data : array<f32>;
    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) gid : vec3u) {
      data[gid.x] = data[gid.x] * 2.0;
    }
  `,
});

const computePipeline = await device.createComputePipelineAsync({
  layout: "auto",
  compute: { module: computeModule, entryPoint: "main" },
});
```

## Example 5: Inspecting shader compilation messages

A WGSL error does not throw from `createShaderModule`. Inspect `getCompilationInfo()` during development to surface errors with line and column.

```js
async function compileChecked(device, code) {
  const module = device.createShaderModule({ code });
  const info = await module.getCompilationInfo();
  for (const m of info.messages) {
    const where = `${m.lineNum}:${m.linePos}`;
    if (m.type === "error") console.error(`WGSL error ${where}: ${m.message}`);
    else if (m.type === "warning") console.warn(`WGSL warning ${where}: ${m.message}`);
  }
  return module;
}
```

## Example 6: Create once, reuse every frame

Pipeline objects are immutable and expensive. Build them at init time and reuse the reference in the render loop.

```js
// Init: build once.
const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module, entryPoint: "vs" },
  fragment: { module, entryPoint: "fs", targets: [{ format }] },
});

// Render loop: reuse the same immutable pipeline object.
function frame() {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
  pass.setPipeline(pipeline); // reused, never recreated
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```
