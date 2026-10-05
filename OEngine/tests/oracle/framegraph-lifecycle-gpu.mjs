import {
  FrameGraph,
  FrameGraphBindingLayout,
  FrameGraphContext,
  FrameGraphResourceManager,
} from "../../.test-dist/framegraph/FrameGraph.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { GPUBufferAllocator } from "../../.test-dist/gpu/GPUBufferAllocator.js";
import { GPUTextureAllocator } from "../../.test-dist/gpu/GPUTextureAllocator.js";
import { FrameProfiler } from "../../.test-dist/debug/FrameProfiler.js";
import { ResourceAccounting } from "../../.test-dist/debug/profiling/ResourceAccounting.js";
import { SurfaceFrameResources } from "../../.test-dist/render/surface/SurfaceFrameResources.js";
import { SurfaceDiagnosticsPass } from "../../.test-dist/render/surface/SurfaceDiagnosticsPass.js";
import { surfaceCellWorkspaceLayout } from "../../.test-dist/gpu/GpuSurfaceCellPlanAbi.js";
import { surfaceDemandLayout } from "../../.test-dist/gpu/GpuSurfaceDemandAbi.js";
import {
  decodeSurfaceDiagnostics,
  SURFACE_DIAGNOSTICS_BYTE_SIZE,
} from "../../.test-dist/gpu/SurfaceDiagnosticsAbi.js";
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
export async function runFrameGraphLifecycleGpuOracle(device) {
  const ledger = new ResourceAccounting(),
    profiler = new FrameProfiler({
      enabled: true,
      gpuTimingMode: "full",
      gpuSampleInterval: 1,
      gpuTimestampAvailable: true,
    });
  profiler.attachResourceAccounting(ledger);
  profiler.attachGpuDevice(device);
  const graphics = {
    device,
    profiler,
    buffer_allocator_main: new GPUBufferAllocator(device, ledger),
    buffer_allocator_staging: { release() {} },
    allocator_textures: new GPUTextureAllocator(device, ledger),
  };
  const output = device.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: {
      module: device.createShaderModule({
        code: "@group(0) @binding(0) var<storage,read_write> v:array<u32>; @compute @workgroup_size(1) fn main(){v[0]+=1u;}",
      }),
      entryPoint: "main",
    },
  });
  const scratch = new SurfaceFrameResources(device, ledger, 4096);
  const made = [];
  try {
    const graph = new FrameGraph("A1 real lifetimes");
    let first, second;
    function increment(command, buffer, label) {
      const pass = command.beginComputePass({ label });
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer } }],
        }),
      );
      pass.dispatchWorkgroups(1);
      pass.end();
    }
    const a = graph.add("Surface/first", {}, (_, r, c) => {
      made.push(r.get(first));
      increment(c.encoder, r.get(first), "Surface/first");
    });
    first = a.create("first", {
      kind: "transient_buffer",
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      ensure_cleared: [0, 4],
    });
    const readA = graph.add("read first", {}, (_, r, c) =>
      c.encoder.copyBufferToBuffer(r.get(first), 0, output, 0, 4),
    );
    readA.read(first);
    readA.make_side_effect();
    const b = graph.add("Surface/second", {}, (_, r, c) => {
      made.push(r.get(second));
      increment(c.encoder, r.get(second), "Surface/second");
    });
    second = b.create("second", {
      kind: "transient_buffer",
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      ensure_cleared: [0, 4],
    });
    const readB = graph.add("read second", {}, (_, r, c) =>
      c.encoder.copyBufferToBuffer(r.get(second), 0, output, 4, 4),
    );
    readB.read(second);
    readB.make_side_effect();
    profiler.beginFrame(1);
    const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    command.encodeGraph(graph);
    check(made[0] === made[1], "nonoverlap transient scopes must alias one physical buffer");
    check(
      graphics.buffer_allocator_main.evidence().pendingCount === 1,
      "encoded buffer must remain pending before submission",
    );
    command.finish();
    profiler.endFrame();
    await command.gpuDone;
    await output.mapAsync(GPUMapMode.READ);
    const values = Array.from(new Uint32Array(output.getMappedRange()));
    output.unmap();
    check(values[0] === 1 && values[1] === 1, `clear/producer/copy consumer mismatch: ${values}`);
    for (let i = 0; i < 100 && profiler.latest.gpu.pending; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const frame = profiler.latest;
    check(!frame.gpu.pending, "timer readback must finish");
    check(frame.gpu.cost.commandSpanMs !== null, "production context did not publish same-command span");
    check(frame.counters["gpu.commands.copyBytes"] === 8, "copy bytes must be actual consumer ranges");
    check(
      frame.counters["gpu.commands.clearBytes"] === 4,
      "new WebGPU buffer zero init needs no clear; aliased allocation must clear exactly four bytes",
    );
    check(frame.counters["gpu.timing.queries"] > 0, "production profiler must record query tax");

    // A graph built at one extent is reused after another extent and returning.
    const cache = new Map();
    const physical = [];
    for (const [index, width] of [
      [2, 4],
      [3, 8],
      [4, 4],
    ]) {
      scratch.prepare(width, 1);
      const initial = {};
      let compiled = cache.get(width);
      if (!compiled) {
        const layout = new FrameGraphBindingLayout(),
          g = new FrameGraph("cached scratch " + width);
        const buffer = scratch.importBuffer(
          g,
          (_name, resolve) => layout.slot("scratch", initial, resolve),
          "extent",
          width,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        );
        const p = g.add("scratch consume", {}, (_, r, c) => {
          const value = r.get(buffer);
          check(value.size === width, "stale resized resource bound");
          physical.push(value);
          increment(c.encoder, value, "scratch consume");
        });
        p.write(buffer);
        compiled = g.compile();
        cache.set(width, compiled);
      }
      profiler.beginFrame(index);
      const ctx = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      ctx.encodeCompiledGraph(compiled, {});
      ctx.finish();
      scratch.commit(ctx.gpuDone);
      profiler.endFrame();
      await ctx.gpuDone;
    }
    check(physical[0] !== physical[2], "returned recipe must not pin the retired first extent");
    for (const g of cache.values()) g.destroy();
    scratch.destroy();
    await Promise.resolve();

    // Native fallback must also retain resources until the explicit queue fence.
    let complete;
    const fence = new Promise((resolve) => (complete = resolve)),
      fallback = new FrameGraph("native fallback");
    let work;
    const p = fallback.add("compute", {}, (_, r, c) => {
      const pass = c.encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: r.get(work) } }],
        }),
      );
      pass.dispatchWorkgroups(1);
      pass.end();
    });
    work = p.create("native", {
      kind: "transient_buffer",
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const consumer = fallback.add("readback", {}, (_, r, c) =>
      c.encoder.copyBufferToBuffer(r.get(work), 0, output, 0, 4),
    );
    consumer.read(work);
    consumer.make_side_effect();
    const encoder = device.createCommandEncoder();
    fallback.compile().execute(new FrameGraphContext({ device, encoder, completion: fence }), undefined);
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    await output.mapAsync(GPUMapMode.READ);
    check(new Uint32Array(output.getMappedRange())[0] === 1, "native fallback destroyed before submission");
    output.unmap();
    complete();
    await Promise.resolve();
    const diagnostic = await checkDiagnosticSnapshot(device);
    return {
      passed: true,
      values,
      physicalTransientAllocations: new Set(made).size,
      cachedResizePhysicalIdentities: new Set(physical).size,
      cpuEncodeMs: frame.cpuMs["graph-execute"],
      timingCost: frame.gpu.cost,
      timingTax: frame.counters,
      diagnostic,
      scope:
        "real compiled executor/command owner/resource lifetime and diagnostic WGSL; not full Surface or historical performance acceptance",
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    scratch.destroy();
    graphics.buffer_allocator_main.destroy();
    graphics.allocator_textures.destroy();
    profiler.destroy();
    output.destroy();
  }
}

async function checkDiagnosticSnapshot(device) {
  const workspaceLayout = surfaceCellWorkspaceLayout(1),
    demandLayout = surfaceDemandLayout(64, 1),
    buffers = [];
  const make = (bytes, data) => {
    const buffer = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    buffers.push(buffer);
    if (data) device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };
  const workspaceWords = new Uint32Array(workspaceLayout.bytes / 4);
  workspaceWords[125] = 1;
  workspaceWords[127] = 1;
  // One visible lane; all other facts are background, independently declared.
  const facts = new Uint32Array(workspaceWords.buffer, workspaceLayout.facts, 64 * 4);
  facts.fill(0xffffffff);
  facts.set([1, 0, 2, 0], 0);
  const demandWords = new Uint32Array(demandLayout.bytes / 4);
  demandWords[0] = 7;
  demandWords[5] = 3;
  demandWords[6] = 2;
  const workspace = make(workspaceLayout.bytes, workspaceWords),
    demand = make(demandLayout.bytes, demandWords),
    reconstruct = make(32, new Uint32Array([64, 0, 0, 0, 0, 0, 0, 1]));
  const output = device.createBuffer({
    size: SURFACE_DIAGNOSTICS_BYTE_SIZE,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  let complete;
  const fence = new Promise((resolve) => (complete = resolve)),
    encoder = device.createCommandEncoder();
  const uploads = [];
  const command = {
    gpu_encoder: encoder,
    beginComputePass: (d) => encoder.beginComputePass(d),
    allocateTransientBuffer(usage, size) {
      const b = device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
      uploads.push(b);
      return b;
    },
    writeBuffer(buffer, offset, data, start, size) {
      device.queue.writeBuffer(buffer, offset, data, start, size);
    },
  };
  const graph = new FrameGraph("production diagnostics"),
    imported = (b) => graph.import_resource("fixture", { kind: "imported" }, b);
  const owner = new SurfaceDiagnosticsPass(device, (ctx, source) =>
    ctx.gpu_encoder.copyBufferToBuffer(source, 0, output, 0, SURFACE_DIAGNOSTICS_BYTE_SIZE),
  );
  owner.addToGraph(graph, {
    demand: { workspace: imported(workspace), arena: imported(demand), layout: demandLayout },
    reconstruct: imported(reconstruct),
    after: imported(demand),
    width: 8,
    height: 8,
    firstTile: 0,
    tileCount: 1,
    last: true,
    frameId: { value: 17 },
  });
  try {
    graph.compile().execute(
      new FrameGraphContext({
        device,
        encoder: command,
        resource_manager: new FrameGraphResourceManager(device, fence),
      }),
      undefined,
    );
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    await output.mapAsync(GPUMapMode.READ);
    const data = output.getMappedRange().slice(0);
    output.unmap();
    complete();
    await Promise.resolve();
    const snapshot = decodeSurfaceDiagnostics(
      data,
      { runId: "oracle", deviceEpoch: 1, frameId: 17 },
      "detailed",
    );
    check(
      snapshot.values.totalTiles === 1 && snapshot.values.visiblePixels === 1,
      "actual coverage scan counter mismatch",
    );
    check(snapshot.values.geometryDescriptions === 7, "description count lost");
    check(snapshot.values.geometryRecordStrideWords === 32, "byte/word stride unit mismatch");
    check(
      snapshot.values.geometryMissCompleted === undefined &&
        snapshot.values.materialEvaluatorCompleted === undefined,
      "queued work falsely published as completed",
    );
    check(snapshot.coverage.status === "unknown", "missing completion producers must not certify coverage");
    return { values: snapshot.values, coverage: snapshot.coverage };
  } finally {
    complete();
    owner.destroy();
    output.destroy();
    for (const b of [...buffers, ...uploads]) b.destroy();
  }
}
