import { PipelineCompilationQueue } from "../../gpu/PipelineCompilationQueue.js";
import type { GpuScene } from "../../gpu/GpuScene.js";
import type { NativeSceneQueryLease } from "../../gpu/GpuNativeMaterialScene.js";
import type { GeometryProductGpuBindingsV1 } from "../../gpu/VirtualGeometryResidency.js";
import type { FrameInstanceTransforms, PreparedFrameInstances } from "../FrameInstanceTransforms.js";
import { scgiAnchorWgsl, scgiSeedWgsl, SCGI_ANCHOR_SETTINGS_BYTES } from "../../shaders/scgi_anchor.js";
import { assertScgiAnchorCapabilities, type ScgiAllocationPlan } from "./ScgiCapacity.js";
import type { ScgiFrameTransaction } from "./ScgiRuntime.js";

/** Immutable publications borrowed from the geometry/scene/material owners.
 * Current frame geometry must match Visibility's work generation and camera. */
export interface ScgiAnchorInputs {
  readonly work: GPUBuffer;
  readonly metadata: GPUBuffer;
  readonly vertices: GPUBuffer;
  readonly instances: GPUBuffer;
  readonly identities: GPUBuffer;
  readonly materials: GPUBuffer;
  readonly visibility: GPUTextureView;
  readonly product?: readonly [GPUBuffer, GPUBuffer, GPUBuffer, GPUBuffer, GPUBuffer];
  readonly source: readonly [number, number, number, number];
  readonly sourcePayload: readonly [number, number, number, number];
}

/** Scene-backed entry: borrow the same frame records as Visibility/Surface.
 * The caller retains geometry and material leases through the command fence. */
export interface ScgiSceneAnchorInputs
  extends Omit<ScgiAnchorInputs, "instances" | "identities" | "materials" | "product"> {
  readonly scene: GpuScene;
  readonly frameOwner: FrameInstanceTransforms;
  readonly frameInstances: PreparedFrameInstances;
  readonly materials: NativeSceneQueryLease;
  readonly product?: GeometryProductGpuBindingsV1;
}

export interface ScgiAnchorView {
  readonly currentView: ArrayLike<number>;
  readonly inverseViewProjection: ArrayLike<number>;
  readonly previousView: ArrayLike<number>;
  readonly previousProjection: ArrayLike<number>;
  readonly previousInverseViewProjection: ArrayLike<number>;
  readonly camera: readonly [number, number, number];
  /** False on camera cut, missing previous camera or invalid deformation. */
  readonly previousValid: boolean;
}

export interface ScgiSeedThresholds {
  readonly distance: number;
  readonly normalCosine: number;
  readonly tangentDistance: number;
}

function writeMatrix(target: Float32Array, offset: number, matrix: ArrayLike<number>): void {
  if (matrix.length !== 16) {
    throw new RangeError("SCGI cameras require complete matrices");
  }
  for (let lane = 0; lane < 16; lane++) {
    const value = Math.fround(matrix[lane]!);
    if (!Number.isFinite(value)) {
      throw new RangeError("SCGI camera must be finite f32");
    }
    target[offset + lane] = value;
  }
}

/** Pre-Surface geometry facts and post-allocation history seeding. Uses the
 * existing transaction and its bounded segmented arenas; never submits or reads
 * back. Pipelines compile only during create. Field production belongs to SCGI-7.
 * Call encodeAnchors after runtime.encode, cache.encode next, encodeSeeds last. */
export class ScgiAnchors {
  private readonly encoded = new WeakMap<
    ScgiFrameTransaction,
    { readonly previousValid: boolean; readonly cameras: Float32Array }
  >();
  private readonly seeded = new WeakSet<ScgiFrameTransaction>();

  private constructor(
    readonly device: GPUDevice,
    readonly plan: ScgiAllocationPlan,
    readonly product: boolean,
    private readonly anchorPipeline: GPUComputePipeline,
    private readonly seedPipeline: GPUComputePipeline
  ) {}

  static async create(device: GPUDevice, plan: ScgiAllocationPlan, product: boolean): Promise<ScgiAnchors> {
    assertScgiAnchorCapabilities(device.limits, plan);
    const queue = PipelineCompilationQueue.forDevice(device);
    const compile = (label: string, code: string) =>
      queue.run(async () => {
        const module = device.createShaderModule({ label, code });
        const errors = (await module.getCompilationInfo()).messages.filter(
          (message) => message.type === "error"
        );
        if (errors.length !== 0) {
          throw new Error(`${label}: ${errors.map((message) => message.message).join("\n")}`);
        }
        return device.createComputePipelineAsync({
          label,
          layout: "auto",
          compute: { module, entryPoint: "main" }
        });
      });
    const anchor = await compile("SCGI/anchors", scgiAnchorWgsl(plan, product));
    const seed = await compile("SCGI/new-patch-seed", scgiSeedWgsl(plan));
    return new ScgiAnchors(device, plan, product, anchor, seed);
  }

  private check(transaction: ScgiFrameTransaction): void {
    if (
      transaction.state !== "encoded" ||
      transaction.command.closed ||
      transaction.command.device !== this.device ||
      transaction.workset.plan !== this.plan
    ) {
      throw new Error("SCGI anchors require their live physical transaction");
    }
  }

  /** Capture current owner identities now and recheck immediately before submit.
   * In-place scene edits change mutationSerial even when buffer identity stays
   * unchanged. No extra GPU copy, scene representation or query AS is needed. */
  encodeSceneAnchors(
    transaction: ScgiFrameTransaction,
    input: ScgiSceneAnchorInputs,
    view: ScgiAnchorView
  ): void {
    this.check(transaction);
    const command = transaction.command;
    const scene = input.scene.queryBindings(command);
    const materials = input.materials;
    const product = input.product;
    const productEpoch = product?.bindingEpoch;
    const metadata = product?.metadata;
    const banks = product === undefined ? undefined : [...product.banks];
    if (input.frameInstances.capacity < scene.highWaterCount || (banks !== undefined && banks.length !== 4)) {
      throw new RangeError("SCGI anchor inputs do not cover the complete scene/Product binding domain");
    }
    const assertCurrent = (): void => {
      const current = input.scene.queryBindings(command);
      if (
        current.instances !== scene.instances ||
        current.identities !== scene.identities ||
        current.mutationSerial !== scene.mutationSerial ||
        current.contentRevision !== scene.contentRevision ||
        current.highWaterCount !== scene.highWaterCount ||
        !materials.isCurrent(command) ||
        (product !== undefined &&
          (product.bindingEpoch !== productEpoch ||
            product.metadata !== metadata ||
            product.banks.some((buffer, index) => buffer !== banks![index])))
      ) {
        throw new Error("SCGI anchor scene/material/geometry publication changed before submit");
      }
      input.frameOwner.assertSource(input.frameInstances, scene.instances, input.work, command.gpu_encoder);
    };
    assertCurrent();
    this.encodeAnchors(
      transaction,
      {
        ...input,
        instances: input.frameInstances.records,
        identities: scene.identities,
        materials: materials.publication.data,
        product:
          product === undefined ? undefined : [metadata!, banks![0]!, banks![1]!, banks![2]!, banks![3]!]
      },
      view
    );
    command.onBeforeFinish.addOne(assertCurrent);
  }

  /** Low-level immutable buffer seam, also used by isolated numerical oracles.
   * Scene composition uses encodeSceneAnchors to validate producer provenance. */
  encodeAnchors(transaction: ScgiFrameTransaction, input: ScgiAnchorInputs, view: ScgiAnchorView): void {
    this.check(transaction);
    if (
      this.encoded.has(transaction) ||
      transaction.publication.cacheComplete ||
      this.product !== (input.product !== undefined)
    ) {
      throw new Error("SCGI anchor geometry profile or encoding order mismatch");
    }
    for (const value of [...input.source, ...input.sourcePayload]) {
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new RangeError("SCGI source offsets must be u32 words");
      }
    }
    if (view.camera.some((value) => !Number.isFinite(Math.fround(value)))) {
      throw new RangeError("SCGI camera must be finite f32");
    }
    // Snapshot once: a caller mutating the camera between allocation and seed
    // must not reinterpret anchors with another previous camera publication.
    const cameras = new Float32Array(32);
    writeMatrix(cameras, 0, view.previousInverseViewProjection);
    writeMatrix(cameras, 16, view.previousView);
    const { publication, command } = transaction;
    let productGroup: GPUBindGroup | undefined;
    if (input.product !== undefined) {
      productGroup = this.device.createBindGroup({
        label: "SCGI/anchor/Product",
        layout: this.anchorPipeline.getBindGroupLayout(1),
        entries: input.product.map((buffer, binding) => ({ binding, resource: { buffer } }))
      });
    }
    let first = 0;
    for (const anchor of publication.anchors) {
      const count = anchor.plan.ranges.anchors!.count;
      const bytes = new ArrayBuffer(SCGI_ANCHOR_SETTINGS_BYTES);
      const words = new Uint32Array(bytes);
      const floats = new Float32Array(bytes);
      words.set(input.source, 0);
      words.set(input.sourcePayload, 4);
      words.set(publication.extent, 8);
      floats.set(view.camera, 12);
      writeMatrix(floats, 16, view.currentView);
      writeMatrix(floats, 36, view.inverseViewProjection);
      writeMatrix(floats, 52, view.previousView);
      writeMatrix(floats, 68, view.previousProjection);
      words.set([first, count, 0, 0], 84);
      // Commit-only serial drives both subpixel winner selection and bounded
      // demand rotation. Abort retries exactly the same phase.
      const demandStart = Number(
        (BigInt(publication.sampleSerial) * BigInt(this.plan.profile.requests)) % BigInt(this.plan.halfPixels)
      );
      words.set([publication.sampleSerial % 4, Number(view.previousValid), demandStart, 0], 88);
      const settings = command.allocateTransientBufferAndLoad(bytes);
      const buffers = [input.work, input.metadata, input.vertices, input.instances];
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: settings, size: SCGI_ANCHOR_SETTINGS_BYTES } },
        ...buffers.map((buffer, i) => ({ binding: i + 1, resource: { buffer } })),
        { binding: 5, resource: input.visibility },
        { binding: 6, resource: { buffer: input.identities } },
        { binding: 7, resource: { buffer: input.materials } },
        { binding: 8, resource: { buffer: publication.privateScratch.buffer } },
        { binding: 9, resource: { buffer: anchor.buffer } }
      ];
      const group = this.device.createBindGroup({
        label: "SCGI/anchor/segment",
        layout: this.anchorPipeline.getBindGroupLayout(0),
        entries
      });
      const pass = command.beginComputePass({ label: "SCGI/anchors" });
      pass.setPipeline(this.anchorPipeline);
      pass.setBindGroup(0, group);
      if (productGroup !== undefined) {
        pass.setBindGroup(1, productGroup);
      }
      pass.dispatchWorkgroups(Math.ceil(count / 64));
      pass.end();
      first += count;
    }
    this.encoded.set(transaction, { previousValid: view.previousValid, cameras });
  }

  encodeSeeds(transaction: ScgiFrameTransaction, thresholds: ScgiSeedThresholds): void {
    this.check(transaction);
    const anchorView = this.encoded.get(transaction);
    if (anchorView === undefined || this.seeded.has(transaction) || !transaction.publication.cacheComplete) {
      throw new Error("SCGI seed requires exactly one preceding anchor encoding");
    }
    if (
      !Number.isFinite(Math.fround(thresholds.distance)) ||
      Math.fround(thresholds.distance) <= 0 ||
      !Number.isFinite(Math.fround(thresholds.tangentDistance)) ||
      Math.fround(thresholds.tangentDistance) <= 0 ||
      !Number.isFinite(thresholds.normalCosine) ||
      Math.abs(thresholds.normalCosine) > 1
    ) {
      throw new RangeError("Invalid SCGI seed geometry thresholds");
    }
    const { command, publication } = transaction;
    const history = publication.previousWorldField;
    if (anchorView.previousValid && history !== null && publication.activeWorld !== null) {
      let anchorFirst = 0;
      for (const anchor of publication.anchors) {
        let historyFirst = 0;
        for (const segment of history.segments) {
          const bytes = new ArrayBuffer(192);
          const words = new Uint32Array(bytes);
          const floats = new Float32Array(bytes);
          floats.set(anchorView.cameras);
          words.set([...publication.extent, anchorFirst, anchor.plan.ranges.anchors!.count], 32);
          words.set([historyFirst, segment.plan.ranges.worldField!.count, 0, 0], 36);
          floats.set(
            [
              thresholds.distance,
              thresholds.normalCosine,
              thresholds.tangentDistance,
              publication.previousCoefficientScale
            ],
            40
          );
          words[44] = 1;
          const settings = command.allocateTransientBufferAndLoad(bytes);
          const group = this.device.createBindGroup({
            label: "SCGI/seed/segments",
            layout: this.seedPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: settings, size: 192 } },
              { binding: 1, resource: { buffer: publication.candidateWorld.buffer } },
              { binding: 2, resource: { buffer: publication.privateScratch.buffer } },
              { binding: 3, resource: { buffer: anchor.buffer } },
              { binding: 4, resource: { buffer: segment.buffer } },
              { binding: 5, resource: { buffer: publication.activeWorld.buffer } }
            ]
          });
          const pass = command.beginComputePass({ label: "SCGI/new-patch-seed" });
          pass.setPipeline(this.seedPipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(Math.ceil(this.plan.profile.patches / 64));
          pass.end();
          historyFirst += segment.plan.ranges.worldField!.count;
        }
        anchorFirst += anchor.plan.ranges.anchors!.count;
      }
    }
    this.seeded.add(transaction);
  }
}
