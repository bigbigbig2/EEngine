import { ScgiRuntime } from "../../.test-dist/render/gi/ScgiRuntime.js";
import { ScgiCache } from "../../.test-dist/render/gi/ScgiCache.js";
import { packScgiRecord } from "../../.test-dist/render/gi/ScgiAbi.js";
import { scgiCacheRequestWgsl } from "../../.test-dist/shaders/scgi_cache.js";
import { scgiGraphics, scgiCommand, scgiProfile } from "./scgi-fixture.mjs";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const demand = { enabled: true, hasGeometry: true, hasLitMaterials: true };
const baseSettings = {
  originEpoch: 1,
  camera: [0, 0, 0],
  voxelSize: 1,
  bounceEnabled: true,
  evictionAge: 100,
  moveBudget: 0,
  normalCosine: 0.9,
  planeDistanceScale: 0.1,
  updateAge: 4,
  varianceThreshold: 1,
};

function request(position, normal = [0, 0, 1], rank = 0, identity = 7) {
  return packScgiRecord("request", {
    positionRadius: [...position, 0],
    normal,
    source: 0,
    identity: new Uint32Array(12).fill(identity),
    cellRankPixelStatus: [0, rank, 0, 0],
  });
}

// Independent integer spatial model. Does not import the production shader or
// its address helper; verifies cell↔patch, semantic identity and complete state.
function expectedCell(position, normal, settings, profile) {
  const d = Math.abs(normal[0]) + Math.abs(normal[1]) + Math.abs(normal[2]);
  let [x, y, z] = normal.map((v) => v / d);
  if (z < 0) [x, y] = [(1 - Math.abs(y)) * (x < 0 ? -1 : 1), (1 - Math.abs(x)) * (y < 0 ? -1 : 1)];
  const bin = Math.min(3, Math.floor((y * 0.5 + 0.5) * 4)) * 4 + Math.min(3, Math.floor((x * 0.5 + 0.5) * 4));
  for (let c = 0; c < profile.cascades; c++) {
    const scale = settings.voxelSize * 2 ** c;
    const coordinate = position.map((v) => Math.floor(v / scale));
    const origin = settings.camera.map((v) => Math.floor(v / scale) - Math.floor(profile.resolution / 2));
    if (coordinate.every((v, i) => v >= origin[i] && v < origin[i] + profile.resolution)) {
      const mod = coordinate.map((v) => ((v % profile.resolution) + profile.resolution) % profile.resolution);
      return (
        (c * profile.resolution ** 3 + (mod[0] * profile.resolution + mod[1]) * profile.resolution + mod[2]) *
          16 +
        bin
      );
    }
  }
  return 0xffffffff;
}

export async function runScgiCacheGpuOracle(device) {
  const graphics = scgiGraphics(device);
  const runtimes = [];
  const results = [];
  let submitted = 0;
  const costs = [];
  const create = async (profile) => {
    const runtime = new ScgiRuntime(device, runtimes.length + 1);
    runtimes.push(runtime);
    const plan = await runtime.configure(demand, profile);
    const cache = await ScgiCache.create(device, plan);
    return { runtime, plan, cache, profile };
  };
  const step = async (state, frame, requests = [], options = {}) => {
    const started = performance.now();
    const command = scgiCommand(graphics);
    const timing = options.measure ? device.createQuerySet({ type: "timestamp", count: 2 }) : null;
    const timingResolve = timing
      ? device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
      : null;
    const timingRead = timing
      ? device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      : null;
    let dispatches = 0;
    const beginCompute = command.beginComputePass.bind(command);
    command.beginComputePass = (...args) => {
      dispatches++;
      if (timing && (dispatches === 1 || args[0]?.label === "SCGI/cache/finish")) {
        args[0] = {
          ...args[0],
          timestampWrites: {
            querySet: timing,
            ...(dispatches === 1 ? { beginningOfPassWriteIndex: 0 } : { endOfPassWriteIndex: 1 }),
          },
        };
      }
      return beginCompute(...args);
    };
    const transaction = state.runtime.prepare(command, { scene: 1, view: 1 });
    state.runtime.encode(transaction);
    const { publication } = transaction;
    const world = publication.candidateWorld;
    const scratch = publication.privateScratch;
    const settings = { ...baseSettings, frame, ...options.settings };
    const regions = [];
    if (requests.length) {
      const bytes = new Uint8Array(requests.length * 96);
      requests.forEach((value, i) => bytes.set(value, i * 96));
      regions.push({
        destination: scratch.buffer,
        destinationOffset: scratch.plan.ranges.requests.offset,
        bytes,
      });
    }
    regions.push({
      destination: scratch.buffer,
      destinationOffset: scratch.plan.ranges.cacheControl.offset,
      bytes: new Uint8Array(new Uint32Array([requests.length]).buffer),
    });
    if (options.write) options.write({ regions, world, scratch, transaction });
    command.uploadRegions(regions);
    if (options.producer) options.producer({ command, world, scratch });
    try {
      state.cache.encode(transaction, settings);
    } catch (error) {
      command.abort(error);
      throw error;
    }
    if (options.afterCache) {
      const after = [];
      options.afterCache({ regions: after, world, scratch, transaction });
      command.uploadRegions(after);
    }
    if (options.afterGpu) options.afterGpu({ command, world, scratch });
    const read = device.createBuffer({
      size: world.plan.bytes + scratch.plan.bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    command.copyBufferToBuffer(world.buffer, 0, read, 0, world.plan.bytes);
    command.copyBufferToBuffer(scratch.buffer, 0, read, world.plan.bytes, scratch.plan.bytes);
    if (timing) {
      command.gpu_encoder.resolveQuerySet(timing, 0, 2, timingResolve, 0);
      command.copyBufferToBuffer(timingResolve, 0, timingRead, 0, 16);
    }
    if (options.abort) {
      command.abort(new Error("cache oracle pre-submit abort"));
      read.destroy();
      return { transaction };
    }
    command.finish();
    submitted++;
    await command.gpuDone;
    await read.mapAsync(GPUMapMode.READ);
    const bytes = read.getMappedRange().slice(0);
    read.unmap();
    read.destroy();
    const words = new Uint32Array(bytes, 0, world.plan.bytes / 4);
    const floats = new Float32Array(bytes, 0, world.plan.bytes / 4);
    const scratchWords = new Uint32Array(bytes, world.plan.bytes, scratch.plan.bytes / 4);
    const control = scratchWords.slice(
      scratch.plan.ranges.cacheControl.offset / 4,
      scratch.plan.ranges.cacheControl.offset / 4 + 64,
    );
    const patchBase = world.plan.ranges.patches.offset / 4;
    const map = world.plan.ranges.map.offset / 4;
    const live = [];
    for (let slot = 0; slot < state.profile.patches; slot++) {
      const at = patchBase + slot * 72;
      if (words[world.plan.ranges.cacheState.offset / 4 + slot * 4 + 3] === 0) continue;
      const cell = words[at + 20];
      check(cell < state.plan.cells, "live cell bounds");
      check(words[map + cell * 2] === slot, "patch→cell→patch bijection");
      check(words[map + cell * 2 + 1] === words[at + 23], "map generation follows slot lifetime");
      live.push({
        slot,
        at,
        cell,
        position: [...floats.slice(at, at + 3)],
        normal: [...floats.slice(at + 4, at + 7)],
        rank: words[at + 68],
      });
    }
    const liveBySlot = new Map(live.map((record) => [record.slot, record]));
    for (let cell = 0; cell < state.plan.cells; cell++) {
      const slot = words[map + cell * 2];
      check(slot === 0xffffffff || liveBySlot.get(slot)?.cell === cell, "no stale cell alias");
    }
    check(words[18] === live.length && control[2] === live.length, "allocator live count");
    check(words[16] < state.profile.patches && words[17] < state.profile.patches, "ring normalized cursors");
    const activeBase = scratch.plan.ranges.cacheActive.offset / 4;
    const ring = Array.from(
      { length: live.length },
      (_, i) => scratchWords[activeBase + ((words[16] + i) % state.profile.patches)],
    );
    check(
      new Set(ring).size === live.length && ring.every((slot) => live.some((v) => v.slot === slot)),
      "logical ring names every physical live slot exactly once across wrap and holes",
    );
    if (!options.allowFault) check(control[9] === 0, "no cache numeric/generation fault");
    for (const record of live) {
      check(
        record.cell === expectedCell(record.position, record.normal, settings, state.profile),
        "independent toroidal address",
      );
    }
    const updateAt = scratch.plan.ranges.updateList.offset / 4;
    const updates = [...scratchWords.slice(updateAt, updateAt + control[28])];
    check(new Set(updates).size === updates.length, "update work has no duplicates");
    check(
      updates.every((slot) => live.some((v) => v.slot === slot)),
      "update work only live slots",
    );
    let gpuCacheMs = null;
    if (timing) {
      await timingRead.mapAsync(GPUMapMode.READ);
      const stamps = new BigUint64Array(timingRead.getMappedRange());
      gpuCacheMs = Number(stamps[1] - stamps[0]) / 1e6;
      timingRead.unmap();
      timingRead.destroy();
      timingResolve.destroy();
      timing.destroy();
    }
    if (options.measure)
      costs.push({
        profile: state.profile,
        dispatches,
        allocatedBytes: state.plan.totalBytes,
        worldCopyBytes: state.plan.world.bytes,
        scratchClearBytes: state.plan.scratch.bytes + state.plan.batch.bytes,
        gpuCacheMs,
        wallIncludingDiagnosticReadbackMs: performance.now() - started,
      });
    return { transaction, words, floats, scratchWords, control, live, updates, settings };
  };
  try {
    const profile = {
      ...scgiProfile,
      resolution: 24,
      cascades: 2,
      patches: 8,
      requests: 512,
      bounceRequests: 8,
      updates: 2,
    };
    const state = await create(profile);
    const duplicates = Array.from({ length: 400 }, () => request([0.25, 0.25, 0.25]));
    let data = await step(state, 1, duplicates);
    check(
      data.live.length === 1 && data.control[11] === 1,
      "cross-workgroup duplicate claims allocate exactly once",
    );
    check(data.words[data.live[0].at + 24] === 0, "allocation does not fake real query samples");
    const generation = state.runtime.activeGeneration;
    await step(state, 2, [request([1.25, 0.25, 0.25])], { abort: true });
    check(state.runtime.activeGeneration === generation, "abort preserves active generation");
    data = await step(state, 2, [request([1.25, 0.25, 0.25])]);
    check(data.live.length === 2, "retry consumes request exactly once");
    data = await step(state, 3, [request([0.25, 0.25, 0.25], [0, 0, -1])]);
    check(data.live.length === 3, "opposing thin surface bins remain distinct");
    data = await step(state, 4, [request([0.25, 0.25, 0.75])]);
    check(data.control[6] === 1 && data.live.length === 3, "incompatible parallel plane explicitly rejected");
    check(
      data.scratchWords[state.plan.scratch.ranges.cacheRequestCells.offset / 4] === 0xffffffff,
      "rejected surface cannot resolve to an incompatible mapped patch",
    );
    results.push("R24 signed modulo, cross-workgroup claims, thin opposing/parallel surfaces, abort/retry");

    data = await step(
      state,
      5,
      Array.from({ length: 10 }, (_, i) => request([i - 5 + 0.25, 2.25, 0.25])),
    );
    check(
      data.live.length === 8 && data.control[5] === 5,
      "full pool defers without losing existing patches",
    );
    check(data.words[16] === data.words[17] && data.words[18] === 8, "full ring start=end is not empty");
    const beforeScroll = data.live.map((v) => v.position.join());
    data = await step(state, 6, [], { settings: { camera: [1, 0, 0] } });
    check(data.live.length === 8, "one-cell scroll preserves overlap");
    check(
      data.live.every((v) => beforeScroll.includes(v.position.join())),
      "scroll never relocates patch positions",
    );
    data = await step(state, 7, [], { settings: { camera: [100, 0, 0] } });
    check(
      data.live.length === 0 && data.words[16] === data.words[17] && data.words[18] === 0,
      "jump empties complete cascades",
    );
    data = await step(state, 8, [request([100.25, 0.25, 0.25])], { settings: { camera: [100, 0, 0] } });
    check(data.live.length === 1, "full pool recovers after scroll");
    results.push(
      "full/empty ring distinction, deferred capacity, overlap scroll/jump and next-frame recovery",
    );

    const eviction = await create({ ...profile, requests: 16 });
    data = await step(eviction, 1, [request([0.25, 0.25, 0.25])]);
    data = await step(eviction, 4, [], { settings: { evictionAge: 2 } });
    check(data.live.length === 1 && data.live[0].rank === 1, "aged visible demotes before eviction");
    check(
      data.words[data.live[0].at + 28] === 1 &&
        data.words[eviction.plan.world.ranges.cacheState.offset / 4 + data.live[0].slot * 4] === 4,
      "demotion age separated from true access",
    );
    data = await step(eviction, 5, [request([0.25, 0.25, 0.25])], { settings: { evictionAge: 2 } });
    check(data.live[0].rank === 0, "rank1 promotes on visible access");
    data = await step(eviction, 8, [], { settings: { evictionAge: 2 } });
    check(data.live[0].rank === 1, "second demotion");
    data = await step(eviction, 11, [], { settings: { evictionAge: 2 } });
    check(data.live.length === 0, "rank1 second age expires");
    results.push("rank promotion and two-age demotion/eviction with independent access/update ages");

    const bounce = await create({ ...profile, requests: 16 });
    data = await step(bounce, 1, [request([0.25, 0.25, 0.25])], {
      afterCache: ({ regions, world }) => {
        regions.push({
          destination: world.buffer,
          destinationOffset: world.plan.ranges.bounceRequests.offset,
          bytes: request([3.25, 0.25, 0.25], [0, 0, 1], 1),
        });
        regions.push({
          destination: world.buffer,
          destinationOffset: 80,
          bytes: new Uint8Array(new Uint32Array([1]).buffer),
        });
      },
    });
    check(data.live.length === 1, "candidate bounce queue is not consumed recursively");
    data = await step(bounce, 2);
    check(
      data.live.length === 2 && data.live.some((v) => v.rank === 1),
      "previous generation bounce demand allocated rank1",
    );
    results.push("bounce requests consumed only from previous committed generation");

    const priority = await create({ ...profile, patches: 2, requests: 16, updates: 1 });
    data = await step(priority, 1, [
      request([0.25, 0.25, 0.25], [0, 0, 1], 1),
      request([1.25, 0.25, 0.25]),
      request([2.25, 0.25, 0.25]),
    ]);
    check(
      data.live.length === 2 && data.live.every((v) => v.rank === 0),
      "rank0 new allocations precede rank1 under capacity pressure",
    );
    data = await step(priority, 3, [], { settings: { bounceEnabled: false, evictionAge: 1 } });
    check(data.live.length === 0, "bounce disabled permits direct eviction");
    results.push("rank0 allocation quota and direct eviction without bounce allocation");

    const defrag = await create({ ...profile, patches: 8, requests: 16 });
    const points = Array.from({ length: 4 }, (_, i) => [i + 0.25, 0.25, 0.25]);
    data = await step(
      defrag,
      1,
      points.map((v) => request(v)),
    );
    const sourceSlot = data.live[3].slot;
    const sourceCell = data.live[3].cell;
    const destinationGeneration = data.words[data.live[0].at + 23];
    data = await step(defrag, 5, [request(data.live[3].position)], {
      settings: { evictionAge: 2, moveBudget: 1 },
      write: ({ regions, world, scratch }) => {
        for (let slot = 0; slot < 4; slot++) {
          const at = world.plan.ranges.patches.offset + slot * 288;
          regions.push({
            destination: world.buffer,
            destinationOffset: at + 112,
            bytes: new Uint8Array(new Uint32Array([slot === 0 ? 1 : 4, 2, 1, 1]).buffer),
          });
          regions.push({
            destination: world.buffer,
            destinationOffset: at + 272,
            bytes: new Uint8Array(new Uint32Array([slot === 0 ? 1 : 0, 123, 456, 789]).buffer),
          });
        }
        for (let slot = 0; slot < 4; slot++) {
          regions.push({
            destination: world.buffer,
            destinationOffset: world.plan.ranges.cacheState.offset + slot * 16,
            bytes: new Uint8Array(new Uint32Array([1, 1, 0, 1]).buffer),
          });
        }
        for (const offset of [160, 208])
          regions.push({
            destination: world.buffer,
            destinationOffset: world.plan.ranges.patches.offset + sourceSlot * 288 + offset,
            bytes: new Uint8Array(
              new Float32Array(Array.from({ length: 12 }, (_, i) => offset + i * 0.25)).buffer,
            ),
          });
        regions.push({
          destination: scratch.buffer,
          destinationOffset: scratch.plan.ranges.a1.offset + sourceSlot * 48,
          bytes: new Uint8Array(new Float32Array(12).fill(33.5).buffer),
        });
      },
    });
    const moved = data.live.find((v) => v.cell === sourceCell);
    check(data.live.length === 3 && moved.slot === 0, "bounded defrag moves high live slot into low hole");
    check(data.words[moved.at + 23] === destinationGeneration + 1, "defrag changes destination lifetime");
    for (const offset of [160, 208])
      for (let i = 0; i < 12; i++) {
        check(
          data.floats[moved.at + offset / 4 + i] === offset + i * 0.25,
          "defrag preserves all signed A0/A2 lanes",
        );
      }
    const a1 = defrag.plan.scratch.ranges.a1.offset / 4;
    check(
      data.scratchWords[a1] === new Uint32Array(new Float32Array([33.5]).buffer)[0],
      "defrag preserves A1 scratch",
    );
    check(data.words[moved.at + 29] === 2, "update scheduling never fabricates estimator update age");
    check(
      data.words[moved.at + 69] === 123 &&
        data.words[moved.at + 70] === 456 &&
        data.words[moved.at + 71] === 789,
      "cache-private state never aliases post/cohort/status",
    );
    const requestCell = data.scratchWords[defrag.plan.scratch.ranges.cacheRequestCells.offset / 4];
    check(
      requestCell === moved.cell &&
        data.words[defrag.plan.world.ranges.map.offset / 4 + requestCell * 2] === moved.slot,
      "request remains resolvable after defrag through semantic cell",
    );
    results.push("bounded defrag snapshot/copy/remap preserves A0/A1/A2, stats, generation and bijection");

    // Hole-to-live chains are resolved by moving into disjoint free destinations;
    // already dense pools (including would-be swap cycles) perform no moves.
    const fragmented = await create({ ...profile, patches: 8, requests: 16 });
    data = await step(
      fragmented,
      1,
      Array.from({ length: 8 }, (_, i) => request([i + 0.25, 0.25, 0.25])),
    );
    data = await step(fragmented, 5, [], {
      settings: { moveBudget: 1, evictionAge: 2, bounceEnabled: false },
      write: ({ regions, world }) => {
        for (const slot of [1, 3, 5, 7]) {
          regions.push({
            destination: world.buffer,
            destinationOffset: world.plan.ranges.patches.offset + slot * 288 + 112,
            bytes: new Uint8Array(new Uint32Array([4]).buffer),
          });
          regions.push({
            destination: world.buffer,
            destinationOffset: world.plan.ranges.cacheState.offset + slot * 16,
            bytes: new Uint8Array(new Uint32Array([4]).buffer),
          });
        }
      },
    });
    check(
      data.live.length === 4 && data.control[8] === 2,
      "partial budget retains remaining fragmented live sources",
    );
    data = await step(fragmented, 6, [], { settings: { moveBudget: 1 } });
    check(
      data.live.every((v) => v.slot < 4),
      "next bounded frame closes remaining move chain",
    );
    data = await step(fragmented, 7, [], { settings: { moveBudget: 8 } });
    check(data.control[8] === 0, "dense pool never creates in-place move cycles");
    results.push("partial defrag chain completes across frames; cycle-producing destinations excluded");

    const fair = await create({ ...profile, requests: 16, updates: 1 });
    const visited = new Set();
    for (let frame = 1; frame <= 12; frame++) {
      data = await step(
        fair,
        frame,
        points.map((v) => request(v)),
        { settings: { updateAge: 1 } },
      );
      for (const slot of data.updates) visited.add(slot);
    }
    check(visited.size === 4, "U=1 scheduler actually visits every stable dirty patch");
    const dirty = Array.from({ length: 33 }, () => ({ min: [100, 100, 100], max: [101, 101, 101] }));
    data = await step(fair, 13, [], {
      settings: { dirtyRegions: dirty },
      write: ({ regions, world }) => {
        for (let slot = 0; slot < 4; slot++)
          regions.push({
            destination: world.buffer,
            destinationOffset: world.plan.ranges.cacheState.offset + slot * 16 + 4,
            bytes: new Uint8Array(new Uint32Array([0]).buffer),
          });
      },
    });
    check(
      data.live.every((v) => data.words[fair.plan.world.ranges.cacheState.offset / 4 + v.slot * 4 + 1] === 1),
      "dirty overflow conservatively invalidates complete cache domain",
    );
    await step(fair, 0xfffffffd, []);
    let boundaryRejected = false;
    try {
      await step(fair, 0xfffffffe, []);
    } catch (error) {
      boundaryRejected = /serial|frame/.test(error.message);
    }
    check(boundaryRejected, "frame wrap rejected before ABA");
    results.push("U=1 real update fairness, dirty overflow escalation and u32 frame boundary rejection");

    const epochs = await create({ ...profile, requests: 16 });
    data = await step(epochs, 1, [request([0.25, 0.25, 0.25])]);
    data = await step(epochs, 2, [], { settings: { originEpoch: 2 } });
    check(data.live.length === 0, "origin rebase rejects stale world addresses");
    data = await step(epochs, 3, [request([0.25, 0.25, 0.25])], { settings: { originEpoch: 2 } });
    data = await step(epochs, 4, [], { settings: { originEpoch: 2, voxelSize: 2 } });
    check(data.live.length === 0, "voxel size changes reject stale geometry even at same storage address");
    epochs.runtime.disable();
    epochs.plan = await epochs.runtime.configure(demand, epochs.profile);
    epochs.cache = await ScgiCache.create(device, epochs.plan);
    data = await step(epochs, 1, [request([0.25, 0.25, 0.25])]);
    check(data.live.length === 1, "fresh world restarts frame serial without ABA");
    results.push("origin/voxel change invalidation and disable/re-enable fresh world serial");

    const hierarchy = await create({
      ...profile,
      resolution: 24,
      patches: 257,
      requests: 16385,
      bounceRequests: 1,
      updates: 4,
    });
    data = await step(
      hierarchy,
      1,
      Array.from({ length: 16385 }, () => request([-0.25, -0.25, -0.25])),
    );
    check(data.live.length === 1 && data.control[11] === 1, "three-level scan and partial last workgroup");
    results.push("16385 competing requests exercise three-level portable scan and partial workgroups");

    const gpuProducer = await create({ ...profile, requests: 16 });
    const payload = request([0.25, 0.25, 0.25]);
    const payloadWords = new Uint32Array(payload.buffer);
    const module = device.createShaderModule({
      code: `
      @group(0) @binding(0) var<storage, read_write> world: array<atomic<u32>>;
      @group(0) @binding(1) var<storage, read_write> scratch: array<atomic<u32>>;
      ${scgiCacheRequestWgsl(gpuProducer.plan)}
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) id: vec3u) {
        let record = array<u32, 24>(${[...payloadWords].map((v) => `${v}u`).join(",")});
        let accepted = scgi_append_receiver_request(record);
      }
    `,
    });
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    data = await step(gpuProducer, 1, [], {
      producer: ({ command, world, scratch }) => {
        const group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 1, resource: { buffer: scratch.buffer } }],
        });
        const pass = command.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(1);
        pass.end();
      },
    });
    check(
      data.live.length === 1 && data.control[0] === 16 && data.control[7] === 48,
      "real GPU request producer safely overflows bounded queue",
    );
    results.push(
      "production request writer GPU→claim→allocation and observable overflow without readback control",
    );

    const bounceModule = device.createShaderModule({
      code: `
      @group(0) @binding(0) var<storage, read_write> world: array<atomic<u32>>;
      @group(0) @binding(1) var<storage, read_write> scratch: array<atomic<u32>>;
      ${scgiCacheRequestWgsl(gpuProducer.plan)}
      @compute @workgroup_size(64)
      fn main() {
        var record = array<u32, 24>(${[...payloadWords].map((v) => `${v}u`).join(",")});
        record[0] = bitcast<u32>(3.25);
        let accepted = scgi_append_bounce_request(record, 0u);
      }
    `,
    });
    const bouncePipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: bounceModule, entryPoint: "main" },
    });
    data = await step(gpuProducer, 2, [], {
      afterGpu: ({ command, world }) => {
        const group = device.createBindGroup({
          layout: bouncePipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: world.buffer } }],
        });
        const pass = command.beginComputePass();
        pass.setPipeline(bouncePipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(1);
        pass.end();
      },
    });
    check(
      data.words[20] === profile.bounceRequests && data.words[21] === 64 - profile.bounceRequests,
      "rank0 scheduled GPU consumer produces bounded next-generation bounce queue",
    );
    data = await step(gpuProducer, 3);
    check(
      data.live.length === 2 && data.live.some((v) => v.rank === 1),
      "GPU-produced duplicate bounce requests deduplicate in next transaction",
    );
    results.push("scheduled rank0 GPU consumer→bounded bounce queue→next-generation dedup allocation");

    const fault = await create({ ...profile, requests: 16, patches: 1, updates: 1 });
    data = await step(fault, 1, [request([0.25, 0.25, 0.25])], {
      allowFault: true,
      write: ({ regions, world }) =>
        regions.push({
          destination: world.buffer,
          destinationOffset: world.plan.ranges.patches.offset + 92,
          bytes: new Uint8Array(new Uint32Array([0xfffffffe]).buffer),
        }),
    });
    check(
      data.live.length === 0 && data.control[9] === 1 && data.words[15] === 1,
      "exhausted slot generation faults complete cache instead of aliasing lifetime",
    );
    data = await step(fault, 2, [], { allowFault: true });
    check(data.words[15] === 1, "fault remains sticky until fresh world epoch");
    results.push("slot-generation exhaustion rejects ABA and poisons subsequent cache publications");

    const scale = await create({
      ...profile,
      resolution: 32,
      cascades: 4,
      patches: 65536,
      requests: 8192,
      bounceRequests: 8192,
      updates: 4096,
    });
    const grid = Array.from({ length: 1728 }, (_, i) =>
      request([(i % 12) - 6 + 0.25, (Math.floor(i / 12) % 12) - 6 + 0.25, Math.floor(i / 144) - 6 + 0.25]),
    );
    data = await step(scale, 1, grid, { measure: true });
    check(
      data.live.length === grid.length && data.updates.length === grid.length,
      "R32/C4/64K real allocation and update counts",
    );
    data = await step(scale, 2, [], { measure: true, settings: { moveBudget: 64 } });
    check(data.live.length === grid.length, "production-size arenas preserve next-frame publication");
    results.push("R32/C4/65536-patch actual GPU capacity, commands and coarse wall-cost observation");

    return {
      passed: true,
      results,
      submittedCacheFrames: submitted,
      costs,
      scope: "SCGI-3 cache infrastructure, production GI disabled; no radiance/image or performance claim",
    };
  } finally {
    for (const runtime of runtimes) runtime.destroy();
    await device.queue.onSubmittedWorkDone();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    graphics.buffer_allocator_main.destroy();
    graphics.buffer_allocator_staging.destroy();
  }
}
