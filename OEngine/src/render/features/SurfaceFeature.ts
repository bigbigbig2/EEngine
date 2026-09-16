import type {
  FrameGraph,
  FrameGraphContext
} from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuSparseShadingAssetHeapBindings } from "../../gpu/GpuAssetStore.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { GPU_SHADING_FRAME_STATUS_BYTES } from "../../gpu/GpuShadingFrameStatusAbi.js";
import { GPU_SHADING_BIN_ABI_VERSION } from "../../gpu/GpuShadingBinAbi.js";
import {
  GPU_SHADING_OUTPUT_DEPENDENCY
} from "../../gpu/GpuSparseShadingPipelineContract.js";
import {
  GPU_SPARSE_SHADING_VIEW_BYTES,
  packGpuSparseShadingView
} from "../../gpu/GpuSparseShadingFrameAbi.js";
import {
  LINEAR_CLAMP_SAMPLER_DESCRIPTOR,
  SHADOW_COMPARISON_SAMPLER_DESCRIPTOR
} from "../../gpu/GPUSamplerCache.js";
import type { LightClusterOutputs } from "../passes/LightClusterPass.js";
import type { ShadingBinFrameBindings } from "../passes/ShadingBinPass.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import type { SparseShadingGpuRevision } from "../pipeline/SparseShadingGpuRevision.js";
import {
  diffuseSurfaceLiteFrame,
  directLightingFrame,
  shadingBinFrame,
  shadingSurfaceLiteFrame,
  specializedShadingFrame,
  textureDomain,
  type SpecializedShadingFrame,
  type VisibilityFrame
} from "../pipeline/FrameProducts.js";

export interface SparseShadingTextureBindingSetResources {
  readonly id: number;
  /** Sparse by physical bank index; null entries are not imported/read. */
  readonly textureBanks: readonly (ResourceId | null)[];
}

export interface SurfaceFeatureJob {
  readonly frameIndex: number;
  readonly materialCount: number;
  readonly materialGeneration: number;
  readonly textureGeneration: number;
  readonly materialPublicationRevision: number;
  readonly assetHeaps: Readonly<GpuSparseShadingAssetHeapBindings>;
  readonly preExposure: number;
  readonly upscaleRatio: readonly [number, number];
  readonly cameraPosition: readonly [number, number, number];
  readonly currentViewProjection: ArrayLike<number>;
  readonly previousViewProjection: ArrayLike<number>;
}

export interface SurfaceFeatureInputs {
  readonly revision: Readonly<SparseShadingGpuRevision>;
  readonly visibility: VisibilityFrame;
  readonly instanceRecords: ResourceId;
  readonly assetMetadataHeap: ResourceId;
  readonly vertexPayloadHeap: ResourceId;
  /** Product metadata/banks; V2 frames bind the existing heaps as harmless fallbacks. */
  readonly virtualProductMetadata: ResourceId;
  readonly virtualProductBanks: readonly [ResourceId, ResourceId, ResourceId, ResourceId];
  readonly materialRecords: ResourceId;
  readonly textureDescriptorRoutingHeap: ResourceId;
  readonly textureBindingSets: readonly SparseShadingTextureBindingSetResources[];
  readonly lightDatabase: ResourceId | null;
  readonly clusters: LightClusterOutputs | null;
  readonly shadowAtlas: ResourceId | null;
  readonly environment: ResourceId | null;
  readonly diffuseIrradiance: ResourceId | null;
  readonly splitSum: ResourceId | null;
}

/**
 * ADR-0013 production opaque owner. Visibility's r8uint identity is classified
 * into revision-owned sparse queues, then consumed only by active-bin indirect
 * specialized kernels. Material evaluation and direct lighting happen once in
 * that same kernel; no CPU-visible list participates in dispatch generation.
 */
export class SurfaceFeature {
  private viewBuffer: GPUBuffer | null = null;
  private activeBinCount = 0;
  private executionMode: "none" | "direct-single-bin" | "sparse-microtile" = "none";
  private outputBytesPerPixel = 0;
  private resolveRan = false;

  constructor(private readonly graphics: GraphicsContext) {}

  get lastActiveBinCount(): number { return this.activeBinCount; }
  get lastExecutionMode(): "none" | "direct-single-bin" | "sparse-microtile" { return this.executionMode; }
  get surfaceBytesPerPixel(): number { return this.outputBytesPerPixel; }
  get materialResolveBackend(): "sparse-shading-bin" { return "sparse-shading-bin"; }
  get lastResolveRan(): boolean { return this.resolveRan; }

  /** Resets per-frame evidence even when the compiled graph recipe is reused. */
  beginFrame(revision: Readonly<SparseShadingGpuRevision>): void {
    const snapshot = revision.snapshot;
    this.activeBinCount = snapshot.pipelines.length;
    this.executionMode = snapshot.executionMode;
    this.outputBytesPerPixel = snapshot.pipelines.length === 0
      ? 0
      : sparseOutputBytesPerPixel(snapshot.context.outputDependencyMask);
    this.resolveRan = false;
  }

  addToGraph(
    graph: FrameGraph,
    job: SurfaceFeatureJob,
    inputs: SurfaceFeatureInputs
  ): SpecializedShadingFrame | null {
    const snapshot = inputs.revision.snapshot;
    const bins = inputs.revision.bins;
    const resolveOwner = inputs.revision.resolve;
    const settingsBuffer = inputs.revision.settings;
    const statusBuffer = inputs.revision.status;
    if (snapshot.pipelines.length === 0) {
      if (bins !== null || resolveOwner !== null || settingsBuffer !== null || statusBuffer !== null) {
        throw new Error("Sparse shading no-opaque revision retained GPU work owners");
      }
      return null;
    }
    if (resolveOwner === null) {
      throw new Error("Sparse shading opaque revision is missing its resolve owner");
    }
    if (snapshot.executionMode === "sparse-microtile" &&
        (bins === null || settingsBuffer === null || statusBuffer !== null)) {
      throw new Error("SparseMicrotile revision has an invalid GPU closure");
    }
    if (snapshot.executionMode === "direct-single-bin" &&
        (bins !== null || settingsBuffer !== null || statusBuffer === null ||
          statusBuffer.size !== GPU_SHADING_FRAME_STATUS_BYTES)) {
      throw new Error("DirectSingleBin revision has an invalid GPU closure");
    }
    if (snapshot.executionMode !== "sparse-microtile" &&
        snapshot.executionMode !== "direct-single-bin") {
      throw new Error("Opaque revision has no executable shading mode");
    }
    if (snapshot.context.width !== inputs.visibility.domain.width ||
        snapshot.context.height !== inputs.visibility.domain.height) {
      throw new Error("Sparse shading revision extent does not match VisibilityFrame");
    }
    const opaqueLit = snapshot.summary.opaqueLitReceiverCount > 0;
    if (opaqueLit !== (inputs.clusters !== null && inputs.lightDatabase !== null)) {
      throw new Error("Sparse shading lit specialization does not match LightCluster inputs");
    }
    if (snapshot.context.shadowSamplingEnabled !== (inputs.shadowAtlas !== null)) {
      throw new Error("Sparse shading shadow specialization does not match its atlas input");
    }
    const environmentIbl = (snapshot.context.outputDependencyMask &
      GPU_SHADING_OUTPUT_DEPENDENCY.EnvironmentIBL) !== 0;
    if (environmentIbl && (
      inputs.environment === null ||
      inputs.diffuseIrradiance === null ||
      inputs.splitSum === null
    )) {
      throw new Error("Sparse shading environment IBL specialization is missing its resources");
    }

    this.viewBuffer ??= this.graphics.device.createBuffer({
      label: "ADR-0013 production sparse shading view",
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    // Capture the exact sampler closure in this graph recipe. Textureless and
    // shadow-off publications must not even request their cached samplers.
    const samplers = new Map<string, GPUSampler>();
    for (const pipeline of snapshot.pipelines) {
      for (const group of pipeline.groups) {
        for (const binding of group.bindings) {
          if (samplers.has(binding.name)) continue;
          if (binding.name.startsWith("material_sampler_")) {
            const index = Number(binding.name.slice("material_sampler_".length));
            const address = ["repeat", "clamp-to-edge", "mirror-repeat"] as const;
            if (!Number.isInteger(index) || index < 0 || index >= 6) {
              throw new Error(`Invalid sparse shading sampler '${binding.name}'`);
            }
            samplers.set(binding.name, materialSampler(
              this.graphics, address[index % 3]!, index < 3 ? "linear" : "nearest"
            ));
          } else if (binding.name === "shadow_sampler") {
            samplers.set(binding.name, this.graphics.samplers.obtain(SHADOW_COMPARISON_SAMPLER_DESCRIPTOR));
          } else if (binding.name === "environment_sampler") {
            samplers.set(binding.name, this.graphics.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR));
          }
        }
      }
    }
    let view = graph.import_resource(
      "SparseShading/production-view",
      { kind: "imported", label: "ADR-0013 240-byte production shading view" },
      this.viewBuffer
    );
    const upload = graph.add(
      "SparseShading/update production view",
      job,
      (frame, resources, context) => {
        const packed = packGpuSparseShadingView({
          width: snapshot.context.width,
          height: snapshot.context.height,
          materialCount: frame.materialCount,
          materialGeneration: frame.materialGeneration,
          textureGeneration: frame.textureGeneration,
          publicationRevision: frame.materialPublicationRevision,
          assets: frame.assetHeaps,
          frameIndex: frame.frameIndex,
          preExposure: frame.preExposure,
          upscaleRatio: frame.upscaleRatio,
          cameraPosition: frame.cameraPosition,
          currentViewProjection: frame.currentViewProjection,
          previousViewProjection: frame.previousViewProjection
        });
        requireCommand(context).writeBuffer(
          requireBuffer(resources.get(view), "sparse shading view"),
          0,
          packed,
          0,
          GPU_SPARSE_SHADING_VIEW_BYTES
        );
      }
    );
    view = upload.write(view);

    const sparseMode = snapshot.executionMode === "sparse-microtile";
    let heap: ResourceId | null = null;
    let indirectArgs: ResourceId | null = null;
    let settings: ResourceId | null = null;
    let status: ResourceId | null = null;
    if (sparseMode) {
      heap = graph.import_resource(
        "SparseShading/heap",
        { kind: "imported", label: "ADR-0013 revision-owned shading-bin heap" },
        bins!.heap
      );
      indirectArgs = graph.import_resource(
        "SparseShading/indirect-args",
        { kind: "imported", label: "ADR-0013 revision-owned indirect arguments" },
        bins!.indirectArgs
      );
      settings = graph.import_resource(
        "SparseShading/settings",
        { kind: "imported", label: "ADR-0013 revision-owned bin settings" },
        settingsBuffer!
      );
    } else {
      status = graph.import_resource(
        "SparseShading/direct-status",
        { kind: "imported", label: "ADR-0015 DirectSingleBin frame status" },
        statusBuffer!
      );
    }
    const frameBindings = new WeakMap<FrameGraphContext, Readonly<ShadingBinFrameBindings>>();
    let previousPass = upload;
    if (sparseMode) {
      const classifier = graph.add(
        "SparseShading/clear + classify production Visibility MRT",
        {},
        (_data, resources, context) => {
          const bindings = bins!.createFrameBindingsForExecution({
            shadingBinId: resolveTextureView(resources.get(inputs.visibility.shadingBinId!)),
            settings: requireBuffer(resources.get(settings!), "sparse shading settings"),
            settingsDynamicOffset: 0,
            generation: snapshot.generation,
            layoutRevision: snapshot.layoutRevision
          });
          frameBindings.set(context, bindings);
          bins!.encodeClassify(requireCommand(context), bindings);
        }
      );
      classifier.read(inputs.visibility.shadingBinId!);
      classifier.read(settings!);
      heap = classifier.write(heap!);
      indirectArgs = classifier.write(indirectArgs!);
      classifier.declareEncoderWork({ computePasses: 1, dispatches: 1 });

      const finalizer = graph.add(
        "SparseShading/finalize production indirect arguments",
        {},
        (_data, _resources, context) => {
          const bindings = frameBindings.get(context);
          if (bindings === undefined) {
            throw new Error("Sparse shading finalizer has no classifier binding snapshot");
          }
          bins!.encodeFinalize(requireCommand(context), bindings);
        }
      );
      finalizer.dependsOn(classifier);
      finalizer.read(heap);
      heap = finalizer.write(heap!);
      indirectArgs = finalizer.write(indirectArgs!);
      finalizer.declareEncoderWork({ computePasses: 1, dispatches: 1 });
      previousPass = finalizer;
    } else {
      const statusClear = graph.add(
        "SparseShading/clear DirectSingleBin status",
        {},
        (_data, resources, context) => {
          requireCommand(context).clearBuffer(
            requireBuffer(resources.get(status!), "DirectSingleBin status"),
            0,
            8
          );
        }
      );
      statusClear.read(status!);
      status = statusClear.write(status!);
      statusClear.declareEncoderWork({ computePasses: 0 });
      previousPass = statusClear;
    }

    const width = snapshot.context.width;
    const height = snapshot.context.height;
    const outputMask = snapshot.context.outputDependencyMask;
    const outputs: {
      hdr: ResourceId;
      normal: ResourceId | null;
      albedoAo: ResourceId | null;
      material: ResourceId | null;
      velocity: ResourceId | null;
    } = { hdr: -1, normal: null, albedoAo: null, material: null, velocity: null };
    const outputInit = graph.add(
      "SparseShading/initialize production HDR",
      {},
      (_data, resources, context) => {
        const pass = requireCommand(context).beginRenderPass({
          label: "ADR-0013 initialize sparse direct HDR",
          colorAttachments: [{
            view: resolveTextureView(resources.get(outputs.hdr)),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store"
          }]
        });
        pass.end();
      }
    );
    outputInit.dependsOn(previousPass);
    outputs.hdr = outputInit.create(
      "SparseShading/direct-hdr",
      sparseTexture(width, height, "rgba16float",
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC)
    );
    outputInit.declareEncoderWork({ renderPasses: 1 });

    const resolve = graph.add(
      "SparseShading/active-bin production indirect resolve",
      {},
      (_data, resources, context) => {
        const textureSet = (
          descriptor: Readonly<{ textureBindingSetId: number }>
        ): SparseShadingTextureBindingSetResources => {
          const found = inputs.textureBindingSets.find(
            (candidate) => candidate.id === descriptor.textureBindingSetId
          );
          if (found === undefined) {
            throw new Error(
              `Sparse shading TextureBindingSet ${descriptor.textureBindingSetId} is unavailable`
            );
          }
          return found;
        };
        const binding = (
          name: string,
          descriptor: Readonly<{ textureBindingSetId: number }>
        ): GPUBindingResource => {
          const buffers: Readonly<Record<string, ResourceId | null>> = {
            shading_bin_settings: settings,
            shading_bin_heap: heap,
            shading_frame_status: status,
            shading_view: view,
            meshlet_work: inputs.visibility.meshletWork.records,
            instance_records: inputs.instanceRecords,
            asset_metadata_heap: inputs.assetMetadataHeap,
            vertex_payload_heap: inputs.vertexPayloadHeap,
            virtual_product_metadata: inputs.virtualProductMetadata,
            virtual_product_bank_0: inputs.virtualProductBanks[0],
            virtual_product_bank_1: inputs.virtualProductBanks[1],
            virtual_product_bank_2: inputs.virtualProductBanks[2],
            virtual_product_bank_3: inputs.virtualProductBanks[3],
            material_records: inputs.materialRecords,
            texture_descriptor_routing_heap: inputs.textureDescriptorRoutingHeap,
            light_database: inputs.lightDatabase,
            light_cluster_lookup: inputs.clusters?.lookup ?? null,
            light_cluster_data: inputs.clusters?.data ?? null,
            light_cluster_parameters: inputs.clusters?.parameters ?? null
          };
          if (name in buffers) {
            const id = buffers[name];
            if (id === null || id === undefined) {
              throw new Error(`Sparse shading binding '${name}' has no production resource`);
            }
            return { buffer: requireBuffer(resources.get(id), name) };
          }
          const textures: Readonly<Record<string, ResourceId | null>> = {
            shading_bin_id: inputs.visibility.shadingBinId,
            visibility_key: inputs.visibility.visibilityKey,
            visibility_depth: inputs.visibility.depth,
            output_hdr: outputs.hdr,
            output_normal: outputs.normal,
            output_albedo_ao: outputs.albedoAo,
            output_material: outputs.material,
            output_velocity: outputs.velocity,
            shadow_atlas: inputs.shadowAtlas,
            environment_diffuse: inputs.diffuseIrradiance,
            environment_specular: inputs.environment,
            split_sum: inputs.splitSum
          };
          if (name in textures) {
            const id = textures[name];
            if (id === null || id === undefined) {
              throw new Error(`Sparse shading binding '${name}' has no production texture`);
            }
            return resolveTextureView(
              resources.get(id),
              name === "visibility_depth" || name === "shadow_atlas"
                ? { aspect: "depth-only" }
                : undefined
            );
          }
          if (name.startsWith("material_texture_")) {
            const index = Number(name.slice("material_texture_".length));
            const id = textureSet(descriptor).textureBanks[index];
            if (id === undefined || id === null) {
              throw new Error(`Sparse shading binding '${name}' is not resident in the static read set`);
            }
            return resolveTextureView(resources.get(id));
          }
          if (name.startsWith("material_sampler_")) {
            const sampler = samplers.get(name);
            if (sampler === undefined) throw new Error(`Sparse shading binding '${name}' is out of range`);
            return sampler;
          }
          if (name === "shadow_sampler") {
            const sampler = samplers.get(name);
            if (sampler === undefined) throw new Error("Sparse shading shadow sampler is absent");
            return sampler;
          }
          if (name === "environment_sampler") {
            const sampler = samplers.get(name);
            if (sampler === undefined) throw new Error("Sparse shading environment sampler is absent");
            return sampler;
          }
          throw new Error(`Unknown sparse shading production binding '${name}'`);
        };
        const bindings = resolveOwner.createFrameBindingsForExecution(binding);
        resolveOwner.encode(
          requireCommand(context),
          indirectArgs === null ? null : requireBuffer(resources.get(indirectArgs), "sparse shading indirect args"),
          0,
          bindings,
          snapshot.revision
        );
        frameBindings.delete(context);
        this.resolveRan = true;
      }
    );
    resolve.dependsOn(outputInit);
    if ((outputMask & GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite) !== 0) {
      outputs.normal = resolve.create(
        "SparseShading/surface-normal",
        sparseTexture(width, height, "rgba16uint",
          GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING)
      );
    }
    if ((outputMask & GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite) !== 0) {
      outputs.albedoAo = resolve.create(
        "SparseShading/surface-albedo-ao",
        sparseTexture(width, height, "rgba8unorm",
          GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING)
      );
    }
    if ((outputMask & (GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite |
        GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite)) !== 0) {
      outputs.material = resolve.create(
        "SparseShading/surface-material",
        sparseTexture(width, height, "rg32uint",
          GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING)
      );
    }
    if ((outputMask & GPU_SHADING_OUTPUT_DEPENDENCY.Velocity) !== 0) {
      outputs.velocity = resolve.create(
        "SparseShading/velocity",
        sparseTexture(width, height, "rg16float",
          GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING)
      );
    }
    resolve.read(inputs.visibility.visibilityKey);
    if (sparseMode) resolve.read(inputs.visibility.shadingBinId!);
    resolve.read(inputs.visibility.depth);
    resolve.read(inputs.visibility.meshletWork.records);
    if (sparseMode) {
      resolve.read(heap!);
      heap = resolve.write(heap!);
      resolve.read(indirectArgs!);
      resolve.read(settings!);
    } else {
      resolve.read(status!);
      status = resolve.write(status!);
    }
    resolve.read(view);
    for (const id of [
      inputs.instanceRecords,
      inputs.assetMetadataHeap,
      inputs.vertexPayloadHeap,
      inputs.materialRecords,
      inputs.textureDescriptorRoutingHeap
    ]) resolve.read(id);
    for (const set of inputs.textureBindingSets) {
      for (const bank of set.textureBanks) {
        if (bank !== null) resolve.read(bank);
      }
    }
    if (opaqueLit) {
      resolve.read(inputs.lightDatabase!);
      resolve.read(inputs.clusters!.lookup);
      resolve.read(inputs.clusters!.data);
      resolve.read(inputs.clusters!.parameters);
    }
    if (environmentIbl) {
      resolve.read(inputs.environment!);
      resolve.read(inputs.diffuseIrradiance!);
      resolve.read(inputs.splitSum!);
    }
    if (inputs.shadowAtlas !== null) resolve.read(inputs.shadowAtlas);
    outputs.hdr = resolve.write(outputs.hdr);
    if (outputs.normal !== null) outputs.normal = resolve.write(outputs.normal);
    if (outputs.albedoAo !== null) outputs.albedoAo = resolve.write(outputs.albedoAo);
    if (outputs.material !== null) outputs.material = resolve.write(outputs.material);
    if (outputs.velocity !== null) outputs.velocity = resolve.write(outputs.velocity);
    resolve.declareEncoderWork({
      computePasses: 1,
      dispatches: sparseMode ? snapshot.pipelines.length : 1
    });

    const domain = textureDomain("internal-full", width, height, 1);
    const binProduct = sparseMode ? shadingBinFrame({
      abiVersion: GPU_SHADING_BIN_ABI_VERSION,
      heap: heap!,
      indirectArgs: indirectArgs!,
      generation: snapshot.generation,
      activeBinMaskLo: snapshot.summary.activeBinMaskLo,
      activeBinMaskHi: snapshot.summary.activeBinMaskHi,
      microtileWidth: 8,
      microtileHeight: 8,
      domain
    }) : null;
    const publishesShading =
      (outputMask & GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite) !== 0 &&
      outputs.normal !== null && outputs.material !== null;
    const publishesDiffuse =
      (outputMask & GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite) !== 0 &&
      outputs.albedoAo !== null && outputs.material !== null;
    return specializedShadingFrame({
      bins: binProduct,
      status,
      direct: directLightingFrame({ hdr: outputs.hdr, domain }),
      shading: publishesShading
        ? shadingSurfaceLiteFrame({
            normal: outputs.normal!,
            roughnessFlags: outputs.material!,
            metallicSpecular: outputs.material!,
            normalSpace: "world",
            domain
          })
        : null,
      diffuse: publishesDiffuse
        ? diffuseSurfaceLiteFrame({
            diffuseReflectance: outputs.albedoAo!,
            materialAo: outputs.albedoAo!,
            receiverFlags: outputs.material!,
            colorSpace: "working-linear",
            receiverModulation: "unapplied",
            domain
          })
        : null,
      velocity: outputs.velocity,
      domain
    });
  }

  destroy(): void {
    this.viewBuffer?.destroy();
    this.viewBuffer = null;
  }
}

function sparseTexture(
  width: number,
  height: number,
  format: GPUTextureFormat,
  usage: GPUTextureUsageFlags
) {
  return {
    kind: "transient_texture" as const,
    width,
    height,
    depthOrArrayLayers: 1,
    format,
    usage,
    domain: "internal-full" as const
  };
}

function sparseOutputBytesPerPixel(mask: number): number {
  let bytes = 8;
  if ((mask & GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite) !== 0) bytes += 8;
  if ((mask & (GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite |
      GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite)) !== 0) bytes += 8;
  if ((mask & GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite) !== 0) bytes += 4;
  if ((mask & GPU_SHADING_OUTPUT_DEPENDENCY.Velocity) !== 0) bytes += 4;
  return bytes;
}

function materialSampler(
  graphics: GraphicsContext,
  addressMode: GPUAddressMode,
  filter: GPUFilterMode
): GPUSampler {
  return graphics.samplers.obtain({
    addressModeU: addressMode,
    addressModeV: addressMode,
    addressModeW: addressMode,
    magFilter: filter,
    minFilter: filter,
    mipmapFilter: filter
  });
}

function requireCommand(context: FrameGraphContext): ShadeGPUCommandContext {
  const command = context.encoder;
  if (command === null || typeof command !== "object" ||
      !("isGPUCommandContext" in command) || command.isGPUCommandContext !== true) {
    throw new Error("Sparse shading production composition requires ShadeGPUCommandContext");
  }
  return command as ShadeGPUCommandContext;
}

function requireBuffer(value: unknown, label: string): GPUBuffer {
  if (value === null || value === undefined || typeof value !== "object") {
    throw new Error(`Sparse shading ${label} buffer is unavailable`);
  }
  return value as GPUBuffer;
}

export type { ResourceId };
