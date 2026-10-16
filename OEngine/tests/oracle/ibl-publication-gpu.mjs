import assert from "node:assert/strict";
import { GpuAuthoredEnvironment } from "../../.test-dist/gpu/GpuAuthoredEnvironment.js";
import { PhysicalEnvironmentRuntime } from "../../.test-dist/render/environment/PhysicalEnvironmentRuntime.js";
import { ResourceAccounting } from "../../.test-dist/debug/profiling/ResourceAccounting.js";
import { GPUSamplerCache } from "../../.test-dist/gpu/GPUSamplerCache.js";
import { ShadeTexture, ShadeImage } from "../../.test-dist/texture/ShadeTexture.js";
import { NATIVE_ENVIRONMENT_SAMPLE_WGSL } from "../../.test-dist/shaders/native_environment_sample.js";
import { ENVIRONMENT_BRDF_WGSL } from "../../.test-dist/shaders/native_environment_brdf.js";

// Actual environment owners and kernels, with a minimal command host. The host
// owns test submissions; production owners never submit or wait for readback.
export async function runIblPublicationGpuOracle(device) {
  const pipelines = new Map(), buffers = [];
  const accounting = new ResourceAccounting();
  const graphics = { device, samplers: new GPUSamplerCache(device), resource_accounting: accounting };
  const authored = new GpuAuthoredEnvironment(graphics);
  const physical = new PhysicalEnvironmentRuntime(device);
  await physical.preparePipelines();
  const command = () => {
    const aborted = [], finished = [], encoder = device.createCommandEncoder();
    const host = {
      gpuDone: Promise.resolve(),
      onAborted: { addOne: (fn) => aborted.push(fn) },
      onFinished: { addOne: (fn) => finished.push(fn) },
      allocateTransientBufferAndLoad(data, usage) {
        const b = device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true });
        new Uint8Array(b.getMappedRange()).set(new Uint8Array(data)); b.unmap(); buffers.push(b); return b;
      },
      constructComputePass({ pipeline: descriptor, bindings }) {
        let p = pipelines.get(descriptor);
        if (!p) {
          const layout = device.createPipelineLayout({
            bindGroupLayouts: descriptor.layout.bindGroupLayouts.map((g) => device.createBindGroupLayout(g)),
          });
          p = device.createComputePipeline({
            layout,
            compute: {
              module: device.createShaderModule(descriptor.compute.module),
              entryPoint: descriptor.compute.entryPoint,
            },
          });
          pipelines.set(descriptor, p);
        }
        const pass = encoder.beginComputePass({ label: descriptor.label });
        pass.setPipeline(p);
        bindings.forEach((resources, index) =>
          pass.setBindGroup(
            index,
            device.createBindGroup({
              layout: p.getBindGroupLayout(index),
              entries: resources.map((resource, binding) => ({ binding, resource })),
            }),
          ),
        );
        return pass;
      },
    };
    return {
      host,
      encoder,
      abort: () => aborted.forEach((fn) => fn()),
      submit: () => {
        device.queue.submit([encoder.finish()]);
        host.gpuDone = device.queue.onSubmittedWorkDone();
        finished.forEach((fn) => fn());
        return host.gpuDone;
      },
    };
  };
  const makeSource = (size, format) => {
    const image = new ShadeImage();
    image.width = image.height = size;
    image.depth = 1;
    const data =
      format === "rgba32float"
        ? new Float32Array(size * size * 4).fill(0.25)
        : format === "rgba16float"
          ? new Uint16Array(size * size * 4).fill(0x3400)
          : new Uint8Array(size * size * 4).fill(64);
    image.source = data.buffer;
    image.data_type = format === "rgba32float" ? "float32" : format === "rgba16float" ? "uint16" : "uint8";
    image.color_space = format === "rgba8unorm-srgb" ? 1 : 2;
    return ShadeTexture.from(image);
  };
  const consumer = await device.createComputePipelineAsync({ layout: "auto", compute: { entryPoint: "main",
    module: device.createShaderModule({ code: `
${NATIVE_ENVIRONMENT_SAMPLE_WGSL}
${ENVIRONMENT_BRDF_WGSL}
@group(0) @binding(0) var diffuse: texture_2d<f32>;
@group(0) @binding(1) var specular: texture_2d<f32>;
@group(0) @binding(2) var dfg: texture_2d<f32>;
@group(0) @binding(3) var linear_clamp: sampler;
@group(0) @binding(4) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let direction = normalize(vec3f(0.13 + f32(id.x), 0.7, -0.31));
  let roughness = f32(id.x) / 3.0;
  let irradiance = sample_native_environment_mip(diffuse, direction, 0u);
  let radiance = sample_native_environment(specular, direction, roughness);
  let lut = sample_environment_dfg(dfg, linear_clamp, 0.6, roughness);
  output[id.x] = vec4f(irradiance + radiance * environment_dfg_single_scatter(lut, vec3f(0.04)), 1.0);
}` }) } });
  const consume = async (encoder, views, sampler, submit) => {
    const out = device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    buffers.push(out, read);
    const p = encoder.beginComputePass();
    p.setPipeline(consumer);
    p.setBindGroup(
      0,
      device.createBindGroup({
        layout: consumer.getBindGroupLayout(0),
        entries: [views.diffuse, views.specular, views.dfg, sampler, { buffer: out }].map(
          (resource, binding) => ({ binding, resource }),
        ),
      }),
    );
    p.dispatchWorkgroups(4);
    p.end();
    encoder.copyBufferToBuffer(out, 0, read, 0, 64);
    await submit();
    await read.mapAsync(GPUMapMode.READ);
    const values = Array.from(new Float32Array(read.getMappedRange()));
    read.unmap();
    assert.ok(values.every(Number.isFinite));
    assert.ok(values.some((v, i) => i % 4 !== 3 && v > 0));
    return values;
  };
  const snapshot = {
    worldToUnit: 0.001,
    lutGeneration: 1,
    sunDirectionWorld: [0, 1, 0],
    sunIrradiance: [1.474, 1.8504, 1.91198],
    skyLuminanceScale: 1,
    lightingDiagnostic: "all",
    aerialPerspectiveEnabled: true,
    shadowLength: [0, 0],
  };
  const results = [];
  try {
    for (const format of ["rgba16float", "rgba32float", "rgba8unorm", "rgba8unorm-srgb"]) {
      const source = makeSource(3, format), aborted = command(), previousRevision = authored.publicationRevision;
      authored.record(aborted.host, source); aborted.abort(); assert.equal(authored.publicationRevision, previousRevision);
      const c = command(); assert.equal(authored.record(c.host, source), true);
      assert.equal(authored.record(c.host, source), false);
      const values = await consume(c.encoder, authored.views, authored.sampler, c.submit);
      await Promise.resolve(); assert.equal(authored.record(command().host, source), false);
      // NPOT specular 3²+1², diffuse32² and DFG64²; scratch must retire at completion.
      assert.equal(authored.allocatedBytes, (10 + 1024 + 4096) * 8);
      results.push({ owner: "authored", format, values, bytes: authored.allocatedBytes });
    }
    let encoder = device.createCommandEncoder();
    let generation = physical.record(encoder, snapshot, [0, 0, 0]);
    physical.abort(generation);
    assert.equal(physical.state.active, null);
    for (const [camera, sun] of [
      [
        [0, 0, 0],
        [0, 1, 0],
      ],
      [
        [30, 0, 0],
        [0, 1, 0],
      ],
      [
        [30, 0, 0],
        [0, 0.6, 0.8],
      ],
    ]) {
      encoder = device.createCommandEncoder();
      generation = physical.record(encoder, { ...snapshot, sunDirectionWorld: sun }, camera);
      assert.notEqual(generation, null);
      const values = await consume(encoder, physical.ibl.views, physical.ibl.sampler, () => {
        device.queue.submit([encoder.finish()]);
        const done = device.queue.onSubmittedWorkDone();
        physical.commit(generation, done);
        return done;
      });
      results.push({ owner: "physical", camera, sun, generation, values });
      assert.equal(
        physical.record(device.createCommandEncoder(), { ...snapshot, sunDirectionWorld: sun }, camera),
        null,
      );
    }
    const tooSmall = new GpuAuthoredEnvironment(graphics, 1);
    let budgetError;
    try { tooSmall.record(command().host, makeSource(1, "rgba32float")); } catch (error) { budgetError = error; }
    assert.ok(budgetError instanceof RangeError && /budget/.test(budgetError.message)); tooSmall.destroy();
    authored.destroy(); authored.destroy(); physical.destroy(); physical.destroy();
    assert.equal(authored.allocatedBytes, 0); assert.equal(accounting.snapshot().liveBytes, 0);
    return { status: "passed", results, abortRetry: true, fenceScratch: true, probeAndSunUpdates: true };
  } finally {
    await device.queue.onSubmittedWorkDone();
    authored.destroy();
    physical.destroy();
    buffers.forEach((b) => b.destroy());
  }
}
