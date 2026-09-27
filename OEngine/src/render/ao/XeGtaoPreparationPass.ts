import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import type { GPUCameraState } from "../GPUCameraState.js";
import { XE_GTAO_PREP_BYTES, packXeGtaoPreparation,
  type XeGtaoTuning } from "./XeGtaoPreparationAbi.js";
import { XE_GTAO_NORMAL_WGSL, XE_GTAO_PREFILTER_2_WGSL,
  XE_GTAO_PREFILTER_4_WGSL, XE_GTAO_PREFILTER_REDUCE_WGSL
} from "../../shaders/xegtao_preparation.js";

export interface XeGtaoPreparationFrame {
  readonly camera: GPUCameraState;
  readonly radiusMeters: number;
  readonly metersPerWorldUnit: number;
  readonly tuning?: XeGtaoTuning;
  readonly noiseIndex?: number;
}

export interface XeGtaoPreparationInputs {
  readonly width: number;
  readonly height: number;
  readonly depth: ResourceId;
  readonly frame: XeGtaoPreparationFrame;
}

export interface XeGtaoPreparedFields {
  readonly width: number;
  readonly height: number;
  /** Exact raw reverse-Z depth used to prepare these same-frame fields. */
  readonly depth: ResourceId;
  /** Graph version of the shared constants; every preparation/Main read depends on this upload. */
  readonly constants: ResourceId;
  /** XeGTAO private packed view-space normal, not a material normal sidecar. */
  readonly normal: ResourceId;
  /** Five separate r32float views of source-equivalent weighted view depth.
   * Their physical extents include the final 16x16 tile's clamped gutter; consumers
   * must use the viewport-derived, floor-halved donor mip extent for point samples. */
  readonly viewDepth: readonly [ResourceId, ResourceId, ResourceId, ResourceId, ResourceId];
}

/**
 * C2/C3 source port: depth normals and weighted depth mips. The class is
 * callable by the AO owner, but production does not activate it until C4–C6
 * provide the real MainPass, denoise and Surface visibility consumer.
 */
export class XeGtaoPreparationPass {
  private readonly constants: GPUBuffer;
  private readonly normalLayout: GPUBindGroupLayout;
  private readonly normalPipeline: GPUComputePipeline;
  private readonly prefilterLayout: GPUBindGroupLayout;
  private readonly prefilterPipeline: GPUComputePipeline;
  private readonly reduceLayout: GPUBindGroupLayout;
  private readonly reducePipeline: GPUComputePipeline;
  private readonly firstMipCount: 2 | 4;

  constructor(private readonly device: GPUDevice) {
    if (Number(device.limits.maxStorageTexturesPerShaderStage) < 2) {
      throw new RangeError("XeGTAO preparation needs at least two storage textures per shader stage");
    }
    this.firstMipCount = Number(device.limits.maxStorageTexturesPerShaderStage) >= 4 ? 4 : 2;
    this.constants = device.createBuffer({ label: "XeGTAO/preparation constants",
      size: XE_GTAO_PREP_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const uniform: GPUBindGroupLayoutEntry = { binding: 0,
      visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } };
    const depth: GPUBindGroupLayoutEntry = { binding: 1,
      visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth" } };
    const storage = (binding: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry => ({
      binding, visibility: GPUShaderStage.COMPUTE,
      storageTexture: { access: "write-only", format }
    });
    this.normalLayout = device.createBindGroupLayout({ entries: [uniform, depth, storage(2, "r32uint")] });
    this.normalPipeline = device.createComputePipeline({
      label: "XeGTAO/GenerateNormals",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.normalLayout] }),
      compute: { module: device.createShaderModule({ code: XE_GTAO_NORMAL_WGSL }),
        entryPoint: "generate_normals" }
    });
    this.prefilterLayout = device.createBindGroupLayout({ entries: [uniform, depth,
      ...Array.from({ length: this.firstMipCount }, (_, mip) => storage(2 + mip, "r32float"))] });
    this.prefilterPipeline = device.createComputePipeline({
      label: "XeGTAO/PrefilterDepths16x16",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.prefilterLayout] }),
      compute: { module: device.createShaderModule({ code: this.firstMipCount === 4
        ? XE_GTAO_PREFILTER_4_WGSL : XE_GTAO_PREFILTER_2_WGSL }), entryPoint: "prefilter" }
    });
    this.reduceLayout = device.createBindGroupLayout({ entries: [uniform,
      { binding: 1, visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "unfilterable-float" } }, storage(2, "r32float")] });
    this.reducePipeline = device.createComputePipeline({
      label: "XeGTAO/WeightedDepthMIPFilter",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.reduceLayout] }),
      compute: { module: device.createShaderModule({ code: XE_GTAO_PREFILTER_REDUCE_WGSL }),
        entryPoint: "reduce_mip" }
    });
  }

  addToGraph(graph: FrameGraph, input: XeGtaoPreparationInputs): XeGtaoPreparedFields {
    if (!Number.isSafeInteger(input.width) || input.width < 1 ||
        !Number.isSafeInteger(input.height) || input.height < 1 ||
        input.width > Number(this.device.limits.maxTextureDimension2D) ||
        input.height > Number(this.device.limits.maxTextureDimension2D)) {
      throw new RangeError("XeGTAO preparation viewport is outside device limits");
    }
    const paddedWidth = Math.ceil(input.width / 16) * 16;
    const paddedHeight = Math.ceil(input.height / 16) * 16;
    if (paddedWidth > Number(this.device.limits.maxTextureDimension2D) ||
        paddedHeight > Number(this.device.limits.maxTextureDimension2D)) {
      throw new RangeError("XeGTAO preparation 16x16 tile extent exceeds device limits");
    }
    const uniform = graph.import_resource("XeGTAO/preparation constants",
      { kind: "imported", label: "XeGTAO preparation constants" }, this.constants);
    const upload = graph.add("XeGTAO/update preparation constants", input.frame,
      (frame, _resources, context) => {
        const command = context.encoder as ShadeGPUCommandContext;
        const values = packXeGtaoPreparation({ width: input.width, height: input.height,
          projection: frame.camera.projection_matrix,
          radiusMeters: frame.radiusMeters,
          metersPerWorldUnit: frame.metersPerWorldUnit,
          tuning: frame.tuning, noiseIndex: frame.noiseIndex });
        command.writeBuffer(this.constants, 0, values, 0, XE_GTAO_PREP_BYTES);
      });
    const currentUniform = upload.write(uniform);
    const normalPass = graph.add("XeGTAO/generate view normals", {},
      (_data, resources, context) => {
        const group = this.device.createBindGroup({ layout: this.normalLayout, entries: [
          { binding: 0, resource: { buffer: resources.get(currentUniform) as GPUBuffer } },
          { binding: 1, resource: resolveTextureView(resources.get(input.depth)) },
          { binding: 2, resource: resolveTextureView(resources.get(normal)) }
        ] });
        this.dispatch(context.encoder as ShadeGPUCommandContext,
          "XeGTAO/generate view normals", this.normalPipeline, group,
          Math.ceil(input.width / 8), Math.ceil(input.height / 8));
      });
    normalPass.read(input.depth);
    normalPass.read(currentUniform);
    const normal = normalPass.create("XeGTAO/view normal", {
      kind: "transient_texture", width: input.width, height: input.height,
      format: "r32uint", domain: "internal-full",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    const first = graph.add("XeGTAO/prefilter weighted view depth", {},
      (_data, resources, context) => {
        const group = this.device.createBindGroup({ layout: this.prefilterLayout,
          entries: [{ binding: 0, resource: { buffer: resources.get(currentUniform) as GPUBuffer } },
            { binding: 1, resource: resolveTextureView(resources.get(input.depth)) },
            ...mips.slice(0, this.firstMipCount).map((id, index) => ({
              binding: index + 2, resource: resolveTextureView(resources.get(id))
            }))] });
        this.dispatch(context.encoder as ShadeGPUCommandContext,
          "XeGTAO/prefilter weighted view depth", this.prefilterPipeline, group,
          paddedWidth / 16, paddedHeight / 16);
      });
    first.read(input.depth);
    first.read(currentUniform);
    const mips: ResourceId[] = [];
    // Preserve the donor's scratch values outside the logical viewport at the
    // last tile. Cropping intermediate mips before a later dispatch changes
    // weighted reduction at odd-size right/bottom edges.
    const size = (mip: number) => ({ width: paddedWidth / (2 ** mip),
      height: paddedHeight / (2 ** mip) });
    const descriptor = (mip: number) => ({ kind: "transient_texture" as const,
      ...size(mip), format: "r32float", usage: GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING });
    for (let mip = 0; mip < this.firstMipCount; mip++) {
      mips.push(first.create(`XeGTAO/weighted depth mip ${mip}`, descriptor(mip)));
    }
    for (let mip = this.firstMipCount; mip < 5; mip++) {
      const previous = mips[mip - 1]!;
      const stage = graph.add(`XeGTAO/weighted depth mip ${mip}`, {},
        (_data, resources, context) => {
          const group = this.device.createBindGroup({ layout: this.reduceLayout, entries: [
            { binding: 0, resource: { buffer: resources.get(currentUniform) as GPUBuffer } },
            { binding: 1, resource: resolveTextureView(resources.get(previous)) },
            { binding: 2, resource: resolveTextureView(resources.get(output)) }
          ] });
          const dimensions = size(mip);
          this.dispatch(context.encoder as ShadeGPUCommandContext,
            `XeGTAO/weighted depth mip ${mip}`, this.reducePipeline, group,
            Math.ceil(dimensions.width / 8), Math.ceil(dimensions.height / 8));
        });
      stage.read(previous);
      stage.read(currentUniform);
      const output = stage.create(`XeGTAO/weighted depth mip ${mip}`, descriptor(mip));
      mips.push(output);
    }
    return { width: input.width, height: input.height, depth: input.depth,
      constants: currentUniform, normal,
      viewDepth: mips as unknown as XeGtaoPreparedFields["viewDepth"] };
  }

  private dispatch(command: ShadeGPUCommandContext, label: string,
    pipeline: GPUComputePipeline, group: GPUBindGroup, x: number, y: number): void {
    const pass = command.beginComputePass({ label });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(x, y);
    pass.end();
  }

  destroy(): void {
    this.constants.destroy();
  }
}
