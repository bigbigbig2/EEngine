import { GraphicsContext } from "../../.test-dist/gpu/GraphicsContext.js";
import { packGpuInstanceRecords } from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { ShadowMeshletBounds } from "../../.test-dist/render/ShadowMeshletBounds.js";
import { VsmCasterRecordPass } from "../../.test-dist/render/vsm/VsmCasterRecordPass.js";
import { NativeRasterWorkPartitions } from "../../.test-dist/render/surface/NativeRasterWorkPartitions.js";
import { FrameGraph } from "../../.test-dist/framegraph/FrameGraph.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { VSM_PAGE_COMMIT_WGSL } from "../../.test-dist/shaders/vsm_page_commit.js";
import { VSM_SAMPLING_WGSL } from "../../.test-dist/shaders/vsm_sampling.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Independent eight-corner oracle, real Geometry bounds → pairs → native
 * partitions → per-page publication. Fixtures author Scene/resident pages;
 * work counts/mode/indirect commands/completion are production GPU products. */
export async function runVsmR3GpuOracle(device) {
  const graphics = new GraphicsContext(device),
    retained = [],
    owners = [];
  const make = (size, usage, data) => {
    const buffer = device.createBuffer({ size, usage, mappedAtCreation: data !== undefined });
    if (data !== undefined) {
      new Uint8Array(buffer.getMappedRange()).set(
        new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength),
      );
      buffer.unmap();
    }
    retained.push(buffer);
    return buffer;
  };
  const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
  const read = async (buffer) => {
    const target = make(buffer.size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, target, 0, buffer.size);
    device.queue.submit([encoder.finish()]);
    await target.mapAsync(GPUMapMode.READ);
    const bytes = target.getMappedRange().slice(0);
    target.unmap();
    return new Uint32Array(bytes);
  };
  const W = 129,
    C = 64,
    generation = 19,
    namespace = 5;
  const transforms = [identity, [-2, 0.5, 0, 0, 0.75, 3, 0, 0, 0.2, -0.3, 1, 0, 1, 0, 0, 1]];
  const sourceInstances = packGpuInstanceRecords(
    transforms.map((matrix, index) => ({
      geometryRecordIndex: 0,
      geometryGeneration: 1,
      materialHandle: 0,
      flags: 3,
      debugId: index,
      boundsSphere: [0, 0, 0, 10000],
      boundsMin: [-1000, -1000, -1000],
      boundsMax: [1000, 1000, 1000],
      currentObjectToWorld: matrix,
      previousObjectToWorld: matrix,
    })),
  );
  const instances = make(sourceInstances.byteLength, storage, sourceInstances);
  const meshletWords = new Uint32Array(W * 32),
    meshletFloats = new Float32Array(meshletWords.buffer);
  const workWords = new Uint32Array(8 + W * 6);
  const triangleCounts = [1, 32, 33, 64, 65, 96, 97, 128];
  for (let slot = 0; slot < W; slot++) {
    meshletWords.set([0, 4, 0, triangleCounts[slot % 8]], slot * 32);
    meshletFloats.set([0.9, 0.1, -0.2, 0], slot * 32 + 8);
    meshletFloats.set([1.1, 0.2, 0.3, 0], slot * 32 + 12);
    workWords.set([0, 0, slot, slot % 3, slot % 2 ? 16 : 0, 0], 8 + slot * 6);
  }
  const meshlets = make(meshletWords.byteLength, storage, meshletWords);
  const work = make(workWords.byteLength, storage, workWords);
  const bounds = new ShadowMeshletBounds(device, { queue: work, capacity: W }, instances, meshlets);
  owners.push(bounds);
  const pairOwner = new VsmCasterRecordPass(device);
  owners.push(pairOwner);
  const pairs = make(32 + C * 16, storage);
  const allocation = make(16 + 4 * 32, storage);
  const pages = make(128 * 48, storage);
  const metas = make(4 * 32, storage);
  const telemetry = make(32, storage);
  const indirect = make(48, storage | GPUBufferUsage.INDIRECT);
  const depth = make(16, storage, new Float32Array([-1, 1, 0.5, 1]));
  const materialWords = new Uint32Array([0, 0, 0, 1, 0, 1, 0, 1, 0, 2, 0, 1]);
  const directory = make(materialWords.byteLength, storage, materialWords);
  const partition = new NativeRasterWorkPartitions(device, {
    work: pairs,
    metadata: meshlets,
    publication: { rasterClasses: [{}, {}, {}], rasterDirectory: directory },
    capacity: W,
    meshletWordBase: 0,
    generation,
    caster: { source: work, bounds: bounds.records, sourceCapacity: W, pairCapacity: C, dirtyCapacity: 4 },
  });
  owners.push(partition);
  await partition.ready;
  const frame = {
    generation,
    projectionEpoch: generation,
    namespace,
    lightView: identity,
    clipOriginExtent: Array.from({ length: 6 }, () => [0, 0, 128, 1 / 128]),
  };
  const resources = {
    profile: "vsm-directional-high",
    casterRecords: pairs,
    rasterIndirect: indirect,
    overflowCounters: telemetry,
    capabilities: {
      virtualPagesPerAxis: 128,
      pageSize: 128,
      border: 4,
      atlasDimension: 272,
      casterRecordCapacity: C,
      residentSlots: 4,
      limits: device.limits,
    },
  };
  const authorPages = (count) => {
    const pageWords = new Uint32Array(128 * 12),
      metaWords = new Uint32Array(4 * 8),
      dirtyWords = new Uint32Array(4 + 4 * 8);
    dirtyWords.set([count, count, 0, generation]);
    for (let slot = 0; slot < count; slot++) {
      const wx = [0, 1, 50, 51][slot],
        virtualPage = wx;
      pageWords.set(
        [slot % 2, Math.floor(slot / 2), 0, 11, generation, 0, 0, generation, wx, 0, namespace, 0],
        virtualPage * 12,
      );
      metaWords.set([virtualPage, 0, 0, 11, generation, slot, 0, 0], slot * 8);
      dirtyWords.set([virtualPage, slot, 0, generation, 11, 0, wx, 0], 4 + slot * 8);
    }
    device.queue.writeBuffer(pages, 0, pageWords);
    device.queue.writeBuffer(metas, 0, metaWords);
    device.queue.writeBuffer(allocation, 0, dirtyWords);
  };
  const content = make(16, storage);
  const commitConstants = make(
    16,
    GPUBufferUsage.UNIFORM,
    new Uint32Array([generation, generation, namespace, 2]),
  );
  const commitModule = device.createShaderModule({ code: VSM_PAGE_COMMIT_WGSL });
  const commitPipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module: commitModule, entryPoint: "main" },
  });
  const commitGroup = device.createBindGroup({
    layout: commitPipeline.getBindGroupLayout(0),
    entries: [commitConstants, pairs, pages, metas, partition.states, content, allocation].map(
      (buffer, binding) => ({ binding, resource: { buffer } }),
    ),
  });
  const encode = async ({
    count,
    dirty,
    invalid = 0,
    overflow = 0,
    sourceCapacity = W,
    instance = 0,
    invalidMaterial = false,
    abort = false,
    measure = false,
  }) => {
    workWords.set([count, count, 0, sourceCapacity, overflow, 11, invalid, 0]);
    for (let slot = 0; slot < W; slot++) workWords[8 + slot * 6] = instance;
    device.queue.writeBuffer(work, 0, workWords);
    device.queue.writeBuffer(directory, 12, new Uint32Array([invalidMaterial ? 0 : 1]));
    authorPages(dirty);
    const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    let timestamps,
      querySet,
      queryRead,
      queryCount = 0;
    const stages = [];
    if (measure && device.features.has("timestamp-query")) {
      querySet = device.createQuerySet({ type: "timestamp", count: 32 });
      timestamps = make(256, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC);
      queryRead = make(256, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
      const begin = command.gpu_encoder.beginComputePass.bind(command.gpu_encoder);
      command.gpu_encoder.beginComputePass = (descriptor) => {
        stages.push(descriptor?.label ?? "commit");
        return begin({
          ...descriptor,
          timestampWrites: {
            querySet,
            beginningOfPassWriteIndex: queryCount++,
            endOfPassWriteIndex: queryCount++,
          },
        });
      };
    }
    bounds.encode(command, identity, allocation);
    const graph = new FrameGraph("R3 Geometry/pair/partition closure");
    const imp = (buffer) => graph.import_resource(buffer.label || "fixture", { kind: "imported" }, buffer);
    pairOwner.addToGraph(graph, {
      allocation: { allocation: imp(allocation), pageTable: imp(pages) },
      meshletWork: imp(work),
      meshletBounds: imp(bounds.records),
      instances: imp(instances),
      resources,
      frame,
      depthRange: imp(depth),
      generation,
      workCapacity: W,
    });
    command.encodeGraph(graph);
    partition.encode(command.gpu_encoder);
    const commit = command.beginComputePass({ label: "R3/per-page commit" });
    commit.setPipeline(commitPipeline);
    commit.setBindGroup(0, commitGroup);
    commit.dispatchWorkgroups(1);
    commit.end();
    if (querySet) {
      command.gpu_encoder.resolveQuerySet(querySet, 0, queryCount, timestamps, 0);
      command.gpu_encoder.copyBufferToBuffer(timestamps, 0, queryRead, 0, queryCount * 8);
    }
    if (abort) {
      const rejected = command.gpuDone.catch((error) => {
        check(String(error).includes("GPU command context aborted"), String(error));
      });
      command.abort();
      await rejected;
      return { aborted: true };
    }
    command.finish();
    await command.gpuDone;
    let costs = null;
    if (querySet) {
      await queryRead.mapAsync(GPUMapMode.READ);
      const values = new BigUint64Array(queryRead.getMappedRange());
      costs = stages.map((stage, index) => ({
        stage,
        milliseconds: Number(values[index * 2 + 1] - values[index * 2]) / 1e6,
      }));
      queryRead.unmap();
      querySet.destroy();
    }
    return { header: [...(await read(pairs)).slice(0, 8)], costs };
  };
  try {
    const cases = [];
    for (const [name, count, dirty, expectedMode, failure] of [
      ["C-1", C - 1, 1, 0, false],
      ["C", C, 1, 0, false],
      ["C+1-single-page", C + 1, 1, 1, false],
      ["multi-page", 1, 2, 0, false],
      ["multi-page-over-C", 33, 2, 1, false],
      ["empty-pages", 0, 4, 0, false],
      ["no-dirty", W, 0, 0, false],
    ]) {
      const result = await encode({ count, dirty });
      check(
        result.header[0] === count * Math.min(dirty, 2) &&
          result.header[4] === expectedMode &&
          result.header[2] === 0,
        `${name}: incomplete pair mode/count ${result.header}`,
      );
      check(
        result.header[1] === (expectedMode ? 0 : result.header[0]),
        `${name}: partial explicit publication`,
      );
      const draws = await read(partition.draws),
        states = await read(partition.states);
      const expectedCounts = new Uint32Array(24);
      for (let slot = 0; slot < count; slot++) {
        const bucket = Math.floor((triangleCounts[slot % 8] - 1) / 32);
        expectedCounts[(slot % 3) * 8 + bucket * 2 + (slot % 2)] += expectedMode ? 1 : Math.min(dirty, 2);
      }
      let drawInstances = 0;
      for (let key = 0; key < 24; key++) {
        check(
          states[key * 4] === expectedCounts[key] &&
            draws[key * 4] === (Math.floor((key % 8) / 2) + 1) * 96 &&
            draws[key * 4 + 1] === expectedCounts[key] * (expectedMode ? dirty : 1) &&
            draws[key * 4 + 3] === 0,
          `${name}: native bucket/side/count or implicit multiplication mismatch`,
        );
        drawInstances += draws[key * 4 + 1];
      }
      const published = await read(pages);
      for (let slot = 0; slot < dirty; slot++) {
        const page = [0, 1, 50, 51][slot] * 12;
        check((published[page + 3] & 11) === 9 && published[page + 6] === 1, `${name}: page completion`);
      }
      cases.push({
        name,
        ...result,
        drawInstances,
        nonemptyDraws: expectedCounts.filter((value) => value !== 0).length,
      });
    }
    for (const [name, options] of [
      ["geometry-invalid", { invalid: 1 }],
      ["geometry-overflow", { overflow: 1 }],
      ["geometry-capacity", { sourceCapacity: 1 }],
      ["partition-invalid", { invalidMaterial: true }],
    ]) {
      const result = await encode({ count: 2, dirty: 3, ...options });
      const published = await read(pages);
      check(
        [0, 1, 50].every((page) => (published[page * 12 + 3] & 2) !== 0 && published[page * 12 + 6] === 0),
        `${name}: failure published ready`,
      );
      const draws = await read(partition.draws);
      check(
        Array.from({ length: 24 }, (_, key) => draws[key * 4 + 1]).every((count) => count === 0),
        `${name}: incomplete native raster issued draws`,
      );
      cases.push({ name, ...result });
    }
    await encode({ count: 2, dirty: 2, instance: 1 });
    const projected = await read(bounds.records),
      floats = new Float32Array(projected.buffer);
    const matrix = transforms[1],
      corners = [];
    for (let corner = 0; corner < 8; corner++) {
      const p = [0.9, 0.1, -0.2].map((v, axis) =>
        Math.fround(corner & (1 << axis) ? [1.1, 0.2, 0.3][axis] : v),
      );
      corners.push(
        [0, 1].map(
          (axis) =>
            Math.fround(matrix[axis]) * p[0] +
            Math.fround(matrix[4 + axis]) * p[1] +
            Math.fround(matrix[8 + axis]) * p[2] +
            Math.fround(matrix[12 + axis]),
        ),
      );
    }
    const expected = [
      Math.min(...corners.map((p) => p[0])),
      Math.min(...corners.map((p) => p[1])),
      Math.max(...corners.map((p) => p[0])),
      Math.max(...corners.map((p) => p[1])),
    ];
    const actual = [...floats.slice(4, 8)];
    check(
      actual[0] <= expected[0] &&
        actual[1] <= expected[1] &&
        actual[2] >= expected[2] &&
        actual[3] >= expected[3] &&
        actual.every((v, i) => Math.abs(v - expected[i]) < 1e-4),
      "Meshlet shear/negative/nonuniform bounds not tight/conservative",
    );
    const before = [...(await read(pairs))];
    await encode({ count: C + 1, dirty: 3, abort: true });
    check(
      JSON.stringify([...(await read(pairs))]) === JSON.stringify(before),
      "Aborted GPU pair frame published data",
    );
    await encode({ count: C + 1, dirty: 3 });
    check((await read(pairs))[4] === 1, "Aborted implicit frame did not retry");
    // Independent sampling address check crosses into physical gutters.
    const samplingConstants = new Uint32Array(64);
    samplingConstants.set([128, 128, 4, 2], 40);
    const samplingUniform = make(256, GPUBufferUsage.UNIFORM, samplingConstants);
    const samplingOutput = make(16, storage);
    const samplingCode =
      `struct GpuPrimitiveTypeTable { direction: vec3f, }\n` +
      VSM_SAMPLING_WGSL +
      `
@group(0) @binding(0) var<uniform> vsm_constants: VsmSamplingConstants;
@group(0) @binding(1) var<storage, read> vsm_page_table: array<VsmPageEntry>;
@group(0) @binding(2) var vsm_atlas_depth: texture_depth_2d;
@group(1) @binding(0) var<storage, read_write> output: array<vec2i>;
@compute @workgroup_size(1) fn check_gutter() {
  let page = VsmPageEntry(1u, 1u, 0u, 9u, 19u, 0u, 1u, 19u, 0, 0, 5u, 0u);
  output[0] = vsm_atlas_texel(page, vec2f(0.0), vec2f(-0.5625));
  output[1] = vsm_atlas_texel(page, vec2f(0.999), vec2f(0.5625));
}`;
    const sampleModule = device.createShaderModule({ code: samplingCode });
    const info = await sampleModule.getCompilationInfo();
    check(!info.messages.some((m) => m.type === "error"), info.messages.map((m) => m.message).join("\n"));
    const samplePipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: sampleModule, entryPoint: "check_gutter" },
    });
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(samplePipeline);
    // Only statically used sampling constants are bound by this entry point.
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: samplePipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: samplingUniform } }],
      }),
    );
    pass.setBindGroup(
      1,
      device.createBindGroup({
        layout: samplePipeline.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer: samplingOutput } }],
      }),
    );
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([encoder.finish()]);
    check(
      JSON.stringify([...(await read(samplingOutput))]) === JSON.stringify([139, 139, 268, 268]),
      "PCF clamped the page interior instead of reading its gutter",
    );
    const costs = [];
    for (const [label, count, dirty] of [
      ["0%", 32, 0],
      ["50%", 32, 2],
      ["100%", 32, 4],
      ["rare-implicit", 33, 2],
      ["worst-implicit", W, 4],
    ]) {
      const samples = [];
      for (let i = 0; i < 12; i++) {
        const result = await encode({ count, dirty, measure: true });
        if (result.costs) samples.push(result.costs);
      }
      const total = samples
        .map((stages) => stages.reduce((sum, stage) => sum + stage.milliseconds, 0))
        .sort((a, b) => a - b);
      costs.push({
        label,
        W: count,
        D: dirty,
        samples,
        p50: total.length ? total[6] : null,
        p95: total.length ? total[11] : null,
      });
    }
    return {
      cases,
      affine: { actual, expected },
      abortRetry: true,
      gutter: true,
      costs,
      scope:
        "Production Geometry bounds/pair/partition/commit GPU stages; raster MASK/depth is the separate native integration oracle, no full-scene speed claim",
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    owners.reverse().forEach((owner) => owner.destroy());
    retained.forEach((buffer) => buffer.destroy());
    graphics.destroy();
  }
}
