import type { GraphicsContext } from "./GraphicsContext.js";
import type { CachedComputePipelineDescriptor } from "./GPUDescriptorCaches.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import type { ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import { requireShadeImage, shadeImageTextureFormat, uploadShadeImage } from "./GPUTextureUpload.js";
import { textureMipLevelCount } from "./GPUTextureContext.js";
import { PHYSICAL_SKY_DFG_WGSL, PHYSICAL_SKY_MIP_WGSL, PHYSICAL_SKY_PREFILTER_WGSL } from "../shaders/physical_sky_ibl.js";
import { ENVIRONMENT_PREFILTER_WGSL, ENVIRONMENT_DIFFUSE_SAMPLE_COUNT } from "../shaders/environment_prefilter.js";

const filterLayout: GPUBindGroupLayoutDescriptor = { entries: [
  { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
  { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
  { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } }
] };
const descriptor = (label: string, code: string, entryPoint: string,
  group: GPUBindGroupLayoutDescriptor): CachedComputePipelineDescriptor => ({ label,
  layout: { bindGroupLayouts: [group] }, compute: { module: { code, label }, entryPoint } });
const filter = descriptor("AuthoredIBL/GGX", PHYSICAL_SKY_PREFILTER_WGSL, "prefilter", filterLayout);
const diffuse = descriptor("AuthoredIBL/irradiance", ENVIRONMENT_PREFILTER_WGSL, "convolve_diffuse", filterLayout);
const mip = descriptor("AuthoredIBL/source mip", PHYSICAL_SKY_MIP_WGSL, "downsample", { entries: [
  { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
  { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } }
] });
const dfg = descriptor("AuthoredIBL/DFG", PHYSICAL_SKY_DFG_WGSL, "dfg", { entries: [
  { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } }
] });
export async function prepareAuthoredEnvironmentPipelines(graphics: GraphicsContext): Promise<void> {
  [filter, diffuse, mip, dfg].forEach(value => graphics.compute_pipelines.obtain(value));
}
type AuthoredIblAllocation = { readonly texture: GPUTexture; readonly handle: ResourceHandle; readonly bytes: number };
type AuthoredIblSet = { readonly source: ShadeTexture; readonly allocations: Set<AuthoredIblAllocation>;
  readonly scratch: readonly AuthoredIblAllocation[];
  readonly views: { readonly diffuse: GPUTextureView; readonly specular: GPUTextureView; readonly dfg: GPUTextureView } };

/** Authored octahedral radiance is immutable publication data, like cooked
 * Appearance. All convolution uses the frame command, with no private submit.
 * Source and filtered levels are separate; successful submission publishes the
 * generation and GPU completion retires the outgoing physical allocation. */
export class GpuAuthoredEnvironment {
  private active: AuthoredIblSet | null = null;
  private pending: AuthoredIblSet | null = null;
  private pendingCommand: ShadeGPUCommandContext | null = null;
  private readonly retiring = new Set<AuthoredIblSet>();
  private destroyed = false;
  private revision = 0;
  constructor(private readonly graphics: GraphicsContext, private readonly maxBytes = 256 * 1024 * 1024) {}
  get publicationRevision(): number { return this.revision; }
  get allocatedBytes(): number {
    const bytes = (set: AuthoredIblSet | null) => set ? [...set.allocations].reduce((sum, value) => sum + value.bytes, 0) : 0;
    return bytes(this.active) + bytes(this.pending) + [...this.retiring].reduce((sum, value) => sum + bytes(value), 0);
  }
  get views(): AuthoredIblSet["views"] {
    const value = this.pending ?? this.active;
    if (!value) throw new Error("Authored environment has no published radiance");
    return value.views;
  }
  record(command: ShadeGPUCommandContext, source: ShadeTexture): boolean {
    if (this.pendingCommand===command && this.pending?.source===source) return false;
    if (this.destroyed || this.pending) throw new Error("Authored environment publication is unavailable");
    if (this.active?.source === source) return false;
    const image = requireShadeImage(source), device = this.graphics.device;
    if (image.width !== image.height || image.depth !== 1 || image.width < 1 ||
      image.width > device.limits.maxTextureDimension2D) throw new RangeError("Authored environment requires a resident square octahedral source");
    // load_environment_map publishes RGBE half payloads as u16 storage. The
    // bits are binary16 radiance, not normalized integer color.
    const format = image.color_space === 2 && image.data_type === "uint16" ? "rgba16float" : shadeImageTextureFormat(image);
    if (!["rgba16float", "rgba32float", "rgba8unorm", "rgba8unorm-srgb"].includes(format))
      throw new RangeError("Authored environment source must contain sampleable RGB radiance");
    const levels = textureMipLevelCount(image.width, image.height);
    const textureBytes = (size: number, count: number, textureFormat: GPUTextureFormat): number => {
      const texelBytes = textureFormat === "rgba32float" ? 16 : textureFormat === "rgba16float" ? 8 : 4;
      let bytes = 0;
      for (let level = 0; level < count; level++) bytes += Math.max(1, size >> level) ** 2 * texelBytes;
      return bytes;
    };
    const requiredBytes = textureBytes(image.width, 1, format) + textureBytes(image.width, levels, "rgba16float") * 2 +
      textureBytes(32, 1, "rgba16float") + textureBytes(64, 1, "rgba16float");
    if (this.allocatedBytes + requiredBytes > this.maxBytes) throw new RangeError("Authored IBL publication exceeds its cumulative physical texture budget");
    const allocations = new Set<AuthoredIblAllocation>();
    const scratch: AuthoredIblAllocation[] = [];
    const make = (label: string, size: number, count: number, textureFormat: GPUTextureFormat,
      usage: GPUTextureUsageFlags, temporary = false): GPUTexture => {
      const texture = device.createTexture({ label, size: [size, size], mipLevelCount: count, format: textureFormat, usage });
      const bytes = textureBytes(size, count, textureFormat);
      const handle = this.graphics.resource_accounting.created({ kind: "texture", category: temporary ? "work-cache" : "resident",
        owner: "Lighting/AuthoredEnvironment", bytes, label });
      const allocation = { texture, handle, bytes }; allocations.add(allocation);
      if (temporary) scratch.push(allocation);
      return texture;
    };
    try {
      const raw = make("AuthoredIBL/source", image.width, 1, format,
        GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING |
        (typeof ImageBitmap !== "undefined" && image.source instanceof ImageBitmap ? GPUTextureUsage.RENDER_ATTACHMENT : 0), true);
      uploadShadeImage(image, raw, device.queue);
      const sourceMips = make("AuthoredIBL/radiance mips", image.width, levels, "rgba16float",
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING, true);
      const filtered = make("AuthoredIBL/filtered specular", image.width, levels, "rgba16float",
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);
      const irradiance = make("AuthoredIBL/diffuse irradiance", 32, 1, "rgba16float",
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);
      const dfgTexture = make("AuthoredIBL/DFG", 64, 1, "rgba16float",
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);
      const params = (roughness: number, samples: number, resolution: number, maxMip: number): GPUBuffer => {
        const values = new ArrayBuffer(16), view = new DataView(values);
        view.setFloat32(0, roughness, true); view.setUint32(4, samples, true);
        view.setUint32(8, resolution, true); view.setUint32(12, maxMip, true);
        return command.allocateTransientBufferAndLoad(values, GPUBufferUsage.UNIFORM);
      };
      const dispatch = (pipeline: CachedComputePipelineDescriptor, bindings: GPUBindingResource[], size: number): void => {
        const pass = command.constructComputePass({ label: pipeline.label, pipeline, bindings: [bindings] });
        pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8)); pass.end();
      };
      // The exact zero-roughness branch copies/reprojects the full source into
      // a linear half mip pyramid; no format-incompatible texture copy.
      dispatch(filter, [{ buffer: params(0, 128, image.width, 0) }, raw.createView(),
        sourceMips.createView({ baseMipLevel: 0, mipLevelCount: 1 })], image.width);
      for (let level = 1; level < levels; level++) dispatch(mip, [
        sourceMips.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }),
        sourceMips.createView({ baseMipLevel: level, mipLevelCount: 1 })], Math.max(1, image.width >> level));
      for (let level = 0; level < levels; level++) {
        const roughness = 1 - Math.sqrt(1 - level / Math.max(levels - 1, 1));
        dispatch(filter, [{ buffer: params(roughness, 128, image.width, levels - 1) }, sourceMips.createView(),
          filtered.createView({ baseMipLevel: level, mipLevelCount: 1 })], Math.max(1, image.width >> level));
      }
      dispatch(diffuse, [{ buffer: params(0, ENVIRONMENT_DIFFUSE_SAMPLE_COUNT, image.width, 0) },
        sourceMips.createView({ baseMipLevel: 0, mipLevelCount: 1 }), irradiance.createView()], 32);
      dispatch(dfg, [dfgTexture.createView()], 64);
      const candidate: AuthoredIblSet = { source, allocations, scratch,
        views: { diffuse: irradiance.createView(), specular: filtered.createView(), dfg: dfgTexture.createView() } };
      const oldRevision = this.revision;
      this.pending = candidate; this.revision = oldRevision >= 0x7ffffffe ? 1 : oldRevision + 1;
      this.pendingCommand=command;
      command.onAborted.addOne(() => {
        if(this.pending!==candidate) return;
        this.pending = null; this.pendingCommand=null; this.revision = oldRevision; this.release(candidate);
      });
      command.onFinished.addOne(() => {
        if(this.pending!==candidate) return;
        const previous = this.active;
        this.active = candidate; this.pending = null; this.pendingCommand=null;
        // Source upload and its unfiltered mip pyramid have no hot consumers.
        // Retire only after this submission has finished filtering them.
        const releaseScratch = () => this.releaseAllocations(candidate, candidate.scratch);
        void command.gpuDone.then(releaseScratch, releaseScratch);
        if (previous) {
          this.retiring.add(previous);
          const release = () => { if (this.retiring.delete(previous)) this.release(previous); };
          void command.gpuDone.then(release, release);
        }
      });
      return true;
    } catch (error) {
      for (const allocation of allocations) { allocation.texture.destroy(); this.graphics.resource_accounting.destroyed(allocation.handle); }
      throw error;
    }
  }
  destroy(): void {
    if (this.destroyed) return; this.destroyed = true;
    if (this.active) this.release(this.active);
    if (this.pending) this.release(this.pending);
    for (const value of this.retiring) this.release(value);
    this.active = this.pending = null; this.pendingCommand=null; this.retiring.clear();
  }
  private release(value: AuthoredIblSet): void {
    this.releaseAllocations(value, [...value.allocations]);
  }
  private releaseAllocations(value: AuthoredIblSet, allocations: readonly AuthoredIblAllocation[]): void {
    for (const allocation of allocations) if (value.allocations.delete(allocation)) {
      allocation.texture.destroy(); this.graphics.resource_accounting.destroyed(allocation.handle);
    }
  }
}
