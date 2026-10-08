import {
  createValidationController,
  attachGpuErrorCollection,
  snapshotAdapterInfo,
  snapshotGpuFeatures,
  snapshotGpuLimits,
} from "../../harness/browser.ts";
import { GraphicsContext } from "../../../OEngine/src/gpu/GraphicsContext.ts";
import { ShadeGPUCommandContext } from "../../../OEngine/src/framegraph/ShadeGPUCommandContext.ts";
import { ShadeImage } from "../../../OEngine/src/texture/ShadeImage.ts";
import { ShadeTexture } from "../../../OEngine/src/texture/ShadeTexture.ts";
import { StandardShadeMaterial } from "../../../OEngine/src/material/StandardShadeMaterial.ts";
import { prepareMaterialTextureProducts } from "../../../OEngine/src/assets/PcMaterialTextures.ts";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture,
} from "../../../OEngine/src/material/AppearanceGraph.ts";
import { compileAppearanceGraph } from "../../../OEngine/src/material/AppearanceGraphCompiler.ts";
import { lowerNativeMaterial } from "../../../OEngine/src/shaders/native_material.ts";
import { createNativeMaterialBindings } from "../../../OEngine/src/gpu/NativeMaterialBindings.ts";

const status = document.querySelector<HTMLElement>("#status");
let device: GPUDevice | undefined;
let graphics: GraphicsContext | undefined;
let errors: ReturnType<typeof attachGpuErrorCollection> | undefined;
let intentionalLoss = false;
const buffers: GPUBuffer[] = [];
const controller = createValidationController(
  {
    caseId: "texture-residency-component",
    workloadId: "texture-residency-component-v1",
  },
  async () => {
    if (device) await device.queue.onSubmittedWorkDone();
    graphics?.destroy();
    buffers.splice(0).forEach((buffer) => buffer.destroy());
    errors?.remove();
    intentionalLoss = true;
    device?.destroy();
    return { buffers: 0, textures: 0, samplers: 0, devices: 0, intentionalDeviceDestroy: true };
  },
);

try {
  controller.transition("negotiating");
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter?.features.has("texture-compression-bc")) {
    controller.unsupported("PC texture profile requires texture-compression-bc");
  } else {
    controller.addEvidence("adapter", {
      info: snapshotAdapterInfo(adapter.info),
      features: snapshotGpuFeatures(adapter.features),
      limits: snapshotGpuLimits(adapter.limits),
    });
    device = await adapter.requestDevice({ requiredFeatures: ["texture-compression-bc"] });
    errors = attachGpuErrorCollection(device, controller, () => intentionalLoss);
    graphics = new GraphicsContext(device);
    controller.transition("ready");
    const pixels = new Uint8Array(128 * 128 * 4);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        pixels.set(
          x >= 56 && x < 72 && y >= 56 && y < 72 ? [0, 255, 0, 255] : [255, 0, 0, 255],
          (y * 128 + x) * 4,
        );
      }
    }
    const material = new StandardShadeMaterial();
    material.is_unlit = true;
    material.texture_albedo = ShadeTexture.from(ShadeImage.fromArrayBuffer(pixels, 4, "uint8", 128, 128));
    await prepareMaterialTextureProducts([material]);
    const residency = graphics.texture_residency;
    const upload = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    const stage = residency.stage([material], upload);
    upload.finish();
    await upload.gpuDone;
    controller.transition("warming");
    const g = new AppearanceGraphBuilder(),
      uv = g.input("uv0", 2, "surface", undefined, "uv0");
    g.output("rgba", g.texture(snapshotAppearanceTexture(material.texture_albedo!, "srgb-rgb"), uv));
    const graph = compileAppearanceGraph(g.build());
    const currentBindings = () =>
      createNativeMaterialBindings({
        graph,
        program: lowerNativeMaterial(graph),
        group: 1,
        bindingSet: stage.bindings.bindingSets.find(
          (set) => set.id === stage.materialBindingSetIds.get(material),
        )!,
        textureRoutingRefs: stage.materialTextureRoutingRefs.get(material)!,
        textureMipRanges: stage.textureMipRanges,
        texturePublications: stage.surfacePublications,
        obtainSampler: (descriptor) => graphics!.samplers.obtain(descriptor),
      });
    const binding = currentBindings();
    const constants = device.createBuffer({
      size: binding.program.constants.length * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const output = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    buffers.push(constants, output, read);
    const module = device.createShaderModule({
      code: `
@group(0) @binding(0) var<storage,read> constants:array<f32>;
@group(0) @binding(1) var<storage,read_write> output:array<vec4f>;
fn native_material_constant(base:u32,slot:u32)->f32{return constants[base+slot];}
${binding.program.source}
@compute @workgroup_size(1) fn main(){
 var inputs:NativeMaterialInputs;
 inputs.center[0]=vec4f(0.5,0.5,0.0,0.0);
 inputs.x[0]=vec4f(0.500001,0.5,0.0,0.0);
 inputs.y[0]=vec4f(0.5,0.500001,0.0,0.0);
 let result=native_material_evaluate(0u,inputs);
 output[0]=vec4f(result[0],result[1],result[2],result[3]);
}`,
    });
    const layouts = [
      device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ],
      }),
      device.createBindGroupLayout({ entries: [...binding.layoutEntries] }),
    ];
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
      compute: { module, entryPoint: "main" },
    });
    const groups = [
      device.createBindGroup({
        layout: layouts[0],
        entries: [
          { binding: 0, resource: { buffer: constants } },
          { binding: 1, resource: { buffer: output } },
        ],
      }),
      device.createBindGroup({ layout: layouts[1], entries: [...binding.entries] }),
    ];
    const sample = async () => {
      const current = currentBindings();
      if (current.program.source !== binding.program.source)
        throw new Error("Mip publication changed native code identity");
      device!.queue.writeBuffer(constants, 0, new Float32Array(current.program.constants));
      const command = ShadeGPUCommandContext.create(graphics!, "Renderer/visibility-frame");
      const pass = command.beginComputePass();
      pass.setPipeline(pipeline);
      groups.forEach((group, index) => pass.setBindGroup(index, group));
      pass.dispatchWorkgroups(1);
      pass.end();
      command.gpu_encoder.copyBufferToBuffer(output, 0, read, 0, 16);
      command.finish();
      await command.gpuDone;
      await read.mapAsync(GPUMapMode.READ);
      const values = [...new Float32Array(read.getMappedRange())];
      read.unmap();
      return values;
    };
    controller.transition("sampling");
    const tail = await sample();
    const promotion = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    residency.promote([material], promotion);
    promotion.finish();
    await promotion.gpuDone;
    const promoted = await sample();
    if (
      tail.some((value) => !Number.isFinite(value)) ||
      promoted.some((value) => !Number.isFinite(value)) ||
      promoted[1]! < 0.98 ||
      tail[1]! > 0.2
    )
      throw new Error("Native BC sampling did not observe mip promotion");
    const before = residency.evidence();
    const release = ShadeGPUCommandContext.create(graphics, "Renderer/visibility-frame");
    residency.release([material], release);
    release.finish();
    await release.gpuDone;
    await Promise.resolve();
    await Promise.resolve();
    const after = residency.evidence();
    if (after.allocatedBytes || after.residentTextureCount || after.retiringTextureCount)
      throw new Error("Fenced BC residency did not clear");
    controller.addEvidence("sampling", {
      tail,
      promoted,
      before,
      after,
      format: "bc7-rgba-unorm-srgb",
      nativeConsumer: true,
    });
    controller.addEvidence("readback", { bytes: 32, matches: true, tail, promoted });
    controller.transition("draining");
    if (status) status.textContent = "passed";
    controller.pass();
  }
} catch (error) {
  controller.fail(error instanceof Error ? error.message : String(error));
}
