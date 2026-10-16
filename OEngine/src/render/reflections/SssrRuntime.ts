import { PipelineCompilationQueue } from "../../gpu/PipelineCompilationQueue.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { GpuBindGroupCache } from "../../gpu/GpuBindGroupResourceCache.js";
import { SSSR_CLASSIFY_WGSL } from "../../shaders/sssr_classify.js";
import { SSSR_INTERSECT_WGSL } from "../../shaders/sssr_intersect.js";
import { SSSR_REPROJECT_WGSL } from "../../shaders/sssr_reproject.js";
import { SSSR_PREFILTER_WGSL } from "../../shaders/sssr_prefilter.js";
import { SSSR_RESOLVE_TEMPORAL_WGSL } from "../../shaders/sssr_resolve_temporal.js";
import { SSSR_COMPOSITE_WGSL, SSSR_SNAPSHOT_WGSL } from "../../shaders/sssr_composite.js";
import {
  SSSR_DEPTH_COPY_WGSL,
  SSSR_DEPTH_REDUCE_WGSL,
  SSSR_BLUE_NOISE_WGSL,
  SSSR_INDIRECT_WGSL
} from "../../shaders/sssr_prepare.js";
import { loadSssrNoiseTables } from "./SssrNoiseData.js";
import {
  planSssrCapacity,
  resolveSssrMemorySettings,
  SSSR_NOISE_BYTES,
  SSSR_UNIFORM_BYTES,
  type SssrCapacity,
  type SssrMemorySettings
} from "./SssrAbi.js";
import {
  resolveScreenSpaceReflectionsSettings,
  screenSpaceReflectionsHistoryKey,
  type ScreenSpaceReflectionsSettings
} from "./ScreenSpaceReflectionsSettings.js";

export interface SssrCamera {
  readonly projection: ArrayLike<number>;
  readonly inverseProjection: ArrayLike<number>;
  readonly view: ArrayLike<number>;
  readonly inverseView: ArrayLike<number>;
  readonly inverseViewProjection: ArrayLike<number>;
  readonly viewProjection: ArrayLike<number>;
}

/** Borrowed products remain live through the ordinary scene submission fence.
 * Depth is FINAL opaque reverse-Z, radiance is pre-SSR Rec2020 x GPU P;
 * environment is the existing linear Rec709 octahedral specular texture.
 * Seed.xy is current_uv-previous_uv. No CPU exposure surrogate is accepted. */
export interface SssrFrameInput {
  readonly output?: GPUTexture;
  readonly width: number;
  readonly height: number;
  readonly receivers: GPUBuffer;
  readonly depth: GPUTexture;
  readonly opaqueRadiance: GPUTexture;
  readonly environment: GPUTexture;
  readonly seed: GPUTexture;
  readonly response: GPUTexture;
  readonly identity: GPUTexture;
  readonly previousIdentity: GPUTexture;
  readonly currentExposure: GPUBuffer;
  readonly previousExposure: GPUBuffer;
  readonly camera: SssrCamera;
  readonly settings: ScreenSpaceReflectionsSettings;
  readonly reset?: boolean;
  /** A real debug consumer supplies a transient 4P storage buffer. No optional
   * diagnostic allocation survives when that consumer disappears. */
  readonly diagnostic?: {
    readonly mode: "hit-confidence" | "history-acceptance";
    readonly lobe: 0 | 1;
    readonly buffer: GPUBuffer;
  };
}

type Stage =
  | "depthCopy"
  | "depthReduce"
  | "noise"
  | "args"
  | "classify"
  | "intersect"
  | "reproject"
  | "prefilter"
  | "resolve"
  | "composite"
  | "snapshot";

interface LobeResources {
  readonly radiance: readonly [GPUTexture, GPUTexture];
  readonly statistics: readonly [GPUTexture, GPUTexture];
  readonly average: readonly [GPUTexture, GPUTexture];
}

interface Workset {
  readonly borrowedOutput: boolean;
  readonly capacity: SssrCapacity;
  readonly charge: number;
  readonly gpuBytes: number;
  readonly textures: GPUTexture[];
  readonly buffers: GPUBuffer[];
  readonly uniforms: readonly [GPUBuffer, GPUBuffer];
  readonly depth: GPUTexture;
  readonly depthViews: GPUTextureView[];
  readonly normalHistory: GPUTexture;
  readonly depthHistory: GPUTexture;
  readonly lobes: readonly [LobeResources, LobeResources];
  readonly reprojected: GPUTexture;
  readonly reprojectionStatistics: GPUTexture;
  readonly prefilterVariance: GPUTexture;
  readonly rayLength: GPUTexture;
  readonly rays: GPUBuffer;
  readonly tiles: GPUBuffer;
  readonly counts: GPUBuffer;
  readonly args: GPUBuffer;
  readonly output: GPUTexture | undefined;
  unsubmittedUploads: boolean;
}

interface PendingFrame {
  readonly input: SssrFrameInput;
  readonly set: Workset;
  readonly write: 0 | 1;
  readonly historyValid: boolean;
  readonly historyKey: string;
  encoded: boolean;
  attached: boolean;
  command?: ShadeGPUCommandContext;
}

/** The complete selected algorithm, not yet selected by FrameProgram (SSR-1).
 * It never creates an encoder, submits, reads visible work or owns materials.
 * prepare -> encode -> successful commit / abort is one scene-frame transaction. */
export class SssrRuntime {
  private readonly groups = new GpuBindGroupCache(128);
  private readonly views = new WeakMap<GPUTexture, GPUTextureView>();
  private readonly memory: Required<SssrMemorySettings>;
  private readonly noiseTables: GPUBuffer;
  private readonly noise: GPUTexture;
  private readonly dummyDiagnostic: GPUBuffer;
  private readonly sampler: GPUSampler;
  private readonly commonLayout: GPUBindGroupLayout;
  private readonly initializationFence: Promise<void>;
  private pipelines!: Record<Stage, GPUComputePipeline>;
  private readonly stageLayouts = new Map<Stage, GPUBindGroupLayout>();
  private readonly scratch = [new ArrayBuffer(SSSR_UNIFORM_BYTES), new ArrayBuffer(SSSR_UNIFORM_BYTES)];
  private readonly previousViewProjection = new Float32Array(16);
  private readonly previousInverseProjection = new Float32Array(16);
  private readonly pendingViewProjection = new Float32Array(16);
  private readonly pendingInverseProjection = new Float32Array(16);
  private active: Workset | null = null;
  private pending: PendingFrame | null = null;
  private readIndex: 0 | 1 = 0;
  private submittedPhase = 0;
  private historyKey = "";
  private invalid = true;
  private lastFence: Promise<void> | null = null;
  private retiredBytes = 0;
  private retiredGpuBytes = 0;
  private globalsAlive = true;
  private destroyed = false;
  private lost = false;

  private constructor(
    private readonly device: GPUDevice,
    tables: ArrayBuffer,
    memory: SssrMemorySettings
  ) {
    this.memory = resolveSssrMemorySettings(memory);
    void device.lost.then(() => {
      this.lost = true;
      this.abort();
      this.retire(this.active, this.lastFence);
      this.active = null;
      this.groups.clear();
    });
    this.commonLayout = device.createBindGroupLayout({
      label: "SSSR/frame products",
      entries: [
        uniform(0),
        storage(1, false),
        sampled(2, "unfilterable-float"),
        storage(3, false),
        storage(4, false)
      ]
    });
    this.noiseTables = device.createBuffer({
      label: "SSSR/pinned Sobol and scrambling",
      size: tables.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(this.noiseTables, 0, tables);
    this.initializationFence = device.queue.onSubmittedWorkDone();
    this.noise = device.createTexture({
      label: "SSSR/128x128 blue noise",
      size: [128, 128],
      format: "rg8unorm",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
    });
    this.dummyDiagnostic = device.createBuffer({
      label: "SSSR/no diagnostic consumer",
      size: 4,
      usage: GPUBufferUsage.STORAGE
    });
    this.sampler = device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge"
    });
  }

  static async create(device: GPUDevice, memory: SssrMemorySettings = {}): Promise<SssrRuntime> {
    // Preflight the complete profile BEFORE allocating even device-local tables.
    planSssrCapacity(1, 1, device.limits, memory);
    if (!device.features.has("texture-formats-tier1")) {
      throw new Error("SSSR requires texture-formats-tier1 for RG8/R16/RG16 storage formats");
    }
    const tables = await loadSssrNoiseTables();
    const runtime = new SssrRuntime(device, tables, memory);
    try {
      await Promise.all([runtime.initializePipelines(), runtime.initializationFence]);
      return runtime;
    } catch (error) {
      runtime.destroy();
      throw error;
    }
  }

  private async initializePipelines(): Promise<void> {
    const definitions: readonly [Stage, string, readonly GPUBindGroupLayoutEntry[], boolean][] = [
      ["depthCopy", SSSR_DEPTH_COPY_WGSL, [sampled(0, "depth"), output(1, "r32float")], false],
      [
        "depthReduce",
        SSSR_DEPTH_REDUCE_WGSL,
        [sampled(0, "unfilterable-float"), output(1, "r32float")],
        false
      ],
      ["noise", SSSR_BLUE_NOISE_WGSL, [uniform(0), storage(1, false), output(2, "rg8unorm")], false],
      ["args", SSSR_INDIRECT_WGSL, [uniform(0), storage(1, false), storage(2, true)], false],
      [
        "classify",
        SSSR_CLASSIFY_WGSL,
        [
          sampled(0),
          storage(1, true),
          storage(2, true),
          storage(3, true),
          output(4, "rgba16float"),
          output(5, "rg16float"),
          output(6, "rgba16float"),
          output(7, "r32float"),
          sampled(8)
        ],
        true
      ],
      [
        "intersect",
        SSSR_INTERSECT_WGSL,
        [
          storage(0, false),
          storage(1, false),
          sampled(2),
          sampled(3),
          sampled(4),
          output(5, "rgba16float"),
          output(6, "r32float"),
          storage(7, true)
        ],
        true
      ],
      [
        "reproject",
        SSSR_REPROJECT_WGSL,
        [
          storage(0, false),
          storage(1, false),
          sampled(2),
          sampled(4),
          sampled(5),
          sampled(6, "float", "2d-array"),
          sampled(7, "unfilterable-float"),
          sampled(9, "unfilterable-float"),
          sampled(10, "unfilterable-float"),
          sampled(11),
          sampled(12, "uint"),
          sampled(13, "uint"),
          storage(15, true),
          output(17, "rgba16float"),
          output(18, "rg16float"),
          output(19, "rgba16float")
        ],
        true
      ],
      [
        "prefilter",
        SSSR_PREFILTER_WGSL,
        [
          storage(0, false),
          storage(1, false),
          sampled(2),
          sampled(3),
          sampled(8),
          filteringSampler(16),
          output(17, "rgba16float"),
          output(20, "r16float")
        ],
        true
      ],
      [
        "resolve",
        SSSR_RESOLVE_TEMPORAL_WGSL,
        [
          storage(0, false),
          storage(1, false),
          sampled(2),
          sampled(3),
          sampled(5),
          sampled(8),
          sampled(14),
          filteringSampler(16),
          output(17, "rgba16float"),
          output(18, "rg16float")
        ],
        true
      ],
      [
        "composite",
        SSSR_COMPOSITE_WGSL,
        [sampled(0), sampled(1), sampled(2), output(3, "rgba16float")],
        true
      ],
      ["snapshot", SSSR_SNAPSHOT_WGSL, [output(0, "rgba16float", "2d-array"), output(1, "r32float")], true]
    ];
    const entries = await Promise.all(
      definitions.map(async ([stage, code, bindings, common]) => {
        const layout = this.device.createBindGroupLayout({
          label: `SSSR/${stage} products`,
          entries: bindings
        });
        this.stageLayouts.set(stage, layout);
        const pipeline = await PipelineCompilationQueue.forDevice(this.device).run(() =>
          this.device.createComputePipelineAsync({
            label: `SSSR/${stage}`,
            layout: this.device.createPipelineLayout({
              bindGroupLayouts: common ? [this.commonLayout, layout] : [layout],
            }),
            compute: {
              module: this.device.createShaderModule({ label: `SSSR/${stage}`, code }),
              entryPoint: "main",
            },
          }),
        );
        return [stage, pipeline] as const;
      })
    );
    this.pipelines = Object.fromEntries(entries) as Record<Stage, GPUComputePipeline>;
  }

  /** False means only fence-retired work prevents admission. A real capacity or
   * input error throws; no resolution/quality fallback hides it. */
  canAdmit(width: number, height: number, diagnostic = false): boolean {
    this.assertLive();
    const capacity = planSssrCapacity(width, height, this.device.limits, this.memory, diagnostic);
    const active = this.active;
    const replacement = !active || active.capacity.width !== width || active.capacity.height !== height;
    const charge = capacity.activeBytes - SSSR_NOISE_BYTES - (diagnostic ? capacity.pixels * 4 : 0);
    const required =
      SSSR_NOISE_BYTES +
      (active?.charge ?? 0) +
      (replacement ? charge : 0) +
      (diagnostic ? capacity.pixels * 4 : 0);
    if (required > this.memory.ownerMaxBytes) {
      throw new RangeError("SSSR owner cannot hold the complete active/candidate extent");
    }
    return required + this.retiredBytes <= this.memory.ownerMaxBytes;
  }

  prepare(input: SssrFrameInput): boolean {
    this.assertLive();
    if (this.pending) {
      throw new Error("SSSR already has a prepared frame");
    }
    const settings = resolveScreenSpaceReflectionsSettings(input.settings, {});
    if (!settings.enabled || settings.strength === 0) {
      throw new Error("Inactive SSSR must not prepare full-screen work");
    }
    const capacity = planSssrCapacity(
      input.width,
      input.height,
      this.device.limits,
      this.memory,
      input.diagnostic !== undefined
    );
    this.validateInputs(input, capacity);
    const historyKey = screenSpaceReflectionsHistoryKey(settings);
    let set = this.active;
    if (
      !set ||
      set.capacity.width !== input.width ||
      set.capacity.height !== input.height ||
      set.borrowedOutput !== (input.output !== undefined)
    ) {
      const charge = capacity.activeBytes - SSSR_NOISE_BYTES - (input.diagnostic ? capacity.pixels * 4 : 0);
      const withoutRetired =
        SSSR_NOISE_BYTES + (this.active?.charge ?? 0) + charge + (input.diagnostic ? capacity.pixels * 4 : 0);
      if (withoutRetired > this.memory.ownerMaxBytes) {
        throw new RangeError("SSSR owner cannot hold active and candidate worksets");
      }
      if (withoutRetired + this.retiredBytes > this.memory.ownerMaxBytes) {
        return false;
      }
      set = this.allocate(capacity, input.output);
    } else if (
      this.reservedBytes + (input.diagnostic ? capacity.pixels * 4 : 0) >
      this.memory.ownerMaxBytes
    ) {
      if (
        this.reservedBytes - this.retiredBytes + (input.diagnostic ? capacity.pixels * 4 : 0) >
        this.memory.ownerMaxBytes
      ) {
        throw new RangeError("SSSR diagnostic consumer exceeds the owner memory ceiling");
      }
      return false;
    }
    const historyValid =
      set === this.active && !this.invalid && !input.reset && historyKey === this.historyKey;
    const pending: PendingFrame = {
      input,
      set,
      write: this.readIndex === 0 ? 1 : 0,
      historyValid,
      historyKey,
      encoded: false,
      attached: false
    };
    this.pending = pending;
    this.pendingViewProjection.set(input.camera.viewProjection);
    this.pendingInverseProjection.set(input.camera.inverseProjection);
    for (let lobe = 0; lobe < 2; lobe++) {
      this.packFrame(pending, lobe);
    }
    return true;
  }

  private validateInputs(input: SssrFrameInput, capacity: SssrCapacity): void {
    const textures: readonly (readonly [GPUTexture, GPUTextureFormat])[] = [
      ...(input.output ? [[input.output, "rgba16float"] as const] : []),
      [input.depth, "depth32float"],
      [input.opaqueRadiance, "rgba16float"],
      [input.seed, "rgba32float"],
      [input.response, "rgba8unorm"],
      [input.identity, "rgba32uint"],
      [input.previousIdentity, "rgba32uint"]
    ];
    for (const [texture, format] of textures) {
      if (
        texture.width !== input.width ||
        texture.height !== input.height ||
        texture.depthOrArrayLayers !== 1 ||
        texture.sampleCount !== 1 ||
        texture.format !== format ||
        (texture.usage & GPUTextureUsage.TEXTURE_BINDING) === 0
      ) {
        throw new RangeError(`SSSR input ${format} does not match the complete viewport/usage`);
      }
    }
    if (
      input.output &&
      (input.output === input.opaqueRadiance || (input.output.usage & GPUTextureUsage.STORAGE_BINDING) === 0)
    ) {
      throw new RangeError("SSSR correction requires a distinct writable HDR output");
    }
    if (
      input.environment.format !== "rgba16float" ||
      input.environment.sampleCount !== 1 ||
      input.environment.width !== input.environment.height ||
      input.environment.depthOrArrayLayers !== 1 ||
      (input.environment.usage & GPUTextureUsage.TEXTURE_BINDING) === 0
    ) {
      throw new RangeError("SSSR requires the native rgba16float octahedral environment");
    }
    for (const [buffer, bytes] of [
      [input.receivers, capacity.receiverBytes],
      [input.currentExposure, 4],
      [input.previousExposure, 4]
    ] as const) {
      if (buffer.size < bytes || (buffer.usage & GPUBufferUsage.STORAGE) === 0) {
        throw new RangeError("SSSR borrowed buffer has insufficient size/usage");
      }
    }
    if (
      input.diagnostic &&
      (input.diagnostic.buffer.size < capacity.pixels * 4 ||
        (input.diagnostic.buffer.usage & (GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)) !==
          (GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) ||
        ![0, 1].includes(input.diagnostic.lobe) ||
        !["hit-confidence", "history-acceptance"].includes(input.diagnostic.mode))
    ) {
      throw new RangeError("SSSR diagnostic consumer must supply a full 4P buffer and valid mode/lobe");
    }
    for (const key of [
      "projection",
      "inverseProjection",
      "view",
      "inverseView",
      "inverseViewProjection",
      "viewProjection"
    ] as const) {
      const matrix = input.camera[key];
      if (!matrix) {
        throw new RangeError(`SSSR camera lacks ${key}`);
      }
      if (matrix.length !== 16) {
        throw new RangeError("SSSR camera requires complete 4x4 matrices");
      }
      for (let index = 0; index < 16; index++) {
        if (!Number.isFinite(Math.fround(matrix[index]!))) {
          throw new RangeError("SSSR camera matrix is not finite f32");
        }
      }
    }
  }

  private packFrame(pending: PendingFrame, lobe: number): void {
    const { input, set, historyValid } = pending;
    const memory = this.scratch[lobe]!;
    const uints = new Uint32Array(memory);
    const floats = new Float32Array(memory);
    uints.set([input.width, input.height, set.capacity.mipCount - 1, lobe], 0);
    floats.set(
      [
        input.settings.maxRoughness ** 2,
        input.settings.thicknessMeters / input.settings.metersPerWorldUnit,
        input.settings.temporalStability,
        input.settings.strength
      ],
      4
    );
    uints.set(
      [
        this.submittedPhase,
        input.settings.quality === "balanced" ? 1 : 4,
        Number(historyValid),
        input.diagnostic ? (input.diagnostic.mode === "hit-confidence" ? 1 : 2) : 0
      ],
      8
    );
    uints.set(
      [
        set.capacity.tilesX,
        this.device.limits.maxComputeWorkgroupsPerDimension,
        128,
        input.diagnostic?.lobe ?? 0
      ],
      12
    );
    floats.set([input.settings.metersPerWorldUnit, 0, 0, 0], 16);
    const matrices = [
      input.camera.inverseProjection,
      input.camera.projection,
      input.camera.view,
      input.camera.inverseView,
      input.camera.inverseViewProjection,
      historyValid ? this.previousViewProjection : input.camera.viewProjection,
      historyValid ? this.previousInverseProjection : input.camera.inverseProjection
    ];
    for (let matrix = 0; matrix < matrices.length; matrix++) {
      floats.set(matrices[matrix]!, 20 + matrix * 16);
    }
    this.device.queue.writeBuffer(set.uniforms[lobe]!, 0, memory);
    set.unsubmittedUploads = true;
  }

  private allocate(capacity: SssrCapacity, borrowedOutput?: GPUTexture): Workset {
    const textures: GPUTexture[] = [];
    const buffers: GPUBuffer[] = [];
    const texture = (
      name: string,
      format: GPUTextureFormat,
      width = capacity.width,
      height = capacity.height,
      layers = 1,
      mipLevelCount = 1
    ): GPUTexture => {
      const resource = this.device.createTexture({
        label: `SSSR/${name}`,
        size: [width, height, layers],
        format,
        mipLevelCount,
        usage:
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          (format === "rgba16float" ? GPUTextureUsage.COPY_DST : 0)
      });
      textures.push(resource);
      return resource;
    };
    const buffer = (name: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
      const resource = this.device.createBuffer({ label: `SSSR/${name}`, size, usage });
      buffers.push(resource);
      return resource;
    };
    try {
      const lobes = [0, 1].map((lobe): LobeResources => ({
        radiance: [
          texture(`lobe${lobe}/radiance0`, "rgba16float"),
          texture(`lobe${lobe}/radiance1`, "rgba16float")
        ],
        statistics: [
          texture(`lobe${lobe}/statistics0`, "rg16float"),
          texture(`lobe${lobe}/statistics1`, "rg16float")
        ],
        average: [
          texture(`lobe${lobe}/average0`, "rgba16float", capacity.tilesX, capacity.tilesY),
          texture(`lobe${lobe}/average1`, "rgba16float", capacity.tilesX, capacity.tilesY)
        ]
      })) as [LobeResources, LobeResources];
      const depth = texture(
        "full precision nearest depth",
        "r32float",
        capacity.width,
        capacity.height,
        1,
        capacity.mipCount
      );
      const depthViews = Array.from({ length: capacity.mipCount }, (_, mip) =>
        depth.createView({ baseMipLevel: mip, mipLevelCount: 1 })
      );
      return {
        capacity,
        borrowedOutput: borrowedOutput !== undefined,
        unsubmittedUploads: false,
        charge: capacity.ownedBytes + capacity.receiverBytes - SSSR_NOISE_BYTES,
        gpuBytes:
          (borrowedOutput ? 94 : 102) * capacity.pixels +
          capacity.depthBytes +
          36 * capacity.tiles +
          SSSR_UNIFORM_BYTES * 2 +
          32,
        textures,
        buffers,
        lobes,
        depth,
        depthViews,
        uniforms: [
          buffer("base constants", SSSR_UNIFORM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
          buffer("coat constants", SSSR_UNIFORM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
        ],
        normalHistory: texture(
          "previous normals and alpha",
          "rgba16float",
          capacity.width,
          capacity.height,
          2
        ),
        depthHistory: texture("previous depth", "r32float"),
        reprojected: texture("shared reprojected radiance", "rgba16float"),
        reprojectionStatistics: texture("shared reprojection statistics", "rg16float"),
        prefilterVariance: texture("shared prefilter variance", "r16float"),
        rayLength: texture("shared full precision ray length", "r32float"),
        rays: buffer(
          "full pixel ray capacity",
          capacity.rayBytes,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        ),
        tiles: buffer(
          "full tile capacity",
          capacity.tiles * 4,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        ),
        counts: buffer(
          "ray and tile counters",
          8,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        ),
        args: buffer(
          "trace and denoiser indirect",
          24,
          GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC
        ),
        output: borrowedOutput ? undefined : texture("corrected opaque", "rgba16float")
      };
    } catch (error) {
      for (const resource of [...textures, ...buffers]) {
        resource.destroy();
      }
      throw error;
    }
  }

  attach(command: ShadeGPUCommandContext): void {
    const pending = this.requirePending();
    if (pending.attached || command.closed) {
      throw new Error("SSSR command attachment must be unique and open");
    }
    pending.attached = true;
    pending.command = command;
    command.onFinished.addOne(() => {
      if (this.pending === pending) {
        this.commit(command.gpuDone);
      }
    });
    command.onAborted.addOne(() => {
      if (this.pending === pending) {
        this.abort();
      }
    });
  }

  encode(encoder: GPUCommandEncoder): GPUTexture {
    this.assertLive();
    const pending = this.requirePending();
    if (pending.encoded) {
      throw new Error("SSSR frame was already encoded");
    }
    const { input, set, write } = pending;
    this.dispatch(
      encoder,
      "depthCopy",
      [this.view(input.depth), set.depthViews[0]!],
      set.capacity.width,
      set.capacity.height
    );
    for (let mip = 1; mip < set.capacity.mipCount; mip++) {
      this.dispatch(
        encoder,
        "depthReduce",
        [set.depthViews[mip - 1]!, set.depthViews[mip]!],
        Math.max(1, input.width >> mip),
        Math.max(1, input.height >> mip)
      );
    }
    this.dispatch(
      encoder,
      "noise",
      [{ buffer: set.uniforms[0] }, { buffer: this.noiseTables }, this.view(this.noise)],
      128,
      128
    );
    if (input.diagnostic) {
      // The graph consumer owns this transient output; initialize all pixels.
      encoder.clearBuffer(input.diagnostic.buffer, 0, set.capacity.pixels * 4);
    }
    for (let lobe = 0; lobe < 2; lobe++) {
      const resources = set.lobes[lobe]!;
      const common = this.commonGroup(set, input, lobe);
      encoder.clearBuffer(set.counts);
      this.dispatchCommon(
        encoder,
        "classify",
        common,
        [
          [0, this.view(resources.statistics[this.readIndex])],
          [1, { buffer: set.rays }],
          [2, { buffer: set.tiles }],
          [3, { buffer: set.counts }],
          [4, this.view(resources.radiance[write])],
          [5, this.view(resources.statistics[write])],
          [6, this.view(resources.average[write])],
          [7, this.view(set.rayLength)],
          [8, this.view(input.environment)]
        ],
        set.capacity.tilesX,
        set.capacity.tilesY
      );
      this.dispatch(
        encoder,
        "args",
        [{ buffer: set.uniforms[lobe]! }, { buffer: set.counts }, { buffer: set.args }],
        1,
        1,
        1
      );
      const diagnostic = input.diagnostic?.buffer ?? this.dummyDiagnostic;
      this.dispatchCommon(
        encoder,
        "intersect",
        common,
        [
          [0, { buffer: set.rays }],
          [1, { buffer: set.counts }],
          [2, this.view(this.noise)],
          [3, this.view(input.opaqueRadiance)],
          [4, this.view(input.environment)],
          [5, this.view(resources.radiance[write])],
          [6, this.view(set.rayLength)],
          [7, { buffer: diagnostic, size: input.diagnostic ? set.capacity.pixels * 4 : 4 }]
        ],
        0,
        0,
        set.args,
        0
      );
      this.dispatchCommon(
        encoder,
        "reproject",
        common,
        [
          [0, { buffer: set.tiles }],
          [1, { buffer: set.counts }],
          [2, this.view(resources.radiance[write])],
          [4, this.view(resources.radiance[this.readIndex])],
          [5, this.view(resources.statistics[this.readIndex])],
          [6, this.view(set.normalHistory)],
          [7, this.view(set.depthHistory)],
          [9, this.view(set.rayLength)],
          [10, this.view(input.seed)],
          [11, this.view(input.response)],
          [12, this.view(input.identity)],
          [13, this.view(input.previousIdentity)],
          [15, { buffer: diagnostic, size: input.diagnostic ? set.capacity.pixels * 4 : 4 }],
          [17, this.view(set.reprojected)],
          [18, this.view(set.reprojectionStatistics)],
          [19, this.view(resources.average[write])]
        ],
        0,
        0,
        set.args,
        12
      );
      // Old history is dead only now. Initialize the complete prefilter image
      // from CURRENT raw radiance: inactive tiles still supply environment halo.
      encoder.copyTextureToTexture(
        { texture: resources.radiance[write] },
        { texture: resources.radiance[this.readIndex] },
        [input.width, input.height]
      );
      this.dispatchCommon(
        encoder,
        "prefilter",
        common,
        [
          [0, { buffer: set.tiles }],
          [1, { buffer: set.counts }],
          [2, this.view(resources.radiance[write])],
          [3, this.view(set.reprojectionStatistics)],
          [8, this.view(resources.average[write])],
          [16, this.sampler],
          [17, this.view(resources.radiance[this.readIndex])],
          [20, this.view(set.prefilterVariance)]
        ],
        0,
        0,
        set.args,
        12
      );
      this.dispatchCommon(
        encoder,
        "resolve",
        common,
        [
          [0, { buffer: set.tiles }],
          [1, { buffer: set.counts }],
          [2, this.view(resources.radiance[this.readIndex])],
          [3, this.view(set.prefilterVariance)],
          [5, this.view(set.reprojectionStatistics)],
          [8, this.view(resources.average[write])],
          [14, this.view(set.reprojected)],
          [16, this.sampler],
          [17, this.view(resources.radiance[write])],
          [18, this.view(resources.statistics[write])]
        ],
        0,
        0,
        set.args,
        12
      );
    }
    const common = this.commonGroup(set, input, 0);
    this.dispatchCommon(
      encoder,
      "composite",
      common,
      [
        [0, this.view(input.opaqueRadiance)],
        [1, this.view(set.lobes[0].radiance[write])],
        [2, this.view(set.lobes[1].radiance[write])],
        [3, this.view(input.output ?? set.output!)]
      ],
      Math.ceil(input.width / 8),
      Math.ceil(input.height / 8)
    );
    this.dispatchCommon(
      encoder,
      "snapshot",
      common,
      [
        [0, this.view(set.normalHistory)],
        [1, this.view(set.depthHistory)]
      ],
      Math.ceil(input.width / 8),
      Math.ceil(input.height / 8)
    );
    pending.encoded = true;
    return input.output ?? set.output!;
  }

  private commonGroup(set: Workset, input: SssrFrameInput, lobe: number): GPUBindGroup {
    return this.groups.create(this.device, {
      layout: this.commonLayout,
      entries: [
        { binding: 0, resource: { buffer: set.uniforms[lobe]! } },
        { binding: 1, resource: { buffer: input.receivers, size: set.capacity.receiverBytes } },
        { binding: 2, resource: this.view(set.depth) },
        { binding: 3, resource: { buffer: input.currentExposure, size: 4 } },
        { binding: 4, resource: { buffer: input.previousExposure, size: 4 } }
      ]
    });
  }

  private view(texture: GPUTexture): GPUTextureView {
    let view = this.views.get(texture);
    if (!view) {
      view = texture.createView({ dimension: texture.depthOrArrayLayers === 1 ? "2d" : "2d-array" });
      this.views.set(texture, view);
    }
    return view;
  }

  private dispatch(
    encoder: GPUCommandEncoder,
    stage: Stage,
    resources: readonly GPUBindingResource[],
    width: number,
    height: number,
    workgroupSize = 8
  ): void {
    const pipeline = this.pipelines[stage];
    const group = this.groups.create(this.device, {
      layout: this.stageLayouts.get(stage)!,
      entries: resources.map((resource, binding) => ({ binding, resource }))
    });
    const pass = encoder.beginComputePass({ label: `SSSR/${stage}` });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(width / workgroupSize), Math.ceil(height / workgroupSize));
    pass.end();
  }

  private dispatchCommon(
    encoder: GPUCommandEncoder,
    stage: Stage,
    common: GPUBindGroup,
    bindings: readonly (readonly [number, GPUBindingResource])[],
    x: number,
    y: number,
    indirect?: GPUBuffer,
    offset = 0
  ): void {
    const pipeline = this.pipelines[stage];
    const group = this.groups.create(this.device, {
      layout: this.stageLayouts.get(stage)!,
      entries: bindings.map(([binding, resource]) => ({ binding, resource }))
    });
    const pass = encoder.beginComputePass({ label: `SSSR/${stage}` });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, common);
    pass.setBindGroup(1, group);
    if (indirect) {
      pass.dispatchWorkgroupsIndirect(indirect, offset);
    } else {
      pass.dispatchWorkgroups(x, y);
    }
    pass.end();
  }

  /** Called only after the caller submits the complete ordinary frame. */
  commit(fence: Promise<void>): void {
    const pending = this.requirePending();
    if (pending.command && !pending.command.closed) {
      throw new Error("SSSR publication requires the submitted frame");
    }
    if (!pending.encoded) {
      throw new Error("SSSR cannot publish incomplete products");
    }
    if (pending.set !== this.active) {
      this.retire(this.active, this.lastFence);
    }
    this.active = pending.set;
    // The ordinary submission fence now covers both uniform uploads and passes.
    this.active.unsubmittedUploads = false;
    this.readIndex = pending.write;
    this.previousViewProjection.set(this.pendingViewProjection);
    this.previousInverseProjection.set(this.pendingInverseProjection);
    this.historyKey = pending.historyKey;
    this.submittedPhase = (this.submittedPhase + 1) >>> 0;
    this.invalid = false;
    this.lastFence = fence;
    this.pending = null;
  }

  abort(): void {
    if (!this.pending) {
      return;
    }
    if (this.pending.command && !this.pending.command.closed) {
      this.pending.command.abort(new Error("SSSR transaction aborted"));
      return;
    }
    if (this.pending.set !== this.active) {
      this.retire(this.pending.set, null);
    }
    this.pending = null;
  }

  invalidate(): void {
    this.assertLive();
    if (this.pending) {
      throw new Error("SSSR invalidation requires a frame boundary");
    }
    this.invalid = true;
  }

  releaseHistory(): void {
    this.assertLive();
    if (this.pending) {
      throw new Error("SSSR release requires a frame boundary");
    }
    this.retire(this.active, this.lastFence);
    this.active = null;
    this.invalid = true;
    this.historyKey = "";
    this.groups.clear();
  }

  private retire(set: Workset | null, fence: Promise<void> | null): void {
    if (!set) {
      return;
    }
    if (set.unsubmittedUploads) {
      // prepare writes uniforms before an encoder exists. An aborted candidate
      // still has queue work; retain its allocation without adding a frame wait.
      const uploadsDone = this.device.queue.onSubmittedWorkDone();
      fence = fence ? Promise.allSettled([fence, uploadsDone]).then(() => undefined) : uploadsDone;
    }
    const release = (): void => {
      for (const resource of [...set.textures, ...set.buffers]) {
        resource.destroy();
      }
      if (fence) {
        this.retiredBytes -= set.charge;
        this.retiredGpuBytes -= set.gpuBytes;
      }
    };
    if (fence) {
      this.retiredBytes += set.charge;
      this.retiredGpuBytes += set.gpuBytes;
      // Both outcomes release resources; the submitting frame retains the
      // original rejecting fence and reports device failure to its caller.
      void fence.then(release, release);
    } else {
      release();
    }
  }

  get frame(): {
    readonly output: GPUTexture;
    readonly base: GPUTexture;
    readonly coat: GPUTexture;
    readonly basePrefilter: GPUTexture;
    readonly coatPrefilter: GPUTexture;
    readonly baseStatistics: GPUTexture;
    readonly coatStatistics: GPUTexture;
    readonly depth: GPUTexture;
    readonly rayLength: GPUTexture;
    readonly counts: GPUBuffer;
    readonly args: GPUBuffer;
    readonly historyValid: boolean;
    readonly capacity: SssrCapacity;
  } {
    const pending = this.requirePending();
    const { set, write } = pending;
    return {
      output: pending.input.output ?? set.output!,
      base: set.lobes[0].radiance[write],
      coat: set.lobes[1].radiance[write],
      basePrefilter: set.lobes[0].radiance[this.readIndex],
      coatPrefilter: set.lobes[1].radiance[this.readIndex],
      baseStatistics: set.lobes[0].statistics[write],
      coatStatistics: set.lobes[1].statistics[write],
      depth: set.depth,
      rayLength: set.rayLength,
      counts: set.counts,
      args: set.args,
      historyValid: pending.historyValid,
      capacity: set.capacity
    };
  }

  get allocatedBytes(): number {
    return (
      (this.globalsAlive ? SSSR_NOISE_BYTES + 4 : 0) +
      this.retiredGpuBytes +
      (this.active?.gpuBytes ?? 0) +
      (this.pending && this.pending.set !== this.active ? this.pending.set.gpuBytes : 0)
    );
  }

  /** Admission charge includes borrowed Native records and constant headroom;
   * allocatedBytes instead reports only this owner's actual GPU descriptors. */
  get reservedBytes(): number {
    return (
      SSSR_NOISE_BYTES +
      this.retiredBytes +
      (this.active?.charge ?? 0) +
      (this.pending && this.pending.set !== this.active ? this.pending.set.charge : 0)
    );
  }

  get phase(): number {
    return this.submittedPhase;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.abort();
    this.retire(this.active, this.lastFence);
    this.active = null;
    const releaseGlobals = (): void => {
      this.noiseTables.destroy();
      this.noise.destroy();
      this.dummyDiagnostic.destroy();
      this.globalsAlive = false;
    };
    void (this.lastFence ?? this.initializationFence).then(releaseGlobals, releaseGlobals);
    this.groups.clear();
    this.destroyed = true;
  }

  private assertLive(): void {
    if (this.destroyed || this.lost) {
      throw new Error("SSSR owner is destroyed or its device was lost");
    }
  }

  private requirePending(): PendingFrame {
    if (!this.pending) {
      throw new Error("SSSR requires a prepared frame transaction");
    }
    return this.pending;
  }
}

function uniform(binding: number): GPUBindGroupLayoutEntry {
  return { binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } };
}
function storage(binding: number, writable: boolean): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type: writable ? "storage" : "read-only-storage" }
  };
}
function sampled(
  binding: number,
  sampleType: GPUTextureSampleType = "float",
  viewDimension: GPUTextureViewDimension = "2d"
): GPUBindGroupLayoutEntry {
  return { binding, visibility: GPUShaderStage.COMPUTE, texture: { sampleType, viewDimension } };
}
function output(
  binding: number,
  format: GPUTextureFormat,
  viewDimension: GPUTextureViewDimension = "2d"
): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.COMPUTE,
    storageTexture: { format, viewDimension, access: "write-only" }
  };
}
function filteringSampler(binding: number): GPUBindGroupLayoutEntry {
  return { binding, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } };
}
