import { NativeVisibilityPass } from "../../.test-dist/render/surface/NativeVisibilityPass.js";
import { ShadeGPUCommandContext } from "../../.test-dist/framegraph/ShadeGPUCommandContext.js";
import { FrameGraph } from "../../.test-dist/framegraph/FrameGraph.js";

/** Actual 16B/32B caster queue, GPU raster partitions, VSM page addressing,
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
  viewBytes
) {
  const retained = [];
  const make = (data, usage) => {
    const buffer = device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    );
    buffer.unmap();
    retained.push(buffer);
    return buffer;
  };
  const words = new Uint32Array(4 + fixture.workCount * 8);
  words.set([fixture.workCount, fixture.workCount, 0, fixture.generation]);
  for (let work = 0; work < fixture.workCount; work++)
    words.set([work % fixture.instanceCount, 0, work, work % 8, 0, 0, 16, 0], 4 + work * 8);
  const caster = make(words, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const pages = make(
    new Uint32Array([0, 0, 0, 11, fixture.generation, 0, 0, 0]),
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  );
  const constants = new Float32Array(48);
  constants.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  constants.set([-1, -1, 2, 0], 16);
  new Uint32Array(constants.buffer).set([1, 128, 2, 132, fixture.generation, 1, fixture.workCount, 1], 40);
  const settings = make(constants, GPUBufferUsage.UNIFORM);
  const atlas = device.createTexture({
    size: [132, 132],
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
  });
  retained.push(atlas);
  const view = new Uint8Array(viewBytes.buffer.slice(0));
  new Uint32Array(view.buffer)[39] = fixture.generation;
  const owner = new NativeVisibilityPass(device, {
    geometry: { ...fixture.geometry, meshletWork: caster },
    publication,
    routes,
    capacity: fixture.workCount,
    generation: fixture.generation,
    view,
    vsmAtlas: { constants: settings, pageTable: pages }
  });
  const output = device.createBuffer({
    size: 128 * 128 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
  });
  const readback = device.createBuffer({
    size: output.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
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
}`
        })
      }
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
          depthStoreOp: "store"
        }
      })
    );
    const written = raster.write(resource);
    const inspect = graph.add("Native VSM/independent alpha consumer", {}, () => {
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: atlas.createView() },
          { binding: 1, resource: { buffer: output } }
        ]
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
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    retained.push(diagnosticReadback);
    const rejectStale = async ({ page = false, queue = false, overflow = false } = {}) => {
      device.queue.writeBuffer(pages, 16, new Uint32Array([fixture.generation + Number(page)]));
      device.queue.writeBuffer(
        caster,
        8,
        new Uint32Array([Number(overflow), fixture.generation + Number(queue)])
      );
      const command = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
      owner.encode(command.gpu_encoder, {
        colorAttachments: [],
        depthStencilAttachment: {
          view: atlas.createView(),
          depthClearValue: 0,
          depthLoadOp: "clear",
          depthStoreOp: "store"
        }
      });
      const pass = command.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: atlas.createView() },
            { binding: 1, resource: { buffer: output } }
          ]
        })
      );
      pass.dispatchWorkgroups(16, 16);
      pass.end();
      command.gpu_encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
      command.gpu_encoder.copyBufferToBuffer(
        owner.partitions.states,
        owner.partitions.count * 16,
        diagnosticReadback,
        0,
        16
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
    const rejected = [
      await rejectStale({ page: true }),
      await rejectStale({ queue: true }),
      await rejectStale({ overflow: true }),
      await rejectStale()
    ];
    return {
      covered,
      comparedPixels: 16384,
      maxDepthError,
      rejected,
      actualCasterAbi: true,
      actualAtlasPageMath: true,
      nativeAlphaMatchesMain: true
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    owner.destroy();
    for (const resource of retained) resource.destroy();
  }
}
