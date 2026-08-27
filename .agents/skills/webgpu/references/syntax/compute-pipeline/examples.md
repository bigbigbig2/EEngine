# Compute Pipeline Examples

WebGPU 1.0-stable (Chrome 113+, Safari 26+, Firefox 141+). Every example is
verified against the W3C WebGPU specification, MDN, and the project vooronderzoek
(PART A section 3, PART C sections 3 and 6).

## Example 1: Complete compute pipeline, pass, and direct dispatch

Doubles every element of a storage buffer. Shows pipeline creation, the compute
pass, bind group setup, and a correctly sized direct dispatch.

```js
async function runDoubleCompute(device, inputArray) {
  const WG = 64;                                 // matches @workgroup_size(64)
  const elementCount = inputArray.length;
  const byteSize = elementCount * 4;             // f32 = 4 bytes

  // Storage buffer holding the data, also copy-source for readback.
  const dataBuffer = device.createBuffer({
    label: "compute-data",
    size: byteSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(dataBuffer, 0, inputArray);

  // WGSL: the index guard handles the ceil remainder.
  const module = device.createShaderModule({
    label: "double-shader",
    code: /* wgsl */ `
      @group(0) @binding(0) var<storage, read_write> data: array<f32>;

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let i = gid.x;
        if (i >= arrayLength(&data)) { return; }
        data[i] = data[i] * 2.0;
      }
    `,
  });

  // Async compilation keeps the load path off the content timeline.
  const pipeline = await device.createComputePipelineAsync({
    label: "double-pipeline",
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });

  // Bind group from the pipeline's auto layout (usable with this pipeline only).
  const bindGroup = device.createBindGroup({
    label: "double-bind-group",
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: dataBuffer } }],
  });

  // workgroupCount is the WORKGROUP count, computed with ceil.
  const workgroupCount = Math.ceil(elementCount / WG);

  const encoder = device.createCommandEncoder({ label: "double-encoder" });
  const pass = encoder.beginComputePass({ label: "double-pass" });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(workgroupCount);       // not elementCount
  pass.end();                                    // before encoder.finish()
  device.queue.submit([encoder.finish()]);

  // Staging readback (storage buffers cannot be mapped directly).
  const readBuffer = device.createBuffer({
    label: "double-readback",
    size: byteSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const copyEncoder = device.createCommandEncoder();
  copyEncoder.copyBufferToBuffer(dataBuffer, 0, readBuffer, 0, byteSize);
  device.queue.submit([copyEncoder.finish()]);

  await readBuffer.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(readBuffer.getMappedRange().slice(0));
  readBuffer.unmap();
  return result;
}
```

## Example 2: Workgroup-count computation

The dispatch grid is `ceil(dataSize / workgroupSize)`. The last workgroup always
launches a full `@workgroup_size` of invocations, so a remainder exists whenever
`dataSize` is not a multiple of the workgroup size.

```js
function workgroupCount1D(dataSize, workgroupSize) {
  return Math.ceil(dataSize / workgroupSize);
}

// dataSize = 100, workgroupSize = 64
//   workgroupCount = ceil(100 / 64) = 2
//   total invocations = 2 * 64 = 128
//   invocations 100..127 are the remainder and MUST be guarded in the shader.
const count = workgroupCount1D(100, 64);   // 2
```

For a 2D dispatch over a `width x height` image with a 2D workgroup:

```js
function workgroupCount2D(width, height, wgX, wgY) {
  return {
    x: Math.ceil(width / wgX),
    y: Math.ceil(height / wgY),
  };
}

// 1920x1080 image, @workgroup_size(8, 8)
const grid = workgroupCount2D(1920, 1080, 8, 8);   // { x: 240, y: 135 }
// pass.dispatchWorkgroups(grid.x, grid.y);
```

The matching WGSL guards both dimensions:

```wgsl
@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var outputTex: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(outputTex);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }   // guard both axes
  let color = textureLoad(inputTex, vec2<i32>(gid.xy), 0);
  textureStore(outputTex, vec2<i32>(gid.xy), color);
}
```

## Example 3: Splitting a large dispatch across dimensions

A 1D dispatch can exceed `maxComputeWorkgroupsPerDimension`. Spread the count
across X and Y and linearize in the shader.

```js
function dispatchLarge(pass, totalWorkgroups, device) {
  const max = device.limits.maxComputeWorkgroupsPerDimension;   // 65535 default
  if (totalWorkgroups <= max) {
    pass.dispatchWorkgroups(totalWorkgroups);
  } else {
    const x = max;
    const y = Math.ceil(totalWorkgroups / max);
    pass.dispatchWorkgroups(x, y);
  }
}
```

```wgsl
override WG_X: u32 = 65535u;   // host passes the same value via constants

@compute @workgroup_size(64)
fn main(
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
) {
  // Linearize the 2D workgroup grid back to a 1D index.
  let workgroupIndex = wid.x + wid.y * WG_X;
  let i = workgroupIndex * 64u + lid.x;
  if (i >= arrayLength(&data)) { return; }
  // ... process element i
}
```

## Example 4: Indirect dispatch with a GPU-computed workgroup count

A first compute pass writes the workgroup count into an `INDIRECT` buffer; a
second pass dispatches from it. No CPU readback of the count is needed. This is
the particle-system pattern from PART C section 6 of the vooronderzoek.

```js
// 12-byte indirect buffer: [workgroupCountX, workgroupCountY, workgroupCountZ].
const indirectBuffer = device.createBuffer({
  label: "dispatch-args",
  size: 12,
  usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});
// Initialize Y and Z to 1; the first pass overwrites X.
device.queue.writeBuffer(indirectBuffer, 0, new Uint32Array([0, 1, 1]));

// Pass A: counts live particles and writes workgroupCountX into the buffer.
const countModule = device.createShaderModule({
  label: "count-shader",
  code: /* wgsl */ `
    @group(0) @binding(0) var<storage, read> aliveFlags: array<u32>;
    @group(0) @binding(1) var<storage, read_write> dispatchArgs: array<u32, 3>;

    @compute @workgroup_size(1)
    fn main() {
      var alive = 0u;
      for (var k = 0u; k < arrayLength(&aliveFlags); k = k + 1u) {
        alive = alive + aliveFlags[k];
      }
      // ceil(alive / 64) workgroups for the simulation pass.
      dispatchArgs[0] = (alive + 63u) / 64u;
    }
  `,
});
const countPipeline = await device.createComputePipelineAsync({
  label: "count-pipeline",
  layout: "auto",
  compute: { module: countModule, entryPoint: "main" },
});

// Pass B: the simulation pipeline, dispatched indirectly.
const simPipeline = await device.createComputePipelineAsync({
  label: "sim-pipeline",
  layout: "auto",
  compute: { module: simModule, entryPoint: "main" },
});

const encoder = device.createCommandEncoder({ label: "indirect-encoder" });

const countPass = encoder.beginComputePass({ label: "count-pass" });
countPass.setPipeline(countPipeline);
countPass.setBindGroup(0, countBindGroup);
countPass.dispatchWorkgroups(1);
countPass.end();

const simPass = encoder.beginComputePass({ label: "sim-pass" });
simPass.setPipeline(simPipeline);
simPass.setBindGroup(0, simBindGroup);
simPass.dispatchWorkgroupsIndirect(indirectBuffer, 0);   // offset 0, multiple of 4
simPass.end();

device.queue.submit([encoder.finish()]);
```

Within a single `queue.submit`, the encoder orders pass A before pass B, so the
indirect buffer holds the value pass A wrote when pass B reads it. NEVER read the
indirect buffer back to the CPU in the same frame without
`device.queue.onSubmittedWorkDone()`; the GPU may not be finished.

## Example 5: Overriding workgroup size with pipeline constants

The WGSL `@workgroup_size` may use `override` constants set at pipeline creation.
The host MUST keep the dispatch math in sync with the chosen value.

```wgsl
override WG_SIZE: u32 = 64u;

@compute @workgroup_size(WG_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= arrayLength(&data)) { return; }
  // ...
}
```

```js
const chosenWgSize = 128;
const pipeline = await device.createComputePipelineAsync({
  label: "tunable-pipeline",
  layout: "auto",
  compute: {
    module,
    entryPoint: "main",
    constants: { WG_SIZE: chosenWgSize },     // matches the override name
  },
});
// The dispatch math MUST use the same value.
const workgroupCount = Math.ceil(elementCount / chosenWgSize);
```

See webgpu-wgsl-compute-shaders for `@workgroup_size` and `override` constant
details.
