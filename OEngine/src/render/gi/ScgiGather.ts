import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { PipelineCompilationQueue } from "../../gpu/PipelineCompilationQueue.js";
import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
import type { NativeSurfaceGeometry } from "../surface/SurfaceV4.js";
import type { ScgiAllocationPlan } from "./ScgiCapacity.js";
import type { ScgiFrameTransaction } from "./ScgiRuntime.js";
import type { ScgiEstimator } from "./ScgiEstimator.js";
import type { SurfaceCacheGiSettings } from "./SurfaceCacheGiSettings.js";
import type { GPUViewContext } from "../ViewContext.js";
import { ScgiQueryBatch } from "./ScgiQueryBatch.js";
import { ScgiQueryHitWork } from "./ScgiQueryHitWork.js";
import { planScgiGather } from "./ScgiGatherLayout.js";
import { scgiGatherWgsl } from "../../shaders/scgi_gather.js";
import { scgiGatherSourceWgsl, scgiGatherClassifyWgsl } from "../../shaders/scgi_gather_source.js";

const ENTRIES = [
  "reproject",
  "spawn",
  "source_begin",
  "source_rays",
  "source_shadow",
  "source_finish",
  "probe_rays",
  "fill",
  "project",
  "interpolate"
] as const;
type Entry = (typeof ENTRIES)[number];

export interface ScgiGatherFrame {
  readonly owner: ScgiGather;
  readonly previous: GPUBuffer;
  readonly candidate: GPUBuffer;
  readonly residual: readonly GPUBuffer[];
  readonly previousResidual: readonly GPUBuffer[];
  readonly candidateResidual: readonly GPUBuffer[];
  readonly previousValid: boolean;
  readonly source: GPUTexture;
  readonly transaction: ScgiFrameTransaction;
  readonly view: GPUViewContext;
  readonly settings: SurfaceCacheGiSettings;
  readonly camera: readonly [number, number, number];
}

/** Optional screen signal inside SCGI. Only successful submission advances its
 * probe role; world histories/seed/cache are strictly borrowed read-only.
 * Every source pixel is evaluated, while query scratch is a bounded reusable batch. */
export class ScgiGather {
  readonly plan;
  readonly residual: GPUBuffer[] = [];
  readonly source: GPUTexture;
  private readonly history: readonly [GPUBuffer, GPUBuffer];
  private readonly residualHistory: readonly [GPUBuffer[], GPUBuffer[]];
  private readonly buffers: GPUBuffer[] = [];
  private readonly textures: GPUTexture[] = [];
  private readonly handles: ResourceHandle[] = [];
  private readonly pipelines = {} as Record<Entry, GPUComputePipeline>;
  private readonly sourcePipelines: GPUComputePipeline[] = [];
  private readonly sourceLayouts: GPUBindGroupLayout[][] = [];
  private readonly layout: GPUBindGroupLayout;
  private readonly rays: GPUBuffer;
  private readonly sourceHits: GPUBuffer;
  private readonly queryHits: GPUBuffer;
  private readonly directionScratch: GPUBuffer;
  private readonly sourceState: GPUBuffer;
  private readonly count: GPUBuffer;
  private readonly defaults: GPUBuffer;
  private readonly black: GPUTexture;
  private readonly unusedOutput: GPUTexture;
  private readonly sampler: GPUSampler;
  private closest!: ScgiQueryBatch;
  private shadow!: ScgiQueryBatch;
  private sourceWork!: ScgiQueryHitWork;
  private deviceLost = false;
  private classify!: GPUComputePipeline;
  private debugPipeline!: GPUComputePipeline;
  private role = 0;
  private valid = false;
  private destroyed = false;
  private poisoned = false;
  private inFlight = 0;
  private retiring = false;
  private readonly prepared = new WeakSet<ShadeGPUCommandContext>();
  private readonly postEncoded = new WeakSet<ScgiFrameTransaction>();

  private constructor(
    private readonly device: GPUDevice,
    readonly allocation: ScgiAllocationPlan,
    readonly estimator: ScgiEstimator,
    settings: SurfaceCacheGiSettings,
    private readonly accounting?: ResourceAccounting
  ) {
    this.plan = planScgiGather(
      device.limits,
      allocation.profile.width,
      allocation.profile.height,
      settings.gatherTile,
      settings.gatherDirections,
      settings.gatherBatchRays
    );
    if (
      device.limits.maxStorageBuffersPerShaderStage < 15 ||
      Math.max(this.plan.halfWidth, this.plan.halfHeight) > device.limits.maxTextureDimension2D ||
      Math.ceil(
        Math.max(this.plan.batch, this.plan.probes, Math.min(allocation.halfPixels, allocation.pixelsPerSegment)) / 64
      ) > device.limits.maxComputeWorkgroupsPerDimension
    ) {
      throw new RangeError("SCGI gather exceeds negotiated storage/dispatch capacity");
    }
    const buffer = (label: string, size: number, usage = 0) => {
      const value = device.createBuffer({
        label: `SCGI/gather/${label}`,
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | usage
      });
      this.buffers.push(value);
      this.track(value, size, "buffer", label);
      return value;
    };
    try {
      this.history = [
        buffer("probe history A", this.plan.probeBytes),
        buffer("probe history B", this.plan.probeBytes)
      ];
      this.residualHistory = [[], []];
      for (const segment of allocation.screen) {
        this.residual.push(buffer("reprojected signed residual", segment.ranges.worldField!.count * 32));
        for (const role of this.residualHistory) {
          role.push(buffer("signed residual history", segment.ranges.worldField!.count * 32));
        }
      }
      this.rays = buffer("bounded rays and results", this.plan.batch * 80);
      this.sourceHits = buffer("bounded Native source", this.plan.batch * 96);
      this.queryHits = buffer("bounded query hit", this.plan.batch * 96);
      this.directionScratch = buffer("current directions", this.plan.directionBytes);
      this.sourceState = buffer("bounded source lighting", this.plan.batch * 16);
      this.count = buffer("query actual count", 4);
      this.defaults = buffer("disabled atmosphere", 64, GPUBufferUsage.UNIFORM);
      this.source = device.createTexture({
        label: "SCGI/gather/diffuse unexposed source",
        size: [this.plan.halfWidth, this.plan.halfHeight],
        format: "rgba32float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
      });
      this.textures.push(this.source);
      this.track(this.source, this.plan.sourceBytes, "texture", "diffuse source");
      this.black = device.createTexture({
        label: "SCGI/gather/disabled transmittance",
        size: [1, 1],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING
      });
      this.textures.push(this.black);
      this.track(this.black, 8, "texture", "disabled transmittance");
      this.unusedOutput = device.createTexture({
        label: "SCGI/gather/unused source output",
        size: [1, 1],
        format: "rgba32float",
        usage: GPUTextureUsage.STORAGE_BINDING
      });
      this.textures.push(this.unusedOutput);
      this.track(this.unusedOutput, 16, "texture", "unused source output");
      this.sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
      this.layout = device.createBindGroupLayout({
        label: "SCGI/gather owners",
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
          ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 17, 18, 19, 20].map(
            (binding): GPUBindGroupLayoutEntry => ({
              binding,
              visibility: GPUShaderStage.COMPUTE,
              buffer: { type: [3, 5, 6, 8, 11, 20].includes(binding) ? "storage" : "read-only-storage" }
            })
          ),
          { binding: 12, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
          {
            binding: 13,
            visibility: GPUShaderStage.COMPUTE,
            storageTexture: { format: "rgba32float", access: "write-only" }
          },
          { binding: 14, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
          { binding: 15, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
          { binding: 16, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } }
        ]
      });
      void device.lost.then(() => {
        this.deviceLost = true;
        this.destroyResources();
      });
    } catch (error) {
      for (const resource of [...this.buffers, ...this.textures]) {
        resource.destroy();
      }
      for (const handle of this.handles) {
        this.accounting!.destroyed(handle);
      }
      throw error;
    }
  }

  private track(
    resource: GPUBuffer | GPUTexture,
    bytes: number,
    kind: "buffer" | "texture",
    label: string
  ): void {
    if (this.accounting !== undefined) {
      this.handles.push(
        this.accounting.created({ kind, category: "transient", owner: "SCGI/gather", label, bytes }, resource)
      );
    }
  }

  static async create(
    device: GPUDevice,
    allocation: ScgiAllocationPlan,
    estimator: ScgiEstimator,
    settings: SurfaceCacheGiSettings,
    product: boolean,
    accounting?: ResourceAccounting
  ): Promise<ScgiGather> {
    const owner = new ScgiGather(device, allocation, estimator, settings, accounting);
    try {
      const queue = PipelineCompilationQueue.forDevice(device);
      const module = device.createShaderModule({
        label: "SCGI/gather",
        code: scgiGatherWgsl(owner.plan, estimator.arena.ranges.lights!.offset / 4)
      });
      const errors = (await module.getCompilationInfo()).messages.filter(
        (message) => message.type === "error"
      );
      if (errors.length !== 0) {
        throw new Error(
          `SCGI gather: ${errors.map((message) => `${message.lineNum}:${message.linePos} ${message.message}`).join("\n")}`
        );
      }
      const layout = device.createPipelineLayout({ bindGroupLayouts: [owner.layout] });
      owner.classify = await queue.run(() =>
        device.createComputePipelineAsync({
          label: "SCGI/source winner classification",
          layout: "auto",
          compute: {
            entryPoint: "main",
            module: device.createShaderModule({ code: scgiGatherClassifyWgsl(owner.plan.batch) })
          }
        })
      );
      owner.debugPipeline = await queue.run(() =>
        device.createComputePipelineAsync({
          label: "SCGI/source debug view",
          layout: "auto",
          compute: {
            entryPoint: "main",
            module: device.createShaderModule({
              code: /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var output: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> exposure: vec4f;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(output))) { return; }
  let value = textureLoad(source, vec2i(id.xy / 2u), 0);
  let working = mat3x3f(vec3f(0.6274039, 0.0690973, 0.0163914),
    vec3f(0.3292830, 0.9195404, 0.0880133), vec3f(0.0433131, 0.0113623, 0.8955953)) * value.xyz;
  textureStore(output, vec2i(id.xy), vec4f(working * exposure.x, 1.0));
}`
            })
          }
        })
      );
      for (const entryPoint of ENTRIES) {
        owner.pipelines[entryPoint] = await queue.run(() =>
          device.createComputePipelineAsync({
            label: `SCGI/gather/${entryPoint}`,
            layout,
            compute: { module, entryPoint }
          })
        );
      }
      owner.sourceWork = await ScgiQueryHitWork.create(
        device,
        estimator.input.scene.sourceInstances.sourceSnapshot,
        estimator.input.scene.materials.directory,
        owner.rays,
        owner.plan.batch,
        owner.plan.batch * 48,
        estimator.input.scene.materials.bins.length
      );
      for (const bin of estimator.input.scene.materials.bins) {
        const program = bin.material.binding.program;
        const entries: GPUBindGroupLayoutEntry[] = [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
          ...[1, 2, 3, 4, 6, 7, 8, 9].map(
            (binding): GPUBindGroupLayoutEntry => ({
              binding,
              visibility: GPUShaderStage.COMPUTE,
              buffer: { type: binding === 6 ? "storage" : "read-only-storage" }
            })
          ),
          { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } }
        ];
        const groups = [
          device.createBindGroupLayout({ entries }),
          device.createBindGroupLayout({
            entries: product
              ? [0, 1, 2, 3, 4].map((binding) => ({
                  binding,
                  visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: "read-only-storage" as const }
                }))
              : []
          }),
          device.createBindGroupLayout({
            entries: [
              { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
              ...(program.virtualTextures
                ? [{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" as const } }]
                : [])
            ]
          }),
          device.createBindGroupLayout({ entries: [...bin.material.binding.layoutEntries] })
        ];
        const sourceModule = device.createShaderModule({
          label: "SCGI/exact Native source",
          code: scgiGatherSourceWgsl(program, product, bin.material.unlit, owner.sourceWork.listWordOffset)
        });
        owner.sourcePipelines.push(
          await queue.run(() =>
            device.createComputePipelineAsync({
              label: "SCGI/exact Native diffuse projection",
              layout: device.createPipelineLayout({ bindGroupLayouts: groups }),
              compute: { module: sourceModule, entryPoint: "main" }
            })
          )
        );
        owner.sourceLayouts.push(groups);
      }
      const input = {
        batch: owner.rays,
        rayCount: owner.plan.batch,
        resultByteOffset: owner.plan.batch * 48,
        output: owner.queryHits,
        outputStride: 96 as const,
        view: estimator.input.view,
        camera: estimator.input.camera,
        coneWidth: 0,
        coneSpread: estimator.input.coneSpread,
        count: { buffer: owner.count, byteOffset: 0 }
      };
      owner.closest = await ScgiQueryBatch.create(device, estimator.input.scene, { ...input, kind: "geometry" });
      owner.shadow = await ScgiQueryBatch.create(device, estimator.input.scene, { ...input, anyHit: true });
      return owner;
    } catch (error) {
      owner.destroyResources();
      throw error;
    }
  }

  get cost() {
    const sourceBatches = this.allocation.screen.reduce(
      (count, segment) => count + Math.ceil(segment.ranges.worldField!.count / this.plan.batch),
      0
    );
    const probeBatches = Math.ceil(this.plan.probes / this.plan.probeBatch);
    const shadowPhases =
      1 +
      this.estimator.input.lights.directionalLights.count +
      Number(this.estimator.input.physical !== null);
    return {
      ownedBytes:
        this.buffers.reduce((sum, buffer) => sum + buffer.size, this.plan.sourceBytes + 24) +
        (this.sourceWork?.buffer.size ?? 0) +
        (this.sourceWork?.indirect.size ?? 0),
      queryPrivateBytes: (this.closest?.cost.privateBytes ?? 0) + (this.shadow?.cost.privateBytes ?? 0),
      sourcePixels: this.plan.halfWidth * this.plan.halfHeight,
      probeCount: this.plan.probes,
      probeRaysUpperBound: this.plan.raysPerFrame,
      sourceShadowRaysUpperBound:
        this.plan.halfWidth *
        this.plan.halfHeight *
        (1 +
          this.estimator.input.lights.directionalLights.count +
          Number(this.estimator.input.physical !== null)),
      historyBytes: this.plan.historyBytes + this.plan.halfWidth * this.plan.halfHeight * 64,
      reprojectedResidualBytes: this.plan.halfWidth * this.plan.halfHeight * 32,
      directionScratchBytes: this.plan.directionBytes,
      maximumEncodedDispatches:
        this.allocation.screen.length * 2 +
        this.allocation.screen.length ** 2 +
        sourceBatches *
          (3 +
            (this.sourceWork?.dispatchCount ?? 0) +
            this.sourcePipelines.length +
            shadowPhases * (2 + (this.shadow?.cost.totalDispatches ?? 0))) +
        probeBatches * (2 + this.allocation.screen.length + (this.closest?.cost.totalDispatches ?? 0)),
      sourceBatches,
      probeBatches,
      note: "Upper bound, not GPU time; routing and native-bin indirect slots included; debug view adds one dispatch"
    };
  }

  prepare(
    transaction: ScgiFrameTransaction,
    view: GPUViewContext,
    settings: SurfaceCacheGiSettings,
    camera: readonly [number, number, number],
    previousValid: boolean
  ): ScgiGatherFrame {
    const command = transaction.command;
    if (this.destroyed || this.poisoned || this.retiring || this.prepared.has(command)) {
      throw new Error("SCGI gather requires one live preparation per frame command");
    }
    this.prepared.add(command);
    const candidate = this.history[1 - this.role]!;
    const frame = {
      owner: this,
      previous: this.history[this.role]!,
      candidate,
      residual: this.residual,
      previousResidual: this.residualHistory[this.role]!,
      candidateResidual: this.residualHistory[1 - this.role]!,
      source: this.source,
      transaction,
      view,
      settings,
      camera,
      previousValid: previousValid && this.valid
    };
    this.inFlight++;
    command.observeSubmission({
      submitted: (fence) => {
        if (this.postEncoded.has(transaction)) {
          this.role = 1 - this.role;
          this.valid = true;
        }
        void fence.then(
          () => {
            this.inFlight--;
            // QueryBatch observers are registered during encoding, after this
            // role observer. Let their same-fence retain counts settle first.
            queueMicrotask(() => this.releaseRetired());
          },
          () => {
            this.poisoned = true;
          }
        );
      },
      aborted: () => {
        this.inFlight--;
        queueMicrotask(() => this.releaseRetired());
      },
      failed: () => {
        this.poisoned = true;
      }
    });
    return frame;
  }

  private parameters(
    frame: ScgiGatherFrame,
    segment: number,
    first = 0,
    count = 0,
    phase = 0,
    directional = 0,
    historySegment = segment
  ): GPUBuffer {
    const bytes = new ArrayBuffer(304);
    const u = new Uint32Array(bytes);
    const f = new Float32Array(bytes);
    const publication = frame.transaction.publication;
    const range = publication.anchors[segment]!.plan.ranges.anchors!;
    const segmentFirst = segment * this.allocation.pixelsPerSegment;
    u.set([...publication.extent, ...publication.halfExtent]);
    u.set([segmentFirst, range.count, first, count], 4);
    u.set([publication.sampleSerial, Number(frame.previousValid), phase, directional], 8);
    u.set(
      [
        this.estimator.profile.maximumLights,
        this.estimator.input.lights.directionalLights.count,
        Number(this.estimator.input.physical !== null),
        0
      ],
      12
    );
    f.set(frame.camera, 16);
    f.set(frame.view.camera.view_projection_matrix, 20);
    f.set(frame.view.gpu_previous_camera_state.camera.view_matrix, 36);
    f.set([frame.settings.gatherDistance, 0.9, 0.02, 0.1], 52);
    u.set(
      [
        historySegment * this.allocation.pixelsPerSegment,
        this.allocation.screen[historySegment]!.ranges.worldField!.count,
        0,
        0
      ],
      56
    );
    f.set(frame.view.gpu_previous_camera_state.view_projection_matrix_inverse, 60);
    return frame.transaction.command.allocateTransientBufferAndLoad(bytes);
  }

  private dispatch(
    frame: ScgiGatherFrame,
    entry: Entry,
    segment: number,
    count: number,
    first = 0,
    batchCount = 0,
    phase = 0,
    directional = 0,
    sourceStage = false,
    historySegment = segment
  ): void {
    const { command, publication } = frame.transaction;
    const parameters = this.parameters(frame, segment, first, batchCount, phase, directional, historySegment);
    const input = this.estimator.input;
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: parameters } },
      ...[
        [1, publication.anchors[segment]!.buffer],
        [2, publication.candidateWorldField.segments[segment]!.buffer],
        [3, frame.candidate],
        [4, frame.previous],
        [5, frame.residual[segment]!],
        [6, this.rays],
        [7, sourceStage ? this.sourceHits : this.queryHits],
        [8, this.directionScratch],
        [9, input.lights.buffer_data],
        [10, this.estimator.buffer],
        [11, this.sourceState],
        [17, input.scene.sourceInstances.identitySnapshot],
        [18, frame.previousResidual[historySegment]!],
        [
          19,
          publication.previousWorldField?.segments[historySegment]!.buffer ??
            publication.candidateWorldField.segments[historySegment]!.buffer
        ],
        [20, frame.candidateResidual[segment]!]
      ].map(([binding, buffer]) => ({
        binding: binding as number,
        resource: { buffer: buffer as GPUBuffer }
      })),
      { binding: 12, resource: entry === "fill" ? this.source.createView() : this.black.createView() },
      {
        binding: 13,
        resource: entry === "source_finish" ? this.source.createView() : this.unusedOutput.createView()
      },
      { binding: 14, resource: { buffer: input.physical?.parameters ?? this.defaults } },
      { binding: 15, resource: input.physical?.luts.views.transmittance ?? this.black.createView() },
      { binding: 16, resource: this.sampler }
    ];
    // Source read and write bindings share one texture in the layout, but only
    // source_finish statically uses storage, only fill statically uses sampled.
    const group = this.device.createBindGroup({ layout: this.layout, entries });
    const pass = command.beginComputePass({ label: `SCGI/gather/${entry}` });
    pass.setPipeline(this.pipelines[entry]);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
  }

  encodePrevious(frame: ScgiGatherFrame): void {
    for (let segment = 0; segment < frame.residual.length; segment++) {
      frame.transaction.command.clearBuffer(frame.residual[segment]!);
      for (let previous = 0; previous < frame.previousResidual.length; previous++) {
        this.dispatch(
          frame,
          "reproject",
          segment,
          this.allocation.screen[segment]!.ranges.worldField!.count,
          0,
          0,
          0,
          0,
          false,
          previous
        );
      }
    }
  }

  encode(frame: ScgiGatherFrame, geometry: NativeSurfaceGeometry, visibility: GPUTextureView): void {
    const { command, publication } = frame.transaction;
    if (this.postEncoded.has(frame.transaction) || !publication.filteredComplete) {
      throw new Error("SCGI gather requires one post-Surface encoding after world publication");
    }
    if (frame.settings.gatherFreeze && frame.previousValid) {
      command.copyBufferToBuffer(frame.previous, 0, frame.candidate, 0, this.plan.probeBytes);
      for (let segment = 0; segment < publication.anchors.length; segment++) {
        this.dispatch(
          frame,
          "interpolate",
          segment,
          publication.anchors[segment]!.plan.ranges.anchors!.count
        );
      }
      this.postEncoded.add(frame.transaction);
      return;
    }
    command.clearBuffer(frame.candidate);
    const view = frame.view.camera;
    this.closest.updateView(
      command,
      view.camera.view_matrix,
      frame.camera,
      0,
      this.estimator.input.coneSpread
    );
    this.shadow.updateView(
      command,
      view.camera.view_matrix,
      frame.camera,
      0,
      this.estimator.input.coneSpread
    );
    let first = 0;
    for (let segment = 0; segment < publication.anchors.length; segment++) {
      const count = publication.anchors[segment]!.plan.ranges.anchors!.count;
      this.dispatch(frame, "spawn", segment, this.plan.probes);
      for (let offset = 0; offset < count; offset += this.plan.batch) {
        const batchCount = Math.min(this.plan.batch, count - offset);
        command.clearBuffer(this.sourceHits);
        const parameters = this.parameters(frame, segment, first + offset, batchCount);
        const classify = command.beginComputePass({ label: "SCGI/source winner classification" });
        classify.setPipeline(this.classify);
        classify.setBindGroup(
          0,
          this.device.createBindGroup({
            layout: this.classify.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: parameters, size: 32 } },
              { binding: 1, resource: { buffer: geometry.meshletWork } },
              { binding: 2, resource: visibility },
              { binding: 3, resource: { buffer: publication.anchors[segment]!.buffer } },
              { binding: 4, resource: { buffer: this.rays } }
            ]
          })
        );
        classify.dispatchWorkgroups(Math.ceil(this.plan.batch / 64));
        classify.end();
        this.sourceWork.encode(command);
        this.projectSource(frame, geometry, visibility, segment, first + offset, batchCount);
        command.writeBuffer(this.count, 0, new Uint32Array([batchCount]).buffer, 0, 4);
        this.dispatch(frame, "source_begin", segment, batchCount, first + offset, batchCount, 0, 0, true);
        const phases =
          1 +
          Number(this.estimator.input.physical !== null) +
          this.estimator.input.lights.directionalLights.count;
        for (let phase = 0; phase < phases; phase++) {
          const kind = phase === 0 ? 0 : phase <= Number(this.estimator.input.physical !== null) ? 1 : 2;
          const directional = phase - 1 - Number(this.estimator.input.physical !== null);
          this.dispatch(
            frame,
            "source_rays",
            segment,
            batchCount,
            first + offset,
            batchCount,
            kind,
            Math.max(0, directional),
            true
          );
          this.shadow.encode(command);
          this.dispatch(
            frame,
            "source_shadow",
            segment,
            batchCount,
            first + offset,
            batchCount,
            kind,
            Math.max(0, directional),
            true
          );
        }
        this.dispatch(frame, "source_finish", segment, batchCount, first + offset, batchCount, 0, 0, true);
      }
      first += count;
    }
    for (let firstProbe = 0; firstProbe < this.plan.probes; firstProbe += this.plan.probeBatch) {
      const probeCount = Math.min(this.plan.probeBatch, this.plan.probes - firstProbe);
      const rays = probeCount * this.plan.directions;
      command.clearBuffer(this.directionScratch);
      command.writeBuffer(this.count, 0, new Uint32Array([rays]).buffer, 0, 4);
      this.dispatch(frame, "probe_rays", 0, rays, firstProbe, rays);
      this.closest.encode(command);
      for (let segment = 0; segment < publication.anchors.length; segment++) {
        this.dispatch(frame, "fill", segment, rays, firstProbe, rays);
      }
      this.dispatch(frame, "project", 0, probeCount, firstProbe, rays);
    }
    for (let segment = 0; segment < publication.anchors.length; segment++) {
      this.dispatch(frame, "interpolate", segment, publication.anchors[segment]!.plan.ranges.anchors!.count);
    }
    this.postEncoded.add(frame.transaction);
  }

  private projectSource(
    frame: ScgiGatherFrame,
    geometry: NativeSurfaceGeometry,
    visibility: GPUTextureView,
    segment: number,
    first: number,
    count: number
  ): void {
    const { command, publication } = frame.transaction;
    const materials = this.estimator.input.scene.materials;
    for (const bin of materials.bins) {
      const bytes = new ArrayBuffer(240);
      const u = new Uint32Array(bytes);
      const f = new Float32Array(bytes);
      u.set(geometry.source);
      u.set(geometry.sourcePayload, 4);
      u.set([...publication.extent, 0, 0], 8);
      f.set(frame.camera, 12);
      f.set(frame.view.camera.camera.view_matrix, 16);
      f.set(frame.view.camera.view_projection_matrix_inverse, 36);
      u.set(
        [
          segment * this.allocation.pixelsPerSegment,
          publication.anchors[segment]!.plan.ranges.anchors!.count,
          first,
          count
        ],
        52
      );
      u.set([bin.index, 0, 0, 0], 56);
      const settings = command.allocateTransientBufferAndLoad(bytes);
      const layouts = this.sourceLayouts[bin.index]!;
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: settings } },
        ...[geometry.meshletWork, geometry.arena, geometry.vertexPayload, geometry.instances].map(
          (buffer, index) => ({ binding: index + 1, resource: { buffer } })
        ),
        { binding: 5, resource: visibility },
        { binding: 6, resource: { buffer: this.sourceHits } },
        { binding: 7, resource: { buffer: publication.anchors[segment]!.buffer } },
        { binding: 8, resource: { buffer: materials.directory } },
        { binding: 9, resource: { buffer: bin.constants } }
      ];
      const groups = [
        this.device.createBindGroup({ layout: layouts[0]!, entries }),
        this.device.createBindGroup({
          layout: layouts[1]!,
          entries:
            geometry.productHeap === undefined
              ? []
              : [geometry.productHeap, ...geometry.productBanks!].map((buffer, binding) => ({
                  binding,
                  resource: { buffer }
                }))
        }),
        this.device.createBindGroup({
          layout: layouts[2]!,
          entries: [
            { binding: 2, resource: { buffer: this.sourceWork.buffer } },
            ...(bin.material.binding.program.virtualTextures
              ? [
                  {
                    binding: 1,
                    resource: {
                      buffer: this.estimator.input.scene.virtualTextures!.beginQueryFeedback(command)
                    }
                  }
                ]
              : [])
          ]
        }),
        this.device.createBindGroup({ layout: layouts[3]!, entries: [...bin.material.binding.entries] })
      ];
      const pass = command.beginComputePass({ label: "SCGI/gather exact Native source bins" });
      pass.setPipeline(this.sourcePipelines[bin.index]!);
      groups.forEach((group, index) => pass.setBindGroup(index, group));
      pass.dispatchWorkgroupsIndirect(this.sourceWork.indirect, bin.index * 32 + 16);
      pass.end();
    }
  }

  retire(): void {
    this.retiring = true;
    this.releaseRetired();
  }
  encodeDebug(frame: ScgiGatherFrame, output: GPUTexture, exposure: GPUBuffer): void {
    if (frame.settings.debug !== "gather-source") {
      return;
    }
    const { command } = frame.transaction;
    const parameters = command.allocateTransientBufferAndLoad(new ArrayBuffer(16));
    command.copyBufferToBuffer(exposure, 0, parameters, 0, 4);
    const pass = command.beginComputePass({ label: "SCGI/diffuse-only source debug" });
    pass.setPipeline(this.debugPipeline);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.debugPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.source.createView() },
          { binding: 1, resource: output.createView() },
          { binding: 2, resource: { buffer: parameters } }
        ]
      })
    );
    pass.dispatchWorkgroups(Math.ceil(this.plan.width / 8), Math.ceil(this.plan.height / 8));
    pass.end();
  }
  private releaseRetired(): void {
    if (this.retiring && this.inFlight === 0 && !this.poisoned) {
      this.destroyResources();
    }
  }
  private destroyResources(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    if (!this.deviceLost) {
      this.closest?.destroy();
      this.shadow?.destroy();
    }
    this.sourceWork?.destroy();
    for (const buffer of this.buffers) {
      buffer.destroy();
    }
    for (const texture of this.textures) {
      texture.destroy();
    }
    for (const handle of this.handles) {
      this.accounting!.destroyed(handle);
    }
  }
}
