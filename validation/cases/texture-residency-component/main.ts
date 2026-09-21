import { createValidationController } from "../../host/protocol.ts";
import {
  attachGpuErrorCollection,
  snapshotAdapterInfo,
  snapshotGpuFeatures,
  snapshotGpuLimits,
  withGpuErrorScopes
} from "../../host/webgpu.ts";
import { GPU_MATERIAL_VISIBILITY_RECORD_WGSL } from "../../../../OEngine/src/gpu/GpuMaterialVisibilityAbi.ts";
import { gpuTextureBankSampleWgsl } from "../../../../OEngine/src/gpu/GpuTextureRefAbi.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#output");
const status = document.querySelector<HTMLElement>("#status");
let device: GPUDevice | undefined;
let errorCollection: ReturnType<typeof attachGpuErrorCollection> | undefined;
let intentionalLoss = false;
const owned: GPUTexture[] = [];
const ownedBuffers: GPUBuffer[] = [];
const ownedSamplers: GPUSampler[] = [];

const controller = createValidationController({
  caseId: "texture-residency-component",
  workloadId: "texture-residency-component-v1"
}, async () => {
  for (const buffer of ownedBuffers.splice(0)) buffer.destroy();
  for (const texture of owned.splice(0)) texture.destroy();
  ownedSamplers.splice(0);
  errorCollection?.remove();
  intentionalLoss = true;
  device?.destroy();
  if (status) status.textContent = "disposed";
  return { buffers: 0, textures: 0, samplers: 0, devices: 0, intentionalDeviceDestroy: intentionalLoss };
});

function paddedRows(width: number, height: number, rgba: readonly [number, number, number, number]): Uint8Array {
  const bytesPerRow = 256;
  const output = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) output.set(rgba, y * bytesPerRow + x * 4);
  }
  return output;
}

function writeSolidMip(texture: GPUTexture, level: number, width: number, height: number, rgba: readonly [number, number, number, number]): void {
  device!.queue.writeTexture(
    { texture, mipLevel: level },
    paddedRows(width, height, rgba),
    { bytesPerRow: 256, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 }
  );
}

function matches(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]!) < 0.02);
}

try {
  controller.transition("negotiating");
  if (!window.isSecureContext || !navigator.gpu) {
    controller.unsupported("WebGPU secure context is unavailable");
  } else {
    const adapter = await navigator.gpu.requestAdapter({ featureLevel: "core", powerPreference: "high-performance" });
    if (!adapter || !adapter.features.has("core-features-and-limits")) {
      controller.unsupported("WebGPU core-features-and-limits is unavailable");
    } else {
      controller.addEvidence("adapter", {
        info: snapshotAdapterInfo(adapter.info),
        features: snapshotGpuFeatures(adapter.features),
        limits: snapshotGpuLimits(adapter.limits)
      });
      device = await adapter.requestDevice({ label: "Mode A texture residency validation", requiredFeatures: ["core-features-and-limits"] });
      errorCollection = attachGpuErrorCollection(device, controller, () => intentionalLoss);
      controller.addEvidence("device", { features: snapshotGpuFeatures(device.features), limits: snapshotGpuLimits(device.limits) });
      controller.transition("ready");

      const texture = device.createTexture({
        label: "Mode A logical texture",
        size: [4, 4, 1],
        mipLevelCount: 3,
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      owned.push(texture);
      const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
      ownedSamplers.push(sampler);
      const settings = device.createBuffer({ label: "Mode A sampler publication", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const output = device.createBuffer({ label: "Mode A sampled output", size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const readback = device.createBuffer({ label: "Mode A sampled readback", size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      ownedBuffers.push(settings, output, readback);

      const shaderCode = `${GPU_MATERIAL_VISIBILITY_RECORD_WGSL}\n${gpuTextureBankSampleWgsl(1)}\n` + /* wgsl */ `
@group(0) @binding(0) var oengine_texture_bank_0: texture_2d_array<f32>;
@group(0) @binding(1) var sampler_clamp_linear: sampler;
@group(0) @binding(2) var sampler_mirror_linear: sampler;
@group(0) @binding(3) var sampler_repeat_linear: sampler;
@group(0) @binding(4) var sampler_clamp_nearest: sampler;
@group(0) @binding(5) var sampler_mirror_nearest: sampler;
@group(0) @binding(6) var sampler_repeat_nearest: sampler;
@group(0) @binding(7) var<uniform> sampler_class: u32;
@group(0) @binding(8) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(1)
fn main() {
  output[0] = oengine_sample_texture_bank(0x20000001u, sampler_class,
    vec2f(0.5), vec2f(0.0), vec2f(0.0), vec4f(0.0));
}`;
      const module = device.createShaderModule({ label: "Mode A texture sampling shader", code: shaderCode });
      const compilation = await module.getCompilationInfo();
      controller.addEvidence("shaderCompilation", compilation.messages.map((message) => ({ type: message.type, message: message.message, lineNum: message.lineNum, linePos: message.linePos })));
      if (compilation.messages.some((message) => message.type === "error")) throw new Error("Mode A texture sampling WGSL compilation failed");
      const pipeline = await withGpuErrorScopes(device, "Mode A texture sampling pipeline", () =>
        device!.createComputePipelineAsync({ label: "Mode A texture sampling pipeline", layout: "auto", compute: { module, entryPoint: "main" } })
      );
      const bindGroup = device.createBindGroup({
        label: "Mode A texture sampling bindings",
        layout: pipeline.value.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView({ dimension: "2d-array" }) },
          { binding: 1, resource: sampler }, { binding: 2, resource: sampler }, { binding: 3, resource: sampler },
          { binding: 4, resource: sampler }, { binding: 5, resource: sampler }, { binding: 6, resource: sampler },
          { binding: 7, resource: { buffer: settings } }, { binding: 8, resource: { buffer: output } }
        ]
      });

      controller.transition("warming");
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      controller.transition("sampling");
      writeSolidMip(texture, 1, 2, 2, [255, 0, 0, 255]);
      writeSolidMip(texture, 2, 1, 1, [255, 0, 0, 255]);
      device.queue.writeBuffer(settings, 0, new Uint32Array([49]));
      const runSample = async (label: string): Promise<number[]> => {
        const encoder = device!.createCommandEncoder({ label });
        const pass = encoder.beginComputePass({ label: `${label} pass` });
        pass.setPipeline(pipeline.value); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(1); pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, 16);
        device!.queue.submit([encoder.finish()]);
        await device!.queue.onSubmittedWorkDone();
        await readback.mapAsync(GPUMapMode.READ);
        const values = [...new Float32Array(readback.getMappedRange().slice(0))];
        readback.unmap();
        return values;
      };
      const tailSample = await runSample("Mode A mip tail sample");
      writeSolidMip(texture, 0, 4, 4, [0, 255, 0, 255]);
      device.queue.writeBuffer(settings, 0, new Uint32Array([17]));
      const promotedSample = await runSample("Mode A promoted mip sample");
      const tailMatches = matches(tailSample, [1, 0, 0, 1]);
      const promotedMatches = matches(promotedSample, [0, 1, 0, 1]);
      controller.addEvidence("sampling", {
        textureDimensions: [4, 4],
        mipLevelCount: 3,
        initialResidentMipRange: [1, 2],
        promotedResidentMipRange: [0, 2],
        tailSamplerClass: 49,
        promotedSamplerClass: 17,
        tailSample,
        promotedSample,
        tailMatches,
        promotedMatches
      });
      controller.addEvidence("submit", { main: 2, additional: [] });
      controller.transition("draining");
      controller.addEvidence("readback", { bytes: 32, matches: tailMatches && promotedMatches });
      if (!tailMatches || !promotedMatches) throw new Error("Mode A texture sampling did not observe the expected tail and promoted mip colors");
      if (canvas) {
        const context = canvas.getContext("2d");
        if (context) { context.fillStyle = "#0e8a5f"; context.fillRect(0, 0, canvas.width, canvas.height); }
      }
      if (status) status.textContent = "passed";
      controller.pass();
    }
  }
} catch (error) {
  controller.fail(error instanceof Error ? error.message : String(error));
}
