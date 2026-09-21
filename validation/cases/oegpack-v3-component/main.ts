import {
  OEGPACK_V3_GROUP_HEADER_BYTES,
  OEGPACK_V3_HIERARCHY_STRIDE,
  OEGPACK_V3_MESHLET_HEADER_BYTES
} from "../../../../OEngine/src/assets/GeometryAbiV3.ts";
import { oegPackV3DecodeWgsl } from "../../../../OEngine/src/shaders/oegpack_v3_decode.ts";
import { createValidationController } from "../../host/protocol.ts";
import { attachGpuErrorCollection, snapshotAdapterInfo, snapshotGpuFeatures, snapshotGpuLimits, withGpuErrorScopes } from "../../host/webgpu.ts";

const status = document.querySelector<HTMLElement>("#status");
const canvas = document.querySelector<HTMLCanvasElement>("#output");
let device: GPUDevice | undefined;
let source: GPUBuffer | undefined;
let offsets: GPUBuffer | undefined;
let output: GPUBuffer | undefined;
let readback: GPUBuffer | undefined;
let errorCollection: ReturnType<typeof attachGpuErrorCollection> | undefined;
let intentionalLoss = false;

const controller = createValidationController({ caseId: "oegpack-v3-component", workloadId: "oegpack-v3-decode-v1" }, async () => {
  readback?.destroy(); output?.destroy(); offsets?.destroy(); source?.destroy();
  errorCollection?.remove(); intentionalLoss = true; device?.destroy();
  if (status) status.textContent = "disposed";
  return { buffers: 0, devices: 0, listeners: 0, intentionalDeviceDestroy: intentionalLoss };
});

try {
  controller.transition("negotiating");
  if (!window.isSecureContext || !navigator.gpu) controller.unsupported("WebGPU secure context is unavailable");
  else {
    const adapter = await navigator.gpu.requestAdapter({ featureLevel: "core", powerPreference: "high-performance" });
    if (!adapter || !adapter.features.has("core-features-and-limits")) controller.unsupported("WebGPU core-features-and-limits is unavailable");
    else {
      controller.addEvidence("adapter", { info: snapshotAdapterInfo(adapter.info), features: snapshotGpuFeatures(adapter.features), limits: snapshotGpuLimits(adapter.limits) });
      device = await adapter.requestDevice({ label: "OEGPACK V3 decode validation", requiredFeatures: ["core-features-and-limits"] });
      errorCollection = attachGpuErrorCollection(device, controller, () => intentionalLoss);
      controller.addEvidence("device", { features: snapshotGpuFeatures(device.features), limits: snapshotGpuLimits(device.limits) });
      controller.transition("ready");

      const fixtureBytes = OEGPACK_V3_HIERARCHY_STRIDE + OEGPACK_V3_GROUP_HEADER_BYTES + OEGPACK_V3_MESHLET_HEADER_BYTES;
      const fixture = new ArrayBuffer(fixtureBytes);
      const view = new DataView(fixture);
      const groupBase = OEGPACK_V3_HIERARCHY_STRIDE;
      const meshletBase = groupBase + OEGPACK_V3_GROUP_HEADER_BYTES;
      view.setFloat32(12, 27.5, true); view.setFloat32(40, 3.25, true); view.setUint32(44, 0x1200000b, true);
      view.setFloat32(groupBase + 40, 7.5, true); view.setUint16(groupBase + 44, 37, true); view.setUint8(groupBase + 46, 5); view.setUint8(groupBase + 47, 9);
      view.setUint32(groupBase + 48, 64, true); view.setUint32(groupBase + 52, 1840, true); view.setUint32(groupBase + 56, 2048, true); view.setUint32(groupBase + 60, 8192, true);
      view.setUint16(meshletBase, 64, true); view.setUint16(meshletBase + 2, 128, true); view.setUint32(meshletBase + 4, 2048, true); view.setUint32(meshletBase + 8, 1840, true);
      view.setUint32(meshletBase + 12, 23, true); view.setUint32(meshletBase + 16, 71, true); view.setUint32(meshletBase + 20, 0xa5, true); view.setFloat32(meshletBase + 24, -4.5, true); view.setFloat32(meshletBase + 44, 19.25, true);
      const expected = new Uint32Array([
        0x1200000b, floatBits(3.25), floatBits(27.5), 37, 5, 9, 64, 1840, 2048, 8192,
        floatBits(7.5), 64, 128, 2048, 1840, 23, 71, 0xa5, floatBits(-4.5), floatBits(19.25)
      ]);

      const scoped = await withGpuErrorScopes(device, "OEGPACK V3 resource and pipeline creation", async () => {
        const module = device!.createShaderModule({ label: "OEGPACK V3 raw ABI decoder", code: oegPackV3DecodeWgsl });
        const compilation = await module.getCompilationInfo();
        controller.addEvidence("shaderCompilation", compilation.messages.map(message => ({ type: message.type, message: message.message, lineNum: message.lineNum, linePos: message.linePos })));
        if (compilation.messages.some(message => message.type === "error")) throw new Error("OEGPACK V3 WGSL compilation failed");
        const pipeline = await device!.createComputePipelineAsync({ label: "OEGPACK V3 decode pipeline", layout: "auto", compute: { module, entryPoint: "decodeOegPackV3" } });
        source = device!.createBuffer({ label: "OEGPACK V3 known records", size: fixtureBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        offsets = device!.createBuffer({ label: "OEGPACK V3 decode offsets", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        output = device!.createBuffer({ label: "OEGPACK V3 decoded fields", size: expected.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        readback = device!.createBuffer({ label: "OEGPACK V3 decoded readback", size: expected.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        device!.queue.writeBuffer(source, 0, fixture);
        device!.queue.writeBuffer(offsets, 0, new Uint32Array([0, groupBase / 4, meshletBase / 4, 0]));
        const bindGroup = device!.createBindGroup({ label: "OEGPACK V3 decode bindings", layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: source } }, { binding: 1, resource: { buffer: offsets } }, { binding: 2, resource: { buffer: output } }
        ] });
        return { pipeline, bindGroup };
      });
      controller.transition("warming"); await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
      controller.transition("sampling");
      await withGpuErrorScopes(device, "OEGPACK V3 decode dispatch", async () => {
        const encoder = device!.createCommandEncoder({ label: "OEGPACK V3 decode encoder" });
        const pass = encoder.beginComputePass({ label: "OEGPACK V3 decode pass" });
        pass.setPipeline(scoped.value.pipeline); pass.setBindGroup(0, scoped.value.bindGroup); pass.dispatchWorkgroups(1); pass.end();
        encoder.copyBufferToBuffer(output!, 0, readback!, 0, expected.byteLength); device!.queue.submit([encoder.finish()]); await device!.queue.onSubmittedWorkDone();
      });
      controller.transition("draining"); await readback!.mapAsync(GPUMapMode.READ);
      const actual = new Uint32Array(readback!.getMappedRange().slice(0)); readback!.unmap();
      const matches = actual.length === expected.length && actual.every((value, index) => value === expected[index]);
      controller.addEvidence("abi", { hierarchyStride: OEGPACK_V3_HIERARCHY_STRIDE, groupHeaderBytes: OEGPACK_V3_GROUP_HEADER_BYTES, meshletHeaderBytes: OEGPACK_V3_MESHLET_HEADER_BYTES });
      controller.addEvidence("readback", { bytes: actual.byteLength, expected: [...expected], actual: [...actual], matches });
      controller.addEvidence("submit", { main: 1, additional: [] });
      if (!matches) throw new Error("OEGPACK V3 GPU decode disagrees with CPU ABI fixture");
      const context = canvas?.getContext("2d"); if (context && canvas) { context.fillStyle = "#0e8a5f"; context.fillRect(0, 0, canvas.width, canvas.height); }
      if (status) status.textContent = "passed"; controller.pass();
    }
  }
} catch (error) { controller.fail(error instanceof Error ? error.message : String(error)); }

function floatBits(value: number): number {
  const bytes = new ArrayBuffer(4); const view = new DataView(bytes); view.setFloat32(0, value, true); return view.getUint32(0, true);
}
