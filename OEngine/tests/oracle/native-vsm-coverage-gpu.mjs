import { NativeVisibilityPass } from "../../.test-dist/render/surface/NativeVisibilityPass.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { FrameGraph } from "../../.test-dist/framegraph/FrameGraph.js";
import { VsmCasterRecordPass } from "../../.test-dist/render/vsm/VsmCasterRecordPass.js";

/** Actual 32B header/16B pairs, borrowed Geometry, GPU raster partitions, VSM page addressing,
 * generation/dirty page validation and depth-only atlas writer. One authored
 * page deliberately covers the whole fixture; production VSM provider owns
 * culling/allocation/content publication, none is replaced by this test. */
export async function runNativeVsmCoverageGpuOracle(
  device,
  graphics,
  fixture,
  publication,
  routes,
  mainValues,
  viewBytes,
) {
  const retained = [];
  let seamOwner, pairOwner;
  const make = (data, usage) => {
    const buffer = device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
    buffer.unmap();
    retained.push(buffer);
    return buffer;
  };
  const words = new Uint32Array(8 + fixture.workCount * 4);
  words.set([
    fixture.workCount,
    fixture.workCount,
    0,
    fixture.generation,
    0,
    fixture.workCount,
    1,
    fixture.generation,
  ]);
  for (let work = 0; work < fixture.workCount; work++) words.set([work, 0, 0, 1], 8 + work * 4);
  const caster = make(words, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const pages = make(
    new Uint32Array([0, 0, 0, 11, fixture.generation, 0, 0, fixture.generation, 0, 0, 1, 0]),
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  );
  const constants = new Float32Array(60);
  constants.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  constants.set([1, 1], 12);
  constants.set([0, 0, 2, 0], 16);
  constants.set([-8, 8, 1 / 16, 1], 52);
  new Uint32Array(constants.buffer).set([fixture.generation, 1, 0, 0], 56);
  new Uint32Array(constants.buffer).set([1, 128, 2, 132, fixture.generation, 1, fixture.workCount, 1], 40);
  const settings = make(constants, GPUBufferUsage.UNIFORM);
  const boundsBytes = new Uint32Array(4 + fixture.workCount * 8);
  boundsBytes.set([fixture.workCount, 0, fixture.workCount, fixture.generation]);
  for (let work = 0; work < fixture.workCount; work++) {
    new Float32Array(boundsBytes.buffer).set([-1, -1, 3, 3], 4 + work * 8);
    boundsBytes.set([2, 1, 0, 0], 8 + work * 8);
  }
  const bounds = make(boundsBytes, GPUBufferUsage.STORAGE);
  const allocation = make(
    new Uint32Array([1, 1, 0, fixture.generation, 0, 0, 0, fixture.generation, 11, 0, 0, 0]),
    GPUBufferUsage.STORAGE,
  );
  const atlas = device.createTexture({
    size: [132, 132],
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  retained.push(atlas);
  const view = new Uint8Array(viewBytes.buffer.slice(0));
  new Uint32Array(view.buffer)[39] = fixture.generation;
  const owner = new NativeVisibilityPass(device, {
    geometry: { ...fixture.geometry, meshletWork: caster },
    publication,
    capacity: fixture.workCount,
    generation: fixture.generation,
    view,
    vsmAtlas: {
      constants: settings,
      pageTable: pages,
      allocation,
      source: fixture.geometry.meshletWork,
      bounds,
      sourceCapacity: fixture.workCount,
      pairCapacity: fixture.workCount,
      dirtyCapacity: 1,
    },
  });
  const output = device.createBuffer({
    size: 128 * 128 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: output.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  retained.push(output, readback);
  try {
    await owner.ready;
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: {
        entryPoint: "main",
        module: device.createShaderModule({
          code: `
@group(0) @binding(0) var atlas:texture_depth_2d;
@group(0) @binding(1) var<storage,read_write> result:array<f32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(128u))){return;}result[id.x+id.y*128u]=textureLoad(atlas,vec2i(id.xy)+vec2i(2),0);
}`,
        }),
      },
    });
    const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    const graph = new FrameGraph("S1/native VSM alpha");
    const resource = graph.import_resource("VSM atlas", { kind: "imported" }, atlas);
    const raster = graph.add("Native VSM/caster alpha", {}, () =>
      owner.encode(command.gpu_encoder, {
        label: "Native VSM/atlas raster",
        colorAttachments: [],
        depthStencilAttachment: {
          view: atlas.createView(),
          depthClearValue: 0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      }),
    );
    const written = raster.write(resource);
    const inspect = graph.add("Native VSM/independent alpha consumer", {}, () => {
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: atlas.createView() },
          { binding: 1, resource: { buffer: output } },
        ],
      });
      const pass = command.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(16, 16);
      pass.end();
      command.gpu_encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
    });
    inspect.read(written);
    inspect.make_side_effect();
    command.encodeGraph(graph);
    command.finish();
    await command.gpuDone;
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    const mainWords = new Uint32Array(mainValues.buffer);
    let covered = 0,
      maxDepthError = 0;
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) {
        const mainX = Math.floor((x * fixture.width) / 128),
          mainY = Math.min(fixture.height - 1, fixture.height - 1 - Math.floor((y * fixture.height) / 128));
        const expectedCovered = mainWords[(mainX + mainY * fixture.width) * 16 + 15] !== 0xffffffff;
        const actual = values[x + y * 128];
        if (actual > 0 !== expectedCovered)
          throw new Error(`Main/VSM native alpha mismatch (${x},${y}): ${actual}`);
        if (expectedCovered) {
          covered++;
          maxDepthError = Math.max(maxDepthError, Math.abs(actual - 0.46875));
        }
      }
    if (maxDepthError > 1e-6 || covered === 0) throw new Error("VSM native depth/addressing mismatch");
    const diagnosticReadback = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    retained.push(diagnosticReadback);
    const rejectStale = async ({ page = false, queue = false, overflow = false } = {}) => {
      device.queue.writeBuffer(pages, 16, new Uint32Array([fixture.generation + Number(page)]));
      device.queue.writeBuffer(
        caster,
        8,
        new Uint32Array([Number(overflow), fixture.generation + Number(queue)]),
      );
      const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      owner.encode(command.gpu_encoder, {
        colorAttachments: [],
        depthStencilAttachment: {
          view: atlas.createView(),
          depthClearValue: 0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      const pass = command.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: atlas.createView() },
            { binding: 1, resource: { buffer: output } },
          ],
        }),
      );
      pass.dispatchWorkgroups(16, 16);
      pass.end();
      command.gpu_encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
      command.gpu_encoder.copyBufferToBuffer(
        owner.partitions.states,
        owner.partitions.count * 16,
        diagnosticReadback,
        0,
        16,
      );
      command.finish();
      await command.gpuDone;
      await readback.mapAsync(GPUMapMode.READ);
      const rejected = new Float32Array(readback.getMappedRange()).slice();
      readback.unmap();
      await diagnosticReadback.mapAsync(GPUMapMode.READ);
      const diagnostics = Array.from(new Uint32Array(diagnosticReadback.getMappedRange()));
      diagnosticReadback.unmap();
      if ((page || queue) && rejected.some((value) => value !== 0))
        throw new Error("Stale native VSM publication produced depth");
      if (diagnostics[0] !== Number(overflow) || diagnostics[1] !== 0 || diagnostics[2] !== Number(queue))
        throw new Error("Native raster overflow/generation diagnostics mismatch");
      return { page, queue, overflow, diagnostics };
    };
    // The same source and MASK program must produce identical depth through
    // GPU-selected implicit Cartesian execution, with no explicit draw records.
    device.queue.writeBuffer(caster, 4, new Uint32Array([0]));
    device.queue.writeBuffer(caster, 16, new Uint32Array([1]));
    device.queue.writeBuffer(caster, 32, new Uint32Array(fixture.workCount * 4).fill(0xffffffff));
    await rejectStale();
    await readback.mapAsync(GPUMapMode.READ);
    const implicitValues = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();
    if (implicitValues.some((value, index) => value !== values[index]))
      throw new Error("Explicit/implicit native MASK depth mismatch");
    device.queue.writeBuffer(caster, 0, words);
    const rejected = [
      await rejectStale({ page: true }),
      await rejectStale({ queue: true }),
      await rejectStale({ overflow: true }),
      await rejectStale(),
    ];
    // Two fine pages and an overlapping coarse page share one resident source.
    // Compare both gutter directions and every coarse pixel to the independent
    // main-view coverage oracle above. Tight bounds deliberately reject many
    // Cartesian candidates, so implicit execution must include degenerate work.
    const virtualPages = [0, 1, 4, 2],
      worldPages = [
        [0, 0],
        [1, 0],
        [0, 0],
        [0, 1],
      ],
      mips = [0, 0, 1, 0];
    const seamPages = new Uint32Array(5 * 12),
      dirtyWords = new Uint32Array(4 + 4 * 8);
    for (let slot = 0; slot < 4; slot++) {
      seamPages.set(
        [
          slot % 2,
          Math.floor(slot / 2),
          mips[slot],
          11,
          fixture.generation,
          0,
          0,
          fixture.generation,
          ...worldPages[slot],
          1,
          0,
        ],
        virtualPages[slot] * 12,
      );
      dirtyWords.set(
        [virtualPages[slot], slot, 0, fixture.generation, 11, mips[slot], ...worldPages[slot]],
        4 + slot * 8,
      );
    }
    const seamTable = make(seamPages, GPUBufferUsage.STORAGE);
    const seamAllocation = make(dirtyWords, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const maxPairs = fixture.workCount * 4;
    const seamPairs = make(
      new Uint32Array(8 + maxPairs * 4),
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    );
    const seamIndirect = make(new Uint32Array(12), GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT);
    const seamTelemetry = make(new Uint32Array(8), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const seamBoundsBytes = new Uint32Array(boundsBytes);
    const columns = fixture.width / 8,
      rows = fixture.height / 8;
    for (let slot = 0; slot < fixture.workCount; slot++) {
      const x = slot % columns,
        y = Math.floor(slot / columns);
      new Float32Array(seamBoundsBytes.buffer).set(
        [(x * 2) / columns, 2 - ((y + 1) * 2) / rows, ((x + 1) * 2) / columns, 2 - (y * 2) / rows],
        4 + slot * 8,
      );
    }
    const seamBounds = make(seamBoundsBytes, GPUBufferUsage.STORAGE);
    const seamConstants = new Float32Array(constants);
    new Uint32Array(seamConstants.buffer).set(
      [2, 128, 2, 264, fixture.generation, fixture.workCount, maxPairs, 4],
      40,
    );
    const seamSettings = make(seamConstants, GPUBufferUsage.UNIFORM);
    const seamDepth = make(
      new Float32Array([-8, 8, 1 / 16, 1]),
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    );
    const seamAtlas = device.createTexture({
      size: [264, 264],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    retained.push(seamAtlas);
    seamOwner = new NativeVisibilityPass(device, {
      geometry: { ...fixture.geometry, meshletWork: seamPairs },
      publication,
      capacity: maxPairs,
      generation: fixture.generation,
      view,
      vsmAtlas: {
        constants: seamSettings,
        pageTable: seamTable,
        allocation: seamAllocation,
        source: fixture.geometry.meshletWork,
        bounds: seamBounds,
        sourceCapacity: fixture.workCount,
        pairCapacity: maxPairs,
        dirtyCapacity: 4,
      },
    });
    pairOwner = new VsmCasterRecordPass(device);
    await seamOwner.ready;
    const seamOutput = make(new Float32Array(264 * 264), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const seamRead = make(new Float32Array(264 * 264), GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const headerRead = make(new Uint32Array(8), GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const seamReadPipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: {
        entryPoint: "main",
        module: device.createShaderModule({
          code: `
@group(0) @binding(0) var atlas:texture_depth_2d;
@group(0) @binding(1) var<storage,read_write> result:array<f32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  if any(id.xy >= vec2u(264u)) { return; }
  result[id.x+id.y*264u] = textureLoad(atlas,vec2i(id.xy),0);
}`,
        }),
      },
    });
    const seamReadGroup = device.createBindGroup({
      layout: seamReadPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: seamAtlas.createView() },
        { binding: 1, resource: { buffer: seamOutput } },
      ],
    });
    const seamFrame = {
      generation: fixture.generation,
      projectionEpoch: fixture.generation,
      namespace: 1,
      lightView: [...seamConstants.slice(0, 16)],
      clipOriginExtent: Array.from({ length: 6 }, () => [0, 0, 2, 1 / 128]),
    };
    const runSeam = async (dirty, capacity, measure = false) => {
      device.queue.writeBuffer(seamAllocation, 0, new Uint32Array([dirty, dirty, 0, fixture.generation]));
      const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      let query,
        timestamps,
        timestampRead,
        queryCount = 0;
      const stages = [];
      if (measure && device.features.has("timestamp-query")) {
        query = device.createQuerySet({ type: "timestamp", count: 32 });
        timestamps = make(new Uint32Array(64), GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC);
        timestampRead = make(new Uint32Array(64), GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
        for (const method of ["beginComputePass", "beginRenderPass"]) {
          const begin = command.gpu_encoder[method].bind(command.gpu_encoder);
          command.gpu_encoder[method] = (descriptor) => {
            stages.push(descriptor?.label ?? method);
            return begin({
              ...descriptor,
              timestampWrites: {
                querySet: query,
                beginningOfPassWriteIndex: queryCount++,
                endOfPassWriteIndex: queryCount++,
              },
            });
          };
        }
      }
      const graph = new FrameGraph("R3 explicit/implicit real depth closure");
      const imp = (buffer) => graph.import_resource("seam fixture", { kind: "imported" }, buffer);
      pairOwner.addToGraph(graph, {
        allocation: { allocation: imp(seamAllocation), pageTable: imp(seamTable) },
        meshletWork: imp(fixture.geometry.meshletWork),
        meshletBounds: imp(seamBounds),
        depthRange: imp(seamDepth),
        frame: seamFrame,
        generation: fixture.generation,
        workCapacity: fixture.workCount,
        resources: {
          profile: "vsm-directional-high",
          casterRecords: seamPairs,
          rasterIndirect: seamIndirect,
          overflowCounters: seamTelemetry,
          capabilities: {
            virtualPagesPerAxis: 2,
            pageSize: 128,
            border: 2,
            atlasDimension: 264,
            casterRecordCapacity: capacity,
            residentSlots: 4,
            limits: device.limits,
          },
        },
      });
      command.encodeGraph(graph);
      seamOwner.encode(command.gpu_encoder, {
        label: "R3/native explicit/implicit depth",
        colorAttachments: [],
        depthStencilAttachment: {
          view: seamAtlas.createView(),
          depthClearValue: 0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      const pass = command.beginComputePass({ label: "R3/read atlas" });
      pass.setPipeline(seamReadPipeline);
      pass.setBindGroup(0, seamReadGroup);
      pass.dispatchWorkgroups(33, 33);
      pass.end();
      command.gpu_encoder.copyBufferToBuffer(seamOutput, 0, seamRead, 0, seamOutput.size);
      command.gpu_encoder.copyBufferToBuffer(seamPairs, 0, headerRead, 0, 32);
      if (query) {
        command.gpu_encoder.resolveQuerySet(query, 0, queryCount, timestamps, 0);
        command.gpu_encoder.copyBufferToBuffer(timestamps, 0, timestampRead, 0, queryCount * 8);
      }
      command.finish();
      await command.gpuDone;
      await seamRead.mapAsync(GPUMapMode.READ);
      const pixels = new Float32Array(seamRead.getMappedRange()).slice();
      seamRead.unmap();
      await headerRead.mapAsync(GPUMapMode.READ);
      const header = [...new Uint32Array(headerRead.getMappedRange())];
      headerRead.unmap();
      let cost = null;
      if (query) {
        await timestampRead.mapAsync(GPUMapMode.READ);
        const times = new BigUint64Array(timestampRead.getMappedRange());
        cost = stages.map((stage, index) => ({
          stage,
          milliseconds: Number(times[index * 2 + 1] - times[index * 2]) / 1e6,
        }));
        timestampRead.unmap();
        query.destroy();
      }
      return { pixels, header, cost };
    };
    const explicit = await runSeam(4, maxPairs);
    if (explicit.header[4] !== 0 || explicit.header[2] !== 0)
      throw new Error("Seam explicit producer failed");
    const implicit = await runSeam(4, explicit.header[0] - 1);
    if (
      implicit.header[4] !== 1 ||
      implicit.header[1] !== 0 ||
      implicit.pixels.some((value, index) => value !== explicit.pixels[index])
    )
      throw new Error(
        `Multi-page implicit depth/MASK differs or consumed partial pairs: ${JSON.stringify({
          explicit: explicit.header,
          implicit: implicit.header,
          differences: Array.from(implicit.pixels.entries())
            .filter(([index, value]) => value !== explicit.pixels[index])
            .slice(0, 12)
            .map(([index, value]) => [index, value, explicit.pixels[index]]),
        })}`,
      );
    let seamPixels = 0;
    for (let y = 2; y < 130; y++) {
      if (
        explicit.pixels[130 + y * 264] !== explicit.pixels[134 + y * 264] ||
        explicit.pixels[129 + y * 264] !== explicit.pixels[133 + y * 264]
      )
        throw new Error(`Raster gutter seam mismatch y=${y}`);
      seamPixels += 2;
    }
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) {
        if (explicit.pixels[x + 2 + (y + 134) * 264] !== values[x + y * 128])
          throw new Error(
            `Coarse mip depth/MASK changed source semantics: x=${x},y=${y},actual=${explicit.pixels[x + 2 + (y + 134) * 264]},expected=${values[x + y * 128]}; E=${explicit.header[0]}`,
          );
      }
    const rasterCosts = [];
    for (const [label, dirty, capacity] of [
      ["0%", 0, maxPairs],
      ["50%", 2, maxPairs],
      ["100%", 4, maxPairs],
      ["rare-implicit", 2, 1],
      ["worst-implicit", 4, 1],
    ]) {
      const samples = [];
      for (let sample = 0; sample < 12; sample++) {
        const result = await runSeam(dirty, capacity, true);
        if (result.cost) samples.push(result.cost);
      }
      const sums = samples
        .map((stages) =>
          stages
            .filter((stage) => stage.stage !== "R3/read atlas")
            .reduce((sum, stage) => sum + stage.milliseconds, 0),
        )
        .sort((a, b) => a - b);
      rasterCosts.push({
        label,
        W: fixture.workCount,
        D: dirty,
        samples,
        p50: sums.length ? sums[6] : null,
        p95: sums.length ? sums[11] : null,
      });
    }
    return {
      covered,
      comparedPixels: 16384,
      maxDepthError,
      rejected,
      actualCasterAbi: true,
      actualAtlasPageMath: true,
      nativeAlphaMatchesMain: true,
      implicitDepthMatchesExplicit: true,
      multiPage: {
        explicit: explicit.header,
        implicit: implicit.header,
        seamPixels,
        coarseComparedPixels: 16384,
      },
      rasterCosts,
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    owner.destroy();
    seamOwner?.destroy();
    pairOwner?.destroy();
    for (const resource of retained) resource.destroy();
  }
}
