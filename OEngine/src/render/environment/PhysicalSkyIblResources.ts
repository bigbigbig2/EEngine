import type { AtmosphereLutName } from "./AtmosphereLutResources.js";
import {
  PHYSICAL_SKY_DFG_WGSL,
  PHYSICAL_SKY_MIP_WGSL,
  PHYSICAL_SKY_PREFILTER_WGSL,
  PHYSICAL_SKY_RADIANCE_WGSL,
} from "../../shaders/physical_sky_ibl.js";
import type { PhysicalEnvironmentSnapshot } from "./PhysicalEnvironmentState.js";
import {
  ENVIRONMENT_PREFILTER_WGSL,
  ENVIRONMENT_DIFFUSE_SAMPLE_COUNT,
} from "../../shaders/environment_prefilter.js";

const SKY_RESOLUTION = 128;
const SKY_MIP_COUNT = 8;
const DFG_RESOLUTION = 64;
const FILTER_SAMPLES = 128;

type SkySet = {
  readonly source: GPUTexture;
  readonly filtered: GPUTexture;
  readonly specular: GPUTextureView;
  readonly diffuseTexture: GPUTexture;
  readonly diffuse: GPUTextureView;
  readonly temporary: GPUBuffer[];
};

/** Device-local sky radiance, Filament GGX prefilter and DFG publication. */
export class PhysicalSkyIblResources {
  private readonly radiancePipeline: GPUComputePipeline;
  private readonly mipPipeline: GPUComputePipeline;
  private readonly prefilterPipeline: GPUComputePipeline;
  private readonly dfgPipeline: GPUComputePipeline;
  private readonly diffusePipeline: GPUComputePipeline;
  private readonly dfgTexture: GPUTexture;
  private readonly dfgView: GPUTextureView;
  private active: SkySet | null = null;
  private pending: SkySet | null = null;
  private readonly retired: SkySet[] = [];
  private dfgReady = false;

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
    const pipeline = (label: string, code: string, entryPoint: string): GPUComputePipeline =>
      device.createComputePipeline({
        label,
        layout: "auto",
        compute: {
          module: device.createShaderModule({ label, code }),
          entryPoint,
        },
      });
    this.radiancePipeline = pipeline("PhysicalSkyIBL/radiance", PHYSICAL_SKY_RADIANCE_WGSL, "radiance");
    this.mipPipeline = pipeline("PhysicalSkyIBL/source mips", PHYSICAL_SKY_MIP_WGSL, "downsample");
    this.prefilterPipeline = pipeline(
      "PhysicalSkyIBL/GGX prefilter",
      PHYSICAL_SKY_PREFILTER_WGSL,
      "prefilter",
    );
    this.dfgPipeline = pipeline("PhysicalSkyIBL/DFG", PHYSICAL_SKY_DFG_WGSL, "dfg");
    this.diffusePipeline = pipeline(
      "PhysicalSkyIBL/diffuse convolution",
      ENVIRONMENT_PREFILTER_WGSL,
      "convolve_diffuse",
    );
    this.dfgTexture = device.createTexture({
      label: "PhysicalSkyIBL/DFG",
      size: [DFG_RESOLUTION, DFG_RESOLUTION],
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.dfgView = this.dfgTexture.createView();
  }

  get views(): Readonly<{ specular: GPUTextureView; diffuse: GPUTextureView; dfg: GPUTextureView }> {
    const selected = this.pending ?? this.active;
    if (selected === null) throw new Error("Physical sky IBL has no recorded generation");
    return Object.freeze({ specular: selected.specular, diffuse: selected.diffuse, dfg: this.dfgView });
  }

  record(
    encoder: GPUCommandEncoder,
    luts: Readonly<Record<AtmosphereLutName, GPUTextureView>>,
    lutSampler: GPUSampler,
    snapshot: Omit<PhysicalEnvironmentSnapshot, "generation">,
    cameraPosition: readonly [number, number, number],
  ): void {
    if (this.pending !== null) throw new Error("Physical sky IBL generation is already pending");
    const set = this.createSet();
    this.pending = set;
    const uniform = (label: string, data: Float32Array | Uint32Array): GPUBuffer => {
      const buffer = this.device.createBuffer({
        label,
        size: Math.max(16, data.byteLength),
        usage: GPUBufferUsage.UNIFORM,
        mappedAtCreation: true,
      });
      new Uint8Array(buffer.getMappedRange()).set(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
      buffer.unmap();
      set.temporary.push(buffer);
      return buffer;
    };
    const dispatch = (
      label: string,
      pipeline: GPUComputePipeline,
      resources: readonly GPUBindingResource[],
      size: number,
    ): void => {
      const group = this.device.createBindGroup({
        label,
        layout: pipeline.getBindGroupLayout(0),
        entries: resources.map((resource, binding) => ({ binding, resource })),
      });
      const pass = encoder.beginComputePass({ label });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8));
      pass.end();
    };
    const probe = uniform(
      "PhysicalSkyIBL/probe",
      new Float32Array([
        ...snapshot.sunDirectionWorld,
        snapshot.skyLuminanceScale,
        ...cameraPosition,
        snapshot.worldToUnit,
      ]),
    );
    dispatch(
      "PhysicalSkyIBL/sky radiance",
      this.radiancePipeline,
      [
        { buffer: probe },
        luts.transmittance,
        luts.scattering,
        luts.higherOrderScattering,
        lutSampler,
        set.source.createView({ baseMipLevel: 0, mipLevelCount: 1 }),
      ],
      SKY_RESOLUTION,
    );
    const diffuseParams = uniform(
      "PhysicalSkyIBL/diffuse parameters",
      new Uint32Array([0, ENVIRONMENT_DIFFUSE_SAMPLE_COUNT, SKY_RESOLUTION, 0]),
    );
    dispatch(
      "PhysicalSkyIBL/diffuse convolution",
      this.diffusePipeline,
      [{ buffer: diffuseParams }, set.source.createView({ baseMipLevel: 0, mipLevelCount: 1 }), set.diffuse],
      32,
    );
    for (let mip = 1; mip < SKY_MIP_COUNT; mip++) {
      dispatch(
        `PhysicalSkyIBL/source mip ${mip}`,
        this.mipPipeline,
        [
          // Bind a disjoint source subresource. Sampling an all-mips view while
          // storing another mip of the same texture is an invalid WebGPU scope.
          set.source.createView({ baseMipLevel: mip - 1, mipLevelCount: 1 }),
          set.source.createView({ baseMipLevel: mip, mipLevelCount: 1 }),
        ],
        SKY_RESOLUTION >> mip,
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
          set.filtered.createView({ baseMipLevel: mip, mipLevelCount: 1 }),
        ],
        SKY_RESOLUTION >> mip,
      );
    }
    if (!this.dfgReady) {
      dispatch("PhysicalSkyIBL/DFG", this.dfgPipeline, [this.dfgView], DFG_RESOLUTION);
    }
  }

  commit(done: Promise<unknown>): void {
    if (this.pending === null) throw new Error("Physical sky IBL has no pending generation");
    if (this.active !== null) this.retired.push(this.active);
    this.active = this.pending;
    this.pending = null;
    this.dfgReady = true;
    const retired = this.retired.splice(0);
    const temporary = this.active.temporary.splice(0);
    void done.then(
      () => {
        retired.forEach((set) => this.destroySet(set));
        temporary.forEach((buffer) => buffer.destroy());
      },
      () => {
        retired.forEach((set) => this.destroySet(set));
        temporary.forEach((buffer) => buffer.destroy());
      },
    );
  }

  abort(): void {
    if (this.pending === null) throw new Error("Physical sky IBL has no pending generation");
    this.destroySet(this.pending);
    this.pending = null;
  }

  abortIfPending(): void {
    if (this.pending !== null) this.abort();
  }

  destroy(): void {
    if (this.pending !== null) this.destroySet(this.pending);
    if (this.active !== null) this.destroySet(this.active);
    this.retired.forEach((set) => this.destroySet(set));
    this.pending = null;
    this.active = null;
    this.retired.length = 0;
    this.dfgTexture.destroy();
  }

  private createSet(): SkySet {
    const make = (label: string): GPUTexture =>
      this.device.createTexture({
        label,
        size: [SKY_RESOLUTION, SKY_RESOLUTION],
        mipLevelCount: SKY_MIP_COUNT,
        format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
    const source = make("PhysicalSkyIBL/source radiance");
    const filtered = make("PhysicalSkyIBL/prefiltered specular");
    const diffuseTexture = this.device.createTexture({
      label: "PhysicalSkyIBL/diffuse irradiance",
      size: [32, 32],
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    return {
      source,
      filtered,
      specular: filtered.createView(),
      diffuseTexture,
      diffuse: diffuseTexture.createView(),
      temporary: [],
    };
  }

  private destroySet(set: SkySet): void {
    set.source.destroy();
    set.filtered.destroy();
    set.diffuseTexture.destroy();
    set.temporary.forEach((buffer) => buffer.destroy());
    set.temporary.length = 0;
  }
}
