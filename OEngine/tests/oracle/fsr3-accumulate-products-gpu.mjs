import assert from "node:assert/strict";
import { FrameGraph, FrameGraphContext } from "../../.test-dist/framegraph/FrameGraph.js";
import { Fsr3AccumulatePass } from "../../.test-dist/render/passes/fsr3/Fsr3AccumulatePass.js";
import { Fsr3RcasPass, FSR3_RCAS_WGSL, packFsr3RcasConstants } from "../../.test-dist/render/passes/fsr3/Fsr3RcasPass.js";
import { packFsr3UpscalerConstants } from "../../.test-dist/render/passes/fsr3/Fsr3UpscalerConstants.js";
import { floatToHalf } from "../../.test-dist/loaders/float16.js";
import { REFERENCE_ACCUMULATE_WGSL } from "./fixtures/fsr3-accumulate-products-v1.mjs";

// Exercise the actual production pass, write-version dependency and RCAS binding.
// The frozen shader proves product equivalence, not independent FSR math quality.
export async function runFsr3AccumulateProductsGpuOracle(device) {
  const pipeline = (code) => device.createComputePipelineAsync({
    layout: "auto",
    compute: { module: device.createShaderModule({ code }), entryPoint: "main" },
  });
  const reference = await pipeline(REFERENCE_ACCUMULATE_WGSL);
  const referenceRcas = await pipeline(FSR3_RCAS_WGSL);
  const reader = await pipeline(`
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> values: array<vec4u>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(source);
  if (id.x >= size.x * size.y) { return; }
  let pixel = vec2i(vec2u(id.x % size.x, id.x / size.x));
  values[id.x] = bitcast<vec4u>(textureLoad(source, pixel, 0));
}`);
  const accumulate = new Fsr3AccumulatePass(device);
  const rcas = new Fsr3RcasPass(device);
  const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  const cases = [];
  // 1:1, true upscaling and non-integral ratios; partial workgroups/edge clamps.
  for (const [width, height, outputWidth, outputHeight] of [
    [8, 8, 8, 8], [17, 9, 17, 9], [17, 9, 34, 18], [33, 17, 49, 25],
  ]) {
    for (const phase of [0, 1, 2, 3]) {
      const owned = [];
      const texture = (w, h, format, storage = false) => {
        const result = device.createTexture({
          size: [w, h], format,
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING |
            (storage ? GPUTextureUsage.STORAGE_BINDING : 0),
        });
        owned.push(result);
        return result;
      };
      const buffer = (size, usage) => {
        const result = device.createBuffer({ size, usage });
        owned.push(result);
        return result;
      };
      let complete;
      let compiled;
      try {
        const fill = (target, channels, values, half = false) => {
          const data = new Float32Array(target.width * target.height * channels);
          for (let pixel = 0; pixel < target.width * target.height; pixel++) {
            data.set(values(pixel), pixel * channels);
          }
          const bytes = half ? Uint16Array.from(data, floatToHalf) : data;
          device.queue.writeTexture({ texture: target }, bytes,
            { bytesPerRow: target.width * channels * (half ? 2 : 4) }, [target.width, target.height]);
        };
        const color = texture(width, height, "rgba16float");
        const motion = texture(width, height, "rgba16float");
        const instability = texture(width, height, "r16float");
        const farthest = texture(Math.floor(width / 2), Math.floor(height / 2), "r16float");
        const masks = texture(width, height, "rgba16float");
        const locks = texture(outputWidth, outputHeight, "r16float");
        const previous = texture(outputWidth, outputHeight, "rgba16float");
        const exposure = texture(1, 1, "r32float");
        const history = texture(outputWidth, outputHeight, "rgba16float", true);
        const expectedHistory = texture(outputWidth, outputHeight, "rgba16float", true);
        const expectedColor = texture(outputWidth, outputHeight, "rgba16float", true);
        const expectedSharpened = texture(outputWidth, outputHeight, "rgba16float", true);
        fill(color, 4, (i) => {
          const hdr = phase === 3 && i % 19 === 0 ? 2048 : 0.02 + (i % 31) / 7;
          return [hdr, hdr * 0.25, hdr * 0.7, 1];
        }, true);
        fill(previous, 4, (i) => [0.1 + (i % 13) / 9, (i % 11) / 4, 0.25, (i % 9) / 4], true);
        fill(motion, 4, (i) => phase >= 2 ? [i % 23 === 0 ? 1.2 : -0.7 / width, 0.6 / height, 0, 0] : [0, 0, 0, 0], true);
        fill(instability, 1, (i) => [(i % 7) / 8], true);
        fill(farthest, 1, (i) => [i % 5 === 0 ? 0 : 10 + i % 37], true);
        fill(masks, 4, (i) => phase === 0 ? [0, 0, 0, 0] : [(i % 7) / 8, (i % 11) / 12, (i % 13) / 14, i % 17 === 0 ? 0 : 0.8], true);
        fill(locks, 1, (i) => [(i % 5) / 4], true);
        fill(exposure, 1, () => [phase === 0 ? 0 : phase === 3 ? 0.125 : 1.7]);
        const constants = buffer(160, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        device.queue.writeBuffer(constants, 0, packFsr3UpscalerConstants({
          renderSize: [width, height], previousFrameRenderSize: [width, height],
          upscaleSize: [outputWidth, outputHeight], previousFrameUpscaleSize: [outputWidth, outputHeight],
          maxRenderSize: [width, height], maxUpscaleSize: [outputWidth, outputHeight],
          deviceToViewDepth: [0, 0.1, 1, 1],
          jitterOffset: [[0, 0], [0.37, -0.29], [-0.47, 0.43], [-0.31, -0.41]][phase],
          previousFrameJitterOffset: [0.17, -0.13], motionVectorScale: [-1, -1],
          downscaleFactor: [width / outputWidth, height / outputHeight],
          motionVectorJitterCancellation: [0, 0], tanHalfFOV: 1,
          jitterPhaseCount: 8, deltaTime: 1 / 60, deltaPreExposure: phase === 3 ? 4 : 0.75,
          viewSpaceToMetersFactor: 1, frameIndex: phase === 0 ? 0 : 9,
          velocityFactor: 1, reactivenessScale: 1, shadingChangeScale: 1,
          accumulationAddedPerFrame: 1 / 8, minDisocclusionAccumulation: -0.5,
        }));
        const rcasConstants = buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        device.queue.writeBuffer(rcasConstants, 0, packFsr3RcasConstants(phase / 3));
        const size = outputWidth * outputHeight * 16;
        const values = buffer(size, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
        const targets = Array.from({ length: 5 }, () => buffer(size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST));
        const read = (encoder, source, target) => {
          const pass = encoder.beginComputePass();
          pass.setPipeline(reader);
          pass.setBindGroup(0, device.createBindGroup({
            layout: reader.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: source.createView() }, { binding: 1, resource: { buffer: values } }],
          }));
          pass.dispatchWorkgroups(Math.ceil((outputWidth * outputHeight) / 64));
          pass.end();
          encoder.copyBufferToBuffer(values, 0, target, 0, size);
        };
        const graph = new FrameGraph("FSR3 history product oracle");
        const imported = (name, resource) => graph.import_resource(name, { kind: "imported" }, resource);
        const exposureId = imported("exposure", exposure);
        const written = accumulate.addToGraph(graph, {
          color: imported("input", color), dilatedMotion: imported("motion", motion),
          lumaInstability: imported("instability", instability), farthestDepthMip1: imported("depth", farthest),
          dilatedReactive: imported("masks", masks), newLocks: imported("locks", locks),
          previousHistory: imported("previous", previous), currentHistory: imported("current", history),
          exposure: exposureId, constants: imported("constants", constants), width: outputWidth, height: outputHeight,
        });
        const sharpened = rcas.addToGraph(graph, {
          color: written, exposure: exposureId, constants: imported("rcas constants", rcasConstants),
          width: outputWidth, height: outputHeight,
        });
        const consume = graph.add("read actual history and final output", {}, (_, resources, context) => {
          read(context.encoder, resources.get(written), targets[0]);
          read(context.encoder, resources.get(sharpened), targets[3]);
        });
        consume.read(written);
        consume.read(sharpened);
        consume.make_side_effect();
        const encoder = device.createCommandEncoder();
        const completion = new Promise((resolve) => { complete = resolve; });
        compiled = graph.compile();
        compiled.execute(new FrameGraphContext({ device, encoder, completion }));
        const dispatch = (pipeline, resources) => {
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: resources.map((resource, binding) => ({ binding, resource })),
          }));
          pass.dispatchWorkgroups(Math.ceil(outputWidth / 8), Math.ceil(outputHeight / 8));
          pass.end();
        };
        dispatch(reference, [
          color, motion, instability, farthest, masks, locks, previous, exposure,
        ].map((t) => t.createView()).concat([
          sampler, { buffer: constants }, expectedHistory.createView(), expectedColor.createView(),
        ]));
        dispatch(referenceRcas, [expectedColor.createView(), exposure.createView(), { buffer: rcasConstants }, expectedSharpened.createView()]);
        read(encoder, expectedHistory, targets[1]);
        read(encoder, expectedColor, targets[2]);
        read(encoder, expectedSharpened, targets[4]);
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        complete();
        await Promise.all(targets.map((target) => target.mapAsync(GPUMapMode.READ)));
        const [actual, oldHistory, oldColor, final, oldFinal] = targets.map((target) => new Uint32Array(target.getMappedRange()));
        let nonUnitLocks = 0;
        for (let i = 0; i < actual.length; i++) {
          const label = `${width}x${height}->${outputWidth}x${outputHeight} phase${phase} word${i}`;
          assert.equal(actual[i], oldHistory[i], `history RGBA ${label}`);
          assert.equal(final[i], oldFinal[i], `RCAS RGBA ${label}`);
          if (i % 4 !== 3) {
            assert.equal(actual[i], oldColor[i], `duplicate RGB ${label}`);
          } else {
            assert.equal(final[i], 0x3f800000, `RCAS alpha ${label}`);
            if (actual[i] !== 0x3f800000) nonUnitLocks++;
          }
        }
        assert.ok(nonUnitLocks > 0, "history alpha must retain locks, not output opacity");
        targets.forEach((target) => target.unmap());
        cases.push({ width, height, outputWidth, outputHeight, phase, comparedWords: size / 4 * 2 + outputWidth * outputHeight * 3, nonUnitLocks, maximumError: 0 });
      } finally {
        await device.queue.onSubmittedWorkDone();
        complete?.();
        compiled?.destroy();
        owned.forEach((resource) => resource.destroy());
      }
    }
  }
  return { status: "passed", cases, reference: "frozen EEngine f6f7189f Accumulate products; unchanged RCAS math" };
}
