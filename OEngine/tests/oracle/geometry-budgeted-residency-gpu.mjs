import assert from "node:assert/strict";
import { GraphicsContext } from "../../.test-dist/gpu/GraphicsContext.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { streamingProductFixture } from "../helpers/geometry-product-fixture.mjs";
import { GeometryProductMultiRuntimeV1 } from "../../.test-dist/gpu/GeometryProductMultiRuntime.js";
import { GeometryProductBytePool } from "../../.test-dist/gpu/GeometryProductBytePool.js";
import { selectGeometryProductResidencyProfileV1 } from "../../.test-dist/gpu/GeometryProductResidencyProfile.js";
import { GeometryPageStreamingRuntimeV1 } from "../../.test-dist/gpu/GeometryPageStreamingRuntime.js";
import {
  GEOMETRY_PRODUCT_GPU_WGSL_V1,
  encodeGeometryProductGpuLocationV1
} from "../../.test-dist/gpu/GeometryProductGpuAbiV1.js";
import { HierarchicalWorkGenerator } from "../../.test-dist/render/HierarchicalWorkGenerator.js";
import { VirtualGeometryMeshletWorkCandidate } from "../../.test-dist/render/MeshletWorkCandidate.js";
import { ShadowGeometryWork } from "../../.test-dist/render/ShadowGeometryWork.js";
import { FrameInstanceTransforms } from "../../.test-dist/render/FrameInstanceTransforms.js";
import { PACKED_CAMERA_TYPE } from "../../.test-dist/shaders/packed_camera.js";
import { unpackGeometryPageDemandV1 } from "../../.test-dist/gpu/GeometryPageDemandAbiV1.js";
import {
  GPU_INSTANCE_ABI_VERSION,
  GPU_INSTANCE_FLAGS,
  packGpuInstanceRecord
} from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { GPU_GEOMETRY_ABI_VERSION } from "../../.test-dist/gpu/GpuGeometryAbi.js";
import { GPU_COUNTER_BYTE_SIZE } from "../../.test-dist/debug/GpuFrameCounters.js";
import { planScgiBvh } from "../../.test-dist/render/gi/ScgiBvhLayout.js";
import { ScgiBvhBuild } from "../../.test-dist/render/gi/ScgiBvhBuild.js";
import { ScgiQueryGeometry } from "../../.test-dist/render/gi/ScgiQueryGeometry.js";
import { GeometryQueryInstances } from "../../.test-dist/gpu/GeometryQueryInstances.js";
import { GeometryQueryInstanceSnapshot } from "../../.test-dist/gpu/GeometryQueryInstanceSnapshot.js";
import { ScgiQueryTraversal } from "../../.test-dist/render/gi/ScgiQueryTraversal.js";
import { ScgiQueryHitWork } from "../../.test-dist/render/gi/ScgiQueryHitWork.js";
import { GpuNativeMaterialPublication } from "../../.test-dist/gpu/GpuNativeMaterialPublication.js";
import { AppearanceProgramRegistry } from "../../.test-dist/gpu/AppearanceProgramRegistry.js";
import { AppearanceGraphBuilder } from "../../.test-dist/material/AppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { lowerNativeMaterial } from "../../.test-dist/shaders/native_material.js";
const MiB = 1024 * 1024;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

async function checkQueryHitWork(device, graphics) {
  const rayCount = 1027;
  const binCount = 257;
  const source = device.createBuffer({ size: binCount * 176,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const directory = device.createBuffer({ size: binCount * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const resultByteOffset = rayCount * 48;
  const batch = device.createBuffer({ size: resultByteOffset + rayCount * 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  let work;
  let read;
  try {
    const instances = new Uint32Array(binCount * 44);
    const routes = new Uint32Array(binCount * 4);
    for (let bin = 0; bin < binCount; bin++) {
      instances[bin * 44 + 1] = bin;
      routes.set([0, bin, 0, 1], bin * 4);
    }
    work = await ScgiQueryHitWork.create(device, source, directory, batch,
      rayCount, resultByteOffset, binCount);
    read = device.createBuffer({ size: work.buffer.size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    for (const allMiss of [false, true]) {
      const results = new Uint32Array(rayCount * 8);
      const expected = Array.from({ length: binCount }, () => []);
      for (let ray = 0; ray < rayCount; ray++) {
        const bin = (ray * 17) % binCount;
        const hit = !allMiss && ray % 7 !== 0 && ray % 11 !== 0;
        results[ray * 8 + 3] = hit ? 0 : ray % 7 === 0 ? 2 : 1;
        results[ray * 8 + 4] = bin;
        if (hit) expected[bin].push(ray);
      }
      const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      command.uploadRegions([
        { destination: source, destinationOffset: 0, bytes: new Uint8Array(instances.buffer) },
        { destination: directory, destinationOffset: 0, bytes: new Uint8Array(routes.buffer) },
        { destination: batch, destinationOffset: resultByteOffset, bytes: new Uint8Array(results.buffer) },
      ]);
      work.encode(command);
      command.copyBufferToBuffer(work.buffer, 0, read, 0, work.buffer.size);
      command.finish();
      await command.gpuDone;
      await read.mapAsync(GPUMapMode.READ);
      const actual = new Uint32Array(read.getMappedRange().slice(0));
      read.unmap();
      let begin = 0;
      for (let bin = 0; bin < binCount; bin++) {
        const count = expected[bin].length;
        assert.deepEqual([...actual.subarray(bin * 8, bin * 8 + 7)],
          [count, begin, count, 0, Math.ceil(count / 64), 1, 1]);
        const rays = [...actual.subarray(work.listWordOffset + begin, work.listWordOffset + begin + count)];
        assert.deepEqual(rays.sort((a, b) => a - b), expected[bin]);
        begin += count;
      }
    }
    return { rayCount, binCount, hierarchicalPrefix: true, allMissReset: true,
      bytes: work.buffer.size + work.indirect.size };
  } finally {
    await device.queue.onSubmittedWorkDone();
    work?.destroy();
    read?.destroy();
    source.destroy();
    directory.destroy();
    batch.destroy();
  }
}

async function checkBvhBuild(device, graphics) {
  const plan = planScgiBvh(device.limits, 513);
  const hierarchy = device.createBuffer({
    size: plan.hierarchy.bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  const scratch = device.createBuffer({
    size: plan.scratch.bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  const read = device.createBuffer({
    size: plan.hierarchy.bytes + plan.scratch.bytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const results = [];
  const canonical = new Map();
  try {
    for (const subgroup of device.features.has("subgroups") ? [false, true] : [false]) {
      const build = await ScgiBvhBuild.create(device, plan, subgroup, graphics.resource_accounting);
      try {
        for (const scenario of [0, 1, 2, 7, 129, 513, "refit", "deep-rescue", "extreme", "invalid"]) {
          const count = scenario === "deep-rescue" ? 129 : typeof scenario === "number" ? scenario : 513;
          const bounds = new Uint8Array(plan.primitiveCapacity * 32);
          const view = new DataView(bounds.buffer);
          for (let primitive = 0; primitive < count; primitive++) {
            // Repeated centroids, a degenerate axis, reverse input order and
            // non-power lengths independently exercise sort and topology.
            const x = (count - primitive) % 37;
            const y = primitive % 5;
            for (const [offset, value] of [[0, x], [4, y], [8, 0], [16, x + 0.25], [20, y + 0.5], [24, 0]]) {
              view.setFloat32(primitive * 32 + offset, value, true);
            }
            if (scenario === "refit") {
              view.setFloat32(primitive * 32, -x * 3, true);
              view.setFloat32(primitive * 32 + 16, -x * 3 + 0.75, true);
            } else if (scenario === "extreme") {
              view.setFloat32(primitive * 32, primitive % 2 === 0 ? -3e38 : 2e38, true);
              view.setFloat32(primitive * 32 + 16, primitive % 2 === 0 ? -2e38 : 3e38, true);
            } else if (scenario === "invalid" && primitive === 17) {
              view.setFloat32(primitive * 32, Number.NaN, true);
            }
          }
          const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
          command.uploadRegions([{ destination: scratch,
            destinationOffset: plan.scratch.ranges.primitiveBounds.offset, bytes: bounds }]);
          if (scenario === "deep-rescue") {
            // An independently constructed legal chain forces the >64 depth
            // rescue, without adding a test-only branch to production kernels.
            const chain = new Uint32Array(plan.hierarchy.bytes / 4);
            chain[0] = count;
            const links = plan.hierarchy.ranges.links.offset / 4;
            const nodes = plan.hierarchy.ranges.nodes.offset / 4;
            for (let index = 0; index < count * 2 - 1; index++) {
              chain[links + index * 2] = 0xffffffff;
              if (index >= count - 1) {
                chain[nodes + index * 16 + 3] = index - count + 1;
                chain[nodes + index * 16 + 7] = 1;
                chain[nodes + index * 16 + 11] = index - count + 1;
                chain[nodes + index * 16 + 15] = 1;
              }
            }
            for (let index = 0; index < count - 1; index++) {
              const left = count - 1 + index;
              const right = index === count - 2 ? count * 2 - 2 : index + 1;
              chain[nodes + index * 16 + 3] = left;
              chain[nodes + index * 16 + 11] = right;
              chain[links + left * 2] = index;
              chain[links + right * 2] = index;
            }
            command.uploadRegions([{ destination: hierarchy, destinationOffset: 0,
              bytes: new Uint8Array(chain.buffer) }]);
          }
          if (scenario === "refit" || scenario === "deep-rescue") {
            build.encodeRefit(command, hierarchy, scratch, count);
          } else {
            build.encode(command, hierarchy, scratch, count);
          }
          command.copyBufferToBuffer(hierarchy, 0, read, 0, plan.hierarchy.bytes);
          command.copyBufferToBuffer(scratch, 0, read, plan.hierarchy.bytes, plan.scratch.bytes);
          command.finish();
          await command.gpuDone;
          await read.mapAsync(GPUMapMode.READ);
          const bytes = read.getMappedRange().slice(0);
          read.unmap();
          const h = new Uint32Array(bytes, 0, plan.hierarchy.bytes / 4);
          const s = new Uint32Array(bytes, plan.hierarchy.bytes, plan.scratch.bytes / 4);
          const f = new Float32Array(bytes, 0, plan.hierarchy.bytes / 4);
          if (scenario === "invalid") {
            assert.ok(h[2] !== 0, "nonfinite primitive bounds must poison the hierarchy");
            results.push({ subgroup, scenario, fault: h[2] });
            continue;
          }
          assert.equal(s[plan.scratch.ranges.control.offset / 4], 0, "BVH build fault");
          const activeWords = count === 0 ? 0 : count * 2 - 1;
          // Unused arena capacity is deliberately untouched across builds.
          // Compare header and the complete active node/link write domains.
          const hierarchyWords = [...h.slice(0, 16),
            ...h.slice(plan.hierarchy.ranges.nodes.offset / 4,
              plan.hierarchy.ranges.nodes.offset / 4 + activeWords * 16),
            ...h.slice(plan.hierarchy.ranges.links.offset / 4,
              plan.hierarchy.ranges.links.offset / 4 + activeWords * 2)];
          if (!subgroup) {
            canonical.set(scenario, hierarchyWords);
          } else {
            const expected = canonical.get(scenario);
            assert.equal(hierarchyWords.length, expected.length);
            for (let index = 0; index < hierarchyWords.length; index++) {
              assert.equal(hierarchyWords[index], expected[index], `portable/subgroup hierarchy word ${index}`);
            }
          }
          const sorted = Array.from({ length: count }, (_, index) => {
            const at = plan.scratch.ranges.keysA.offset / 4 + index * 2;
            return [s[at], s[at + 1]];
          });
          if (scenario !== "refit" && scenario !== "deep-rescue") {
            const sceneLow = [Infinity, Infinity, Infinity];
            const sceneHigh = [-Infinity, -Infinity, -Infinity];
            for (let primitive = 0; primitive < count; primitive++) {
              for (let axis = 0; axis < 3; axis++) {
                sceneLow[axis] = Math.min(sceneLow[axis], view.getFloat32(primitive * 32 + axis * 4, true));
                sceneHigh[axis] = Math.max(sceneHigh[axis], view.getFloat32(primitive * 32 + 16 + axis * 4, true));
              }
            }
            const expected = Array.from({ length: count }, (_, primitive) => {
              let code = 0;
              for (let axis = 0; axis < 3; axis++) {
                const low = view.getFloat32(primitive * 32 + axis * 4, true);
                const high = view.getFloat32(primitive * 32 + 16 + axis * 4, true);
                const scale = Math.max(Math.abs(sceneLow[axis]), Math.abs(sceneHigh[axis]));
                const power = scale === 0 ? 1 : 2 ** (Math.floor(Math.log2(scale)) + 1);
                const sceneMin = Math.fround(sceneLow[axis] / power);
                const sceneMax = Math.fround(sceneHigh[axis] / power);
                const center = Math.fround(Math.fround(Math.fround(low / power) * 0.5) +
                  Math.fround(Math.fround(high / power) * 0.5));
                const extent = Math.fround(sceneMax - sceneMin);
                const numerator = Math.fround(center - sceneMin);
                const point = extent > 0 ? Math.fround(numerator / extent) : 0.5;
                const quantized = Math.trunc(Math.max(0, Math.min(1023, Math.fround(point * 1024))));
                // Independent bit interleave, without donor multiplication masks.
                for (let bit = 0; bit < 10; bit++) {
                  code |= ((quantized >> bit) & 1) << (bit * 3 + 2 - axis);
                }
              }
              return [code >>> 0, primitive];
            }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
            assert.deepEqual(sorted, expected, "GPU Morton/radix matches independent bit oracle");
          }
          if (scenario !== "deep-rescue") {
            assert.deepEqual(sorted.map((item) => item[1]).sort((a, b) => a - b),
              Array.from({ length: count }, (_, index) => index));
          }
          const visited = new Set();
          const leaves = [];
          let internalAreaSum = 0;
            const walk = (node, parent, escape = 0xffffffff) => {
            assert.ok(node < count * 2 - 1 && !visited.has(node), "topology must be an acyclic complete tree");
            visited.add(node);
            const link = plan.hierarchy.ranges.links.offset / 4 + node * 2;
            assert.equal(h[link], parent);
            assert.equal(h[link + 1], escape, "stackless escape matches independent DFS successor");
            const at = plan.hierarchy.ranges.nodes.offset / 4 + node * 16;
            if (node >= count - 1) {
              leaves.push(h[at + 3]);
              const primitive = h[at + 3];
              for (let axis = 0; axis < 3; axis++) {
                assert.equal(f[at + axis], view.getFloat32(primitive * 32 + axis * 4, true));
                assert.equal(f[at + 4 + axis], view.getFloat32(primitive * 32 + 16 + axis * 4, true));
              }
              return { low: [f[at], f[at + 1], f[at + 2]], high: [f[at + 4], f[at + 5], f[at + 6]] };
            }
            const left = walk(h[at + 3], node, h[at + 11]);
            const right = walk(h[at + 11], node, escape);
            for (let axis = 0; axis < 3; axis++) {
              assert.equal(f[at + axis], left.low[axis]);
              assert.equal(f[at + 4 + axis], left.high[axis]);
              assert.equal(f[at + 8 + axis], right.low[axis]);
              assert.equal(f[at + 12 + axis], right.high[axis]);
            }
            const bounds = { low: left.low.map((x, axis) => Math.min(x, right.low[axis])),
              high: left.high.map((x, axis) => Math.max(x, right.high[axis])) };
            const extent = bounds.high.map((x, axis) => x - bounds.low[axis]);
            internalAreaSum += 2 * (extent[0] * extent[1] + extent[0] * extent[2] + extent[1] * extent[2]);
            return bounds;
          };
          if (count > 0) {
            walk(0, 0xffffffff);
            assert.equal(visited.size, count * 2 - 1);
            assert.deepEqual(leaves.sort((a, b) => a - b), Array.from({ length: count }, (_, index) => index));
          }
          if (scenario === "deep-rescue") {
            const begin = plan.scratch.ranges.depths.offset / 4;
            assert.ok(Math.max(...s.slice(begin, begin + count * 2 - 1)) <= 64,
              "balanced rescue must replace the excessively deep chain");
          }
          if (count === 7) {
            // Independent exhaustive subset oracle for the entire seven-leaf
            // treelet. Constant leaf costs cancel; compare internal SAH only.
            const cost = new Float64Array(128);
            for (let mask = 1; mask < 128; mask++) {
              const low = [Infinity, Infinity, Infinity];
              const high = [-Infinity, -Infinity, -Infinity];
              let population = 0;
              for (let primitive = 0; primitive < count; primitive++) {
                if ((mask & (1 << primitive)) === 0) continue;
                population++;
                for (let axis = 0; axis < 3; axis++) {
                  low[axis] = Math.min(low[axis], view.getFloat32(primitive * 32 + axis * 4, true));
                  high[axis] = Math.max(high[axis], view.getFloat32(primitive * 32 + 16 + axis * 4, true));
                }
              }
              if (population === 1) continue;
              let best = Infinity;
              for (let left = 1; left < mask; left++) {
                if ((left & mask) === left) best = Math.min(best, cost[left] + cost[mask ^ left]);
              }
              const e = high.map((value, axis) => value - low[axis]);
              cost[mask] = best + 2 * (e[0] * e[1] + e[0] * e[2] + e[1] * e[2]);
            }
            assert.equal(internalAreaSum, cost[127], "seven-leaf SAH must match exhaustive partition optimum");
          }
          results.push({ subgroup, count, scenario, nodes: visited.size });
        }
      } finally {
        build.destroy();
      }
    }
    return results;
  } finally {
    await device.queue.onSubmittedWorkDone();
    hierarchy.destroy();
    scratch.destroy();
    read.destroy();
  }
}

async function checkQueryPageSnapshot(device, graphics) {
  const fixture = await streamingProductFixture(2);
  const options = { configuredCapacityBytes: 2 * MiB, initialBankBytes: 1024, maxPageLeases: 8 };
  const runtime = new GeometryProductMultiRuntimeV1(device, {
    descriptors: [fixture.descriptor],
    residency: options,
  });
  const pool = GeometryProductBytePool.retain(
    device,
    selectGeometryProductResidencyProfileV1(device.limits, options),
  );
  const read = device.createBuffer({
    size: 176,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  let snapshot;
  try {
    const { residency } = await runtime.load(fixture.source);
    const page = await fixture.source.readPage(1);
    residency.stagePage(page);
    const publish = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    residency.preparePublication(publish, [1]);
    const candidateSnapshot = residency.retainQueryPages([1], publish);
    const candidateLocation = candidateSnapshot.pages[0].location;
    publish.copyBufferToBuffer(
      candidateSnapshot.banks[candidateLocation.bankIndex],
      candidateLocation.byteOffset,
      read,
      0,
      176,
    );
    publish.finish();
    await publish.gpuDone;
    await read.mapAsync(GPUMapMode.READ);
    assert.deepEqual(new Uint8Array(read.getMappedRange().slice(0)), new Uint8Array(page.bytes, 0, 176));
    read.unmap();
    candidateSnapshot.release();
    snapshot = residency.retainQueryPages([1]);
    const original = snapshot.pages[0].location;
    const epoch = snapshot.bindingEpoch;
    residency.beginRetirePage(1);
    const revoke = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    residency.preparePublication(revoke, []);
    revoke.finish();
    await revoke.gpuDone;
    assert.equal(residency.pageLocation(1), undefined);
    assert.equal(residency.evidence().retiringPages, 1);
    assert.equal(residency.tryStagePage(page), false);
    pool.requestGrowth(2048);
    const abortedGrowth = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    GeometryProductBytePool.prepareDeviceFrame(device, abortedGrowth);
    const discardedSnapshot = residency.retainQueryPages([0], abortedGrowth);
    abortedGrowth.abort(new Error("Query candidate growth aborted"));
    assert.equal(discardedSnapshot.valid, false);
    const growth = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    GeometryProductBytePool.prepareDeviceFrame(device, growth);
    const grownSnapshot = residency.retainQueryPages([0], growth);
    growth.finish();
    await growth.gpuDone;
    assert.equal(grownSnapshot.valid, true);
    grownSnapshot.release();
    assert.notEqual(pool.bindingEpoch, epoch);
    const consume = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    consume.copyBufferToBuffer(snapshot.banks[original.bankIndex], original.byteOffset, read, 0, 176);
    consume.finish();
    await consume.gpuDone;
    await read.mapAsync(GPUMapMode.READ);
    const actual = new Uint8Array(read.getMappedRange().slice(0));
    read.unmap();
    assert.deepEqual(actual, new Uint8Array(page.bytes, 0, 176));
    snapshot.release();
    assert.equal(snapshot.valid, false);
    assert.equal(residency.evidence().retiringPages, 0);
    assert.equal(residency.tryStagePage(page), true);
    snapshot = residency.retainQueryPages([0]);
    const rootPage = await fixture.source.readPage(0);
    runtime.destroy();
    const afterDestroy = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    const root = snapshot.pages[0].location;
    afterDestroy.copyBufferToBuffer(snapshot.banks[root.bankIndex], root.byteOffset, read, 0, 176);
    afterDestroy.finish();
    await afterDestroy.gpuDone;
    await read.mapAsync(GPUMapMode.READ);
    const retainedRoot = new Uint8Array(read.getMappedRange().slice(0));
    read.unmap();
    assert.deepEqual(retainedRoot, new Uint8Array(rootPage.bytes, 0, 176));
    snapshot.release();
    return {
      pageBytes: actual.length,
      afterDestroyBytes: retainedRoot.length,
      generation: epoch,
      replacementGeneration: pool.bindingEpoch,
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    snapshot?.release();
    runtime.destroy();
    pool.releaseOwner();
    read.destroy();
  }
}

async function checkQueryGeometrySnapshot(device, graphics) {
  const fixture = await streamingProductFixture(3);
  const runtime = new GeometryProductMultiRuntimeV1(device, { descriptors: [fixture.descriptor] });
  let snapshot;
  let geometry;
  let build;
  let tlasBuild;
  let instances;
  let instanceSnapshot;
  let query;
  let material;
  let registry;
  let diffuseQuery;
  const diffuseOutput = device.createBuffer({ size: 5 * 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const diffuseRead = device.createBuffer({ size: 5 * 64,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const diffuseDirectory = device.createBuffer({ size: 32,
    usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
  new Uint32Array(diffuseDirectory.getMappedRange()).set([0, 0, 0, 1, 0, 0, 0, 1]);
  diffuseDirectory.unmap();
  const coverageQueries = [];
  const wavefrontQueries = [];
  let candidateWork;
  let pendingWork;
  const pendingQueries = [];
  const continuation = device.createBuffer({ size: 5 * 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const plan = planScgiBvh(device.limits, 1);
  const hierarchy = device.createBuffer({ size: plan.hierarchy.bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const scratch = device.createBuffer({ size: plan.scratch.bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const boundsRead = device.createBuffer({ size: 64,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const alphaLayers = 81;
  const tlasPlan = planScgiBvh(device.limits, alphaLayers + 2);
  const tlas = device.createBuffer({ size: tlasPlan.hierarchy.bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const tlasScratch = device.createBuffer({ size: tlasPlan.scratch.bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const rayCount = 5;
  const resultOffset = rayCount * 48;
  const batch = device.createBuffer({ size: resultOffset + rayCount * 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const hitRead = device.createBuffer({ size: rayCount * 32,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const output = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const read = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const { residency } = await runtime.load(fixture.source);
    let coverageFailure;
    try {
      residency.retainQueryGeometry();
    } catch (error) {
      coverageFailure = error;
    }
    assert.ok(/not available/.test(String(coverageFailure)));
    residency.stagePage(await fixture.source.readPage(2));
    const publish = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    residency.preparePublication(publish, [2]);
    snapshot = residency.retainQueryGeometry(publish);
    publish.finish();
    await publish.gpuDone;
    residency.beginRetirePage(2);
    const revoke = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    residency.preparePublication(revoke, []);
    revoke.finish();
    await revoke.gpuDone;
    assert.equal(residency.pageLocation(2), undefined);
    const module = device.createShaderModule({ code: `${GEOMETRY_PRODUCT_GPU_WGSL_V1}
@group(0) @binding(0) var<storage, read> directory: array<u32>;
@group(0) @binding(1) var<storage, read_write> result: array<u32>;
@compute @workgroup_size(1)
fn main() {
  let asset = oengine_geometry_product_resolve_asset_v1(&directory, 0u, ${snapshot.productGeneration}u);
  let page = oengine_geometry_product_lookup_page_heap_v1(&directory, asset, 2u);
  result[0] = select(0u, 1u, asset.valid);
  result[1] = select(0u, 1u, page.valid);
  result[2] = directory[${snapshot.querySectionWordOffset}u];
  result[3] = page.byte_offset;
}` });
    const info = await module.getCompilationInfo();
    assert.deepEqual(info.messages.filter((message) => message.type === "error"), []);
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: snapshot.metadata } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    geometry = await ScgiQueryGeometry.create(device, plan, scratch, snapshot, 0);
    build = await ScgiBvhBuild.create(device, plan, false, graphics.resource_accounting);
    const scene = graphics.gpu_scene;
    const upload = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    const sceneCount = alphaLayers + 1;
    const sceneTransforms = new Float32Array(sceneCount * 16);
    const sceneSpheres = new Float32Array(sceneCount * 4);
    const sceneMin = new Float32Array(sceneCount * 3);
    const sceneMax = new Float32Array(sceneCount * 3);
    const sceneMaterials = new Uint32Array(sceneCount);
    for (let index = 0; index < sceneCount; index++) {
      sceneTransforms.set(identity, index * 16);
      sceneSpheres.set([0, 0, 0, 1], index * 4);
      sceneMin.set([-0.5, -0.5, 0], index * 3);
      sceneMax.set([0.5, 0.5, 0], index * 3);
    }
    sceneTransforms[(sceneCount - 1) * 16 + 14] = -1;
    sceneMaterials[sceneCount - 1] = 1;
    scene.instantiate({ count: sceneCount, geometryHandles: [],
      virtualGeometry: { productTableSlot: snapshot.productTableSlot, productGeneration: snapshot.productGeneration, assetCount: 1 },
      geometryIndices: new Uint32Array(sceneCount), materialHandles: sceneMaterials,
      currentTransforms: sceneTransforms, boundsSpheres: sceneSpheres,
      boundsMin: sceneMin, boundsMax: sceneMax,
    }, upload);
    upload.finish();
    await upload.gpuDone;
    instanceSnapshot = new GeometryQueryInstanceSnapshot(device, scene, graphics.resource_accounting);
    instances = await GeometryQueryInstances.create(device, tlasPlan, tlasScratch, instanceSnapshot,
      { productTableSlot: snapshot.productTableSlot, productGeneration: snapshot.productGeneration,
        assetReference: 0, root: 0, shard: 0, asGeneration: 1 }, graphics.resource_accounting);
    tlasBuild = await ScgiBvhBuild.create(device, tlasPlan, false, graphics.resource_accounting);
    query = await ScgiQueryTraversal.create(device, plan, tlasPlan,
      { lease: snapshot, asset: 0, blas: hierarchy, tlas, instances, batch, rayCount, resultByteOffset: resultOffset });
    const alphaGraph = new AppearanceGraphBuilder();
    const alphaPosition = alphaGraph.input("worldPosition", 3, "geometry");
    // Front plane rejects; the translated rear plane accepts. This is a real
    // custom alpha graph lowered by the production native material compiler.
    alphaGraph.output("alpha", alphaGraph.operation("multiply", alphaGraph.swizzle(alphaPosition, [2]), alphaGraph.constant(-1)));
    const alphaProgram = lowerNativeMaterial(compileAppearanceGraph(alphaGraph.build()));
    const rearGraph = new AppearanceGraphBuilder();
    const rearPosition = rearGraph.input("worldPosition", 3, "geometry");
    rearGraph.output("alpha", rearGraph.operation("subtract", rearGraph.constant(0), rearGraph.swizzle(rearPosition, [2])));
    const rearProgram = lowerNativeMaterial(compileAppearanceGraph(rearGraph.build()));
    const baseGraph = new AppearanceGraphBuilder();
    baseGraph.output("baseColor", baseGraph.constant([0.5, 0.5, 0.5]));
    const baseProgram = lowerNativeMaterial(compileAppearanceGraph(baseGraph.build()));
    registry = new AppearanceProgramRegistry(device);
    const descriptor = { source: "@compute @workgroup_size(1) fn main() {}", entryPoint: "main",
      workgroupSize: 1, groups: [] };
    material = new GpuNativeMaterialPublication(device, registry, [0, 1].map((materialSlot) => ({
      materialSlot, bindingSet: 0, program: baseProgram, descriptor, valueRevision: 1,
      coverage: { program: materialSlot === 0 ? alphaProgram : rearProgram, layoutEntries: [], materialEntries: [] },
      raster: { alphaCutoff: 0.5, alphaMask: true },
    })));
    await material.ready;
    material.commit();
    for (let classIndex = 0; classIndex < material.rasterClasses.length; classIndex++) {
      coverageQueries.push(await ScgiQueryTraversal.create(device, plan, tlasPlan,
        { lease: snapshot, asset: 0, blas: hierarchy, tlas, instances, batch, rayCount,
          resultByteOffset: resultOffset, merge: classIndex > 0,
          coverage: { publication: material, classIndex, view: identity, camera: [0, 0, 1],
            coneWidth: 0.01, coneSpread: 0.001 } }));
    }
    wavefrontQueries.push(await ScgiQueryTraversal.create(device, plan, tlasPlan,
      { lease: snapshot, asset: 0, blas: hierarchy, tlas, instances, batch, rayCount,
        resultByteOffset: resultOffset, wavefront: { phase: "candidate", continuation } }));
    candidateWork = await ScgiQueryHitWork.create(device, instances.sourceSnapshot,
      material.rasterDirectory, batch, rayCount, resultOffset, material.rasterClasses.length);
    pendingWork = await ScgiQueryHitWork.create(device, instances.sourceSnapshot,
      material.rasterDirectory, batch, rayCount, resultOffset, 1, true);
    for (let classIndex = 0; classIndex < material.rasterClasses.length; classIndex++) {
      wavefrontQueries.push(await ScgiQueryTraversal.create(device, plan, tlasPlan,
        { lease: snapshot, asset: 0, blas: hierarchy, tlas, instances, batch, rayCount,
          resultByteOffset: resultOffset,
          wavefront: { phase: "coverage", continuation, work: candidateWork },
          coverage: { publication: material, classIndex, view: identity, camera: [0, 0, 1],
            coneWidth: 0.01, coneSpread: 0.001 } }));
      pendingQueries.push(await ScgiQueryTraversal.create(device, plan, tlasPlan,
        { lease: snapshot, asset: 0, blas: hierarchy, tlas, instances, batch, rayCount,
          resultByteOffset: resultOffset, merge: classIndex > 0, pendingWork,
          // One step forces suspension on internal/leaf nodes and across the
          // BLAS-to-TLAS return, instead of only testing the single-dispatch case.
          wavefront: { phase: "tail", continuation, nodeQuantum: 1 },
          coverage: { publication: material, classIndex, view: identity, camera: [0, 0, 1],
            coneWidth: 0.01, coneSpread: 0.001 } }));
    }
    const hitGraph = new AppearanceGraphBuilder();
    hitGraph.output("baseColor", hitGraph.constant([0.2, 0.4, 0.8]));
    hitGraph.output("emissive", hitGraph.input("cameraPosition", 3, "view"));
    const hitProgram = lowerNativeMaterial(compileAppearanceGraph(hitGraph.build()));
    const hitConstants = new Float32Array(hitProgram.constants.length + 2);
    hitConstants.set(hitProgram.constants);
    diffuseQuery = await ScgiQueryTraversal.create(device, plan, tlasPlan,
      { lease: snapshot, asset: 0, blas: hierarchy, tlas, instances, batch, rayCount,
        resultByteOffset: resultOffset,
        diffuse: { material: { materialSlot: 0, constants: hitConstants, unlit: false,
          viewDependent: true, binding: { program: hitProgram, layoutEntries: [], entries: [] } },
          directory: diffuseDirectory, output: diffuseOutput,
          view: identity, camera: [2, 3, 4], coneWidth: 0.01, coneSpread: 0.001 } });
    const rays = new Uint8Array(resultOffset);
    const rayView = new DataView(rays.buffer);
    for (const [index, values] of [[0, [0, 0, 1, 0, 0, 0, -1, 10]],
      [1, [1, 0, 1, 0, 0, 0, -1, 10]], [2, [0, 0, -1, 0, 0, 0, 1, 10]],
      [3, [0, 0, 1, 0, 0, 0, 0, 10]], [4, [-0.5, -0.5, 1, 0, 0, 0, -1, 10]]]) {
      for (let lane = 0; lane < 8; lane++) rayView.setFloat32(index * 48 + lane * 4, values[lane], true);
      rayView.setUint32(index * 48 + 36, 0xffffffff, true);
    }
    runtime.destroy();
    const consume = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    const pass = consume.gpu_encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(1);
    pass.end();
    geometry.encodeBounds(consume);
    build.encode(consume, hierarchy, scratch, geometry.primitiveCount);
    instances.encode(consume);
    tlasBuild.encode(consume, tlas, tlasScratch, instances.count);
    consume.uploadRegions([{ destination: batch, destinationOffset: 0, bytes: rays }]);
    query.encode(consume);
    consume.copyBufferToBuffer(batch, resultOffset, hitRead, 0, rayCount * 32);
    consume.copyBufferToBuffer(hierarchy, plan.hierarchy.ranges.nodes.offset, boundsRead, 0, 64);
    consume.copyBufferToBuffer(output, 0, read, 0, 16);
    consume.finish();
    await consume.gpuDone;
    await read.mapAsync(GPUMapMode.READ);
    const actual = [...new Uint32Array(read.getMappedRange().slice(0))];
    read.unmap();
    assert.deepEqual(actual, [1, 1, 0x3251474f, snapshot.pages[0].location.byteOffset]);
    await boundsRead.mapAsync(GPUMapMode.READ);
    const built = new Float32Array(boundsRead.getMappedRange().slice(0));
    boundsRead.unmap();
    assert.deepEqual([built[0], built[1], built[2], built[4], built[5], built[6]],
      [-0.5, -0.5, 0, 0.5, 0.5, 0], "AS bounds must come from shared actual positions, not header proxies");
    await hitRead.mapAsync(GPUMapMode.READ);
    const hits = hitRead.getMappedRange().slice(0);
    hitRead.unmap();
    const hitWords = new Uint32Array(hits);
    const hitFloats = new Float32Array(hits);
    assert.deepEqual([hitWords[3], hitWords[11], hitWords[19], hitWords[27], hitWords[35]], [0, 1, 0, 1, 0]);
    assert.equal(hitFloats[0], 1);
    assert.equal(hitFloats[1], 0.25);
    assert.equal(hitFloats[2], 0.5);
    assert.equal(hitWords[4], 1);
    assert.equal(hitWords[5], 0);
    assert.equal(hitWords[7], 1);
    assert.equal(hitWords[23], 0);
    const coverageCommand = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    for (const coverageQuery of coverageQueries) coverageQuery.encode(coverageCommand);
    coverageCommand.clearBuffer(diffuseOutput);
    diffuseQuery.encode(coverageCommand);
    coverageCommand.copyBufferToBuffer(diffuseOutput, 0, diffuseRead, 0, rayCount * 64);
    coverageCommand.copyBufferToBuffer(batch, resultOffset, hitRead, 0, rayCount * 32);
    coverageCommand.finish();
    await coverageCommand.gpuDone;
    await hitRead.mapAsync(GPUMapMode.READ);
    const acceptedHits = hitRead.getMappedRange().slice(0);
    hitRead.unmap();
    const acceptedWords = new Uint32Array(acceptedHits);
    const acceptedFloats = new Float32Array(acceptedHits);
    assert.equal(acceptedWords[3], 0);
    assert.equal(acceptedWords[4], sceneCount, "deep equal-t alpha rejection must complete across native bins");
    assert.equal(acceptedFloats[0], 2);
    await diffuseRead.mapAsync(GPUMapMode.READ);
    const diffuse = new Float32Array(diffuseRead.getMappedRange().slice(0));
    diffuseRead.unmap();
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(Math.abs(diffuse[channel] - [0.2, 0.4, 0.8][channel] / Math.PI) < 1e-7);
    }
    assert.deepEqual([...diffuse.subarray(4, 7)], [2, 3, 4], "real camera inputs survive accepted-hit material projection");
    assert.equal(diffuse[11], 1);
    assert.deepEqual([...diffuse.subarray(12, 15)], [0, 0, -1], "shade actual accepted rear-plane geometry");
    for (const rounds of [2, 83]) {
      const wave = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      wave.clearBuffer(continuation);
      for (let round = 0; round < rounds; round++) {
        wavefrontQueries[0].encode(wave);
        candidateWork.encode(wave);
        for (let index = 1; index < wavefrontQueries.length; index++) wavefrontQueries[index].encode(wave);
      }
      if (rounds === 2) {
        wave.copyBufferToBuffer(batch, resultOffset, read, 0, 16);
        pendingWork.encode(wave);
        for (const coverageQuery of pendingQueries) coverageQuery.encode(wave);
      }
      wave.copyBufferToBuffer(batch, resultOffset, hitRead, 0, rayCount * 32);
      wave.finish();
      await wave.gpuDone;
      await hitRead.mapAsync(GPUMapMode.READ);
      const candidate = new Uint32Array(hitRead.getMappedRange().slice(0));
      hitRead.unmap();
      if (rounds === 2) {
        await read.mapAsync(GPUMapMode.READ);
        const pending = new Uint32Array(read.getMappedRange().slice(0));
        read.unmap();
        assert.equal(pending[3], 4, "K is a scheduling limit, deep alpha remains pending for complete tail");
        assert.equal(candidate[3], 0);
        assert.equal(candidate[4], sceneCount, "complete tail resolves pending in the same GPU command");
      } else {
        assert.equal(candidate[3], 0);
        assert.equal(candidate[4], sceneCount, "equal-t rejection cursor must preserve every coplanar instance");
      }
    }
    await snapshot.releaseAfter(consume.gpuDone);
    return { immutableDirectoryAfterRevokeAndProductDestruction: actual, directoryBytes: snapshot.metadataByteLength };
  } finally {
    await device.queue.onSubmittedWorkDone();
    geometry?.destroy();
    build?.destroy();
    query?.destroy();
    for (const coverageQuery of coverageQueries) coverageQuery.destroy();
    for (const waveQuery of wavefrontQueries) waveQuery.destroy();
    candidateWork?.destroy();
    pendingWork?.destroy();
    for (const pending of pendingQueries) pending.destroy();
    continuation.destroy();
    material?.destroy();
    registry?.destroy();
    diffuseQuery?.destroy();
    diffuseOutput.destroy();
    diffuseRead.destroy();
    diffuseDirectory.destroy();
    instances?.destroy();
    instanceSnapshot?.destroy();
    tlasBuild?.destroy();
    tlas.destroy();
    tlasScratch.destroy();
    batch.destroy();
    hitRead.destroy();
    hierarchy.destroy();
    scratch.destroy();
    boundsRead.destroy();
    snapshot?.release();
    runtime.destroy();
    output.destroy();
    read.destroy();
  }
}

async function checkQueryInstances(device, graphics) {
  const scene = graphics.gpu_scene;
  const count = 3;
  const transforms = new Float32Array(count * 16);
  for (let index = 0; index < count; index++) {
    transforms.set(identity, index * 16);
    transforms[index * 16] = index === 0 ? -2 : index === 2 ? 0 : 1;
    transforms[index * 16 + 5] = 3;
    transforms[index * 16 + 10] = 0.5;
    transforms[index * 16 + 12] = 100 + index * 10;
  }
  const upload = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
  const handle = scene.instantiate({ count, geometryHandles: [],
    virtualGeometry: { productTableSlot: 0, productGeneration: 1, assetCount: 1 },
    geometryIndices: new Uint32Array(count), materialHandles: new Uint32Array(count),
    currentTransforms: transforms, boundsSpheres: new Float32Array(count * 4).fill(1),
    boundsMin: new Float32Array(count * 3).fill(-0.5),
    boundsMax: new Float32Array(count * 3).fill(0.5),
    flags: new Uint32Array([GPU_INSTANCE_FLAGS.Active, 0, GPU_INSTANCE_FLAGS.Active]),
  }, upload);
  upload.finish();
  await upload.gpuDone;
  const deactivate = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
  scene.patch(handle, { frameId: 1, visibility: { indices: new Uint32Array([1]),
    flags: new Uint32Array([0]) } }, deactivate);
  deactivate.finish();
  await deactivate.gpuDone;
  const source = scene.bindings();
  const plan = planScgiBvh(device.limits, source.highWaterCount);
  const scratch = device.createBuffer({ size: plan.scratch.bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const read = device.createBuffer({ size: source.highWaterCount * 128 + 32,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  let query;
  const instanceSnapshot = new GeometryQueryInstanceSnapshot(device, scene, graphics.resource_accounting);
  try {
    query = await GeometryQueryInstances.create(device, plan, scratch, instanceSnapshot,
      { productTableSlot: 0, productGeneration: 1, assetReference: 0, root: 0, shard: 0, asGeneration: 1 },
      graphics.resource_accounting);
    const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    query.encode(command);
    command.copyBufferToBuffer(query.records, 0, read, 0, source.highWaterCount * 128);
    command.copyBufferToBuffer(scratch, plan.scratch.ranges.primitiveBounds.offset + scene.range(handle).start * 32,
      read, source.highWaterCount * 128, 32);
    command.finish();
    await command.gpuDone;
    await read.mapAsync(GPUMapMode.READ);
    const data = read.getMappedRange().slice(0);
    read.unmap();
    const f = new Float32Array(data);
    const u = new Uint32Array(data);
    const first = scene.range(handle).start;
    assert.equal(u[first * 32 + 30], 0xffffffff, "offscreen active instance remains query-visible");
    assert.equal(u[(first + 1) * 32 + 30], 0, "inactive hole is masked");
    assert.equal(u[(first + 2) * 32 + 31], 0x80000000, "singular transform is untrusted coverage");
    assert.equal(f[first * 32 + 12], -0.5);
    // Normalized cofactors perform several f32 operations; validate the inverse
    // identity in float32 units rather than requiring one CPU division's bits.
    assert.ok(Math.abs(f[first * 32 + 17] * 3 - 1) <= 4 * 2 ** -23);
    assert.equal(f[first * 32 + 22], 2);
    assert.equal(f[first * 32 + 15], 50);
    const b = source.highWaterCount * 32;
    assert.deepEqual([f[b], f[b + 1], f[b + 2], f[b + 4], f[b + 5], f[b + 6]],
      [99, -1.5, -0.25, 101, 1.5, 0.25]);
    return { highWaterCount: source.highWaterCount, offscreenIncluded: true,
      negativeNonuniformInverse: true, singularUntrusted: true };
  } finally {
    await device.queue.onSubmittedWorkDone();
    query?.destroy();
    instanceSnapshot.destroy();
    scratch.destroy();
    read.destroy();
  }
}

async function checkPendingDemandDeviceLoss() {
  const results = [];
  for (const [shadow, queued] of [[false, false], [true, false], [false, true], [true, true]]) {
    const adapter = await navigator.gpu.requestAdapter();
    assert.ok(adapter, "Demand cancellation adapter unavailable");
    const device = await adapter.requestDevice();
    const errors = [];
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    // This isolated check exercises only the real readback/loss owner; no
    // residency uploads are needed to cancel a committed demand copy.
    const streaming = new GeometryPageStreamingRuntimeV1(device, { evidence: () => ({}) }, {
      readback: { slotCount: 2, bytesPerSlot: 64 }
    });
    const source = device.createBuffer({
      label: "Geometry cancellation demand",
      size: 32,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });
    try {
      const encoder = device.createCommandEncoder();
      const finished = [];
      const command = {
        gpu_encoder: encoder,
        onFinished: { addOne: (callback) => finished.push(callback) },
        onAborted: { addOne() {} }
      };
      if (shadow) streaming.encodeShadowDemandReadback(command, source, 1);
      else streaming.encodeDemandReadback(command, source, 1);
      device.queue.submit([encoder.finish()]);
      finished.forEach((callback) => callback());
      await device.queue.onSubmittedWorkDone();
      const poll = queued
        ? streaming.consumeAfterCompletion(1, Promise.resolve())
        : streaming.consumeCompleted(2);
      if (!queued) await Promise.resolve();
      device.destroy();
      assert.equal((await poll).cancelled, true, "Loss must revoke the pending map");
      await device.lost;
      const evidence = streaming.evidence();
      assert.equal(evidence.lastError, null);
      assert.equal(evidence.readback.inUse, 0);
      if (shadow) assert.equal(evidence.shadowReadback.inUse, 0);
      assert.deepEqual(errors, []);
      results.push({ shadow, queued, cancelled: true, evidence });
    } finally {
      streaming.destroy();
      source.destroy();
      device.destroy();
    }
  }
  return results;
}

export async function runGeometryBudgetedResidencyGpuOracle(device) {
  const graphics = new GraphicsContext(device);
  const queryHitWork = await checkQueryHitWork(device, graphics);
  const queryPageSnapshot = await checkQueryPageSnapshot(device, graphics);
  const queryGeometrySnapshot = await checkQueryGeometrySnapshot(device, graphics);
  const queryInstances = await checkQueryInstances(device, graphics);
  const bvhBuild = await checkBvhBuild(device, graphics);
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter?.features.has("subgroups") && !device.features.has("subgroups")) {
    const subgroupDevice = await adapter.requestDevice({ requiredFeatures: ["subgroups"] });
    const subgroupGraphics = new GraphicsContext(subgroupDevice);
    const errors = [];
    subgroupDevice.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    try {
      bvhBuild.push(...await checkBvhBuild(subgroupDevice, subgroupGraphics));
      assert.deepEqual(errors, []);
    } finally {
      subgroupGraphics.destroy();
      subgroupDevice.destroy();
    }
  }
  const pendingDemandDeviceLoss = await checkPendingDemandDeviceLoss();
  const boundaries = [];
  const shader = device.createShaderModule({
    code: `${GEOMETRY_PRODUCT_GPU_WGSL_V1}
    @group(0) @binding(0) var<storage, read> heap: array<u32>;
    @group(0) @binding(1) var<storage, read> bank: array<u32>;
    @group(0) @binding(2) var<storage, read_write> output: array<u32>;
    @compute @workgroup_size(1) fn main() {
      let asset = OEngineGeometryProductResolvedAssetV1(
        true, 0u, 19u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 16u, 1u, 0u, 0u);
      let location = oengine_geometry_product_lookup_page_heap_v1(&heap, asset, 0u);
      output[0] = select(0u, 1u, location.valid);
      output[1] = location.byte_offset;
      output[2] = location.byte_offset / 4u;
      output[3] = 0u;
      if (location.valid) { output[3] = bank[location.byte_offset / 4u]; }
    }`
  });
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: shader, entryPoint: "main" }
  });
  for (const profile of ["auto", "Portable", "Balanced", "HighEnd"]) {
    const plan = selectGeometryProductResidencyProfileV1(device.limits, { requestedProfile: profile });
    const pool = GeometryProductBytePool.retain(device, plan);
    const locations = device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    const output = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const heapHeader = new Uint32Array(16);
    heapHeader[12] = pool.bankBytes;
    device.queue.writeBuffer(locations, 0, heapHeader);
    try {
      const cases = [
        ...[0, 176, 512, pool.bankBytes - 16].map(offset => ({ offset, valid: true })),
        { offset: 0, valid: false, word: 2, value: 20, name: "stale-generation" },
        { offset: 0, valid: false, absent: true, name: "nonresident" },
        { offset: 0, valid: false, word: 0, value: 22, name: "reserved-bits" },
        { offset: 0, valid: false, word: 1, value: 4, name: "unaligned" },
        { offset: pool.bankBytes - 16, valid: false, word: 3, value: 32, name: "past-bank-end" },
        { offset: 0, valid: false, word: 1, value: 0xfffffff0, name: "u32-wrap" },
      ];
      for (const entry of cases) {
        const offset = entry.offset;
        const bytes = encodeGeometryProductGpuLocationV1(entry.absent ? undefined : {
          bankIndex: 2, byteOffset: offset, payloadBytes: 16, productGeneration: 19, flags: 1
        });
        if (entry.word !== undefined) new DataView(bytes.buffer).setUint32(entry.word * 4, entry.value, true);
        device.queue.writeBuffer(locations, 64, bytes);
        const marker = 0x12340000 + offset;
        device.queue.writeBuffer(pool.banks[2], offset, new Uint32Array([marker]));
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(
          0,
          device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: locations } },
              { binding: 1, resource: { buffer: pool.banks[2] } },
              { binding: 2, resource: { buffer: output } }
            ]
          })
        );
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(output, 0, read, 0, 16);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const words = new Uint32Array(read.getMappedRange().slice(0));
        read.unmap();
        assert.equal(words[0], Number(entry.valid), entry.name);
        if (entry.valid) assert.deepEqual([...words], [1, offset, offset / 4, marker]);
        else assert.equal(words[3], 0, `${entry.name} must not read the bank`);
        boundaries.push({
          profile: plan.profile, capacityBytes: pool.bankBytes * 4, offset,
          name: entry.name ?? "valid-address", valid: entry.valid, marker: words[3],
        });
      }
    } finally {
      await device.queue.onSubmittedWorkDone();
      pool.releaseOwner();
      locations.destroy();
      output.destroy();
      read.destroy();
    }
  }

  // Eight exact leases. Two pinned roots plus one visible six-page chain
  // fit after tail reuse; switching instances must reclaim the old fine pages.
  const runtime = new GeometryProductMultiRuntimeV1(device, {
    metadataBytes: 64 * 1024,
    residency: { configuredCapacityBytes: 2 * MiB, maxPageLeases: 8 }
  });
  const hierarchy = new HierarchicalWorkGenerator(device);
  const candidate = new VirtualGeometryMeshletWorkCandidate(device);
  await candidate.preparePipelines();
  const frameInstances = new FrameInstanceTransforms(device);
  await frameInstances.ready;
  const shadowOwner = new ShadowGeometryWork({ device, frame_instances: frameInstances });
  const buffers = [];
  const buffer = (
    size,
    usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
  ) => {
    const result = device.createBuffer({ size, usage });
    buffers.push(result);
    return result;
  };
  let streaming;
  const frames = [];
  try {
    const fixtures = [await streamingProductFixture(6), await streamingProductFixture(6)];
    const handles = [];
    for (const fixture of fixtures) handles.push(await runtime.load(fixture.source));
    streaming = new GeometryPageStreamingRuntimeV1(device, handles[0].residency, {
      schedulerOptions: {
        maxConcurrentReads: 2,
        maxInFlightBytes: 2 * 262144,
        maxUploadBytesPerFrame: MiB,
        adaptive: false
      }
    });
    for (const [index, handle] of handles.entries())
      streaming.registerProduct(fixtures[index].source, handle.residency);
    const records = handles.map((handle, index) =>
      packGpuInstanceRecord({
        geometryRecordIndex: handle.assetReferenceBegin,
        geometryGeneration: handle.productGeneration,
        materialHandle: 0,
        flags:
          GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.VirtualGeometry | GPU_INSTANCE_FLAGS.CastsShadow,
        debugId: index,
        boundsSphere: [0, 0, 0, 1],
        boundsMin: [-1, -1, -1],
        boundsMax: [1, 1, 1],
        currentObjectToWorld: identity,
        previousObjectToWorld: identity
      })
    );
    const instances = buffer(2 * 176);
    records.forEach((record, index) => device.queue.writeBuffer(instances, index * 176, record));
    const scene = { abiVersion: GPU_INSTANCE_ABI_VERSION, instances, highWaterCount: 2 };
    const placeholder = buffer(256),
      counters = buffer(GPU_COUNTER_BYTE_SIZE);
    const h = hierarchy.prepare(
      {
        assets: {
          abiVersion: GPU_GEOMETRY_ABI_VERSION,
          geometryRecords: placeholder,
          meshletRecords: placeholder,
          clusterRecords: placeholder,
          clusterChildren: placeholder
        },
        scene,
        instanceBegin: 0,
        instanceCount: 2,
        maxHierarchyDepth: 0,
        traversalWorkCapacity: 12,
        visibleClusterCapacity: 12,
        rasterWorkCapacity: 12,
        counterBuffer: counters,
        virtualGeometry: runtime.bindings()
      },
      { sseThreshold: 1, countersEnabled: true, diagnosticsEnabled: true, rasterExpansionEnabled: false }
    );
    await hierarchy.prepareWorkPipelines(h);
    const work = candidate.prepare({
      virtualGeometry: runtime.bindings(),
      visibleClusters: h.generated.visibleClusters,
      viewUniform: h.generated.viewUniform,
      lodAnchors: h.generated.lodAnchors,
      visibleClusterCapacity: 12,
      capacity: 12,
      counterBuffer: counters,
      countersEnabled: true,
      scene
    });
    const read = buffer(work.queue.size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const view = {
      kind: "perspective",
      cameraPosition: [0, 0, 4],
      viewportHeight: 720,
      verticalFovRadians: Math.PI / 3,
      nearPlane: 0.1,
      frustumPlanes: Array.from({ length: 6 }, () => [0, 0, 0, 1])
    };
    const camera = buffer(PACKED_CAMERA_TYPE.size, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    // The current bounds producer is gated by the real allocation header's
    // dirty count. This test needs caster work on every pressure tick.
    const shadowAllocation = buffer(48);
    // One real mip5 page at world (0, 0); its caster domain intersects the fixture.
    const coarsePage = 16384 + 4096 + 1024 + 256 + 64;
    device.queue.writeBuffer(shadowAllocation, 0,
      new Uint32Array([1, 1, 0, 1, coarsePage, 0, 0, 1, 0, 5, 0, 0]));
    const shadowRequested = buffer(Math.ceil((coarsePage + 64) / 32) * 4);
    device.queue.writeBuffer(shadowRequested, Math.floor(coarsePage / 32) * 4,
      new Uint32Array([1 << (coarsePage % 32)]));
    const shadowJob = {
      assets: {
        abiVersion: GPU_GEOMETRY_ABI_VERSION,
        geometryRecords: placeholder,
        meshletRecords: placeholder,
        clusterRecords: placeholder,
        clusterChildren: placeholder
      },
      scene,
      runtime: {
        instanceBegin: 0,
        instanceCount: 2,
        hierarchyMaxDepth: 0,
        hierarchyTraversalCapacity: 12,
        hierarchyVisibleClusterCapacity: 12,
        hierarchyRasterWorkCapacity: 12,
        counterSink: counters
      },
      virtualGeometry: runtime.bindings(),
      streamingRuntime: streaming,
      shadowFrame: { generation: 1, lightView: identity, clipOriginExtent: [[-2, -2, 4, 1]] }
    };
    await shadowOwner.preparePipelines({ ...shadowJob.runtime, virtualGeometry: shadowJob.virtualGeometry });
    const shadowPrepared = shadowOwner.prepare(
      shadowJob,
      {
        key: { traversalCapacity: 12, meshletWorkCandidateCapacity: 12 }
      },
      camera,
      {
        destroyAfterGpuDone() {
          throw new Error("No prior shadow allocation may retire");
        }
      }
    );
    const shadowRead = buffer(
      shadowPrepared.work.queue.size,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    );
    const demandRead = buffer(
      shadowPrepared.hierarchy.generated.pageDemand.size,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    );
    let shadowDemandRecords = 0;
    let residentUsageRecords = 0;
    let aborted = false;
    try {
      for (let frame = 0; frame < 72; frame++) {
        const activeInstance = Math.floor(frame / 24) % 2;
        records.forEach((record, index) => {
          // The flags lane is owned by packGpuInstanceRecord, not a test offset.
          const updated = packGpuInstanceRecord({
            geometryRecordIndex: handles[index].assetReferenceBegin,
            geometryGeneration: handles[index].productGeneration,
            materialHandle: 0,
            flags: GPU_INSTANCE_FLAGS.VirtualGeometry | GPU_INSTANCE_FLAGS.CastsShadow |
              (index === activeInstance ? GPU_INSTANCE_FLAGS.Active : 0),
            debugId: index, boundsSphere: [0, 0, 0, 1],
            boundsMin: [-1, -1, -1], boundsMax: [1, 1, 1],
            currentObjectToWorld: identity, previousObjectToWorld: identity,
          });
          device.queue.writeBuffer(instances, index * record.byteLength, updated);
        });
        const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
        const encoder = command.gpu_encoder;
        streaming.preparePublication(command);
        hierarchy.encode(encoder, h, view, { coneEnabled: false, demandFrameRevisionLow: frame });
        candidate.encode(command, work);
        streaming.encodeDemandReadback(command, h.generated.pageDemand, frame);
        const cleanShadow = frame % 8 === 7;
        device.queue.writeBuffer(shadowAllocation, 4, new Uint32Array([cleanShadow ? 0 : 1]));
        shadowOwner.encode(
          { ...shadowJob, demandFrameIndex: frame, demandFrameRevisionLow: frame },
          shadowPrepared,
          command,
          shadowAllocation,
          shadowRequested
        );
        encoder.copyBufferToBuffer(work.queue, 0, read, 0, work.queue.size);
        encoder.copyBufferToBuffer(shadowPrepared.work.queue, 0, shadowRead, 0, shadowRead.size);
        encoder.copyBufferToBuffer(
          shadowPrepared.hierarchy.generated.pageDemand,
          0,
          demandRead,
          0,
          demandRead.size
        );
        if (frame === 0 && !aborted) {
          command.abort(new Error("Geometry pressure injected pre-submit abort"));
          assert.equal(streaming.evidence().readback.inUse, 0);
          assert.equal(
            streaming.evidence().shadowReadback.inUse,
            0,
            "Abort must cancel independent shadow demand"
          );
          aborted = true;
          frame--;
          continue; // Retry the exact same frame with a new command.
        }
        command.finish();
        await command.gpuDone;
        await read.mapAsync(GPUMapMode.READ);
        const words = new Uint32Array(read.getMappedRange().slice(0));
        read.unmap();
        await Promise.all([shadowRead.mapAsync(GPUMapMode.READ), demandRead.mapAsync(GPUMapMode.READ)]);
        const shadowWords = new Uint32Array(shadowRead.getMappedRange().slice(0));
        const demandBytes = demandRead.getMappedRange().slice(0),
          demandWords = new Uint32Array(demandBytes);
        shadowRead.unmap();
        demandRead.unmap();
        assert.equal(shadowWords[4] + shadowWords[6], 0, "Shadow work must retain complete resident cut");
        const shadowCounts = [0, 0];
        for (let index = 0; index < shadowWords[1]; index++) shadowCounts[shadowWords[8 + index * 6]]++;
        assert.ok(
          (cleanShadow ? shadowWords[1] === 0 : shadowCounts[activeInstance] >= 1) &&
            shadowCounts[1 - activeInstance] === 0,
          "Shadow missing pages cannot erase coarse coverage"
        );
        assert.equal(demandWords[2], 0, "Shadow demand cannot overflow this fixture");
        assert.ok(demandWords[1] > 0, "Clean shadow pages must still touch/request geometry");
        for (let index = 0; index < Math.min(demandWords[0], demandWords[1]); index++) {
          const demand = unpackGeometryPageDemandV1(new Uint8Array(demandBytes, 16 + index * 16, 16));
          assert.equal(demand.shadow, true, "Independent shadow producer must tag feedback");
          if (demand.residentUsage) {
            residentUsageRecords++;
          } else {
            assert.equal(demand.priority, 65535);
            shadowDemandRecords++;
          }
        }
        assert.equal(words[4] + words[6], 0, "pressure produced invalid/overflow work");
        const counts = [0, 0];
        for (let index = 0; index < words[1]; index++) counts[words[8 + index * 6]]++;
        assert.ok(
          counts[activeInstance] >= 1 && counts[1 - activeInstance] === 0,
          "coarse coverage lost an accepted instance"
        );
        if (frame === 0) {
          const sameFrame = await streaming.consumeCompleted(frame, performance.now());
          assert.equal(sameFrame.consumedReadbacks, 0, "Neither view may consume same-frame feedback");
        }
        await streaming.consumeAfterCompletion(frame, device.queue.onSubmittedWorkDone(), performance.now());
        await streaming.scheduler.drainReads();
        const evidence = streaming.evidence();
        assert.ok(evidence.scheduler.verifiedBytes + evidence.scheduler.inFlightBytes <= 2 * 262144);
        assert.ok(evidence.products.every((product) => product.pinnedPages === 1));
        frames.push({
          frame,
          counts,
          shadowCounts,
          uploads: evidence.scheduler.uploadedBytes,
          verifiedBytes: evidence.scheduler.verifiedBytes,
          pending: evidence.scheduler.pending,
          residents: evidence.products.map((product) => product.residentPages)
        });
        if (frame % 24 >= 20) {
          assert.equal(evidence.products[activeInstance].residentPages, 6, "Static active chain must fully converge");
          assert.equal(evidence.scheduler.blockedUploads, 0);
        }
      }
    } finally {
      candidate.release(work);
      hierarchy.release(h);
    }
    const evidence = streaming.evidence();
    assert.ok(
      evidence.products.every((product) => product.evictedPages > 0),
      "one Product starved pressure eviction"
    );
    assert.ok(
      evidence.products.every(
        (product) => product.residentPages > product.pinnedPages || product.evictedPages > 0
      )
    );
    assert.ok(
      fixtures.reduce((sum, fixture) => sum + fixture.reads, 0) > 12,
      "pressure uploads failed to progress beyond capacity"
    );
    assert.equal(evidence.scheduler.failed, 0);
    assert.equal(evidence.lastError, null);
    assert.ok(shadowDemandRecords > 0, "Real missing shadow pages must produce delayed feedback");
    assert.ok(residentUsageRecords > 0, "Resident shadow pages must refresh eviction age");
    assert.ok(evidence.shadowReadback.submitted > 1);
    await device.queue.onSubmittedWorkDone();
    const retirements = [],
      retirement = {
        destroyAfterGpuDone(resource) {
          retirements.push(resource);
        }
      };
    const beforeReplacement = frameInstances.allocatedBytes;
    const replaced = shadowOwner.prepare(
      shadowJob,
      { key: { traversalCapacity: 12, meshletWorkCandidateCapacity: 12 } },
      camera,
      retirement
    );
    assert.notEqual(replaced, shadowPrepared);
    assert.equal(retirements.length, 1);
    assert.equal(
      frameInstances.allocatedBytes,
      beforeReplacement * 2,
      "Old view resources remain live until retirement"
    );
    retirements[0].destroy();
    retirements[0].destroy();
    assert.equal(
      frameInstances.allocatedBytes,
      beforeReplacement,
      "Repeated retirement cannot destroy the current view"
    );
    shadowOwner.release(shadowJob.runtime, retirement);
    assert.equal(
      frameInstances.allocatedBytes,
      beforeReplacement,
      "Release must respect the last-reader completion"
    );
    shadowOwner.destroy();
    for (const resource of retirements) resource.destroy();
    assert.equal(
      frameInstances.allocatedBytes,
      0,
      "Teardown and pending callbacks cannot double release or leak"
    );
    return {
      queryPageSnapshot,
      queryGeometrySnapshot,
      bvhBuild,
      queryInstances,
      queryHitWork,
      pendingDemandDeviceLoss,
      boundaries,
      frames,
      evidence,
      shadowDemandRecords,
      residentUsageRecords,
      physicalCapacityBytes: 2 * MiB,
      logicalFinePageBytes: 10 * 262144,
      limitations: ["Small correctness/pressure fixture; not G2.4 scene-scale performance"]
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    streaming?.destroy();
    shadowOwner.destroy();
    frameInstances.destroy();
    hierarchy.destroy();
    candidate.destroy();
    runtime.destroy();
    buffers.forEach((item) => item.destroy());
    graphics.destroy();
  }
}
