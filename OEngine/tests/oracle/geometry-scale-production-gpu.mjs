import { triangleProductFixture } from "../helpers/geometry-product-fixture.mjs";
import { Renderer } from "../../.test-dist/render/pipeline/RendererCore.js";
import { Scene } from "../../.test-dist/scene/Scene.js";
import { PerspectiveCamera } from "../../.test-dist/camera/PerspectiveCamera.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { ShadeDrawSide } from "../../.test-dist/material/enums.js";
import { GeometryProductMultiRuntimeV1 } from "../../.test-dist/gpu/GeometryProductMultiRuntime.js";
import {
  buildVirtualGeometrySceneSourceV1,
  mergeVirtualGeometryProductSceneSourcesV1
} from "../../.test-dist/assets/geometry-product/VirtualGeometrySceneSourceV1.js";
import { GPU_INSTANCE_FLAGS } from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK } from "../../.test-dist/gpu/GpuVisibilityKeyAbi.js";
import { geometryProductGpuBudgetEvidence } from "../../.test-dist/gpu/GeometryProductGpuBudget.js";
import { decodeFloat16 } from "../../.test-dist/core/Float16.js";
import { summarizeGpuTimingCost } from "../../.test-dist/debug/GpuTimingCost.js";

function check(value, message) {
  if (!value) throw new Error(message);
}
function distribution(values) {
  check(values.length > 0 && values.every(Number.isFinite), "Missing finite scale cost");
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1)
  };
}

// Actual Renderer, exhaustive grid of nonoverlapping resident triangle instances.
// This tests raster/winner completeness at scale, not authored PBR/streaming quality.
async function runCase(count, productCount) {
  const width = 1920,
    height = 1080;
  const renderer = new Renderer({
    autoExposure: false,
    fixedExposure: 1,
    requiredFeatures: ["timestamp-query"]
  });
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("webgpu");
  check(context, "Scale canvas unavailable");
  let runtime;
  const buffers = [];
  const errors = [];
  const releases = new Uint32Array(productCount);
  try {
    await renderer.initialize({ context });
    renderer.resize(width, height);
    renderer.temporal_jitter_enabled = false;
    renderer.perf_gpu_counters_enabled = true;
    const device = renderer.device;
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    runtime = new GeometryProductMultiRuntimeV1(device, {
      slotCapacity: Math.max(64, productCount),
      residency: { configuredCapacityBytes: 64 * 1024 * 1024 }
    });
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    camera.aspect = width / height;
    camera.fov_degrees = 60;
    camera.transform.position.set(0, 0, 4);
    camera.transform.lookAt({ x: 0, y: 0, z: 0 });
    camera.update();
    const material = new StandardShadeMaterial();
    material.is_unlit = true;
    material.draw_side = ShadeDrawSide.Double;
    material.diffuse_color.set(0.2, 0.3, 0.1, 1);
    const profile = {
      hasAuthoredVertexColor: false,
      hasUv0: false,
      hasUv1: false,
      hasUv2: false,
      hasNormal: false,
      hasTangent: false
    };
    const columns = count === 100000 ? 400 : 100;
    const rows = count / columns;
    const cellWidth = 6 / columns,
      cellHeight = 3.75 / rows;
    const parts = [],
      shards = [];
    for (let product = 0; product < productCount; product++) {
      const { descriptor, page } = triangleProductFixture();
      descriptor.productId.fill(product + 1);
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", page)).subarray(0, 16);
      descriptor.pageRecords.set(hash);
      const shard = await runtime.load({
        descriptor,
        async readPage(pageId) {
          check(pageId === 0, "Unexpected terminal page");
          return {
            productId: descriptor.productId,
            revision: 0,
            pageId,
            decodedHash128: hash,
            decodedPageHash128: hash,
            bytes: page.slice().buffer
          };
        },
        release() {
          releases[product]++;
        }
      });
      shards.push(shard);
      const instances = [];
      for (let index = product; index < count; index += productCount) {
        const x = ((index % columns) + 0.5) * cellWidth - 3;
        const y = (Math.floor(index / columns) + 0.5) * cellHeight - 1.875;
        instances.push({
          assetIndex: 0,
          materialIndex: 0,
          flags: GPU_INSTANCE_FLAGS.DoubleSided,
          transform: new Float32Array([
            cellWidth * 0.9,
            0,
            0,
            0,
            0,
            cellHeight * 0.9,
            0,
            0,
            0,
            0,
            1,
            0,
            x,
            y,
            0,
            1
          ])
        });
      }
      const mapped = buildVirtualGeometrySceneSourceV1(descriptor, [profile], instances, [material]);
      parts.push({
        source: mapped.source,
        productTableSlot: shard.productTableSlot,
        productGeneration: shard.productGeneration,
        assetReferenceBegin: shard.assetReferenceBegin
      });
    }
    const source = mergeVirtualGeometryProductSceneSourcesV1(parts);
    check(source.count === count, "Incomplete procedural instance union");
    await renderer.uploadVirtualGeometryScene(scene, source, shards[0].residency, null, undefined, {
      bindings: runtime.bindings(),
      assetCount: source.assetCount,
      multiRuntime: runtime
    });
    const surface = renderer._surface;
    let frame,
      inspectNext = false,
      captures;
    const prepare = surface.prepareFrameNow.bind(surface);
    surface.prepareFrameNow = (prepared, bins) => {
      frame = prepared;
      prepare(prepared, bins);
    };
    const encode = surface.encode.bind(surface);
    surface.encode = (encoder) => {
      encode(encoder);
      if (!inspectNext) return;
      const read = (size) => {
        const buffer = device.createBuffer({
          size,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
        buffers.push(buffer);
        return buffer;
      };
      const hdrRow = Math.ceil((width * 8) / 256) * 256;
      const winnerRow = Math.ceil((width * 4) / 256) * 256;
      captures = {
        work: read(frame.geometry.meshletWork.size),
        hdr: read(hdrRow * height),
        winner: read(winnerRow * height),
        hdrRow,
        winnerRow
      };
      encoder.copyBufferToBuffer(frame.geometry.meshletWork, 0, captures.work, 0, captures.work.size);
      encoder.copyTextureToBuffer({ texture: frame.output }, { buffer: captures.hdr, bytesPerRow: hdrRow }, [
        width,
        height
      ]);
      encoder.copyTextureToBuffer(
        { texture: frame.visibility },
        { buffer: captures.winner, bytesPerRow: winnerRow },
        [width, height]
      );
    };
    const tick = async () => {
      const first = renderer.frame_count;
      for (let attempt = 0; attempt < 300; attempt++) {
        const start = performance.now();
        renderer.render(camera, scene, 1 / 60);
        const cpuMs = performance.now() - start;
        await device.queue.onSubmittedWorkDone();
        if (renderer.frame_count !== first) return cpuMs;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Scale Scene never became renderable");
    };
    for (let frame = 0; frame < 16; frame++) await tick();
    renderer.profiler.setMode("record");
    renderer.profiler.configure({
      enabled: true,
      gpuSampleInterval: 1,
      gpuTimingMode: "full",
      historyCapacity: 128
    });
    const first = renderer.frame_count,
      cpu = [];
    for (let frame = 0; frame < 16; frame++) cpu.push(await tick());
    inspectNext = true;
    await tick();
    inspectNext = false;
    await Promise.all([captures.work, captures.hdr, captures.winner].map((b) => b.mapAsync(GPUMapMode.READ)));
    const work = new Uint32Array(captures.work.getMappedRange());
    check(work[1] === count && work[4] === 0 && work[6] === 0, `Scale work incomplete: ${work[1]}/${count}`);
    const workInstances = new Set();
    const instanceBegin = renderer.graphics.render_world.runtime(scene).instanceBegin;
    for (let slot = 0; slot < count; slot++) {
      const instance = work[8 + slot * 6];
      check(
        instance >= instanceBegin && instance < instanceBegin + count && !workInstances.has(instance),
        `Scale work lost/duplicated instance: slot=${slot} instance=${instance} begin=${instanceBegin} count=${count}`
      );
      workInstances.add(instance);
    }
    const winners = new Uint32Array(captures.winner.getMappedRange());
    const colors = new Uint16Array(captures.hdr.getMappedRange());
    const visibleInstances = new Set();
    let visiblePixels = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const key = winners[(y * captures.winnerRow) / 4 + x];
        if (key === 0xffffffff) continue;
        const slot = key & GPU_VISIBILITY_KEY_MESHLET_WORK_SLOT_MASK;
        check(slot < count && key >>> 24 === 0, "Illegal terminal winner identity");
        visibleInstances.add(work[8 + slot * 6]);
        visiblePixels++;
        const pixel = (y * captures.hdrRow) / 2 + x * 4;
        for (let c = 0; c < 3; c++)
          check(Number.isFinite(decodeFloat16(colors[pixel + c])), "Nonfinite scale HDR");
      }
    check(visibleInstances.size === count, `Raster lost ${count - visibleInstances.size} accepted instances`);
    for (const buffer of [captures.work, captures.hdr, captures.winner]) buffer.unmap();
    for (let attempt = 0; attempt < 100; attempt++) {
      const ready = renderer.profiler.history.filter(
        (p) => p.frameIndex >= first && p.frameIndex < first + 16 && !p.gpu.pending
      );
      if (ready.length === 16) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const profiles = renderer.profiler.history.filter(
      (p) => p.frameIndex >= first && p.frameIndex < first + 16
    );
    check(
      profiles.length === 16 &&
        profiles.every(
          (p) =>
            p.gpu.sampled && !p.gpu.pending && !p.counters["gpu.timing.truncated"] && p.submits.count === 1
        ),
      "Incomplete scale timing/extra submit"
    );
    const costs = profiles.map((p) => summarizeGpuTimingCost(p.gpu.segments));
    const result = {
      count,
      productCount,
      visiblePixels,
      uniqueWinnerInstances: visibleInstances.size,
      cpuEncodeMs: distribution(cpu),
      frameGpuMs: distribution(costs.map((c) => c.commandSpanMs)),
      memory: renderer.memoryEvidence(),
      productCapacity: geometryProductGpuBudgetEvidence(device),
      profiles,
      sourceProfile:
        "Resident procedural position-only triangle; Unlit; no authored textures/streaming/shadow casters"
    };
    check(errors.length === 0, `Scale GPU errors: ${errors.join(" | ")}`);
    await renderer.releaseVirtualGeometryScene(scene);
    runtime.destroy();
    check(
      releases.every((value) => value === 1),
      "Product source release must occur exactly once"
    );
    check(geometryProductGpuBudgetEvidence(device).totalBytes === 0, "Scale Product budget leaked");
    return result;
  } finally {
    buffers.forEach((buffer) => buffer.destroy());
    runtime?.destroy();
    renderer.destroy();
  }
}

export async function runGeometryScaleProductionGpuOracle() {
  const cases = [];
  for (const [count, products] of [
    [10000, 8],
    [100000, 66]
  ])
    cases.push(await runCase(count, products));
  return {
    cases,
    limitations: [
      "Scale completeness and diagnostic costs; not authored PBR/streaming quality or matched historical performance"
    ]
  };
}
