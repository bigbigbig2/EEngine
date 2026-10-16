import { PreparedComputePipeline } from "../../gpu/PreparedPipeline.js";
import type { AtmosphereLutName } from "./AtmosphereLutResources.js";
import {
  PHYSICAL_SKY_DFG_WGSL,
  PHYSICAL_SKY_MIP_WGSL,
  PHYSICAL_SKY_PREFILTER_WGSL,
  PHYSICAL_SKY_RADIANCE_WGSL
} from "../../shaders/physical_sky_ibl.js";
import type { PhysicalEnvironmentSnapshot } from "./PhysicalEnvironmentState.js";
import {
  ENVIRONMENT_PREFILTER_WGSL,
  ENVIRONMENT_DIFFUSE_SAMPLE_COUNT
} from "../../shaders/environment_prefilter.js";

const SKY_RESOLUTION = 128;
const SKY_MIP_COUNT = 8;
const DFG_RESOLUTION = 64;
const FILTER_SAMPLES = 128;
const SKY_CACHE_CAPACITY = 4;

type SkySet = {
  readonly key: string;
  readonly lutViews: readonly GPUTextureView[];
  readonly lutSampler: GPUSampler;
  readonly source: GPUTexture;
  readonly filtered: GPUTexture;
  readonly specular: GPUTextureView;
  readonly diffuseTexture: GPUTexture;
  readonly diffuse: GPUTextureView;
  readonly temporary: GPUBuffer[];
  destroyed: boolean;
};

/** Device-local sky radiance, Filament GGX prefilter and DFG publication. */
export class PhysicalSkyIblResources {
  async preparePipelines(): Promise<void> {
    await Promise.all(
      [
        this.radiancePipeline,
        this.mipPipeline,
        this.prefilterPipeline,
        this.dfgPipeline,
        this.diffusePipeline,
      ].map((pipeline) => pipeline.prepare()),
    );
  }

  readonly sampler: GPUSampler;
  private readonly radiancePipeline: PreparedComputePipeline;
  private readonly mipPipeline: PreparedComputePipeline;
  private readonly prefilterPipeline: PreparedComputePipeline;
  private readonly dfgPipeline: PreparedComputePipeline;
  private readonly diffusePipeline: PreparedComputePipeline;
  private readonly dfgTexture: GPUTexture;
  private readonly dfgView: GPUTextureView;
  private active: SkySet | null = null;
  private pending: SkySet | null = null;
  private readonly cached: SkySet[] = [];
  private readonly retired = new Set<SkySet>();
  private dfgReady = false;
  private destroyed = false;

  get ready(): boolean {
    return this.active !== null || this.pending !== null;
  }
  get hasPending(): boolean {
    return this.pending !== null;
  }

  constructor(private readonly device: GPUDevice) {
    if (
      Number(device.limits.maxTextureDimension2D) < SKY_RESOLUTION ||
      Number(device.limits.maxComputeWorkgroupsPerDimension) < SKY_RESOLUTION / 8
    ) {
      throw new RangeError("Physical sky IBL exceeds device limits");
    }
    this.sampler = device.createSampler({
      label: "PhysicalSkyIBL/DFG linear clamp",
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge"
    });
    const pipeline = (label: string, code: string, entryPoint: string): PreparedComputePipeline =>
      new PreparedComputePipeline(device, {
        label,
        layout: "auto",
        compute: {
          module: device.createShaderModule({ label, code }),
          entryPoint
        }
      });
    this.radiancePipeline = pipeline("PhysicalSkyIBL/radiance", PHYSICAL_SKY_RADIANCE_WGSL, "radiance");
    this.mipPipeline = pipeline("PhysicalSkyIBL/source mips", PHYSICAL_SKY_MIP_WGSL, "downsample");
    this.prefilterPipeline = pipeline(
      "PhysicalSkyIBL/GGX prefilter",
      PHYSICAL_SKY_PREFILTER_WGSL,
      "prefilter"
    );
    this.dfgPipeline = pipeline("PhysicalSkyIBL/DFG", PHYSICAL_SKY_DFG_WGSL, "dfg");
    this.diffusePipeline = pipeline(
      "PhysicalSkyIBL/diffuse convolution",
      ENVIRONMENT_PREFILTER_WGSL,
      "convolve_diffuse"
    );
    this.dfgTexture = device.createTexture({
      label: "PhysicalSkyIBL/DFG",
      size: [DFG_RESOLUTION, DFG_RESOLUTION],
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    this.dfgView = this.dfgTexture.createView();
  }

  get views(): Readonly<{ specular: GPUTextureView; diffuse: GPUTextureView; dfg: GPUTextureView }> {
    const selected = this.pending ?? this.active;
    if (selected === null) throw new Error("Physical sky IBL has no recorded generation");
    return Object.freeze({ specular: selected.specular, diffuse: selected.diffuse, dfg: this.dfgView });
  }
  get specularTexture(): GPUTexture {
    const selected = this.pending ?? this.active;
    if (!selected) throw new Error("Physical sky IBL has no recorded generation");
    return selected.filtered;
  }

  record(
    encoder: GPUCommandEncoder,
    luts: Readonly<Record<AtmosphereLutName, GPUTextureView>>,
    lutSampler: GPUSampler,
    snapshot: Omit<PhysicalEnvironmentSnapshot, "generation">,
    cameraPosition: readonly [number, number, number]
  ): void {
    if (this.destroyed) {
      throw new Error("Physical sky IBL resources are destroyed");
    }
    if (this.pending !== null) {
      throw new Error("Physical sky IBL generation is already pending");
    }
    const probeData = new Float32Array([
      ...snapshot.sunDirectionWorld,
      snapshot.skyLuminanceScale,
      ...cameraPosition,
      snapshot.worldToUnit
    ]);
    // Match every bit of the actual producer uniform, including signed zero.
    // LUT resource identity also separates pending replacements and device epochs.
    const key = `${snapshot.lutGeneration}:${new Uint32Array(probeData.buffer).join(",")}`;
    const lutViews = [luts.transmittance, luts.scattering, luts.higherOrderScattering];
    const existing = this.cached.find(
      (set) =>
        set.key === key &&
        set.lutSampler === lutSampler &&
        set.lutViews.every((view, index) => view === lutViews[index])
    );
    if (existing !== undefined) {
      // Immutable completed-or-queue-ordered output: no upload or dispatch.
      // Record alone does not change LRU order or the active publication.
      this.pending = existing;
      return;
    }
    const set = this.createSet(key, lutViews, lutSampler);
    this.pending = set;
    const uniform = (label: string, data: Float32Array | Uint32Array): GPUBuffer => {
      const buffer = this.device.createBuffer({
        label,
        size: Math.max(16, data.byteLength),
        usage: GPUBufferUsage.UNIFORM,
        mappedAtCreation: true
      });
      new Uint8Array(buffer.getMappedRange()).set(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      );
      buffer.unmap();
      set.temporary.push(buffer);
      return buffer;
    };
    const dispatch = (
      label: string,
      pipeline: PreparedComputePipeline,
      resources: readonly GPUBindingResource[],
      size: number
    ): void => {
      const group = this.device.createBindGroup({
        label,
        layout: pipeline.requirePrepared().getBindGroupLayout(0),
        entries: resources.map((resource, binding) => ({ binding, resource })),
      });
      const pass = encoder.beginComputePass({ label });
      pass.setPipeline(pipeline.requirePrepared());
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8));
      pass.end();
    };
    const probe = uniform("PhysicalSkyIBL/probe", probeData);
    dispatch(
      "PhysicalSkyIBL/sky radiance",
      this.radiancePipeline,
      [
        { buffer: probe },
        luts.transmittance,
        luts.scattering,
        luts.higherOrderScattering,
        lutSampler,
        set.source.createView({ baseMipLevel: 0, mipLevelCount: 1 })
      ],
      SKY_RESOLUTION
    );
    const diffuseParams = uniform(
      "PhysicalSkyIBL/diffuse parameters",
      new Uint32Array([0, ENVIRONMENT_DIFFUSE_SAMPLE_COUNT, SKY_RESOLUTION, 0])
    );
    dispatch(
      "PhysicalSkyIBL/diffuse convolution",
      this.diffusePipeline,
      [{ buffer: diffuseParams }, set.source.createView({ baseMipLevel: 0, mipLevelCount: 1 }), set.diffuse],
      32
    );
    for (let mip = 1; mip < SKY_MIP_COUNT; mip++) {
      dispatch(
        `PhysicalSkyIBL/source mip ${mip}`,
        this.mipPipeline,
        [
          // Bind a disjoint source subresource. Sampling an all-mips view while
          // storing another mip of the same texture is an invalid WebGPU scope.
          set.source.createView({ baseMipLevel: mip - 1, mipLevelCount: 1 }),
          set.source.createView({ baseMipLevel: mip, mipLevelCount: 1 })
        ],
        SKY_RESOLUTION >> mip
      );
    }
    for (let mip = 0; mip < SKY_MIP_COUNT; mip++) {
      // Inverse of Filament's perceptualRoughnessToLod quadratic mapping.
      const level = mip / (SKY_MIP_COUNT - 1);
      const roughness = 1 - Math.sqrt(1 - level);
      const params = new ArrayBuffer(16);
      const view = new DataView(params);
      view.setFloat32(0, roughness, true);
      view.setUint32(4, FILTER_SAMPLES, true);
      view.setUint32(8, SKY_RESOLUTION, true);
      view.setUint32(12, SKY_MIP_COUNT - 1, true);
      const buffer = uniform(`PhysicalSkyIBL/filter mip ${mip}`, new Uint32Array(params));
      dispatch(
        `PhysicalSkyIBL/filter mip ${mip}`,
        this.prefilterPipeline,
        [
          { buffer },
          set.source.createView(),
          set.filtered.createView({ baseMipLevel: mip, mipLevelCount: 1 })
        ],
        SKY_RESOLUTION >> mip
      );
    }
    if (!this.dfgReady) {
      dispatch("PhysicalSkyIBL/DFG", this.dfgPipeline, [this.dfgView], DFG_RESOLUTION);
    }
  }

  commit(done: Promise<unknown>): void {
    if (this.pending === null) {
      throw new Error("Physical sky IBL has no pending generation");
    }
    const selected = this.pending;
    const previousIndex = this.cached.indexOf(selected);
    if (previousIndex >= 0) {
      this.cached.splice(previousIndex, 1);
    }
    this.cached.push(selected);
    this.active = selected;
    this.pending = null;
    this.dfgReady = true;
    // A LUT replacement retires the prior LUT resources on this fence. Cached
    // probes must not retain bindings to those destroyed source textures.
    const evicted: SkySet[] = [];
    for (let index = this.cached.length - 1; index >= 0; index--) {
      const cached = this.cached[index]!;
      if (
        cached.lutSampler !== selected.lutSampler ||
        cached.lutViews.some((view, lane) => view !== selected.lutViews[lane])
      ) {
        evicted.push(...this.cached.splice(index, 1));
      }
    }
    if (this.cached.length > SKY_CACHE_CAPACITY) {
      evicted.push(this.cached.shift()!);
    }
    for (const set of evicted) {
      this.retired.add(set);
    }
    // This submission follows all earlier uses on the same queue. Its completion
    // covers the evicted probe even when another frame still sampled it.
    const temporary = selected.temporary.splice(0);
    const release = (): void => {
      for (const set of evicted) {
        this.retired.delete(set);
        this.destroySet(set);
      }
      temporary.forEach((buffer) => buffer.destroy());
    };
    void done.then(release, release);
  }

  abort(): void {
    if (this.pending === null) {
      throw new Error("Physical sky IBL has no pending generation");
    }
    if (!this.cached.includes(this.pending)) {
      this.destroySet(this.pending);
    }
    this.pending = null;
  }

  abortIfPending(): void {
    if (this.pending !== null) this.abort();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    if (this.pending !== null && !this.cached.includes(this.pending)) {
      this.destroySet(this.pending);
    }
    this.cached.forEach((set) => this.destroySet(set));
    this.retired.forEach((set) => this.destroySet(set));
    this.pending = null;
    this.active = null;
    this.cached.length = 0;
    this.retired.clear();
    this.dfgTexture.destroy();
  }

  private createSet(key: string, lutViews: readonly GPUTextureView[], lutSampler: GPUSampler): SkySet {
    const allocated: GPUTexture[] = [];
    const make = (label: string): GPUTexture => {
      const texture = this.device.createTexture({
        label,
        size: [SKY_RESOLUTION, SKY_RESOLUTION],
        mipLevelCount: SKY_MIP_COUNT,
        format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
      });
      allocated.push(texture);
      return texture;
    };
    try {
      const source = make("PhysicalSkyIBL/source radiance");
      const filtered = make("PhysicalSkyIBL/prefiltered specular");
      const diffuseTexture = this.device.createTexture({
        label: "PhysicalSkyIBL/diffuse irradiance",
        size: [32, 32],
        format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
      });
      allocated.push(diffuseTexture);
      return {
        key,
        lutViews,
        lutSampler,
        source,
        filtered,
        specular: filtered.createView(),
        diffuseTexture,
        diffuse: diffuseTexture.createView(),
        temporary: [],
        destroyed: false
      };
    } catch (error) {
      allocated.forEach((texture) => texture.destroy());
      throw error;
    }
  }

  private destroySet(set: SkySet): void {
    if (set.destroyed) {
      return;
    }
    set.destroyed = true;
    set.source.destroy();
    set.filtered.destroy();
    set.diffuseTexture.destroy();
    set.temporary.forEach((buffer) => buffer.destroy());
    set.temporary.length = 0;
  }
}
