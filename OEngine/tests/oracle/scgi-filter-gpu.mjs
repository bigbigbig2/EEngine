import assert from "node:assert/strict";
import { ScgiRuntime } from "../../.test-dist/render/gi/ScgiRuntime.js";
import { ScgiCache } from "../../.test-dist/render/gi/ScgiCache.js";
import { ScgiFilter } from "../../.test-dist/render/gi/ScgiFilter.js";
import { ScgiInvalidation } from "../../.test-dist/render/gi/ScgiInvalidation.js";
import { GpuScene } from "../../.test-dist/gpu/GpuScene.js";
import { GeometryQueryInstanceSnapshot } from "../../.test-dist/gpu/GeometryQueryInstanceSnapshot.js";
import { packScgiRecord, unpackScgiIrradiance } from "../../.test-dist/render/gi/ScgiAbi.js";
import { scgiGraphics, scgiCommand, scgiProfile } from "./scgi-fixture.mjs";

export const filterSettings = {
  geometryEpoch: 1,
  filterEpoch: 1,
  spatial: false,
  post: false,
  spatialTaps: 16,
  lookupTaps: 8,
  spatialRadius: 1.5,
  lookupRadius: 0.5,
  normalCosine: 0.95,
  planeDistanceScale: 0.02,
  shortHysteresis: 0.5,
  longHysteresis: 0.98,
  postHysteresis: 0.8,
  driftScale: 0.25,
  maximumCount: 8,
  maximumAge: 8,
  invalidDecay: 0.5,
  revisionDecay: 0.25
};
const cacheSettings = {
  originEpoch: 1,
  camera: [0, 0, 0],
  voxelSize: 1,
  bounceEnabled: true,
  evictionAge: 1000,
  moveBudget: 0,
  normalCosine: 0.95,
  planeDistanceScale: 0.02,
  updateAge: 2,
  varianceThreshold: 1
};
const identity = new Uint32Array(16).fill(7);
const coeff = (v) => [v, 2 * v, 4 * v, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const request = (position, normal = [0, 0, 1], id = identity) =>
  packScgiRecord("request", {
    positionRadius: [...position, 0],
    normal,
    source: 0,
    identity: id.slice(0, 12),
    cellRankPixelStatus: [0, 0, 0, 0],
    identityTail: id.slice(12)
  });

/** Isolated real cache/filter owners. Raw cohorts are explicit estimator inputs,
 * not a replacement transport implementation. An additional oracle exercises
 * the real estimator->filter chain. CPU expected values use closed form means. */
export async function runScgiFilterGpuOracle(device) {
  const graphics = scgiGraphics(device),
    runtime = new ScgiRuntime(device, 1);
  const profile = {
    ...scgiProfile,
    width: 7,
    height: 5,
    resolution: 8,
    cascades: 2,
    patches: 16,
    updates: 16,
    requests: 16
  };
  const plan = await runtime.configure({ enabled: true, hasGeometry: true, hasLitMaterials: true }, profile);
  const cache = await ScgiCache.create(device, plan),
    filter = await ScgiFilter.create(device, plan);
  const patchBase = plan.world.ranges.patches.offset / 4,
    stateBase = plan.world.ranges.cacheState.offset / 4;
  let frame = 0,
    scene = 1,
    pending;
  const timers = [];
  const invalidator = await ScgiInvalidation.create(device, 80);
  const sceneOwner = new GpuScene(device, { publicationIdentity: () => ({ slot: 1, generation: 1 }) });
  const snapshots = [];
  const run = async ({
    value = coeff(1),
    valid = true,
    spatial = false,
    post = false,
    abort = false,
    positions = [[0.1, 0.1, 0]],
    normals,
    identities,
    dirtyRegions,
    epoch = 1,
    geometryEpoch = 1,
    filterEpoch = 1,
    radius = 1.5,
    lookupTaps = 8,
    missing = 0,
    camera = [0, 0, 0],
    before,
    after,
    rawBySlot,
    moveBudget = 0,
    evictionAge = 1000,
    bounceEnabled = true,
    frameStep = 1,
    measure = false
  } = {}) => {
    const command = scgiCommand(graphics);
    pending = command;
    const tx = runtime.prepare(command, { scene, view: 1 });
    runtime.encode(tx);
    const requests = positions.map((p, i) =>
      request(p, normals?.[i] ?? [0, 0, 1], identities?.[i] ?? identity)
    );
    const all = new Uint8Array(requests.length * 112);
    requests.forEach((r, i) => all.set(r, i * 112));
    command.uploadRegions([
      {
        destination: tx.publication.privateScratch.buffer,
        destinationOffset: plan.scratch.ranges.requests.offset,
        bytes: all
      },
      {
        destination: tx.publication.privateScratch.buffer,
        destinationOffset: plan.scratch.ranges.cacheControl.offset,
        bytes: new Uint8Array(new Uint32Array([requests.length]).buffer)
      }
    ]);
    const nextFrame = frame + frameStep;
    cache.encode(tx, {
      ...cacheSettings,
      frame: nextFrame,
      camera,
      dirtyRegions,
      moveBudget,
      evictionAge,
      bounceEnabled
    });
    const header = new Uint32Array([epoch, 1, 1, 0]);
    command.uploadRegions([
      {
        destination: tx.publication.candidateWorld.buffer,
        destinationOffset: 16,
        bytes: new Uint8Array(header.buffer)
      }
    ]);
    const data = new ArrayBuffer(profile.updates * 64),
      f = new Float32Array(data),
      u = new Uint32Array(data);
    // GPU update list can reorder. A tiny test input producer maps raw values to
    // selected slot; production filtering still consumes the unchanged raw ABI.
    for (let i = 0; i < profile.updates; i++) {
      f.set(value, i * 16);
      u.set([8, 8, Number(valid), valid ? 0 : 4], i * 16 + 12);
    }
    command.uploadRegions([
      {
        destination: tx.publication.privateScratch.buffer,
        destinationOffset: plan.scratch.ranges.raw.offset,
        bytes: new Uint8Array(data)
      }
    ]);
    const anchors = new ArrayBuffer(plan.halfPixels * 128),
      af = new Float32Array(anchors),
      au = new Uint32Array(anchors);
    for (let i = 0; i < plan.halfPixels; i++) {
      af.set([...positions[0], i === plan.halfPixels - 1 ? 0 : 1], i * 32);
      af.set(normals?.[0] ?? [0, 0, 1], i * 32 + 4);
      au[i * 32 + 7] = Math.floor(i / plan.halfWidth) * 2 * profile.width + (i % plan.halfWidth) * 2;
      af[i * 32 + 15] = 2;
      au.set(identities?.[0] ?? identity, i * 32 + 16);
    }
    command.uploadRegions([
      { destination: tx.publication.anchors[0].buffer, destinationOffset: 0, bytes: new Uint8Array(anchors) }
    ]);
    if (rawBySlot) {
      const module = device.createShaderModule({
        code: `
@group(0) @binding(0) var<storage,read_write> scratch:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
 if(id.x>=scratch[${plan.scratch.ranges.cacheControl.offset / 4 + 28}u]) {return;}
 let slot=scratch[${plan.scratch.ranges.updateList.offset / 4}u+id.x];
 let v=select(1.0,8.0,slot==1u);
 for(var c=0u;c<3u;c++) {scratch[${plan.scratch.ranges.raw.offset / 4}u+id.x*16u+c]=bitcast<u32>(v);}
}`
      });
      const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "main" }
      });
      const pass = command.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: tx.publication.privateScratch.buffer } }]
        })
      );
      pass.dispatchWorkgroups(1);
      pass.end();
    }
    if (missing)
      for (let slot = 0; slot < profile.patches; slot++)
        command.uploadRegions([
          {
            destination: tx.publication.candidateWorld.buffer,
            destinationOffset: plan.world.ranges.patches.offset + slot * 304 + 284,
            bytes: new Uint8Array(new Uint32Array([missing]).buffer)
          }
        ]);
    before?.(tx);
    tx.publication.estimateComplete = true;
    let timing, resolve;
    if (measure && device.features.has("timestamp-query")) {
      timing = device.createQuerySet({ type: "timestamp", count: 2 });
      resolve = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
      });
      const pass = command.gpu_encoder.beginComputePass({
        timestampWrites: { querySet: timing, beginningOfPassWriteIndex: 0 }
      });
      pass.end();
    }
    filter.encode(tx, {
      ...filterSettings,
      frame: nextFrame,
      spatial,
      post,
      geometryEpoch,
      filterEpoch,
      lookupTaps,
      spatialRadius: radius
    });
    after?.(tx);
    if (timing) {
      const pass = command.gpu_encoder.beginComputePass({
        timestampWrites: { querySet: timing, endOfPassWriteIndex: 1 }
      });
      pass.end();
      command.gpu_encoder.resolveQuerySet(timing, 0, 2, resolve, 0);
    }
    const total = plan.world.bytes + plan.scratch.bytes + plan.screenRoleBytes;
    const read = device.createBuffer({
      size: total + 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    command.copyBufferToBuffer(tx.publication.candidateWorld.buffer, 0, read, 0, plan.world.bytes);
    command.copyBufferToBuffer(
      tx.publication.privateScratch.buffer,
      0,
      read,
      plan.world.bytes,
      plan.scratch.bytes
    );
    command.copyBufferToBuffer(
      tx.publication.candidateWorldField.segments[0].buffer,
      0,
      read,
      plan.world.bytes + plan.scratch.bytes,
      plan.screenRoleBytes
    );
    if (resolve) command.copyBufferToBuffer(resolve, 0, read, total, 16);
    try {
      if (abort) {
        const serial = runtime.sampleSerial;
        command.abort(new Error("filter abort retry"));
        await command.gpuDone.catch(() => {});
        assert.equal(runtime.sampleSerial, serial);
        return;
      }
      command.finish();
      await command.gpuDone;
      frame = nextFrame;
      pending = null;
      await read.mapAsync(GPUMapMode.READ);
      const bytes = read.getMappedRange().slice(0);
      read.unmap();
      if (timing) {
        const t = new BigUint64Array(bytes, total, 2);
        timers.push(Number(t[1] - t[0]) / 1e6);
      }
      const world = new Uint32Array(bytes, 0, plan.world.bytes / 4),
        wf = new Float32Array(bytes, 0, plan.world.bytes / 4);
      const patches = [];
      for (let slot = 0; slot < profile.patches; slot++)
        if (world[stateBase + slot * 4 + 3]) {
          const at = patchBase + slot * 76;
          patches.push({
            slot,
            at,
            count: world[at + 24],
            confidence: wf[at + 35],
            a0: Array.from(wf.slice(at + 40, at + 52)),
            a2: Array.from(wf.slice(at + 52, at + 64)),
            post: world[at + 69]
          });
        }
      return {
        world,
        wf,
        bytes,
        patches,
        field: new Uint32Array(bytes, plan.world.bytes + plan.scratch.bytes, plan.screenRoleBytes / 4),
        fault: world[15]
      };
    } finally {
      read.destroy();
      timing?.destroy();
      resolve?.destroy();
    }
  };
  try {
    const combinations = [];
    for (const spatial of [false, true])
      for (const post of [false, true]) {
        scene++;
        const first = await run({ spatial, post, measure: true });
        assert.equal(first.fault, 0);
        assert.equal(first.patches[0].count, 1);
        for (let i = 0; i < 12; i++) assert.ok(Math.abs(first.patches[0].a0[i] - coeff(1)[i]) < 1e-6);
        let settled = first;
        for (let i = 0; i < 8; i++) settled = await run({ spatial, post });
        assert.equal(settled.patches[0].count, 8);
        assert.equal(settled.patches[0].post, post ? 2 : 0);
        const decoded = unpackScgiIrradiance(
          settled.field.slice(0, 8),
          2 ** (((settled.field[11] >>> 2) & 255) - 126)
        );
        assert.ok(Math.abs(decoded[0] - 1) < 0.002 && Math.abs(decoded[2] - 4) < 0.004);
        for (let i = (plan.halfPixels - 1) * 28; i < plan.halfPixels * 28; i++)
          assert.equal(settled.field[i], 0, "background full write");
        const failed = await run({ spatial, post, valid: false });
        assert.equal(failed.patches[0].count, 8);
        assert.equal(failed.patches[0].a0[0], 1);
        assert.ok(failed.patches[0].confidence < settled.patches[0].confidence);
        const before = runtime.sampleSerial;
        await run({ spatial, post, abort: true, value: coeff(99) });
        assert.equal(runtime.sampleSerial, before);
        const retry = await run({ spatial, post });
        assert.equal(retry.patches[0].a0[0], 1);
        let step;
        for (let i = 0; i < 24; i++) step = await run({ spatial, post, value: coeff(0), epoch: 2 });
        assert.ok(
          step.patches[0].a0[0] < 0.001 && step.patches[0].a2[0] < 0.01,
          "off step response settles without stale light"
        );
        assert.equal(step.patches[0].count, 8, "epoch changes preserve real saturated count");
        combinations.push({ spatial, post, count: step.patches[0].count, end: step.patches[0].a2[0] });
      }
    scene++;
    const hdr = await run({ value: coeff(1e30), post: true });
    assert.equal(hdr.fault, 0);
    assert.ok(Number.isFinite(hdr.wf[58]) && hdr.wf[58] > 1);
    const hdrDecode = unpackScgiIrradiance(hdr.field.slice(0, 8), hdr.wf[58]);
    assert.ok(Math.abs(hdrDecode[0] / 1e30 - 1) < 0.002, "HDR scale independent of exposure");
    scene++;
    const noSupport = await run({ missing: 8 });
    assert.equal(noSupport.patches[0].confidence, 0);
    assert.equal(noSupport.field[11] & 1, 0);
    scene++;
    const thin = await run({
      positions: [
        [0.1, 0.1, 0],
        [1.1, 0.1, 0.1]
      ],
      spatial: true,
      post: true,
      rawBySlot: true
    });
    assert.equal(thin.fault, 0);
    assert.equal(thin.patches[0].a2[0], 1, "parallel displaced thin surface rejected");
    scene++;
    const otherIdentity = new Uint32Array(identity);
    otherIdentity[2]++;
    const separate = await run({
      positions: [
        [0.1, 0.1, 0],
        [1.1, 0.1, 0]
      ],
      identities: [identity, otherIdentity],
      spatial: true,
      rawBySlot: true
    });
    assert.equal(separate.patches[0].a2[0], 1, "same-facing different instance rejected");
    scene++;
    let mixed;
    for (let i = 0; i < 4; i++)
      mixed = await run({
        positions: [
          [0.1, 0.1, 0],
          [1.1, 0.1, 0]
        ],
        spatial: true,
        rawBySlot: true
      });
    assert.ok(
      mixed.patches[0].a2[0] > 1 && mixed.patches[0].a2[0] < 8,
      "spatial really consumes compatible neighbor"
    );
    scene++;
    const directional = coeff(1);
    directional[3] = 0.4;
    directional[9] = 0.8;
    const directionalField = await run({ value: directional });
    const decodedDirection = unpackScgiIrradiance(
      directionalField.field.slice(0, 8),
      directionalField.wf[58]
    );
    const evalSh = (n) =>
      decodedDirection[0] * 0.28209479177 +
      (decodedDirection[3] * n[0] + decodedDirection[9] * n[2]) * 0.4886025119;
    assert.ok(evalSh([0, 0, 1]) > evalSh([1, 0, 0]), "field retains normal-map evaluation directionality");
    const stats1 = await run({ value: coeff(3) });
    const mean = stats1.wf[stats1.patches[0].at + 32],
      relativeVariance = stats1.wf[stats1.patches[0].at + 36];
    assert.ok(
      Math.abs(mean - 2) < 1e-6 && Math.abs(relativeVariance - 0.25) < 1e-6,
      "independent weighted moment: mean2 variance1"
    );
    const localDirty = await run({
      value: coeff(3),
      dirtyRegions: [{ min: [0, 0, -0.1], max: [0.2, 0.2, 0.1] }]
    });
    assert.equal(localDirty.patches[0].count, 3, "dirty update remains a real cohort");
    scene++;
    const cascade = await run({
      positions: [
        [3.8, 0.1, 0],
        [4.1, 0.1, 0]
      ],
      spatial: true,
      post: true,
      value: coeff(2)
    });
    assert.equal(cascade.fault, 0);
    assert.ok(
      cascade.patches.length === 2 && cascade.patches.every((p) => p.a2[0] === 2),
      "cascade boundary constant"
    );
    const scroll = await run({
      positions: [
        [3.8, 0.1, 0],
        [4.1, 0.1, 0]
      ],
      camera: [1, 0, 0],
      spatial: true,
      post: true,
      value: coeff(2)
    });
    assert.equal(scroll.fault, 0);
    assert.ok(
      scroll.patches.every((p) => p.a2[0] === 2),
      "scroll preserves constant histories"
    );
    scene++;
    await run({ post: true, value: coeff(2) });
    const disabled = await run({ post: false, value: coeff(2) });
    assert.equal(disabled.patches[0].post, 0);
    const enabled = await run({ post: true, value: coeff(4) });
    assert.equal(enabled.patches[0].a0[0], enabled.patches[0].a2[0], "post reenable seeds current input");
    const radiusReset = await run({ post: true, spatial: true, radius: 2, value: coeff(8) });
    assert.equal(radiusReset.patches[0].a0[0], radiusReset.patches[0].a2[0]);
    // A valid seed is permitted at count0 but contributes no MC sample. The
    // next real cohort replaces it rather than averaging seed as observation.
    scene++;
    const seed = await run({
      valid: false,
      before: (tx) => {
        const values = new Float32Array(76);
        values[35] = 0.25;
        values[39] = 1;
        values.set(coeff(10), 40);
        values.set(coeff(10), 52);
        for (const [offset, count] of [
          [35, 1],
          [39, 1],
          [40, 12],
          [52, 12]
        ])
          tx.command.uploadRegions([
            {
              destination: tx.publication.candidateWorld.buffer,
              destinationOffset: (patchBase + offset) * 4,
              bytes: new Uint8Array(values.buffer, offset * 4, count * 4)
            }
          ]);
      }
    });
    assert.equal(seed.patches[0].count, 0);
    assert.equal(seed.patches[0].a0[0], 10);
    const real = await run({ value: coeff(1) });
    assert.equal(real.patches[0].count, 1);
    assert.equal(real.patches[0].a0[0], 1);
    scene++;
    const nearbyOnly = await run({ positions: [[0.95, 0.4, 0]], lookupTaps: 128, before: tx => {
      tx.command.uploadRegions([{ destination: tx.publication.anchors[0].buffer, destinationOffset: 0,
        bytes: new Uint8Array(new Float32Array([1.01]).buffer) }]);
    } });
    assert.equal(nearbyOnly.field[11] & 3, 3, `jitter supports field even without center patch ${JSON.stringify({fault:nearbyOnly.fault,patches:nearbyOnly.patches,header:Array.from(nearbyOnly.wf.slice(24,40))})}`);
    const remote = await run({ positions: [[0.95, 0.4, 0]], valid: false, geometryEpoch: 2 });
    assert.ok(remote.patches[0].confidence < nearbyOnly.patches[0].confidence,
      "global geometry revision decays receiver outside local bounds");
    assert.equal(remote.patches[0].count, nearbyOnly.patches[0].count);
    scene++;
    const boundary = await run({ positions: [[0.2, 0.2, 1e-7]], lookupTaps: 1, before: tx => {
      tx.command.uploadRegions([{ destination: tx.publication.anchors[0].buffer, destinationOffset: 8,
        bytes: new Uint8Array(new Float32Array([-1e-7]).buffer) }]);
    } });
    assert.equal(boundary.field[11] & 3, 3, "grid-plane rounding retains compatible support");
    scene++;
    const orientationBoundary = await run({ positions: [[0.2, 0.2, 0.1]], normals: [[1e-7, 0, 1]], lookupTaps: 1, before: tx => {
      tx.command.uploadRegions([{ destination: tx.publication.anchors[0].buffer, destinationOffset: 16,
        bytes: new Uint8Array(new Float32Array([-1e-7, 0, 1]).buffer) }]);
    } });
    assert.equal(orientationBoundary.field[11] & 3, 3, "octahedral bin rounding retains compatible support");
    scene++;
    const curved = await run({ positions: [[0.2, 0.2, 0.1]], lookupTaps: 1, before: tx => {
      tx.command.uploadRegions([
        { destination: tx.publication.anchors[0].buffer, destinationOffset: 0,
          bytes: new Uint8Array(new Float32Array([0.3, 0.2, 0.09]).buffer) },
        { destination: tx.publication.anchors[0].buffer, destinationOffset: 16,
          bytes: new Uint8Array(new Float32Array([0.1980198, 0, 0.980198]).buffer) }
      ]);
    } });
    assert.equal(curved.field[11] & 3, 3, "mean tangent plane supports a smooth curved surface chord");
    // Cache compaction moves the actual A2 history together with its identity;
    // the filter must consume it at the destination rather than its old slot.
    scene++;
    const locations = [
      [-2.1, 0.1, 0],
      [-0.9, 0.1, 0],
      [1.1, 0.1, 0],
      [2.1, 0.1, 0]
    ];
    const allocated = await run({ positions: locations, post: true, value: coeff(2) });
    const survivor = allocated.patches[3];
    const survivorPosition = Array.from(allocated.wf.slice(survivor.at, survivor.at + 3));
    const moved = await run({
      positions: [survivorPosition],
      post: true,
      value: coeff(2),
      moveBudget: 1,
      evictionAge: 1,
      bounceEnabled: false,
      frameStep: 3
    });
    assert.equal(moved.patches.length, 1);
    assert.ok(moved.patches[0].slot < survivor.slot, "actual cache defrags retained filter history");
    assert.equal(moved.patches[0].post, 2);
    assert.equal(moved.patches[0].a2[0], 2);
    assert.equal(moved.patches[0].count, survivor.count + 1);
    const reused = await run({ positions: [survivorPosition, [-2.1, 0.1, 0]], post: true, value: coeff(5) });
    assert.ok(
      reused.patches.some((p) => p.count === 1 && p.a2[0] === 5),
      "slot reuse resets A2 and count"
    );
    scene++;
    const invalidNumeric = await run({ value: [NaN, ...coeff(1).slice(1)] });
    assert.ok((invalidNumeric.fault & 0x100) !== 0);
    assert.equal(invalidNumeric.patches[0].count, 0);
    assert.ok(
      invalidNumeric.field.every((v) => v === 0),
      "nonfinite input faults, never valid black"
    );
    scene++;
    // Actual GpuScene mutation -> immutable snapshot -> GPU dirty product ->
    // cache scheduling/filter confidence. Observe bounds, deletion, abort and
    // overflow without a current-frame readback controlling production work.
    const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    let handle;
    const dirtyFrame = async ({ x = 0, count = 1, abort = false, remove = false, material = 1 } = {}) => {
      const command = scgiCommand(graphics);
      pending = command;
      const previousHandle = handle;
      if (handle) sceneOwner.release(handle, command);
      handle = null;
      if (!remove) {
        const transforms = new Float32Array(count * 16);
        for (let i = 0; i < count; i++) {
          transforms.set(transform, i * 16);
          transforms[i * 16 + 12] = x + i * 3;
        }
        handle = sceneOwner.instantiate(
          {
            count,
            geometryHandles: [{}],
            geometryIndices: new Uint32Array(count),
            materialHandles: new Uint32Array(count),
            currentTransforms: transforms,
            flags: new Uint32Array(count).fill(1),
            boundsSpheres: new Float32Array(count * 4).fill(1),
            boundsMin: new Float32Array(count * 3).fill(-0.5),
            boundsMax: new Float32Array(count * 3).fill(0.5)
          },
          command
        );
      }
      const snapshot = new GeometryQueryInstanceSnapshot(device, sceneOwner, undefined, command);
      snapshots.push(snapshot);
      snapshot.encode(command);
      const tx = runtime.prepare(command, { scene, view: 1 });
      runtime.encode(tx);
      const gpuDirty = invalidator.encode(tx, snapshot, material, 0.25);
      cache.encode(tx, { ...cacheSettings, frame: frame + 1, gpuDirty });
      const read = device.createBuffer({
        size: 1040,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      command.copyBufferToBuffer(gpuDirty, 0, read, 0, 1040);
      try {
        if (abort) {
          command.abort(new Error("dirty abort"));
          await command.gpuDone.catch(() => {});
          handle = previousHandle;
          pending = null;
          return;
        }
        command.finish();
        await command.gpuDone;
        pending = null;
        frame++;
        await read.mapAsync(GPUMapMode.READ);
        const bytes = read.getMappedRange().slice(0);
        read.unmap();
        return { u: new Uint32Array(bytes), f: new Float32Array(bytes) };
      } finally {
        read.destroy();
      }
    };
    const initialDirty = await dirtyFrame();
    assert.ok(initialDirty.u[0] > 0);
    await dirtyFrame({ x: 3, abort: true });
    // Abort leaves the last committed derived facts at x0; the retry's union
    // must still include both x0 and x3 (not the aborted candidate alone).
    const dirtyRetry = await dirtyFrame({ x: 3 });
    assert.ok(dirtyRetry.u[0] > 0);
    assert.equal(dirtyRetry.u[1], 0);
    assert.ok(dirtyRetry.f[4] <= -0.75 && dirtyRetry.f[8] >= 3.75, "old/new union plus influence guard");
    const removed = await dirtyFrame({ remove: true });
    assert.ok(removed.u[0] > 0, "removed geometry retains old bounds dirty");
    const overflow = await dirtyFrame({ count: 40 });
    assert.ok(overflow.u[0] > 32 && overflow.u[1] === 1, "overflow upgrades full dirty");
    const segmented = await checkSegmentedFilter(device);
    return {
      segmented,
      combinations,
      hdrScale: hdr.wf[58],
      hdr: Array.from(hdrDecode),
      cost: filter.estimateCost({ ...filterSettings, frame: 1 }),
      gpuMs: timers,
      dirty: {
        initial: initialDirty.u[0],
        retry: dirtyRetry.u[0],
        removed: removed.u[0],
        overflow: overflow.u[0],
        cost: invalidator.cost
      },
      scope: "actual filter/cache, explicit raw input; transport is independently covered by estimator oracle"
    };
  } catch (error) {
    if (pending && !pending.closed) pending.abort(error);
    throw error;
  } finally {
    await device.queue.onSubmittedWorkDone();
    invalidator.destroy();
    for (const snapshot of snapshots) snapshot.destroy();
    sceneOwner.destroy();
    runtime.destroy();
    graphics.buffer_allocator_main.destroy();
    graphics.buffer_allocator_staging.destroy();
  }
}

async function checkSegmentedFilter(device) {
  const limited = new Proxy(device, {
    get(target, key) {
      if (key === "limits")
        return new Proxy(target.limits, {
          get(limits, name) {
            return name === "maxStorageBufferBindingSize" ? 65536 : Reflect.get(limits, name, limits);
          }
        });
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const graphics = scgiGraphics(limited),
    runtime = new ScgiRuntime(limited, 1);
  const reads = [];
  let command;
  try {
    const plan = await runtime.configure(
      { enabled: true, hasGeometry: true, hasLitMaterials: true },
      { ...scgiProfile, width: 65, height: 65 }
    );
    assert.equal(plan.screen.length, 3);
    const cache = await ScgiCache.create(limited, plan),
      filter = await ScgiFilter.create(limited, plan);
    command = scgiCommand(graphics);
    const tx = runtime.prepare(command, { scene: 1, view: 1 });
    runtime.encode(tx);
    command.uploadRegions([
      {
        destination: tx.publication.privateScratch.buffer,
        destinationOffset: plan.scratch.ranges.requests.offset,
        bytes: request([0.1, 0.1, 0])
      },
      {
        destination: tx.publication.privateScratch.buffer,
        destinationOffset: plan.scratch.ranges.cacheControl.offset,
        bytes: new Uint8Array(new Uint32Array([1]).buffer)
      }
    ]);
    cache.encode(tx, { ...cacheSettings, frame: 1 });
    const raw = new ArrayBuffer(plan.profile.updates * 64),
      rf = new Float32Array(raw),
      ru = new Uint32Array(raw);
    for (let i = 0; i < plan.profile.updates; i++) {
      rf.set(coeff(2), i * 16);
      ru.set([8, 8, 1, 0], i * 16 + 12);
    }
    command.uploadRegions([
      {
        destination: tx.publication.privateScratch.buffer,
        destinationOffset: plan.scratch.ranges.raw.offset,
        bytes: new Uint8Array(raw)
      }
    ]);
    for (let segment = 0; segment < plan.anchors.length; segment++) {
      const count = plan.anchors[segment].ranges.anchors.count;
      const bytes = new ArrayBuffer(count * 128),
        f = new Float32Array(bytes),
        u = new Uint32Array(bytes);
      for (let i = 0; i < count; i++) {
        const pixel = segment * plan.pixelsPerSegment + i;
        f.set([0.1, 0.1, 0, pixel === plan.halfPixels - 1 ? 0 : 1], i * 32);
        f[i * 32 + 6] = 1;
        f[i * 32 + 15] = 2;
        u[i * 32 + 7] = Math.floor(pixel / plan.halfWidth) * 130 + (pixel % plan.halfWidth) * 2;
        u.set(identity, i * 32 + 16);
      }
      command.uploadRegions([
        {
          destination: tx.publication.anchors[segment].buffer,
          destinationOffset: 0,
          bytes: new Uint8Array(bytes)
        }
      ]);
    }
    tx.publication.estimateComplete = true;
    filter.encode(tx, { ...filterSettings, frame: 1, spatial: true, post: true });
    for (const segment of tx.publication.candidateWorldField.segments) {
      const buffer = device.createBuffer({
        size: segment.buffer.size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      reads.push(buffer);
      command.copyBufferToBuffer(segment.buffer, 0, buffer, 0, buffer.size);
    }
    command.finish();
    await command.gpuDone;
    let visited = 0;
    for (const buffer of reads) {
      await buffer.mapAsync(GPUMapMode.READ);
      const words = new Uint32Array(buffer.getMappedRange());
      for (let i = 0; i < words.length / 28; i++, visited++) {
        if (visited === plan.halfPixels - 1) {
          assert.ok(words.subarray(i * 28, (i + 1) * 28).every((v) => v === 0));
        } else {
          assert.equal(words[i * 28 + 11] & 3, 3, "complete field across physical segments");
          assert.equal(words[i * 28 + 10], Math.floor(visited / 33) * 130 + (visited % 33) * 2);
        }
      }
      buffer.unmap();
    }
    assert.equal(visited, 1089);
    return { segments: reads.length, halfPixels: visited };
  } catch (error) {
    if (command && !command.closed) command.abort(error);
    throw error;
  } finally {
    await device.queue.onSubmittedWorkDone();
    for (const buffer of reads) buffer.destroy();
    runtime.destroy();
    graphics.buffer_allocator_main.destroy();
    graphics.buffer_allocator_staging.destroy();
  }
}
