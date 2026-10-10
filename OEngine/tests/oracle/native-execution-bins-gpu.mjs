import { NativeExecutionBins } from "../../.test-dist/render/surface/NativeExecutionBins.js";
import {
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
} from "../../.test-dist/gpu/GpuMeshletRasterWorkAbi.js";
import {
  GPU_FRAME_INSTANCE_STRIDE,
  GPU_FRAME_INSTANCE_OFFSETS,
} from "../../.test-dist/gpu/GpuFrameInstanceAbi.js";

const check = (value, message) => {
  if (!value) throw new Error(message);
};

/** Component oracle: actual Visibility/Work/frame-instance/native-directory ABI.
 * This verifies routing and indirect consumer ownership, not material shading.
 * No readback influences GPU commands; diagnostics are inspected after submit.
 */
export async function runNativeExecutionBinsGpuOracle(device) {
  const resources = [];
  const owners = [];
  const reports = [];
  const buffer = (data, usage) => {
    const resource = device.createBuffer({
      size: Math.max(4, data.byteLength),
      usage,
      mappedAtCreation: true,
    });
    new Uint8Array(resource.getMappedRange()).set(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
    resource.unmap();
    resources.push(resource);
    return resource;
  };
  const read = async (encoder, source) => {
    const result = device.createBuffer({
      size: source.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    resources.push(result);
    encoder.copyBufferToBuffer(source, 0, result, 0, source.size);
    return result;
  };
  try {
    for (const fixture of [
      { name: "tail-multimaterial", width: 19, height: 13, binCount: 3, maxGroups: 4 },
      { name: "many-empty-bins", width: 37, height: 21, binCount: 513, maxGroups: 8 },
      { name: "uniform-high-count-2d", width: 128, height: 128, binCount: 2, maxGroups: 16, uniform: true },
      {
        name: "uniform-primitive",
        width: 16,
        height: 16,
        binCount: 2,
        maxGroups: 8,
        uniform: true,
        primitive: true,
      },
      { name: "all-empty", width: 17, height: 9, binCount: 5, maxGroups: 8, empty: true },
      { name: "malformed-winners", width: 19, height: 13, binCount: 3, maxGroups: 4, malformed: true },
      { name: "stale-generation", width: 19, height: 13, binCount: 3, maxGroups: 4, stale: true },
    ]) {
      const { width, height, binCount } = fixture;
      const pixels = width * height;
      const generation = 7;
      // Program and resource sets are deliberately independent of material slots.
      const bins = Array.from({ length: binCount }, (_, bin) => ({
        programIndex: bin % 3,
        bindingSet: Math.floor(bin / 3),
      }));
      const slots = binCount * 2;
      const work = new Uint32Array(
        (GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE + slots * GPU_MESHLET_RASTER_WORK_RECORD_STRIDE) / 4,
      );
      work.set([slots, slots, 0, slots, 0, generation, 0, 0]);
      for (let slot = 0; slot < slots; slot++) {
        // Both materials share instance 0; a classifier reading source.material_handle fails.
        work.set(
          [0, 0, 0, slot, 0, 1],
          GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE / 4 + (slot * GPU_MESHLET_RASTER_WORK_RECORD_STRIDE) / 4,
        );
      }
      const instances = new Uint32Array(GPU_FRAME_INSTANCE_STRIDE / 4);
      instances[GPU_FRAME_INSTANCE_OFFSETS.generation / 4] = generation;
      instances[1] = 0; // source material is intentionally unrelated to most winners.
      const directory = new Uint32Array(slots * 4);
      for (let slot = 0; slot < slots; slot++) {
        const bin = slot % binCount;
        directory.set([slot * 4, bins[bin].programIndex, bins[bin].bindingSet, bin], slot * 4);
      }
      if (fixture.malformed) {
        directory[(slots - 2) * 4 + 3] = 0xffffffff;
        work[
          GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE / 4 +
            ((slots - 1) * GPU_MESHLET_RASTER_WORK_RECORD_STRIDE) / 4 +
            3
        ] = slots + 3;
      }
      const keys = new Uint32Array(pixels);
      const expected = new Int32Array(pixels).fill(-1);
      let expectedInvalid = 0;
      for (let at = 0; at < pixels; at++) {
        if (fixture.empty || (!fixture.uniform && at % 11 === 0)) {
          keys[at] = 0xffffffff;
        } else {
          const slot = fixture.uniform ? 0 : (at * 7 + Math.floor(at / width)) % slots;
          keys[at] = slot | ((fixture.primitive ? 0 : at % 128) << 24);
          expected[at] = slot % binCount;
          if (fixture.malformed && at % 13 === 0) {
            keys[at] = at % 2 ? 0xfffffffe : 0x80000000;
            expected[at] = -1;
            expectedInvalid++;
          } else if (fixture.stale || (fixture.malformed && slot >= slots - 2)) {
            expected[at] = -1;
            expectedInvalid++;
          }
        }
      }
      const visibility = device.createTexture({
        size: [width, height],
        format: "r32uint",
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      });
      resources.push(visibility);
      device.queue.writeTexture({ texture: visibility }, keys, { bytesPerRow: width * 4 }, [width, height]);
      const inputs = {
        visibility: visibility.createView(),
        meshletWork: buffer(work, GPUBufferUsage.STORAGE),
        frameInstances: buffer(instances, GPUBufferUsage.STORAGE),
        materialDirectory: buffer(directory, GPUBufferUsage.STORAGE),
        generation: fixture.stale ? generation + 1 : generation,
      };
      const owner = new NativeExecutionBins(device, {
        width,
        height,
        bins,
        maxWorkgroupsPerDimension: fixture.maxGroups,
      });
      owners.push(owner);
      await owner.ready;
      const bindings = owner.createBindings(inputs);
      const selected = bins.map((_, bin) =>
        buffer(new Uint32Array([bin, width, height, 0]), GPUBufferUsage.UNIFORM),
      );
      const written = buffer(
        new Uint32Array(pixels),
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      );
      const membership = buffer(
        new Uint32Array(pixels),
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      );
      const module = device.createShaderModule({
        code: /* wgsl */ `
@group(0) @binding(0) var<storage, read> queue: array<u32>;
@group(0) @binding(1) var<storage, read_write> written: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> membership: array<u32>;
@group(0) @binding(3) var<uniform> selected: vec4u;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group: vec3u, @builtin(num_workgroups) groups: vec3u,
    @builtin(local_invocation_index) lane: u32) {
  let at = group.y * groups.x + group.x;
  let record = selected.x * 8u;
  if at >= queue[record + 1u] { return; }
  let address = queue[record] + at * 3u;
  let mask = queue[address + 1u + lane / 32u];
  if (mask & (1u << (lane % 32u))) == 0u { return; }
  let tile = queue[address] & 0x7fffffffu;
  let tiles_x = (selected.y + 7u) / 8u;
  let xy = vec2u((tile % tiles_x) * 8u + lane % 8u, (tile / tiles_x) * 8u + lane / 8u);
  if xy.x >= selected.y || xy.y >= selected.z { return; }
  let pixel = xy.y * selected.y + xy.x;
  atomicAdd(&written[pixel], 1u);
  membership[pixel] = selected.x + 1u;
}`,
      });
      const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "main" },
      });
      const groups = bins.map((_, bin) =>
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [owner.queue, written, membership, selected[bin]].map((resource, binding) => ({
            binding,
            resource: { buffer: resource },
          })),
        }),
      );
      for (const replay of [0, 1]) {
        const encoder = device.createCommandEncoder();
        encoder.clearBuffer(written);
        encoder.clearBuffer(membership);
        owner.encode(encoder, bindings);
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        for (let bin = 0; bin < binCount; bin++) {
          pass.setBindGroup(0, groups[bin]);
          pass.dispatchWorkgroupsIndirect(owner.queue, owner.indirectOffset(bin));
        }
        pass.end();
        const readbacks = await Promise.all(
          [written, membership, owner.queue, owner.scratch].map((source) => read(encoder, source)),
        );
        device.queue.submit([encoder.finish()]);
        const values = [];
        for (const readback of readbacks) {
          await readback.mapAsync(GPUMapMode.READ);
          values.push(new Uint32Array(readback.getMappedRange()).slice());
          readback.unmap();
        }
        const [writers, actual, queue, scratch] = values;
        check(
          scratch[0] === expectedInvalid && scratch[1] === 0,
          `${fixture.name} classification/capacity invariant failure: ${scratch[0]}/${scratch[1]} expected ${expectedInvalid}/0`,
        );
        const counts = new Uint32Array(binCount);
        for (let at = 0; at < pixels; at++) {
          const valid = expected[at] >= 0;
          check(
            writers[at] === (valid ? 1 : 0),
            `${fixture.name} replay ${replay}: pixel ${at} has ${writers[at]} writers`,
          );
          check(actual[at] === expected[at] + 1, `${fixture.name} replay ${replay}: wrong bin for ${at}`);
          if (valid) counts[expected[at]]++;
        }
        const tilesX = Math.ceil(width / 8);
        const tileCapacity = tilesX * Math.ceil(height / 8);
        const expectedTiles = Array.from({ length: binCount }, () => new Set());
        for (let at = 0; at < pixels; at++) {
          if (expected[at] >= 0)
            expectedTiles[expected[at]].add(
              Math.floor((at % width) / 8) + Math.floor(Math.floor(at / width) / 8) * tilesX,
            );
        }
        for (let bin = 0; bin < binCount; bin++) {
          const base = binCount * 8 + bin * tileCapacity * 3;
          check(queue[bin * 8] === base, `${fixture.name} incorrect tile bank at bin ${bin}`);
          check(
            queue[bin * 8 + 1] === expectedTiles[bin].size,
            `${fixture.name} incorrect tile count at bin ${bin}`,
          );
          const seen = new Set();
          for (let at = 0; at < queue[bin * 8 + 1]; at++) {
            const packed = queue[base + at * 3];
            const tile = packed & 0x7fffffff;
            check(
              expectedTiles[bin].has(tile) && !seen.has(tile),
              `${fixture.name} duplicate or unexpected tile`,
            );
            seen.add(tile);
            let primitive;
            for (let lane = 0; lane < 64; lane++) {
              const active = (queue[base + at * 3 + 1 + Math.floor(lane / 32)] >>> lane % 32) & 1;
              const x = (tile % tilesX) * 8 + (lane % 8);
              const y = Math.floor(tile / tilesX) * 8 + Math.floor(lane / 8);
              const valid = x < width && y < height && expected[y * width + x] === bin;
              check(active === Number(valid), `${fixture.name} wrong exact tile mask`);
              if (packed >>> 31) {
                check(valid, `${fixture.name} uniform primitive flag on partial tile`);
                const key = keys[y * width + x];
                primitive ??= key;
                check(key === primitive, `${fixture.name} incorrect uniform primitive flag`);
              }
            }
          }
        }
        if (fixture.uniform && !fixture.primitive)
          check(queue[3] > 1, "High-count fixture did not exercise 2D indirect dispatch");
        if (fixture.primitive) check(scratch[3] === tileCapacity, "Uniform primitive classification missing");
      }
      reports.push({
        name: fixture.name,
        pixels,
        bins: binCount,
        dispatches: owner.plan.dispatches,
        queueBytes: owner.plan.queueBytes,
        scratchBytes: owner.plan.scratchBytes,
        checked:
          "winner/material routing, exact membership, one writer, background, exact tile masks, uniform primitive flags, empty bins, indirect, replay",
      });
      await owner.retire(device.queue.onSubmittedWorkDone());
    }
    return {
      status: "passed",
      scope: "tile execution-bins component, no performance claim",
      reports,
    };
  } finally {
    for (const owner of owners) owner.destroy();
    for (const resource of resources) resource.destroy();
  }
}
