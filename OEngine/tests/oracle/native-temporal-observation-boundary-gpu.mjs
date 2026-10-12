import assert from "node:assert/strict";
import { NATIVE_TEMPORAL_V2_SHADING_CHANGE_WGSL } from "../../.test-dist/shaders/native_temporal_amd.js";
import { FSR3_SHADING_CHANGE_WGSL } from "../../.test-dist/render/passes/fsr3/Fsr3ShadingChangePass.js";
import { FSR3_UPSCALER_CONSTANTS_BYTES } from "../../.test-dist/render/passes/fsr3/Fsr3UpscalerConstants.js";
import { floatToHalf } from "../../.test-dist/loaders/float16.js";

// Independent pinned-reference producer, real RG16 filtering and actual R8
// stores. Compare stored bytes, not two copies of the removed inline helper.
export async function runNativeTemporalObservationBoundaryGpuOracle(device) {
  const native = await device.createComputePipelineAsync({
    layout: "auto", compute: { module: device.createShaderModule({ code: NATIVE_TEMPORAL_V2_SHADING_CHANGE_WGSL }), entryPoint: "main" },
  });
  const reference = await device.createComputePipelineAsync({
    layout: "auto", compute: { module: device.createShaderModule({ code: FSR3_SHADING_CHANGE_WGSL }), entryPoint: "main" },
  });
  const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  const jitters = [[0, -1 / 6], [-.25, 1 / 6], [.25, -7 / 18], [-.375, -1 / 18], [.125, 5 / 18], [-.125, -5 / 18], [.375, 1 / 18], [-.4375, 7 / 18]];
  let compared = 0;
  const cases = [];
  for (const [width, height] of [[1, 1], [3, 5], [65, 49], [1919, 1079], [1920, 1080]]) {
    const owned = [];
    try {
      const mips = [2, 4, 8].map((scale, level) => {
        const w = Math.ceil(width / scale), h = Math.ceil(height / scale);
        const texture = device.createTexture({ size: [w, h], format: "rg16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        owned.push(texture);
        const data = new Uint16Array(w * h * 2);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const index = (y * w + x) * 2;
          data[index] = floatToHalf(width === 1 ? .75 : ((x * 37 + y * 19 + level * 29) % 9 - 4) / 8);
          data[index + 1] = floatToHalf(width === 1 ? .5 : ((x * 13 + y * 7 + level * 11) % 7 - 3) / 4);
        }
        device.queue.writeTexture({ texture }, data, { bytesPerRow: w * 4 }, [w, h]);
        return texture;
      });
      const w = Math.max(1, Math.floor(width / 2)), h = Math.max(1, Math.floor(height / 2));
      const outputs = [0, 1].map(() => {
        const texture = device.createTexture({ size: [w, h], format: "r8unorm", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
        owned.push(texture);
        return texture;
      });
      const uniforms = [48, FSR3_UPSCALER_CONSTANTS_BYTES].map((size) => {
        const buffer = device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        owned.push(buffer);
        return buffer;
      });
      const groups = [native, reference].map((pipeline, index) => device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: index === 0 ? [
          { binding: 0, resource: { buffer: uniforms[0] } },
          ...mips.map((texture, mip) => ({ binding: mip + 1, resource: texture.createView() })),
          { binding: 4, resource: sampler }, { binding: 5, resource: outputs[0].createView() },
        ] : [
          ...mips.map((texture, mip) => ({ binding: mip, resource: texture.createView() })),
          { binding: 3, resource: sampler }, { binding: 4, resource: { buffer: uniforms[1] } },
          { binding: 5, resource: outputs[1].createView() },
        ],
      }));
      const row = Math.ceil(w / 256) * 256, bytes = row * h;
      const readback = device.createBuffer({ size: bytes * 2, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      owned.push(readback);
      for (const jitter of jitters) {
        const frame = new ArrayBuffer(48);
        new Uint32Array(frame).set([width, height]);
        new Float32Array(frame).set(jitter, 4);
        device.queue.writeBuffer(uniforms[0], 0, frame);
        const sdk = new ArrayBuffer(FSR3_UPSCALER_CONSTANTS_BYTES);
        new Int32Array(sdk).set([width, height]);
        new Float32Array(sdk).set(jitter, 16);
        device.queue.writeBuffer(uniforms[1], 0, sdk);
        const encoder = device.createCommandEncoder();
        for (let index = 0; index < (width === 1 ? 1 : 2); index++) {
          const pass = encoder.beginComputePass();
          pass.setPipeline(index === 0 ? native : reference);
          pass.setBindGroup(0, groups[index]);
          pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
          pass.end();
          encoder.copyTextureToBuffer({ texture: outputs[index] }, { buffer: readback, offset: index * bytes, bytesPerRow: row }, [w, h]);
        }
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const values = new Uint8Array(readback.getMappedRange());
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const index = y * row + x;
          const expected = width === 1 ? 96 : values[bytes + index];
          assert.equal(values[index], expected, `R8 boundary ${width}x${height}, jitter ${jitter}, ${x},${y}`);
          compared++;
        }
        readback.unmap();
      }
      cases.push({ width, height, domain: [w, h], phases: jitters.length });
    } finally {
      await device.queue.onSubmittedWorkDone();
      owned.forEach((resource) => resource.destroy());
    }
  }
  return { status: "passed", comparedR8Bytes: compared, cases, reference: "Pinned SDK shading-change producer, exact stored R8 byte comparison; 1x1 constant checked analytically because donor floor-half domain is empty." };
}
