import { FrameGraph } from "../../.test-dist/framegraph/FrameGraph.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { GPUBufferAllocator } from "../../.test-dist/gpu/GPUBufferAllocator.js";
import { GPUStagingBufferAllocator } from "../../.test-dist/gpu/GPUStagingBufferAllocator.js";
import { GPUTextureAllocator } from "../../.test-dist/gpu/GPUTextureAllocator.js";
import { FrameProfiler } from "../../.test-dist/debug/FrameProfiler.js";
import {
  planFinalPixelLightingDirectory,
  FINAL_PIXEL_SOLAR_SAMPLING_WGSL,
} from "../../.test-dist/gpu/FinalPixelAbi.js";
import { addFinalPixelSolarPublication } from "../../.test-dist/render/environment/FinalPixelSolarPublication.js";
import { encodeFloat16, decodeFloat16 } from "../../.test-dist/core/Float16.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Independent CPU interpolation and the current GPU filtered-LUT reference.
 * Exercises nonconstant providers, exact texels, clamp edges and byte publication. */
export async function runFinalPixelSolarGpuOracle(device) {
  const graphics = {
    device,
    profiler: new FrameProfiler({ enabled: false }),
    buffer_allocator_main: new GPUBufferAllocator(device),
    buffer_allocator_staging: new GPUStagingBufferAllocator(device),
    allocator_textures: new GPUTextureAllocator(device),
  };
  const resources = [];
  const buffer = (size, usage, initial) => {
    const value = device.createBuffer({ size, usage, mappedAtCreation: initial !== undefined });
    if (initial !== undefined) {
      new Uint8Array(value.getMappedRange()).set(new Uint8Array(initial.buffer));
      value.unmap();
    }
    resources.push(value);
    return value;
  };
  try {
    const plan = planFinalPixelLightingDirectory(device.limits, 24, 3);
    const poison = new Uint32Array(plan.bytes / 4).fill(0xdeadbeef);
    const directory = buffer(
      plan.bytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      poison,
    );
    const ranges = buffer(16, GPUBufferUsage.UNIFORM, plan.words);
    const half = new Uint16Array(256 * 64 * 4);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 256; x++) {
        const at = (y * 256 + x) * 4;
        const values = [x / 255, y / 63, 0.5 + 0.3 * Math.sin(x * 0.035) * Math.cos(y * 0.12), 1];
        half.set(values.map(encodeFloat16), at);
      }
    const texture = device.createTexture({
      size: [256, 64],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    resources.push(texture);
    device.queue.writeTexture({ texture }, half, { bytesPerRow: 2048 }, [256, 64]);
    const uv = [];
    for (let y = 0; y < 32; y++) for (let x = 0; x < 128; x++) uv.push((x + 0.317) / 128, (y + 0.719) / 32);
    for (const x of [-1, 0, 0.5 / 256, 0.5, 255.5 / 256, 1, 2])
      for (const y of [-1, 0, 0.5 / 64, 0.5, 63.5 / 64, 1, 2]) uv.push(x, y);
    const samples = new Float32Array(uv),
      count = samples.length / 2;
    const input = buffer(samples.byteLength, GPUBufferUsage.STORAGE, samples);
    const output = buffer(count * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const readback = buffer(count * 32 + plan.bytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const module = device.createShaderModule({
      code: `
@group(1) @binding(2) var<storage, read> lighting_directory: array<u32>;
@group(1) @binding(9) var<uniform> lighting_ranges: vec4u;
${FINAL_PIXEL_SOLAR_SAMPLING_WGSL}
@group(0) @binding(0) var original: texture_2d<f32>;
@group(0) @binding(1) var linear_clamp: sampler;
@group(0) @binding(2) var<storage, read> samples: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&samples)) { return; }
  output[id.x * 2u] = vec4f(final_pixel_solar_transmittance(samples[id.x]), 1.0);
  output[id.x * 2u + 1u] = textureSampleLevel(original, linear_clamp, samples[id.x], 0.0);
}`,
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    const group0 = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: device.createSampler({ minFilter: "linear", magFilter: "linear" }) },
        { binding: 2, resource: { buffer: input } },
        { binding: 3, resource: { buffer: output } },
      ],
    });
    const group1 = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 2, resource: { buffer: directory } },
        { binding: 9, resource: { buffer: ranges } },
      ],
    });
    const graph = new FrameGraph("Final Pixel solar numeric");
    const original = graph.import_resource("Sun LUT", { kind: "imported" }, texture);
    const target = graph.import_resource("Lighting container", { kind: "imported" }, directory);
    const published = addFinalPixelSolarPublication(graph, { transmittance: original, target, plan });
    const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    const consumer = graph.add("Solar numeric consumer", {}, () => {
      const pass = command.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group0);
      pass.setBindGroup(1, group1);
      pass.dispatchWorkgroups(Math.ceil(count / 64));
      pass.end();
      command.gpu_encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
      command.gpu_encoder.copyBufferToBuffer(directory, 0, readback, output.size, directory.size);
    });
    consumer.read(published);
    consumer.read(original);
    consumer.make_side_effect();
    command.encodeGraph(graph);
    command.finish();
    await command.gpuDone;
    await readback.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(readback.getMappedRange()).slice();
    readback.unmap();
    const values = new Float32Array(bytes.buffer, 0, count * 8);
    const publishedBytes = bytes.subarray(output.size);
    const copied = new Uint16Array(
      publishedBytes.buffer,
      publishedBytes.byteOffset + plan.solarOffset,
      half.length,
    );
    for (let i = 0; i < half.length; i++)
      check(copied[i] === half[i], `Solar publication changed half texel ${i}`);
    const words = new Uint32Array(publishedBytes.buffer, publishedBytes.byteOffset, directory.size / 4);
    for (let i = 0; i < words.length; i++)
      if (i < plan.solarOffset / 4 || i >= (plan.solarOffset + plan.solarBytes) / 4)
        check(words[i] === 0xdeadbeef, `Solar publication overwrote another owner at ${i}`);
    const texel = (x, y, c) =>
      decodeFloat16(half[(Math.max(0, Math.min(63, y)) * 256 + Math.max(0, Math.min(255, x))) * 4 + c]);
    let maxCpuError = 0,
      maxFilteredError = 0;
    for (let i = 0; i < count; i++) {
      const x = Math.fround(Math.fround(Math.max(0, Math.min(1, samples[i * 2])) * 256) - 0.5);
      const y = Math.fround(Math.fround(Math.max(0, Math.min(1, samples[i * 2 + 1])) * 64) - 0.5);
      const bx = Math.floor(x),
        by = Math.floor(y),
        fx = x - bx,
        fy = y - by;
      for (let c = 0; c < 3; c++) {
        const row0 = texel(bx, by, c) * (1 - fx) + texel(bx + 1, by, c) * fx;
        const row1 = texel(bx, by + 1, c) * (1 - fx) + texel(bx + 1, by + 1, c) * fx;
        const actual = values[i * 8 + c],
          expected = row0 * (1 - fy) + row1 * fy;
        check(Number.isFinite(actual), "Solar sample is nonfinite");
        maxCpuError = Math.max(maxCpuError, Math.abs(actual - expected));
        maxFilteredError = Math.max(maxFilteredError, Math.abs(actual - values[i * 8 + 4 + c]));
      }
    }
    check(maxCpuError <= 2 ** -20, `Exact-half interpolation error ${maxCpuError}`);
    check(maxFilteredError <= 0.003, `Existing filtered provider comparison error ${maxFilteredError}`);
    return {
      samples: count,
      sourceBytesUnchanged: true,
      disjointOwnerWrites: true,
      maxCpuError,
      maxFilteredError,
      publicationBytes: plan.solarBytes,
      qualityContract: "existing .003 provider comparison; not dynamic whole-renderer quality",
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    for (const value of resources) value.destroy();
    graphics.buffer_allocator_main.destroy();
    graphics.buffer_allocator_staging.destroy();
    graphics.allocator_textures.destroy();
  }
}
