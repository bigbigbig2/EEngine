import { createValidationController } from "../../host/protocol.ts";
import { attachGpuErrorCollection, snapshotAdapterInfo, snapshotGpuFeatures, snapshotGpuLimits, withGpuErrorScopes } from "../../host/webgpu.ts";
import { GEOMETRY_PRODUCT_GPU_WGSL_V1 } from "../../../../OEngine/src/gpu/GeometryProductGpuAbiV1.ts";
import { VIRTUAL_GEOMETRY_PRODUCT_WGSL } from "../../../../OEngine/src/shaders/virtual_geometry_product.ts";
import { VIRTUAL_GEOMETRY_MESHLET_WORK_WGSL } from "../../../../OEngine/src/shaders/virtual_geometry_work.ts";
import { VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_WGSL } from "../../../../OEngine/src/shaders/meshlet_bucket_visibility.ts";
import { GPU_COUNTER_BYTE_SIZE, counterByteOffset } from "../../../../OEngine/src/debug/GpuFrameCounters.ts";

const status = document.querySelector<HTMLElement>("#status");
const canvas = document.querySelector<HTMLCanvasElement>("#output");
let device: GPUDevice | undefined;
let errorCollection: ReturnType<typeof attachGpuErrorCollection> | undefined;
let intentionalLoss = false;
const owned: GPUBuffer[] = [];

const controller = createValidationController({
  caseId: "virtual-geometry-component",
  workloadId: "virtual-geometry-component-v1"
}, async () => {
  for (const buffer of owned.splice(0)) buffer.destroy();
  errorCollection?.remove();
  intentionalLoss = true;
  device?.destroy();
  if (status) status.textContent = "disposed";
  return { buffers: 0, devices: 0, listeners: 0, intentionalDeviceDestroy: intentionalLoss };
});

try {
  controller.transition("negotiating");
  if (!window.isSecureContext || !navigator.gpu) {
    controller.unsupported("WebGPU secure context is unavailable");
  } else {
    const adapter = await navigator.gpu.requestAdapter({ featureLevel: "core", powerPreference: "high-performance" });
    if (!adapter || !adapter.features.has("core-features-and-limits") || adapter.limits.maxStorageBuffersPerShaderStage < 9) {
      controller.unsupported("WebGPU core-features-and-limits is unavailable");
    } else {
      controller.addEvidence("adapter", { info: snapshotAdapterInfo(adapter.info), features: snapshotGpuFeatures(adapter.features), limits: snapshotGpuLimits(adapter.limits) });
      device = await adapter.requestDevice({
        label: "S1 Product ABI validation",
        requiredFeatures: ["core-features-and-limits"],
        requiredLimits: { maxStorageBuffersPerShaderStage: 9 }
      });
      errorCollection = attachGpuErrorCollection(device, controller, () => intentionalLoss);
      controller.addEvidence("device", { features: snapshotGpuFeatures(device.features), limits: snapshotGpuLimits(device.limits) });
      controller.transition("ready");

      const productCode = VIRTUAL_GEOMETRY_PRODUCT_WGSL;
      const workCode = VIRTUAL_GEOMETRY_MESHLET_WORK_WGSL;
      const rasterCode = VIRTUAL_GEOMETRY_BUCKET_VISIBILITY_WGSL;
      let workModule: GPUShaderModule | undefined;
      const compiled = await withGpuErrorScopes(device, "S1 Product shader compilation", async () => {
        workModule = device!.createShaderModule({ label: "S1 Product MeshletWork", code: workCode });
        const modules = [
          device!.createShaderModule({ label: "S1 Product ABI helpers", code: productCode }),
          workModule,
          device!.createShaderModule({ label: "S1 Product Visibility raster", code: rasterCode })
        ];
        const infos = await Promise.all(modules.map((module) => module.getCompilationInfo()));
        const messages = infos.flatMap((info, index) => info.messages.map((message) => ({ shader: index, type: message.type, message: message.message, lineNum: message.lineNum, linePos: message.linePos })));
        controller.addEvidence("shaderCompilation", messages);
        if (messages.some((message) => message.type === "error")) {
          throw new Error(`S1 Product shader compilation failed: ${messages.filter((message) => message.type === "error").map((message) => `${message.shader}:${message.lineNum}:${message.linePos} ${message.message}`).join(" | ")}`);
        }
        return messages;
      });
      controller.addEvidence("shaderCompilationResult", compiled.value);
      if (!workModule) throw new Error("Product MeshletWork shader module was not created");

      const metadata = new Uint32Array(112);
      metadata[0] = 1; metadata[1] = 1; metadata[2] = 1; metadata[3] = metadata.length;
      metadata[4] = 16; metadata[5] = 32; metadata[6] = 36; metadata[7] = 68;
      metadata[8] = 80; metadata[9] = 92; metadata[10] = 96; metadata[11] = 100;
      metadata[16] = 1; metadata[17] = 1; metadata[18] = 0; metadata[19] = 1;
      metadata[20] = 0; metadata[21] = 1; metadata[22] = 0; metadata[23] = 1;
      metadata[24] = 0; metadata[25] = 1; metadata[26] = 0; metadata[27] = 1;
      metadata[28] = 0; metadata[29] = 1;
      metadata[32] = 0; metadata[33] = 1; metadata[34] = 0; metadata[35] = 0;
      metadata[54] = 0; metadata[55] = 1; metadata[56] = 0; metadata[57] = 1;
      metadata[58] = 0; metadata[59] = 1;
      metadata[68] = 0;
      metadata[80 + 11] = 1;
      metadata[92] = 0; metadata[93] = 0; metadata[94] = 256; metadata[95] = 1;
      metadata[96] = 0; metadata[97] = 0; metadata[98] = 1; metadata[99] = 3;
      const page = new Uint32Array(16384);
      page[11] = 2; page[12] = 64; page[13] = 160; page[14] = 168; page[15] = 256;
      page[16] = 3 | (1 << 16); page[17] = 168; page[18] = 160;
      page[22] = 0; page[23] = 0; page[24] = 0x3f800000; page[25] = 0x3f800000; page[26] = 0x3f800000;
      page[27] = 0x3f800000; page[28] = 3 | (1 << 16); page[29] = 168; page[30] = 163;
      const input = device.createBuffer({ label: "S1 Product metadata fixture", size: metadata.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      const pageBuffer = device.createBuffer({ label: "S1 Product resident page fixture", size: page.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const output = device.createBuffer({ label: "S1 Product metadata readback source", size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const readback = device.createBuffer({ label: "S1 Product metadata readback", size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      owned.push(input, pageBuffer, output, readback);
      device.queue.writeBuffer(input, 0, metadata);
      device.queue.writeBuffer(pageBuffer, 0, page);
      const oracleResult = await withGpuErrorScopes(device, "S1 Product metadata oracle pipeline", async () => {
        const oracleModule = device!.createShaderModule({ label: "S1 Product metadata oracle", code: `${VIRTUAL_GEOMETRY_PRODUCT_WGSL}\n@group(0) @binding(0) var<storage,read> heap: array<u32>; @group(0) @binding(1) var<storage,read> bank: array<u32>; @group(0) @binding(2) var<storage,read_write> out: array<u32>; @compute @workgroup_size(1) fn main(){ let a=oengine_geometry_product_resolve_asset_v1(&heap,0u,1u); let p=oengine_geometry_product_lookup_page_heap_v1(&heap,a,0u); let g=oengine_virtual_group_v1(&heap,a,0u); let h=oengine_virtual_group_header_v1(&bank,p,g); let m=oengine_virtual_meshlet_header_v1(&bank,p,g,h,0u); out[0]=select(0u,1u,a.valid); out[1]=a.root_word_offset; out[2]=a.hierarchy_count; out[3]=a.group_count; out[4]=select(0u,1u,p.valid); out[5]=select(0u,1u,g.valid); out[6]=select(0u,1u,h.valid); out[7]=select(0u,1u,m.valid); }` });
        const info = await oracleModule.getCompilationInfo();
        const messages = info.messages.map((message) => ({ type: message.type, message: message.message, lineNum: message.lineNum, linePos: message.linePos }));
        controller.addEvidence("oracleShaderCompilation", messages);
        if (messages.some((message) => message.type === "error")) throw new Error(`S1 Product metadata oracle shader compilation failed: ${messages.filter((message) => message.type === "error").map((message) => `${message.lineNum}:${message.linePos} ${message.message}`).join(" | ")}`);
        return device!.createComputePipelineAsync({ label: "S1 Product metadata oracle pipeline", layout: "auto", compute: { module: oracleModule, entryPoint: "main" } });
      });
      const pipeline = oracleResult.value;
      const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: pageBuffer } }, { binding: 2, resource: { buffer: output } }] });

      const visibleBytes = new Uint8Array(52);
      const visibleView = new DataView(visibleBytes.buffer);
      visibleView.setUint32(0, 1, true); visibleView.setUint32(4, 1, true);
      visibleView.setUint32(8, 1, true); visibleView.setUint32(20, 1, true);
      // VisibleCluster: instance, Product asset reference, Group, material, raster flags.
      for (const [offset, value] of [[32, 0], [36, 0], [40, 0], [44, 0], [48, 0]] as const) visibleView.setUint32(offset, value, true);
      const workBytes = new Uint8Array(56);
      new DataView(workBytes.buffer).setUint32(12, 1, true);
      const visibleBuffer = device.createBuffer({ label: "S5 Product overflow visible queue", size: visibleBytes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const workBuffer = device.createBuffer({ label: "S5 Product overflow MeshletWork queue", size: workBytes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      const settingsBuffer = device.createBuffer({ label: "S5 Product overflow settings", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const countersBuffer = device.createBuffer({ label: "S5 Product overflow counters", size: GPU_COUNTER_BYTE_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const drawBuffer = device.createBuffer({ label: "S5 Product overflow draw", size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const overflowReadback = device.createBuffer({ label: "S5 Product overflow readback", size: 32 + 16 + GPU_COUNTER_BYTE_SIZE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      owned.push(visibleBuffer, workBuffer, settingsBuffer, countersBuffer, drawBuffer, overflowReadback);
      device.queue.writeBuffer(visibleBuffer, 0, visibleBytes);
      device.queue.writeBuffer(workBuffer, 0, workBytes);
      device.queue.writeBuffer(settingsBuffer, 0, new Uint32Array([1, 1, 1, 0]));

      const overflowLayout = device.createBindGroupLayout({
        label: "S5 Product overflow bind group layout",
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
          { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
        ]
      });
      const overflowPipelineLayout = device.createPipelineLayout({ label: "S5 Product overflow pipeline layout", bindGroupLayouts: [overflowLayout] });
      const overflowPipelines = await withGpuErrorScopes(device, "S5 Product overflow pipelines", () => Promise.all([
        device!.createComputePipelineAsync({ label: "S5 prepare Product overflow", layout: overflowPipelineLayout, compute: { module: workModule!, entryPoint: "prepare_virtual_geometry_work" } }),
        device!.createComputePipelineAsync({ label: "S5 generate Product overflow", layout: overflowPipelineLayout, compute: { module: workModule!, entryPoint: "generate_virtual_geometry_work" } }),
        device!.createComputePipelineAsync({ label: "S5 finalize Product overflow", layout: overflowPipelineLayout, compute: { module: workModule!, entryPoint: "finalize_virtual_geometry_work" } })
      ]));
      const [prepareOverflow, generateOverflow, finalizeOverflow] = overflowPipelines.value;
      const overflowBindGroup = device.createBindGroup({
        label: "S5 Product overflow bind group",
        layout: overflowLayout,
        entries: [
          { binding: 0, resource: { buffer: visibleBuffer } },
          { binding: 1, resource: { buffer: workBuffer } },
          { binding: 2, resource: { buffer: settingsBuffer } },
          { binding: 3, resource: { buffer: countersBuffer } },
          { binding: 4, resource: { buffer: drawBuffer } },
          { binding: 5, resource: { buffer: input } },
          { binding: 6, resource: { buffer: pageBuffer } },
          { binding: 7, resource: { buffer: pageBuffer } },
          { binding: 8, resource: { buffer: pageBuffer } },
          { binding: 9, resource: { buffer: pageBuffer } }
        ]
      });
      controller.transition("warming");
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      controller.transition("sampling");
      await withGpuErrorScopes(device, "S1 Product metadata dispatch", async () => {
        const encoder = device!.createCommandEncoder({ label: "S1 Product metadata encoder" });
        const pass = encoder.beginComputePass({ label: "S1 Product metadata pass" });
        pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(1); pass.end();
        const overflowPass = encoder.beginComputePass({ label: "S5 Product MeshletWork overflow pass" });
        overflowPass.setBindGroup(0, overflowBindGroup);
        overflowPass.setPipeline(prepareOverflow); overflowPass.dispatchWorkgroups(1);
        overflowPass.setPipeline(generateOverflow); overflowPass.dispatchWorkgroups(1);
        overflowPass.setPipeline(finalizeOverflow); overflowPass.dispatchWorkgroups(1);
        overflowPass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, 32);
        encoder.copyBufferToBuffer(workBuffer, 0, overflowReadback, 0, 32);
        encoder.copyBufferToBuffer(drawBuffer, 0, overflowReadback, 32, 16);
        encoder.copyBufferToBuffer(countersBuffer, 0, overflowReadback, 48, GPU_COUNTER_BYTE_SIZE);
        device!.queue.submit([encoder.finish()]);
        await device!.queue.onSubmittedWorkDone();
      });
      controller.transition("draining");
      await readback.mapAsync(GPUMapMode.READ);
      const actual = [...new Uint32Array(readback.getMappedRange().slice(0))];
      readback.unmap();
      await overflowReadback.mapAsync(GPUMapMode.READ);
      const overflowWords = new Uint32Array(overflowReadback.getMappedRange().slice(0));
      overflowReadback.unmap();
      const attemptedCount = overflowWords[0]!;
      const writtenCount = overflowWords[1]!;
      const capacity = overflowWords[3]!;
      const overflowCount = overflowWords[4]!;
      const invalidCount = overflowWords[6]!;
      const instanceCount = overflowWords[9]!;
      const counterBase = 48 / 4;
      const overflowCounter = overflowWords[counterBase + counterByteOffset("meshletQueueOverflow") / 4]!;
      const invalidCounter = overflowWords[counterBase + counterByteOffset("meshletQueueInvalid") / 4]!;
      const overflowMatches = attemptedCount === 2 && writtenCount === 0 && capacity === 1 &&
        overflowCount === 2 && invalidCount === 1 && instanceCount === 0 &&
        overflowCounter === 2 && invalidCounter === 1;
      const matches = actual[0] === 1 && actual[1] === 68 && actual[2] === 1 && actual[3] === 1 && actual[4] === 1 && actual[5] === 1 && actual[6] === 1 && actual[7] === 1;
      controller.addEvidence("readback", { expected: [1, 68, 1, 1, 1, 1, 1, 1], actual, matches });
      controller.addEvidence("overflowReadback", { attemptedCount, writtenCount, capacity, overflowCount, invalidCount, instanceCount, overflowCounter, invalidCounter, matches: overflowMatches });
      controller.addEvidence("abi", { metadataWords: metadata.length, productShaderBytes: productCode.length, workShaderBytes: workCode.length, rasterShaderBytes: rasterCode.length });
      controller.addEvidence("submit", { main: 1, additional: [] });
      const context = canvas?.getContext("2d");
      if (context && canvas) { context.fillStyle = matches ? "#0e8a5f" : "#9a3131"; context.fillRect(0, 0, canvas.width, canvas.height); }
      if (!matches) throw new Error("Product metadata GPU oracle disagrees with expected ranges");
      if (!overflowMatches) throw new Error("Product MeshletWork overflow did not fail closed with exact GPU counters");
      if (status) status.textContent = "passed";
      controller.pass();
    }
  }
} catch (error) {
  controller.fail(error instanceof Error ? error.message : String(error));
}

