import {
  BoxGeometry,
  Mesh,
  ShadeDrawSide,
  ShadeIndirectLightingMode,
  ShadeTexture,
  ShadeTransparencyMode,
  openTextureAssetPackageV2,
  prepareKtx2TextureAssetPackageV2,
  uploadTextureAssetPackageV2,
  type FrameProfileSnapshot,
  type PackedSceneSource
} from "../../../OEngine/src/index.ts";
import {
  cookReferenceTextureAssetPackageV2 as cookTextureAssetPackageV2
} from "../../../OEngine/src/assets/codec/ReferenceTextureCodec.ts";
import {
  GPU_TEXTURE_REF_ABI_VERSION,
  GPU_TEXTURE_REF_BANK_MASK,
  GPU_TEXTURE_REF_BANK_SHIFT,
  GPU_TEXTURE_REF_LAYER_MASK,
  GPU_TEXTURE_REF_ROUTING_MASK,
  GPU_TEXTURE_REF_ROUTING_SHIFT,
  GPU_TEXTURE_REF_VERSION_MASK,
  GPU_TEXTURE_REF_VERSION_SHIFT,
  GPU_TEXTURE_REF_WGSL,
  decodeGpuTextureRef,
  encodeGpuTextureRef
} from "../../../OEngine/src/gpu/GpuTextureRefAbi.ts";
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
import { CanonicalPackedRuntime } from "../shared/canonical-runtime.ts";
import { packedFrameHasNoLegacyGeometryOwners } from "../shared/packed-owner-evidence.ts";
import { FixtureState } from "../shared/fixture-state.ts";
import { createPackedBoxScene, solidMaterial } from "../shared/packed-scene.ts";
import {
  hasGpuFailure,
  validationAdapter,
  validationDiagnostics
} from "../shared/runtime-evidence.ts";

const canvas = required<HTMLCanvasElement>("gpu-canvas");
const statusElement = required<HTMLElement>("status");
const ETC1S_MIP_FIXTURE_URL = new URL(
  "../../../OEngine/tests/fixtures/texture-codec/rgba-64x64-mipmap-etc1s.ktx2",
  import.meta.url
);
let disposed = false;
const runtime = new CanonicalPackedRuntime({
  canvas,
  camera: { position: [0, 3.5, 15], target: [0, 1, 0], far: 100 },
  source: createSurfaceSource,
  onDeviceLost: (message) => {
    state.deviceLost({ name: "GPUDeviceLost", message });
    showStatus();
  }
});
const state = new FixtureState({
  fixtureId: "surface",
  canvas,
  frame: () => runtime.frame,
  adapter: () => validationAdapter(runtime.renderer?.adapter_info ?? null, runtime.renderer?.device ?? null),
  diagnostics: () => validationDiagnostics(runtime.renderer?.profiler.diagnostics)
});
const fixture: ValidationFixture = { getSnapshot: () => state.snapshot(), runScenario, dispose };
window[VALIDATION_FIXTURE_KEY] = fixture;

void runtime.initialize().then(async () => {
  await runtime.waitForFrames(3);
  state.ready();
  showStatus();
}).catch(failFixture);

async function runScenario(request: ValidationScenarioRequest): Promise<ValidationScenarioResult> {
  const supported = ["basic", "textured", "material-switch", "texture-fallback", "texture-ref-oracle", "texture-package-bc", "texture-package-production", "texture-codec-production", "texture-codec-device-loss-recreate", "transparent", "scene-adapter", "lpv-baseline-pruning", "gtao-replacement"];
  if (!supported.includes(request.scenarioId)) {
    return failedScenario(request, new Error(`Unknown surface scenario '${request.scenarioId}'`));
  }
  const startedFrame = runtime.frame;
  state.start(request.runId, request.scenarioId);
  showStatus();
  try {
    const assertions: ValidationAssertion[] = [];
    const evidence: Record<string, unknown> = {};
    let profile: FrameProfileSnapshot;

    if (request.scenarioId === "gtao-replacement") {
      const renderer = runtime.renderer;
      if (renderer === null) throw new Error("Surface runtime is not initialized");
      renderer.configure({
        features: { ambientOcclusion: true },
        ao: {
          radiusMeters: 1,
          thicknessMeters: 1,
          resolutionScale: 0.5,
          temporalEnabled: true,
          sliceCount: 3,
          stepCount: 6,
          spatialStep: 1,
          temporalBlend: 0.95
        }
      });
      await runtime.waitForFrames(4);
      profile = await runtime.waitForCounters(runtime.frame - 1);
      for (let attempt = 0; attempt < 8 &&
        (profile.gpuCounters.values.aoHistoryAcceptedPixels ?? 0) === 0; attempt++) {
        profile = await runtime.waitForCounters(profile.frameIndex);
      }
      const onAo = renderer.ambientOcclusionEvidence();
      const onGraph = renderer.mainFrameGraphEvidence();
      if (onGraph === null) throw new Error("GTAO-on frame did not publish FrameGraph evidence");
      const onPasses = onGraph.dump.passes.filter((entry) => !entry.culled).map((entry) => entry.name);
      const onResources = onGraph.dump.resources.map((entry) => entry.name);
      const gtaoPasses = onPasses.filter((name) => /GTAO/i.test(name));
      const gtaoResources = onResources.filter((name) => /GTAO|ao_history|ao_output/i.test(name));
      const onCounters = {
        evaluated: profile.gpuCounters.values.aoEvaluatedPixels ?? 0,
        historyAccepted: profile.gpuCounters.values.aoHistoryAcceptedPixels ?? 0,
        historyRejected: profile.gpuCounters.values.aoHistoryRejectedPixels ?? 0
      };

      renderer.configure({ features: { ambientOcclusion: false } });
      await runtime.waitForFrames(3);
      const offProfile = await runtime.waitForCounters(profile.frameIndex);
      const offAo = renderer.ambientOcclusionEvidence();
      const offGraph = renderer.mainFrameGraphEvidence();
      if (offGraph === null) throw new Error("GTAO-off frame did not publish FrameGraph evidence");
      const offPasses = offGraph.dump.passes.filter((entry) => !entry.culled).map((entry) => entry.name);
      const offResources = offGraph.dump.resources.map((entry) => entry.name);
      const offGtaoPasses = offPasses.filter((name) => /GTAO/i.test(name));
      const offGtaoResources = offResources.filter((name) => /GTAO|ao_history|ao_output/i.test(name));

      Object.assign(evidence, {
        gtaoReplacement: {
          on: {
            runtime: onAo,
            passes: gtaoPasses,
            resources: gtaoResources,
            counters: onCounters,
            submits: profile.submits
          },
          off: {
            runtime: offAo,
            passes: offGtaoPasses,
            resources: offGtaoResources,
            counters: {
              evaluated: offProfile.gpuCounters.values.aoEvaluatedPixels ?? 0,
              historyAccepted: offProfile.gpuCounters.values.aoHistoryAcceptedPixels ?? 0,
              historyRejected: offProfile.gpuCounters.values.aoHistoryRejectedPixels ?? 0
            }
          }
        }
      });
      assertions.push(validationAssertion(
        "three-gtao-pinned-production-path",
        onAo.algorithm === "three-gtao-r186-oengine-wgsl" &&
          onAo.upstreamRevision === "148ef33ecb6d2502ff796d4554abd1549c95d519" &&
          onAo.sliceCount === 3 && onAo.stepCount === 6 &&
          onAo.traceDepthSamplesPerPixel === 36,
        "The ordinary opaque-lighting path runs the pinned Three.js r186-derived GTAO trace contract",
        onAo,
        "pinned revision, 3 directions, 6 steps and 36 bidirectional depth samples/pixel"
      ));
      assertions.push(validationAssertion(
        "gtao-packed-temporal-abi",
        onAo.momentsFormat === "rgba16float" &&
          onAo.finalVisibilityFormat === "r8unorm" &&
          onAo.bentNormalFormat === "rg16uint" &&
          onAo.momentsBytesPerPixel === 8 &&
          onAo.finalVisibilityBytesPerPixel === 1 &&
          onAo.bentNormalBytesPerPixel === 4 &&
          onAo.historyTextureCount === 2 &&
          onAo.historyBytes === onAo.aoPixels * 8 * 2,
        "AO moments and bent normal share one temporally filtered half-resolution history before the final compact split",
        onAo,
        "rgba16float history x2, r8unorm visibility and rg16uint bent normal"
      ));
      assertions.push(validationAssertion(
        "gtao-single-trace-temporal-consumer",
        gtaoPasses.filter((name) => name === "Three GTAO r186 horizon trace").length === 1 &&
          gtaoPasses.filter((name) => name === "GTAO spatial moments filter").length === 1 &&
          gtaoPasses.filter((name) => name === "GTAO temporal moments resolve").length === 1 &&
          gtaoPasses.filter((name) => name === "GTAO joint bilateral AO+bent-normal resolve").length === 1 &&
          !onPasses.some((name) => /SSAO/i.test(name)) &&
          onAo.rawPasses === 1 && onAo.spatialPasses === 1 &&
          onAo.temporalPasses === 1 && onAo.compositePasses === 1,
        "One GTAO trace feeds the shared AO+bent spatial/temporal chain and the opaque-lighting consumer",
        { gtaoPasses, runtime: onAo },
        "one pass per phase and no legacy SSAO pass"
      ));
      assertions.push(validationAssertion(
        "gtao-temporal-policy-executed",
        onAo.historyValid && onCounters.evaluated > 0 &&
          onCounters.historyAccepted + onCounters.historyRejected === onCounters.evaluated &&
          profile.submits.count === 1 && profile.submits.labels["Renderer/main-0"] === 1,
        "The GTAO temporal policy classifies every sampled pixel without adding a second submission",
        { historyValid: onAo.historyValid, counters: onCounters, submits: profile.submits },
        "history valid, accepted + rejected = evaluated > 0, one main submit"
      ));
      assertions.push(validationAssertion(
        "gtao-feature-off-zero-cost",
        !offAo.enabled && offAo.algorithm === "disabled" &&
          offAo.rawPasses === 0 && offAo.spatialPasses === 0 &&
          offAo.temporalPasses === 0 && offAo.compositePasses === 0 &&
          offAo.historyTextureCount === 0 && offAo.historyBytes === 0 &&
          offGtaoPasses.length === 0 && offGtaoResources.length === 0 &&
          (offProfile.gpuCounters.values.aoEvaluatedPixels ?? 0) === 0 &&
          (offProfile.gpuCounters.values.aoHistoryAcceptedPixels ?? 0) === 0 &&
          (offProfile.gpuCounters.values.aoHistoryRejectedPixels ?? 0) === 0,
        "Disabling GTAO removes its owner, history, graph passes, transient resources and sampled evidence dispatch",
        { runtime: offAo, passes: offGtaoPasses, resources: offGtaoResources },
        "all GTAO work and persistent history absent"
      ));

      await runtime.replaceScene(await createGtaoValidationSource());
      renderer.configure({ features: { ambientOcclusion: true } });
      await runtime.waitForFrames(4);
      profile = await runtime.waitForCounters(offProfile.frameIndex);
    } else if (request.scenarioId === "lpv-baseline-pruning") {
      const renderer = runtime.renderer;
      if (renderer === null) throw new Error("Surface runtime is not initialized");
      renderer.indirect_lighting_mode = ShadeIndirectLightingMode.LPV;
      renderer.configure({ features: { screenSpaceReflections: false } });
      await runtime.waitForFrames(2);
      const offProfile = await runtime.waitForCounters(runtime.frame - 1);
      const offGraph = renderer.mainFrameGraphEvidence();
      if (offGraph === null) throw new Error("LPV SSR-off frame did not publish FrameGraph evidence");
      const offPasses = offGraph.dump.passes.filter((entry) => !entry.culled).map((entry) => entry.name);
      const offResources = offGraph.dump.resources.map((entry) => entry.name);

      renderer.configure({ features: { screenSpaceReflections: true } });
      await runtime.waitForFrames(2);
      profile = await runtime.waitForCounters(Math.max(offProfile.frameIndex, runtime.frame - 1));
      const onGraph = renderer.mainFrameGraphEvidence();
      if (onGraph === null) throw new Error("LPV SSR-on frame did not publish FrameGraph evidence");
      const onPasses = onGraph.dump.passes.filter((entry) => !entry.culled).map((entry) => entry.name);
      const onResources = onGraph.dump.resources.map((entry) => entry.name);
      const offBaselineResources = offResources.filter((name) => name.includes("pre-exposed-baseline-specular"));
      const onBaselineResources = onResources.filter((name) => name.includes("pre-exposed-baseline-specular"));
      const isSsrConsumerPass = (name: string): boolean =>
        !/no SSR output/i.test(name) && /SSR|screen.?space reflection/i.test(name);
      const offSsrPasses = offPasses.filter(isSsrConsumerPass);
      const onSsrPasses = onPasses.filter(isSsrConsumerPass);
      Object.assign(evidence, {
        lpvBaselinePruning: {
          off: {
            cacheKey: offGraph.cacheKey,
            baselineResources: offBaselineResources,
            ssrPasses: offSsrPasses,
            transientResources: offGraph.resources.transient
          },
          on: {
            cacheKey: onGraph.cacheKey,
            baselineResources: onBaselineResources,
            ssrPasses: onSsrPasses,
            transientResources: onGraph.resources.transient
          }
        }
      });
      assertions.push(validationAssertion(
        "lpv-ssr-off-prunes-baseline-specular",
        offBaselineResources.length === 0 && offSsrPasses.length === 0,
        "LPV without SSR has no baseline-specular resource and no SSR pass in the executable FrameGraph",
        { offBaselineResources, offSsrPasses },
        "both arrays empty"
      ));
      assertions.push(validationAssertion(
        "lpv-ssr-on-materializes-baseline-specular",
        onBaselineResources.length === 1 && onSsrPasses.length > 0,
        "LPV with SSR materializes exactly one replaceable baseline-specular product consumed by the SSR topology",
        { onBaselineResources, onSsrPasses },
        "one baseline resource and at least one SSR pass"
      ));
      assertions.push(validationAssertion(
        "lpv-ssr-topology-changes-physical-memory",
        onGraph.resources.transient > offGraph.resources.transient,
        "The SSR-on graph owns more transient resources than the pruned SSR-off graph",
        { off: offGraph.resources.transient, on: onGraph.resources.transient },
        "on > off"
      ));
    } else if (request.scenarioId === "scene-adapter") {
      const renderer = runtime.renderer;
      const scene = runtime.scene;
      if (renderer === null || scene === null) throw new Error("Surface runtime is not initialized");
      runtime.stop();
      await renderer.releasePackedScene(scene);
      const ordinary = await createOrdinarySurfaceScene(scene);
      await renderer.uploadScene(scene, ordinary.geometryAssets);
      renderer.configure({ features: { temporalAntiAliasing: true } });
      ordinary.meshes[0]!.transform_local.position.set(-4.1, 1.2, 0);
      ordinary.meshes[0]!.material = ordinary.materials[1]!;
      runtime.start();
      profile = await runtime.waitForCounters(startedFrame);
      for (let attempt = 0; attempt < 8 && (
        (profile.gpuCounters.values.transparentRasterWork ?? 0) === 0 ||
        (profile.gpuCounters.values.temporalReactivePixels ?? 0) === 0
      ); attempt++) {
        profile = await runtime.waitForCounters(profile.frameIndex);
      }
      const renderWorld = renderer.gpuRenderWorldEvidence();
      const gpuScene = renderer.gpuSceneEvidence();
      evidence.renderWorld = renderWorld;
      evidence.gpuScene = gpuScene;
      assertions.push(validationAssertion("ordinary-scene-surface-adapter", renderWorld.ordinarySceneAdapterCount === 1 && renderWorld.packedSourceCount === 0 && renderWorld.ordinaryScenePatchCount >= 1, "The ordinary Scene adapter supplied the unified Surface pipeline and consumed its SceneChangeSet patch", renderWorld));
      assertions.push(validationAssertion("ordinary-scene-material-classes", (profile.gpuCounters.values.geometryRasterTriangles ?? 0) > 0 && (profile.gpuCounters.values.transparentRasterWork ?? 0) > 0, "Ordinary alpha-tested geometry reached VisibilityKey V2 and transparent instances entered SecondaryRasterWork", { geometryRasterTriangles: profile.gpuCounters.values.geometryRasterTriangles ?? 0, transparentRasterWork: profile.gpuCounters.values.transparentRasterWork ?? 0 }, "> 0"));
      assertions.push(validationAssertion("ordinary-scene-temporal-metadata", (profile.gpuCounters.values.transparentReactivePixels ?? 0) > 0 && (profile.gpuCounters.values.temporalReactivePixels ?? 0) > 0, "Ordinary Scene transparency published reactive metadata consumed by Temporal", { transparentReactivePixels: profile.gpuCounters.values.transparentReactivePixels ?? 0, temporalReactivePixels: profile.gpuCounters.values.temporalReactivePixels ?? 0 }, "> 0"));
    } else if (request.scenarioId === "texture-ref-oracle") {
      const oracle = await runTextureRefOracle();
      Object.assign(evidence, oracle);
      assertions.push(validationAssertion(
        "texture-ref-cpu-wgsl-parity",
        oracle.mismatchCount === 0,
        "The real WebGPU decoder matches the CPU TextureRef ABI for valid and invalid values",
        oracle,
        "mismatchCount = 0"
      ));
      profile = await runtime.waitForCounters(startedFrame);
    } else if (request.scenarioId === "texture-package-bc") {
      const oracle = await runTexturePackageBcOracle();
      Object.assign(evidence, oracle);
      assertions.push(validationAssertion(
        "texture-package-bc-selected",
        oracle.physicalFormat === "bc3-rgba-unorm-srgb" && oracle.mipCount === 4 && oracle.runtimeMipPasses === 0,
        "Texture Package V2 selected and sampled the cooked desktop BC mip chain",
        oracle,
        "physicalFormat = bc3-rgba-unorm-srgb, mipCount = 4 and runtimeMipPasses = 0"
      ));
      assertions.push(validationAssertion(
        "texture-package-bc-sample",
        oracle.pixel[0] >= 190 && oracle.pixel[1] <= 80 && oracle.pixel[2] <= 80 && oracle.pixel[3] >= 245,
        "The real WebGPU BC texture sampled the expected opaque red color",
        oracle.pixel,
        "R >= 190, G/B <= 80, A >= 245"
      ));
      profile = await runtime.waitForCounters(startedFrame);
    } else if (request.scenarioId === "texture-codec-production" || request.scenarioId === "texture-codec-device-loss-recreate") {
      let renderer = runtime.renderer;
      if (renderer === null) throw new Error("Surface runtime is not initialized");
      if (!renderer.device.features.has("texture-compression-bc")) {
        throw new Error("Target desktop adapter did not enable texture-compression-bc");
      }
      const response = await fetch(ETC1S_MIP_FIXTURE_URL);
      if (!response.ok) throw new Error(`KTX2 fixture fetch failed: ${response.status} ${response.statusText}`);
      const codecOwner = renderer.graphics.asset_codecs;
      const measuredPreparation = await measureMainThreadResponsiveness(async () =>
        prepareKtx2TextureAssetPackageV2(
          codecOwner,
          await response.arrayBuffer(),
          {
            taskId: 1,
            priority: 0,
            sourceEncoding: "ktx2-etc1s",
            semantic: "base-color-srgb",
            targetFormat: "bc7-rgba-unorm-srgb",
            sourceUri: "fixture://surface/texture-codec-production"
          }
        )
      );
      const asset = measuredPreparation.value;
      const workerTexture = ShadeTexture.fromAssetPackageV2(asset);
      workerTexture.label = "validation-surface-worker-transcoded-base-color";
      let recreatedWithoutCodecOwner = false;
      let deviceLossReason: GPUDeviceLostReason | null = null;
      if (request.scenarioId === "texture-codec-device-loss-recreate") {
        const lost = await runtime.recreateAfterDeviceLoss();
        deviceLossReason = lost.reason;
        renderer = runtime.renderer;
        if (renderer === null) throw new Error("Surface runtime did not recreate its Renderer");
        recreatedWithoutCodecOwner = renderer.graphics.asset_codecs_if_created === undefined;
      }
      await runtime.replaceScene(await createSurfaceSource(workerTexture));
      profile = await runtime.waitForCounters(runtime.frame);
      const codec = codecOwner.evidence();
      const residency = renderer.graphics.texture_residency.evidence();
      const variant = asset.variants[0];
      const packageEvidence = Object.freeze({
        sourceBytes: asset.evidence.sourceBytes,
        packageBytes: asset.evidence.packageBytes,
        mipCount: variant?.mips.length ?? 0,
        physicalFormat: variant?.format ?? null,
        codecId: variant?.codecId ?? null,
        codecRevision: variant?.codecRevision ?? null,
        codecBinaryHash: variant?.codecBinaryHash ?? null
      });
      evidence.codec = codec;
      evidence.mainThreadResponsiveness = measuredPreparation.responsiveness;
      evidence.package = packageEvidence;
      evidence.textureResidency = residency;
      evidence.deviceRecreate = request.scenarioId === "texture-codec-device-loss-recreate"
        ? { recreatedWithoutCodecOwner, deviceLossReason }
        : undefined;
      assertions.push(validationAssertion(
        "texture-codec-worker-executed",
        codec.tasksCompleted === 1 && codec.workerPathCount === 1 && codec.outputBytes > 0 &&
          codec.transferBytes === codec.inputBytes + codec.outputBytes && codec.peakActiveWorkers === 1 &&
          codec.codecIdentities.length === 1 && codec.codecIdentities[0]!.completedTaskCount === 1,
        "The bounded browser Worker executed the pinned KTX2/Basis codec exactly once",
        codec,
        "completed/workerPath/peakWorkers/codec identity = 1, outputBytes > 0, and transferBytes are closed"
      ));
      assertions.push(validationAssertion(
        "texture-codec-main-thread-responsive",
        measuredPreparation.responsiveness.animationFrameSamples >= 2,
        "The main thread continued servicing animation frames while the Worker/WASM task was pending",
        measuredPreparation.responsiveness,
        "at least two animation-frame samples; max gap retained as load evidence"
      ));
      assertions.push(validationAssertion(
        "texture-codec-package-provenance",
        packageEvidence.physicalFormat === "bc7-rgba-unorm-srgb" && packageEvidence.mipCount === 7 &&
          packageEvidence.codecId === "khronos-ktx-software-libktx-read" &&
          packageEvidence.codecBinaryHash === "8336a23659f306c93f45816022dcdfae122f66eaf566488a2b7cf40e0bf65f0e",
        "Worker output retained its exact physical format, complete mip chain, and pinned codec provenance in TextureAssetPackage V2",
        packageEvidence,
        "BC7 sRGB, 7 mips, pinned libktx identity"
      ));
      assertions.push(validationAssertion(
        "texture-binding-set-multi-consumer",
        residency.bindingSetCount >= 2 && residency.bindingSetPreflightFailures === 0,
        "Normal Render World materials span multiple bounded TextureBindingSets without preflight failure",
        { bindingSetCount: residency.bindingSetCount, preflightFailures: residency.bindingSetPreflightFailures },
        "bindingSetCount >= 2 and preflightFailures = 0"
      ));
      assertions.push(validationAssertion(
        "texture-codec-residency-evidence",
        residency.workerTranscodeCount === 1 && residency.transcodeBytes > 0 &&
          residency.directPackageCount >= 4 &&
          residency.formatDistribution.some((entry) => entry.format === "bc7-rgba-unorm-srgb" && entry.residentTextureCount === 1),
        "TextureResidency distinguishes Worker, direct-package, and exact physical-format paths",
        {
          workerTranscodeCount: residency.workerTranscodeCount,
          directPackageCount: residency.directPackageCount,
          transcodeBytes: residency.transcodeBytes,
          formatDistribution: residency.formatDistribution
        },
        "one BC7 Worker texture, direct package textures, and transcodeBytes > 0"
      ));
      if (request.scenarioId === "texture-codec-device-loss-recreate") {
        assertions.push(validationAssertion(
          "texture-codec-device-loss-authority",
          deviceLossReason === "destroyed" && recreatedWithoutCodecOwner && residency.workerTranscodeCount === 1,
          "A prepared Runtime Asset rebuilt compressed GPU residency after intentional device loss without Worker-private state",
          { deviceLossReason, recreatedWithoutCodecOwner, workerTranscodeCount: residency.workerTranscodeCount },
          "device loss reason = destroyed; new Renderer starts without a codec owner and reuses one Worker-prepared Runtime Asset"
        ));
      }
    } else if (request.scenarioId === "material-switch") {
      const before = await runtime.waitForCounters(startedFrame);
      const renderer = runtime.renderer;
      const scene = runtime.scene;
      if (renderer === null || scene === null) throw new Error("Surface runtime is not initialized");
      const patchedMaterialsBefore = renderer.gpuSceneEvidence().patchedMaterialCount;
      renderer.queuePackedScenePatch(scene, {
        frameId: renderer.frame_count + 1,
        materials: {
          indices: new Uint32Array([0]),
          materialIndices: new Uint32Array([2])
        }
      });
      profile = before;
      let patchedMaterialsAfter = patchedMaterialsBefore;
      for (let attempt = 0; attempt < 6 && patchedMaterialsAfter === patchedMaterialsBefore; attempt++) {
        profile = await runtime.waitForCounters(profile.frameIndex);
        patchedMaterialsAfter = renderer.gpuSceneEvidence().patchedMaterialCount;
      }
      evidence.patchedMaterialsBefore = patchedMaterialsBefore;
      evidence.patchedMaterialsAfter = patchedMaterialsAfter;
      assertions.push(validationAssertion("material-patch-applied", patchedMaterialsAfter === patchedMaterialsBefore + 1, "The explicit material patch was consumed by the GPU Scene", { patchedMaterialsBefore, patchedMaterialsAfter }, "after = before + 1"));
    } else {
      profile = await runtime.waitForCounters(startedFrame);
    }

    const gpu = profile.gpuCounters.values;
    const counted = profile.counters;
    const activeMaterials = gpu.activeMaterials ?? 0;
    const residentTextures = counted["packed.material.residentTextures"] ?? 0;
    const residentTextureBytes = counted["packed.material.residentTextureBytes"] ?? 0;
    const textureFallbacks = counted["packed.material.textureFallbacks"] ?? 0;
    const cookedResidentTextures = counted["packed.material.cookedResidentTextures"] ?? 0;
    const compressedResidentTextures = counted["packed.material.compressedResidentTextures"] ?? 0;
    const cookedUploadBytes = counted["packed.material.textureUploadBytes"] ?? 0;
    const runtimeMipGenerations = counted["packed.material.textureRuntimeMipGenerations"] ?? 0;
    const cookedRuntimeMipGenerations = counted["packed.material.cookedRuntimeMipGenerations"] ?? 0;
    const ownerCreation = runtime.renderer?.gpuOwnerCreationEvidence();
    Object.assign(evidence, {
      activeMaterials,
      shadedPixels: gpu.shadedPixels ?? 0,
      residentTextures,
      residentTextureBytes,
      textureFallbacks,
      cookedResidentTextures,
      compressedResidentTextures,
      cookedUploadBytes,
      runtimeMipGenerations,
      cookedRuntimeMipGenerations,
      queueOverflowMask: gpu.queueOverflowMask ?? 0,
      gpuCounterSchemaVersion: profile.gpuCounters.schemaVersion
    });
    assertions.push(validationAssertion("materials-resolved", activeMaterials >= 4, "All four fixed materials are addressable by Material Resolve", activeMaterials, ">= 4"));
    assertions.push(validationAssertion("surface-pixels-resolved", (gpu.shadedPixels ?? 0) > 0, "Material Resolve produced visible Surface pixels", gpu.shadedPixels, "> 0"));
    assertions.push(validationAssertion("gpu-queue-no-overflow", (gpu.queueOverflowMask ?? 0) === 0, "GPU work queues did not overflow", gpu.queueOverflowMask, 0));
    if (request.scenarioId === "textured") {
      assertions.push(validationAssertion("texture-resident", residentTextures >= 1 && residentTextureBytes > 0, "The generated texture owns a resident GPU layer", { residentTextures, residentTextureBytes }, "residentTextures >= 1 and bytes > 0"));
      assertions.push(validationAssertion("texture-fallback-bounded", textureFallbacks === 1, "Only the intentionally unusable texture fell back", textureFallbacks, 1));
    }
    if (request.scenarioId === "texture-fallback") {
      assertions.push(validationAssertion("texture-fallback-recorded", textureFallbacks >= 1, "An unusable texture was recorded as an explicit material fallback", textureFallbacks, ">= 1"));
    }
    if (request.scenarioId === "texture-package-production" || request.scenarioId === "texture-codec-production" || request.scenarioId === "texture-codec-device-loss-recreate") {
      const expectedCompressedTextures = 5;
      assertions.push(validationAssertion(
        `${request.scenarioId}-resident`,
        cookedResidentTextures >= expectedCompressedTextures &&
          compressedResidentTextures >= expectedCompressedTextures && cookedUploadBytes > 0,
        "GpuRenderWorld staged the scenario's material textures through TextureResidency into compressed package segments",
        { cookedResidentTextures, compressedResidentTextures, cookedUploadBytes },
        `cooked/compressed >= ${expectedCompressedTextures} and uploadBytes > 0`
      ));
      assertions.push(validationAssertion(
        `${request.scenarioId}-offline-mips`,
        runtimeMipGenerations === 0 && cookedRuntimeMipGenerations === 0,
        "The authoritative cooked material path consumed its complete offline mip chain without a runtime mip pass",
        { runtimeMipGenerations, cookedRuntimeMipGenerations },
        "both = 0"
      ));
    }
    if (request.scenarioId === "texture-package-production") {
      assertions.push(validationAssertion(
        "texture-codec-feature-off-cold",
        runtime.renderer?.graphics.asset_codecs_if_created === undefined,
        "Direct GPU-native package loading did not create a Worker/WASM codec owner",
        runtime.renderer?.graphics.asset_codecs_if_created === undefined,
        true
      ));
    }
    if (request.scenarioId === "transparent") {
      assertions.push(validationAssertion("transparent-work-produced", (gpu.transparentRasterWork ?? 0) > 0 && (gpu.transparentTriangles ?? 0) > 0, "Packed transparency produced bounded raster work and triangle work", { rasterWork: gpu.transparentRasterWork ?? 0, triangles: gpu.transparentTriangles ?? 0 }, "> 0"));
      assertions.push(validationAssertion("transparent-queue-no-overflow", (gpu.transparentQueueOverflowMask ?? 0) === 0, "Packed transparency work did not overflow", gpu.transparentQueueOverflowMask, 0));
    }
    if (request.scenarioId === "scene-adapter") {
      assertions.push(validationAssertion("ordinary-transparent-work-produced", (gpu.transparentRasterWork ?? 0) > 0 && (gpu.transparentTriangles ?? 0) > 0, "Ordinary Scene transparency used the shared bounded raster and MBOIT consumer", { rasterWork: gpu.transparentRasterWork ?? 0, triangles: gpu.transparentTriangles ?? 0 }, "> 0"));
    }
    assertions.push(validationAssertion("single-material-owner", ownerCreation !== undefined && ownerCreation.renderWorld.materialStoreCreated, "Surface and Transparency used the authoritative material owner", ownerCreation?.renderWorld));
    assertions.push(validationAssertion("single-geometry-owner", ownerCreation !== undefined && packedFrameHasNoLegacyGeometryOwners(ownerCreation), "Surface, patches and Transparency used one Render World", ownerCreation?.scene));
    const diagnostics = validationDiagnostics(runtime.renderer?.profiler.diagnostics);
    assertions.push(validationAssertion("gpu-diagnostics-clean", !hasGpuFailure(diagnostics), "WebGPU diagnostics are clean", diagnostics));

    const result: ValidationScenarioResult = {
      schemaVersion: VALIDATION_PROTOCOL_SCHEMA_VERSION,
      fixtureId: "surface",
      runId: request.runId,
      scenarioId: request.scenarioId,
      status: assertions.every((assertion) => assertion.passed) ? "passed" : "failed",
      startedFrame,
      completedFrame: Math.max(startedFrame + 1, profile.frameIndex),
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

async function runTexturePackageBcOracle(): Promise<Readonly<{
  physicalFormat: GPUTextureFormat;
  mipCount: number;
  residentBytes: number;
  uploadBytes: number;
  runtimeMipPasses: number;
  pixel: readonly number[];
}>> {
  const device = runtime.renderer?.device;
  if (device === undefined) throw new Error("Surface runtime has no WebGPU device for the Texture Package V2 oracle");
  if (!device.features.has("texture-compression-bc")) {
    throw new Error("Target desktop adapter did not enable texture-compression-bc");
  }
  const rgba8 = new Uint8Array(8 * 8 * 4);
  for (let pixel = 0; pixel < 64; pixel++) rgba8.set([224, 32, 20, 255], pixel * 4);
  const asset = await openTextureAssetPackageV2(await cookTextureAssetPackageV2({
    width: 8,
    height: 8,
    rgba8,
    semantic: "base-color-srgb",
    sourceUri: "fixture://surface/texture-package-bc"
  }));
  const uploaded = uploadTextureAssetPackageV2(device, asset);
  const target = device.createTexture({
    label: "validation/Texture Package V2 sample target",
    size: [1, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
  });
  const readback = device.createBuffer({
    label: "validation/Texture Package V2 sample readback",
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  device.pushErrorScope("validation");
  let errorScopeOpen = true;
  try {
    const module = device.createShaderModule({
      label: "validation/Texture Package V2 sample shader",
      code: `
@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[index], 0.0, 1.0);
}
@fragment fn fragment_main() -> @location(0) vec4f {
  return textureSampleLevel(source_texture, source_sampler, vec2f(0.5), 0.0);
}`
    });
    const pipeline = await device.createRenderPipelineAsync({
      label: "validation/Texture Package V2 sample pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vertex_main" },
      fragment: { module, entryPoint: "fragment_main", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list" }
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: uploaded.view },
        { binding: 1, resource: device.createSampler({ minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" }) }
      ]
    });
    const encoder = device.createCommandEncoder({ label: "validation/Texture Package V2 sample" });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" }]
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: 256 },
      [1, 1, 1]
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixel = Object.freeze([...new Uint8Array(readback.getMappedRange()).slice(0, 4)]);
    readback.unmap();
    const scopedError = await device.popErrorScope();
    errorScopeOpen = false;
    if (scopedError !== null) throw new Error(`Texture Package V2 WebGPU validation failed: ${scopedError.message}`);
    return Object.freeze({
      physicalFormat: uploaded.evidence.physicalFormat,
      mipCount: uploaded.variant.mips.length,
      residentBytes: uploaded.evidence.residentBytes,
      uploadBytes: uploaded.evidence.uploadBytes,
      runtimeMipPasses: uploaded.evidence.runtimeMipPasses,
      pixel
    });
  } catch (error) {
    if (readback.mapState === "mapped") readback.unmap();
    if (errorScopeOpen) await device.popErrorScope().catch(() => null);
    throw error;
  } finally {
    uploaded.texture.destroy();
    target.destroy();
    readback.destroy();
  }
}

async function runTextureRefOracle(): Promise<Readonly<{ sampleCount: number; mismatchCount: number }>> {
  const device = runtime.renderer?.device;
  if (device === undefined) throw new Error("Surface runtime has no WebGPU device for the TextureRef oracle");
  const refs = new Uint32Array([
    ...Array.from({ length: 5 }, (_, bank) => encodeGpuTextureRef(bank, bank + 1)),
    encodeGpuTextureRef(5, 7, 1),
    encodeGpuTextureRef(6, 9, 2),
    0xffffffff,
    0x00000001,
    0x2f000001,
    0x20000000
  ]);
  const input = device.createBuffer({
    label: "validation/TextureRef oracle input",
    size: refs.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  const outputSize = refs.length * 16;
  const output = device.createBuffer({
    label: "validation/TextureRef oracle output",
    size: outputSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
  });
  const readback = device.createBuffer({
    label: "validation/TextureRef oracle readback",
    size: outputSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  try {
    device.queue.writeBuffer(input, 0, refs);
    const module = device.createShaderModule({
      label: "validation/TextureRef CPU-WGSL oracle",
      code: /* wgsl */ `
${GPU_TEXTURE_REF_WGSL}
@group(0) @binding(0) var<storage, read> refs: array<u32>;
@group(0) @binding(1) var<storage, read_write> decoded: array<vec4u>;
@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= ${refs.length}u { return; }
  let value = refs[id.x];
  decoded[id.x] = vec4u(
    oengine_texture_ref_version(value),
    oengine_texture_ref_bank(value),
    oengine_texture_ref_routing(value),
    oengine_texture_ref_layer(value) | (select(0u, 1u, oengine_texture_ref_valid(value)) << 31u)
  );
}`
    });
    const pipeline = await device.createComputePipelineAsync({
      label: "validation/TextureRef oracle pipeline",
      layout: "auto",
      compute: { module, entryPoint: "main" }
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } }
      ]
    });
    const encoder = device.createCommandEncoder({ label: "validation/TextureRef oracle" });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, outputSize);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Uint32Array(readback.getMappedRange());
    let mismatchCount = 0;
    for (let index = 0; index < refs.length; index++) {
      const value = refs[index]!;
      const cpu = decodeGpuTextureRef(value);
      const expected = [
        (value & GPU_TEXTURE_REF_VERSION_MASK) >>> GPU_TEXTURE_REF_VERSION_SHIFT,
        (value & GPU_TEXTURE_REF_BANK_MASK) >>> GPU_TEXTURE_REF_BANK_SHIFT,
        (value & GPU_TEXTURE_REF_ROUTING_MASK) >>> GPU_TEXTURE_REF_ROUTING_SHIFT,
        ((value & GPU_TEXTURE_REF_LAYER_MASK) | (cpu === null ? 0 : 0x80000000)) >>> 0
      ];
      if (expected[0] !== actual[index * 4] || expected[1] !== actual[index * 4 + 1] ||
        expected[2] !== actual[index * 4 + 2] || expected[3] !== actual[index * 4 + 3]) mismatchCount++;
    }
    if (GPU_TEXTURE_REF_ABI_VERSION !== 2) mismatchCount++;
    readback.unmap();
    return Object.freeze({ sampleCount: refs.length, mismatchCount });
  } finally {
    if (readback.mapState === "mapped") readback.unmap();
    input.destroy();
    output.destroy();
    readback.destroy();
  }
}

async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  await runtime.destroy();
  state.dispose();
  showStatus();
  delete window[VALIDATION_FIXTURE_KEY];
}

async function measureMainThreadResponsiveness<T>(work: () => Promise<T>): Promise<Readonly<{
  value: T;
  responsiveness: Readonly<{
    animationFrameSamples: number;
    maximumAnimationFrameGapMs: number;
  }>;
}>> {
  const frameTimes = [performance.now()];
  let active = true;
  let request = requestAnimationFrame(function sample(time): void {
    if (!active) return;
    frameTimes.push(time);
    request = requestAnimationFrame(sample);
  });
  try {
    const value = await work();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let maximumAnimationFrameGapMs = 0;
    for (let index = 1; index < frameTimes.length; index++) {
      maximumAnimationFrameGapMs = Math.max(
        maximumAnimationFrameGapMs,
        frameTimes[index]! - frameTimes[index - 1]!
      );
    }
    return Object.freeze({
      value,
      responsiveness: Object.freeze({
        animationFrameSamples: Math.max(0, frameTimes.length - 1),
        maximumAnimationFrameGapMs
      })
    });
  } finally {
    active = false;
    cancelAnimationFrame(request);
  }
}

async function createSurfaceSource(workerBaseColor?: ShadeTexture): Promise<PackedSceneSource> {
  const red = solidMaterial([0.9, 0.08, 0.06, 1], 0.7, 0);
  const metal = solidMaterial([0.72, 0.76, 0.82, 1], 0.18, 1);
  metal.draw_side = ShadeDrawSide.Double;
  const textured = solidMaterial([1, 1, 1, 1], 0.5, 0);
  const cooked = await createCookedMaterialTextures();
  textured.texture_albedo = workerBaseColor ?? cooked.baseColor;
  textured.texture_normal = cooked.normal;
  textured.texture_orm = cooked.orm;
  textured.texture_emissive = cooked.emissive;
  const fallback = solidMaterial([0.85, 0.2, 0.85, 1], 0.8, 0);
  fallback.texture_albedo = new ShadeTexture();
  const transparent = solidMaterial([0.1, 0.7, 0.95, 0.5], 0.25, 0);
  transparent.transparency_mode = ShadeTransparencyMode.Transparent;
  const alphaTested = solidMaterial([0.85, 0.8, 0.2, 1], 0.55, 0);
  alphaTested.transparency_mode = ShadeTransparencyMode.AlphaTested;
  alphaTested.texture_albedo = cooked.alphaMask;
  return createPackedBoxScene([
    { size: [2.4, 2.4, 2.4], position: [-4.5, 1.2, 0], materialIndex: 0, debugId: 1 },
    { size: [2.4, 2.4, 2.4], position: [-1.5, 1.2, 0], materialIndex: 1, debugId: 2 },
    { size: [2.4, 2.4, 2.4], position: [1.5, 1.2, 0], materialIndex: 2, debugId: 3 },
    { size: [2.4, 2.4, 2.4], position: [4.5, 1.2, 0], materialIndex: 3, debugId: 4 },
    { size: [1.8, 1.8, 1.8], position: [0, 1.2, 2.2], materialIndex: 4, debugId: 5 },
    { size: [1.8, 1.8, 1.8], position: [0, 1.2, -2.2], materialIndex: 5, debugId: 6 }
  ], [red, metal, textured, fallback, transparent, alphaTested]);
}

async function createOrdinarySurfaceScene(scene: NonNullable<typeof runtime.scene>) {
  const source = await createSurfaceSource();
  const sizes: readonly (readonly [number, number, number])[] = [
    [2.4, 2.4, 2.4],
    [2.4, 2.4, 2.4],
    [2.4, 2.4, 2.4],
    [2.4, 2.4, 2.4],
    [1.8, 1.8, 1.8],
    [1.8, 1.8, 1.8]
  ];
  const meshes: Mesh[] = [];
  const geometryAssets = sizes.map((size, index) => {
    const geometry = new BoxGeometry(size[0], size[1], size[2]);
    const materialIndex = source.materialIndices[index]!;
    const mesh = Mesh.from(
      geometry,
      source.materials[materialIndex]!,
      source.currentTransforms.subarray(index * 16, (index + 1) * 16)
    );
    meshes.push(mesh);
    scene.add(mesh);
    return { geometry, asset: source.geometries[index]! };
  });
  return { meshes, materials: source.materials, geometryAssets };
}

async function createCookedMaterialTextures(): Promise<Readonly<{
  baseColor: ShadeTexture;
  normal: ShadeTexture;
  orm: ShadeTexture;
  emissive: ShadeTexture;
  alphaMask: ShadeTexture;
}>> {
  const semantics = [
    "base-color-srgb",
    "normal-linear",
    "orm-linear",
    "emissive-srgb",
    "alpha-mask"
  ] as const;
  const textures = await Promise.all(semantics.map(async (semantic) => {
    const pixels = new Uint8Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const rgba = semantic === "normal-linear"
        ? [128, 128, 255, 255]
        : semantic === "orm-linear"
          ? [255, 150, 24, 255]
          : semantic === "emissive-srgb"
            ? [12, 28, 72, 255]
            : semantic === "alpha-mask"
              ? [255, 255, 255, (x + y) % 2 === 0 ? 255 : 0]
              : (x + y) % 2 === 0
                ? [255, 255, 255, 255]
                : [25, 80, 230, 255];
      pixels.set(rgba, (y * 8 + x) * 4);
    }
    const asset = await openTextureAssetPackageV2(await cookTextureAssetPackageV2({
      width: 8,
      height: 8,
      rgba8: pixels,
      semantic,
      sourceUri: `fixture://surface/production-${semantic}`
    }));
    const texture = ShadeTexture.fromAssetPackageV2(asset);
    texture.label = `validation-surface-${semantic}`;
    return texture;
  }));
  return Object.freeze({
    baseColor: textures[0],
    normal: textures[1],
    orm: textures[2],
    emissive: textures[3],
    alphaMask: textures[4]
  });
}

async function createGtaoValidationSource(): Promise<PackedSceneSource> {
  const floor = solidMaterial([0.58, 0.6, 0.63, 1], 0.82, 0);
  const wall = solidMaterial([0.68, 0.28, 0.18, 1], 0.72, 0);
  const thinOccluder = solidMaterial([0.15, 0.46, 0.72, 1], 0.34, 0.1);
  const contact = solidMaterial([0.74, 0.7, 0.18, 1], 0.62, 0);
  return createPackedBoxScene([
    { size: [13, 0.2, 8], position: [0, -0.1, 0], materialIndex: 0, debugId: 101 },
    { size: [0.2, 6, 8], position: [-6, 3, 0], materialIndex: 1, debugId: 102 },
    { size: [0.08, 3.8, 4.4], position: [-0.7, 1.9, 0], materialIndex: 2, debugId: 103 },
    { size: [2.2, 2.2, 2.2], position: [2.1, 1.1, 0], materialIndex: 3, debugId: 104 }
  ], [floor, wall, thinOccluder, contact]);
}

function failedScenario(request: ValidationScenarioRequest, error: unknown, startedFrame = runtime.frame): ValidationScenarioResult {
  const normalized = validationError(error);
  return {
    schemaVersion: VALIDATION_PROTOCOL_SCHEMA_VERSION,
    fixtureId: "surface",
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
