import {
  BoxGeometry,
  buildBoxSourceGeometry,
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  Mesh,
  ShadeDataType,
  ShadeImage,
  ShadeTexture,
  ShadeTransparencyMode,
  INSTANCE_SOURCE_FLAGS,
  RenderDebugView,
  type FrameProfileSnapshot,
  type PackedSceneSource
} from "../../../OEngine/src/index.ts";
import { GPU_MESHLET_DRAW_COUNT } from "../../../OEngine/src/gpu/GpuMeshletRasterWorkAbi.ts";
import {
  VALIDATION_FIXTURE_KEY,
  VALIDATION_PROTOCOL_SCHEMA_VERSION,
  validationAssertion,
  validationError,
  type ValidationAssertion,
  type ValidationFixture,
  type ValidationScenarioRequest,
  type ValidationScenarioResult
} from "../fixture-protocol.ts";
import {
  CanonicalPackedRuntime,
  type CanonicalRuntimeCameraPose
} from "../shared/canonical-runtime.ts";
import { FixtureState } from "../shared/fixture-state.ts";
import {
  packedFrameHasNoLegacyGeometryOwners,
  shadowFeatureIsCold
} from "../shared/packed-owner-evidence.ts";
import { createPackedBoxScene, solidMaterial } from "../shared/packed-scene.ts";
import {
  hasGpuFailure,
  validationAdapter,
  validationDiagnostics
} from "../shared/runtime-evidence.ts";

const DEFAULT_POSE: CanonicalRuntimeCameraPose = {
  position: [0, 3, 14],
  target: [0, 1, -1],
  far: 250
};
const NEAR_POSE: CanonicalRuntimeCameraPose = {
  position: [0, 3, 14],
  target: [0, 1, -1],
  far: 250
};
const FAR_POSE: CanonicalRuntimeCameraPose = {
  position: [0, 11, 74],
  target: [0, 1, -1],
  far: 250
};

const canvas = required<HTMLCanvasElement>("gpu-canvas");
const statusElement = required<HTMLElement>("status");
let disposed = false;
const runtime = new CanonicalPackedRuntime({
  canvas,
  camera: DEFAULT_POSE,
  source: createVisibilitySource,
  shadows: true,
  onDeviceLost: (message) => {
    state.deviceLost({ name: "GPUDeviceLost", message });
    showStatus();
  }
});
const state = new FixtureState({
  fixtureId: "visibility",
  canvas,
  frame: () => runtime.frame,
  adapter: () => validationAdapter(runtime.renderer?.adapter_info ?? null, runtime.renderer?.device ?? null),
  diagnostics: () => validationDiagnostics(runtime.renderer?.profiler.diagnostics)
});
const fixture: ValidationFixture = { getSnapshot: () => state.snapshot(), runScenario, dispose };
window[VALIDATION_FIXTURE_KEY] = fixture;

void runtime.initialize().then(async () => {
  if (runtime.renderer === null) throw new Error("Visibility runtime has no Renderer");
  await runtime.waitForFrames(3);
  state.ready();
  showStatus();
}).catch(failFixture);

async function runScenario(request: ValidationScenarioRequest): Promise<ValidationScenarioResult> {
  const supported = ["basic", "meshlet-work-overflow", "meshlet-work-portable", "selective-risk", "large-triangle-setup", "frustum", "occlusion", "lod-near", "lod-far", "camera-cut", "debug", "shadow", "shadow-toggle", "shadow-scene-parity", "transform-patch"];
  if (!supported.includes(request.scenarioId)) {
    return failedScenario(request, new Error(`Unknown visibility scenario '${request.scenarioId}'`));
  }
  const startedFrame = runtime.frame;
  state.start(request.runId, request.scenarioId);
  showStatus();
  try {
    const assertions: ValidationAssertion[] = [];
    const evidence: Record<string, unknown> = {};
    let completed: FrameProfileSnapshot;
    let shadowRendered: FrameProfileSnapshot | null = null;
    if (runtime.renderer === null) throw new Error("Visibility runtime is not initialized");
    runtime.renderer.packed_meshlet_work_candidate_capacity =
      request.scenarioId === "meshlet-work-overflow" ? 1 : 0;
    runtime.renderer.packed_meshlet_work_compaction =
      request.scenarioId === "meshlet-work-portable" ? "portable" : "auto";
    runtime.renderer.packed_triangle_setup_enabled =
      request.scenarioId === "large-triangle-setup";
    runtime.renderer.packed_triangle_setup_threshold_pixels = 1;

    if (request.scenarioId === "lod-near" || request.scenarioId === "lod-far") {
      const renderer = runtime.renderer;
      const scene = runtime.scene;
      if (renderer === null || scene === null) throw new Error("Visibility runtime is not initialized");
      const visibilityBefore = renderer.gpuSceneEvidence().patchedVisibilityCount;
      renderer.queuePackedScenePatch(scene, {
        frameId: renderer.frame_count + 1,
        visibility: {
          indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
          // Isolate one high-density geometry so near/far compares the same
          // visible set instead of measuring a wider far-view frustum.
          flags: new Uint32Array([
            0, 0, 0, 0,
            INSTANCE_SOURCE_FLAGS.Active |
              INSTANCE_SOURCE_FLAGS.CastsShadow |
              INSTANCE_SOURCE_FLAGS.ReceivesShadow,
            0
          ])
        }
      });
      let isolated = await runtime.waitForCounters(runtime.frame);
      for (let attempt = 0; attempt < 6 &&
        renderer.gpuSceneEvidence().patchedVisibilityCount === visibilityBefore; attempt++) {
        isolated = await runtime.waitForCounters(isolated.frameIndex);
      }
      evidence.isolatedVisibleInstanceCount = 1;
      const near = await samplePose(NEAR_POSE, 3);
      const far = await samplePose(FAR_POSE, 3);
      const nearClusters = near.gpuCounters.values.selectedClusters ?? 0;
      const farClusters = far.gpuCounters.values.selectedClusters ?? 0;
      evidence.nearSelectedClusters = nearClusters;
      evidence.farSelectedClusters = farClusters;
      evidence.nearRasterTriangles = near.gpuCounters.values.hwTriangles ?? 0;
      evidence.farRasterTriangles = far.gpuCounters.values.hwTriangles ?? 0;
      assertions.push(validationAssertion("lod-work-produced", nearClusters > 0 && farClusters > 0, "Both near and far views produced hierarchy work", { nearClusters, farClusters }, "> 0"));
      assertions.push(validationAssertion("lod-distance-reduces-work", nearClusters >= farClusters, "Far view does not select more cluster work than near view", { nearClusters, farClusters }, "near >= far"));
      assertions.push(validationAssertion("lod-raster-consumer", (near.gpuCounters.values.hwTriangles ?? 0) > 0 && (far.gpuCounters.values.hwTriangles ?? 0) > 0, "Near and far LOD selections both reached the exact-raster consumer", {
        near: near.gpuCounters.values.hwTriangles ?? 0,
        far: far.gpuCounters.values.hwTriangles ?? 0
      }, "> 0"));
      completed = request.scenarioId === "lod-near"
        ? await samplePose(NEAR_POSE, 2)
        : far;
    } else if (request.scenarioId === "camera-cut") {
      const before = await samplePose(DEFAULT_POSE, 2);
      const invalidationsBefore = before.counters["hzb.historyInvalidations"] ?? 0;
      const cascadeRevisionBefore = runtime.renderer?.gpuOwnerCreationEvidence().shadow.directionalCameraRevision ?? 0;
      runtime.setCamera({ position: [12, 7, 10], target: [0, 1, -1], far: 250 });
      runtime.renderer?.indicate_view_change();
      completed = await runtime.waitForCounters(runtime.frame);
      const invalidationsAfter = completed.counters["hzb.historyInvalidations"] ?? 0;
      const cascadeRevisionAfter = runtime.renderer?.gpuOwnerCreationEvidence().shadow.directionalCameraRevision ?? 0;
      evidence.historyInvalidationsBefore = invalidationsBefore;
      evidence.historyInvalidationsAfter = invalidationsAfter;
      evidence.historyValid = completed.counters["hzb.historyValid"] ?? 0;
      evidence.cascadeRevisionBefore = cascadeRevisionBefore;
      evidence.cascadeRevisionAfter = cascadeRevisionAfter;
      assertions.push(validationAssertion("camera-cut-invalidates-hzb", invalidationsAfter > invalidationsBefore, "The explicit camera cut invalidated HZB history", { invalidationsBefore, invalidationsAfter }, "after > before"));
      assertions.push(validationAssertion("camera-cut-updates-cascades", cascadeRevisionAfter > cascadeRevisionBefore, "The Shadow Feature recomputed directional cascade cameras after a camera cut", { cascadeRevisionBefore, cascadeRevisionAfter }, "after > before"));
    } else if (request.scenarioId === "debug") {
      const renderer = runtime.renderer;
      if (renderer === null) throw new Error("Visibility runtime is not initialized");
      renderer.render_debug_view = RenderDebugView.VisibilityKey;
      completed = await runtime.waitForCounters(runtime.frame);
      const graph = renderer.mainFrameGraphEvidence();
      const executable = new Set(graph?.dump.executablePassOrder ?? []);
      const passNames = (graph?.dump.passes ?? [])
        .filter((pass) => executable.has(pass.id))
        .map((pass) => pass.name);
      const debugPassNames = passNames.filter((name) => /debug/i.test(name));
      evidence.debugPassNames = debugPassNames;
      evidence.graphCacheKey = graph?.cacheKey ?? null;
      assertions.push(validationAssertion(
        "debug-view-executable",
        debugPassNames.length > 0,
        "A supported debug view added one executable main-graph consumer",
        debugPassNames,
        "at least one debug pass"
      ));
      renderer.render_debug_view = RenderDebugView.None;
    } else if (request.scenarioId === "shadow") {
      const renderer = runtime.renderer;
      const scene = runtime.scene;
      if (renderer === null || scene === null) throw new Error("Visibility runtime is not initialized");
      renderer.queuePackedScenePatch(scene, {
        frameId: renderer.frame_count + 1,
        materials: {
          indices: new Uint32Array([0]),
          materialIndices: new Uint32Array([3])
        }
      });
      completed = await runtime.waitForCounters(runtime.frame);
      for (let attempt = 0; attempt < 8 && (
        (completed.counters["shadow.packedCascadeDraws"] ?? 0) === 0 ||
        (completed.gpuCounters.values.shadowAlphaRasterWork ?? 0) === 0
      ); attempt++) {
        completed = await runtime.waitForCounters(completed.frameIndex);
      }
      shadowRendered = completed;
      completed = await runtime.waitForCounters(completed.frameIndex);
      for (let attempt = 0; attempt < 6 && (
        (completed.counters["shadow.directionalCameraCacheHits"] ?? 0) === 0 ||
        (completed.counters["shadow.directionalRasterSkips"] ?? 0) === 0
      ); attempt++) {
        completed = await runtime.waitForCounters(completed.frameIndex);
      }
    } else if (request.scenarioId === "shadow-toggle") {
      const renderer = runtime.renderer;
      if (renderer === null) throw new Error("Visibility runtime is not initialized");
      renderer.configure({ features: { shadows: false } });
      const off = await runtime.waitForCounters(runtime.frame);
      const offOwners = renderer.gpuOwnerCreationEvidence();
      evidence.shadowOffOwners = offOwners.shadow;
      evidence.shadowOffCounters = {
        atlasBytes: off.counters["shadow.atlasBytes"] ?? 0,
        cascadeDraws: off.counters["shadow.packedCascadeDraws"] ?? 0
      };
      assertions.push(validationAssertion("shadow-toggle-off-cold", shadowFeatureIsCold(offOwners) && (off.counters["shadow.atlasBytes"] ?? 0) === 0 && (off.counters["shadow.packedCascadeDraws"] ?? 0) === 0, "Toggling shadows off retired the atlas, Pass and work owners and produced zero shadow counters", { owners: offOwners.shadow, counters: evidence.shadowOffCounters }));
      renderer.configure({ features: { shadows: true } });
      completed = await runtime.waitForCounters(off.frameIndex);
      for (let attempt = 0; attempt < 8 &&
        (completed.counters["shadow.packedCascadeDraws"] ?? 0) === 0; attempt++) {
        completed = await runtime.waitForCounters(completed.frameIndex);
      }
      const onOwners = renderer.gpuOwnerCreationEvidence();
      assertions.push(validationAssertion("shadow-toggle-on-restored", onOwners.shadow.featureCount === 1 && onOwners.shadow.atlasCount === 1 && onOwners.shadow.rasterPassCount === 1 && (completed.counters["shadow.packedCascadeDraws"] ?? 0) > 0, "Toggling shadows on recreated exactly one Render-owned Shadow Feature and resumed cascade raster", { owners: onOwners.shadow, cascadeDraws: completed.counters["shadow.packedCascadeDraws"] ?? 0 }));
    } else if (request.scenarioId === "shadow-scene-parity") {
      const renderer = runtime.renderer;
      const scene = runtime.scene;
      if (renderer === null || scene === null) throw new Error("Visibility runtime is not initialized");
      renderer.queuePackedScenePatch(scene, {
        frameId: renderer.frame_count + 1,
        materials: {
          indices: new Uint32Array([0]),
          materialIndices: new Uint32Array([0])
        }
      });
      let packedProfile = await runtime.waitForCounters(runtime.frame);
      for (let attempt = 0; attempt < 8 &&
        (packedProfile.counters["shadow.packedCascadeDraws"] ?? 0) === 0; attempt++) {
        packedProfile = await runtime.waitForCounters(packedProfile.frameIndex);
      }
      const packedShadow = renderer.gpuOwnerCreationEvidence().shadow;
      runtime.stop();
      await renderer.releasePackedScene(scene);
      const material = solidMaterial([0.2, 0.72, 0.92, 1], 0.4);
      const casterGeometry = new BoxGeometry(3, 3, 3);
      const caster = Mesh.from(casterGeometry, material);
      caster.transform_local.position.set(0, 1.5, 0);
      scene.addChild(caster);
      const groundGeometry = new BoxGeometry(14, 0.2, 14);
      const ground = Mesh.from(groundGeometry, solidMaterial([0.22, 0.24, 0.28, 1], 0.9));
      ground.transform_local.position.set(0, -0.1, 0);
      scene.addChild(ground);
      const recipe = createGeometryCookRecipe();
      await renderer.uploadScene(scene, [
        {
          geometry: casterGeometry,
          asset: (await cookGeometryAssetPackage(
            buildBoxSourceGeometry(3, 3, 3),
            recipe
          )).asset
        },
        {
          geometry: groundGeometry,
          asset: (await cookGeometryAssetPackage(
            buildBoxSourceGeometry(14, 0.2, 14),
            recipe
          )).asset
        }
      ]);
      runtime.start();
      completed = await runtime.waitForCounters(packedProfile.frameIndex);
      for (let attempt = 0; attempt < 8 &&
        (completed.counters["shadow.packedCascadeDraws"] ?? 0) === 0; attempt++) {
        completed = await runtime.waitForCounters(completed.frameIndex);
      }
      const ordinaryShadow = renderer.gpuOwnerCreationEvidence().shadow;
      const splitDelta = maximumArrayDelta(
        packedShadow.directionalCascadeSplits,
        ordinaryShadow.directionalCascadeSplits
      );
      const layoutDelta = maximumArrayDelta(
        packedShadow.directionalCascadeLayouts.flat(),
        ordinaryShadow.directionalCascadeLayouts.flat()
      );
      evidence.packedShadow = packedShadow;
      evidence.ordinaryShadow = ordinaryShadow;
      evidence.cascadeSplitMaximumDelta = splitDelta;
      evidence.cascadeLayoutMaximumDelta = layoutDelta;
      assertions.push(validationAssertion("packed-scene-cascade-parity", splitDelta <= 1e-6 && layoutDelta <= 1e-6, "Packed and ordinary Scene adapters produced the same cascade splits and atlas layout", { splitDelta, layoutDelta }, "<= 1e-6"));
      assertions.push(validationAssertion("ordinary-scene-shadow-unified", ordinaryShadow.featureCount === 1 && ordinaryShadow.atlasCount === 1 && ordinaryShadow.rasterPassCount === 1 && (completed.counters["shadow.packedCascadeDraws"] ?? 0) > 0, "The ordinary Scene adapter used the shared shadow work and raster consumer", { owner: ordinaryShadow, rasterDraws: completed.counters["shadow.packedCascadeDraws"] ?? 0 }));
    } else if (request.scenarioId === "transform-patch") {
      const renderer = runtime.renderer;
      const scene = runtime.scene;
      if (renderer === null || scene === null) throw new Error("Visibility runtime is not initialized");
      const before = renderer.gpuSceneEvidence().patchedTransformCount;
      const transform = new Float32Array(16);
      transform[0] = 1;
      transform[5] = 1;
      transform[10] = 1;
      transform[12] = -3.5;
      transform[13] = 1.25;
      transform[15] = 1;
      renderer.queuePackedScenePatch(scene, {
        frameId: renderer.frame_count + 1,
        transforms: { indices: new Uint32Array([0]), transforms: transform }
      });
      completed = await runtime.waitForCounters(runtime.frame);
      let after = renderer.gpuSceneEvidence().patchedTransformCount;
      for (let attempt = 0; attempt < 6 && after === before; attempt++) {
        completed = await runtime.waitForCounters(completed.frameIndex);
        after = renderer.gpuSceneEvidence().patchedTransformCount;
      }
      evidence.patchedTransformsBefore = before;
      evidence.patchedTransformsAfter = after;
      assertions.push(validationAssertion("transform-patch-applied", after === before + 1, "The explicit Packed transform patch was consumed", { before, after }, "after = before + 1"));
    } else {
      runtime.setCamera(DEFAULT_POSE);
      if (request.scenarioId === "occlusion") await runtime.waitForFrames(8);
      completed = await runtime.waitForCounters(runtime.frame);
    }

    const counters = completed.gpuCounters.values;
    Object.assign(evidence, {
      candidateInstances: counters.candidateInstances ?? 0,
      visibleInstances: counters.visibleInstances ?? 0,
      rejectedFrustum: counters.rejectedFrustum ?? 0,
      rejectedHzb: counters.rejectedHzb ?? 0,
      selectedClusters: counters.selectedClusters ?? 0,
      rasterTriangles: counters.hwTriangles ?? 0,
      geometryNodesTested: counters.geometryNodesTested ?? 0,
      geometryClustersAccepted: counters.geometryClustersAccepted ?? 0,
      geometryMeshletsSelected: counters.geometryMeshletsSelected ?? 0,
      geometryMeshletWorksProduced: counters.geometryMeshletWorksProduced ?? 0,
      geometryCandidateTriangles: counters.geometryCandidateTriangles ?? 0,
      geometryRiskyTriangles: counters.geometryRiskyTriangles ?? 0,
      geometryExactSurvivedTriangles: counters.geometryExactSurvivedTriangles ?? 0,
      geometryRasterTriangles: counters.geometryRasterTriangles ?? 0,
      geometryPaddedVertices: counters.geometryPaddedVertices ?? 0,
      geometryVisiblePixels: counters.geometryVisiblePixels ?? 0,
      geometryQueueBytes: counters.geometryQueueBytes ?? 0,
      meshletQueueAttempted: counters.meshletQueueAttempted ?? 0,
      meshletQueueWritten: counters.meshletQueueWritten ?? 0,
      meshletQueueConsumed: counters.meshletQueueConsumed ?? 0,
      meshletQueueOverflow: counters.meshletQueueOverflow ?? 0,
      meshletQueueInvalid: counters.meshletQueueInvalid ?? 0,
      meshletBucketNonEmpty: counters.meshletBucketNonEmpty ?? 0,
      meshletBucketDraws: counters.meshletBucketDraws ?? 0,
      meshletSubgroupReservations: counters.meshletSubgroupReservations ?? 0,
      meshletPortableReservations: counters.meshletPortableReservations ?? 0,
      meshletIndirectInstances: counters.meshletIndirectInstances ?? 0,
      meshletRasterTriangles: counters.meshletRasterTriangles ?? 0,
      meshletRasterPixels: counters.meshletRasterPixels ?? 0,
      meshletRasterMatchedPixels: counters.meshletRasterMatchedPixels ?? 0,
      meshletRasterMismatchPixels: counters.meshletRasterMismatchPixels ?? 0,
      queueOverflowMask: counters.queueOverflowMask ?? 0,
      gpuCounterSchemaVersion: completed.gpuCounters.schemaVersion
    });
    if (request.scenarioId !== "shadow-scene-parity") {
      const overflowScenario = request.scenarioId === "meshlet-work-overflow";
      assertions.push(validationAssertion("candidate-work-produced", (counters.candidateInstances ?? 0) >= 6, "All fixed visibility candidates reached GPU work generation", counters.candidateInstances, ">= 6"));
      assertions.push(validationAssertion("visible-work-produced", (counters.visibleInstances ?? 0) > 0, "At least one instance remained visible", counters.visibleInstances, "> 0"));
      assertions.push(validationAssertion(
        "raster-work-produced",
        overflowScenario
          ? (counters.geometryRasterTriangles ?? 0) === 0
          : (counters.geometryRasterTriangles ?? 0) > 0,
        overflowScenario
          ? "Correctness-critical overflow suppressed every normal-path raster draw"
          : "Meshlet Hardware Visibility consumed normal-path triangle work",
        counters.geometryRasterTriangles,
        overflowScenario ? 0 : "> 0"
      ));
      assertions.push(validationAssertion(
        "geometry-truth-closed",
        (counters.geometryNodesTested ?? 0) > 0 &&
          (counters.geometryClustersAccepted ?? 0) > 0 &&
          (counters.geometryMeshletsSelected ?? 0) >= (counters.geometryClustersAccepted ?? 0) &&
          (counters.geometryCandidateTriangles ?? 0) >= (counters.geometryExactSurvivedTriangles ?? 0) &&
          (counters.geometryCandidateTriangles ?? 0) >= (counters.geometryRasterTriangles ?? 0) &&
          (overflowScenario
            ? (counters.geometryRasterTriangles ?? 0) === 0 &&
              (counters.geometryVisiblePixels ?? 0) === 0
            : (counters.geometryRasterTriangles ?? 0) > 0 &&
              (counters.geometryVisiblePixels ?? 0) > 0) &&
          (counters.geometryQueueBytes ?? 0) > 0,
        "Geometry truth distinguishes hierarchy, selected meshlets, exact/raster triangles, visible pixels and queue bytes",
        {
          nodesTested: counters.geometryNodesTested ?? 0,
          clustersAccepted: counters.geometryClustersAccepted ?? 0,
          meshletsSelected: counters.geometryMeshletsSelected ?? 0,
          candidateTriangles: counters.geometryCandidateTriangles ?? 0,
          exactSurvivedTriangles: counters.geometryExactSurvivedTriangles ?? 0,
          rasterTriangles: counters.geometryRasterTriangles ?? 0,
          visiblePixels: counters.geometryVisiblePixels ?? 0,
          queueBytes: counters.geometryQueueBytes ?? 0
        },
        overflowScenario
          ? "nodes/clusters/bytes > 0; candidate >= exact; raster = visible = 0"
          : "nodes/clusters/raster/pixels/bytes > 0; candidate >= exact and raster"
      ));
      const meshletQueue = {
        attempted: counters.meshletQueueAttempted ?? 0,
        written: counters.meshletQueueWritten ?? 0,
        consumed: counters.meshletQueueConsumed ?? 0,
        produced: counters.geometryMeshletWorksProduced ?? 0,
        overflow: counters.meshletQueueOverflow ?? 0,
        invalid: counters.meshletQueueInvalid ?? 0
      };
      const meshletBuckets = {
        nonEmpty: counters.meshletBucketNonEmpty ?? 0,
        draws: counters.meshletBucketDraws ?? 0,
        indirectInstances: counters.meshletIndirectInstances ?? 0,
        subgroupReservations: counters.meshletSubgroupReservations ?? 0,
        portableReservations: counters.meshletPortableReservations ?? 0
      };
      const meshletRaster = {
        triangles: counters.meshletRasterTriangles ?? 0,
        paddedVertices: counters.geometryPaddedVertices ?? 0,
        pixels: counters.meshletRasterPixels ?? 0,
        matchedPixels: counters.meshletRasterMatchedPixels ?? 0,
        mismatchPixels: counters.meshletRasterMismatchPixels ?? 0
      };
      if (request.scenarioId === "meshlet-work-overflow") {
        assertions.push(validationAssertion(
          "meshlet-work-overflow-all-or-nothing",
          meshletQueue.attempted > 0 &&
            meshletQueue.attempted - meshletQueue.written === meshletQueue.overflow &&
            meshletQueue.written === meshletQueue.consumed &&
            meshletQueue.produced === meshletQueue.written &&
            meshletQueue.overflow > 0 &&
            meshletQueue.invalid === 0 &&
            meshletBuckets.indirectInstances === 0 &&
            meshletRaster.triangles === 0 &&
            meshletRaster.pixels === 0 &&
            meshletRaster.mismatchPixels === 0,
          "Correctness-critical MeshletWork reservations fail per cluster without publishing partial ranges",
          { meshletQueue, meshletBuckets, meshletRaster },
          "attempted - written = overflow > 0; written = consumed = produced; all indirect/raster work = 0"
        ));
      } else {
        assertions.push(validationAssertion(
          "meshlet-work-normal-path-closed",
          meshletQueue.attempted > 0 &&
            meshletQueue.attempted === meshletQueue.written &&
            meshletQueue.written === meshletQueue.consumed &&
            meshletQueue.produced === meshletQueue.written &&
            meshletQueue.overflow === 0 &&
            meshletQueue.invalid === 0,
          "GPU MeshletWork normal producer and GPU validation consumer close without CPU queue readback",
          meshletQueue,
          "attempted = written = consumed = produced > 0; overflow = invalid = 0"
        ));
        assertions.push(validationAssertion(
          "meshlet-bucket-indirect-closed",
          meshletBuckets.nonEmpty > 0 &&
            meshletBuckets.nonEmpty <= GPU_MESHLET_DRAW_COUNT &&
            meshletBuckets.draws === GPU_MESHLET_DRAW_COUNT &&
            meshletBuckets.indirectInstances === meshletQueue.written,
          "GPU histogram/prefix generated all bounded draw records and preserved every MeshletWork instance",
          meshletBuckets,
          `0 < nonEmpty <= ${GPU_MESHLET_DRAW_COUNT}; draws = ${GPU_MESHLET_DRAW_COUNT}; indirectInstances = written`
        ));
        const portable = request.scenarioId === "meshlet-work-portable" ||
          !runtime.renderer.device.features.has("subgroups");
        assertions.push(validationAssertion(
          portable ? "portable-compaction-selected" : "subgroup-compaction-selected",
          portable
            ? meshletBuckets.portableReservations > 0 && meshletBuckets.subgroupReservations === 0
            : meshletBuckets.subgroupReservations > 0 && meshletBuckets.portableReservations === 0,
          portable
            ? "Portable shared-memory prefix fallback produced the queue"
            : "Negotiated subgroup ballot/prefix specialization produced the queue",
          meshletBuckets,
          portable ? "portable > 0; subgroup = 0" : "subgroup > 0; portable = 0"
        ));
        assertions.push(validationAssertion(
          "meshlet-bucket-hardware-raster-parity",
          meshletRaster.triangles > 0 &&
            meshletRaster.paddedVertices >= 0 &&
            meshletRaster.pixels > 0 &&
            meshletRaster.matchedPixels === meshletRaster.pixels &&
            meshletRaster.mismatchPixels === 0,
          "Standard bucket drawIndirect preserves reverse-Z/culling/coverage semantic identity against the production exact path",
          meshletRaster,
          "triangles/pixels > 0; matched = pixels; mismatch = 0"
        ));
      }
      assertions.push(validationAssertion("gpu-queue-no-overflow", (counters.queueOverflowMask ?? 0) === 0, "GPU work queues did not overflow", counters.queueOverflowMask, 0));
      if (request.scenarioId === "selective-risk") {
        assertions.push(validationAssertion(
          "selective-risk-exclusive",
          (counters.geometryRiskyTriangles ?? 0) > 0 &&
            (counters.geometryRiskyTriangles ?? 0) < (counters.geometryCandidateTriangles ?? 0) &&
            (counters.geometryExactSurvivedTriangles ?? 0) ===
              (counters.geometryRiskyTriangles ?? 0),
          "The GPU classifier routed only the explicit risk subset through the exclusive exact bucket range",
          {
            candidates: counters.geometryCandidateTriangles ?? 0,
            risky: counters.geometryRiskyTriangles ?? 0,
            exact: counters.geometryExactSurvivedTriangles ?? 0
          },
          "0 < risky = exact < candidates"
        ));
      }
      if (request.scenarioId === "large-triangle-setup") {
        assertions.push(validationAssertion(
          "large-triangle-setup-live",
          (counters.setupAttempted ?? 0) > 0 &&
            (counters.setupWritten ?? 0) > 0 &&
            (counters.setupVisiblePixelHits ?? 0) > 0 &&
            (counters.setupOverflow ?? 0) === 0,
          "The independent optional setup owner built V2-addressable records consumed by visible pixels",
          {
            attempted: counters.setupAttempted ?? 0,
            written: counters.setupWritten ?? 0,
            hits: counters.setupVisiblePixelHits ?? 0,
            fallbacks: counters.setupVisiblePixelFallbacks ?? 0,
            overflow: counters.setupOverflow ?? 0
          },
          "attempted/written/hits > 0; overflow = 0"
        ));
      }
    }
    if (request.scenarioId === "frustum") {
      assertions.push(validationAssertion("frustum-rejection-observed", (counters.rejectedFrustum ?? 0) > 0, "The off-axis object was rejected by the GPU frustum stage", counters.rejectedFrustum, "> 0"));
    }
    if (request.scenarioId === "occlusion") {
      assertions.push(validationAssertion("hzb-rejection-observed", (counters.rejectedHzb ?? 0) > 0, "The object behind the occluder was rejected by HZB", counters.rejectedHzb, "> 0"));
    }
    if (request.scenarioId === "shadow") {
      const rendered = shadowRendered ?? completed;
      const packedCascadeDraws = rendered.counters["shadow.packedCascadeDraws"] ?? 0;
      const atlasBytes = rendered.counters["shadow.atlasBytes"] ?? 0;
      const shadowAlphaRasterWork = rendered.gpuCounters.values.shadowAlphaRasterWork ?? 0;
      assertions.push(validationAssertion("packed-shadow-produced", packedCascadeDraws > 0 && atlasBytes > 0, "Packed CSM consumed the Packed material bindings and produced cascade work", { packedCascadeDraws, atlasBytes }, "> 0"));
      assertions.push(validationAssertion("alpha-tested-shadow-produced", shadowAlphaRasterWork > 0, "Packed CSM sampled an alpha-tested material through the shared TextureRef ABI", shadowAlphaRasterWork, "> 0"));
      assertions.push(validationAssertion("shadow-queue-no-overflow", (rendered.gpuCounters.values.shadowQueueOverflowMask ?? 0) === 0, "Packed shadow work queues reported their overflow contract and did not overflow the fixed fixture", rendered.gpuCounters.values.shadowQueueOverflowMask, 0));
      assertions.push(validationAssertion("directional-cache-hit", (completed.counters["shadow.directionalCameraCacheHits"] ?? 0) > 0 && (completed.counters["shadow.directionalRasterSkips"] ?? 0) > 0, "Stable camera/content reused cascade fit and skipped redundant directional raster", { cacheHits: completed.counters["shadow.directionalCameraCacheHits"] ?? 0, rasterSkips: completed.counters["shadow.directionalRasterSkips"] ?? 0 }, "> 0"));
    }
    const ownerCreation = runtime.renderer?.gpuOwnerCreationEvidence();
    evidence.ownerCreation = ownerCreation;
    assertions.push(validationAssertion("single-material-owner", ownerCreation !== undefined && ownerCreation.renderWorld.materialStoreCreated, "Visibility and Shadow used the authoritative material owner", ownerCreation?.renderWorld));
    assertions.push(validationAssertion("single-geometry-owner", ownerCreation !== undefined && packedFrameHasNoLegacyGeometryOwners(ownerCreation), "Visibility, HZB and Shadow used one Render World", ownerCreation?.scene));
    assertions.push(validationAssertion("render-shadow-owner", ownerCreation !== undefined && ownerCreation.shadow.featureCount === 1 && ownerCreation.shadow.atlasCount === 1 && ownerCreation.shadow.rasterPassCount === 1 && ownerCreation.shadow.workSetCount > 0 && ownerCreation.shadow.workBytes > 0, "Shadows are owned only by one Render-layer Shadow Feature with the unified raster consumer", ownerCreation?.shadow));
    if (request.scenarioId === "shadow") {
      const splits = ownerCreation?.shadow.directionalCascadeSplits ?? [];
      const layouts = ownerCreation?.shadow.directionalCascadeLayouts ?? [];
      assertions.push(validationAssertion("cascade-fit-and-layout", splits.length === 3 && splits[0]! > 0 && splits[0]! < splits[1]! && splits[1]! < splits[2]! && splits[2] === 1 && layouts.length === 3 && layouts.every((layout) => layout[2] > 0 && layout[3] > 0), "Directional cascade fit produced three monotonic splits and valid atlas layouts", { splits, layouts }));
    }
    const diagnostics = validationDiagnostics(runtime.renderer?.profiler.diagnostics);
    assertions.push(validationAssertion("gpu-diagnostics-clean", !hasGpuFailure(diagnostics), "WebGPU diagnostics are clean", diagnostics));

    const result: ValidationScenarioResult = {
      schemaVersion: VALIDATION_PROTOCOL_SCHEMA_VERSION,
      fixtureId: "visibility",
      runId: request.runId,
      scenarioId: request.scenarioId,
      status: assertions.every((assertion) => assertion.passed) ? "passed" : "failed",
      startedFrame,
      completedFrame: completed.frameIndex,
      evidence,
      assertions,
      diagnostics
    };
    state.finish();
    showStatus();
    return result;
  } catch (error) {
    state.finish();
    showStatus();
    return failedScenario(request, error, startedFrame);
  }
}

async function samplePose(
  pose: CanonicalRuntimeCameraPose,
  settleFrames: number
): Promise<FrameProfileSnapshot> {
  runtime.setCamera(pose);
  await runtime.waitForFrames(settleFrames);
  return runtime.waitForCounters(runtime.frame);
}

async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  await runtime.destroy();
  state.dispose();
  showStatus();
  delete window[VALIDATION_FIXTURE_KEY];
}

async function createVisibilitySource(): Promise<PackedSceneSource> {
  const visible = solidMaterial([0.2, 0.75, 0.95, 1], 0.35);
  const occluder = solidMaterial([0.14, 0.18, 0.24, 1], 0.85);
  const hidden = solidMaterial([0.95, 0.2, 0.18, 1], 0.5);
  const detail = solidMaterial([0.35, 0.9, 0.38, 1], 0.45);
  detail.transparency_mode = ShadeTransparencyMode.AlphaTested;
  detail.texture_albedo = createAlphaCheckerTexture();
  const source = await createPackedBoxScene([
    { size: [2, 2, 2], position: [-4, 1, 0], materialIndex: 0, debugId: 1 },
    { size: [5, 5, 1], position: [0, 2.5, 0], materialIndex: 1, debugId: 2, segments: [4, 4, 2] },
    { size: [0.75, 0.75, 0.75], position: [0, 1, -20], materialIndex: 2, debugId: 3, segments: [8, 8, 8] },
    { size: [2, 2, 2], position: [30, 1, 0], materialIndex: 0, debugId: 4 },
    { size: [3, 3, 3], position: [5, 1.5, -1], materialIndex: 3, debugId: 5, segments: [16, 16, 16] },
    { size: [1.5, 1.5, 1.5], position: [-7, 0.75, -3], materialIndex: 0, debugId: 6 }
  ], [visible, occluder, hidden, detail]);
  source.flags?.fill(INSTANCE_SOURCE_FLAGS.CastsShadow | INSTANCE_SOURCE_FLAGS.ReceivesShadow);
  return source;
}

function createAlphaCheckerTexture(): ShadeTexture {
  const image = ShadeImage.fromArrayBuffer(
    new Uint8Array([
      255, 255, 255, 255, 255, 255, 255, 0,
      255, 255, 255, 0, 255, 255, 255, 255
    ]).buffer,
    4,
    ShadeDataType.Uint8,
    2,
    2
  );
  const texture = ShadeTexture.from(image);
  texture.label = "validation-alpha-tested-shadow";
  return texture;
}

function maximumArrayDelta(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let maximum = 0;
  for (let index = 0; index < a.length; index++) {
    maximum = Math.max(maximum, Math.abs(a[index]! - b[index]!));
  }
  return maximum;
}

function failedScenario(request: ValidationScenarioRequest, error: unknown, startedFrame = runtime.frame): ValidationScenarioResult {
  const normalized = validationError(error);
  return {
    schemaVersion: VALIDATION_PROTOCOL_SCHEMA_VERSION,
    fixtureId: "visibility",
    runId: request.runId,
    scenarioId: request.scenarioId,
    status: "failed",
    startedFrame,
    completedFrame: Math.max(startedFrame + 1, runtime.frame),
    evidence: {},
    assertions: [validationAssertion("scenario-execution", false, normalized.message)],
    diagnostics: validationDiagnostics(runtime.renderer?.profiler.diagnostics),
    error: normalized
  };
}

function failFixture(error: unknown): void {
  state.fail(validationError(error));
  showStatus();
  console.error(error);
}

function showStatus(): void {
  statusElement.dataset.fixtureStatus = state.status;
  statusElement.textContent = state.status;
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}
