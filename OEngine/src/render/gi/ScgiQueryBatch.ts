import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { ScgiQueryHitWork } from "./ScgiQueryHitWork.js";
import { ScgiQueryTraversal } from "./ScgiQueryTraversal.js";
import type { ScgiQueryScene } from "./ScgiQueryScene.js";
import { scgiInteger } from "./ScgiCapacity.js";
import { PipelineCompilationQueue } from "../../gpu/PipelineCompilationQueue.js";

export interface ScgiQueryBatchInput {
  readonly batch: GPUBuffer;
  readonly rayCount: number;
  readonly resultByteOffset: number;
  readonly output: GPUBuffer;
  readonly view: ArrayLike<number>;
  readonly camera: ArrayLike<number>;
  readonly coneWidth: number;
  readonly coneSpread: number;
  readonly wavefrontRounds: number;
  readonly anyHit?: boolean;
  readonly feedback?: GPUBuffer;
}

/** One finite work batch over one immutable scene. All native coverage bins
 * and AS shards participate before a physical miss is observable. K is only
 * the fast-path schedule: remaining candidates compact into the complete
 * inline native tail in the same command. No internal submit/readback exists.
 * Creation is asynchronous preparation; encoding creates no GPU objects. */
export class ScgiQueryBatch {
  private readonly candidates: ScgiQueryTraversal[] = [];
  private readonly coverage: ScgiQueryTraversal[] = [];
  private readonly tail: ScgiQueryTraversal[] = [];
  private readonly diffuse: ScgiQueryTraversal[] = [];
  private readonly work: ScgiQueryHitWork[] = [];
  private readonly buffers: GPUBuffer[] = [];
  private continuation!: GPUBuffer;
  private destroyed = false;
  private inFlight = 0;
  private poisoned = false;
  private readonly commands = new WeakSet<ShadeGPUCommandContext>();
  private emptyScene: { pipeline: GPUComputePipeline; group: GPUBindGroup } | undefined;

  private constructor(
    private readonly device: GPUDevice,
    private readonly scene: ScgiQueryScene,
    private readonly input: ScgiQueryBatchInput,
  ) {
    void device.lost.then(() => this.destroyResources());
  }

  private async retainPrepared<T extends { destroy(): void }>(
    resources: T[],
    pending: Promise<T>,
  ): Promise<T> {
    const resource = await pending;
    if (this.destroyed) {
      resource.destroy();
      throw new Error("Query device was lost during batch preparation");
    }
    resources.push(resource);
    return resource;
  }

  static async create(device: GPUDevice, scene: ScgiQueryScene,
    input: ScgiQueryBatchInput): Promise<ScgiQueryBatch> {
    scgiInteger(input.wavefrontRounds, "query wavefront rounds", 0, 64);
    scgiInteger(input.rayCount, "query batch ray capacity", 1);
    if (!Number.isSafeInteger(input.resultByteOffset) || input.resultByteOffset % 4 !== 0 ||
        input.resultByteOffset < input.rayCount * 48 ||
        input.resultByteOffset + input.rayCount * 32 > input.batch.size ||
        Math.ceil(input.rayCount / 64) > device.limits.maxComputeWorkgroupsPerDimension) {
      throw new RangeError("Query batch requires complete nonoverlapping ray/result ranges");
    }
    const continuationBytes = scene.shards.length === 0 ? 0 : input.rayCount * 64;
    if ((!scene.prepared && !scene.valid) || continuationBytes >
        Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize)) {
      throw new RangeError("Query batch requires its complete live scene and admitted continuation arena");
    }
    const owner = new ScgiQueryBatch(device, scene, input);
    try {
      if (scene.shards.length === 0) {
        await owner.prepareEmptyScene();
        if (!scene.prepared && !scene.valid) {
          throw new Error("Query scene retired during empty-domain preparation");
        }
        return owner;
      }
      owner.continuation = device.createBuffer({ label: "SCGI/query continuation",
        size: continuationBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      owner.buffers.push(owner.continuation);
      const source = scene.sourceInstances.sourceSnapshot;
      const publication = scene.materialPublication;
      const coverageWork = await owner.retainPrepared(owner.work,
        ScgiQueryHitWork.create(device, source, publication.rasterDirectory,
          input.batch, input.rayCount, input.resultByteOffset, publication.rasterClasses.length));
      const pendingWork = await owner.retainPrepared(owner.work,
        ScgiQueryHitWork.create(device, source, publication.rasterDirectory,
          input.batch, input.rayCount, input.resultByteOffset, 1, true));
      const diffuseWork = await owner.retainPrepared(owner.work,
        ScgiQueryHitWork.create(device, source, scene.materials.directory,
          input.batch, input.rayCount, input.resultByteOffset, scene.materials.bins.length));
      const view = { view: input.view, camera: input.camera,
        coneWidth: input.coneWidth, coneSpread: input.coneSpread };
      for (const shard of scene.shards) {
        const common = { lease: shard.lease, segment: shard.segment, asset: shard.asset, blas: shard.blas,
          tlas: shard.tlas, instances: shard.instances, primitiveOffset: shard.primitiveOffset,
          primitiveCount: shard.primitiveCount, batch: input.batch, rayCount: input.rayCount,
          resultByteOffset: input.resultByteOffset, anyHit: input.anyHit,
          coverageStatus: scene.coverageStatus };
        await owner.retainPrepared(owner.candidates, ScgiQueryTraversal.create(device, scene.blasPlan, scene.tlasPlan,
          { ...common, merge: owner.candidates.length > 0,
            anyHit: false,
            wavefront: { phase: "candidate", continuation: owner.continuation } }));
        for (let classIndex = 0; classIndex < publication.rasterClasses.length; classIndex++) {
          const coverage = { publication, classIndex, ...view };
          await owner.retainPrepared(owner.coverage, ScgiQueryTraversal.create(device, scene.blasPlan, scene.tlasPlan,
            { ...common, coverage, wavefront: { phase: "coverage",
              continuation: owner.continuation, work: coverageWork } }));
          await owner.retainPrepared(owner.tail, ScgiQueryTraversal.create(device, scene.blasPlan, scene.tlasPlan,
            { ...common, coverage, merge: owner.tail.length > 0,
              wavefront: { phase: "tail", continuation: owner.continuation },
              // Without a wavefront, the complete tail consumes all input rays.
              ...(input.wavefrontRounds === 0 ? {} : { pendingWork }) }));
        }
        for (const bin of scene.materials.bins) {
          await owner.retainPrepared(owner.diffuse, ScgiQueryTraversal.create(device, scene.blasPlan, scene.tlasPlan,
            { ...common, diffuse: { material: bin.material, constants: bin.constants,
              directory: scene.materials.directory, binIndex: bin.index, work: diffuseWork,
              output: input.output, feedback: input.feedback, ...view } }));
        }
      }
      if (!scene.prepared && !scene.valid) {
        throw new Error("Query scene retired during batch pipeline preparation");
      }
      return owner;
    } catch (error) {
      owner.destroy();
      throw error;
    }
  }

  private async prepareEmptyScene(): Promise<void> {
    const module = this.device.createShaderModule({ label: "SCGI/empty covered query", code: /* wgsl */ `
struct Settings { count: u32, result_word: u32, reserved: vec2u, }
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var<storage, read_write> batch: array<u32>;
@group(0) @binding(2) var<storage, read> coverage: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= settings.count) {
    return;
  }
  let ray = id.x * 12u;
  let result = settings.result_word + id.x * 8u;
  let origin = bitcast<vec3f>(vec3u(batch[ray], batch[ray + 1u], batch[ray + 2u]));
  let direction = bitcast<vec3f>(vec3u(batch[ray + 4u], batch[ray + 5u], batch[ray + 6u]));
  let t_min = bitcast<f32>(batch[ray + 3u]);
  let t_max = bitcast<f32>(batch[ray + 7u]);
  let start = origin + direction * t_min;
  let end = origin + direction * t_max;
  let low = bitcast<vec3f>(vec3u(coverage[4], coverage[5], coverage[6]));
  let high = bitcast<vec3f>(vec3u(coverage[8], coverage[9], coverage[10]));
  let finite_segment = all((bitcast<vec3u>(start) & vec3u(0x7f800000u)) != vec3u(0x7f800000u)) &&
    all((bitcast<vec3u>(end) & vec3u(0x7f800000u)) != vec3u(0x7f800000u));
  let finite_input = all((bitcast<vec3u>(origin) & vec3u(0x7f800000u)) != vec3u(0x7f800000u)) &&
    all((bitcast<vec3u>(direction) & vec3u(0x7f800000u)) != vec3u(0x7f800000u)) &&
    (bitcast<u32>(t_min) & 0x7f800000u) != 0x7f800000u;
  let valid_max = (bitcast<u32>(t_max) & 0x7f800000u) != 0x7f800000u ||
    bitcast<u32>(t_max) == 0x7f800000u;
  var status = 1u;
  if (coverage[0] != 0u || !finite_input || !valid_max || !(t_min <= t_max) || all(direction == vec3f(0.0)) ||
      (coverage[7] != 0u && (!finite_segment ||
        any(start < low) || any(start > high) || any(end < low) || any(end > high)))) {
    status = 2u;
  }
  batch[result] = batch[ray + 7u];
  batch[result + 1u] = 0u;
  batch[result + 2u] = 0u;
  batch[result + 3u] = status;
  batch[result + 4u] = 0xffffffffu;
  batch[result + 5u] = 0xffffffffu;
  batch[result + 6u] = 0u;
  batch[result + 7u] = 0u;
}
` });
    const pipeline = await PipelineCompilationQueue.forDevice(this.device).run(() =>
      this.device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } }));
    if (this.destroyed) {
      throw new Error("Query device was lost during empty-domain preparation");
    }
    const settings = this.device.createBuffer({ label: "SCGI/empty query parameters",
      size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
    this.buffers.push(settings);
    new Uint32Array(settings.getMappedRange()).set([this.input.rayCount, this.input.resultByteOffset / 4, 0, 0]);
    settings.unmap();
    const group = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: settings } },
      { binding: 1, resource: { buffer: this.input.batch } },
      { binding: 2, resource: { buffer: this.scene.coverageStatus } },
    ] });
    this.emptyScene = { pipeline, group };
  }

  encode(command: ShadeGPUCommandContext): void {
    if (this.destroyed || this.poisoned || command.closed || command.device !== this.device || !this.scene.valid) {
      throw new Error("Query batch requires its encoded immutable scene publication");
    }
    if (this.commands.has(command)) {
      throw new Error("Query batch can be encoded only once in a command");
    }
    this.scene.observeUse(command);
    this.commands.add(command);
    this.inFlight++;
    command.observeSubmission({
      submitted: (fence) => {
        void fence.then(() => { this.inFlight--; }, () => { this.poisoned = true; });
      },
      aborted: () => { this.inFlight--; },
      failed: () => { this.poisoned = true; },
    });
    if (this.emptyScene !== undefined) {
      const pass = command.gpu_encoder.beginComputePass({ label: "SCGI/empty covered query" });
      pass.setPipeline(this.emptyScene.pipeline);
      pass.setBindGroup(0, this.emptyScene.group);
      pass.dispatchWorkgroups(Math.ceil(this.input.rayCount / 64));
      pass.end();
      command.clearBuffer(this.input.output);
      return;
    }
    command.clearBuffer(this.continuation);
    for (let round = 0; round < this.input.wavefrontRounds; round++) {
      for (const candidate of this.candidates) { candidate.encode(command); }
      this.work[0]!.encode(command);
      for (const coverage of this.coverage) { coverage.encode(command); }
    }
    if (this.input.wavefrontRounds !== 0) { this.work[1]!.encode(command); }
    for (const tail of this.tail) { tail.encode(command); }
    command.clearBuffer(this.input.output);
    this.work[2]!.encode(command);
    for (const diffuse of this.diffuse) { diffuse.encode(command); }
  }

  /** Pre-submit cancellation or final successful consumer fence. Scene/page
   * leases remain owned by the query scene; this owns only batch resources. */
  destroy(): void {
    if (this.inFlight !== 0 || this.poisoned) {
      throw new Error("Query batch is retained by an encoded command or failed submission");
    }
    this.destroyResources();
  }

  private destroyResources(): void {
    if (this.destroyed) { return; }
    this.destroyed = true;
    for (const queries of [this.candidates, this.coverage, this.tail, this.diffuse]) {
      for (const query of queries) { query.destroy(); }
    }
    for (const work of this.work) { work.destroy(); }
    for (const buffer of this.buffers) { buffer.destroy(); }
  }
}
