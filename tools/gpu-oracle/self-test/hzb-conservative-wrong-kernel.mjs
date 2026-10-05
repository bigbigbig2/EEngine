// Isolated negative control: the production kernel must accept depth 0.5,
// then a deliberately wrong kernel must fail the SAME independent bound.
// The exhaustive production HZB oracle is unchanged; its subnormal failures
// cannot accidentally count as sensitivity to this injected defect.
import assert from "node:assert/strict";
import { HZB_REDUCE_COMPUTE_WGSL } from "../../../OEngine/.test-dist/shaders/hzb_reduce.js";

const wrong = `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var output: texture_storage_2d<rg16float, write>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(output))) { return; }
  let value = textureLoad(source,vec2i(id.xy),0).xy;
  textureStore(output,vec2i(id.xy),vec4f(value.x*2.0,value.y,0.0,0.0));
}`;
function half(bits) {
  const e = (bits >>> 10) & 31,
    m = bits & 1023;
  return e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15);
}
export async function runWrongKernelHzbOracle(device) {
  const resources = [];
  const source = device.createTexture({
    size: [8, 8],
    format: "rg32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const output = device.createTexture({
    size: [8, 8],
    format: "rg16float",
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  });
  const read = device.createBuffer({
    size: 256 * 8,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  resources.push(source, output, read);
  try {
    device.queue.writeTexture(
      { texture: source },
      new Float32Array(8 * 8 * 2).fill(0.5),
      { bytesPerRow: 64 },
      [8, 8],
    );
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rg16float" },
        },
      ],
    });
    const group = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: output.createView() },
      ],
    });
    async function run(code) {
      const pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module: device.createShaderModule({ code }), entryPoint: "main" },
      });
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyTextureToBuffer({ texture: output }, { buffer: read, bytesPerRow: 256 }, [8, 8]);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const bits = new Uint16Array(read.getMappedRange().slice(0));
      read.unmap();
      return [half(bits[0]), half(bits[1])];
    }
    const baseline = await run(HZB_REDUCE_COMPUTE_WGSL);
    assert.ok(
      baseline[0] <= 0.5 && baseline[1] >= 0.5,
      "production normal-depth positive control must pass before mutation",
    );
    const bad = await run(wrong);
    assert.ok(bad[0] <= 0.5, `controlled wrong kernel rejected: min ${bad[0]} exceeds source 0.5`);
    return { baseline, bad };
  } finally {
    for (const resource of resources) resource.destroy();
  }
}
