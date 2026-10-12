import assert from "node:assert/strict";
import * as Before from "./fixtures/native-temporal-observation/before-shaders.mjs";
import * as Candidate from "../../.test-dist/shaders/native_temporal_amd.js";
import { floatToHalf } from "../../.test-dist/loaders/float16.js";

// Exact product comparison against the frozen original 64x64 reduction.
// Covers tile/halo seams, strict receiver ties, sky and the mip-5 boundary.
export async function runNativeTemporalObservationMeasureGpuOracle(device) {
  const pipelines = [Before, Candidate].map((source) => {
    const pipeline = (code, entries) =>
      device.createComputePipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [device.createBindGroupLayout({ entries })]
        }),
        compute: { module: device.createShaderModule({ code }), entryPoint: "main" }
      });
    const uniform = { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } };
    const sampled = (binding) => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType: "unfilterable-float" }
    });
    const output = (binding, format) => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      storageTexture: { access: "write-only", format }
    });
    return {
      measure: pipeline(source.NATIVE_TEMPORAL_V2_MEASURE_WGSL, [
        uniform,
        sampled(1),
        output(2, "r16float"),
        output(3, "r32float"),
        sampled(4),
        output(5, "r16float"),
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        output(7, "r32uint")
      ]),
      exposure: pipeline(source.NATIVE_TEMPORAL_V2_EXPOSURE_WGSL, [
        uniform,
        sampled(1),
        sampled(2),
        output(3, "rgba32float")
      ])
    };
  });
  const cases = [];
  let comparedBytes = 0;
  for (const [width, height] of [
    [1, 1],
    [3, 5],
    [31, 33],
    [32, 32],
    [33, 31],
    [63, 65],
    [65, 63],
    [1919, 1079],
    [1920, 1080],
    [4096, 65],
    [65, 4096],
    [4096, 4096]
  ]) {
    const owned = [];
    const texture = (format, w, h, output = false) => {
      const resource = device.createTexture({
        size: [w, h],
        format,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST |
          (output ? GPUTextureUsage.STORAGE_BINDING : 0)
      });
      owned.push(resource);
      return resource;
    };
    const buffer = (size, usage) => {
      const resource = device.createBuffer({ size, usage });
      owned.push(resource);
      return resource;
    };
    try {
      const color = texture("rgba16float", width, height);
      const seed = texture("rgba32float", width, height);
      const colors = new Uint16Array(width * height * 4);
      const seeds = new Float32Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const index = (y * width + x) * 4;
          const value = [0, 0.5, 128, 8192, 0.125, 1.3, 4096][(x * 37 + y * 19) % 7];
          colors.set(
            [floatToHalf(value), floatToHalf(value * 0.5), floatToHalf(value * 0.25), floatToHalf(1)],
            index
          );
          seeds[index + 3] = (x + y) % 7 === 0 ? 0 : [0.1, 0.1, 2, 65504][(x * 13 + y * 7) % 4];
        }
      }
      device.queue.writeTexture({ texture: color }, colors, { bytesPerRow: width * 8 }, [width, height]);
      device.queue.writeTexture({ texture: seed }, seeds, { bytesPerRow: width * 16 }, [width, height]);
      const frame = buffer(48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const previous = texture("rgba32float", 1, 1);
      device.queue.writeTexture(
        { texture: previous },
        new Float32Array([0.7, 1.25, 0, 0]),
        { bytesPerRow: 16 },
        [1, 1]
      );
      const products = [64, 32].map((tile) => ({
        luma: texture("r16float", width, height, true),
        box: texture("r16float", Math.ceil(width / 2), Math.ceil(height / 2), true),
        receivers: texture("r32uint", width, height, true),
        logs: texture("r32float", Math.ceil(width / tile), Math.ceil(height / tile), true),
        info: texture("rgba32float", 1, 1, true),
        weights: buffer(96, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
      }));
      const measureGroups = products.map((p, index) =>
        device.createBindGroup({
          layout: pipelines[index].measure.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: frame } },
            { binding: 1, resource: color.createView() },
            { binding: 2, resource: p.luma.createView() },
            { binding: 3, resource: p.logs.createView() },
            { binding: 4, resource: seed.createView() },
            { binding: 5, resource: p.box.createView() },
            { binding: 6, resource: { buffer: p.weights } },
            { binding: 7, resource: p.receivers.createView() }
          ]
        })
      );
      const exposureGroups = products.map((p, index) =>
        device.createBindGroup({
          layout: pipelines[index].exposure.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: frame } },
            { binding: 1, resource: p.logs.createView() },
            { binding: 2, resource: previous.createView() },
            { binding: 3, resource: p.info.createView() }
          ]
        })
      );
      let bytes = 256;
      const copies = [
        ["luma", width, height, 2],
        ["box", Math.ceil(width / 2), Math.ceil(height / 2), 2],
        ["receivers", width, height, 4],
        ["info", 1, 1, 16]
      ].map(([name, w, h, stride]) => {
        const row = Math.ceil((w * stride) / 256) * 256;
        const copy = { name, width: w, height: h, row, stride, offset: bytes };
        bytes += row * h;
        return copy;
      });
      const readback = buffer(bytes * 2, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
      const phases = width === 4096 && height === 4096 ? 1 : 8;
      for (let phase = 0; phase < phases; phase++) {
        const constants = new ArrayBuffer(48);
        new Uint32Array(constants).set([width, height, phase % 2]);
        new Float32Array(constants).set([(((phase * 3) % 8) - 4) / 8, (((phase * 5) % 9) - 4) / 9], 4);
        new Float32Array(constants).set([1 / 60, phase % 2 ? 65504 : 1000], 8);
        device.queue.writeBuffer(frame, 0, constants);
        const encoder = device.createCommandEncoder();
        for (let index = 0; index < 2; index++) {
          let pass = encoder.beginComputePass();
          pass.setPipeline(pipelines[index].measure);
          pass.setBindGroup(0, measureGroups[index]);
          const tile = index === 0 ? 64 : 32;
          pass.dispatchWorkgroups(Math.ceil(width / tile), Math.ceil(height / tile));
          pass.end();
          pass = encoder.beginComputePass();
          pass.setPipeline(pipelines[index].exposure);
          pass.setBindGroup(0, exposureGroups[index]);
          pass.dispatchWorkgroups(1);
          pass.end();
          encoder.copyBufferToBuffer(products[index].weights, 0, readback, index * bytes, 96);
          for (const copy of copies) {
            encoder.copyTextureToBuffer(
              { texture: products[index][copy.name] },
              { buffer: readback, offset: index * bytes + copy.offset, bytesPerRow: copy.row },
              [copy.width, copy.height]
            );
          }
        }
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const data = new Uint8Array(readback.getMappedRange());
        let mismatch = -1;
        for (let k = 0; k < 96; k++) {
          if (data[k] !== data[bytes + k]) {
            mismatch = k;
            break;
          }
        }
        assert.equal(mismatch, -1, `weights ${width}x${height}, phase ${phase}, byte ${mismatch}`);
        comparedBytes += 96;
        for (const copy of copies) {
          mismatch = -1;
          for (let y = 0; y < copy.height && mismatch < 0; y++) {
            for (let x = 0; x < copy.width * copy.stride; x++) {
              const k = copy.offset + y * copy.row + x;
              if (data[k] !== data[bytes + k]) {
                mismatch = k;
                break;
              }
            }
          }
          assert.equal(mismatch, -1, `${copy.name} ${width}x${height}, phase ${phase}, byte ${mismatch}`);
          comparedBytes += copy.width * copy.height * copy.stride;
        }
        readback.unmap();
      }
      cases.push({ width, height, phases });
    } finally {
      await device.queue.onSubmittedWorkDone();
      owned.forEach((resource) => resource.destroy());
    }
  }
  return {
    status: "passed",
    comparedBytes,
    cases,
    reference:
      "Frozen original Measure/Exposure; exact bytes for luma, half-depth box, receiver, filter weights and frameInfo. Includes full 4096x4096 negotiated limit."
  };
}
