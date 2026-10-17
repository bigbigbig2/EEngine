import { PipelineCompilationQueue } from "../../gpu/PipelineCompilationQueue.js";
import type { ScgiAllocationPlan } from "./ScgiCapacity.js";
import { scgiInteger } from "./ScgiCapacity.js";
import type { ScgiFrameTransaction } from "./ScgiRuntime.js";
import { scgiFilterWgsl } from "../../shaders/scgi_filter.js";

export interface ScgiFilterSettings {
  readonly frame: number;
  readonly geometryEpoch: number;
  /** Explicit algorithm/representation revision. Spatial/post/radius changes
   * are additionally detected from submitted configuration, never on abort. */
  readonly filterEpoch: number;
  readonly spatial: boolean;
  readonly post: boolean;
  readonly spatialTaps: number;
  readonly lookupTaps: number;
  readonly spatialRadius: number;
  readonly lookupRadius: number;
  readonly normalCosine: number;
  readonly planeDistanceScale: number;
  readonly shortHysteresis: number;
  readonly longHysteresis: number;
  readonly postHysteresis: number;
  readonly driftScale: number;
  readonly maximumCount: number;
  readonly maximumAge: number;
  readonly invalidDecay: number;
  readonly revisionDecay: number;
}

const ENTRIES = ["qualify", "integrate", "spatial", "post", "publish", "lookup", "touch"] as const;

/** Borrowed bank/scratch/anchor/field ownership; no persistent GPU allocations,
 * no submit and no readback. The real raw producer must precede this owner.
 * Configuration and filter reset serial advance only with the frame submit. */
export class ScgiFilter {
  private readonly encoded = new WeakSet<ScgiFrameTransaction>();
  private committedConfiguration = "";
  private committedSerial = 0;

  private constructor(
    private readonly device: GPUDevice,
    readonly plan: ScgiAllocationPlan,
    private readonly layout: GPUBindGroupLayout,
    private readonly pipelines: Readonly<Record<(typeof ENTRIES)[number], GPUComputePipeline>>
  ) {}

  static async create(device: GPUDevice, plan: ScgiAllocationPlan): Promise<ScgiFilter> {
    if (
      device.limits.maxStorageBuffersPerShaderStage < 5 ||
      device.limits.maxUniformBuffersPerShaderStage < 1 ||
      device.limits.maxUniformBufferBindingSize < 96 ||
      device.limits.maxComputeInvocationsPerWorkgroup < 64 ||
      device.limits.maxComputeWorkgroupSizeX < 64 ||
      Math.ceil(Math.max(plan.profile.patches, Math.min(plan.halfPixels, plan.pixelsPerSegment)) / 64) >
        device.limits.maxComputeWorkgroupsPerDimension
    ) {
      throw new RangeError("SCGI filter exceeds admitted binding/work domain");
    }
    const layout = device.createBindGroupLayout({
      label: "SCGI/filter owners",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
      ]
    });
    const module = device.createShaderModule({
      label: "SCGI/A0 A1 A2 and directional field",
      code: scgiFilterWgsl(plan)
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const queue = PipelineCompilationQueue.forDevice(device);
    const pipelines = {} as Record<(typeof ENTRIES)[number], GPUComputePipeline>;
    for (const entryPoint of ENTRIES) {
      pipelines[entryPoint] = await queue.run(() =>
        device.createComputePipelineAsync({
          label: `SCGI/filter/${entryPoint}`,
          layout: pipelineLayout,
          compute: { module, entryPoint }
        })
      );
    }
    return new ScgiFilter(device, plan, layout, pipelines);
  }

  get cost() {
    const p = this.plan.profile;
    return Object.freeze({
      privateBytes: 0,
      borrowedControlBytes: 64 + p.patches * 4,
      borrowedValidityBytes: p.patches * 4,
      a1Bytes: p.patches * 48,
      persistentA0A2BytesPerBank: p.patches * 96,
      fieldHistoryBytes: this.plan.screenHistoryBytes,
      baseDispatches: 6,
      lookupDispatches: this.plan.screen.length,
      access:
        "A0/stats sequential, A1 and field bounded map gathers, A2 sequential; no output-resolution allocation"
    });
  }

  estimateCost(settings: ScgiFilterSettings) {
    return {
      ...this.cost,
      maximumSpatialLookups: settings.spatial ? this.plan.profile.patches * settings.spatialTaps : 0,
      maximumFieldLookups: this.plan.halfPixels * (settings.lookupTaps + 1),
      maximumMapProbes:
        (this.plan.profile.patches * (settings.spatial ? settings.spatialTaps * 2 + 1 : 0) +
          this.plan.halfPixels * (2 * settings.lookupTaps + 3)) *
        this.plan.profile.cascades
    };
  }

  encode(transaction: ScgiFrameTransaction, settings: ScgiFilterSettings): void {
    if (
      transaction.state !== "encoded" ||
      transaction.command.device !== this.device ||
      transaction.workset.plan !== this.plan ||
      !transaction.publication.estimateComplete ||
      !transaction.publication.cacheComplete ||
      this.encoded.has(transaction)
    ) {
      throw new Error("SCGI filter requires one complete raw/cache publication exactly once");
    }
    for (const key of ["frame", "geometryEpoch", "filterEpoch", "maximumAge"] as const) {
      scgiInteger(settings[key], `filter ${key}`);
    }
    scgiInteger(settings.maximumCount, "filter maximum count", 1, 0x00ffffff);
    for (const key of ["spatialTaps", "lookupTaps"] as const) {
      scgiInteger(settings[key], `filter ${key}`, 0, 4096);
    }
    for (const key of [
      "shortHysteresis",
      "longHysteresis",
      "postHysteresis",
      "invalidDecay",
      "revisionDecay"
    ] as const) {
      if (!Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] >= 1) {
        throw new RangeError(`Invalid SCGI ${key}`);
      }
    }
    for (const key of ["spatialRadius", "lookupRadius", "planeDistanceScale", "driftScale"] as const) {
      if (!Number.isFinite(Math.fround(settings[key])) || settings[key] <= 0) {
        throw new RangeError(`Invalid SCGI ${key}`);
      }
    }
    if (!Number.isFinite(settings.normalCosine) || settings.normalCosine < -1 || settings.normalCosine > 1) {
      throw new RangeError("Invalid SCGI normal cosine");
    }
    const configuration = JSON.stringify([
      settings.filterEpoch,
      settings.spatial,
      settings.post,
      settings.spatialRadius,
      settings.spatialTaps,
      settings.normalCosine,
      settings.planeDistanceScale
    ]);
    const changed = configuration !== this.committedConfiguration;
    const serial = this.committedSerial + Number(changed);
    scgiInteger(serial, "filter configuration serial");
    const { command, publication } = transaction;
    this.encoded.add(transaction);
    command.observeSubmission({
      submitted: () => {
        this.committedConfiguration = configuration;
        this.committedSerial = serial;
      },
      aborted: () => {},
      failed: () => {}
    });
    const world = publication.candidateWorld.buffer;
    const scratch = publication.privateScratch.buffer;
    const range = this.plan.scratch.ranges.filterControl!;
    command.clearBuffer(scratch, range.offset, range.bytes);
    // Storage control has a separate aligned binding, never aliases the bound
    // scratch read/write range in a dispatch. Bind scratch only before control.
    const dispatch = (entry: (typeof ENTRIES)[number], segment: number, count: number) => {
      const data = new ArrayBuffer(96),
        u = new Uint32Array(data),
        f = new Float32Array(data);
      u.set([
        settings.frame,
        Number(settings.spatial),
        Number(settings.post),
        serial,
        settings.spatialTaps,
        settings.lookupTaps,
        settings.maximumCount,
        settings.maximumAge
      ]);
      f.set(
        [
          settings.shortHysteresis,
          settings.longHysteresis,
          settings.postHysteresis,
          settings.driftScale,
          settings.spatialRadius,
          settings.lookupRadius,
          settings.normalCosine,
          settings.planeDistanceScale,
          settings.invalidDecay,
          settings.revisionDecay,
          0
        ],
        8
      );
      u[19] = Number(publication.activeWorld !== null);
      u[20] = settings.geometryEpoch;
      // An owner recreated against retained world banks must reset A2 even if
      // its local serial happens to equal the old owner's serial.
      u[21] = Number(changed);
      u[22] = segment * this.plan.pixelsPerSegment;
      u[23] = count;
      const uniform = command.allocateTransientBufferAndLoad(data);
      const anchor = publication.anchors[segment]!;
      const field = publication.candidateWorldField.segments[segment]!;
      const bindings = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: world } },
          { binding: 1, resource: { buffer: scratch, offset: 0, size: range.offset } },
          { binding: 2, resource: { buffer: uniform, size: 96 } },
          { binding: 3, resource: { buffer: scratch, offset: range.offset, size: range.bytes } },
          { binding: 4, resource: { buffer: anchor.buffer } },
          { binding: 5, resource: { buffer: field.buffer } }
        ]
      });
      const pass = command.beginComputePass({ label: `SCGI/filter/${entry}` });
      pass.setPipeline(this.pipelines[entry]);
      pass.setBindGroup(0, bindings);
      pass.dispatchWorkgroups(entry === "publish" ? 1 : Math.ceil(count / 64));
      pass.end();
    };
    dispatch("qualify", 0, this.plan.profile.patches);
    dispatch("integrate", 0, this.plan.profile.updates);
    dispatch("spatial", 0, this.plan.profile.patches);
    dispatch("post", 0, this.plan.profile.patches);
    dispatch("publish", 0, 1);
    for (let segment = 0; segment < publication.anchors.length; segment++) {
      dispatch("lookup", segment, publication.anchors[segment]!.plan.ranges.anchors!.count);
    }
    dispatch("touch", 0, this.plan.profile.patches);
    publication.filteredComplete = true;
    // Scale is carried by each GPU field's flags and header58; CPU metadata
    // stays1 and must never be used in place of scgi_field_scale.
    transaction.markFieldComplete(1);
  }
}
