import { atmosphereLutStages } from "../../shaders/atmosphere/lut.js";

export type AtmosphereLutName = "transmittance" | "multipleScattering" |
  "scattering" | "higherOrderScattering" | "irradiance";

/** Pinned Takram default Earth profile. Length inside the kernels is kilometres. */
export const ATMOSPHERE_LUT_SIZES = Object.freeze({
  transmittance: [256, 64, 1], multipleScattering: [64, 64, 1],
  scattering: [256, 128, 32], higherOrderScattering: [256, 128, 32],
  irradiance: [64, 16, 1]
} as const);

/**
 * Device-local LUT generation; does not submit or own scene/camera state.
 * record() must precede consumers in the same submission. commit() is called
 * only after successful queue.submit, abort() when the encoder is discarded.
 * No GPU readback or CPU approximation of scattering is involved.
 */
export class AtmosphereLutResources {
  readonly views: Readonly<Record<AtmosphereLutName, GPUTextureView>>;
  readonly sampler: GPUSampler;
  private readonly textures: GPUTexture[] = [];
  private readonly transforms: GPUBuffer;
  private readonly stages: ReadonlyArray<{
    pipeline: GPUComputePipeline; bindings: GPUBindGroup;
    dispatch: readonly [number, number, number]; name: string;
  }>;
  private state: "empty" | "recorded" | "ready" | "destroyed" = "empty";
  private ticket = 0;

  constructor(device: GPUDevice) {
    const limits = device.limits;
    if (limits.maxTextureDimension2D < 256 || limits.maxTextureDimension3D < 256 ||
        limits.maxStorageTexturesPerShaderStage < 2 ||
        limits.maxComputeInvocationsPerWorkgroup < 64 ||
        limits.maxComputeWorkgroupSizeZ < 64 || limits.maxComputeWorkgroupStorageSize < 2048) {
      throw new Error("Device limits do not support the pinned Takram atmosphere LUT profile");
    }
    const views = {} as Record<AtmosphereLutName, GPUTextureView>;
    for (const name of Object.keys(ATMOSPHERE_LUT_SIZES) as AtmosphereLutName[]) {
      const size = ATMOSPHERE_LUT_SIZES[name];
      const dimension = size[2] > 1 ? "3d" : "2d";
      const texture = device.createTexture({ label: `Atmosphere/${name}`,
        size: [...size], dimension, format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
      this.textures.push(texture);
      views[name] = texture.createView({ dimension });
    }
    this.views = Object.freeze(views);
    this.sampler = device.createSampler({ label: "Atmosphere/LUT linear clamp",
      minFilter: "linear", magFilter: "linear", mipmapFilter: "nearest",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
    // Two identity mat3x3<f32>, columns padded to vec4: source-verified UV transforms.
    this.transforms = device.createBuffer({ label: "Atmosphere/LUT transforms", size: 96,
      usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
    const matrices = new Float32Array(this.transforms.getMappedRange());
    for (const offset of [0, 5, 10, 12, 17, 22]) matrices[offset] = 1;
    this.transforms.unmap();
    const bindings: readonly (readonly GPUBindingResource[])[] = [
      [views.transmittance],
      [this.sampler, views.transmittance, { buffer: this.transforms }, views.multipleScattering],
      [this.sampler, views.transmittance, { buffer: this.transforms }, this.sampler,
        views.multipleScattering, views.scattering, views.higherOrderScattering],
      [views.irradiance, this.sampler, views.scattering, this.sampler, views.higherOrderScattering]
    ];
    this.stages = atmosphereLutStages.map((stage, index) => {
      const pipeline = device.createComputePipeline({ label: `Atmosphere/${stage.name}`, layout: "auto",
        compute: { module: device.createShaderModule({ label: `Takram/${stage.name}`, code: stage.wgsl }),
          entryPoint: "main" } });
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
        entries: bindings[index]!.map((resource, binding) => ({ binding, resource })) });
      return { name: stage.name, dispatch: stage.dispatch, pipeline, bindings: group };
    });
  }

  get ready(): boolean { return this.state === "ready"; }

  /** Returns a submission ticket, or null when this immutable profile is already resident. */
  record(encoder: GPUCommandEncoder): number | null {
    if (this.state === "ready") return null;
    if (this.state !== "empty") throw new Error(`Atmosphere LUT record in state ${this.state}`);
    for (const stage of this.stages) {
      const pass = encoder.beginComputePass({ label: `Atmosphere/${stage.name}` });
      pass.setPipeline(stage.pipeline);
      pass.setBindGroup(0, stage.bindings);
      pass.dispatchWorkgroups(...stage.dispatch);
      pass.end();
    }
    this.state = "recorded";
    return ++this.ticket;
  }

  commit(ticket: number): void {
    this.requireTicket(ticket);
    this.state = "ready";
  }

  abort(ticket: number): void {
    this.requireTicket(ticket);
    this.state = "empty";
  }

  private requireTicket(ticket: number): void {
    if (this.state !== "recorded" || ticket !== this.ticket) {
      throw new Error("Stale or unrecorded atmosphere LUT submission");
    }
  }

  /** Caller retires the generation after its last submitted consumer; device loss can destroy immediately. */
  destroy(): void {
    if (this.state === "destroyed") return;
    this.textures.forEach(texture => texture.destroy());
    this.transforms.destroy();
    this.state = "destroyed";
  }
}
