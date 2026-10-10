// Diagnostic host only. Hooks are restored before disposal; no producer uses
// these readbacks to schedule rendering. Entropy runs after timing has stopped.
import { Renderer } from "../../../OEngine/src/render/Renderer.ts";
import { OrbitControls } from "../../../OEngine/src/camera/OrbitControls.ts";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../../../OEngine/src/gpu/GpuMeshletRasterWorkAbi.ts";
import { GPU_VISIBILITY_KEY_WGSL } from "../../../OEngine/src/gpu/GpuVisibilityKeyAbi.ts";
import { GPU_FRAME_INSTANCE_WGSL } from "../../../OEngine/src/gpu/GpuFrameInstanceAbi.ts";
import { GPU_INSTANCE_RECORD_WGSL } from "../../../OEngine/src/gpu/GpuInstanceAbi.ts";
import { NATIVE_MATERIAL_DIRECTORY_WGSL } from "../../../OEngine/src/gpu/GpuNativeMaterialPublication.ts";
import { FRAME_GEOMETRY_ARENA_HEADER_WORDS as H } from "../../../OEngine/src/gpu/GpuFrameGeometryArenaAbi.ts";

const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const summarize = values => {
  const sorted = values.slice().sort((a, b) => a - b);
  return { n: sorted.length, p50: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null };
};

export async function install() {
  let renderer, camera, scene, controls, latestSurface, paused = false;
  const originalRender = Renderer.prototype.render;
  const originalUpdate = OrbitControls.prototype.update;
  Renderer.prototype.render = function (view, world, ...args) {
    renderer = this; camera = view; scene = world;
    Renderer.prototype.render = originalRender;
    return originalRender.call(this, view, world, ...args);
  };
  OrbitControls.prototype.update = function (...args) {
    controls = this;
    OrbitControls.prototype.update = originalUpdate;
    return originalUpdate.apply(this, args);
  };
  for (let attempt = 0; (!renderer || !controls) && attempt < 300; attempt++) await frame();
  if (!renderer || !controls) throw new Error("Bistro did not provide a live renderer/camera");
  const render = renderer.render;
  const prepare = renderer._surface.prepareFrameNow;
  const update = controls.update;
  let trajectory = "static", startFrame = renderer.frame_count;
  let cpu = [], callbacks = 0;
  renderer._surface.prepareFrameNow = function (input, ...args) {
    latestSurface = input;
    return prepare.call(this, input, ...args);
  };
  renderer.render = function (...args) {
    if (paused) return false;
    callbacks++;
    const before = this.frame_count, begin = performance.now();
    const result = render.apply(this, args);
    if (this.frame_count > before) cpu.push({ frame: before, ms: performance.now() - begin, at: begin });
    return result;
  };
  controls.update = function () {
    const progress = renderer.frame_count - startFrame;
    const angle = progress * (trajectory === "slow" ? 0.002 : trajectory === "fast" ? 0.012 : 0);
    this.look({ x: 20 + Math.sin(angle) * 50, y: 5, z: 5 - Math.cos(angle) * 50 }, { x: 20, y: 5, z: 5 });
    camera.update();
  };

  async function settle({ width, height }) {
    paused = true;
    await renderer.device.queue.onSubmittedWorkDone();
    renderer.pixel_ratio = 1;
    renderer.resize(width, height, true);
    camera.aspect = width / height;
    trajectory = "static";
    startFrame = renderer.frame_count;
    renderer.profiler.configure({ enabled: false });
    renderer.perf_gpu_counters_enabled = false;
    paused = false;
    const deadline = performance.now() + 180000;
    let previous, stable = 0, lastPoll = 0;
    while (stable < 20 || renderer.frame_count - startFrame < 240) {
      await frame();
      if (performance.now() - lastPoll < 250) continue;
      lastPoll = performance.now();
      const report = window.bistroDemo.report();
      if (report.failure) throw new Error(JSON.stringify(report.failure));
      const key = JSON.stringify(report.streaming?.products.map(product =>
        [product.residentPages, product.uploadedBytes, product.retiringPages, product.failedPages]));
      stable = key === previous ? stable + 1 : 0;
      previous = key;
      if (performance.now() > deadline) throw new Error(`Geometry residency did not settle at the capture camera: ${JSON.stringify({submitted: renderer.frame_count - startFrame, stablePolls: stable, streaming: report.streaming, admission: renderer.frameSubmissionEvidence()})}`);
    }
    paused = true;
    await renderer.device.queue.onSubmittedWorkDone();
    return { submitted: renderer.frame_count - startFrame, streaming: window.bistroDemo.report().streaming };
  }

  async function capture({ width, height, samples = 120, warmup = 30, motion = "static", timing = true,
    hzbRecovery = true, admissionProfile = "latency", variant = "on-latency" }) {
    paused = true;
    await renderer.device.queue.onSubmittedWorkDone();
    renderer.packed_visibility_current_hzb_late_recheck_enabled = hzbRecovery;
    renderer.frameAdmissionProfile = admissionProfile;
    renderer.pixel_ratio = 1;
    renderer.resize(width, height, true);
    camera.aspect = width / height;
    camera.update();
    renderer.invalidateTemporalHistory();
    trajectory = motion;
    startFrame = renderer.frame_count;
    const profiler = renderer.profiler;
    profiler.setMode(timing ? "record" : "live");
    profiler.configure({ enabled: timing, gpuTimingMode: timing ? "full" : "production",
      gpuSampleInterval: 1, gpuCounterSampleInterval: 8, historyCapacity: 512, warmupFrames: 0 });
    renderer.perf_gpu_counters_enabled = timing;
    const targetStart = startFrame + warmup, targetEnd = targetStart + samples;
    const gpu = new Map();
    const unsubscribe = profiler.subscribe(snapshot => {
      if (snapshot.frameIndex >= targetStart && snapshot.frameIndex < targetEnd &&
          snapshot.gpu.sampled && !snapshot.gpu.pending) gpu.set(snapshot.frameIndex, snapshot);
    });
    const beforeAdmission = renderer.frameSubmissionEvidence();
    cpu = []; callbacks = 0; paused = false;
    const deadline = performance.now() + 120000;
    while (renderer.frame_count < targetEnd || (timing && gpu.size < samples)) {
      if (performance.now() > deadline) throw new Error(`Incomplete capture: frame ${renderer.frame_count}, GPU ${gpu.size}/${samples}`);
      if (renderer.frame_count >= targetEnd) paused = true;
      await frame();
    }
    paused = true;
    await renderer.device.queue.onSubmittedWorkDone();
    unsubscribe();
    const normalCpu = cpu.filter(sample => sample.frame >= targetStart && sample.frame < targetEnd);
    const snapshots = [...gpu.values()];
    const labels = new Set(snapshots.flatMap(sample => sample.gpu.segments.filter(segment => segment.scope === "pass").map(segment => segment.label)));
    const passes = Object.fromEntries([...labels].map(label => [label, summarize(snapshots.map(sample =>
      sample.gpu.segments.filter(segment => segment.scope === "pass" && segment.label === label).reduce((sum, segment) => sum + segment.durationMs, 0)))]));
    const entropy = await inspect(renderer, latestSurface, scene);
    const report = window.bistroDemo.report();
    const intervals = normalCpu.slice(1).map((sample, index) => sample.at - normalCpu[index].at);
    const submissionSpan = normalCpu.at(-1).at - normalCpu[0].at;
    return { motion, timing, variant, cpu: summarize(normalCpu.map(sample => sample.ms)),
      scheduling: { submittedFps: (normalCpu.length - 1) * 1000 / submissionSpan,
        submissionIntervalsMs: summarize(intervals), intervalsOver25Ms: intervals.filter(value => value > 25).length,
        completionDeferrals: renderer.frameSubmissionEvidence().completionDeferredTicks - beforeAdmission.completionDeferredTicks,
        historyDeferrals: renderer.frameSubmissionEvidence().historyDeferredTicks - beforeAdmission.historyDeferredTicks },
      gpuCommandSpan: summarize(snapshots.map(sample => sample.gpu.cost.commandSpanMs)), passes,
      gpuCounters: snapshots.filter(sample => sample.gpuCounters.sampled && !sample.gpuCounters.pending).map(sample => ({ frame: sample.frameIndex, values: sample.gpuCounters.values })),
      callbacks, submitted: cpu.length, admissionBefore: beforeAdmission, admissionAfter: renderer.frameSubmissionEvidence(),
      conditions: { adapter: renderer.adapter_info, userAgent: navigator.userAgent, resolution: renderer.resolutionEvidence(),
        sse: renderer.packed_visibility_sse_threshold, camera: { start: [20, 5, -45], target: [20, 5, 5], motion, radiansPerFrame: motion === "slow" ? 0.002 : motion === "fast" ? 0.012 : 0 },
        effects: { fsr3: renderer.fsr3_enabled, bloom: renderer.bloom_enabled, gtao: renderer.xe_gtao_enabled,
          vsm: renderer.shadowVisibilityEnabled, previousHzb: renderer.packed_visibility_hzb_enabled,
          hzbRecovery, admissionProfile },
        asset: report.asset, quality: report.quality }, entropy, diagnostics: renderer.profiler.diagnostics,
      raw: snapshots.map(sample => ({ frameIndex: sample.frameIndex, gpu: sample.gpu, counters: sample.counters, gpuCounters: sample.gpuCounters })) };
  }
  return { settle, capture, dispose() {
    paused = true;
    renderer.render = render;
    renderer._surface.prepareFrameNow = prepare;
    controls.update = update;
    renderer.perf_gpu_counters_enabled = false;
    renderer.profiler.setMode("live");
    renderer.profiler.configure({ enabled: false, gpuTimingMode: "production" });
  } };
}

async function inspect(renderer, input, scene) {
  if (!input) throw new Error("No completed Surface input");
  const device = renderer.device, bins = input.publication.bins.length;
  const tilesX = Math.ceil(input.width / 8), tilesY = Math.ceil(input.height / 8);
  const resources = [];
  const buffer = (size, usage) => { const result = device.createBuffer({ size, usage }); resources.push(result); return result; };
  async function read(source, offset, size) {
    const output = buffer(size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, offset, output, 0, size);
    device.queue.submit([encoder.finish()]);
    await output.mapAsync(GPUMapMode.READ);
    const result = new Uint32Array(output.getMappedRange()).slice();
    output.unmap();
    return result;
  }
  device.pushErrorScope("validation");
  try {
    const stats = buffer((8 + bins) * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const source = `${GPU_INSTANCE_RECORD_WGSL}\n${GPU_FRAME_INSTANCE_WGSL}\n${GPU_MESHLET_RASTER_WORK_WGSL}\n${GPU_VISIBILITY_KEY_WGSL}\n${NATIVE_MATERIAL_DIRECTORY_WGSL}
@group(0) @binding(0) var visibility: texture_2d<u32>;
@group(0) @binding(1) var<storage, read> work: OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var<storage, read> instances: array<OEngineFrameInstanceRecord>;
@group(0) @binding(3) var<storage, read> materials: array<NativeMaterialDirectoryEntry>;
@group(0) @binding(4) var<storage, read_write> stats: array<atomic<u32>>;
var<workgroup> keys: array<u32, 64>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) lane: u32) {
  var bin = 0xffffffffu;
  if all(id.xy < textureDimensions(visibility)) {
    let decoded = oengine_visibility_key_decode(textureLoad(visibility, vec2i(id.xy), 0).r);
    if decoded.valid != 0u && decoded.empty == 0u {
      if decoded.meshlet_work_slot < min(work.header.written_count, work.header.capacity) {
        let record = work.elements[decoded.meshlet_work_slot];
        if record.instance_slot < arrayLength(&instances) && record.material_slot_or_range < arrayLength(&materials) {
          let material = materials[record.material_slot_or_range];
          if material.execution_bin < ${bins}u && instances[record.instance_slot].generation == work.header.generation {
            bin = material.execution_bin;
            atomicAdd(&stats[8u + bin], 1u);
          }
        }
      }
      if bin == 0xffffffffu { atomicAdd(&stats[5u], 1u); }
    }
  }
  keys[lane] = bin;
  workgroupBarrier();
  if lane == 0u {
    var distinct = 0u;
    var empty = 0u;
    for (var at = 0u; at < 64u; at++) {
      let key = keys[at];
      if key == 0xffffffffu { empty++; continue; }
      var first = true;
      for (var prior = 0u; prior < at; prior++) { if keys[prior] == key { first = false; break; } }
      if first { distinct++; }
    }
    if distinct == 0u { atomicAdd(&stats[0u], 1u); }
    else if distinct == 1u && empty == 0u { atomicAdd(&stats[1u], 1u); }
    else {
      atomicAdd(&stats[6u], 1u);
      if distinct <= 2u { atomicAdd(&stats[2u], 1u); }
      else if distinct <= 4u { atomicAdd(&stats[3u], 1u); }
      else { atomicAdd(&stats[4u], 1u); }
    }
  }
}`;
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module: device.createShaderModule({ code: source }), entryPoint: "main" } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: input.visibility.createView() },
      { binding: 1, resource: { buffer: input.geometry.meshletWork } },
      { binding: 2, resource: { buffer: input.geometry.instances } },
      { binding: 3, resource: { buffer: input.publication.directory } },
      { binding: 4, resource: { buffer: stats } },
    ] });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(tilesX, tilesY); pass.end();
    device.queue.submit([encoder.finish()]);
    const counts = await read(stats, 0, stats.size);
    const headerWord = input.geometry.sourcePayload[3] & 0x7fffffff;
    const header = await read(input.geometry.arena, headerWord * 4, 64);
    const directory = header[(input.geometry.sourcePayload[3] & 0x80000000) ? H.filteredDirectory : H.sourceDirectory];
    const geometry = await read(input.geometry.arena, directory * 4, 16);
    const queue = await read(input.geometry.meshletWork, 0, 32);
    const runtime = renderer._graphics.render_world.runtime(scene);
    const occlusion = renderer._visibilityFeature.implementation.currentHzbPrepared.get(runtime);
    const occlusionCounts = occlusion ? await read(occlusion.deferred, 0, 32) : null;
    const binOwner = renderer._surface.state.bins;
    const sets = renderer._graphics.texture_residency.bindings().bindingSets;
    const physicalBanks = [...new Map(sets.flatMap(set => set.bankDescriptors.map((bank, slot) =>
      [bank.segment, { segment: bank.segment, format: bank.formatClass, size: bank.sizeClass }]))).values()];
    const tileStats = binOwner.scratch ? await read(binOwner.scratch, 0, binOwner.scratch.size) : null;
    if (tileStats && (tileStats[0] || tileStats[1])) throw new Error(`Tile work invariant failure: ${tileStats[0]}/${tileStats[1]}`);
    const error = await device.popErrorScope();
    if (error || counts[5]) throw new Error(`Cost map malformed winners: ${counts[5]}; ${error?.message ?? ""}`);
    return { executionBins: bins, programs: new Set(input.publication.bins.map(bin => bin.programIndex)).size,
      continuations: input.publication.bins.filter(bin => input.publication.continuation(bin.programIndex)).length,
      tiles: { total: tilesX * tilesY, empty: counts[0], uniform: counts[1], twoOrLess: counts[2], threeOrFour: counts[3], overFour: counts[4], mixed: counts[6], mixedRatio: counts[6] / (tilesX * tilesY) },
      pixelsPerBin: [...counts.slice(8)], shadedPixels: counts.slice(8).reduce((sum, value) => sum + value, 0),
      queueBytes: binOwner.plan.queueBytes, scratchBytes: binOwner.plan.scratchBytes,
      physicalBanks, physicalBindingSets: sets.length,
      tileWork: tileStats ? { uniformClassTiles: tileStats[2], uniformPrimitiveTiles: tileStats[3],
        recordsPerBin: [...tileStats.slice(4)], records: tileStats.slice(4).reduce((sum, value) => sum + value, 0),
        writtenBytes: tileStats.slice(4).reduce((sum, value) => sum + value, 0) * 12 } : null,
      rasterClasses: input.publication.rasterClasses.length,
      rasterDraws: input.publication.rasterClasses.length * 8,
      occlusion: occlusionCounts ? { deferred: occlusionCounts[0], early: occlusionCounts[1],
        recovered: occlusionCounts[2], rejected: occlusionCounts[3],
        activeMeshlets: occlusionCounts[1] + occlusionCounts[2],
        indexCapacityBytes: occlusion.deferred.size,
        rasterDraws: input.publication.rasterClasses.length * 16 } : null,
      frameGeometry: { work: geometry[0], generation: geometry[1], candidateVertices: geometry[2], candidateTriangles: geometry[3], vertexCapacity: header[H.vertexCapacity], arenaBytes: input.geometry.arena.size },
      meshletQueueHeader: [...queue], materialPrograms: input.publication.entries.map(entry => ({ slot: entry.materialSlot, program: entry.programIndex, bin: entry.executionBin, bindingSet: entry.bindingSet, inputs: entry.program.inputs.map(input => input.name) })) };
  } finally {
    await device.queue.onSubmittedWorkDone();
    resources.forEach(resource => resource.destroy());
  }
}
