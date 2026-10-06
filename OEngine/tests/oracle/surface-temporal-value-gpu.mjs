import { TemporalFactsPass } from "../../.test-dist/render/temporal/TemporalFactsPass.js";
import { materialVisibilitySource } from "../../.test-dist/gpu/GpuMaterialVisibilityAbi.js";
import {
  packGpuShadingMaterialRecord,
  GPU_SHADING_MATERIAL_RECORD_STRIDE
} from "../../.test-dist/gpu/GpuShadingMaterialAbi.js";

/** Real identity history, written only by the current TemporalFacts producer.
 * The fixture's visible plane independently has clip depth 0.5 and zero motion.
 * No correct identity or reactive output is prefilled by the harness. */
export class SurfaceTemporalValueFixture {
  constructor(device) {
    this.device = device;
    this.owner = new TemporalFactsPass(device);
    this.readIndex = 0;
    this.valid = false;
    this.ephemeral = [];
    this.empty = device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(
      this.empty,
      0,
      new Uint32Array([0xffffffff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    );
  }
  add(graph, input) {
    const device = this.device;
    this.owner.prepareFrame(input.width, input.height, this.readIndex, 1 - this.readIndex, this.valid);
    const imported = (name, value) => graph.import_resource(name, { kind: "imported" }, value);
    const depth = device.createTexture({
      size: [input.width, input.height],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    const depthResource = imported("Temporal fixture depth", depth);
    const pass = graph.add("Fixture exact plane depth", {}, (_data, _resources, context) => {
      const render = context.encoder.gpu_encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView(),
          depthLoadOp: "clear",
          depthStoreOp: "store",
          depthClearValue: 0.5
        }
      });
      render.end();
    });
    const bytes = new Uint8Array(
      (Math.max(...input.publication.entries.map((entry) => entry.materialSlot)) + 1) *
        GPU_SHADING_MATERIAL_RECORD_STRIDE
    );
    for (const entry of input.publication.entries)
      bytes.set(
        packGpuShadingMaterialRecord(
          {
            programId: 0,
            textureBindingSetId: entry.textureBindingSetId,
            materialGeneration: 1,
            textureGeneration: 1,
            publicationRevision: 1,
            flags: 0
          },
          materialVisibilitySource(entry.material, {}, entry.materialSlot, entry.textureBindingSetId).packed
        ),
        entry.materialSlot * GPU_SHADING_MATERIAL_RECORD_STRIDE
      );
    const materials = device.createBuffer({
      size: bytes.length,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(materials, 0, bytes);
    this.ephemeral.push(depth, materials);
    return this.owner.addToGraph(
      graph,
      {
        width: input.width,
        height: input.height,
        visibility: input.visibility,
        depth: pass.write(depthResource),
        meshletWork: input.work,
        instances: input.instances,
        materials: imported("Temporal fixture materials", materials),
        textureRoutes: imported("Temporal fixture empty routes", this.empty),
        textureResidencyVersions: imported("Temporal fixture empty residency", this.empty),
        appearanceMetadata: input.metadata,
        appearanceOffsets: input.publication.surfaceMetadataOffsets,
        currentCamera: input.camera,
        previousCamera: input.camera,
        assetMetadata: input.source,
        vertexPayload: input.vertices,
        sourceBindings: input.sourceBindings
      },
      (_name, resolve) => resolve(this.owner)
    ).mask;
  }
  commit(done) {
    this.owner.commit(done);
    this.readIndex = 1 - this.readIndex;
    this.valid = true;
    const resources = this.ephemeral.splice(0);
    void done.then(() => resources.forEach((value) => value.destroy()));
  }
  abort() {
    this.owner.abort();
    this.ephemeral.splice(0).forEach((value) => value.destroy());
  }
  destroy() {
    this.owner.destroy();
    this.empty.destroy();
  }
}
