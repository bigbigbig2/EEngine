import { GraphicsContext } from "../../.test-dist/gpu/GraphicsContext.js";
import { FrameGraph } from "../../.test-dist/framegraph/FrameGraph.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { packGpuInstanceRecords, GPU_INSTANCE_FLAGS } from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { VsmDepthBoundsPass } from "../../.test-dist/render/vsm/VsmDepthBoundsPass.js";
import { VsmGeneration } from "../../.test-dist/render/vsm/VsmGeneration.js";
import { VsmInvalidationPass } from "../../.test-dist/render/vsm/VsmInvalidationPass.js";
import { VsmResources } from "../../.test-dist/render/vsm/VsmResources.js";
import { negotiateVsmCapabilities } from "../../.test-dist/render/vsm/VsmCapabilities.js";
import { vsmWorldPageEntryIndex } from "../../.test-dist/render/vsm/VsmPageState.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export async function runVsmLocalInvalidationGpuOracle(device) {
  const graphics = new GraphicsContext(device);
  const resources = VsmResources.create(device, negotiateVsmCapabilities(device));
  const bounds = new VsmDepthBoundsPass(device);
  await bounds.preparePipelines();
  const invalidation = new VsmInvalidationPass(device);
  await invalidation.preparePipelines();
  const generations = new VsmGeneration();
  const retained = [];
  const make = (size, usage) => {
    const buffer = device.createBuffer({ size, usage });
    retained.push(buffer);
    return buffer;
  };
  const instances = make(132 * 176, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const inspect = async (source) => {
    const staging = make(source.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, 0, staging, 0, source.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const copy = staging.getMappedRange().slice(0);
    staging.unmap();
    return copy;
  };
  const caster = (x, asset = 0) => ({
    geometryRecordIndex: asset + 40,
    geometryGeneration: 0xfedcba98,
    productTableSlot: 3,
    materialHandle: 0xf0000001,
    flags: GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.CastsShadow | GPU_INSTANCE_FLAGS.VirtualGeometry,
    debugId: 0,
    boundsSphere: [0, 0, 0, 1],
    boundsMin: [-0.1, -0.1, -0.1],
    boundsMax: [0.1, 0.1, 0.1],
    currentObjectToWorld: [...identity.slice(0, 12), x, 0.5, 0, 1],
    previousObjectToWorld: identity
  });
  let records = [
    caster(0.5),
    caster(6.5, 1),
    { ...caster(30.5, 2), boundsMin: [-1, -1, -10], boundsMax: [1, 1, 10] }
  ];
  /** Proven per-asset changed regions for the residency-influence path. The
   * oracle drains them exactly like the production damage owner. */
  let pendingInfluences = [];
  const source = {
    publicationActive: true,
    productTableSlot: 3,
    productGeneration: 0xfedcba98,
    assetReferenceBegin: 40,
    assetContentRevisions: new Uint32Array([7, 8, 9]),
    residencyInfluences() {
      return pendingInfluences;
    },
    acknowledgeResidencyInfluences(changes) {
      if (changes === pendingInfluences) pendingInfluences = [];
    }
  };
  const scene = {};
  let revision = 0;
  let sourceRevision = 0;
  let width = 32;
  let currentState;
  const clips = Array.from({ length: resources.capabilities.clipLevels }, (_, i) => [
    -64,
    -64,
    128 * 2 ** i,
    1
  ]);
  const frame = () => ({
    lightView: identity,
    clipOriginExtent: clips,
    generation: currentState.generation,
    projectionEpoch: currentState.projectionEpoch,
    namespace: resources.namespace
  });
  const submit = async ({ abort = false, coverage = false, reset = false, residencyOnly = false } = {}) => {
    if (reset) generations.invalidate();
    device.queue.writeBuffer(instances, 0, packGpuInstanceRecords(records));
    const input = {
      deviceEpoch: 1,
      scene,
      sceneRevision: 1,
      casterRevision: residencyOnly ? revision : ++revision,
      sourceRevision: ++sourceRevision,
      coverageChanged: coverage,
      sunDirection: [0, 0, 1],
      cameraCut: false,
      clipOriginExtent: clips,
      width,
      height: 32
    };
    currentState = generations.prepare(input);
    const graph = new FrameGraph("VSM local invalidation production oracle");
    const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    command.onFinished.addOne(() => generations.commit(currentState));
    command.onAborted.addOne(() => generations.abort());
    bounds.prepareFrame(records.length, command, currentState, source);
    const contentVersion = invalidation.addToGraph(graph, { resources, frame: frame(), state: currentState });
    const result = bounds.addToGraph(graph, {
      resources,
      frame: frame(),
      state: currentState,
      contentVersion,
      instances: graph.import_resource("instances", { kind: "imported" }, instances),
      instanceBegin: 0,
      instanceCount: records.length
    });
    const consumer = graph.add("oracle depth consumer", {}, () => {});
    consumer.read(result.depthRange);
    consumer.make_side_effect();
    command.encodeGraph(graph);
    if (abort) {
      const done = command.gpuDone.catch((error) => check(String(error).includes("P5 abort"), String(error)));
      command.abort(new Error("P5 abort"));
      await done;
    } else {
      command.finish();
      await command.gpuDone;
    }
    return new Float32Array(await inspect(resources.depthRange));
  };
  const caps = resources.capabilities;
  // All six clips, every mip including coarse; negative world coordinates and
  // a neighbour touched ONLY by the four-texel gutter.
  const coordinates = [];
  for (let level = 0; level < caps.clipLevels; level++)
    for (let mip = 0; mip < 6; mip++) {
      for (const x of [-1, 0, 1, 6]) coordinates.push({ level, mip, x, y: 0 });
    }
  const seed = () => {
    const pages = new Uint32Array(caps.virtualEntryCount * 12);
    const metas = new Uint32Array(caps.residentSlots * 8);
    // The largest-mip torus has only four entries: skip duplicate addresses.
    const used = new Set();
    let slot = 0;
    for (const c of coordinates) {
      const index = vsmWorldPageEntryIndex(c.level, c.mip, c.x, c.y, caps.virtualPagesPerAxis);
      if (used.has(index)) continue;
      used.add(index);
      c.index = index;
      c.slot = slot;
      pages.set(
        [
          slot % caps.atlasPagesPerAxis,
          Math.floor(slot / caps.atlasPagesPerAxis),
          c.mip,
          13,
          currentState.generation,
          5,
          123,
          currentState.projectionEpoch,
          c.x >>> 0,
          0,
          resources.namespace,
          0
        ],
        index * 12
      );
      metas.set([index, c.mip, 17, 13, currentState.generation, slot, 0, 0], slot * 8);
      slot++;
    }
    device.queue.writeBuffer(resources.pageTable, 0, pages);
    device.queue.writeBuffer(resources.metaTable, 0, metas);
    return coordinates.filter((c) => c.index !== undefined);
  };
  const cornerXY = (record) => {
    const points = [];
    for (let mask = 0; mask < 8; mask++) {
      const p = record.boundsMin.map((low, a) => (mask & (1 << a) ? record.boundsMax[a] : low));
      const m = record.currentObjectToWorld;
      points.push([
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]
      ]);
    }
    return [
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1]))
    ];
  };
  let assertions = 0;
  const compare = async (seeded, damaged) => {
    const pages = new Uint32Array(await inspect(resources.pageTable));
    const metas = new Uint32Array(await inspect(resources.metaTable));
    for (const c of seeded) {
      const world = clips[c.level][2] / Math.max(1, caps.virtualPagesPerAxis >> c.mip);
      const gutter = (world * caps.border) / caps.pageSize;
      const low = [c.x * world - gutter, c.y * world - gutter];
      const high = [(c.x + 1) * world + gutter, (c.y + 1) * world + gutter];
      const dirty = damaged.some(
        (b) => b[2] >= low[0] && b[3] >= low[1] && b[0] <= high[0] && b[1] <= high[1]
      );
      check(pages[c.index * 12 + 3] === (dirty ? 11 : 13), `incorrect dirty/ready ${JSON.stringify(c)}`);
      check(metas[c.slot * 8 + 3] === (dirty ? 11 : 13), "meta ready must agree");
      check(
        pages[c.index * 12 + 6] === 123 && pages[c.index * 12 + 4] === currentState.generation,
        "content invalidation cannot replace identity or content version"
      );
      assertions += 3;
    }
  };
  try {
    const initial = await submit();
    const seeded = seed();
    const previous = records[0];
    records[0] = caster(1.5);
    const moved = await submit();
    check(
      [...moved].every((v, i) => v === initial[i]),
      "enclosed movement changed depth encoding"
    );
    check(
      !currentState.fullInvalidate && !currentState.temporalInvalidate,
      "normal caster motion advanced global epoch/history"
    );
    await compare(seeded, [cornerXY(previous), cornerXY(records[0])]);

    const beforeGutter = records[0];
    records[0] = {
      ...caster(-0.02),
      boundsMin: [-0.001, -0.001, -0.001],
      boundsMax: [0.001, 0.001, 0.001]
    };
    seed();
    await submit();
    await compare(seeded, [cornerXY(beforeGutter), cornerXY(records[0])]);
    const gutterCaster = records[0];
    check(cornerXY(gutterCaster)[2] < 0, "gutter fixture must stay outside page 0 interior");
    const gutterSeed = seed();
    source.assetContentRevisions[0]++;
    await submit();
    await compare(gutterSeed, [cornerXY(gutterCaster)]);
    const gutterPages = new Uint32Array(await inspect(resources.pageTable));
    const pageZero = gutterSeed.find((c) => c.level === 0 && c.mip === 0 && c.x === 0);
    check((gutterPages[pageZero.index * 12 + 3] & 2) !== 0, "gutter-only neighbour must be dirty");

    seed();
    source.assetContentRevisions[1] = 0xfffffffe;
    await submit();
    await compare(seeded, [cornerXY(records[1])]);
    seed();
    source.publicationActive = false;
    await submit();
    await compare(seeded, records.map(cornerXY));
    source.publicationActive = true;
    await submit();

    seed();
    const old = records[0];
    records[0] = {
      ...old,
      currentObjectToWorld: [-2, 0.25, 0, 0, 0.5, 3, 0, 0, 0, 0, -1, 0, -0.001, 0.5, 0, 1]
    };
    await submit();
    await compare(seeded, [cornerXY(old), cornerXY(records[0])]);
    seed();
    const removed = records[0];
    records[0] = { ...removed, flags: GPU_INSTANCE_FLAGS.Active };
    await submit();
    await compare(seeded, [cornerXY(removed)]);

    records[1] = { ...records[1], flags: records[1].flags | GPU_INSTANCE_FLAGS.AlphaTested };
    await submit();
    seed();
    await submit({ coverage: true });
    await compare(seeded, [cornerXY(records[1])]);
    seed();
    records[1] = { ...records[1], materialHandle: 0xffffffff };
    await submit();
    await compare(seeded, [cornerXY(records[1])]);

    seed();
    const beforeAbort = records[1];
    records[1] = { ...beforeAbort, currentObjectToWorld: [...identity.slice(0, 12), -2.5, 0.5, 0, 1] };
    await submit({ abort: true });
    await compare(seeded, []);
    await submit();
    await compare(seeded, [cornerXY(beforeAbort), cornerXY(records[1])]);

    seed();
    records[2] = { ...records[2], currentObjectToWorld: [...identity.slice(0, 12), 30.5, 0.5, 50, 1] };
    const expanded = await submit();
    check(
      expanded[1] > 59 && expanded[0] === initial[0],
      "expanded depth must retain old minimum and include new caster"
    );
    const allPages = new Uint32Array(await inspect(resources.pageTable));
    check(
      seeded.every((c) => allPages[c.index * 12 + 3] === 11),
      "depth expansion left cached content ready"
    );

    seed();
    const saved = records;
    records = Array.from({ length: 132 }, () => caster(0.5));
    await submit({ abort: true });
    records = saved;
    await submit();
    await compare(seeded, []);
    width = 64;
    await submit();
    check(!currentState.fullInvalidate && currentState.resized, "resize changed projection content identity");
    await submit({ reset: true });
    check(currentState.fullInvalidate, "explicit reset cannot use local damage");

    // A proven residency influence tightens damage to the changed region.
    // Unproven / fallback relations keep conservative whole-instance damage.
    const wide = { ...caster(0.5), boundsMin: [-8, -3, -1], boundsMax: [8, 3, 1] };
    records = [wide];
    await submit();
    const tightenSeed = seed();
    source.assetContentRevisions[0]++;
    pendingInfluences = [
      {
        assetIndex: 0,
        min: [-0.4, -0.4, -1],
        max: [0.4, 0.4, 1],
        revision: source.assetContentRevisions[0]
      }
    ];
    await submit();
    const tightenedPages = new Uint32Array(await inspect(resources.pageTable));
    const tightInside = tightenSeed.find((c) => c.level === 0 && c.mip === 0 && c.x === 0 && c.y === 0);
    check((tightenedPages[tightInside.index * 12 + 3] & 2) !== 0, "page inside the proven influence must be dirty");
    const tightOutside = tightenSeed.find((c) => c.level === 0 && c.mip === 0 && c.x === 6 && c.y === 0);
    check((tightenedPages[tightOutside.index * 12 + 3] & 2) === 0, "page outside the proven influence must stay ready");

    // Unproven influence (empty) falls back to whole-instance damage.
    seed();
    source.assetContentRevisions[0]++;
    pendingInfluences = [];
    await submit();
    const fallbackPages = new Uint32Array(await inspect(resources.pageTable));
    check((fallbackPages[tightInside.index * 12 + 3] & 2) !== 0, "fallback damage marks inside page dirty");
    assertions += 3;

    const contribution = (min, max, fullAsset = false) => ({
      assetIndex: 0, min, max, fullAsset, revision: source.assetContentRevisions[0],
    });
    seed();
    source.assetContentRevisions[0]++;
    pendingInfluences = [
      contribution([-0.4, -0.4, -1], [0.4, 0.4, 1]),
      contribution([5.5, -0.4, -1], [6.5, 0.4, 1]),
    ];
    const beforeResidencyDepth = await inspect(resources.depthRange);
    await submit({ abort: true, residencyOnly: true });
    check(pendingInfluences.length === 2, "abort consumed unpublished influence records");
    await submit({ residencyOnly: true });
    check(!currentState.rebuildDepthRange, "pure residency rebuilt the authored depth range");
    check(
      [...new Uint32Array(await inspect(resources.depthRange))].every(
        (value, index) => value === new Uint32Array(beforeResidencyDepth)[index],
      ),
      "pure residency changed depth encoding",
    );
    const unionPages = new Uint32Array(await inspect(resources.pageTable));
    check((unionPages[tightInside.index * 12 + 3] & 2) !== 0, "first page influence was overwritten");
    check((unionPages[tightOutside.index * 12 + 3] & 2) !== 0, "second page influence was omitted");
    seed();
    source.assetContentRevisions[0]++;
    pendingInfluences = [
      contribution([0, 0, 0], [0, 0, 0], true),
      contribution([-0.4, -0.4, -1], [0.4, 0.4, 1]),
    ];
    await submit({ residencyOnly: true });
    const mixedPages = new Uint32Array(await inspect(resources.pageTable));
    check((mixedPages[tightOutside.index * 12 + 3] & 2) !== 0, "tight subset hid a whole-asset fallback");
    assertions += 6;
    return {
      assertions,
      clips: caps.clipLevels,
      mips: 6,
      initial: [...initial],
      expanded: [...expanded],
      oldNew: "passed",
      productAssetStamps: "passed",
      mask: "passed",
      abortResizeRetry: "passed",
      tightenedInfluence: "passed"
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    bounds.destroy();
    invalidation.destroy();
    resources.destroy();
    graphics.destroy();
    for (const buffer of retained) buffer.destroy();
  }
}
