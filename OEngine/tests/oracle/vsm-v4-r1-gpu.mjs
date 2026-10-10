import { VSM_DEPTH_BOUNDS_WGSL } from "../../.test-dist/shaders/vsm_depth_bounds.js";
import { VSM_INVALIDATION_WGSL } from "../../.test-dist/shaders/vsm_invalidation.js";
import { VSM_RECEIVER_DEMAND_WGSL } from "../../.test-dist/shaders/vsm_receiver_demand.js";
import { VSM_ALLOCATE_PAGES_WGSL } from "../../.test-dist/shaders/vsm_allocate_pages.js";
import { VSM_CASTER_RECORDS_WGSL } from "../../.test-dist/shaders/vsm_caster_records.js";
import { VSM_ATLAS_PAGE_CLEAR_WGSL } from "../../.test-dist/shaders/vsm_atlas_raster.js";
import { packGpuInstanceRecords } from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { packVsmProjection } from "../../.test-dist/render/vsm/VsmProjection.js";
import { vsmWorldPageEntryIndex, vsmEntriesPerClipLevel } from "../../.test-dist/render/vsm/VsmPageState.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

export async function runVsmR1GpuOracle(device) {
  const retained = [];
  const buffer = (size, usage, data) => {
    const result = device.createBuffer({ size, usage, mappedAtCreation: data !== undefined });
    if (data !== undefined) {
      new Uint8Array(result.getMappedRange()).set(
        new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength)
      );
      result.unmap();
    }
    retained.push(result);
    return result;
  };
  const inspect = async (source) => {
    const readback = buffer(source.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, 0, readback, 0, source.size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const bytes = readback.getMappedRange().slice(0);
    readback.unmap();
    return bytes;
  };
  const compile = async (label, code) => {
    const module = device.createShaderModule({ label, code });
    const info = await module.getCompilationInfo();
    check(
      !info.messages.some((message) => message.type === "error"),
      `${label}: ${info.messages.map((message) => message.message).join("\n")}`
    );
    return module;
  };
  device.pushErrorScope("validation");
  try {
    for (const [label, code] of Object.entries({
      receiver: VSM_RECEIVER_DEMAND_WGSL,
      allocation: VSM_ALLOCATE_PAGES_WGSL,
      caster: VSM_CASTER_RECORDS_WGSL,
      clear: VSM_ATLAS_PAGE_CLEAR_WGSL
    })) {
      await compile(label, code);
    }
    const boundsModule = await compile("depth", VSM_DEPTH_BOUNDS_WGSL);
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
      ]
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const first = await device.createComputePipelineAsync({
      layout: pipelineLayout,
      compute: { module: boundsModule, entryPoint: "instance_bounds" }
    });
    const final = await device.createComputePipelineAsync({
      layout: pipelineLayout,
      compute: { module: boundsModule, entryPoint: "publish_depth" }
    });
    const matrix = [1, 0, 0.75, 0, -0.5, 2, -0.25, 0, 0, 0.3, -3, 0, 4, -2, 7, 1];
    const minimum = [-2, -3, -1],
      maximum = [1, 2, 4];
    const records = Array.from({ length: 130 }, (_, i) => ({
      geometryRecordIndex: 0,
      geometryGeneration: 1,
      materialHandle: 0,
      flags: i === 0 ? 7 : 5,
      debugId: i,
      boundsSphere: [0, 0, 0, 10],
      boundsMin: minimum,
      boundsMax: maximum,
      currentObjectToWorld: matrix,
      previousObjectToWorld: matrix
    }));
    const bytes = packGpuInstanceRecords(records);
    const instances = buffer(bytes.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, bytes);
    const constantsBytes = new ArrayBuffer(80);
    new Float32Array(constantsBytes).set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    new Uint32Array(constantsBytes).set([0, 130, 3, 1], 16);
    const constants = buffer(80, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, constantsBytes);
    const scratch = buffer(48, GPUBufferUsage.STORAGE);
    const product = buffer(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const group = device.createBindGroup({
      layout,
      entries: [constants, instances, scratch, product].map((buffer, binding) => ({
        binding,
        resource: { buffer }
      }))
    });
    const reduce = async () => {
      const encoder = device.createCommandEncoder();
      for (const [pipeline, count] of [
        [first, 3],
        [final, 1]
      ]) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(count);
        pass.end();
      }
      device.queue.submit([encoder.finish()]);
      return [...new Float32Array(await inspect(product))];
    };
    const depth = await reduce();
    const corners = [];
    for (let corner = 0; corner < 8; corner++) {
      const p = minimum.map((value, axis) => (corner & (1 << axis) ? maximum[axis] : value));
      corners.push(matrix[2] * p[0] + matrix[6] * p[1] + matrix[10] * p[2] + matrix[14]);
    }
    const low = Math.min(...corners),
      high = Math.max(...corners);
    check(
      depth[3] === 1 && depth[0] < low && depth[1] > high,
      "GPU range must conservatively contain all independent eight-corner depths"
    );
    check(
      Math.abs(depth[0] - (low - 0.01)) < 1e-5 && Math.abs(depth[1] - (high + 0.01)) < 1e-5,
      "GPU range must be tight with declared padding"
    );
    new Float32Array(bytes.buffer)[8] = NaN;
    device.queue.writeBuffer(instances, 0, bytes);
    check((await reduce())[3] === 0, "invalid caster bounds cannot publish valid depth");
    new Uint32Array(bytes.buffer)[2] = 5;
    device.queue.writeBuffer(instances, 0, bytes);
    const empty = await reduce();
    check(
      empty[3] === 1 && Math.abs(empty[0] + 0.51) < 1e-6 && Math.abs(empty[1] - 0.51) < 1e-6,
      "no-caster domain must publish finite empty depth"
    );

    const pagesPerAxis = 8,
      entryCount = vsmEntriesPerClipLevel(pagesPerAxis);
    const pageWords = new Uint32Array(entryCount * 12),
      metaWords = new Uint32Array(3 * 8);
    const worlds = [
      [-3, -3],
      [-4, -3],
      [3, -3]
    ];
    worlds.forEach(([x, y], slot) => {
      const index = vsmWorldPageEntryIndex(0, 0, x, y, pagesPerAxis);
      pageWords.set([slot, 0, 0, 9, 7, 0, 3, 7, x >>> 0, y >>> 0, 19, 0], index * 12);
      metaWords.set([index, 0, 7, 9, 7, index, 3, 0], slot * 8);
    });
    const pages = buffer(pageWords.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, pageWords);
    const metas = buffer(metaWords.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, metaWords);
    const dirty = buffer(Math.ceil(entryCount / 32) * 4, GPUBufferUsage.STORAGE);
    const content = buffer(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const packed = packVsmProjection({
      lightView: Array(16).fill(0),
      clipOriginExtent: [[-3, -4, 8, 1]],
      generation: 7,
      projectionEpoch: 7,
      namespace: 19
    });
    new Uint32Array(packed).set([8, 3, 0, 0, 7, 0, 0, 0], 40);
    const windowConstants = buffer(256, GPUBufferUsage.UNIFORM, packed);
    const windowPipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: await compile("window", VSM_INVALIDATION_WGSL), entryPoint: "main" }
    });
    const windowGroup = device.createBindGroup({
      layout: windowPipeline.getBindGroupLayout(0),
      entries: [windowConstants, pages, metas, dirty, content].map((buffer, binding) => ({
        binding,
        resource: { buffer }
      }))
    });
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(windowPipeline);
    pass.setBindGroup(0, windowGroup);
    pass.dispatchWorkgroups(Math.ceil(entryCount / 64));
    pass.end();
    device.queue.submit([encoder.finish()]);
    const resultPages = new Uint32Array(await inspect(pages)),
      resultMetas = new Uint32Array(await inspect(metas));
    worlds.forEach(([x, y], slot) => {
      const index = vsmWorldPageEntryIndex(0, 0, x, y, pagesPerAxis);
      const expected = slot === 1 ? 0 : 9;
      check(
        resultPages[index * 12 + 3] === expected && resultMetas[slot * 8 + 3] === expected,
        "rolling must preserve intersection and release departed slot"
      );
    });
    const error = await device.popErrorScope();
    check(error === null, error?.message);
    return {
      depth,
      expectedCasterRange: [low, high],
      empty,
      rolling: "preserved 2, released 1",
      shaderCompile: "passed"
    };
  } finally {
    for (const resource of retained) resource.destroy();
  }
}
