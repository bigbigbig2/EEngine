import { atmosphereLutStages } from "../../shaders/atmosphere/lut.js";

export type AtmosphereLutName =
  | "transmittance"
  | "multipleScattering"
  | "scattering"
  | "higherOrderScattering"
  | "irradiance";
export const ATMOSPHERE_LUT_SIZES = Object.freeze({
  transmittance: [256, 64, 1],
  multipleScattering: [64, 64, 1],
  scattering: [256, 128, 32],
  higherOrderScattering: [256, 128, 32],
  irradiance: [64, 16, 1],
} as const);
type LutSet = {
  readonly views: Readonly<Record<AtmosphereLutName, GPUTextureView>>;
  readonly sampler: GPUSampler;
  readonly textures: readonly GPUTexture[];
  readonly transforms: GPUBuffer;
  readonly stages: ReadonlyArray<{
    pipeline: GPUComputePipeline;
    bindings: GPUBindGroup;
    dispatch: readonly [number, number, number];
    name: string;
  }>;
};

/** Device-local LUT owner with active/pending generation replacement. */
export class AtmosphereLutResources {
  private active: LutSet;
  private pending: LutSet | null = null;
  private state: "empty" | "recorded" | "ready" | "destroyed" = "empty";
  private ticket = 0;
  private pendingTicket = 0;
  private retired: LutSet[] = [];
  constructor(private readonly device: GPUDevice) {
    const limits = device.limits;
    if (
      limits.maxTextureDimension2D < 256 ||
      limits.maxTextureDimension3D < 256 ||
      limits.maxStorageTexturesPerShaderStage < 2 ||
      limits.maxComputeInvocationsPerWorkgroup < 64 ||
      limits.maxComputeWorkgroupSizeZ < 64 ||
      limits.maxComputeWorkgroupStorageSize < 2048
    )
      throw new Error("Device limits do not support the pinned Takram atmosphere LUT profile");
    this.active = this.createSet();
  }
  get ready(): boolean {
    return this.state === "ready";
  }
  get hasRetired(): boolean {
    return this.retired.length > 0;
  }
  get views(): Readonly<Record<AtmosphereLutName, GPUTextureView>> {
    return (this.pending ?? this.active).views;
  }
  get sampler(): GPUSampler {
    return (this.pending ?? this.active).sampler;
  }
  record(encoder: GPUCommandEncoder, replace = false): number | null {
    if (this.state === "destroyed") throw new Error("Atmosphere LUT resources are destroyed");
    if (this.pending !== null) throw new Error("Atmosphere LUT replacement is already recorded");
    if (this.state === "ready" && !replace) return null;
    const next = this.state === "ready" ? this.createSet() : this.active;
    for (const stage of next.stages) {
      const pass = encoder.beginComputePass({ label: `Atmosphere/${stage.name}` });
      pass.setPipeline(stage.pipeline);
      pass.setBindGroup(0, stage.bindings);
      pass.dispatchWorkgroups(...stage.dispatch);
      pass.end();
    }
    this.pending = next;
    this.state = "recorded";
    this.pendingTicket = ++this.ticket;
    return this.pendingTicket;
  }
  commit(ticket: number): void {
    if (this.state !== "recorded" || this.pending === null || ticket !== this.pendingTicket)
      throw new Error("Stale or unrecorded atmosphere LUT submission");
    if (this.active !== this.pending) this.retired.push(this.active);
    this.active = this.pending;
    this.pending = null;
    this.state = "ready";
  }
  abort(ticket: number): void {
    if (this.state !== "recorded" || this.pending === null || ticket !== this.pendingTicket)
      throw new Error("Stale or unrecorded atmosphere LUT submission");
    const initial = this.pending === this.active;
    if (!initial) this.destroySet(this.pending);
    this.pending = null;
    this.state = initial ? "empty" : "ready";
  }
  retireCompleted(done: Promise<unknown>): void {
    const retired = this.retired.splice(0);
    void done.then(() => retired.forEach((set) => this.destroySet(set))).catch(() => undefined);
  }
  destroy(): void {
    if (this.state === "destroyed") return;
    if (this.pending && this.pending !== this.active) this.destroySet(this.pending);
    this.destroySet(this.active);
    this.retired.forEach((set) => this.destroySet(set));
    this.retired = [];
    this.pending = null;
    this.state = "destroyed";
  }
  private createSet(): LutSet {
    const views = {} as Record<AtmosphereLutName, GPUTextureView>;
    const textures: GPUTexture[] = [];
    for (const name of Object.keys(ATMOSPHERE_LUT_SIZES) as AtmosphereLutName[]) {
      const size = ATMOSPHERE_LUT_SIZES[name];
      const dimension = size[2] > 1 ? "3d" : "2d";
      const texture = this.device.createTexture({
        label: `Atmosphere/${name}`,
        size: [...size],
        dimension,
        format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      textures.push(texture);
      views[name] = texture.createView({ dimension });
    }
    const sampler = this.device.createSampler({
      label: "Atmosphere/LUT linear clamp",
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
    });
    const transforms = this.device.createBuffer({
      label: "Atmosphere/LUT transforms",
      size: 96,
      usage: GPUBufferUsage.UNIFORM,
      mappedAtCreation: true,
    });
    const matrices = new Float32Array(transforms.getMappedRange());
    for (const offset of [0, 5, 10, 12, 17, 22]) matrices[offset] = 1;
    transforms.unmap();
    const bindings: readonly (readonly GPUBindingResource[])[] = [
      [views.transmittance],
      [sampler, views.transmittance, { buffer: transforms }, views.multipleScattering],
      [
        sampler,
        views.transmittance,
        { buffer: transforms },
        sampler,
        views.multipleScattering,
        views.scattering,
        views.higherOrderScattering,
      ],
      [views.irradiance, sampler, views.scattering, sampler, views.higherOrderScattering],
    ];
    const stages = atmosphereLutStages.map((stage, index) => {
      const pipeline = this.device.createComputePipeline({
        label: `Atmosphere/${stage.name}`,
        layout: "auto",
        compute: {
          module: this.device.createShaderModule({ label: `Takram/${stage.name}`, code: stage.wgsl }),
          entryPoint: "main",
        },
      });
      const group = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: bindings[index]!.map((resource, binding) => ({ binding, resource })),
      });
      return { name: stage.name, dispatch: stage.dispatch, pipeline, bindings: group };
    });
    return { views: Object.freeze(views), sampler, textures, transforms, stages };
  }
  private destroySet(set: LutSet): void {
    set.textures.forEach((texture) => texture.destroy());
    set.transforms.destroy();
  }
}
