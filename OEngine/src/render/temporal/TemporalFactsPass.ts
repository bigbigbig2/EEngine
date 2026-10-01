import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { TEMPORAL_FACTS_WGSL } from "../../shaders/temporal_facts.js";
import type { GpuSparseShadingAssetHeapBindings } from "../../gpu/GpuAssetStore.js";

type IdentityPair = readonly [GPUTexture, GPUTexture];
export type TemporalFactsGraphBinder = <T extends object>(
  name: string, resolve: (runtime: TemporalFactsPass) => T
) => T;

export interface TemporalFactProducts {
  /** Jittered current-minus-previous UV, including camera rotation for sky. */
  readonly motion: ResourceId;
  /** R=opaque reactive, G=motion validity, B=identity mismatch, A=change bits / 255. */
  readonly mask: ResourceId;
  /** Instance slot, geometry/LOD, material, and transform revision; persistent writer. */
  readonly identity: ResourceId;
}

/**
 * Local GPU fact production before the pinned FSR3 adapter. The signature is a
 * change detector, not an exact object ID; its first channel is the exact
 * Scene-allocation instance slot. Resource role/index comes from TemporalFabric.
 */
export class TemporalFactsPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly constants: GPUBuffer;
  private histories: IdentityPair | null = null;
  private size: readonly [number, number] = [0, 0];
  private readIndex: 0 | 1 = 0;
  private writeIndex: 0 | 1 = 1;
  private readValid = false;
  private prepared = false;
  private lastGpuDone: Promise<void> | null = null;
  private invalidateNext = false;

  constructor(private readonly device: GPUDevice) {
    if (device.limits.maxStorageTexturesPerShaderStage < 3) {
      throw new RangeError("Temporal Facts requires three storage textures in its isolated pass");
    }
    this.constants = device.createBuffer({ label: "Temporal Facts/frame constants", size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
      ...[4, 5, 6].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" as const } })),
      ...[7, 8, 9].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" as const } })),
      { binding: 10, visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: "write-only", format: "rg16float" } },
      { binding: 11, visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: "write-only", format: "rgba8unorm" } },
      { binding: 12, visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: "write-only", format: "rgba32uint" } },
      ...[13, 14, 15, 16].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" as const } }))
    ] });
    this.pipeline = device.createComputePipeline({ label: "Temporal Facts/resolve",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ label: "Temporal Facts", code: TEMPORAL_FACTS_WGSL }),
        entryPoint: "main" } });
  }

  prepareFrame(width: number, height: number, readIndex: 0 | 1,
    writeIndex: 0 | 1, readValid: boolean): void {
    if (this.prepared) throw new Error("Temporal Facts frame is already prepared");
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
        width > this.device.limits.maxTextureDimension2D ||
        height > this.device.limits.maxTextureDimension2D) {
      throw new RangeError("Temporal Facts extent exceeds the device limit");
    }
    if (readIndex === writeIndex) throw new Error("Temporal Facts history roles alias");
    if (this.histories === null || this.size[0] !== width || this.size[1] !== height) {
      this.retireHistories();
      this.histories = [0, 1].map(index => this.device.createTexture({
        label: `Temporal Facts/identity/${index}`, size: [width, height], format: "rgba32uint",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
      })) as unknown as IdentityPair;
      this.size = [width, height];
      readValid = false;
    }
    this.readIndex = readIndex;
    this.writeIndex = writeIndex;
    this.readValid = readValid && !this.invalidateNext;
    this.invalidateNext = false;
    this.prepared = true;
  }

  /** Forces the next fact production to treat the previous identity as absent. */
  invalidate(): void {
    if (this.prepared) throw new Error("Temporal Facts cannot invalidate an active frame");
    this.invalidateNext = true;
  }

  assertPreparedFrame(width: number, height: number): void {
    if (!this.prepared || !this.histories ||
        this.size[0] !== width || this.size[1] !== height ||
        this.histories[0] === this.histories[1] ||
        this.histories.some(texture => texture.width !== width || texture.height !== height ||
          texture.format !== "rgba32uint")) {
      throw new Error("Temporal Facts physical history does not match this Frame Program");
    }
  }

  history(role: "read" | "write"): GPUTexture {
    if (!this.prepared || !this.histories) throw new Error("Temporal Facts history is not prepared");
    return this.histories[role === "read" ? this.readIndex : this.writeIndex];
  }

  addToGraph(graph: FrameGraph, input: {
    width: number; height: number;
    visibility: ResourceId; depth: ResourceId;
    meshletWork: ResourceId; instances: ResourceId; materials: ResourceId;
    textureRoutes: ResourceId; textureResidencyVersions: ResourceId;
    currentCamera: ResourceId; previousCamera: ResourceId;
    assetMetadata: ResourceId; vertexPayload: ResourceId;
    sourceBindings: GpuSparseShadingAssetHeapBindings;
  }, bind: TemporalFactsGraphBinder): TemporalFactProducts {
    const previous = graph.import_resource("Temporal Facts/previous identity",
      { kind: "imported", label: "Temporal Facts previous identity", domain: "internal-full" },
      bind("previous-identity", runtime => runtime.history("read")));
    const current = graph.import_resource("Temporal Facts/current identity",
      { kind: "imported", label: "Temporal Facts current identity", domain: "internal-full" },
      bind("current-identity", runtime => runtime.history("write")));
    const node = graph.add("Temporal Facts/resolve identity and reactive", input,
      (data, resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        const constants = new Uint32Array([data.width, data.height, Number(this.readValid), 0,
          data.sourceBindings.meshletWordBase, data.sourceBindings.vertexDataWordBase, 0, 0]);
        command.writeBuffer(this.constants, 0, constants.buffer, 0, constants.byteLength);
        const ids = [data.visibility, data.depth, previous,
          data.meshletWork, data.instances, data.materials, data.currentCamera,
          data.previousCamera] as const;
        const entries: GPUBindGroupEntry[] = ids.map((id, index) => ({ binding: index === 0 ? 0 : index + 1,
          resource: index < 3 ? resolveTextureView(resources.get(id)) :
            { buffer: resources.get(id) as GPUBuffer } }));
        entries.push({ binding: 9, resource: { buffer: this.constants } });
        entries.push({ binding: 10, resource: resolveTextureView(resources.get(motion)) });
        entries.push({ binding: 11, resource: resolveTextureView(resources.get(mask)) });
        entries.push({ binding: 12, resource: resolveTextureView(resources.get(identity)) });
        entries.push({ binding: 13, resource: { buffer: resources.get(data.textureRoutes) as GPUBuffer } });
        entries.push({ binding: 14, resource: { buffer: resources.get(data.textureResidencyVersions) as GPUBuffer } });
        entries.push({ binding: 15, resource: { buffer: resources.get(data.assetMetadata) as GPUBuffer } });
        entries.push({ binding: 16, resource: { buffer: resources.get(data.vertexPayload) as GPUBuffer } });
        const group = this.device.createBindGroup({ layout: this.layout, entries });
        const pass = command.beginComputePass({ label: "Temporal Facts/resolve" });
        pass.setPipeline(this.pipeline); pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(data.width / 8), Math.ceil(data.height / 8));
        pass.end();
      });
    for (const id of [input.visibility, input.depth,
      input.meshletWork, input.instances, input.materials, input.textureRoutes, input.textureResidencyVersions,
      input.currentCamera, input.previousCamera, input.assetMetadata, input.vertexPayload, previous]) node.read(id);
    const motion = node.create("Temporal Facts/motion", {
      kind: "transient_texture", width: input.width, height: input.height,
      format: "rg16float", domain: "internal-full",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    const mask = node.create("Temporal Facts/reactive and validity", {
      kind: "transient_texture", width: input.width, height: input.height,
      format: "rgba8unorm", domain: "internal-full",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    const identity = node.write(current);
    return { motion, mask, identity };
  }

  commit(gpuDone: Promise<void>): void {
    if (!this.prepared) throw new Error("Temporal Facts commit without a prepared writer");
    this.prepared = false;
    this.lastGpuDone = gpuDone;
  }
  abort(): void { this.prepared = false; }
  destroy(): void { this.retireHistories(); this.constants.destroy(); }

  private retireHistories(): void {
    const old = this.histories;
    this.histories = null;
    if (!old) return;
    const destroy = () => { old[0].destroy(); old[1].destroy(); };
    if (this.lastGpuDone) void this.lastGpuDone.then(destroy, destroy);
    else destroy();
  }
}
