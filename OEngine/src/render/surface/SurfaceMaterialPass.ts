import { SurfaceProbePass } from "./SurfaceProbePass.js";
import type { SurfaceProbeBudget } from "./SurfaceProbe.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { GPUViewContext } from "../ViewContext.js";
import { GPU_SPARSE_SHADING_VIEW_BYTES, packGpuSparseShadingView } from "../../gpu/GpuSparseShadingFrameAbi.js";
import { createSurfaceBindGroupLayouts, compileSurfaceProgramLayout,
  type SurfacePhysicalBinding } from "./SurfaceKernelBindingPlan.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { surfaceSampleWorkerWgsl } from "../../shaders/surface_sample_worker.js";
import { surfaceSampleBuilderWgsl, SURFACE_SAMPLE_FINALIZE_WGSL, SURFACE_SAMPLE_RESOLVE_WGSL } from "../../shaders/surface_sample_work.js";
import { surfaceSampleCapacity, packSurfaceSampleHeader, packSurfaceSampleDispatch,
  type SurfaceSampleWorkerMode, SURFACE_SAMPLE_INDIRECT_BYTES, SURFACE_SAMPLE_HEADER } from "./SurfaceSampleAbi.js";
import type { PreExposureContract } from "../RadiometryContract.js";
import type { VsmResources } from "../vsm/VsmResources.js";
import type { VsmDirectionalFrameConstants } from "../vsm/VsmReceiverDemandPass.js";
import type { ShadowVisibilityFrame } from "../pipeline/FrameProducts.js";
import { SHADOW_DEPTH_BIAS, SHADOW_DEPTH_SLOPE_SCALE, SHADOW_NORMAL_OFFSET_SCALE } from "../../gpu/ShadowContract.js";
import { ShaderModuleCache } from "../../gpu/GPUDescriptorCaches.js";

export interface SurfaceMaterialFrame {
  readonly runtime: GpuRenderWorldRuntime;
  readonly assets: GpuAssetBindings;
  readonly view: GPUViewContext;
  readonly frameIndex: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly preExposure: PreExposureContract;
}
export interface SurfaceMaterialInputs {
  readonly width: number;
  readonly height: number;
  readonly frame: SurfaceMaterialFrame;
  readonly preExposureBuffer: ResourceId;
  readonly activeSets: readonly number[];
  readonly textureBankMask: number;
  readonly hasLit: boolean;
  /** Same-frame XeGTAO scalar product. Omitted when no lit consumer exists. */
  readonly indirectVisibility?: ResourceId;
  readonly virtualGeometry: boolean;
  readonly visibilityKey: ResourceId;
  readonly meshletWork: ResourceId;
  readonly materialRecords: ResourceId;
  readonly depth: ResourceId;
  readonly instances: ResourceId;
  readonly geometryMetadata: ResourceId;
  readonly vertexPayload: ResourceId;
  readonly virtualMetadata?: ResourceId;
  readonly virtualBanks?: readonly ResourceId[];
  readonly textureRoutes: ResourceId;
  readonly textureResidencyVersions: ResourceId;
  readonly textureBanks: readonly (readonly ResourceId[])[];
  readonly lightRecords?: ResourceId;
  readonly lightLookup?: ResourceId;
  readonly lightData?: ResourceId;
  readonly lightParams?: ResourceId;
  readonly physicalEnvironmentSun?: ResourceId;
  readonly physicalEnvironmentTransmittance?: ResourceId;
  readonly physicalSkyIrradiance?: ResourceId;
  readonly physicalSkySpecular?: ResourceId;
  readonly physicalSkyDfg?: ResourceId;
  /** Read-only VSM publication consumed by the direct-light shader. */
  readonly shadowVisibility?: {
    readonly resources: VsmResources;
    readonly frame: ShadowVisibilityFrame;
    readonly vsmFrame: VsmDirectionalFrameConstants;
  };
}
type SurfaceVsmBindings = Readonly<{
  pageTable: ResourceId;
  atlasDepth: ResourceId;
  constants: ResourceId;
}>;
type Program = Readonly<{
  pipeline: GPUComputePipeline;
  layouts: readonly GPUBindGroupLayout[];
  bindings: readonly Readonly<SurfacePhysicalBinding>[];
}>;

export class SurfaceMaterialPass {
  private readonly shaderModules: ShaderModuleCache;
  private readonly programs = new Map<string, Program>();
  private readonly layouts = new Map<string, readonly GPUBindGroupLayout[]>();
  private readonly builders = new Map<string, GPUComputePipeline>();
  private readonly viewBuffer: GPUBuffer;
  private readonly samplers: readonly GPUSampler[];
  private readonly finalize: GPUComputePipeline;
  private readonly resolve: GPUComputePipeline;
  private readonly probe: SurfaceProbePass;
  constructor(private readonly device: GPUDevice, probeBudget?: SurfaceProbeBudget) {
    this.shaderModules = new ShaderModuleCache(device);
    this.probe = new SurfaceProbePass(device, probeBudget);
    this.viewBuffer = device.createBuffer({ label: "Surface/frame view",
      size: Math.ceil(GPU_SPARSE_SHADING_VIEW_BYTES / 256) * 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const modes = ["repeat", "clamp-to-edge", "mirror-repeat"] as const;
    this.samplers = Object.freeze(Array.from({ length: 6 }, (_, index) => {
      const filter = index < 3 ? "linear" : "nearest";
      return device.createSampler({ addressModeU: modes[index % 3], addressModeV: modes[index % 3],
        magFilter: filter, minFilter: filter, mipmapFilter: filter });
    }));
    this.finalize = device.createComputePipeline({ label: "Surface/finalize sample indirect", layout: "auto", compute: {
      module: this.shaderModules.obtain({ label: "Surface/finalize sample indirect", code: SURFACE_SAMPLE_FINALIZE_WGSL }), entryPoint: "finalize" } });
    this.resolve = device.createComputePipeline({ label: "Surface/coarse sample Resolve", layout: "auto", compute: {
      module: this.shaderModules.obtain({ label: "Surface/coarse sample Resolve", code: SURFACE_SAMPLE_RESOLVE_WGSL }), entryPoint: "resolve" } });
  }
  addToGraph(graph: FrameGraph, input: SurfaceMaterialInputs): {
    radiance: ResourceId; work: ResourceId; sampleResults: ResourceId;
    probeCandidates: ResourceId; probeCounters: ResourceId;
  } {
    const capacity = surfaceSampleCapacity(input.width, input.height, this.device.limits);
    const frameView = graph.import_resource("surface-frame-view",
      { kind: "imported", label: "Surface frame view" }, this.viewBuffer);
    const upload = graph.add("Surface/update material frame view", input.frame,
      (frame, _resources, context) => {
        const camera = frame.view.camera.camera;
        const packed = packGpuSparseShadingView({
          width: input.width, height: input.height,
          materialCount: frame.runtime.materialResources.materialCapacity,
          materialGeneration: frame.runtime.materialGeneration,
          textureGeneration: frame.runtime.textureGeneration,
          publicationRevision: frame.runtime.materialPublicationRevision,
          assets: frame.assets.sparseShading, frameIndex: frame.frameIndex,
          preExposure: frame.preExposure.multiplier,
          upscaleRatio: [frame.outputWidth / input.width, frame.outputHeight / input.height],
          cameraPosition: [camera.transform.matrix[12]!, camera.transform.matrix[13]!,
            camera.transform.matrix[14]!],
          currentViewProjection: frame.view.camera.view_projection_matrix,
          previousViewProjection: frame.view.gpu_previous_camera_state.view_projection_matrix
        });
        (context.encoder as ShadeGPUCommandContext).writeBuffer(
          this.viewBuffer, 0, packed, 0, GPU_SPARSE_SHADING_VIEW_BYTES);
      });
    const currentView = upload.write(frameView);
    let vsmBindings: SurfaceVsmBindings | undefined;
    if (input.shadowVisibility !== undefined) {
      if (!input.hasLit) throw new Error("VSM shadow visibility requires a lit Surface consumer");
      const owner = input.shadowVisibility.resources;
      if (owner.profile === "shadow-disabled" || owner.pageTable === null ||
          owner.atlasDepth === null || owner.pageConstants === null) {
        throw new Error("Surface VSM publication is missing its read-only resources");
      }
      const update = graph.add("Surface/update VSM sampling constants",
        input.shadowVisibility.vsmFrame, (_frame, _resources, context) => {
          const data = packVsmSamplingConstants(input.shadowVisibility!.resources,
            input.shadowVisibility!.vsmFrame);
          (context.encoder as ShadeGPUCommandContext).writeBuffer(
            owner.pageConstants!, 0, data, 0, data.byteLength);
        });
      vsmBindings = Object.freeze({
        pageTable: required(input.shadowVisibility.frame.virtualPageTable ?? undefined, "vsm-page-table"),
        atlasDepth: required(input.shadowVisibility.frame.physicalAtlasDepth ?? undefined, "vsm-atlas-depth"),
        constants: update.write(required(input.shadowVisibility.frame.lightProjection ?? undefined,
          "vsm-sampling-constants"))
      });
    }
    const hasLit = input.hasLit, scalarAo = input.indirectVisibility !== undefined;
    if (scalarAo && !hasLit) throw new Error("Surface AO has no lit consumer");
    const activeSets = [...new Set(input.activeSets)].sort((left, right) => left - right);
    const builderKey = String(hasLit) + ":" + scalarAo;
    let builderPipeline = this.builders.get(builderKey);
    if (!builderPipeline) {
      builderPipeline = this.device.createComputePipeline({ label: "Surface/tile Work Builder", layout: "auto", compute: {
        module: this.shaderModules.obtain({ label: "Surface/tile Work Builder", code: surfaceSampleBuilderWgsl(hasLit, scalarAo) }), entryPoint: "build" } });
      this.builders.set(builderKey, builderPipeline);
    }
    const builderProgram = builderPipeline;
    const probe = this.probe.addToGraph(graph, input, currentView);
    const builder = graph.add("Surface/tile Work Builder", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const queue = resources.get(work) as GPUBuffer;
      command.clearBuffer(queue);
      const header = packSurfaceSampleHeader(capacity); header[SURFACE_SAMPLE_HEADER.errorProfile] = activeSets[0] ?? 0;
      command.writeBuffer(queue, 0, header.buffer, 0, header.byteLength);
      const policy = command.allocateTransientBufferAndLoad(new Uint32Array([
        Number(vsmBindings !== undefined || input.physicalEnvironmentSun !== undefined), 0, 0, 0]).buffer, GPUBufferUsage.UNIFORM);
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: queue } },
        { binding: 1, resource: resolveTextureView(resources.get(input.visibilityKey)) },
        { binding: 2, resource: resolveTextureView(resources.get(probe.candidates)) },
        { binding: 3, resource: { buffer: resources.get(input.meshletWork) as GPUBuffer } },
        { binding: 4, resource: { buffer: resources.get(input.materialRecords) as GPUBuffer } },
        { binding: 5, resource: { buffer: resources.get(currentView) as GPUBuffer } },
        { binding: 6, resource: { buffer: policy } }
      ];
      if (hasLit) entries.push({ binding: 7, resource: { buffer: resources.get(required(input.lightData, "light-data")) as GPUBuffer } });
      if (scalarAo) entries.push({ binding: 8, resource: { buffer: resources.get(input.indirectVisibility!) as GPUBuffer } });
      const pass = command.beginComputePass({ label: "Surface/tile Work Builder" });
      pass.setPipeline(builderProgram); pass.setBindGroup(0, this.device.createBindGroup({
        layout: builderProgram.getBindGroupLayout(0), entries }));
      pass.dispatchWorkgroups(capacity.tilesX, capacity.tilesY); pass.end();
    });
    for (const id of [input.visibilityKey, probe.candidates, input.meshletWork, input.materialRecords, currentView]) builder.read(id);
    if (hasLit) builder.read(required(input.lightData, "light-data"));
    if (scalarAo) builder.read(input.indirectVisibility!);
    const work = builder.create("Surface/tile states and compact work", { kind: "transient_buffer",
      size: capacity.workBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    const finalize = graph.add("Surface/finalize sample indirect", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const pass = command.beginComputePass({ label: "Surface/finalize sample indirect" });
      pass.setPipeline(this.finalize); pass.setBindGroup(0, this.device.createBindGroup({
        layout: this.finalize.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: resources.get(work) as GPUBuffer } },
          { binding: 1, resource: { buffer: resources.get(indirect) as GPUBuffer } }
        ] })); pass.dispatchWorkgroups(1); pass.end();
    });
    const finalizedWork = finalize.write(work);
    const indirect = finalize.create("Surface/sample indirect", { kind: "transient_buffer",
      size: SURFACE_SAMPLE_INDIRECT_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT });
    const virtualBankCount = input.virtualBanks?.length ?? 0;
    const physicalEnvironment = input.physicalEnvironmentSun !== undefined;
    const program = this.program(hasLit, input.virtualGeometry, virtualBankCount, input.textureBankMask,
      physicalEnvironment, scalarAo, vsmBindings !== undefined);
    const workers = graph.add("Surface/material and lighting samples", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const clear = command.beginRenderPass({ label: "Surface/background", colorAttachments: [{
        view: resolveTextureView(resources.get(radiance)), loadOp: "clear", storeOp: "store",
        clearValue: { r: 0.025, g: 0.035, b: 0.05, a: 1 } }] }); clear.end();
      const dispatches = activeSets.map(setId => {
        const parametersFor = (mode: SurfaceSampleWorkerMode): GPUBuffer =>
          command.allocateTransientBufferAndLoad(packSurfaceSampleDispatch(setId, mode).buffer, GPUBufferUsage.UNIFORM);
        const bindGroup = (groupIndex: number, parameters: GPUBuffer): GPUBindGroup => this.device.createBindGroup({
          layout: program.layouts[groupIndex]!, entries: program.bindings.filter(binding => binding.group === groupIndex).map(binding => ({
            binding: binding.binding, resource: this.resolveBinding(binding, input, currentView, radiance,
              finalizedWork, sampleResults, setId, parameters, resources, vsmBindings) })) });
        const parameters = parametersFor("implicit");
        return { setId, groups: program.layouts.map((_layout, index) => bindGroup(index, parameters)),
          compact: bindGroup(0, parametersFor("compact")), fallback: bindGroup(0, parametersFor("fallback")) };
      });
      // Upload copies must be encoded before opening the compute pass.
      const pass = command.beginComputePass({ label: "Surface/material and lighting samples" });
      pass.setPipeline(program.pipeline);
      for (const dispatch of dispatches) {
        dispatch.groups.forEach((group, index) => pass.setBindGroup(index, group));
        pass.dispatchWorkgroupsIndirect(resources.get(indirect) as GPUBuffer, dispatch.setId * 32);
        // Only group zero contains dispatch parameters. Resident and lighting
        // groups remain bound for all three work kinds.
        pass.setBindGroup(0, dispatch.compact);
        pass.dispatchWorkgroupsIndirect(resources.get(indirect) as GPUBuffer, dispatch.setId * 32 + 16);
        pass.setBindGroup(0, dispatch.fallback);
        pass.dispatchWorkgroups(capacity.tilesX, capacity.tilesY);
      }
      pass.end();
    });
    workers.read(indirect);
    const completedWork = workers.write(finalizedWork);
    for (const binding of program.bindings) {
      if (["radiance-output", "sample-results", "shading-work", "sample-profile", "texture-samplers"].includes(binding.role) ||
          binding.role.endsWith("sampler")) continue;
      if (binding.role === "frame-view") workers.read(currentView);
      else if (binding.role === "texture-banks") {
        for (const setId of activeSets) workers.read(required(input.textureBanks[setId]?.[binding.element], "texture-bank"));
      } else workers.read(this.resolveResourceId(binding, input, 0, vsmBindings));
    }
    const radiance = workers.create("Surface/radiance", { kind: "transient_texture", width: input.width, height: input.height,
      format: "rgba16float", domain: "internal-full", usage: GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    const sampleResults = workers.create("Surface/immutable coarse results", { kind: "transient_texture",
      width: capacity.resultWidth, height: capacity.resultHeight, format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    const resolve = graph.add("Surface/coarse sample Resolve", {}, (_data, resources, context) => {
      const pass = (context.encoder as ShadeGPUCommandContext).beginComputePass({ label: "Surface/coarse sample Resolve" });
      pass.setPipeline(this.resolve); pass.setBindGroup(0, this.device.createBindGroup({
        layout: this.resolve.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: resources.get(completedWork) as GPUBuffer } },
          { binding: 1, resource: resolveTextureView(resources.get(sampleResults)) },
          { binding: 2, resource: resolveTextureView(resources.get(radiance)) },
          { binding: 3, resource: resolveTextureView(resources.get(input.visibilityKey)) },
          { binding: 4, resource: resolveTextureView(resources.get(input.depth)) }
        ] })); pass.dispatchWorkgroups(capacity.tilesX, capacity.tilesY); pass.end();
    });
    resolve.read(completedWork); resolve.read(sampleResults); resolve.read(input.visibilityKey); resolve.read(input.depth);
    return { radiance: resolve.write(radiance), work: completedWork, sampleResults,
      probeCandidates: probe.candidates, probeCounters: probe.counters };
  }
  private program(hasLit: boolean, virtualGeometry: boolean, virtualBankCount: number,
    textureBankMask: number, physicalEnvironment: boolean, scalarAo: boolean,
    vsmShadowEnabled: boolean): Program {
    const layoutKey = [hasLit, virtualGeometry, virtualBankCount, textureBankMask,
      physicalEnvironment, scalarAo, vsmShadowEnabled].join(":");
    const key = layoutKey;
    const cached = this.programs.get(key); if (cached) return cached;
    const compiled = compileSurfaceProgramLayout({
      kernel: { programId: hasLit ? 15 : 3, outputDependencyMask: 0, textureBankMask },
      virtualGeometry, virtualBankCount, lighting: hasLit ? "direct" : "unlit", physicalEnvironment,
      aoProfile: scalarAo ? "scalar-high" : "off", shadowProfile: vsmShadowEnabled ? "vsm" : "off",
      source: "surface-samples-v1", capabilityFingerprint: "webgpu-core", formatProfile: "rgba16float"
    }, this.device.limits);
    let layouts = this.layouts.get(layoutKey);
    if (!layouts) { layouts = createSurfaceBindGroupLayouts(this.device, compiled.plan); this.layouts.set(layoutKey, layouts); }
    const label = `Surface/samples (${layoutKey})`;
    const pipeline = this.device.createComputePipeline({ label, layout: this.device.createPipelineLayout({ bindGroupLayouts: [...layouts] }),
      compute: { module: this.shaderModules.obtain({ label, code: surfaceSampleWorkerWgsl(compiled.plan,
        hasLit, virtualGeometry, vsmShadowEnabled, virtualBankCount, textureBankMask, physicalEnvironment) }), entryPoint: "shade" } });
    const program = Object.freeze({ pipeline, layouts, bindings: compiled.plan.bindings }); this.programs.set(key, program); return program;
  }
  private resolveBinding(binding: Readonly<SurfacePhysicalBinding>, input: SurfaceMaterialInputs,
    view: ResourceId, hdr: ResourceId, work: ResourceId, results: ResourceId, setId: number,
    parameters: GPUBuffer, resources: { get(id: ResourceId): unknown }, vsmBindings?: SurfaceVsmBindings): GPUBindingResource {
    if (binding.role === "texture-samplers") return this.samplers[binding.element]!;
    if (binding.role === "sample-profile") return { buffer: parameters };
    if (binding.role === "physical-sky-irradiance-sampler" || binding.role === "physical-sky-specular-sampler") return this.samplers[1]!;
    const id = binding.role === "frame-view" ? view : binding.role === "radiance-output" ? hdr :
      binding.role === "sample-results" ? results : binding.role === "shading-work" ? work :
      this.resolveResourceId(binding, input, setId, vsmBindings);
    const resource = resources.get(id);
    if (binding.kind.startsWith("sampled-") || binding.kind.startsWith("write-only-")) return resolveTextureView(resource);
    return { buffer: resource as GPUBuffer };
  }
  private resolveResourceId(binding: Readonly<SurfacePhysicalBinding>,
    input: SurfaceMaterialInputs, setId: number, vsmBindings?: SurfaceVsmBindings): ResourceId {
    switch (binding.role) {
      case "indirect-visibility": return required(input.indirectVisibility, binding.role);
      case "visibility-key": return input.visibilityKey;
      case "meshlet-work": return input.meshletWork;
      case "material-records": return input.materialRecords;
      case "pre-exposure": return input.preExposureBuffer;
      case "visibility-depth": return input.depth;
      case "instance-records": return input.instances;
      case "geometry-metadata": return input.geometryMetadata;
      case "vertex-payload": return input.vertexPayload;
      case "virtual-product-metadata": return required(input.virtualMetadata, binding.role);
      case "virtual-product-banks": return required(input.virtualBanks?.[binding.element], binding.role);
      case "texture-routes": return input.textureRoutes;
      case "texture-banks": return required(input.textureBanks[setId]?.[binding.element],
        `${binding.role} ${setId}:${binding.element}`);
      case "direct-light-records": return required(input.lightRecords, binding.role);
      case "direct-light-cluster-lookup": return required(input.lightLookup, binding.role);
      case "direct-light-cluster-data": return required(input.lightData, binding.role);
      case "direct-light-cluster-params": return required(input.lightParams, binding.role);
      case "physical-environment-sun": return required(input.physicalEnvironmentSun, binding.role);
      case "physical-environment-transmittance": return required(input.physicalEnvironmentTransmittance, binding.role);
      case "physical-sky-irradiance": return required(input.physicalSkyIrradiance, binding.role);
      case "physical-sky-specular": return required(input.physicalSkySpecular, binding.role);
      case "physical-sky-dfg": return required(input.physicalSkyDfg, binding.role);
      case "vsm-page-table": return required(vsmBindings?.pageTable, binding.role);
      case "vsm-atlas-depth": return required(vsmBindings?.atlasDepth, binding.role);
      case "vsm-sampling-constants": return required(vsmBindings?.constants, binding.role);
      default: throw new Error(`Surface role ${binding.role} has no readable resource`);
    }
  }

  destroy(): void {
    this.viewBuffer.destroy();
    this.programs.clear();
    this.layouts.clear();
    this.builders.clear();
    this.shaderModules.clear();
  }
}
function required(value: ResourceId | undefined, role: string): ResourceId {
  if (value === undefined) throw new Error(`Surface binding missing ${role}`);
  return value;
}

function packVsmSamplingConstants(
  resources: VsmResources,
  frame: VsmDirectionalFrameConstants
): ArrayBuffer {
  const capabilities = resources.capabilities;
  const data = new ArrayBuffer(256);
  const floats = new Float32Array(data);
  const uints = new Uint32Array(data);
  if (frame.lightView.length !== 16 || frame.clipOriginExtent.length < capabilities.clipLevels) {
    throw new RangeError("Surface VSM sampling constants have an invalid clipmap shape");
  }
  floats.set(frame.lightView, 0);
  for (let level = 0; level < 6; level++) {
    floats.set(frame.clipOriginExtent[level] ?? [0, 0, 1, 1], 16 + level * 4);
  }
  uints.set([
    capabilities.virtualPagesPerAxis,
    capabilities.pageSize,
    capabilities.border,
    capabilities.atlasPagesPerAxis,
    capabilities.clipLevels,
    frame.generation >>> 0,
    capabilities.pcfTapCount,
    capabilities.atlasDimension
  ], 40);
  floats.set([
    SHADOW_NORMAL_OFFSET_SCALE * 0.001,
    SHADOW_DEPTH_BIAS * 0.0001,
    SHADOW_DEPTH_SLOPE_SCALE * 0.0001,
    0
  ], 48);
  return data;
}
