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
import { surfaceExecutionWgsl, SURFACE_WORK_CONTROL_WGSL,
  type SurfaceExecutionMode } from "../../shaders/surface_execution.js";
import { SURFACE_EXCEPTION_LANES, SURFACE_WORK_INDIRECT_BYTES,
  surfaceLaneCapacity } from "./SurfaceExecutionAbi.js";
import { shadingFrequencyPlanCapacity } from "./ShadingFrequencyPlanAbi.js";
import { SHADING_FREQUENCY_PLAN_WGSL } from "../../shaders/shading_frequency.js";
import type { PreExposureContract } from "../RadiometryContract.js";
import type { VsmResources } from "../vsm/VsmResources.js";
import type { VsmDirectionalFrameConstants } from "../vsm/VsmReceiverDemandPass.js";
import type { ShadowVisibilityFrame } from "../pipeline/FrameProducts.js";
import { SHADOW_DEPTH_BIAS, SHADOW_DEPTH_SLOPE_SCALE, SHADOW_NORMAL_OFFSET_SCALE } from "../../gpu/ShadowContract.js";

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
  readonly activeExceptionLanes?: readonly number[];
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

/** One full-rate Dense producer followed by fixed GPU indirect exception lanes. */
export class SurfaceMaterialPass {
  private readonly programs = new Map<string, Program>();
  private readonly layouts = new Map<string, readonly GPUBindGroupLayout[]>();
  private readonly viewBuffer: GPUBuffer;
  private readonly samplers: readonly GPUSampler[];
  private readonly controlLayout: GPUBindGroupLayout;
  private readonly initialize: GPUComputePipeline;
  private readonly finalize: GPUComputePipeline;
  private readonly frequencyLayout: GPUBindGroupLayout;
  private readonly frequencyPipeline: GPUComputePipeline;
  private readonly probe: SurfaceProbePass;

  constructor(
    private readonly device: GPUDevice,
    private readonly virtualUnlitFallback = false,
    probeBudget?: SurfaceProbeBudget
  ) {
    this.probe = new SurfaceProbePass(device, probeBudget);
    this.viewBuffer = device.createBuffer({
      label: "Surface/frame view", size: Math.ceil(GPU_SPARSE_SHADING_VIEW_BYTES / 256) * 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const modes = ["repeat", "clamp-to-edge", "mirror-repeat"] as const;
    this.samplers = Object.freeze(Array.from({ length: 6 }, (_, index) => {
      const filter = index < 3 ? "linear" : "nearest";
      return device.createSampler({ addressModeU: modes[index % 3],
        addressModeV: modes[index % 3], addressModeW: modes[index % 3],
        magFilter: filter, minFilter: filter, mipmapFilter: filter });
    }));
    this.controlLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
    ] });
    const module = device.createShaderModule({ code: SURFACE_WORK_CONTROL_WGSL });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.controlLayout] });
    this.initialize = device.createComputePipeline({ layout,
      compute: { module, entryPoint: "initialize" } });
    this.finalize = device.createComputePipeline({ layout,
      compute: { module, entryPoint: "finalize" } });
    this.frequencyLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: "write-only", format: "r32uint" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } }
    ] });
    this.frequencyPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.frequencyLayout] }),
      compute: { module: device.createShaderModule({ code: SHADING_FREQUENCY_PLAN_WGSL }),
        entryPoint: "plan" }
    });
  }

  addToGraph(graph: FrameGraph, input: SurfaceMaterialInputs):
    { radiance: ResourceId; work: ResourceId; probeCandidates: ResourceId; probeCounters: ResourceId } {
    const { capacity, queueBytes } = surfaceLaneCapacity(input.width, input.height,
      this.device.limits);
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
    const probe = this.probe.addToGraph(graph, input, currentView);
    const tiles = shadingFrequencyPlanCapacity(input.width, input.height, this.device.limits);
    const planner = graph.add("Surface/conservative spatial frequency", {},
      (_data, resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        const group = this.device.createBindGroup({ layout: this.frequencyLayout, entries: [
          { binding: 0, resource: resolveTextureView(resources.get(input.visibilityKey)) },
          { binding: 1, resource: resolveTextureView(resources.get(input.depth)) },
          { binding: 2, resource: { buffer: resources.get(input.meshletWork) as GPUBuffer } },
          { binding: 3, resource: { buffer: resources.get(input.materialRecords) as GPUBuffer } },
          { binding: 4, resource: { buffer: resources.get(input.instances) as GPUBuffer } },
          { binding: 5, resource: { buffer: resources.get(currentView) as GPUBuffer } },
          { binding: 6, resource: resolveTextureView(resources.get(frequencyPlan)) },
          { binding: 7, resource: resolveTextureView(resources.get(probe.candidates)) }
        ] });
        const pass = command.beginComputePass({ label: "Surface/spatial frequency plan" });
        pass.setPipeline(this.frequencyPipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(tiles.tilesX / 8), Math.ceil(tiles.tilesY / 8));
        pass.end();
      });
    planner.read(input.visibilityKey);
    planner.read(input.depth);
    planner.read(input.meshletWork);
    planner.read(input.materialRecords);
    planner.read(input.instances);
    planner.read(currentView);
    planner.read(probe.candidates);
    const frequencyPlan = planner.create("Surface/frequency plan", {
      kind: "transient_texture", width: tiles.tilesX, height: tiles.tilesY,
      format: "r32uint", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
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
    const hasLit = input.hasLit;
    const scalarAo = input.indirectVisibility !== undefined;
    if (scalarAo && !hasLit) throw new Error("Surface AO has no lit consumer");
    const activeSets = new Set(input.activeSets);
    const virtualBankCount = input.virtualBanks?.length ?? 0;
    const physicalEnvironment = input.physicalEnvironmentSun !== undefined;
    const dense = activeSets.size === 0 ? null :
      this.program(hasLit, input.virtualGeometry, virtualBankCount,
        input.textureBankMask, physicalEnvironment, scalarAo, "dense", 0,
        vsmBindings !== undefined);
    const requestedLanes = input.activeExceptionLanes ??
      Array.from({ length: SURFACE_EXCEPTION_LANES }, (_, lane) => lane);
    const lanes = requestedLanes.map(lane => {
      const setId = lane === 0 ? 0 : 1 + Math.floor((lane - 1) / 2);
      return activeSets.has(setId) ? { lane, setId,
        binned: this.program(hasLit, input.virtualGeometry, virtualBankCount,
          input.textureBankMask, physicalEnvironment, scalarAo, "binned", lane, vsmBindings !== undefined),
        fallback: this.program(hasLit, input.virtualGeometry, virtualBankCount,
          input.textureBankMask, physicalEnvironment, scalarAo, "fallback", lane, vsmBindings !== undefined) } : null;
    }).filter((value): value is NonNullable<typeof value> => value !== null);
    const surface = graph.add("Surface/Dense and bounded exceptions", {},
      (_data, resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        const queue = resources.get(work) as GPUBuffer;
        const args = resources.get(indirect) as GPUBuffer;
        const clear = command.beginRenderPass({ label: "Surface/clear HDR",
          colorAttachments: [{ view: resolveTextureView(resources.get(radiance)),
            loadOp: "clear", storeOp: "store",
            clearValue: { r: 0.025, g: 0.035, b: 0.05, a: 1 } }] });
        clear.end();
        if (dense === null) return;
        const control = command.allocateTransientBufferAndLoad(new Uint32Array([
          capacity, Number(this.device.limits.maxComputeWorkgroupsPerDimension),
          input.width, input.height
        ]).buffer, GPUBufferUsage.UNIFORM);
        const controlGroup = this.device.createBindGroup({ layout: this.controlLayout,
          entries: [{ binding: 0, resource: { buffer: queue } },
            { binding: 1, resource: { buffer: args } },
            { binding: 2, resource: { buffer: control } }] });
        const laneWords = new Uint32Array(SURFACE_EXCEPTION_LANES * 64);
        for (let lane = 0; lane < SURFACE_EXCEPTION_LANES; lane++) {
          laneWords[lane * 64] = lane;
        }
        const laneParameters = command.allocateTransientBufferAndLoad(
          laneWords.buffer, GPUBufferUsage.UNIFORM);
        const controlPass = (label: string, pipeline: GPUComputePipeline) => {
          const pass = command.beginComputePass({ label });
          pass.setPipeline(pipeline); pass.setBindGroup(0, controlGroup);
          pass.dispatchWorkgroups(1); pass.end();
        };
        controlPass("Surface/initialize exception lanes", this.initialize);
        const groupsByLane = new Map<string, readonly GPUBindGroup[]>();
        const encodeProgram = (pass: GPUComputePassEncoder, program: Program,
          setId: number, laneId: number,
          encode: (pass: GPUComputePassEncoder) => void) => {
          const bindingKey = `${setId}:${laneId}`;
          let groups = groupsByLane.get(bindingKey);
          if (groups === undefined) {
            groups = program.layouts.map((layout, groupIndex) =>
              this.device.createBindGroup({ layout, entries: program.bindings
              .filter(binding => binding.group === groupIndex)
              .map(binding => ({ binding: binding.binding,
              resource: this.resolveBinding(binding, input, currentView, frequencyPlan,
                  radiance, work, setId, laneParameters, laneId, resources,
                  vsmBindings) })) }));
            groupsByLane.set(bindingKey, groups);
          }
          pass.setPipeline(program.pipeline);
          groups.forEach((group, index) => pass.setBindGroup(index, group));
          encode(pass);
        };
        const densePass = command.beginComputePass({ label: "Surface/Dense hot Standard and Unlit" });
        encodeProgram(densePass, dense, 0, 0,
          pass => pass.dispatchWorkgroups(Math.ceil(input.width / 8),
            Math.ceil(input.height / 8)));
        densePass.end();
        controlPass("Surface/finalize exception indirect", this.finalize);
        const exceptionPass = command.beginComputePass({ label: "Surface/bounded exception lanes" });
        for (const lane of lanes) {
          encodeProgram(exceptionPass, lane.binned, lane.setId, lane.lane,
            pass => pass.dispatchWorkgroupsIndirect(args, lane.lane * 32));
          encodeProgram(exceptionPass, lane.fallback, lane.setId, lane.lane,
            pass => pass.dispatchWorkgroupsIndirect(args, lane.lane * 32 + 16));
        }
        exceptionPass.end();
      });
    for (const binding of dense?.bindings ?? []) {
      if (binding.role === "radiance-output" ||
          binding.role === "shading-work" || binding.role === "exception-lane" ||
          binding.role === "frequency-plan" ||
          binding.role.endsWith("sampler") ||
          binding.role === "texture-samplers") continue;
      if (binding.role === "frame-view") surface.read(currentView);
      else if (binding.role === "pre-exposure") surface.read(input.preExposureBuffer);
      else if (binding.role === "vsm-page-table" || binding.role === "vsm-atlas-depth" ||
          binding.role === "vsm-sampling-constants") {
        if (vsmBindings === undefined) throw new Error(`Surface binding missing ${binding.role}`);
        surface.read(binding.role === "vsm-page-table" ? vsmBindings.pageTable :
          binding.role === "vsm-atlas-depth" ? vsmBindings.atlasDepth : vsmBindings.constants);
      }
      else if (binding.role === "texture-banks") {
        for (const setId of activeSets) {
          const id = input.textureBanks[setId]?.[binding.element];
          if (id !== undefined) surface.read(id);
        }
      } else surface.read(this.resolveResourceId(binding, input, 0));
    }
    surface.read(frequencyPlan);
    const radiance = surface.create("Surface/radiance", {
      kind: "transient_texture", width: input.width, height: input.height,
      format: "rgba16float", domain: "internal-full",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING
    });
    const work = surface.create("Surface/exception work", {
      kind: "transient_buffer", size: queueBytes, usage: GPUBufferUsage.STORAGE });
    const indirect = surface.create("Surface/exception indirect", {
      kind: "transient_buffer", size: SURFACE_WORK_INDIRECT_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT });
    return { radiance, work, probeCandidates: probe.candidates, probeCounters: probe.counters };
  }

  private program(hasLit: boolean, virtualGeometry: boolean, virtualBankCount: number,
    textureBankMask: number, physicalEnvironment: boolean, scalarAo: boolean,
    mode: SurfaceExecutionMode, lane: number, vsmShadowEnabled: boolean): Program {
    const coated = hasLit && mode !== "dense" && (lane === 0 || (lane & 1) === 0);
    const key = `${hasLit}:${virtualGeometry}:${virtualBankCount}:${textureBankMask}:${physicalEnvironment}:${scalarAo}:${mode}:${coated}:${vsmShadowEnabled}`;
    const cached = this.programs.get(key);
    if (cached) return cached;
    const compiled = compileSurfaceProgramLayout({
      kernel: { programId: hasLit ? 15 : 3,
        outputDependencyMask: 0, textureBankMask },
      virtualGeometry, virtualBankCount, lighting: hasLit ? "direct" : "unlit",
      physicalEnvironment,
      aoProfile: scalarAo ? "scalar-high" : "off",
      shadowProfile: vsmShadowEnabled ? "vsm" : "off",
      source: "surface-execution-v2", capabilityFingerprint: "webgpu-core",
      formatProfile: "rgba16float"
    }, this.device.limits);
    const source = surfaceExecutionWgsl(compiled.plan, mode,
      coated ? 0 : 1, hasLit, virtualGeometry, vsmShadowEnabled,
      virtualBankCount, textureBankMask, this.virtualUnlitFallback, physicalEnvironment);
    const layoutKey = `${hasLit}:${virtualGeometry}:${virtualBankCount}:${textureBankMask}:${physicalEnvironment}:${scalarAo}:${vsmShadowEnabled}`;
    let layouts = this.layouts.get(layoutKey);
    if (layouts === undefined) {
      layouts = createSurfaceBindGroupLayouts(this.device, compiled.plan);
      this.layouts.set(layoutKey, layouts);
    }
    const pipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [...layouts] }),
      compute: { module: this.device.createShaderModule({ code: source }), entryPoint: "shade" }
    });
    const program = Object.freeze({ pipeline, layouts, bindings: compiled.plan.bindings });
    this.programs.set(key, program);
    return program;
  }

  private resolveBinding(binding: Readonly<SurfacePhysicalBinding>, input: SurfaceMaterialInputs,
    view: ResourceId, frequencyPlan: ResourceId, hdr: ResourceId,
    work: ResourceId,
    setId: number, laneParameters: GPUBuffer, laneId: number,
    resources: { get(id: ResourceId): unknown },
    vsmBindings?: SurfaceVsmBindings): GPUBindingResource {
    if (binding.role === "texture-samplers") return this.samplers[binding.element]!;
    if (binding.role === "exception-lane") return {
      buffer: laneParameters, offset: laneId * 256, size: 16 };
    if (binding.role === "physical-sky-irradiance-sampler" ||
        binding.role === "physical-sky-specular-sampler") return this.samplers[1]!;
    const id = binding.role === "frame-view" ? view :
      binding.role === "frequency-plan" ? frequencyPlan :
      binding.role === "radiance-output" ? hdr :
      binding.role === "shading-work" ? work :
      this.resolveResourceId(binding, input, setId, vsmBindings);
    const resource = resources.get(id);
    if (binding.kind === "sampled-depth" || binding.kind === "sampled-uint" ||
        binding.kind === "sampled-array" || binding.kind === "sampled-2d" ||
        binding.kind === "write-only-rgba16float" ||
        binding.kind === "write-only-rg16float") return resolveTextureView(resource);
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
