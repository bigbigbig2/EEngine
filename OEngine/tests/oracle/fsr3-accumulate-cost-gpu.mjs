import { FSR3_ACCUMULATE_WGSL } from "../../.test-dist/render/passes/fsr3/Fsr3AccumulateShader.js";
import { TILE_CANDIDATE_WGSL } from "./fixtures/fsr3-accumulate-tile-candidate.mjs";
import { packFsr3UpscalerConstants } from "../../.test-dist/render/passes/fsr3/Fsr3UpscalerConstants.js";
import { floatToHalf } from "../../.test-dist/loaders/float16.js";

// Paired execution cost, not a scene benchmark or quality oracle. Both kernels
// use the production math with identical inputs; ABBA keeps order visible.
export async function runFsr3AccumulateCostGpuOracle(device) {
  const owned = [];
  const width = 1920, height = 1080;
  const texture = (w, h, format, value, storage = false) => {
    const t = device.createTexture({ size: [w, h], format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
        (storage ? GPUTextureUsage.STORAGE_BINDING : 0) });
    owned.push(t);
    const channels = format.startsWith("rgba") ? 4 : 1;
    const half = format.endsWith("16float");
    const data = half ? new Uint16Array(w * h * channels) : new Float32Array(w * h * channels);
    for (let i = 0; i < w * h; i++) for (let c = 0; c < channels; c++) {
      const v = value(i, c);
      data[i * channels + c] = half ? floatToHalf(v) : v;
    }
    device.queue.writeTexture({ texture: t }, data, { bytesPerRow: w * channels * data.BYTES_PER_ELEMENT }, [w, h]);
    return t.createView();
  };
  const buffer = (size, usage) => {
    const b = device.createBuffer({ size, usage }); owned.push(b); return b;
  };
  try {
    const inputs = [
      texture(width, height, "rgba16float", (i, c) => c === 3 ? 1 : .1 + (i % 31) / 9),
      texture(width, height, "rgba16float", (_, c) => c === 0 ? -.7 / width : c === 1 ? .6 / height : 0),
      texture(width, height, "r16float", i => (i % 7) / 8),
      texture(width / 2, height / 2, "r16float", i => 10 + i % 37),
      texture(width, height, "rgba16float", (i, c) => c === 3 ? .8 : (i % 7) / 8),
      texture(width, height, "r16float", i => (i % 5) / 4),
      texture(width, height, "rgba16float", (i, c) => c === 3 ? .5 : .2 + (i % 13) / 9),
      texture(1, 1, "r32float", () => 1.7),
      device.createSampler({ minFilter: "linear", magFilter: "linear" }),
    ];
    const constants = buffer(160, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(constants, 0, packFsr3UpscalerConstants({
      renderSize: [width, height], previousFrameRenderSize: [width, height],
      upscaleSize: [width, height], previousFrameUpscaleSize: [width, height],
      maxRenderSize: [width, height], maxUpscaleSize: [width, height],
      deviceToViewDepth: [0, .1, 1, 1], jitterOffset: [.37, -.29],
      previousFrameJitterOffset: [.17, -.13], motionVectorScale: [-1, -1],
      downscaleFactor: [1, 1], motionVectorJitterCancellation: [0, 0], tanHalfFOV: 1,
      jitterPhaseCount: 8, deltaTime: 1 / 60, deltaPreExposure: .75,
      viewSpaceToMetersFactor: 1, frameIndex: 9, velocityFactor: 1,
      reactivenessScale: 1, shadingChangeScale: 1, accumulationAddedPerFrame: 1 / 8,
      minDisocclusionAccumulation: -.5,
    }));
    inputs.push({ buffer: constants }, texture(width, height, "rgba16float", () => 0, true));
    const pipelines = await Promise.all([false, true].map(async tiled => {
      const p = await device.createComputePipelineAsync({ layout: "auto",
        compute: { module: device.createShaderModule({ code: tiled ? TILE_CANDIDATE_WGSL : FSR3_ACCUMULATE_WGSL }), entryPoint: "main" } });
      return { p, group: device.createBindGroup({ layout: p.getBindGroupLayout(0),
        entries: inputs.map((resource, binding) => ({ resource, binding })) }) };
    }));
    const query = device.createQuerySet({ type: "timestamp", count: 48 }); owned.push(query);
    const resolved = buffer(48 * 8, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC);
    const readback = buffer(48 * 8, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const encoder = device.createCommandEncoder();
    const order = Array.from({ length: 24 }, (_, i) => [0, 1, 1, 0][i % 4]);
    // Untimed warmup for both pipeline/resource states.
    for (const index of [0, 1, 0, 1]) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipelines[index].p); pass.setBindGroup(0, pipelines[index].group);
      pass.dispatchWorkgroups(width / 8, height / 8); pass.end();
    }
    order.forEach((index, i) => {
      const pass = encoder.beginComputePass({ timestampWrites: { querySet: query,
        beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 } });
      pass.setPipeline(pipelines[index].p); pass.setBindGroup(0, pipelines[index].group);
      pass.dispatchWorkgroups(width / 8, height / 8); pass.end();
    });
    encoder.resolveQuerySet(query, 0, 48, resolved, 0);
    encoder.copyBufferToBuffer(resolved, 0, readback, 0, 48 * 8);
    device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
    const ticks = new BigUint64Array(readback.getMappedRange());
    const samples = order.map((index, i) => ({ tiled: Boolean(index), ms: Number(ticks[i * 2 + 1] - ticks[i * 2]) / 1e6 }));
    readback.unmap();
    return { status: "passed", domain: [width, height], samples,
      note: "Synthetic prepared inputs, same history/math; not Dungeon, occupancy or locked-clock evidence." };
  } finally {
    await device.queue.onSubmittedWorkDone(); owned.forEach(r => r.destroy());
  }
}
