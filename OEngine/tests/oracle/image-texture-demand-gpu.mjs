import assert from "node:assert/strict";
import { VIRTUAL_TEXTURE_SAMPLE_WGSL, VIRTUAL_TEXTURE_FEEDBACK_WGSL } from "../../.test-dist/shaders/virtual_texture.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { VT_MAX_MIP_LEVELS } from "../../.test-dist/gpu/VirtualTextureAbi.js";

export async function checkVirtualImageDemand(graphics, owner, route) {
  const device = graphics.device;
  const uvOffset = VT_MAX_MIP_LEVELS * 7;
  const values = new Float32Array(uvOffset + 2);
  for (let level = 0; level < VT_MAX_MIP_LEVELS; level++) {
    const mip = route.mips[Math.min(level, route.mips.length - 1)];
    values.set([mip.width, mip.height, mip.gridWidth, mip.base & 65535, mip.base >>> 16, ...mip.origin], level * 7);
  }
  const constants = device.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(constants, 0, values);
  const output = device.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const module = device.createShaderModule({ code: `
@group(0) @binding(0) var<storage, read> constants: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<vec4f>;
@group(1) @binding(0) var page_table: texture_2d_array<u32>;
@group(1) @binding(1) var atlas: texture_2d_array<f32>;
@group(1) @binding(2) var filtering: sampler;
fn native_material_constant(base: u32, at: u32) -> f32 { return constants[base + at]; }
${VIRTUAL_TEXTURE_FEEDBACK_WGSL}
${VIRTUAL_TEXTURE_SAMPLE_WGSL}
@compute @workgroup_size(1)
fn main() {
  // Odd/outside-domain coordinates exercise cooked repeat gutters as well as demand.
  let uv = vec2f(constants[${uvOffset}u], constants[${uvOffset + 1}u]);
  output[0] = native_vt_sample(page_table, atlas, filtering, 0u, 0u,
    ${route.mips.length}u, ${route.tailFirst}u, 5u, true,
    uv, vec2f(0.0001, 0.0), vec2f(0.0, 0.0001));
  let lookup = native_vt_lookup(page_table, 0u, 0u, ${route.mips.length}u,
    ${route.tailFirst}u, 0u, fract(uv));
  output[1] = vec4f(f32(lookup.level), f32(lookup.slot), f32(lookup.generation), 0.0);
}` });
  const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
  const first = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: constants } }, { binding: 1, resource: { buffer: output } }
  ] });
  const second = device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: [
    { binding: 0, resource: route.tableView }, { binding: 1, resource: route.atlasView },
    { binding: 2, resource: device.createSampler({ minFilter: "linear", magFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 8 }) }
  ] });
  let releaseQuery;
  try {
    await owner.enableQueryFeedback();
    releaseQuery = owner.retainQueryDemand();
    const result = {};
    let frame = 0;
    for (const query of [false, true]) {
      // Separate fine pages: query-only must cause new IO/encode/mapping rather
      // than merely observe the page just published through primary feedback.
      const uv = query ? [0.17, 0.83] : [-0.07, 1.03];
      device.queue.writeBuffer(constants, uvOffset * 4, new Float32Array(uv));
      let reachedFine = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        const command = ShadeGPUCommandContext.create(graphics, "Renderer/GpuRenderWorld/residency-transaction");
        owner.prepareFrame(command, frame++, query ? "query" : "primary");
        owner.encodeUploads(command);
        const feedback = query ? owner.beginQueryFeedback(command) : owner.frameFeedback;
        const third = device.createBindGroup({ layout: pipeline.getBindGroupLayout(2), entries: [
          { binding: 1, resource: { buffer: feedback } }
        ] });
        const pass = command.gpu_encoder.beginComputePass();
        pass.setPipeline(pipeline); pass.setBindGroup(0, first); pass.setBindGroup(1, second); pass.setBindGroup(2, third);
        pass.dispatchWorkgroups(1); pass.end();
        owner.finishFeedback(command);
        command.gpu_encoder.copyBufferToBuffer(output, 0, readback, 0, 32);
        command.finish(); await command.gpuDone;
        await readback.mapAsync(GPUMapMode.READ);
        const values = [...new Float32Array(readback.getMappedRange())];
        readback.unmap();
        assert.ok(values.every(Number.isFinite));
        if (query && attempt === 0) {
          assert.ok(values[4] > 0, "Query-only fine page was already resident before query demand");
        }
        if (values[4] === 0 && values[6] > 0) {
          reachedFine = true;
          result[query ? "query" : "primary"] = { frames: attempt + 1, fineSlot: values[5] };
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(reachedFine, `Actual ${query ? "query" : "primary"} feedback never reached a fine image page`);
    }
    assert.ok(owner.evidence().uploadBytes > 0);
    assert.ok(owner.evidence().physicalCopyBytes > 0);
    return result;
  } finally {
    releaseQuery?.();
    constants.destroy(); output.destroy(); readback.destroy();
  }
}
