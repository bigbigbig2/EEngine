import { createValidationController } from "../../host/protocol.ts";
import {
  attachGpuErrorCollection,
  probeWebGpu2026Surface,
  snapshotAdapterInfo,
  snapshotGpuFeatures,
  snapshotGpuLimits,
  withGpuErrorScopes
} from "../../host/webgpu.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#output");
const status = document.querySelector<HTMLElement>("#status");
let device: GPUDevice | undefined;
let buffer: GPUBuffer | undefined;
let readback: GPUBuffer | undefined;
let errorCollection: ReturnType<typeof attachGpuErrorCollection> | undefined;
let lostIntentionally = false;

const controller = createValidationController({
  caseId: "webgpu-component",
  workloadId: "webgpu-component-v1"
}, async () => {
  readback?.destroy();
  buffer?.destroy();
  errorCollection?.remove();
  lostIntentionally = true;
  device?.destroy();
  const lost = errorCollection === undefined
    ? null
    : await Promise.race([
        errorCollection.lost,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))
      ]);
  if (status) status.textContent = "disposed";
  return {
    buffers: 0,
    devices: 0,
    rafPending: 0,
    listeners: 0,
    intentionalDeviceDestroy: lostIntentionally,
    deviceLost: lost === null ? null : { reason: lost.reason, message: lost.message }
  };
});

try {
  controller.transition("negotiating");
  if (!window.isSecureContext || !navigator.gpu) {
    controller.unsupported("WebGPU secure context is unavailable");
  } else {
    const adapter = await navigator.gpu.requestAdapter({ featureLevel: "core", powerPreference: "high-performance" });
    if (!adapter) {
      controller.unsupported("No WebGPU core adapter is available");
    } else if (!adapter.features.has("core-features-and-limits")) {
      controller.unsupported("Adapter does not expose core-features-and-limits");
    } else {
      const requestedFeatures: GPUFeatureName[] = ["core-features-and-limits"];
      const requestedLimits = {};
      const adapterEvidence = {
        info: snapshotAdapterInfo(adapter.info),
        features: snapshotGpuFeatures(adapter.features),
        limits: snapshotGpuLimits(adapter.limits)
      };
      controller.addEvidence("adapter", adapterEvidence);
      controller.addEvidence("requestedDevice", { features: requestedFeatures, limits: requestedLimits });
      device = await adapter.requestDevice({
        label: "OEngine Validation WebGPU Component",
        requiredFeatures: requestedFeatures,
        requiredLimits: requestedLimits
      });
      errorCollection = attachGpuErrorCollection(device, controller, () => lostIntentionally);
      const deviceEvidence = {
        features: snapshotGpuFeatures(device.features),
        limits: snapshotGpuLimits(device.limits),
        webgpu2026: await probeWebGpu2026Surface(navigator.gpu, device)
      };
      controller.addEvidence("device", deviceEvidence);
      controller.addEvidence("capabilityFingerprint", JSON.stringify({ adapter: adapterEvidence, requestedFeatures, requestedLimits, device: deviceEvidence }));
      controller.transition("ready");

      const shader = await withGpuErrorScopes(device, "Validation deterministic write shader", async () => {
        const module = device!.createShaderModule({
          label: "Validation deterministic write shader",
          code: "@group(0) @binding(0) var<storage, read_write> output: array<u32>;\n@compute @workgroup_size(1) fn main() { output[0] = 0x0e131401u; }"
        });
        const compilation = await module.getCompilationInfo();
        controller.addEvidence("shaderCompilation", compilation.messages.map((message) => ({
          type: message.type,
          message: message.message,
          lineNum: message.lineNum,
          linePos: message.linePos
        })));
        if (compilation.messages.some((message) => message.type === "error")) throw new Error("Shader compilation failed");
        return module;
      });
      const pipeline = await withGpuErrorScopes(device, "Validation deterministic write pipeline", () =>
        device!.createComputePipelineAsync({
          label: "Validation deterministic write pipeline",
          layout: "auto",
          compute: { module: shader.value, entryPoint: "main" }
        })
      );
      const resources = await withGpuErrorScopes(device, "Validation component buffers", () => {
        buffer = device!.createBuffer({
          label: "Validation output",
          size: 4,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        });
        readback = device!.createBuffer({
          label: "Validation readback",
          size: 4,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        return { buffer, readback };
      });
      const group = await withGpuErrorScopes(device, "Validation deterministic write bindings", () =>
        device!.createBindGroup({
          label: "Validation deterministic write bindings",
          layout: pipeline.value.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: resources.value.buffer } }]
        })
      );

      device.pushErrorScope("validation");
      const invalidBuffer = device.createBuffer({
        label: "Validation expected scoped failure",
        size: 4,
        usage: 0 as GPUBufferUsageFlags
      });
      const expectedValidation = await device.popErrorScope();
      invalidBuffer.destroy();
      if (!(expectedValidation instanceof GPUValidationError)) {
        throw new Error("Expected validation error scope did not capture invalid buffer usage");
      }
      controller.addEvidence("expectedErrorScope", {
        captured: true,
        constructor: expectedValidation.constructor.name,
        message: expectedValidation.message
      });

      controller.transition("warming");
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      controller.transition("sampling");
      await withGpuErrorScopes(device, "Validation component command", async () => {
        const encoder = device!.createCommandEncoder({ label: "Validation component encoder" });
        const pass = encoder.beginComputePass({ label: "Validation deterministic write pass" });
        pass.setPipeline(pipeline.value);
        pass.setBindGroup(0, group.value);
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(resources.value.buffer, 0, resources.value.readback, 0, 4);
        device!.queue.submit([encoder.finish()]);
        await device!.queue.onSubmittedWorkDone();
      });
      controller.addEvidence("submit", { main: 1, additional: [] });
      controller.transition("draining");
      await resources.value.readback.mapAsync(GPUMapMode.READ);
      const actual = new Uint32Array(resources.value.readback.getMappedRange().slice(0))[0];
      resources.value.readback.unmap();
      controller.addEvidence("readback", { bytes: 4, expected: 0x0e131401, actual });
      if (actual !== 0x0e131401) throw new Error(`GPU readback mismatch: ${actual}`);
      if (canvas) {
        const context = canvas.getContext("2d");
        if (context) {
          context.fillStyle = "#0e8a5f";
          context.fillRect(0, 0, canvas.width, canvas.height);
        }
      }
      if (status) status.textContent = "passed";
      controller.pass();
    }
  }
} catch (error) {
  controller.fail(error instanceof Error ? error.message : String(error));
}
