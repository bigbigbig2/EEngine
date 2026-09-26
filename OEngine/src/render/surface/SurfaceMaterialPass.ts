import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { GPUViewContext } from "../ViewContext.js";
import { GPU_SPARSE_SHADING_VIEW_BYTES, packGpuSparseShadingView } from "../../gpu/GpuSparseShadingFrameAbi.js";
import { shadingProgramUsesTextures } from "../../gpu/GpuShadingProgramAbi.js";
import { createSurfaceBindGroupLayouts,
  compileSurfaceProgramLayout, type SurfacePhysicalBinding } from "./SurfaceKernelBindingPlan.js";
import { surfaceProgramKey } from "./SurfaceProducts.js";
import { createSurfaceMaterialProgramWgsl } from "../../shaders/surface_material_program.js";
import { shadingWorkClassIndirectOffset } from "./ShadingWorkAbi.js";
import { resolveTextureView } from "../RenderTargetViews.js";
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
  readonly textureBankMasks: readonly number[];
  readonly virtualGeometry: boolean;
  readonly queue: ResourceId;
  readonly classes: ResourceId;
  readonly indirect: ResourceId;
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
  /** Motion is required for every temporal-enabled Surface program. */
  readonly motionOutput: ResourceId;
}

type Program = Readonly<{
  pipeline: GPUComputePipeline;
  layouts: readonly GPUBindGroupLayout[];
  bindings: readonly Readonly<SurfacePhysicalBinding>[];
}>;

/** Executes only GPU-classified hits, with a static complete material kernel per active class. */
export class SurfaceMaterialPass {
  private readonly programs = new Map<string, Program>();
  private readonly viewBuffer: GPUBuffer;
  private readonly samplers: readonly GPUSampler[];

  constructor(private readonly device: GPUDevice) {
    this.viewBuffer = device.createBuffer({
      label: "Surface/frame view", size: Math.ceil(GPU_SPARSE_SHADING_VIEW_BYTES / 256) * 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const addressModes = ["repeat", "clamp-to-edge", "mirror-repeat"] as const;
    this.samplers = Object.freeze(Array.from({ length: 6 }, (_, index) => {
      const filter = index < 3 ? "linear" : "nearest";
      return device.createSampler({
        addressModeU: addressModes[index % 3],
        addressModeV: addressModes[index % 3],
        addressModeW: addressModes[index % 3],
        magFilter: filter, minFilter: filter, mipmapFilter: filter
      });
    }));
  }

  addToGraph(graph: FrameGraph, input: SurfaceMaterialInputs): { radiance: ResourceId; motion: ResourceId } {
    const frameView = graph.import_resource(
      "surface-frame-view", { kind: "imported", label: "Surface frame view" }, this.viewBuffer
    );
    const upload = graph.add("Surface/update material frame view", input.frame,
      (frame, _resources, context) => {
        const camera = frame.view.camera.camera;
        const packed = packGpuSparseShadingView({
          width: input.width, height: input.height,
          materialCount: frame.runtime.materialResources.materialCapacity,
          materialGeneration: frame.runtime.materialGeneration,
          textureGeneration: frame.runtime.textureGeneration,
          publicationRevision: frame.runtime.materialPublicationRevision,
          assets: frame.assets.sparseShading,
          frameIndex: frame.frameIndex, preExposure: frame.preExposure.multiplier,
          upscaleRatio: [frame.outputWidth / input.width, frame.outputHeight / input.height],
          cameraPosition: [camera.transform.matrix[12]!, camera.transform.matrix[13]!,
            camera.transform.matrix[14]!],
          currentViewProjection: frame.view.camera.view_projection_matrix,
          previousViewProjection: frame.view.gpu_previous_camera_state.view_projection_matrix
        });
        (context.encoder as ShadeGPUCommandContext).writeBuffer(
          this.viewBuffer, 0, packed, 0, GPU_SPARSE_SHADING_VIEW_BYTES
        );
      });
    const currentView = upload.write(frameView);

    const clear = graph.add("Surface/clear radiance and motion", {}, (_data, resources, context) => {
      const pass = (context.encoder as ShadeGPUCommandContext).gpu_encoder.beginRenderPass({
        colorAttachments: [{ view: resolveTextureView(resources.get(radiance)),
          loadOp: "clear", storeOp: "store",
          clearValue: { r: 0.025, g: 0.035, b: 0.05, a: 1 } }, {
            view: resolveTextureView(resources.get(input.motionOutput)), loadOp: "clear" as const,
            storeOp: "store" as const, clearValue: { r: 0, g: 0, b: 0, a: 0 }
          }]
      });
      pass.end();
    });
    const radiance = clear.create("Surface/radiance", {
      kind: "transient_texture", width: input.width, height: input.height,
      format: "rgba16float", domain: "internal-full",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING
    });
    let output = radiance;
    let motion = input.motionOutput;
    motion = clear.write(motion);
    for (const classId of input.activeClasses) {
      const programId = classId & 15;
      const textureSet = classId >> 4;
      const textured = shadingProgramUsesTextures(programId);
      const textureBankMask = textured ? input.textureBankMasks[textureSet] ?? 0 : 0;
      const compiled = compileSurfaceProgramLayout({
        kernel: { programId, outputDependencyMask: 0, textureBankMask },
        virtualGeometry: input.virtualGeometry,
        lighting: programId >= 4 ? "direct" : "unlit",
        source: "surface-material-kernel-v1", capabilityFingerprint: "webgpu-core",
        formatProfile: "rgba16float"
      }, this.device.limits);
      const source = createSurfaceMaterialProgramWgsl(compiled.closure, compiled.plan, classId);
      const closure = { ...compiled.closure, source };
      const key = surfaceProgramKey(closure);
      let program = this.programs.get(key);
      if (!program) {
        const layouts = createSurfaceBindGroupLayouts(this.device, compiled.plan);
        const pipeline = this.device.createComputePipeline({
          layout: this.device.createPipelineLayout({ bindGroupLayouts: [...layouts] }),
          compute: { module: this.device.createShaderModule({ code: source }), entryPoint: "shade" }
        });
        program = Object.freeze({ pipeline, layouts, bindings: compiled.plan.bindings });
        this.programs.set(key, program);
      }
      const activeProgram = program;
      const inputOutput = output;
      const passNode = graph.add(`Surface/shade material class ${classId}`, input.frame,
        (_frame, resources, context) => {
          const groups = activeProgram.layouts.map((layout, groupIndex) =>
            this.device.createBindGroup({ layout, entries: activeProgram.bindings
              .filter(binding => binding.group === groupIndex)
              .map(binding => ({
                binding: binding.binding,
                resource: this.resolveBinding(binding, input, currentView, inputOutput,
                  textureSet, resources)
              })) }));
          const pass = (context.encoder as ShadeGPUCommandContext)
            .beginComputePass({ label: `Surface/shade material class ${classId}` });
          pass.setPipeline(activeProgram.pipeline);
          groups.forEach((group, index) => pass.setBindGroup(index, group));
          pass.dispatchWorkgroupsIndirect(resources.get(input.indirect) as GPUBuffer,
            shadingWorkClassIndirectOffset(classId));
          pass.end();
        });
      for (const binding of activeProgram.bindings) {
        if (binding.role === "radiance-output" || binding.role === "motion-output" || binding.role === "texture-samplers" || binding.role === "physical-sky-irradiance-sampler") continue;
        if (binding.role === "frame-view") passNode.read(currentView);
        else passNode.read(this.resolveResourceId(binding, input, textureSet));
      }
      passNode.read(input.indirect);
      passNode.read(inputOutput);
      output = passNode.write(inputOutput);
      motion = passNode.write(motion);
    }
    return { radiance: output, motion };
  }

  private resolveBinding(
    binding: Readonly<SurfacePhysicalBinding>, input: SurfaceMaterialInputs,
    view: ResourceId, output: ResourceId, textureSet: number,
    resources: { get(id: ResourceId): unknown }
  ): GPUBindingResource {
    if (binding.role === "texture-samplers") return this.samplers[binding.element]!;
    if (binding.role === "physical-sky-irradiance-sampler") return this.samplers[1]!;
    const id = binding.role === "frame-view" ? view :
      binding.role === "radiance-output" ? output :
      binding.role === "motion-output" ? requireId(input.motionOutput, binding.role) :
        this.resolveResourceId(binding, input, textureSet);
    const resource = resources.get(id);
    if (binding.kind === "sampled-depth" || binding.kind === "sampled-array" ||
        binding.kind === "sampled-2d" || binding.kind === "write-only-rgba16float" || binding.kind === "write-only-rg16float") return resolveTextureView(resource);
    return { buffer: resource as GPUBuffer };
  }

  private resolveResourceId(binding: Readonly<SurfacePhysicalBinding>,
    input: SurfaceMaterialInputs, textureSet: number): ResourceId {
    switch (binding.role) {
      case "shading-work": return input.queue;
      case "shading-work-classes": return input.classes;
      case "meshlet-work": return input.meshletWork;
      case "material-records": return input.materialRecords;
      case "visibility-depth": return input.depth;
      case "instance-records": return input.instances;
      case "geometry-metadata": return input.geometryMetadata;
      case "vertex-payload": return input.vertexPayload;
      case "virtual-product-metadata": return requireId(input.virtualMetadata, binding.role);
      case "virtual-product-banks": return requireId(input.virtualBanks?.[binding.element], binding.role);
      case "texture-routes": return input.textureRoutes;
      case "texture-banks": return requireId(input.textureBanks[textureSet]?.[binding.element], binding.role);
      case "direct-light-records": return requireId(input.lightRecords, binding.role);
      case "direct-light-cluster-lookup": return requireId(input.lightLookup, binding.role);
      case "direct-light-cluster-data": return requireId(input.lightData, binding.role);
      case "direct-light-cluster-params": return requireId(input.lightParams, binding.role);
      case "physical-environment-sun": return requireId(input.physicalEnvironmentSun, binding.role);
      case "physical-environment-transmittance": return requireId(input.physicalEnvironmentTransmittance, binding.role);
      case "physical-sky-irradiance": return requireId(input.physicalSkyIrradiance, binding.role);
      case "physical-sky-irradiance-sampler": throw new Error("Surface sampler is not a graph resource");
      case "motion-output": return requireId(input.motionOutput, binding.role);
      default: throw new Error(`Surface role ${binding.role} is not a readable graph resource`);
    }
  }

  destroy(): void {
    this.viewBuffer.destroy();
    this.programs.clear();
  }
}

function requireId(value: ResourceId | undefined, role: string): ResourceId {
  if (value === undefined) throw new Error(`Surface binding missing ${role}`);
  return value;
}
