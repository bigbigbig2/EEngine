import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { ScgiQueryHitWork } from "./ScgiQueryHitWork.js";
import { ScgiQueryTraversal } from "./ScgiQueryTraversal.js";
import type { ScgiQueryScene } from "./ScgiQueryScene.js";
import { scgiInteger } from "./ScgiCapacity.js";

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
    const continuationBytes = input.rayCount * 64;
    if ((!scene.prepared && !scene.valid) || continuationBytes >
        Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize)) {
      throw new RangeError("Query batch requires its complete live scene and admitted continuation arena");
    }
    const owner = new ScgiQueryBatch(device, scene, input);
    try {
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
        const common = { lease: shard.lease, asset: shard.asset, blas: shard.blas,
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
