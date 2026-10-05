import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { XE_GTAO_PACK_WGSL, xeGtaoDenoiseWgsl } from "../../shaders/xegtao_denoise.js";
import type { XeGtaoPreparedFields } from "./XeGtaoPreparationPass.js";
import type { XeGtaoMainProducts } from "./XeGtaoMainPass.js";

export interface XeGtaoDenoiseInputs {
  readonly prepared: XeGtaoPreparedFields;
  readonly main: XeGtaoMainProducts;
}

export interface XeGtaoScalarVisibility {
  readonly packed: ResourceId;
  readonly width: number;
  readonly height: number;
  /** Four row-major pixels per u32, little-endian byte lanes. */
  readonly words: number;
}

/** Donor edge-aware filtering followed by a single-writer GPU pack. */
export class XeGtaoDenoisePass {
  private readonly denoiseLayout: GPUBindGroupLayout;
  private readonly intermediatePipeline: GPUComputePipeline | null;
  private readonly finalPipeline: GPUComputePipeline;
  private readonly packLayout: GPUBindGroupLayout;
  private readonly packPipeline: GPUComputePipeline;

  constructor(
    private readonly device: GPUDevice,
    readonly denoisePasses = 1,
  ) {
    if (!Number.isInteger(denoisePasses) || denoisePasses < 0 || denoisePasses > 3) {
      throw new RangeError("XeGTAO DenoisePasses must be 0..3");
    }
    if (!device.features.has("texture-formats-tier1")) {
      throw new Error("XeGTAO r8unorm denoise output requires texture-formats-tier1");
    }
    if (
      Number(device.limits.maxSampledTexturesPerShaderStage) < 2 ||
      Number(device.limits.maxStorageTexturesPerShaderStage) < 1 ||
      Number(device.limits.maxStorageBuffersPerShaderStage) < 1
    ) {
      throw new RangeError(
        "XeGTAO denoise requires two sampled textures, one storage texture and one storage buffer",
      );
    }
    this.denoiseLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "r8unorm" },
        },
      ],
    });
    const denoiseLayout = device.createPipelineLayout({ bindGroupLayouts: [this.denoiseLayout] });
    const pipeline = (finalApply: boolean): GPUComputePipeline =>
      device.createComputePipeline({
        label: `XeGTAO/Denoise ${finalApply ? "final" : "intermediate"}`,
        layout: denoiseLayout,
        compute: {
          module: device.createShaderModule({
            code: xeGtaoDenoiseWgsl(finalApply, denoisePasses === 0 ? 1e4 : 1.2),
          }),
          entryPoint: "denoise",
        },
      });
    this.intermediatePipeline = denoisePasses > 1 ? pipeline(false) : null;
    this.finalPipeline = pipeline(true);
    this.packLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    this.packPipeline = device.createComputePipeline({
      label: "XeGTAO/pack scalar visibility",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.packLayout] }),
      compute: { module: device.createShaderModule({ code: XE_GTAO_PACK_WGSL }), entryPoint: "pack" },
    });
  }

  addToGraph(graph: FrameGraph, input: XeGtaoDenoiseInputs): XeGtaoScalarVisibility {
    const { width, height, constants } = input.prepared;
    const pixels = width * height;
    const words = Math.ceil(pixels / 4);
    const bytes = words * 4;
    if (
      !Number.isSafeInteger(pixels) ||
      pixels < 1 ||
      pixels > 0xfffffffc ||
      bytes > Number(this.device.limits.maxStorageBufferBindingSize) ||
      bytes > Number(this.device.limits.maxBufferSize) ||
      bytes > 0x7fffffff
    ) {
      throw new RangeError("XeGTAO packed visibility exceeds buffer/index limits");
    }
    const maxGroups = Number(this.device.limits.maxComputeWorkgroupsPerDimension);
    const groups = Math.ceil(words / 64);
    const groupsX = Math.min(maxGroups, groups);
    const groupsY = Math.ceil(groups / groupsX);
    if (!Number.isSafeInteger(maxGroups) || maxGroups < 1 || groupsY > maxGroups) {
      throw new RangeError("XeGTAO pack dispatch exceeds device limits");
    }
    let source = input.main.rawAo;
    for (let index = 0; index < Math.max(1, this.denoisePasses); index++) {
      const final = index === Math.max(1, this.denoisePasses) - 1;
      const sourceId = source;
      const pipeline = final ? this.finalPipeline : this.intermediatePipeline!;
      const denoise = graph.add(
        `XeGTAO/denoise ${index + 1}${final ? " final" : ""}`,
        {},
        (_data, resources, context) => {
          const group = this.device.createBindGroup({
            layout: this.denoiseLayout,
            entries: [
              { binding: 0, resource: { buffer: resources.get(constants) as GPUBuffer } },
              { binding: 1, resource: resolveTextureView(resources.get(sourceId)) },
              { binding: 2, resource: resolveTextureView(resources.get(input.main.edges)) },
              { binding: 3, resource: resolveTextureView(resources.get(output)) },
            ],
          });
          const pass = (context.encoder as ShadeGPUCommandContext).beginComputePass({
            label: `XeGTAO/denoise ${index + 1}`,
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
          pass.end();
        },
      );
      denoise.read(constants);
      denoise.read(sourceId);
      denoise.read(input.main.edges);
      const output = denoise.create(`XeGTAO/denoised scalar ${index + 1}`, {
        kind: "transient_texture",
        width,
        height,
        format: "r8unorm",
        domain: "internal-full",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
      source = output;
    }
    const finalAo = source;
    const packing = graph.add("XeGTAO/pack indirect visibility", {}, (_data, resources, context) => {
      const group = this.device.createBindGroup({
        layout: this.packLayout,
        entries: [
          { binding: 0, resource: { buffer: resources.get(constants) as GPUBuffer } },
          { binding: 1, resource: resolveTextureView(resources.get(finalAo)) },
          { binding: 2, resource: { buffer: resources.get(packed) as GPUBuffer } },
        ],
      });
      const pass = (context.encoder as ShadeGPUCommandContext).beginComputePass({
        label: "XeGTAO/pack indirect visibility",
      });
      pass.setPipeline(this.packPipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(groupsX, groupsY);
      pass.end();
    });
    packing.read(constants);
    packing.read(finalAo);
    const packed = packing.create("XeGTAO/indirect visibility", {
      kind: "transient_buffer",
      size: bytes,
      usage: GPUBufferUsage.STORAGE,
      domain: "internal-full",
    });
    return { packed, width, height, words };
  }
}
