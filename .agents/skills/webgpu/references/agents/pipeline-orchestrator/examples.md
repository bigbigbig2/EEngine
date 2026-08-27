# Examples : End-to-End Render and Compute Scaffolds

Baseline: WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). Every API name,
descriptor field, enum value, and WGSL construct below is verified against the
vooronderzoek research base (W3C WebGPU spec, W3C WGSL spec, MDN, Chrome WebGPU docs).

These two scaffolds show the orchestrated setup sequence as complete, runnable code.
They are minimal on purpose: they demonstrate ordering and routing, not feature depth.

## Example 1 : Minimal Render Setup, End to End

A triangle drawn to a canvas. Follows the 15-step render-path checklist. The vertex
positions are generated in the shader from `@builtin(vertex_index)`, so NO vertex
buffer is bound and step 11 only creates a uniform buffer.

### The WGSL shader module

```wgsl
struct Uniforms {
  color : vec4<f32>,
}

@group(0) @binding(0) var<uniform> u : Uniforms;

struct VSOut {
  @builtin(position) clip_pos : vec4<f32>,
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>( 0.0,  0.5),
    vec2<f32>(-0.5, -0.5),
    vec2<f32>( 0.5, -0.5),
  );
  var out : VSOut;
  out.clip_pos = vec4<f32>(positions[vi], 0.0, 1.0);
  return out;
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  return u.color;
}
```

### The host-side setup and frame loop

```js
async function initRender(canvas) {
  // Step 1: guard navigator.gpu and the secure context.
  if (!navigator.gpu) {
    throw new Error("WebGPU is not available. Use HTTPS or localhost.");
  }

  // Step 2: request the adapter and null-check it.
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) {
    throw new Error("No WebGPU adapter found.");
  }

  // Step 3: negotiate features against adapter.features.
  const requiredFeatures = adapter.features.has("shader-f16")
    ? ["shader-f16"]
    : [];

  // Step 4: request the device, register device.lost BEFORE any resource.
  const device = await adapter.requestDevice({
    label: "main-device",
    requiredFeatures,
  });
  device.lost.then((info) => {
    console.error(`Device lost: ${info.reason} : ${info.message}`);
    // See webgpu-errors-device-loss for the full recovery pattern.
  });

  // Step 5: read the queue (a property, never a call).
  const queue = device.queue;

  // Step 6: configure the canvas context.
  const context = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  // Step 7: create the shader module and check compilation.
  const module = device.createShaderModule({
    label: "triangle-shader",
    code: WGSL_SOURCE,
  });
  const info = await module.getCompilationInfo();
  for (const msg of info.messages) {
    if (msg.type === "error") {
      throw new Error(`WGSL error ${msg.lineNum}:${msg.linePos} ${msg.message}`);
    }
  }

  // Step 8: create the bind group layout.
  const bindGroupLayout = device.createBindGroupLayout({
    label: "uniform-layout",
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" },
    }],
  });

  // Step 9: create the pipeline layout.
  const pipelineLayout = device.createPipelineLayout({
    label: "main-pipeline-layout",
    bindGroupLayouts: [bindGroupLayout],
  });

  // Step 10: create the render pipeline. fragment target format equals the
  // canvas attachment format.
  const pipeline = device.createRenderPipeline({
    label: "triangle-pipeline",
    layout: pipelineLayout,
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  // Step 11: create the uniform buffer with correct usage flags.
  const uniformBuffer = device.createBuffer({
    label: "color-uniform",
    size: 16, // vec4<f32> = 16 bytes
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Step 12: create the bind group, binding numbers match the layout.
  const bindGroup = device.createBindGroup({
    label: "uniform-bind-group",
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  // Steps 13 to 15 run every frame.
  function frame() {
    queue.writeBuffer(uniformBuffer, 0, new Float32Array([0.2, 0.5, 0.9, 1.0]));

    const encoder = device.createCommandEncoder({ label: "frame-encoder" });
    const view = context.getCurrentTexture().createView(); // fresh each frame

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3); // 3 vertices, generated in the shader
    pass.end();

    queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
```

## Example 2 : Minimal Compute Setup, End to End

A compute kernel that doubles every element of an input array and reads the result
back to the CPU. Follows the 16-step compute-path checklist. There is no canvas, so
step 6 is skipped.

### The WGSL compute shader

```wgsl
@group(0) @binding(0) var<storage, read>       input  : array<f32>;
@group(0) @binding(1) var<storage, read_write> output : array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&input)) {
    return;
  }
  output[i] = input[i] * 2.0;
}
```

### The host-side compute setup

```js
async function runCompute(data) {
  // Steps 1 to 5: identical init to the render path.
  if (!navigator.gpu) {
    throw new Error("WebGPU is not available.");
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No WebGPU adapter found.");
  }
  const device = await adapter.requestDevice({ label: "compute-device" });
  device.lost.then((info) => {
    console.error(`Device lost: ${info.reason} : ${info.message}`);
  });
  const queue = device.queue;

  // Step 6 skipped: no canvas for a compute-only app.

  // Step 7: create the compute shader module and check compilation.
  const module = device.createShaderModule({
    label: "double-kernel",
    code: WGSL_COMPUTE_SOURCE,
  });
  const info = await module.getCompilationInfo();
  for (const msg of info.messages) {
    if (msg.type === "error") {
      throw new Error(`WGSL error ${msg.lineNum}:${msg.linePos} ${msg.message}`);
    }
  }

  // Step 8: bind group layout with storage buffer entries, COMPUTE visibility.
  const bindGroupLayout = device.createBindGroupLayout({
    label: "compute-layout",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
    ],
  });

  // Step 9: pipeline layout.
  const pipelineLayout = device.createPipelineLayout({
    label: "compute-pipeline-layout",
    bindGroupLayouts: [bindGroupLayout],
  });

  // Step 10: compute pipeline, entryPoint names the @compute function.
  const pipeline = device.createComputePipeline({
    label: "double-pipeline",
    layout: pipelineLayout,
    compute: { module, entryPoint: "main" },
  });

  // Step 11: storage buffers plus a separate MAP_READ readback buffer.
  const byteSize = data.byteLength;

  const inputBuffer = device.createBuffer({
    label: "input-storage",
    size: byteSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  queue.writeBuffer(inputBuffer, 0, data);

  const outputBuffer = device.createBuffer({
    label: "output-storage",
    size: byteSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  // Readback buffer: MAP_READ combines ONLY with COPY_DST. NEVER add STORAGE.
  const readbackBuffer = device.createBuffer({
    label: "readback",
    size: byteSize,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  // Step 12: bind group, binding numbers match the layout.
  const bindGroup = device.createBindGroup({
    label: "compute-bind-group",
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: inputBuffer } },
      { binding: 1, resource: { buffer: outputBuffer } },
    ],
  });

  // Step 13: fresh encoder.
  const encoder = device.createCommandEncoder({ label: "compute-encoder" });

  // Step 14: compute pass. Workgroup count = ceil(itemCount / 64).
  const itemCount = data.length;
  const pass = encoder.beginComputePass({ label: "double-pass" });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(itemCount / 64));
  pass.end();

  // Step 15: copy storage to readback, then finish and submit.
  encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, byteSize);
  queue.submit([encoder.finish()]);

  // Step 16: wait for the GPU, then map and read.
  await queue.onSubmittedWorkDone();
  await readbackBuffer.mapAsync(GPUMapMode.READ);
  const mapped = new Float32Array(readbackBuffer.getMappedRange());
  const result = mapped.slice(); // copy out BEFORE unmap detaches the buffer
  readbackBuffer.unmap();
  return result;
}

// Usage:
// const out = await runCompute(new Float32Array([1, 2, 3, 4]));
// out is Float32Array [2, 4, 6, 8]
```

## What These Scaffolds Demonstrate

| Orchestration rule | Where it appears |
|--------------------|------------------|
| Init (steps 1-5) precedes every resource | Both examples |
| `device.lost` registered before any resource | Both examples, step 4 |
| Bind group layout (8) precedes pipeline layout (9) precedes pipeline (10) | Both examples |
| `@group` / `@binding` numbers match across WGSL and the layout | Both examples |
| `visibility` stage matches the WGSL stage that reads the binding | Render: `FRAGMENT`; Compute: `COMPUTE` |
| Fragment target `format` equals the canvas attachment `format` | Example 1, step 10 |
| `MAP_READ` combined ONLY with `COPY_DST` | Example 2, readback buffer |
| Storage buffer copied to a separate staging buffer for readback | Example 2, step 15 |
| `onSubmittedWorkDone` awaited before `mapAsync` | Example 2, step 16 |
| Data copied out before `unmap()` | Example 2, step 16 |
| Fresh encoder and fresh `getCurrentTexture` per frame | Example 1, frame loop |
| Every descriptor carries a `label` | Both examples |

For deeper detail on any single step, route to the matching skill in the Skill
Routing Map in `methods.md`.
