import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { GPUViewContext } from "../ViewContext.js";
import { GPU_SPARSE_SHADING_VIEW_BYTES, packGpuSparseShadingView } from "../../gpu/GpuSparseShadingFrameAbi.js";
import { GPU_SURFACE_KERNEL_DEMAND } from "../../gpu/GpuSurfaceProgramSpecialization.js";
import { createSurfaceBindGroupLayouts, compileSurfaceProgramLayout,
  type SurfacePhysicalBinding } from "./SurfaceKernelBindingPlan.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { surfaceExecutionWgsl, SURFACE_WORK_CONTROL_WGSL,
  type SurfaceExecutionMode } from "../../shaders/surface_execution.js";
import { SURFACE_EXCEPTION_LANES, SURFACE_WORK_INDIRECT_BYTES,
  surfaceLaneCapacity } from "./SurfaceExecutionAbi.js";
import type { PreExposureContract } from "../RadiometryContract.js";

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
  readonly activeClasses: readonly number[];
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
}
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

  constructor(private readonly device: GPUDevice) {
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
  }

  addToGraph(graph: FrameGraph, input: SurfaceMaterialInputs):
    { radiance: ResourceId; motion: ResourceId; work: ResourceId } {
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
    const hasLit = input.activeClasses.some(id => (id & 15) >= 4);
    const activeSets = new Set(input.activeClasses.map(id => id >> 4));
    const dense = activeSets.size === 0 ? null :
      this.program(hasLit, input.virtualGeometry, "dense", 0);
    const lanes = Array.from({ length: SURFACE_EXCEPTION_LANES }, (_, lane) => {
      const setId = lane === 0 ? 0 : 1 + Math.floor((lane - 1) / 2);
      return activeSets.has(setId) ? { lane, setId,
        binned: this.program(hasLit, input.virtualGeometry, "binned", lane),
        fallback: this.program(hasLit, input.virtualGeometry, "fallback", lane) } : null;
    }).filter((value): value is NonNullable<typeof value> => value !== null);
    const surface = graph.add("Surface/Dense and bounded exceptions", {},
      (_data, resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        const queue = resources.get(work) as GPUBuffer;
        const args = resources.get(indirect) as GPUBuffer;
        const clear = command.beginRenderPass({ label: "Surface/clear HDR and motion",
          colorAttachments: [{ view: resolveTextureView(resources.get(radiance)),
            loadOp: "clear", storeOp: "store",
            clearValue: { r: 0.025, g: 0.035, b: 0.05, a: 1 } },
          { view: resolveTextureView(resources.get(motion)), loadOp: "clear", storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
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
                resource: this.resolveBinding(binding, input, currentView, radiance,
                  motion, work, setId, laneParameters, laneId, resources) })) }));
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
      if (binding.role === "radiance-output" || binding.role === "motion-output" ||
          binding.role === "shading-work" || binding.role === "exception-lane" ||
          binding.role.endsWith("sampler") ||
          binding.role === "texture-samplers") continue;
      if (binding.role === "frame-view") surface.read(currentView);
      else if (binding.role === "texture-banks") {
        for (const setId of activeSets) {
          const id = input.textureBanks[setId]?.[binding.element];
          if (id !== undefined) surface.read(id);
        }
      } else surface.read(this.resolveResourceId(binding, input, 0));
    }
    const radiance = surface.create("Surface/radiance", {
      kind: "transient_texture", width: input.width, height: input.height,
      format: "rgba16float", domain: "internal-full",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING
    });
    const motion = surface.create("Surface/motion", {
      kind: "transient_texture", width: input.width, height: input.height,
      format: "rg16float", domain: "internal-full",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING
    });
    const work = surface.create("Surface/exception work", {
      kind: "transient_buffer", size: queueBytes, usage: GPUBufferUsage.STORAGE });
    const indirect = surface.create("Surface/exception indirect", {
      kind: "transient_buffer", size: SURFACE_WORK_INDIRECT_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT });
    return { radiance, motion, work };
  }

  private program(hasLit: boolean, virtualGeometry: boolean,
    mode: SurfaceExecutionMode, lane: number): Program {
    const coated = hasLit && mode !== "dense" && (lane === 0 || (lane & 1) === 0);
    const key = `${hasLit}:${virtualGeometry}:${mode}:${coated}`;
    const cached = this.programs.get(key);
    if (cached) return cached;
    const compiled = compileSurfaceProgramLayout({
      kernel: { programId: hasLit ? 15 : 3,
        outputDependencyMask: GPU_SURFACE_KERNEL_DEMAND.Motion, textureBankMask: 0x1ff },
      virtualGeometry, lighting: hasLit ? "direct" : "unlit",
      source: "surface-execution-v2", capabilityFingerprint: "webgpu-core",
      formatProfile: "rgba16float"
    }, this.device.limits);
    const source = surfaceExecutionWgsl(compiled.plan, mode,
      coated ? 0 : 1, hasLit, virtualGeometry);
    const layoutKey = `${hasLit}:${virtualGeometry}`;
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
    view: ResourceId, hdr: ResourceId, motion: ResourceId, work: ResourceId,
    setId: number, laneParameters: GPUBuffer, laneId: number,
    resources: { get(id: ResourceId): unknown }): GPUBindingResource {
    if (binding.role === "texture-samplers") return this.samplers[binding.element]!;
    if (binding.role === "exception-lane") return {
      buffer: laneParameters, offset: laneId * 256, size: 16 };
    if (binding.role === "physical-sky-irradiance-sampler" ||
        binding.role === "physical-sky-specular-sampler") return this.samplers[1]!;
    const id = binding.role === "frame-view" ? view :
      binding.role === "radiance-output" ? hdr :
      binding.role === "motion-output" ? motion :
      binding.role === "shading-work" ? work :
      this.resolveResourceId(binding, input, setId);
    const resource = resources.get(id);
    if (binding.kind === "sampled-depth" || binding.kind === "sampled-uint" ||
        binding.kind === "sampled-array" || binding.kind === "sampled-2d" ||
        binding.kind === "write-only-rgba16float" ||
        binding.kind === "write-only-rg16float") return resolveTextureView(resource);
    return { buffer: resource as GPUBuffer };
  }

  private resolveResourceId(binding: Readonly<SurfacePhysicalBinding>,
    input: SurfaceMaterialInputs, setId: number): ResourceId {
    switch (binding.role) {
      case "visibility-key": return input.visibilityKey;
      case "meshlet-work": return input.meshletWork;
      case "material-records": return input.materialRecords;
      case "visibility-depth": return input.depth;
      case "instance-records": return input.instances;
      case "geometry-metadata": return input.geometryMetadata;
      case "vertex-payload": return input.vertexPayload;
      case "virtual-product-metadata": return required(input.virtualMetadata, binding.role);
      case "virtual-product-banks": return required(input.virtualBanks?.[binding.element] ??
        input.virtualBanks?.[0], binding.role);
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
