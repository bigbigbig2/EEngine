import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GPULightCollection } from "../../gpu/LightDatabase.js";
import { PipelineCompilationQueue } from "../../gpu/PipelineCompilationQueue.js";
import type { PhysicalEnvironmentRuntime } from "../environment/PhysicalEnvironmentRuntime.js";
import type { ScgiFrameTransaction } from "./ScgiRuntime.js";
import type { ScgiAllocationPlan } from "./ScgiCapacity.js";
import { scgiInteger } from "./ScgiCapacity.js";
import { planScgiEstimator, SCGI_ESTIMATOR, type ScgiEstimatorProfile } from "./ScgiEstimatorLayout.js";
import { ScgiQueryBatch } from "./ScgiQueryBatch.js";
import type { ScgiQueryScene } from "./ScgiQueryScene.js";
import { scgiEstimatorWgsl } from "../../shaders/scgi_estimator.js";

const ENTRIES = [
  "publish_lights",
  "light_distribution",
  "begin_cohorts",
  "window_count",
  "pool_rays",
  "pool_hits",
  "hemisphere_rays",
  "hemisphere_hits",
  "shadow_rays",
  "shadow_hits",
  "connection_rays",
  "connection_hits",
  "finish_cohorts",
  "finish_epochs"
] as const;
type Entry = (typeof ENTRIES)[number];

export interface ScgiEstimatorInput {
  readonly scene: ScgiQueryScene;
  readonly lights: GPULightCollection;
  readonly physical: PhysicalEnvironmentRuntime | null;
  readonly environment: "black" | "physical-scattered-sky" | "authored-preserve-asset";
  /** Authored assets containing a sun disk remain intact; the composition is
   * explicit so a directional plus an asset disk can be diagnosed as authored. */
  readonly authoredSolarDisk: "absent" | "embedded";
  readonly view: ArrayLike<number>;
  readonly camera: ArrayLike<number>;
  readonly coneWidth: number;
  readonly coneSpread: number;
  /** Finite values require the query domain's coverage certificate; Infinity
   * is valid only with complete-world coverage, otherwise cohorts fail unknown. */
  readonly rayDistance: number;
  readonly environmentScale: number;
  readonly environmentEpoch: number;
  readonly lightingEpoch: number;
  readonly multiBounce: boolean;
  readonly powerSampling: boolean;
  readonly normalCosine: number;
  readonly planeDistanceScale: number;
}

/** Prepared finite estimator over the existing immutable query publication.
 * One owner per captured scene and physical light/environment resources;
 * compatible numeric publications refresh in place. No private queue,
 * scene, material evaluator, geometry payload or same-frame readback exists.
 * All scratch/query resources retire at the last consumer fence. */
export class ScgiEstimator {
  readonly arena;
  readonly buffer: GPUBuffer;
  private readonly batch: GPUBuffer;
  private readonly hits: GPUBuffer;
  private readonly indirect: GPUBuffer;
  private readonly defaults: GPUBuffer;
  private readonly black: GPUTexture;
  private readonly sampler: GPUSampler;
  private readonly layout: GPUBindGroupLayout;
  private readonly pipelines = {} as Record<Entry, GPUComputePipeline>;
  private closest!: ScgiQueryBatch;
  private shadow!: ScgiQueryBatch;
  private lightRevision: number;
  private lightSourceRevision: number;
  private readonly lightBuffer: GPUBuffer;
  private environmentRevision: number;
  private physicalGeneration: number;
  private readonly materialRevision: number;
  private readonly environmentView: GPUTextureView;
  private readonly transmittanceView: GPUTextureView;
  private readonly physicalParameters: GPUBuffer;
  private pointPages: number;
  private spotPages: number;
  private directionalSlots: number;
  private inFlight = 0;
  private destroyed = false;
  private poisoned = false;
  private readonly encoded = new WeakSet<ScgiFrameTransaction>();

  private constructor(
    private readonly device: GPUDevice,
    readonly plan: ScgiAllocationPlan,
    readonly profile: ScgiEstimatorProfile,
    public input: ScgiEstimatorInput
  ) {
    this.arena = planScgiEstimator(device.limits, profile, plan.profile.updates);
    if (
      device.limits.maxStorageBuffersPerShaderStage < 10 ||
      device.limits.maxSampledTexturesPerShaderStage < 2 ||
      device.limits.maxUniformBuffersPerShaderStage < 2 ||
      device.limits.maxUniformBufferBindingSize < SCGI_ESTIMATOR.settingsBytes ||
      device.limits.maxSamplersPerShaderStage < 1 ||
      device.limits.maxBindingsPerBindGroup < 15 ||
      Math.ceil(
        Math.max(
          plan.profile.updates,
          profile.batchRays,
          input.lights.pointLights.dispatch_page_count,
          input.lights.spotLights.dispatch_page_count
        ) / 64
      ) > device.limits.maxComputeWorkgroupsPerDimension ||
      profile.batchRays * 96 >
        Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize)
    ) {
      throw new RangeError("SCGI estimator exceeds negotiated bindings or finite work capacity");
    }
    const allocated: GPUBuffer[] = [];
    let black: GPUTexture | undefined;
    const allocate = (label: string, size: number, usage = 0) => {
      const buffer = device.createBuffer({
        label: `SCGI/estimator/${label}`,
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | usage
      });
      allocated.push(buffer);
      return buffer;
    };
    try {
      this.buffer = allocate("pool/path/cohorts", this.arena.bytes);
      this.batch = allocate("finite rays/results", profile.batchRays * 80);
      this.hits = allocate("native hit geometry", profile.batchRays * 96);
      this.indirect = allocate("window dispatch", 12, GPUBufferUsage.INDIRECT);
      this.defaults = allocate("disabled atmosphere", 64, GPUBufferUsage.UNIFORM);
      this.black = black = device.createTexture({
        label: "SCGI/disabled environment binding",
        size: [1, 1],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING
      });
      this.sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
      const disabledView = this.black.createView();
      this.environmentView =
        input.environment === "physical-scattered-sky"
          ? input.physical!.ibl.views.specular
          : input.environment === "authored-preserve-asset"
            ? input.lights.authoredIbl.views.specular
            : disabledView;
      this.transmittanceView = input.physical?.luts.views.transmittance ?? disabledView;
      this.physicalParameters = input.physical?.parameters ?? this.defaults;
      this.lightRevision = input.lights.publicationRevision;
      this.lightSourceRevision = input.lights.source.version;
      this.lightBuffer = input.lights.buffer_data;
      this.environmentRevision = input.lights.authoredIbl.publicationRevision;
      this.physicalGeneration = input.physical?.queryGeneration ?? 0;
      this.materialRevision = input.scene.materials.source.revision;
      this.pointPages = input.lights.pointLights.dispatch_page_count;
      this.spotPages = input.lights.spotLights.dispatch_page_count;
      // GPULightCollection.build publishes dense class tables, never a screen
      // light subset. Snapshot counts change together with its revision.
      this.directionalSlots = input.lights.directionalLights.count;
      this.layout = device.createBindGroupLayout({
        label: "SCGI/estimator actual owners",
        entries: [
          ...Array.from(
            { length: 10 },
            (_, binding): GPUBindGroupLayoutEntry => ({
              binding,
              visibility: GPUShaderStage.COMPUTE,
              buffer: { type: [0, 1, 3, 4].includes(binding) ? "storage" : "read-only-storage" }
            })
          ),
          { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
          { binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
          { binding: 12, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
          { binding: 13, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
          { binding: 14, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } }
        ]
      });
    } catch (error) {
      for (const buffer of allocated) {
        buffer.destroy();
      }
      black?.destroy();
      throw error;
    }
    void device.lost.then(() => this.destroyResources(true));
  }

  static async create(
    device: GPUDevice,
    plan: ScgiAllocationPlan,
    profile: ScgiEstimatorProfile,
    input: ScgiEstimatorInput
  ): Promise<ScgiEstimator> {
    scgiInteger(input.lightingEpoch, "estimator lighting epoch");
    scgiInteger(input.environmentEpoch, "estimator environment epoch");
    if (
      !(input.rayDistance > 0) ||
      Number.isNaN(input.rayDistance) ||
      !Number.isFinite(Math.fround(input.environmentScale)) ||
      input.environmentScale < 0 ||
      !Number.isFinite(input.normalCosine) ||
      input.normalCosine < -1 ||
      input.normalCosine > 1 ||
      !Number.isFinite(input.planeDistanceScale) ||
      input.planeDistanceScale <= 0 ||
      (input.environment === "physical-scattered-sky" && input.physical === null) ||
      (input.physical !== null && input.physical.queryGeneration === 0)
    ) {
      throw new RangeError("SCGI estimator requires coherent environment, epochs and geometry settings");
    }
    const owner = new ScgiEstimator(
      device,
      plan,
      Object.freeze({ ...profile }),
      Object.freeze({
        ...input,
        view: Object.freeze(Array.from(input.view)),
        camera: Object.freeze(Array.from(input.camera))
      })
    );
    try {
      const module = device.createShaderModule({
        label: "SCGI/full irradiance estimator",
        code: scgiEstimatorWgsl(plan, owner.arena, profile)
      });
      const layout = device.createPipelineLayout({ bindGroupLayouts: [owner.layout] });
      for (const entryPoint of ENTRIES) {
        owner.pipelines[entryPoint] = await PipelineCompilationQueue.forDevice(device).run(() =>
          device.createComputePipelineAsync({
            label: `SCGI/estimator/${entryPoint}`,
            layout,
            compute: { module, entryPoint }
          })
        );
      }
      const query = {
        batch: owner.batch,
        rayCount: profile.batchRays,
        resultByteOffset: profile.batchRays * 48,
        output: owner.hits,
        outputStride: SCGI_ESTIMATOR.hitStride,
        view: owner.input.view,
        camera: owner.input.camera,
        coneWidth: input.coneWidth,
        coneSpread: input.coneSpread,
        wavefrontRounds: 0,
        count: { buffer: owner.buffer, byteOffset: 6 * 4 }
      };
      owner.closest = await ScgiQueryBatch.create(device, input.scene, query);
      owner.shadow = await ScgiQueryBatch.create(device, input.scene, { ...query, anyHit: true });
      if (owner.destroyed) {
        throw new Error("SCGI estimator device lost during preparation");
      }
      return owner;
    } catch (error) {
      owner.destroyResources();
      throw error;
    }
  }

  /** Refresh finite lighting facts without rebuilding traversal or pipelines.
   * Resource replacement still selects a new owner before encoding. */
  refresh(input: ScgiEstimatorInput): boolean {
    if (
      this.destroyed ||
      this.poisoned ||
      input.scene !== this.input.scene ||
      input.environment !== this.input.environment ||
      input.physical !== this.input.physical ||
      input.lights.buffer_data !== this.lightBuffer ||
      (input.environment === "physical-scattered-sky" &&
        input.physical!.ibl.views.specular !== this.environmentView) ||
      (input.environment === "authored-preserve-asset" &&
        input.lights.authoredIbl.views.specular !== this.environmentView) ||
      (input.physical !== null && input.physical.luts.views.transmittance !== this.transmittanceView)
    ) {
      return false;
    }
    const pointPages = input.lights.pointLights.dispatch_page_count;
    const spotPages = input.lights.spotLights.dispatch_page_count;
    if (
      Math.ceil(Math.max(pointPages, spotPages) / 64) > this.device.limits.maxComputeWorkgroupsPerDimension
    ) {
      throw new RangeError("SCGI lighting publication exceeds negotiated dispatch capacity");
    }
    this.input = Object.freeze({ ...input });
    this.pointPages = pointPages;
    this.spotPages = spotPages;
    this.directionalSlots = input.lights.directionalLights.count;
    this.lightRevision = input.lights.publicationRevision;
    this.lightSourceRevision = input.lights.source.version;
    this.environmentRevision = input.lights.authoredIbl.publicationRevision;
    this.physicalGeneration = input.physical?.queryGeneration ?? 0;
    return true;
  }

  get cost() {
    const p = this.profile;
    const updates = this.plan.profile.updates;
    const hemisphere = updates * p.hemisphereSamples;
    const shadows = hemisphere * (this.directionalSlots + Number(this.input.physical !== null));
    const reconnect = updates * p.connectionSamples;
    const windows = Math.ceil(updates / p.batchRays);
    const poolWindows = Math.ceil(p.lightSamples / p.batchRays);
    const directionalCount = this.directionalSlots + Number(this.input.physical !== null);
    const queryCalls = poolWindows + windows * (p.hemisphereSamples + p.connectionSamples);
    const shadowCalls = windows * p.hemisphereSamples * directionalCount;
    const localDispatches =
      5 +
      poolWindows * 3 +
      windows * (1 + p.hemisphereSamples * (2 + 2 * directionalCount) + p.connectionSamples * 2);
    const uniformAlignment = this.device.limits.minUniformBufferOffsetAlignment;
    return Object.freeze({
      privateBytes:
        this.buffer.size +
        this.batch.size +
        this.hits.size +
        this.indirect.size +
        this.defaults.size +
        8 +
        this.closest.cost.privateBytes +
        this.shadow.cost.privateBytes,
      poolBytes: this.arena.ranges.pool!.bytes,
      maximumLightOriginRays: p.lightSamples,
      maximumHemisphereRays: hemisphere,
      maximumShadowRays: shadows,
      maximumReconnectRays: reconnect,
      maximumCacheLookups: this.input.multiBounce ? hemisphere : 0,
      queryBatchRays: p.batchRays,
      maximumEncodedDispatches:
        localDispatches +
        queryCalls * this.closest.cost.totalDispatches +
        shadowCalls * this.shadow.cost.totalDispatches,
      parameterBytesPerEncode:
        localDispatches * Math.ceil(SCGI_ESTIMATOR.settingsBytes / uniformAlignment) * uniformAlignment,
      query: this.closest.cost,
      shadowQuery: this.shadow.cost,
      ideal: "environment misses: no directional shadows/cache reads; fixed no-hit pool slots retained",
      normal: "opaque hits: hemisphere + active directional visibility + fixed reconnect count",
      worst: "all hits/all directionals/all reconnects plus complete bounded alpha traversal per query"
    });
  }

  private assertCurrent(command: ShadeGPUCommandContext): void {
    const input = this.input;
    if (
      this.destroyed ||
      this.poisoned ||
      command.device !== this.device ||
      command.closed ||
      input.lights.publicationRevision !== this.lightRevision ||
      input.lights.source.version !== this.lightSourceRevision ||
      input.lights.buffer_data !== this.lightBuffer ||
      input.lights.authoredIbl.publicationRevision !== this.environmentRevision ||
      (input.physical?.queryGeneration ?? 0) !== this.physicalGeneration ||
      input.scene.materials.source.revision !== this.materialRevision
    ) {
      throw new Error("SCGI estimator publication changed; abort and prepare a coherent cohort");
    }
    input.scene.sourceInstances.assertCurrent(command);
    if (
      (input.environment === "physical-scattered-sky" &&
        input.physical!.ibl.views.specular !== this.environmentView) ||
      (input.environment === "authored-preserve-asset" &&
        input.lights.authoredIbl.views.specular !== this.environmentView) ||
      (input.physical !== null && input.physical.luts.views.transmittance !== this.transmittanceView)
    ) {
      throw new Error("SCGI estimator environment resource changed after capture");
    }
    if (!input.scene.materials.source.isCurrent(command)) {
      throw new Error("SCGI estimator material publication is stale");
    }
  }

  encode(
    transaction: ScgiFrameTransaction,
    view?: {
      readonly view: ArrayLike<number>;
      readonly camera: ArrayLike<number>;
      readonly coneWidth: number;
      readonly coneSpread: number;
    }
  ): void {
    const { command, publication } = transaction;
    this.assertCurrent(command);
    if (view !== undefined) {
      this.closest.updateView(command, view.view, view.camera, view.coneWidth, view.coneSpread);
      this.shadow.updateView(command, view.view, view.camera, view.coneWidth, view.coneSpread);
    }
    if (
      publication.deviceEpoch !== this.input.scene.profile.deviceEpoch ||
      transaction.state !== "encoded" ||
      !publication.cacheComplete ||
      transaction.workset.plan !== this.plan ||
      this.encoded.has(transaction)
    ) {
      throw new Error("SCGI estimator requires its complete selected cache transaction exactly once");
    }
    this.encoded.add(transaction);
    this.inFlight++;
    command.onBeforeFinish.addOne(() => this.assertCurrent(command));
    command.observeSubmission({
      submitted: (fence) => {
        void fence.then(
          () => {
            this.inFlight--;
          },
          () => {
            this.poisoned = true;
          }
        );
      },
      aborted: () => {
        this.inFlight--;
      },
      failed: () => {
        this.poisoned = true;
      }
    });
    command.clearBuffer(this.buffer);
    const raw = this.plan.scratch.ranges.raw!;
    command.clearBuffer(publication.privateScratch.buffer, raw.offset, raw.bytes);
    // Each stage has immutable encoder-ordered parameters. No queue.writeBuffer
    // can overwrite constants of earlier windows in this same submission.
    const dispatch = (
      entry: Entry,
      window = 0,
      sample = 0,
      directional = 0,
      stage = 1,
      count = this.profile.batchRays,
      indirect = true
    ): void => {
      const data = new ArrayBuffer(SCGI_ESTIMATOR.settingsBytes);
      const u = new Uint32Array(data),
        f = new Float32Array(data);
      u.set([
        window,
        sample,
        directional,
        stage,
        this.profile.hemisphereSamples,
        this.profile.connectionSamples,
        Number(this.input.multiBounce),
        Number(publication.activeWorld !== null),
        this.pointPages,
        this.spotPages,
        Number(this.input.powerSampling),
        Number(this.input.physical !== null),
        Number(this.input.environment !== "black"),
        Number(this.closest.viewDependent),
        publication.viewEpoch,
        this.input.scene.virtualTextures?.mappingGeneration(command) ?? 0,
        this.input.lightingEpoch,
        this.materialRevision,
        this.input.environmentEpoch,
        publication.generation
      ]);
      f.set(
        [
          this.input.rayDistance,
          this.input.environmentScale,
          this.input.normalCosine,
          this.input.planeDistanceScale
        ],
        20
      );
      u[24] = publication.sampleSerial;
      const settings = command.allocateTransientBufferAndLoad(data);
      const buffers = [
        publication.candidateWorld.buffer,
        publication.privateScratch.buffer,
        publication.activeWorld?.buffer ?? this.defaults,
        this.buffer,
        this.batch,
        this.hits,
        this.lightBuffer,
        this.input.scene.sourceInstances.sourceSnapshot,
        this.input.scene.sourceInstances.identitySnapshot,
        this.input.scene.materialPublication.data
      ];
      const group = this.device.createBindGroup({
        label: `SCGI/estimator/${entry}`,
        layout: this.layout,
        entries: [
          ...buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
          { binding: 10, resource: { buffer: settings, size: SCGI_ESTIMATOR.settingsBytes } },
          { binding: 11, resource: { buffer: this.physicalParameters, size: 64 } },
          { binding: 12, resource: this.environmentView },
          { binding: 13, resource: this.transmittanceView },
          { binding: 14, resource: this.sampler }
        ]
      });
      const pass = command.beginComputePass({ label: `SCGI/estimator/${entry}` });
      pass.setPipeline(this.pipelines[entry]);
      pass.setBindGroup(0, group);
      if (indirect) {
        pass.dispatchWorkgroupsIndirect(this.indirect, 0);
      } else {
        pass.dispatchWorkgroups(
          Math.ceil(
            count /
              (entry === "window_count" || entry === "light_distribution" || entry === "finish_epochs"
                ? 1
                : 64)
          )
        );
      }
      pass.end();
    };
    dispatch("publish_lights", 0, 0, 0, 1, Math.max(1, this.pointPages, this.spotPages), false);
    dispatch("light_distribution", 0, 0, 0, 1, 1, false);
    dispatch("begin_cohorts", 0, 0, 0, 1, this.plan.profile.updates, false);
    const windows = (total: number, stage: number, body: (window: number) => void) => {
      for (let window = 0; window < total; window += this.profile.batchRays) {
        dispatch("window_count", window, 0, 0, stage, 1, false);
        command.copyBufferToBuffer(this.buffer, 18 * 4, this.indirect, 0, 12);
        body(window);
      }
    };
    windows(this.profile.lightSamples, 0, (window) => {
      dispatch("pool_rays", window, 0, 0, 0);
      this.closest.encode(command);
      dispatch("pool_hits", window, 0, 0, 0);
    });
    windows(this.plan.profile.updates, 1, (window) => {
      for (let sample = 0; sample < this.profile.hemisphereSamples; sample++) {
        dispatch("hemisphere_rays", window, sample);
        this.closest.encode(command);
        dispatch("hemisphere_hits", window, sample);
        for (
          let directional = this.input.physical === null ? 1 : 0;
          directional <= this.directionalSlots;
          directional++
        ) {
          dispatch("shadow_rays", window, sample, directional);
          this.shadow.encode(command);
          dispatch("shadow_hits", window, sample, directional);
        }
      }
      for (let sample = 0; sample < this.profile.connectionSamples; sample++) {
        dispatch("connection_rays", window, sample);
        this.closest.encode(command);
        dispatch("connection_hits", window, sample);
      }
    });
    dispatch("finish_cohorts", 0, 0, 0, 1, this.plan.profile.updates, false);
    dispatch("finish_epochs", 0, 0, 0, 1, 1, false);
    publication.estimateComplete = true;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    if (this.inFlight !== 0 || this.poisoned) {
      throw new Error("SCGI estimator retained by a consumer fence or poisoned submission");
    }
    this.destroyResources();
  }

  /** A failed submitted publication stays quarantined until device loss. */
  retire(completion: Promise<void>): void {
    void completion.then(
      () => {
        if (!this.poisoned) {
          this.destroy();
        }
      },
      () => {
        this.poisoned = true;
      }
    );
  }

  private destroyResources(deviceLost = false): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    if (!deviceLost) {
      this.closest?.destroy();
      this.shadow?.destroy();
    }
    for (const buffer of [this.buffer, this.batch, this.hits, this.indirect, this.defaults]) {
      buffer.destroy();
    }
    this.black.destroy();
  }
}
