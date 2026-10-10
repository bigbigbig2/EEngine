import { VSM_DEMAND_SCAN_WGSL } from "../../.test-dist/shaders/vsm_demand_scan.js";
import { VSM_ALLOCATE_PAGES_WGSL } from "../../.test-dist/shaders/vsm_allocate_pages.js";
import { VSM_RECEIVER_DEMAND_WGSL } from "../../.test-dist/shaders/vsm_receiver_demand.js";
import { VSM_PAGE_COMMIT_WGSL } from "../../.test-dist/shaders/vsm_page_commit.js";
import { VSM_ATLAS_PAGE_CLEAR_WGSL } from "../../.test-dist/shaders/vsm_atlas_raster.js";
import { VSM_SAMPLING_WGSL } from "../../.test-dist/shaders/vsm_sampling.js";
import { VsmResources } from "../../.test-dist/render/vsm/VsmResources.js";
import { negotiateVsmCapabilities } from "../../.test-dist/render/vsm/VsmCapabilities.js";
import { VsmAllocatePagesPass } from "../../.test-dist/render/vsm/VsmAllocatePagesPass.js";
import { VsmInvalidationPass } from "../../.test-dist/render/vsm/VsmInvalidationPass.js";
import {
  VsmReceiverDemandPass,
  packVsmSamplingConstants,
} from "../../.test-dist/render/vsm/VsmReceiverDemandPass.js";
import { GraphicsContext } from "../../.test-dist/gpu/GraphicsContext.js";
import { FrameGraph } from "../../.test-dist/framegraph/FrameGraph.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { packVsmProjection } from "../../.test-dist/render/vsm/VsmProjection.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
export async function runVsmR2GpuOracle(device) {
  const modules = {};
  for (const [label, code] of Object.entries({
    scan: VSM_DEMAND_SCAN_WGSL,
    residency: VSM_ALLOCATE_PAGES_WGSL,
    receiver: VSM_RECEIVER_DEMAND_WGSL,
    commit: VSM_PAGE_COMMIT_WGSL,
  })) {
    const module = device.createShaderModule({ label, code });
    const info = await module.getCompilationInfo();
    check(
      !info.messages.some((message) => message.type === "error"),
      `${label}: ${info.messages.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`).join("\n")}`,
    );
    modules[label] = module;
  }
  const graphics = new GraphicsContext(device);
  const resources = VsmResources.create(device, negotiateVsmCapabilities(device));
  const profile = resources.capabilities;
  check(profile.profile === "vsm-directional-high", "This full-domain fixture requires high profile");
  const allocate = new VsmAllocatePagesPass(device);
  const receiver = new VsmReceiverDemandPass(device);
  const invalidate = new VsmInvalidationPass(device);
  const retained = [];
  const make = (size, usage, bytes) => {
    const buffer = device.createBuffer({ size, usage, mappedAtCreation: bytes !== undefined });
    if (bytes !== undefined) {
      new Uint8Array(buffer.getMappedRange()).set(
        new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength),
      );
      buffer.unmap();
    }
    retained.push(buffer);
    return buffer;
  };
  const inspect = async (source) => {
    const staging = make(source.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, 0, staging, 0, source.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    return words;
  };
  const frame = {
    generation: 7,
    projectionEpoch: 7,
    namespace: resources.namespace,
    lightView: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    clipOriginExtent: Array.from({ length: 6 }, (_, level) => {
      const extent = 128 * 2 ** level;
      return [-extent / 2, -extent / 2, extent, extent / (128 * 128)];
    }),
  };
  // Independent address construction; no production page/index/window helpers.
  const perLevel = 16384 + 4096 + 1024 + 256 + 64 + 64;
  const coarseSet = () => {
    const expected = new Set();
    frame.clipOriginExtent.forEach(([x, y, extent], level) => {
      const step = extent / 4;
      for (let wy = Math.floor(y / step); wy < Math.ceil((y + extent) / step); wy++) {
        for (let wx = Math.floor(x / step); wx < Math.ceil((x + extent) / step); wx++) {
          const wrap = (value) => ((value % 8) + 8) % 8;
          expected.add((level + 1) * perLevel - 64 + wrap(wy) * 8 + wrap(wx));
        }
      }
    });
    return expected;
  };
  const fullFine = new Set();
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 256; x++) {
      const wx = Math.floor(-64 + (x + 0.5) / 2);
      const wy = Math.floor(64 - (y + 0.5));
      fullFine.add(((wy + 128) % 128) * 128 + ((wx + 128) % 128));
    }
  }
  const markExpected = (fine) => {
    const bits = new Uint32Array(Math.ceil(profile.virtualEntryCount / 32));
    for (const index of [...fine, ...coarseSet()]) {
      bits[index >>> 5] |= 1 << (index & 31);
    }
    device.queue.writeBuffer(resources.requestedPages, 0, bits);
  };
  const readState = async () => {
    const [pages, metas, demand, allocation, telemetry, requested] = await Promise.all(
      [
        resources.pageTable,
        resources.metaTable,
        resources.demand,
        resources.allocation,
        resources.overflowCounters,
        resources.requestedPages,
      ].map(inspect),
    );
    const map = new Map();
    for (let index = 0; index < pages.length / 12; index++) {
      const p = index * 12;
      if ((pages[p + 3] & 9) !== 9) continue;
      const slot = pages[p + 1] * profile.atlasPagesPerAxis + pages[p];
      check(metas[slot * 8] === index && metas[slot * 8 + 4] === 7, "Broken reverse slot identity");
      map.set(index, {
        slot,
        flags: pages[p + 3],
        version: pages[p + 6],
        world: [pages[p + 8] | 0, pages[p + 9] | 0],
      });
    }
    check(new Set([...map.values()].map((value) => value.slot)).size === map.size, "Duplicate slot owner");
    check(allocation[1] <= profile.residentSlots && allocation[2] === 0, "Dirty work publication overflow");
    const dirtyIds = Array.from({ length: allocation[1] }, (_, i) => allocation[4 + i * 8]);
    check(new Set(dirtyIds).size === dirtyIds.length, "Duplicate dirty page writer");
    check(demand[2] === 0, "Unique full-domain demand must not overflow");
    for (const page of coarseSet()) {
      check(
        map.has(page) && map.get(page).slot < profile.coarseReservedSlots,
        "Coarse cover missing under fine pressure",
      );
    }
    check(telemetry[3] === 0, "Coarse allocation failure");
    return { pages, metas, demand, allocation, telemetry, requested, map };
  };
  const encodeResidency = async (
    serial,
    { producer = false, rolled = false, abort = false, measure = false } = {},
  ) => {
    const graph = new FrameGraph("R2 complete-domain residency oracle");
    const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    let querySet, timestamps, readback;
    let queryCount = 0;
    const stages = [];
    if (measure && device.features.has("timestamp-query")) {
      querySet = device.createQuerySet({ type: "timestamp", count: 22 });
      timestamps = make(176, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC);
      readback = make(176, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
      const begin = command.beginComputePass.bind(command);
      command.beginComputePass = (descriptor) => {
        stages.push(descriptor.label);
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
    const importBuffer = (name, buffer) => graph.import_resource(name, { kind: "imported" }, buffer);
    let content = importBuffer("content", resources.contentVersion);
    if (rolled) {
      content = invalidate.addToGraph(graph, {
        resources,
        frame,
        state: {
          generation: 7,
          projectionEpoch: 7,
          frameSerial: serial,
          deviceEpoch: 1,
          sceneRevision: 1,
          casterRevision: 1,
          reason: "page-quantum",
          reasonMask: 128,
          fullInvalidate: false,
          temporalInvalidate: false,
          pageQuantumChanged: true,
          resized: false,
        },
      });
    }
    let demand = importBuffer("requests", resources.requestedPages);
    if (producer) {
      demand = receiver.addToGraph(graph, {
        width: 256,
        height: 128,
        camera: importBuffer("camera", camera),
        instances: importBuffer("instances", instances),
        meshletWork: importBuffer("work", work),
        depthRange: importBuffer("depth range", resources.depthRange),
        frame,
        resources,
        depth: graph.import_resource("depth", { kind: "imported" }, depth),
        visibilityKey: graph.import_resource("key", { kind: "imported" }, key),
        generation: 7,
      }).demand;
    }
    allocate.addToGraph(graph, {
      demand,
      resources,
      generation: 7,
      frameSerial: serial,
      contentVersion: content,
      frame,
    });
    command.encodeGraph(graph);
    if (abort) {
      const rejected = command.gpuDone.then(
        () => {
          throw new Error("Aborted command unexpectedly submitted");
        },
        (error) =>
          check(String(error).includes("R2 injected pre-submit abort"), `Unexpected abort: ${error}`),
      );
      command.abort(new Error("R2 injected pre-submit abort"));
      await rejected;
      return;
    }
    if (querySet) {
      command.gpu_encoder.resolveQuerySet(querySet, 0, queryCount, timestamps, 0);
      command.gpu_encoder.copyBufferToBuffer(timestamps, 0, readback, 0, queryCount * 8);
    }
    command.finish();
    await command.gpuDone;
    if (querySet) {
      await readback.mapAsync(GPUMapMode.READ);
      const values = new BigUint64Array(readback.getMappedRange());
      const times = stages.map((stage, i) => ({
        stage,
        milliseconds: Number(values[i * 2 + 1] - values[i * 2]) / 1e6,
      }));
      readback.unmap();
      querySet.destroy();
      return times;
    }
  };
  const packedCamera = new Float32Array(624 / 4);
  packedCamera.set([64, 0, 0, 0, 0, 64, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 112);
  const camera = make(
    packedCamera.byteLength,
    GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    packedCamera,
  );
  const instanceWords = new Uint32Array(44);
  instanceWords[2] = 7 | (4 << 8);
  const instances = make(176, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, instanceWords);
  const workWords = new Uint32Array(8 + 6);
  workWords.set([1, 1, 1, 1, 0, 7, 0, 0]);
  const work = make(workWords.byteLength, GPUBufferUsage.STORAGE, workWords);
  const depth = device.createTexture({
    size: [256, 128],
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const key = device.createTexture({
    size: [256, 128],
    format: "r32uint",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  retained.push(depth, key);
  device.queue.writeTexture(
    { texture: key },
    new Uint32Array(256 * 128),
    { bytesPerRow: 256 * 4 },
    [256, 128],
  );
  device.queue.writeBuffer(resources.depthRange, 0, new Float32Array([-1, 1, 0.5, 1]));
  const clear = device.createCommandEncoder();
  clear
    .beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depth.createView(),
        depthClearValue: 0.5,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    })
    .end();
  device.queue.submit([clear.finish()]);
  const commitConstants = make(
    16,
    GPUBufferUsage.UNIFORM,
    new Uint32Array([7, 7, resources.namespace, profile.atlasPagesPerAxis]),
  );
  const caster = make(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, new Uint32Array([0, 0, 0, 7]));
  const completion = make(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, new Uint32Array(4));
  const commit = device.createComputePipeline({
    layout: "auto",
    compute: { module: modules.commit, entryPoint: "main" },
  });
  const commitGroup = device.createBindGroup({
    layout: commit.getBindGroupLayout(0),
    entries: [
      commitConstants,
      caster,
      resources.pageTable,
      resources.metaTable,
      completion,
      resources.contentVersion,
      resources.allocation,
    ].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  const clearConstants = packVsmProjection(frame);
  new Uint32Array(clearConstants).set([128, 128, 4, 4096, 7, 0, 65536, 900], 40);
  const clearBuffer = make(256, GPUBufferUsage.UNIFORM, clearConstants);
  const clearModule = device.createShaderModule({ code: VSM_ATLAS_PAGE_CLEAR_WGSL });
  const clearPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: clearModule, entryPoint: "clear_page" },
    fragment: { module: clearModule, entryPoint: "clear_depth", targets: [] },
    primitive: { topology: "triangle-list" },
    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
  });
  const clearGroup = device.createBindGroup({
    layout: clearPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: clearBuffer } },
      { binding: 1, resource: { buffer: resources.allocation } },
    ],
  });
  const publishEmpty = async () => {
    const encoder = device.createCommandEncoder();
    const raster = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: resources.atlasDepthView,
        depthLoadOp: "load",
        depthStoreOp: "store",
      },
    });
    raster.setPipeline(clearPipeline);
    raster.setBindGroup(0, clearGroup);
    raster.draw(6, profile.residentSlots);
    raster.end();
    const pass = encoder.beginComputePass();
    pass.setPipeline(commit);
    pass.setBindGroup(0, commitGroup);
    pass.dispatchWorkgroups(Math.ceil(profile.residentSlots / 64));
    pass.end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
  };
  const runSamplingQueries = async () => {
    const points = [
      [-48, -16],
      [-48, -48],
      [-16, -48],
      [16, -48],
      [48, -48],
      [1e6, 1e6],
    ];
    const authored = new Uint32Array(profile.virtualEntryCount * 12);
    const author = (point, mip, flags, epoch = 7) => {
      const step = mip === 5 ? 32 : 1;
      const axis = mip === 5 ? 8 : 128;
      const world = point.map((value) => Math.floor(value / step));
      const wrap = (value) => ((value % axis) + axis) % axis;
      const index = (mip === 5 ? perLevel - 64 : 0) + wrap(world[1]) * axis + wrap(world[0]);
      authored.set(
        [0, 0, mip, flags, 7, 5, 1, epoch, world[0] >>> 0, world[1] >>> 0, resources.namespace, 0],
        index * 12,
      );
    };
    author(points[0], 0, 9);
    author(points[1], 5, 25);
    author(points[3], 0, 9, 6);
    author(points[4], 0, 11);
    const table = make(authored.byteLength, GPUBufferUsage.STORAGE, authored);
    const packed = packVsmSamplingConstants({ resources, frame, width: 256, height: 128, generation: 7 });
    new Float32Array(packed).set([-1, 1, 0.5, 1], 52);
    const constants = make(256, GPUBufferUsage.UNIFORM, packed);
    const positions = make(
      points.length * 16,
      GPUBufferUsage.STORAGE,
      new Float32Array(points.flatMap(([x, y]) => [x, y, 0, 1])),
    );
    const output = make(points.length * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const module = device.createShaderModule({
      code: `
struct GpuPrimitiveTypeTable { direction: vec3f, };
${VSM_SAMPLING_WGSL}
@group(0) @binding(0) var<uniform> vsm_constants: VsmSamplingConstants;
@group(0) @binding(1) var<storage, read> vsm_page_table: array<VsmPageEntry>;
@group(0) @binding(2) var vsm_atlas_depth: texture_depth_2d;
@group(0) @binding(3) var<storage, read> positions: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> results: array<vec4u>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&positions)) { return; }
  let query = vsm_query_directional(positions[id.x].xy);
  let visibility = vsm_sample_directional(positions[id.x].xyz, vec3f(0.0, 1.0, 0.0),
    GpuPrimitiveTypeTable(vec3f(0.0, 1.0, 0.0)));
  results[id.x] = vec4u(query.status, query.target_status, query.level, bitcast<u32>(visibility));
}`,
    });
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: constants } },
        { binding: 1, resource: { buffer: table } },
        { binding: 2, resource: resources.atlasDepthView },
        { binding: 3, resource: { buffer: positions } },
        { binding: 4, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([encoder.finish()]);
    const actual = await inspect(output);
    const statuses = Array.from({ length: 6 }, (_, i) => actual[i * 4]);
    check(
      JSON.stringify(statuses) === JSON.stringify([0, 1, 2, 3, 4, 5]),
      `Sampling classifications: ${statuses}`,
    );
    check(actual[5] === 2, "Coarse fallback hid missing fine target");
    check(
      Array.from({ length: 6 }, (_, i) => actual[i * 4 + 3]).every((value) => value === 0x3f800000),
      "Cleared empty/invalid query did not return neutral visibility",
    );
    return { statuses, coarseTargetStatus: actual[5], neutralVisibility: true };
  };
  device.pushErrorScope("validation");
  try {
    await encodeResidency(1, { producer: true });
    const first = await readState();
    check(
      first.demand[0] === 16384 && first.demand[1] === 16384 + 96,
      "Receiver set lost pixels/pages after 8192",
    );
    for (let page = 0; page < 16384; page++) {
      check((first.requested[page >>> 5] & (1 << (page & 31))) !== 0, `Receiver omitted page ${page}`);
    }
    check(
      first.map.size === 846 && first.telemetry[0] === 15634,
      "Fine pressure must preserve full demand and complete coarse cover",
    );
    await publishEmpty();
    const ready = await readState();
    check(
      [...ready.map.values()].every((entry) => (entry.flags & 2) === 0 && entry.version === 1),
      "Empty dirty pages must complete once",
    );
    await publishEmpty();
    check(
      [...(await readState()).map.values()].every((entry) => entry.version === 1),
      "Repeated commit advanced version twice",
    );
    await encodeResidency(2, { producer: true });
    check((await readState()).allocation[1] === 0, "Stable ready pages generated dirty work");
    // Reverse both screen axes: same complete expected set, different lane-to-page order.
    device.queue.writeBuffer(
      camera,
      112 * 4,
      new Float32Array([-64, 0, 0, 0, 0, -64, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    );
    await encodeResidency(2, { producer: true });
    check((await readState()).allocation[1] === 0, "Receiver execution order changed the unique page set");
    const keep = ready.map.get(0);
    const oldDirty = ready.map.get(1);
    device.queue.writeBuffer(resources.pageTable, 1 * 48 + 12, new Uint32Array([11]));
    device.queue.writeBuffer(resources.metaTable, oldDirty.slot * 32 + 12, new Uint32Array([11]));
    const replacement = new Set([0, ...Array.from({ length: 750 }, (_, i) => 1000 + i)]);
    markExpected(replacement);
    await encodeResidency(3);
    const recycled = await readState();
    check(
      recycled.map.get(0).slot === keep.slot && recycled.map.get(0).version === 1,
      "Touch lost to eviction",
    );
    check(
      !recycled.map.has(1) && recycled.telemetry[1] === 749 && recycled.telemetry[0] === 1,
      "Same-generation dirty unrequested pages did not recycle",
    );
    for (const [level, clip] of frame.clipOriginExtent.entries()) {
      clip[0] += 2 ** level;
      clip[1] += 2 ** level;
    }
    markExpected(replacement);
    await encodeResidency(4, { rolled: true });
    const rolled = await readState();
    check(
      coarseSet().size === 150 && rolled.map.get(0).slot === keep.slot,
      "Rolling coarse guard cover lost fine intersection",
    );
    const victim = rolled.map.get(1000);
    device.queue.writeBuffer(resources.metaTable, victim.slot * 32 + 12, new Uint32Array([0]));
    await publishEmpty();
    check((await readState()).map.get(1000).flags & 2, "Revoked reverse owner published ready");
    device.queue.writeBuffer(resources.metaTable, victim.slot * 32 + 12, new Uint32Array([victim.flags]));
    device.queue.writeBuffer(completion, 4, new Uint32Array([1]));
    await publishEmpty();
    check((await readState()).map.get(1000).flags & 2, "Malformed native partitions published ready");
    device.queue.writeBuffer(completion, 4, new Uint32Array([0]));
    device.queue.writeBuffer(caster, 8, new Uint32Array([1]));
    await publishEmpty();
    check((await readState()).map.get(1000).flags & 2, "Caster overflow published ready");
    device.queue.writeBuffer(caster, 8, new Uint32Array([0]));
    await publishEmpty();
    check(
      ((await readState()).map.get(1000).flags & 2) === 0,
      "Successful retry did not complete dirty page",
    );
    markExpected(new Set([0, 5000]));
    const beforeAbort = await inspect(resources.pageTable);
    await encodeResidency(5, { abort: true });
    check(
      JSON.stringify(Array.from(await inspect(resources.pageTable))) ===
        JSON.stringify(Array.from(beforeAbort)),
      "Pre-submit abort changed residency",
    );
    await encodeResidency(5);
    check((await readState()).map.has(5000), "Aborted frame scratch prevented retry");
    const queries = await runSamplingQueries();
    const costs = [];
    // Author readiness fractions only; all work below uses the actual production allocator.
    const baseline = await readState();
    const fine = new Set([...baseline.map.keys()].filter((page) => page < 16384));
    markExpected(fine);
    let serial = 6;
    for (const fraction of [0, 0.5, 1]) {
      const pages = baseline.pages.slice();
      const metas = baseline.metas.slice();
      let ordinal = 0;
      const dirtyCount = Math.floor(baseline.map.size * fraction);
      for (const [page, entry] of baseline.map) {
        const dirty = ordinal++ < dirtyCount ? 2 : 0;
        pages[page * 12 + 3] = (pages[page * 12 + 3] & ~6) | dirty;
        metas[entry.slot * 8 + 3] = (metas[entry.slot * 8 + 3] & ~6) | dirty;
      }
      device.queue.writeBuffer(resources.pageTable, 0, pages);
      device.queue.writeBuffer(resources.metaTable, 0, metas);
      await encodeResidency(serial++);
      check((await readState()).allocation[1] === dirtyCount, "Dirty fraction workload mismatch");
      const samples = [];
      for (let iteration = 0; iteration < 12; iteration++) {
        const stages = await encodeResidency(serial++, { measure: true });
        if (stages)
          samples.push({ totalMs: stages.reduce((sum, stage) => sum + stage.milliseconds, 0), stages });
      }
      const sorted = samples.map((sample) => sample.totalMs).sort((a, b) => a - b);
      costs.push({
        fraction,
        dirtyCount,
        samples,
        p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? null,
        p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? null,
      });
    }
    const receiverCosts = [];
    for (let iteration = 0; iteration < 12; iteration++) {
      const stages = await encodeResidency(serial++, { producer: true, measure: true });
      if (stages) receiverCosts.push(stages);
    }
    const validation = await device.popErrorScope();
    check(validation === null, validation?.message ?? "GPU validation error");
    return {
      compiled: Object.keys(modules),
      receiverPixels: 32768,
      uniqueFinePages: 16384,
      coarseInitial: 96,
      coarseRolling: 150,
      initialMapped: 846,
      fineMisses: 15634,
      recycled: 749,
      touchedPageRetained: true,
      emptyPagesReady: true,
      failureNeverReady: true,
      stableDirty: 0,
      abortRetry: true,
      queries,
      costs,
      profile,
      receiverCosts,
      timestampAvailable: device.features.has("timestamp-query"),
    };
  } finally {
    allocate.destroy();
    receiver.destroy();
    invalidate.destroy();
    resources.destroy();
    retained.forEach((resource) => resource.destroy());
    graphics.destroy();
  }
}
