import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import type { VirtualGeometryResidency } from "../../gpu/VirtualGeometryResidency.js";
import type { GeometryPageStreamingRuntimeV1 } from "../../gpu/GeometryPageStreamingRuntime.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GPULightCollection } from "../../gpu/LightDatabase.js";
import type { PhysicalEnvironmentRuntime } from "../environment/PhysicalEnvironmentRuntime.js";
import type { PackedVisibilityJob } from "../passes/PackedVisibilityPass.js";
import type { GPUViewContext } from "../ViewContext.js";
import { nativeWinnerGeometry } from "../MeshletBucketRaster.js";
import { ScgiRuntime, type ScgiFrameTransaction } from "./ScgiRuntime.js";
import { ScgiCache } from "./ScgiCache.js";
import { ScgiAnchors } from "./ScgiAnchors.js";
import { ScgiFilter } from "./ScgiFilter.js";
import { ScgiInvalidation } from "./ScgiInvalidation.js";
import { ScgiEstimator } from "./ScgiEstimator.js";
import { ScgiQueryScene } from "./ScgiQueryScene.js";
import { ScgiQueryScenePublication } from "./ScgiQueryScenePublication.js";
import { surfaceCacheGiFilter, type SurfaceCacheGiSettings } from "./SurfaceCacheGiSettings.js";
import { geometryQueryCut } from "../../gpu/GeometryQueryCut.js";
import type { GeometryQueryCut } from "../../gpu/GeometryQueryCut.js";
import type { GeometryProductDescriptorV1 } from "../../assets/geometry-product/GeometryProductV1.js";
import { ScgiGather, type ScgiGatherFrame } from "./ScgiGather.js";

export interface ScgiRendererFrame {
  readonly owner: ScgiRenderer;
  readonly transaction: ScgiFrameTransaction;
  readonly query: ScgiQueryScene;
  readonly estimator: ScgiEstimator;
  readonly settings: SurfaceCacheGiSettings;
  readonly view: GPUViewContext;
  readonly camera: readonly [number, number, number];
  readonly previousValid: boolean;
  readonly lightingChanged: boolean;
  readonly queryRevision: number;
  readonly gather: ScgiGatherFrame | null;
}

/** Composition of the existing GI owners. Asynchronous preparation borrows the
 * open Renderer command; all GPU writes still execute in that single submit.
 * Scene snapshots are replaced only when their source publication changes. */
export class ScgiRenderer {
  readonly runtime: ScgiRuntime;
  private readonly scenes = new ScgiQueryScenePublication();
  private configuration = "";
  private cache!: ScgiCache;
  private anchors!: ScgiAnchors;
  private filter!: ScgiFilter;
  private invalidation: ScgiInvalidation | null = null;
  private estimator: ScgiEstimator | null = null;
  private estimatorKey = "";
  private gather: ScgiGather | null = null;
  private gatherKey = "";
  private lastFence: Promise<void> = Promise.resolve();
  private stopped = false;
  private committedLighting = "";
  private readonly exactCuts = new WeakMap<GeometryProductDescriptorV1, GeometryQueryCut>();
  private sceneEpoch = 0;
  private sourceSceneEpoch = -1;
  private voxelSize = 0;
  private queryRevision = 0;
  private readonly queryRevisions = new WeakMap<ScgiQueryScene, number>();

  constructor(
    private readonly graphics: GraphicsContext,
    readonly deviceEpoch: number,
  ) {
    this.runtime = new ScgiRuntime(graphics.device, deviceEpoch, graphics.resource_accounting);
  }

  /** Compound macro write domain: private work stays with its actual owner. */
  get graphWork() {
    return { estimator: this.estimator, invalidation: this.invalidation, gather: this.gather };
  }

  get cost() {
    const runtime = this.runtime.snapshot();
    const query = this.scenes.current?.byteLength ?? 0;
    const estimator = this.estimator?.cost;
    const invalidation = this.invalidation?.cost.privateBytes ?? 0;
    return {
      runtime,
      queryBytes: query,
      queryArenas: this.scenes.current?.arenas.length ?? 0,
      estimator,
      invalidationBytes: invalidation,
      gather: this.gather?.cost,
      currentOwnedBytes:
        runtime.totalBytes +
        query +
        (estimator?.privateBytes ?? 0) +
        invalidation +
        (this.gather?.cost.ownedBytes ?? 0) +
        (this.gather?.cost.queryPrivateBytes ?? 0),
      note: "Excludes borrowed geometry/textures, retired query/estimator generations, directory and driver allocations",
    };
  }

  async prepare(input: {
    command: ShadeGPUCommandContext;
    settings: SurfaceCacheGiSettings;
    world: GpuRenderWorldRuntime;
    products: readonly VirtualGeometryResidency[];
    streaming?: GeometryPageStreamingRuntimeV1;
    width: number;
    height: number;
    sceneEpoch: number;
    viewEpoch: number;
    view: GPUViewContext;
    lights: GPULightCollection;
    physical: PhysicalEnvironmentRuntime | null;
    authoredEnvironment: boolean;
    previousValid: boolean;
  }): Promise<ScgiRendererFrame> {
    if (this.stopped) {
      throw new Error("SCGI renderer has retired");
    }
    const { command, settings, world, view, width, height } = input;
    const reset = this.sourceSceneEpoch !== input.sceneEpoch || this.voxelSize !== settings.voxelSize;
    const sceneEpoch = this.sceneEpoch + Number(reset);
    command.observeSubmission({
      submitted: () => {
        this.sceneEpoch = sceneEpoch;
        this.sourceSceneEpoch = input.sceneEpoch;
        this.voxelSize = settings.voxelSize;
      },
      aborted: () => {},
      failed: () => {},
    });
    const assertPreparing = (): void => {
      if (this.stopped || command.closed) {
        throw new Error("SCGI preparation belongs to a cancelled command");
      }
    };
    // Only submission advances the retirement fence. An aborted frame must
    // never replace the last successful consumer with a rejected future.
    command.observeSubmission({
      submitted: (fence) => {
        this.lastFence = fence;
      },
      aborted: () => {
        this.retireEstimator();
      },
      failed: () => {
        this.runtime.poison(new Error("SCGI submission failed"), this.deviceEpoch);
      },
    });
    const worldChanged = this.scenes.current?.runtime !== world;
    if (worldChanged) {
      this.retireEstimator();
    }
    const camera = [
      view.camera.camera.transform.matrix[12]!,
      view.camera.camera.transform.matrix[13]!,
      view.camera.camera.transform.matrix[14]!,
    ] as const;
    const configuration = JSON.stringify([
      width,
      height,
      settings.resolution,
      settings.cascades,
      settings.patches,
      settings.updates,
      settings.requests,
      settings.bounceRequests,
      settings.batchRays,
      world.virtualGeometry !== null,
    ]);
    if (this.configuration !== configuration) {
      const plan = await this.runtime.configure(
        { enabled: true, hasGeometry: true, hasLitMaterials: true },
        {
          width,
          height,
          resolution: settings.resolution,
          cascades: settings.cascades,
          patches: settings.patches,
          updates: settings.updates,
          requests: settings.requests,
          bounceRequests: settings.bounceRequests,
          rayBatch: settings.batchRays,
        },
      );
      assertPreparing();
      [this.cache, this.anchors, this.filter] = await Promise.all([
        ScgiCache.create(command.device, plan!),
        ScgiAnchors.create(command.device, plan!, world.virtualGeometry !== null),
        ScgiFilter.create(command.device, plan!),
      ]);
      assertPreparing();
      this.configuration = configuration;
      this.retireEstimator();
    }
    let query = worldChanged ? null : this.scenes.current;
    const delayed = query?.delayedCuts;
    const desiredCuts = input.products.map((product) => {
      const published = delayed?.find((cut) => cut.descriptor === product.descriptor);
      if (published !== undefined) {
        this.exactCuts.set(product.descriptor, published);
      }
      const cut = published ?? this.exactCuts.get(product.descriptor);
      if (cut !== undefined) {
        return cut;
      }
      const exact = geometryQueryCut(product.descriptor);
      this.exactCuts.set(product.descriptor, exact);
      return exact;
    });
    for (let index = 0; index < input.products.length; index++) {
      input.streaming?.requestQueryCut(input.products[index]!, desiredCuts[index]!);
    }
    // Cold IO is not a render-frame failure. Admit an explicitly unknown asset
    // until its entire cut is frame-readable. The GPU certificate prevents a
    // partial AS from ever fabricating a physical environment miss.
    const cuts = desiredCuts.map((cut, index) =>
      input.products[index]!.queryPagesAvailable(cut.pages, command)
        ? cut
        : geometryQueryCut(
            cut.descriptor,
            cut.assets.map(() => ({ active: false, domain: null, maximumError: 0 })),
          ),
    );
    if (query !== null) {
      // Revision mismatch is a normal new snapshot, not an exception hidden by
      // a stale-scene fallback. Capture the same pending command publication.
      if (
        !query.sourceInstances.isCurrent(command) ||
        !query.materials.source.isCurrent(command) ||
        !query.matchesProducts(input.products) ||
        query.profile.primitiveCapacity !== settings.primitiveCapacity ||
        query.profile.maximumBytes !== settings.queryMaximumBytes ||
        query.profile.workingSet?.voxelSize !== settings.voxelSize ||
        !query.matchesCuts(cuts)
      ) {
        query = null;
      }
    }
    if (query === null) {
      const candidate = await ScgiQueryScene.create(
        command.device,
        {
          deviceEpoch: this.deviceEpoch,
          originEpoch: 0,
          primitiveCapacity: settings.primitiveCapacity,
          maximumBytes: settings.queryMaximumBytes,
          queryCuts: cuts,
          workingSet: { voxelSize: settings.voxelSize, receiver: camera },
          subgroup: command.device.features.has("subgroups"),
        },
        world,
        this.graphics.gpu_scene,
        input.products,
        this.graphics.resource_accounting,
        command,
        undefined,
        this.scenes.current ?? undefined,
      );
      if (this.stopped || command.closed) {
        candidate.destroy();
        throw new Error("SCGI scene preparation cancelled at the frame boundary");
      }
      this.scenes.stage(candidate, command);
      if (this.queryRevision >= 0xfffffffd) {
        throw new RangeError("SCGI query publication revision exhausted");
      }
      this.queryRevisions.set(candidate, ++this.queryRevision);
      query = candidate;
      this.retireEstimator();
    } else {
      query.observeUse(command);
    }
    const sourceCount = Math.max(1, query.sourceInstances.count);
    if (this.invalidation === null || this.invalidation.capacity < sourceCount) {
      const previous = this.invalidation;
      this.invalidation = null;
      // Retire before awaiting replacement: cancellation must not lose the
      // previous owner when the new allocation has not been installed yet.
      previous?.retire(this.lastFence);
      const invalidation = await ScgiInvalidation.create(command.device, sourceCount);
      if (this.stopped || command.closed) {
        invalidation.destroy();
        assertPreparing();
      }
      this.invalidation = invalidation;
    }
    const estimatorKey = JSON.stringify([
      configuration,
      settings.hemisphereSamples,
      settings.connectionSamples,
      settings.lightSamples,
      settings.maximumLights,
      settings.multiBounce,
      input.authoredEnvironment,
      input.physical !== null,
    ]);
    const environment = input.authoredEnvironment
      ? ("authored-preserve-asset" as const)
      : input.physical === null
        ? ("black" as const)
        : ("physical-scattered-sky" as const);
    const estimatorInput = {
      scene: query,
      lights: input.lights,
      physical: input.physical,
      environment,
      authoredSolarDisk: input.authoredEnvironment ? ("embedded" as const) : ("absent" as const),
      view: view.camera.camera.view_matrix,
      camera,
      coneWidth: 0,
      coneSpread: 2 / (height * Math.abs(view.camera.projection_matrix[5]!)),
      rayDistance: Infinity,
      environmentScale: 1,
      environmentEpoch: Math.max(
        1,
        input.physical?.queryGeneration ?? input.lights.authoredIbl.publicationRevision,
      ),
      lightingEpoch: Math.max(1, input.lights.publicationRevision),
      multiBounce: settings.multiBounce,
      powerSampling: true,
      normalCosine: 0.9,
      planeDistanceScale: 0.02,
    };
    if (
      this.estimator === null ||
      this.estimatorKey !== estimatorKey ||
      !this.estimator.refresh(estimatorInput)
    ) {
      this.retireEstimator();
      // Same configured plan is used by every producer; no independent GI arena.
      const transaction = this.runtime.prepare(command, { scene: sceneEpoch, view: input.viewEpoch })!;
      this.estimator = await ScgiEstimator.create(
        command.device,
        transaction.workset.plan,
        {
          hemisphereSamples: settings.hemisphereSamples,
          connectionSamples: settings.connectionSamples,
          lightSamples: settings.lightSamples,
          maximumLights: settings.maximumLights,
          batchRays: settings.batchRays,
        },
        estimatorInput,
      );
      if (this.stopped || command.closed) {
        this.estimator.destroy();
        this.estimator = null;
        assertPreparing();
      }
      this.estimatorKey = estimatorKey;
      return this.frame(input, transaction, query, camera);
    }
    return this.frame(
      input,
      this.runtime.prepare(command, { scene: sceneEpoch, view: input.viewEpoch })!,
      query,
      camera,
    );
  }

  private async frame(
    input: {
      command: ShadeGPUCommandContext;
      settings: SurfaceCacheGiSettings;
      view: GPUViewContext;
      previousValid: boolean;
    },
    transaction: ScgiFrameTransaction,
    query: ScgiQueryScene,
    camera: readonly [number, number, number],
  ): Promise<ScgiRendererFrame> {
    const estimatorInput = this.estimator!.input;
    const lighting = JSON.stringify([
      this.estimatorKey,
      estimatorInput.lights.publicationRevision,
      estimatorInput.lights.source.version,
      estimatorInput.lights.authoredIbl.publicationRevision,
      estimatorInput.physical?.queryGeneration ?? 0,
      query.sourceInstances.contentRevision,
      query.materials.source.revision,
      this.queryRevisions.get(query),
    ]);
    const lightingChanged = lighting !== this.committedLighting;
    const gatherKey = JSON.stringify([
      input.settings.gatherTile,
      input.settings.gatherDirections,
      input.settings.gatherBatchRays,
      input.settings.gatherDistance,
    ]);
    if (!input.settings.gather || this.gatherKey !== gatherKey) {
      this.gather?.retire();
      this.gather = null;
      this.gatherKey = "";
    }
    if (input.settings.gather && this.gather === null) {
      const candidate = await ScgiGather.create(
        input.command.device,
        transaction.workset.plan,
        this.estimator!,
        input.settings,
        query.runtime.virtualGeometry !== null,
        this.graphics.resource_accounting,
      );
      if (this.stopped || input.command.closed) {
        candidate.retire();
        throw new Error("SCGI gather preparation cancelled");
      }
      this.gather = candidate;
      this.gatherKey = gatherKey;
    }
    const gather =
      this.gather?.prepare(
        transaction,
        input.view,
        input.settings,
        camera,
        input.previousValid && !lightingChanged && transaction.publication.previousWorldField !== null,
      ) ?? null;
    input.command.observeSubmission({
      submitted: () => {
        this.committedLighting = lighting;
      },
      aborted: () => {},
      failed: () => {},
    });
    return {
      owner: this,
      transaction,
      query,
      estimator: this.estimator!,
      settings: input.settings,
      view: input.view,
      camera,
      previousValid: input.previousValid,
      lightingChanged,
      queryRevision: this.queryRevisions.get(query)!,
      gather,
    };
  }

  encode(frame: ScgiRendererFrame, job: PackedVisibilityJob, visibility: GPUTextureView): void {
    const { transaction, query, view, settings } = frame;
    query.encodeWorkingSet(transaction.command);
    this.runtime.encode(transaction);
    const geometry = nativeWinnerGeometry(
      job.assets,
      job.prepared.workSet.frameVertices,
      job.prepared.workSet.meshletWorkCandidate!.queue,
      job.prepared.workSet.frameInstances.records,
      job.runtime,
    );
    const previous = view.gpu_previous_camera_state;
    this.anchors.encodeSceneAnchors(
      transaction,
      {
        scene: this.graphics.gpu_scene,
        frameOwner: this.graphics.frame_instances,
        frameInstances: job.prepared.workSet.frameInstances,
        materials: query.materials.source,
        work: geometry.meshletWork,
        metadata: geometry.arena,
        vertices: geometry.vertexPayload,
        visibility,
        source: geometry.source,
        sourcePayload: geometry.sourcePayload,
        product: job.runtime.virtualGeometry ?? undefined,
      },
      {
        currentView: view.camera.camera.view_matrix,
        inverseViewProjection: view.camera.view_projection_matrix_inverse,
        previousView: previous.camera.view_matrix,
        previousProjection: previous.projection_matrix,
        previousInverseViewProjection: previous.view_projection_matrix_inverse,
        camera: frame.camera,
        previousValid: frame.previousValid,
      },
    );
    const serial = transaction.publication.generation;
    const dirty = this.invalidation!.encode(
      transaction,
      query.sourceInstances,
      Math.max(1, query.materials.source.revision),
      settings.voxelSize,
    );
    this.cache.encode(transaction, {
      frame: serial,
      originEpoch: 1,
      camera: frame.camera,
      voxelSize: settings.voxelSize,
      bounceEnabled: settings.multiBounce,
      evictionAge: 120,
      moveBudget: 64,
      normalCosine: 0.9,
      planeDistanceScale: 0.02,
      updateAge: 8,
      varianceThreshold: 0.1,
      gpuDirty: dirty,
    });
    this.anchors.encodeSeeds(transaction, {
      distance: settings.voxelSize * 0.02,
      normalCosine: 0.9,
      tangentDistance: settings.voxelSize,
    });
    transaction.command.enterTimingStage("scgi-estimator");
    frame.estimator.encode(transaction, {
      view: view.camera.camera.view_matrix,
      camera: frame.camera,
      coneWidth: 0,
      coneSpread: 2 / (transaction.publication.extent[1] * Math.abs(view.camera.projection_matrix[5]!)),
    });
    transaction.command.enterTimingStage("scgi-filter");
    this.filter.encode(transaction, surfaceCacheGiFilter(settings, serial, frame.queryRevision));
    if (frame.gather !== null) {
      frame.gather.owner.encodePrevious(frame.gather);
      frame.gather.owner.encodeRequests(frame.gather);
    }
  }

  encodeGather(frame: ScgiRendererFrame): void {
    if (frame.gather === null) {
      throw new Error("SCGI gather stage has no prepared owner");
    }
    frame.gather.owner.encode(frame.gather);
  }

  private retireEstimator(): void {
    this.gather?.retire();
    this.gather = null;
    this.gatherKey = "";
    const previous = this.estimator;
    this.estimator = null;
    this.estimatorKey = "";
    if (previous !== null) {
      previous.retire(this.lastFence);
    }
  }

  retire(fence = this.lastFence): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.lastFence = fence;
    this.scenes.retire(fence);
    this.retireEstimator();
    const invalidation = this.invalidation;
    if (invalidation !== null) {
      invalidation.retire(fence);
    }
    this.runtime.destroy();
  }
}
