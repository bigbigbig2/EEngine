import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import { xeGtaoScalarMainWgsl, type XeGtaoScalarQuality } from "../../shaders/xegtao_main.js";
import type { XeGtaoPreparedFields } from "./XeGtaoPreparationPass.js";
import { buildXeGtaoHilbertLut } from "./XeGtaoNoise.js";

export interface XeGtaoMainInputs {
  readonly prepared: XeGtaoPreparedFields;
}

export interface XeGtaoMainProducts {
  /** Donor's scalar working term, visibility / 1.5 quantized to r8unorm.
   * C5 recovers the source byte with round(textureLoad(...).x * 255). */
  readonly rawAo: ResourceId;
  /** L/R/T/B 2-bit edge strengths packed in an r8unorm texel.
   * C5 recovers the source byte with round(textureLoad(...).x * 255). */
  readonly edges: ResourceId;
}

/** C4 only: caller must add C5 denoise and a real consumer before production activation. */
export class XeGtaoMainPass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly hilbertLut: GPUTexture;

  constructor(
    private readonly device: GPUDevice,
    readonly quality: XeGtaoScalarQuality = "high",
  ) {
    if (!device.features.has("texture-formats-tier1")) {
      throw new Error("XeGTAO r8unorm storage outputs require texture-formats-tier1");
    }
    if (
      Number(device.limits.maxStorageTexturesPerShaderStage) < 2 ||
      Number(device.limits.maxSampledTexturesPerShaderStage) < 8
    ) {
      throw new RangeError("XeGTAO MainPass requires two storage and eight sampled textures");
    }
    this.hilbertLut = device.createTexture({
      label: "XeGTAO/Hilbert 64x64",
      size: { width: 64, height: 64 },
      format: "r32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.hilbertLut },
      buildXeGtaoHilbertLut().buffer as ArrayBuffer,
      { bytesPerRow: 64 * 4, rowsPerImage: 64 },
      { width: 64, height: 64 },
    );
    const sampled = (binding: number, sampleType: GPUTextureSampleType): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType },
    });
    const storage = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      storageTexture: { access: "write-only", format: "r8unorm" },
    });
    this.layout = device.createBindGroupLayout({
      label: "XeGTAO/Main scalar layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        sampled(1, "depth"),
        sampled(2, "uint"),
        ...Array.from({ length: 5 }, (_, mip) => sampled(3 + mip, "unfilterable-float")),
        sampled(8, "uint"),
        storage(9),
        storage(10),
      ],
    });
    this.pipeline = device.createComputePipeline({
      label: `XeGTAO/Main scalar ${quality}`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: {
        module: device.createShaderModule({
          label: `XeGTAO/Main scalar ${quality} WGSL`,
          code: xeGtaoScalarMainWgsl(quality),
        }),
        entryPoint: "main",
      },
    });
  }

  addToGraph(graph: FrameGraph, input: XeGtaoMainInputs): XeGtaoMainProducts {
    const { width, height, depth } = input.prepared;
    if (
      !Number.isSafeInteger(width) ||
      width < 1 ||
      !Number.isSafeInteger(height) ||
      height < 1 ||
      width > Number(this.device.limits.maxTextureDimension2D) ||
      height > Number(this.device.limits.maxTextureDimension2D)
    ) {
      throw new RangeError("XeGTAO MainPass viewport is outside device limits");
    }
    const lut = graph.import_resource(
      "XeGTAO/Hilbert 64x64",
      { kind: "imported", label: "XeGTAO/Hilbert 64x64" },
      this.hilbertLut,
    );
    const pass = graph.add(`XeGTAO/Main scalar ${this.quality}`, {}, (_data, resources, context) => {
      const prepared = input.prepared;
      const group = this.device.createBindGroup({
        label: `XeGTAO/Main ${this.quality} bindings`,
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: resources.get(prepared.constants) as GPUBuffer } },
          { binding: 1, resource: resolveTextureView(resources.get(depth)) },
          { binding: 2, resource: resolveTextureView(resources.get(prepared.normal)) },
          ...prepared.viewDepth.map((id, mip) => ({
            binding: 3 + mip,
            resource: resolveTextureView(resources.get(id)),
          })),
          { binding: 8, resource: resolveTextureView(resources.get(lut)) },
          { binding: 9, resource: resolveTextureView(resources.get(rawAo)) },
          { binding: 10, resource: resolveTextureView(resources.get(edges)) },
        ],
      });
      const command = context.encoder as ShadeGPUCommandContext;
      const encoder = command.beginComputePass({ label: `XeGTAO/Main scalar ${this.quality}` });
      encoder.setPipeline(this.pipeline);
      encoder.setBindGroup(0, group);
      encoder.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      encoder.end();
    });
    pass.read(depth);
    pass.read(input.prepared.constants);
    pass.read(input.prepared.normal);
    for (const mip of input.prepared.viewDepth) pass.read(mip);
    pass.read(lut);
    const descriptor = (format: GPUTextureFormat) => ({
      kind: "transient_texture" as const,
      width,
      height,
      format,
      domain: "internal-full" as const,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const rawAo = pass.create("XeGTAO/raw scalar AO", descriptor("r8unorm"));
    const edges = pass.create("XeGTAO/packed edges", descriptor("r8unorm"));
    return { rawAo, edges };
  }

  destroy(): void {
    this.hilbertLut.destroy();
  }
}
