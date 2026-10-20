import assert from "node:assert/strict";
import { IMAGE_TEXTURE_SAMPLE_WGSL } from "../../.test-dist/shaders/image_texture_sampling.js";
import { GPU_TEXTURE_CLAMPED_SAMPLE_WGSL } from "../../.test-dist/gpu/GpuTextureRefAbi.js";

/** Independent logical texel oracle. R8 isolates sampling math from lossy BC;
 * production BC/normal consumption is checked by the residency oracle. */
export async function checkLogicalImageSampling(device) {
  const texture = device.createTexture({ size: [8, 8], mipLevelCount: 3, format: "r8unorm",
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
  const levels = [];
  for (let mip = 0; mip < 3; mip++) {
    const width = Math.max(1, 7 >> mip), height = Math.max(1, 5 >> mip);
    const side = 8 >> mip;
    const bytes = new Uint8Array(side * side).fill(255);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) bytes[y * side + x] = (x * 29 + y * 41 + mip * 37) % 231;
    }
    levels.push({ width, height, side, bytes });
    device.queue.writeTexture({ texture, mipLevel: mip }, bytes,
      { bytesPerRow: side }, [side, side]);
  }
  const cases = [];
  for (let u = 0; u < 3; u++) for (let v = 0; v < 3; v++) {
    for (const linear of [false, true]) for (const lod of [0, 0.37, 1.21]) {
      for (const uv of [[-0.31, 0.83], [0.01, 0.01], [0.99, 0.99], [1.17, -1.27], [0.37, 0.41]]) {
        cases.push({ uv, lod, linear, u, v });
      }
    }
  }
  const values = new Float32Array(cases.length * 8);
  cases.forEach((c, i) => values.set([...c.uv, 2 ** c.lod / 7, 0, 0, 2 ** c.lod / 5,
    c.u | (c.v << 2) | (c.linear ? 16 : 0), 0], i * 8));
  const input = device.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(input, 0, values);
  const output = device.createBuffer({ size: cases.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: output.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const module = device.createShaderModule({ code: `
const OENGINE_MATERIAL_SAMPLER_LINEAR: u32 = 16u;
const OENGINE_MATERIAL_SAMPLER_MIP_MASK: u32 = 224u;
const OENGINE_MATERIAL_SAMPLER_MIP_SHIFT: u32 = 5u;
const OENGINE_MATERIAL_SAMPLER_FULL_MIP_CODE: u32 = 7u;
@group(0) @binding(0) var image: texture_2d_array<f32>;
@group(0) @binding(1) var filtering: sampler;
@group(0) @binding(2) var<storage, read> cases: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> output: array<f32>;
${GPU_TEXTURE_CLAMPED_SAMPLE_WGSL}
${IMAGE_TEXTURE_SAMPLE_WGSL}
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let a = cases[id.x * 2u];
  let b = cases[id.x * 2u + 1u];
  output[id.x] = image_texture_sample(image, filtering, 1u, u32(b.z) | 224u,
    a.xy, 0, a.zw, b.xy, vec2f(7.0, 5.0), 1.0).r;
}` });
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: texture.createView({ dimension: "2d-array" }) },
      { binding: 1, resource: device.createSampler({ minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" }) },
      { binding: 2, resource: { buffer: input } }, { binding: 3, resource: { buffer: output } }
    ] });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(cases.length); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(readback.getMappedRange());
    const address = (index, size, mode) => {
      if (mode === 0) return Math.min(size - 1, Math.max(0, index));
      const cycle = Math.floor(index / size), local = index - cycle * size;
      return mode === 2 && Math.abs(cycle % 2) === 1 ? size - local - 1 : local;
    };
    const levelValue = (c, mip) => {
      const { width, height, side, bytes } = levels[mip];
      const at = (x, y) => bytes[address(y, height, c.v) * side + address(x, width, c.u)] / 255;
      if (!c.linear) return at(Math.floor(c.uv[0] * width), Math.floor(c.uv[1] * height));
      const px = c.uv[0] * width - 0.5, py = c.uv[1] * height - 0.5;
      const x = Math.floor(px), y = Math.floor(py), wx = px - x, wy = py - y;
      return at(x, y) * (1 - wx) * (1 - wy) + at(x + 1, y) * wx * (1 - wy)
        + at(x, y + 1) * (1 - wx) * wy + at(x + 1, y + 1) * wx * wy;
    };
    let maxError = 0;
    cases.forEach((c, index) => {
      const low = Math.floor(c.lod), fraction = c.lod - low;
      const expected = c.linear ? levelValue(c, low) * (1 - fraction) + levelValue(c, Math.min(2, low + 1)) * fraction
        : levelValue(c, Math.round(c.lod));
      const error = Math.abs(actual[index] - expected);
      maxError = Math.max(maxError, error);
      assert.ok(error < 0.00002, JSON.stringify({ index, c, actual: actual[index], expected, error }));
    });
    readback.unmap();
    return { cases: cases.length, maxError, addressPairs: 9, scope: "independent logical nearest/bilinear/trilinear oracle" };
  } finally {
    texture.destroy(); input.destroy(); output.destroy(); readback.destroy();
  }
}
