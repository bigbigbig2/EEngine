import { GpuBindGroupCache } from "../../gpu/GpuBindGroupResourceCache.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuSparseShadingAssetHeapBindings } from "../../gpu/GpuAssetStore.js";
import { NATIVE_TEMPORAL_FACTS_WGSL } from "../../shaders/native_surface_aux.js";
import { resolveTextureView } from "../RenderTargetViews.js";

export interface NativeTemporalFactProducts {
  /** Jittered current-minus-previous UV; invalid motion is zero. */
  readonly motion: ResourceId;
  /** R=soft reactive, G=motion validity, B=local hard replacement, A=change byte/255. */
  readonly mask: ResourceId;
  /** Instance slot, topology/resource signature, material signature, material slot+1. */
  readonly identity: ResourceId;
}

export interface NativeTemporalFactsInput {
  readonly width: number;
  readonly height: number;
  readonly visibility: ResourceId;
  readonly depth: ResourceId;
  readonly opaqueReactive: ResourceId;
  readonly meshletWork: ResourceId;
  readonly instances: ResourceId;
  /** Native publication vec2u per material slot: signature, nonzero value revision. */
  readonly materialVersions: ResourceId;
  readonly materialSlotCount: number;
  readonly currentCamera: ResourceId;
  readonly previousCamera: ResourceId;
  readonly assetMetadata: ResourceId;
  readonly vertexPayload: ResourceId;
  readonly sourceBindings: GpuSparseShadingAssetHeapBindings;
}

export type NativeTemporalFactsGraphBinder = <T extends object>(
  name: string,
  resolve: (runtime: NativeTemporalFactsPass) => T,
) => T;

type HistorySet = {
  readonly textures: readonly [GPUTexture, GPUTexture];
  readonly width: number;
  readonly height: number;
};

/**
 * Isolated native effect owner, with no production Surface/publication ownership.
 * Cost at 1080p: 32B/pixel persistent identity pair (63.28 MiB); 12B/pixel
 * frame motion/mask (23.73 MiB); 28B/pixel full-domain output writes plus one
 * 16B identity read for valid reprojection. Version/geometry reads are
 * bounded random inputs. One 8x8 dispatch; no atomics, CPU readback or submit.
 * History roles come from the caller's Temporal registry and advance only commit.
 * Resize allocation is transactional; abort preserves the previous committed set.
 */
export class NativeTemporalFactsPass {
  private readonly bindGroups = new GpuBindGroupCache();
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly constants: GPUBuffer;
  private readonly constantWords = new Uint32Array(8);
  private active: HistorySet | null = null;
  private pending: HistorySet | null = null;
  private readIndex: 0 | 1 = 0;
  private writeIndex: 0 | 1 = 1;
  private readValid = false;
  private invalidateNext = false;
  private lastGpuDone: Promise<void> | null = null;
  private retiredBytes = 0;
  private constantsLive = true;
  private destroyed = false;

  constructor(private readonly device: GPUDevice) {
    if (
      device.limits.maxStorageTexturesPerShaderStage < 3 ||
      device.limits.maxStorageBuffersPerShaderStage < 5 ||
      device.limits.maxSampledTexturesPerShaderStage < 4 ||
      device.limits.maxUniformBuffersPerShaderStage < 3
    ) {
      throw new RangeError("Native Temporal Facts exceeds negotiated shader-stage limits");
    }
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        {
          binding: 10,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rg32float" },
        },
        {
          binding: 11,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba8unorm" },
        },
        {
          binding: 12,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba32uint" },
        },
        { binding: 15, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 16, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 17, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 18, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      ],
    });
    this.pipeline = device.createComputePipeline({
      label: "SurfaceV4/Native Temporal Facts",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: {
        module: device.createShaderModule({
          label: "Native Temporal Facts",
          code: NATIVE_TEMPORAL_FACTS_WGSL,
        }),
        entryPoint: "main",
      },
    });
    this.constants = device.createBuffer({
      label: "Native Temporal Facts/constants",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    void device.lost.then(() => this.destroy());
  }

  prepareFrame(width: number, height: number, readIndex: 0 | 1, writeIndex: 0 | 1, readValid: boolean): void {
    if (this.destroyed || this.pending !== null) {
      throw new Error("Native Temporal Facts unavailable or already prepared");
    }
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > this.device.limits.maxTextureDimension2D ||
      height > this.device.limits.maxTextureDimension2D
    ) {
      throw new RangeError("Native Temporal Facts extent exceeds negotiated limits");
    }
    if (
      (readIndex !== 0 && readIndex !== 1) ||
      (writeIndex !== 0 && writeIndex !== 1) ||
      readIndex === writeIndex
    ) {
      throw new Error("Native Temporal Facts history roles alias or are invalid");
    }
    if (this.active?.width === width && this.active.height === height) {
      this.pending = this.active;
    } else {
      const textures: GPUTexture[] = [];
      try {
        for (let index = 0; index < 2; index++) {
          textures.push(
            this.device.createTexture({
              label: `Native Temporal Facts/identity/${index}`,
              size: [width, height],
              format: "rgba32uint",
              usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
            }),
          );
        }
      } catch (error) {
        for (const texture of textures) {
          texture.destroy();
        }
        throw error;
      }
      this.pending = { textures: [textures[0]!, textures[1]!], width, height };
      readValid = false;
    }
    this.readIndex = readIndex;
    this.writeIndex = writeIndex;
    this.readValid = readValid && !this.invalidateNext;
  }

  invalidate(): void {
    if (this.destroyed || this.pending !== null) {
      throw new Error("Native Temporal Facts cannot invalidate an active frame");
    }
    this.invalidateNext = true;
  }

  assertPreparedFrame(width: number, height: number): void {
    if (this.pending?.width !== width || this.pending.height !== height) {
      throw new Error("Native Temporal Facts physical history does not match the frame");
    }
  }

  history(role: "read" | "write"): GPUTexture {
    if (this.pending === null) {
      throw new Error("Native Temporal Facts history is not prepared");
    }
    return this.pending.textures[role === "read" ? this.readIndex : this.writeIndex];
  }

  get allocatedBytes(): number {
    let bytes = this.retiredBytes + (this.constantsLive ? 32 : 0);
    if (this.active) {
      bytes += this.active.width * this.active.height * 32;
    }
    if (this.pending && this.pending !== this.active) {
      bytes += this.pending.width * this.pending.height * 32;
    }
    return bytes;
  }

  addToGraph(
    graph: FrameGraph,
    input: NativeTemporalFactsInput,
    bind: NativeTemporalFactsGraphBinder,
  ): NativeTemporalFactProducts {
    this.assertPreparedFrame(input.width, input.height);
    if (
      !Number.isSafeInteger(input.materialSlotCount) ||
      input.materialSlotCount < 1 ||
      input.materialSlotCount > 0xffffffff
    ) {
      throw new RangeError("Native Temporal Facts requires a valid native material slot count");
    }
    const previous = graph.import_resource(
      "Native Temporal Facts/previous identity",
      { kind: "imported", domain: "internal-full" },
      bind("previous-identity", (runtime) => runtime.history("read")),
    );
    const current = graph.import_resource(
      "Native Temporal Facts/current identity",
      { kind: "imported", domain: "internal-full" },
      bind("current-identity", (runtime) => runtime.history("write")),
    );
    const node = graph.add("Native Temporal Facts/resolve", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      this.constantWords[0] = data.width;
      this.constantWords[1] = data.height;
      this.constantWords[2] = Number(this.readValid);
      this.constantWords[3] = data.materialSlotCount;
      this.constantWords[4] = data.sourceBindings.meshletWordBase;
      this.constantWords[5] = data.sourceBindings.vertexDataWordBase;
      command.writeBuffer(this.constants, 0, this.constantWords.buffer, 0, 32);
      const texture = (id: ResourceId) => resolveTextureView(resources.get(id));
      const buffer = (id: ResourceId) => ({ buffer: resources.get(id) as GPUBuffer });
      const group = this.bindGroups.create(this.device, {
        layout: this.layout,
        entries: [
          { binding: 0, resource: texture(data.visibility) },
          { binding: 2, resource: texture(data.depth) },
          { binding: 3, resource: texture(previous) },
          { binding: 4, resource: buffer(data.meshletWork) },
          { binding: 5, resource: buffer(data.instances) },
          { binding: 7, resource: buffer(data.currentCamera) },
          { binding: 8, resource: buffer(data.previousCamera) },
          { binding: 9, resource: { buffer: this.constants } },
          { binding: 10, resource: texture(motion) },
          { binding: 11, resource: texture(mask) },
          { binding: 12, resource: texture(identity) },
          { binding: 15, resource: buffer(data.assetMetadata) },
          { binding: 16, resource: buffer(data.vertexPayload) },
          { binding: 17, resource: buffer(data.materialVersions) },
          { binding: 18, resource: texture(data.opaqueReactive) },
        ],
      });
      const pass = command.beginComputePass({ label: "Native Temporal Facts/resolve" });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(data.width / 8), Math.ceil(data.height / 8));
      pass.end();
    });
    for (const id of [
      input.visibility,
      input.depth,
      input.opaqueReactive,
      input.meshletWork,
      input.instances,
      input.materialVersions,
      input.currentCamera,
      input.previousCamera,
      input.assetMetadata,
      input.vertexPayload,
      previous,
    ]) {
      node.read(id);
    }
    const motion = node.create("Native Temporal Facts/motion", {
      kind: "transient_texture",
      width: input.width,
      height: input.height,
      format: "rg32float",
      domain: "internal-full",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const mask = node.create("Native Temporal Facts/reactive and validity", {
      kind: "transient_texture",
      width: input.width,
      height: input.height,
      format: "rgba8unorm",
      domain: "internal-full",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const identity = node.write(current);
    return { motion, mask, identity };
  }

  commit(gpuDone: Promise<void>): void {
    if (this.pending === null) {
      throw new Error("Native Temporal Facts commit without prepared frame");
    }
    if (this.active !== this.pending) {
      this.retire(this.active, this.lastGpuDone);
      this.active = this.pending;
    }
    this.pending = null;
    this.invalidateNext = false;
    this.lastGpuDone = gpuDone;
  }

  /** Caller guarantees the aborted encoder was not submitted. */
  abort(): void {
    if (this.pending !== this.active) {
      this.retire(this.pending, null);
    }
    this.pending = null;
  }

  destroy(): void {
    this.bindGroups.clear();
    if (this.destroyed) {
      return;
    }
    this.abort();
    this.retire(this.active, this.lastGpuDone);
    this.active = null;
    const destroyConstants = () => {
      this.constants.destroy();
      this.constantsLive = false;
    };
    if (this.lastGpuDone) {
      void this.lastGpuDone.then(destroyConstants, destroyConstants);
    } else {
      destroyConstants();
    }
    this.destroyed = true;
  }

  private retire(set: HistorySet | null, fence: Promise<void> | null): void {
    if (set === null) {
      return;
    }
    const bytes = set.width * set.height * 32;
    const destroy = () => {
      set.textures[0].destroy();
      set.textures[1].destroy();
      if (fence) {
        this.retiredBytes -= bytes;
      }
    };
    if (fence) {
      this.retiredBytes += bytes;
      void fence.then(destroy, destroy);
    } else {
      destroy();
    }
  }
}
