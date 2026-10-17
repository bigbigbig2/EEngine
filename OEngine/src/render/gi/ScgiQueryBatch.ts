import { GPU_INSTANCE_RECORD_WGSL } from "../../gpu/GpuInstanceAbi.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { ScgiQueryHitWork } from "./ScgiQueryHitWork.js";
import { ScgiQueryRayCount } from "./ScgiQueryRayCount.js";
import { ScgiQueryRouteWork } from "./ScgiQueryRouteWork.js";
import { ScgiQueryTraversal } from "./ScgiQueryTraversal.js";
import type { ScgiQueryScene } from "./ScgiQueryScene.js";
import { scgiInteger } from "./ScgiCapacity.js";
import { PipelineCompilationQueue } from "../../gpu/PipelineCompilationQueue.js";

export interface ScgiQueryBatchInput {
  readonly batch: GPUBuffer;
  readonly rayCount: number;
  readonly resultByteOffset: number;
  readonly output: GPUBuffer;
  /** Optional geometry facts for transport, in the same output binding. */
  readonly outputStride?: 64 | 96;
  readonly view: ArrayLike<number>;
  readonly camera: ArrayLike<number>;
  readonly coneWidth: number;
  readonly coneSpread: number;
  readonly diagnostics?: boolean;
  readonly kind?: "geometry" | "material";
  readonly anyHit?: boolean;
  readonly feedback?: GPUBuffer;
  /** GPU-produced dense prefix, rayCount remains allocation capacity. */
  readonly count?: { readonly buffer: GPUBuffer; readonly byteOffset: number };
}

/** One finite work batch over one immutable scene. All native coverage bins
 * and finite AS arenas participate before a physical miss is observable.
 * Each traversal invocation completes its tree, including inline MASK.
 * No internal submit/readback or quantum tail exists.
 * Creation is asynchronous preparation; encoding creates no GPU objects. */
export class ScgiQueryBatch {
  private readonly traversal: ScgiQueryTraversal[] = [];
  private readonly diffuse: ScgiQueryTraversal[] = [];
  private readonly work: ScgiQueryHitWork[] = [];
  private readonly buffers: GPUBuffer[] = [];
  private destroyed = false;
  private inFlight = 0;
  private poisoned = false;
  private readonly commands = new WeakSet<ShadeGPUCommandContext>();
  private emptyScene: { pipeline: GPUComputePipeline; group: GPUBindGroup; settings: GPUBuffer } | undefined;
  private resolve: { pipeline: GPUComputePipeline; group: GPUBindGroup } | undefined;
  private usesVirtualTextures = false;
  private releaseQueryDemand: (() => void) | undefined;
  private routing: ScgiQueryRouteWork | undefined;
  private rayWork: ScgiQueryRayCount | undefined;
  private mappingRevision = 0;

  /** Borrowed last-encode diagnostics; caller must retain this batch through
   * the copy fence. Rows: routed/node/triangle/coverage/xyz/active, 32B each. */
  get routeCounters(): GPUBuffer | undefined {
    return this.routing?.counters;
  }

  get mappingGeneration(): number {
    return this.mappingRevision;
  }
  get viewDependent(): boolean {
    return this.scene.viewDependent;
  }

  /** Borrowed scene/ray/output/feedback allocations are charged by their
   * owners. This reports every private batch byte, including bin parameters.
   * Upper-bound dispatches count encoded zero-work commands as real host work. */
  get cost() {
    const traversals = [...this.traversal, ...this.diffuse];
    return Object.freeze({
      privateBytes:
        (this.routing === undefined
          ? 0
          : this.routing.buffer.size + this.routing.indirect.size + (this.routing.counters?.size ?? 0)) +
        this.buffers.reduce((bytes, buffer) => bytes + buffer.size, 0) +
        this.work.reduce((bytes, work) => bytes + work.buffer.size + work.indirect.size, 0) +
        traversals.reduce((bytes, traversal) => bytes + traversal.byteLength, 0) +
        (this.rayWork === undefined ? 0 : this.rayWork.buffer.size + this.rayWork.indirect.size),
      traversalDispatches: this.traversal.length,
      acceptedDispatches: this.diffuse.length,
      routingDispatches: this.traversal.length * 2,
      totalDispatches:
        (this.scene.arenas.length === 0
          ? 1
          : traversals.length +
            this.traversal.length * 2 +
            this.work.reduce((count, work) => count + work.dispatchCount, 0) +
            1) +
        2 * Number(this.rayWork !== undefined),
      rayCapacity: this.input.rayCount,
      descriptors: traversals.reduce(
        (maximum, traversal) => ({
          storage: Math.max(maximum.storage, traversal.descriptors.storage),
          sampled: Math.max(maximum.sampled, traversal.descriptors.sampled),
          sampler: Math.max(maximum.sampler, traversal.descriptors.sampler),
          uniform: Math.max(maximum.uniform, traversal.descriptors.uniform),
        }),
        { storage: 0, sampled: 0, sampler: 0, uniform: 0 },
      ),
    });
  }

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

  static async create(
    device: GPUDevice,
    scene: ScgiQueryScene,
    input: ScgiQueryBatchInput,
  ): Promise<ScgiQueryBatch> {
    scgiInteger(input.rayCount, "query batch ray capacity", 1);
    if (
      (input.kind === "geometry" && input.outputStride !== 96) ||
      (input.outputStride !== undefined && input.outputStride !== 64 && input.outputStride !== 96) ||
      !Number.isSafeInteger(input.resultByteOffset) ||
      input.resultByteOffset % 4 !== 0 ||
      input.resultByteOffset < input.rayCount * 48 ||
      input.resultByteOffset + input.rayCount * 32 > input.batch.size ||
      input.batch.size > device.limits.maxStorageBufferBindingSize ||
      input.output.size > device.limits.maxStorageBufferBindingSize ||
      !(input.batch.usage & GPUBufferUsage.STORAGE) ||
      !(input.output.usage & GPUBufferUsage.STORAGE) ||
      input.output.size < input.rayCount * (input.outputStride ?? 64) ||
      Math.ceil(input.rayCount / 64) > device.limits.maxComputeWorkgroupsPerDimension
    ) {
      throw new RangeError("Query batch requires complete nonoverlapping ray/result ranges");
    }
    if (!scene.prepared && !scene.valid) {
      throw new Error("Query batch requires its complete live scene");
    }
    const owner = new ScgiQueryBatch(device, scene, input);
    try {
      {
        const rayWork = await ScgiQueryRayCount.create(
          device,
          input.rayCount,
          input.batch,
          input.resultByteOffset,
          input.count,
          scene.coverageStatus,
          input.anyHit ? undefined : { buffer: input.output, stride: input.outputStride ?? 64 },
        );
        if (owner.destroyed) {
          rayWork.destroy();
          throw new Error("Query device was lost during ray count preparation");
        }
        owner.rayWork = rayWork;
      }
      if (scene.arenas.length === 0) {
        await owner.prepareEmptyScene();
        if (!scene.prepared && !scene.valid) {
          throw new Error("Query scene retired during empty-domain preparation");
        }
        return owner;
      }
      owner.routing = await ScgiQueryRouteWork.create(
        device,
        scene,
        input.batch,
        input.rayCount,
        input.resultByteOffset,
        owner.rayWork!,
        input.anyHit ?? false,
        input.diagnostics ?? false,
      );
      const source = scene.sourceInstances.sourceSnapshot;
      const publication = scene.materialPublication;
      owner.usesVirtualTextures =
        !input.anyHit &&
        input.kind !== "geometry" &&
        scene.materials.bins.some((bin) => bin.material.binding.program.virtualTextures);
      if (owner.usesVirtualTextures && input.feedback === undefined) {
        if (scene.virtualTextures === null) {
          throw new Error("Query VT material has no texture owner");
        }
        await scene.virtualTextures.enableQueryFeedback();
        owner.releaseQueryDemand = scene.virtualTextures.retainQueryDemand();
      }
      const diffuseWork =
        input.anyHit || input.kind === "geometry"
          ? undefined
          : await owner.retainPrepared(
              owner.work,
              ScgiQueryHitWork.create(
                device,
                source,
                scene.materials.directory,
                input.batch,
                input.rayCount,
                input.resultByteOffset,
                scene.materials.bins.length,
                owner.rayWork,
              ),
            );
      const view = {
        view: input.view,
        camera: input.camera,
        coneWidth: input.coneWidth,
        coneSpread: input.coneSpread,
      };
      for (const arena of scene.arenas) {
        for (const route of arena.routes) {
          await owner.retainPrepared(
            owner.traversal,
            ScgiQueryTraversal.create(device, {
              diagnostics: input.diagnostics,
              arena,
              route,
              source,
              instances: scene.instanceRecords,
              batch: input.batch,
              coverageStatus: scene.coverageStatus,
              rayCount: input.rayCount,
              resultByteOffset: input.resultByteOffset,
              anyHit: input.anyHit,
              merge: true,
              rayWork: owner.rayWork,
              routing: { work: owner.routing, route },
              coverage: { publication, classIndex: route.classIndex, ...view },
            }),
          );
        }
        // Attributes are evaluated once per accepted ray/source segment and
        // actual Native Program, never once per asset or BLAS.
        const segments = [...new Set(arena.geometries.map((item) => item.segment))];
        for (let sourceGroup = 0; sourceGroup < segments.length; sourceGroup++) {
          const route = {
            ...arena.routes[0]!,
            segment: segments[sourceGroup]!,
            sourceGroup,
            lease: arena.geometries.find((item) => item.segment === segments[sourceGroup])!.lease,
          };
          const common = {
            diagnostics: input.diagnostics,
            arena,
            route,
            source,
            instances: scene.instanceRecords,
            batch: input.batch,
            coverageStatus: scene.coverageStatus,
            rayCount: input.rayCount,
            resultByteOffset: input.resultByteOffset,
            rayWork: owner.rayWork,
          };
          if (input.anyHit) {
            continue;
          }
          if (input.kind === "geometry") {
            await owner.retainPrepared(
              owner.diffuse,
              ScgiQueryTraversal.create(device, {
                ...common,
                geometryOnly: true,
                geometryOutput: input.output,
                outputStride: input.outputStride,
              }),
            );
          } else {
            for (const bin of scene.materials.bins) {
              await owner.retainPrepared(
                owner.diffuse,
                ScgiQueryTraversal.create(device, {
                  ...common,
                  work: diffuseWork,
                  diffuse: {
                    material: bin.material,
                    constants: bin.constants,
                    directory: scene.materials.directory,
                    binIndex: bin.index,
                    output: input.output,
                    outputStride: input.outputStride,
                    feedback: input.feedback,
                    ...(owner.usesVirtualTextures && input.feedback === undefined
                      ? { feedbackBuffers: scene.virtualTextures!.queryFeedbackBuffers }
                      : {}),
                    ...view,
                  },
                }),
              );
            }
          }
        }
      }
      if (!scene.prepared && !scene.valid) {
        throw new Error("Query scene retired during batch pipeline preparation");
      }
      await owner.prepareResolve();
      if (owner.destroyed) {
        throw new Error("Query device was lost during final status preparation");
      }
      return owner;
    } catch (error) {
      owner.destroy();
      throw error;
    }
  }

  private async prepareEmptyScene(): Promise<void> {
    const module = this.device.createShaderModule({
      label: "SCGI/empty covered query",
      code: /* wgsl */ `
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
  if (!finite_input || !valid_max || !(t_min <= t_max) || all(direction == vec3f(0.0))) {
    status = 5u;
  } else if (coverage[0] != 0u ||
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
`,
    });
    const pipeline = await PipelineCompilationQueue.forDevice(this.device).run(() =>
      this.device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } }),
    );
    if (this.destroyed) {
      throw new Error("Query device was lost during empty-domain preparation");
    }
    const settings = this.device.createBuffer({
      label: "SCGI/empty query parameters",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    this.buffers.push(settings);
    new Uint32Array(settings.getMappedRange()).set([
      this.input.rayCount,
      this.input.resultByteOffset / 4,
      0,
      0,
    ]);
    settings.unmap();
    const group = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: settings } },
        { binding: 1, resource: { buffer: this.input.batch } },
        { binding: 2, resource: { buffer: this.scene.coverageStatus } },
      ],
    });
    this.emptyScene = { pipeline, group, settings };
  }

  private async prepareResolve(): Promise<void> {
    const module = this.device.createShaderModule({
      label: "SCGI/query resolve",
      code: /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
@group(0) @binding(0) var<storage, read> source: array<OEngineInstanceRecord>;
@group(0) @binding(1) var<storage, read_write> batch: array<u32>;
@group(0) @binding(2) var<storage, read> hits: array<vec4f>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${this.input.rayCount}u) { return; }
  let at = ${this.input.resultByteOffset / 4}u + id.x * 8u;
  let status = batch[at + 3u];
  if (status == 4u) { batch[at + 3u] = 5u; return; }
  if (status != 0u) { return; }
  let slot = batch[at + 4u];
  if (slot >= arrayLength(&source)) { batch[at + 3u] = 5u; return; }
  ${
    this.input.anyHit
      ? ""
      : `
  if (batch[at + 7u] == 0u && (source[slot].flags & 16u) == 0u) {
    batch[at + 3u] = 3u;
    return;
  }
  if (hits[id.x * ${(this.input.outputStride ?? 64) / 16}u + 2u].w != 1.0) { batch[at + 3u] = 2u; return; }
  for (var item = 0u; item < 3u; item++) {
    if (any((bitcast<vec4u>(hits[id.x * ${(this.input.outputStride ?? 64) / 16}u + item]) & vec4u(0x7f800000u)) == vec4u(0x7f800000u))) {
      batch[at + 3u] = 5u;
    }
  }
  if (any((bitcast<vec3u>(hits[id.x * ${(this.input.outputStride ?? 64) / 16}u + 3u].xyz) & vec3u(0x7f800000u)) == vec3u(0x7f800000u))) {
    batch[at + 3u] = 5u;
  }
  ${
    this.input.outputStride === 96
      ? `
  let geometry = hits[id.x * 6u + 5u];
  if (any((bitcast<vec4u>(geometry) & vec4u(0x7f800000u)) == vec4u(0x7f800000u)) ||
      dot(geometry.xyz, geometry.xyz) < 0.5 || geometry.w < 0.0) {
    batch[at + 3u] = 5u;
  }`
      : ""
  }`
  }
}`,
    });
    const pipeline = await PipelineCompilationQueue.forDevice(this.device).run(() =>
      this.device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } }),
    );
    const group = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.scene.sourceInstances.sourceSnapshot } },
        { binding: 1, resource: { buffer: this.input.batch } },
        ...(!this.input.anyHit ? [{ binding: 2, resource: { buffer: this.input.output } }] : []),
      ],
    });
    this.resolve = { pipeline, group };
  }

  encode(command: ShadeGPUCommandContext): void {
    if (
      this.destroyed ||
      this.poisoned ||
      command.closed ||
      command.device !== this.device ||
      !this.scene.valid
    ) {
      throw new Error("Query batch requires its encoded immutable scene publication");
    }
    // Sequential reuse is intentional: a consumer must finish reading the old
    // results before overwriting rays. Encoder order is the dependency, with
    // one scene/fence registration for all windows in this command.
    if (!this.commands.has(command)) {
      this.scene.observeUse(command);
      this.commands.add(command);
      this.inFlight++;
      command.observeSubmission({
        submitted: (fence) => {
          void fence.then(
            () => {
              this.inFlight--;
            },
            () => {
              this.poisoned = true;
            },
          );
        },
        aborted: () => {
          this.inFlight--;
        },
        failed: () => {
          this.poisoned = true;
        },
      });
    }
    this.rayWork?.encode(command);
    if (this.emptyScene !== undefined) {
      if (this.rayWork !== undefined) {
        command.copyBufferToBuffer(this.rayWork.buffer, 0, this.emptyScene.settings, 0, 4);
      }
      const pass = command.gpu_encoder.beginComputePass({ label: "SCGI/empty covered query" });
      pass.setPipeline(this.emptyScene.pipeline);
      pass.setBindGroup(0, this.emptyScene.group);
      if (this.rayWork !== undefined) {
        pass.dispatchWorkgroupsIndirect(this.rayWork.indirect, 16);
      } else {
        pass.dispatchWorkgroups(Math.ceil(this.input.rayCount / 64));
      }
      pass.end();
      return;
    }
    for (const traversal of this.traversal) {
      traversal.encode(command);
    }
    // Output records are only read for Hit. Accepted stages completely write
    // their own record; misses/unknown never require full-capacity clears.
    for (const work of this.work) {
      work.encode(command);
    }
    const feedback =
      this.usesVirtualTextures && this.input.feedback === undefined
        ? this.scene.virtualTextures!.beginQueryFeedback(command)
        : this.input.feedback;
    this.mappingRevision = this.scene.virtualTextures?.mappingGeneration(command) ?? 0;
    if (!this.input.anyHit) {
      for (const diffuse of this.diffuse) {
        diffuse.encode(command, feedback);
      }
    }
    const pass = command.gpu_encoder.beginComputePass({ label: "SCGI/query final status" });
    pass.setPipeline(this.resolve!.pipeline);
    pass.setBindGroup(0, this.resolve!.group);
    if (this.rayWork !== undefined) {
      pass.dispatchWorkgroupsIndirect(this.rayWork.indirect, 16);
    } else {
      pass.dispatchWorkgroups(Math.ceil(this.input.rayCount / 64));
    }
    pass.end();
  }

  updateView(
    command: ShadeGPUCommandContext,
    view: ArrayLike<number>,
    camera: ArrayLike<number>,
    coneWidth: number,
    coneSpread: number,
  ): void {
    for (const traversal of [...this.traversal, ...this.diffuse]) {
      traversal.updateView(command, view, camera, coneWidth, coneSpread);
    }
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
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const queries of [this.traversal, this.diffuse]) {
      for (const query of queries) {
        query.destroy();
      }
    }
    for (const work of this.work) {
      work.destroy();
    }
    this.routing?.destroy();
    this.rayWork?.destroy();
    for (const buffer of this.buffers) {
      buffer.destroy();
    }
    this.releaseQueryDemand?.();
    this.releaseQueryDemand = undefined;
  }
}
