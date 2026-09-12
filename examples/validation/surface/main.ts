import {
  BoxGeometry,
  Mesh,
  RenderDebugView,
  ShadeDrawSide,
  ShadeTexture,
  ShadeTransparencyMode,
  createBrick4LightMapPackageV1,
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
  const supported = ["basic", "textured", "material-switch", "texture-fallback", "texture-ref-oracle", "texture-package-bc", "texture-package-production", "texture-codec-production", "texture-codec-device-loss-recreate", "transparent", "scene-adapter", "lpv-baseline-pruning", "gtao-replacement", "ssgi-production", "ssr-replacement", "shared-derived-products", "temporal-reconstruction", "post-fusion"];
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

    if (request.scenarioId === "post-fusion") {
      const renderer = runtime.renderer;
      if (renderer === null) throw new Error("Surface runtime is not initialized");
      renderer.configure({
        features: {
          temporalAntiAliasing: true,
          bloom: true,
          automaticExposure: true,
          sharpening: true,
          motionBlur: false
        },
        resolution: { mode: "fixed", internalScale: 1 },
        post: {
          bloomIntensity: 1,
          sharpeningStrength: 0.8,
          colorGradingLift: 0.01,
          colorGradingGamma: 1.02,
          colorGradingGain: 1.03,
          colorGradingSaturation: 1.05,
          colorGradingContrast: 1.02
        }
      });
      await runtime.waitForFrames(4);
      profile = await runtime.waitForCounters(runtime.frame - 1);
      const fused = renderer.finalOutputEvidence();
      const fusedGraph = renderer.mainFrameGraphEvidence();
      if (fusedGraph === null) throw new Error("Post-fusion frame did not publish FrameGraph evidence");
      const fusedPasses = fusedGraph.dump.passes
        .filter((entry) => !entry.culled)
        .map((entry) => entry.name);
      const fusedResources = liveFrameGraphResourceNames(fusedGraph);

      renderer.configure({ features: { bloom: false, sharpening: false } });
      await runtime.waitForFrames(2);
      const optionalOff = renderer.finalOutputEvidence();
      const optionalOffGraph = renderer.mainFrameGraphEvidence();
      if (optionalOffGraph === null) throw new Error("Post optional-off frame did not publish FrameGraph evidence");
      const optionalOffPasses = optionalOffGraph.dump.passes
        .filter((entry) => !entry.culled)
        .map((entry) => entry.name);
      const optionalOffResources = liveFrameGraphResourceNames(optionalOffGraph);

      renderer.configure({ features: { automaticExposure: false } });
      await runtime.waitForFrames(2);
      const exposureOff = renderer.sharedDerivedProductsEvidence();
      const exposureOffFinal = renderer.finalOutputEvidence();
      const exposureOffGraph = renderer.mainFrameGraphEvidence();
      if (exposureOffGraph === null) throw new Error("Post exposure-off frame did not publish FrameGraph evidence");
      const exposureOffPasses = exposureOffGraph.dump.passes
        .filter((entry) => !entry.culled)
        .map((entry) => entry.name);
      const exposureOffResources = liveFrameGraphResourceNames(exposureOffGraph);

      renderer.configure({
        features: { bloom: true, automaticExposure: true, sharpening: true }
      });
      const capturePromise = renderer.requestLinearHdrCapture({
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        stage: "post-color-grading"
      });
      await runtime.waitForFrames(1);
      const capturePath = renderer.finalOutputEvidence();
      const captureGraph = renderer.mainFrameGraphEvidence();
      if (captureGraph === null) throw new Error("Post capture frame did not publish FrameGraph evidence");
      const capturePasses = captureGraph.dump.passes
        .filter((entry) => !entry.culled)
        .map((entry) => entry.name);
      // The readback promise resolves after queue completion, while the fixture's
      // continuous render loop may already have restored the fused topology.
      // Snapshot graph/runtime evidence at the exact capture frame first.
      const capture = await capturePromise;

      renderer.render_debug_view = RenderDebugView.LinearHdr;
      await runtime.waitForFrames(2);
      const debugPath = renderer.finalOutputEvidence();
      const debugShared = renderer.sharedDerivedProductsEvidence();
      const debugGraph = renderer.mainFrameGraphEvidence();
      if (debugGraph === null) throw new Error("Post debug frame did not publish FrameGraph evidence");
      const debugPasses = debugGraph.dump.passes
        .filter((entry) => !entry.culled)
        .map((entry) => entry.name);
      const debugResources = liveFrameGraphResourceNames(debugGraph);

      // Restore the representative fused topology for the always screenshot.
      renderer.render_debug_view = RenderDebugView.None;
      await runtime.waitForFrames(3);
      profile = await runtime.waitForCounters(runtime.frame - 1);
      const restored = renderer.finalOutputEvidence();

      Object.assign(evidence, {
        postFusion: {
          fused,
          fusedPasses,
          fusedResources,
          optionalOff,
          optionalOffPasses,
          optionalOffResources,
          exposureOff,
          exposureOffFinal,
          exposureOffPasses,
          exposureOffResources,
          capturePath,
          capturePasses,
          capturePixel: Array.from(capture.rgba),
          debugPath,
          debugShared,
          debugPasses,
          debugResources,
          restored,
          profilerCounters: profile.counters,
          submits: profile.submits
        }
      });
      assertions.push(validationAssertion(
        "post-normal-path-fuses-full-resolution-stages",
        fused.finalOutputPasses === 1 &&
          ((fused.outputMode === "hdr" && fused.outputFormat === "rgba16float" &&
            fusedPasses.includes("Final Output HDR")) ||
            (fused.outputMode === "sdr" &&
              fused.outputFormat === navigator.gpu.getPreferredCanvasFormat() &&
              fusedPasses.includes("Final Output SDR"))) &&
          fused.bloomFused &&
          fused.colorGradingFused && fused.sharpeningFused &&
          fused.bloomCompositeMaterializationPasses === 0 &&
          fused.colorGradingMaterializationPasses === 0 &&
          fused.standaloneSharpenPasses === 0 &&
          fused.fullResolutionHdrIntermediateCount === 0 &&
          fusedPasses.filter((name) => name === "Final Output SDR" || name === "Final Output HDR").length === 1 &&
          !fusedPasses.includes("Bloom composite shared pyramid") &&
          !fusedPasses.includes("Color Grading") &&
          !fusedPasses.includes("Sharpen XE") &&
          !fusedResources.some((name) =>
            ["Bloom composited", "Color graded color", "Sharpened color"].includes(name)
          ),
        "Normal post topology folds Bloom composite, grading, optional sharpen and display mapping into one swapchain pass",
        { runtime: fused, passes: fusedPasses, resources: fusedResources },
        "one Final Output pass and zero full-resolution HDR post intermediates"
      ));
      assertions.push(validationAssertion(
        "post-optional-features-are-statically-pruned",
        optionalOff.finalOutputPasses === 1 && !optionalOff.bloomFused &&
          optionalOff.colorGradingFused && !optionalOff.sharpeningFused &&
          optionalOff.bloomCompositeMaterializationPasses === 0 &&
          optionalOff.fullResolutionHdrIntermediateCount === 0 &&
          !optionalOffPasses.some((name) => name.startsWith("Bloom ")) &&
          !optionalOffResources.some((name) => name === "Bloom reconstructed pyramid"),
        "Bloom-off and Sharpen-off select a smaller Final Output binding/shader variant without dummy resources",
        { runtime: optionalOff, passes: optionalOffPasses, resources: optionalOffResources },
        "no Bloom pass/binding and no sharpen neighborhood specialization"
      ));
      assertions.push(validationAssertion(
        "post-exposure-off-prunes-final-reduction-and-history",
        exposureOffFinal.finalOutputPasses === 1 &&
          exposureOff.pyramids.finalBuilds === 0 && exposureOff.finalConsumerCount === 0 &&
          exposureOff.exposureHistogramPasses === 0 &&
          exposureOff.histories.find((history) => history.name === "exposure")?.active === false &&
          !exposureOffPasses.includes("FinalColorPyramid shared producer") &&
          !exposureOffPasses.includes("Automatic exposure histogram eC") &&
          !exposureOffResources.includes("FinalColorPyramid") &&
          !exposureOffResources.includes("Automatic exposure adapted"),
        "With Bloom and Automatic Exposure both disabled, the final pyramid, histogram and exposure history have no production consumer",
        {
          shared: exposureOff,
          finalOutput: exposureOffFinal,
          passes: exposureOffPasses,
          resources: exposureOffResources
        },
        "zero final consumers/builds and inactive exposure history"
      ));
      assertions.push(validationAssertion(
        "post-capture-materializes-only-required-hdr-boundary",
        capturePath.finalOutputPasses === 1 && !capturePath.bloomFused &&
          !capturePath.colorGradingFused && capturePath.sharpeningFused &&
          capturePath.bloomCompositeMaterializationPasses === 1 &&
          capturePath.colorGradingMaterializationPasses === 1 &&
          capturePath.fullResolutionHdrIntermediateCount === 2 &&
          capturePath.oneShotCaptureMaterialized &&
          capturePasses.includes("R5 one-shot post-color-grading capture") &&
          capture.rgba.length === 4 && capture.rgba.every(Number.isFinite),
        "One-shot post-grading capture materializes the exact HDR boundary and the following frame returns to fusion",
        { runtime: capturePath, passes: capturePasses, capture: Array.from(capture.rgba) },
        "Bloom composite + Color Grading only in capture topology; finite rgba16float readback"
      ));
      assertions.push(validationAssertion(
        "post-debug-bypasses-scene-post-and-prunes-unused-bloom",
        debugPath.finalOutputPasses === 1 && debugPath.debugBypass &&
          !debugPath.bloomFused && !debugPath.colorGradingFused && !debugPath.sharpeningFused &&
          debugPath.bloomCompositeMaterializationPasses === 0 &&
          debugPath.colorGradingMaterializationPasses === 0 &&
          debugPath.fullResolutionHdrIntermediateCount === 0 &&
          debugShared.finalConsumerCount === 1 &&
          debugPasses.some((name) => name === "Render debug/linear-hdr") &&
          !debugPasses.includes("Bloom reconstruct from FinalColorPyramid") &&
          !debugResources.includes("Bloom reconstructed pyramid"),
        "Linear-HDR debug observes the pre-post source, keeps exposure as the sole final-pyramid consumer and culls configured Bloom work",
        { runtime: debugPath, shared: debugShared, passes: debugPasses, resources: debugResources },
        "debug bypass true; no Bloom/grading/sharpen work; one live exposure consumer"
      ));
      assertions.push(validationAssertion(
        "post-fusion-remains-one-main-submit-and-observable",
        restored.finalOutputPasses === 1 && restored.bloomFused &&
          restored.colorGradingFused && restored.sharpeningFused &&
          profile.submits.count === 1 &&
          profile.counters["post.finalOutputPasses"] === 1 &&
          profile.counters["post.fullResolutionHdrIntermediates"] === 0,
        "Fused Final Output and shared Bloom/Exposure work stay inside the one main command submission",
        { runtime: restored, counters: profile.counters, submits: profile.submits },
        "one submit, one final output, zero full-resolution HDR intermediates"
      ));
    } else if (request.scenarioId === "temporal-reconstruction") {
      const renderer = runtime.renderer;
      if (renderer === null) throw new Error("Surface runtime is not initialized");
      const originalWidth = renderer.output_resolution.x;
      const originalHeight = renderer.output_resolution.y;
      // First exercise the opaque-only topology so the shared SurfaceValidity
      // producer cannot be hidden by the fixture's default transparent mesh.
      await runtime.replaceScene(await createSsrReplacementSource());
      renderer.upscale_type = 0;
      renderer.configure({
        features: {
          screenSpaceDiffuseMode: "gtao",
          screenSpaceReflections: false,
          temporalAntiAliasing: true,
          motionBlur: false,
          sharpening: false
        },
        ao: { temporalEnabled: true },
        resolution: {
          mode: "fixed",
          internalScale: 0.75,
          adaptiveMinimumScale: 0.67,
          adaptiveMaximumScale: 1,
          adaptiveTargetFrameRate: 60
        }
      });
      const fixedSamplesBefore = renderer.temporalEvidence().drsAcceptedGpuSamples;
      await runtime.waitForFrames(5);
      profile = await runtime.waitForCounters(runtime.frame - 1);
      const fixedProfile = profile;
      const fixed = renderer.temporalEvidence();
      const fixedGraph = renderer.mainFrameGraphEvidence();
      if (fixedGraph === null) throw new Error("Temporal fixed-mode frame did not publish FrameGraph evidence");
      const fixedPasses = fixedGraph.dump.passes
        .filter((entry) => !entry.culled)
        .map((entry) => entry.name);
      const fixedResources = liveFrameGraphResourceNames(fixedGraph);

      renderer.indicate_view_change();
      await runtime.waitForFrames(1);
      const afterCameraCut = renderer.temporalEvidence();
      await runtime.waitForFrames(2);
      const afterCameraRecovery = renderer.temporalEvidence();

      const resizedWidth = originalWidth === 640 ? 704 : 640;
      const resizedHeight = originalHeight === 360 ? 396 : 360;
      runtime.resize(resizedWidth, resizedHeight);
      await runtime.waitForFrames(1);
      const afterResize = renderer.temporalEvidence();
      runtime.resize(originalWidth, originalHeight);
      await runtime.waitForFrames(2);

      renderer.configure({
        resolution: {
          mode: "adaptive",
          internalScale: 0.75,
          adaptiveMinimumScale: 0.67,
          adaptiveMaximumScale: 1,
          adaptiveTargetFrameRate: 60,
          adaptiveTolerance: 0.1,
          adaptiveSettleFrames: 30
        }
      });
      await runtime.waitForFrames(2);
      const adaptive = renderer.temporalEvidence();

      // The screenshot and final sampled counters use the deterministic fixed
      // topology required by formal benchmark/visual comparison.
      renderer.configure({ resolution: { mode: "fixed", internalScale: 0.75 } });
      await runtime.waitForFrames(4);
      profile = await runtime.waitForCounters(runtime.frame - 1);
      const restoredFixed = renderer.temporalEvidence();

      // Restore the canonical surface workload, which contains real MBOIT
      // geometry, and prove that only this topology adds the final-layer
      // reactive classification.
      await runtime.replaceScene(await createSurfaceSource());
      await runtime.waitForFrames(4);
      profile = await runtime.waitForCounters(runtime.frame - 1);
      const transparent = renderer.temporalEvidence();
      const transparentGraph = renderer.mainFrameGraphEvidence();
      if (transparentGraph === null) {
        throw new Error("Temporal transparent frame did not publish FrameGraph evidence");
      }
      const transparentPasses = transparentGraph.dump.passes
        .filter((entry) => !entry.culled)
        .map((entry) => entry.name);

      Object.assign(evidence, {
        temporalReconstruction: {
          fixed,
          fixedPasses,
          fixedResources,
          fixedProfilerCounters: fixedProfile.counters,
          fixedSubmits: fixedProfile.submits,
          fixedSamplesBefore,
          afterCameraCut,
          afterCameraRecovery,
          afterResize,
          adaptive,
          restoredFixed,
          transparent,
          transparentPasses,
          profilerCounters: profile.counters,
          gpuCounters: profile.gpuCounters.values,
          submits: profile.submits
        }
      });
      assertions.push(validationAssertion(
        "temporal-reconstruction-has-explicit-resolution-domains",
        fixed.enabled && fixed.reconstructionOwner === "taa" &&
          fixed.reconstructionInputDomain === "internal-full" &&
          fixed.reconstructionOutputDomain === "output-full" &&
          fixed.confidenceChannel === "alpha-history-lock" &&
          fixed.preExposureAware && fixed.reactiveMaskConsumed &&
          fixed.disocclusionConsumed && fixed.taaPasses === 1 &&
          fixed.classificationPasses === 1 &&
          fixed.internalWidth === Math.floor(fixed.outputWidth * 0.75) &&
          fixed.internalHeight === Math.floor(fixed.outputHeight * 0.75) &&
          fixed.outputPixels > fixed.internalPixels,
        "TemporalFeature reconstructs internal HDR into one typed output-resolution history product",
        fixed,
        "TAA owner, internal-full input, output-full result, confidence/reactive/disocclusion/pre-exposure contract"
      ));
      assertions.push(validationAssertion(
        "temporal-reconstruction-production-graph-is-closed",
        fixedPasses.filter((name) =>
          name.endsWith("temporal validity classification")
        ).length === 1 &&
          fixedPasses.filter((name) => name === "FX-06 final temporal validity classification").length === 1 &&
          fixedPasses.filter((name) => name === "FX-06B Final TAA/TAAU resolve").length === 1 &&
          fixedPasses.indexOf("FX-06 final temporal validity classification") <
            fixedPasses.indexOf("FX-06B Final TAA/TAAU resolve") &&
          fixedResources.filter((name) => name === "taa_history").length === 1 &&
          fixedResources.filter((name) => name === "taa_output").length === 1 &&
          fixedProfile.submits.count === 1,
        "Reactive classification and output-domain reconstruction are GPU producer-to-consumer closed in the main submit",
        { passes: fixedPasses, resources: fixedResources, submits: fixedProfile.submits },
        "one classifier, one reconstruction, one history read/write pair, one main submit"
      ));
      assertions.push(validationAssertion(
        "temporal-transparent-topology-adds-only-final-layer-classifier",
        transparent.classificationPasses === 2 &&
          transparentPasses.filter((name) =>
            name.endsWith("temporal validity classification")
          ).length === 2 &&
          transparentPasses.filter((name) =>
            name === "FX-06 opaque temporal validity classification"
          ).length === 1 &&
          transparentPasses.filter((name) =>
            name === "FX-06 final temporal validity classification"
          ).length === 1 &&
          transparentPasses.indexOf("FX-05 Packed transparent forward") <
            transparentPasses.indexOf("FX-06 final temporal validity classification"),
        "Only real transparent reactive coverage adds a second final-layer SurfaceValidity classification",
        { runtime: transparent, passes: transparentPasses },
        "opaque-only: one shared classifier; MBOIT: opaque plus final classifier ordered after reactive output"
      ));
      assertions.push(validationAssertion(
        "fixed-drs-is-deterministic-and-adaptive-is-explicit",
        fixed.drsMode === "fixed" &&
          fixed.drsAcceptedGpuSamples === fixedSamplesBefore &&
          adaptive.drsMode === "adaptive" &&
          adaptive.drsMinimumScale === 0.67 && adaptive.drsMaximumScale === 1 &&
          adaptive.drsTargetFrameRate === 60 &&
          JSON.stringify(adaptive.drsScaleBuckets) === JSON.stringify([0.67, 0.75, 0.8, 0.9, 1]) &&
          restoredFixed.drsMode === "fixed" && restoredFixed.internalScale === 0.75 &&
          profile.counters["temporal.drsAdaptive"] === 0,
        "Formal fixed mode consumes no timing feedback while adaptive game mode declares bounded buckets and target",
        { fixed, adaptive, restoredFixed, profilerCounters: profile.counters },
        "fixed sample count unchanged; adaptive range 0.67..1; final benchmark state fixed"
      ));
      assertions.push(validationAssertion(
        "temporal-history-rejects-cut-and-resize-then-recovers",
        !afterCameraCut.historyReadValid &&
          afterCameraCut.historyInvalidationReason === "camera-cut" &&
          afterCameraRecovery.historyReadValid &&
          !afterResize.historyReadValid &&
          afterResize.historyInvalidationReason === "output-resize" &&
          restoredFixed.historyReadValid &&
          profile.gpuCounters.sampled &&
          (profile.gpuCounters.values.temporalReactivePixels ?? 0) > 0 &&
          (profile.gpuCounters.values.temporalHistoryRejectedPixels ?? 0) >=
            (profile.gpuCounters.values.temporalReactivePixels ?? 0),
        "Camera cut and resize reject stale output history before sampling and subsequent submitted frames recover",
        { afterCameraCut, afterCameraRecovery, afterResize, restoredFixed, gpuCounters: profile.gpuCounters.values },
        "invalid immediately after cut/resize; valid after committed recovery frames"
      ));
    } else if (request.scenarioId === "shared-derived-products") {
      const renderer = runtime.renderer;
      if (renderer === null) throw new Error("Surface runtime is not initialized");
      const originalWidth = renderer.output_resolution.x;
      const originalHeight = renderer.output_resolution.y;
      renderer.configure({
        features: {
          screenSpaceDiffuseMode: "ssgi",
          screenSpaceReflections: true,
          temporalAntiAliasing: true,
          bloom: true,
          automaticExposure: true,
          motionBlur: false,
          sharpening: false
        },
        ssgi: { temporalEnabled: true, resolutionScale: 0.5 },
        ssr: { temporalEnabled: true, resolutionScale: 0.5 }
      });
      await runtime.waitForFrames(5);
      profile = await runtime.waitForCounters(runtime.frame - 1);
      const allOn = renderer.sharedDerivedProductsEvidence();
      const allOnGraph = renderer.mainFrameGraphEvidence();
      if (allOnGraph === null) throw new Error("Shared-products frame did not publish FrameGraph evidence");
      const allOnPasses = allOnGraph.dump.passes
        .filter((entry) => !entry.culled)
        .map((entry) => entry.name);
      const allOnResources = liveFrameGraphResourceNames(allOnGraph);
      const historyNames = allOn.histories.map((history) => history.name);
      const historyByName = new Map(allOn.histories.map((history) => [history.name, history]));

      const invalidationsBeforeCameraCut = new Map(
        allOn.histories.map((history) => [history.name, history.invalidationCount])
      );
      renderer.indicate_view_change();
      await runtime.waitForFrames(1);
      const afterCameraCut = renderer.sharedDerivedProductsEvidence();

      const resizedWidth = originalWidth === 640 ? 704 : 640;
      const resizedHeight = originalHeight === 360 ? 396 : 360;
      runtime.resize(resizedWidth, resizedHeight);
      await runtime.waitForFrames(1);
      const afterResize = renderer.sharedDerivedProductsEvidence();
      runtime.resize(originalWidth, originalHeight);
      await runtime.waitForFrames(1);

      renderer.configure({ features: { screenSpaceDiffuseMode: "gtao" } });
      await runtime.waitForFrames(1);
      const afterDiffuseModeSwitch = renderer.sharedDerivedProductsEvidence();

      renderer.configure({ features: { screenSpaceReflections: false } });
      await runtime.waitForFrames(2);
      const noOpaqueConsumer = renderer.sharedDerivedProductsEvidence();
      const noOpaqueGraph = renderer.mainFrameGraphEvidence();
      if (noOpaqueGraph === null) throw new Error("SSR-off shared-products frame did not publish FrameGraph evidence");
      const noOpaquePasses = noOpaqueGraph.dump.passes
        .filter((entry) => !entry.culled)
        .map((entry) => entry.name);
      const noOpaqueResources = liveFrameGraphResourceNames(noOpaqueGraph);

      renderer.configure({ features: { bloom: false, automaticExposure: false } });
      await runtime.waitForFrames(2);
      const allConsumersOff = renderer.sharedDerivedProductsEvidence();
      const allConsumersOffGraph = renderer.mainFrameGraphEvidence();
      if (allConsumersOffGraph === null) throw new Error("Shared-products-off frame did not publish FrameGraph evidence");
      const allConsumersOffPasses = allConsumersOffGraph.dump.passes
        .filter((entry) => !entry.culled)
        .map((entry) => entry.name);
      const allConsumersOffResources = liveFrameGraphResourceNames(allConsumersOffGraph);

      // Leave the always-screenshot artifact on the representative all-on
      // topology after the off-pruning evidence has been captured.
      renderer.configure({
        features: {
          screenSpaceDiffuseMode: "ssgi",
          screenSpaceReflections: true,
          bloom: true,
          automaticExposure: true
        }
      });
      await runtime.waitForFrames(3);

      Object.assign(evidence, {
        sharedDerivedProducts: {
          allOn: { runtime: allOn, passes: allOnPasses, resources: allOnResources },
          afterCameraCut,
          afterResize,
          afterDiffuseModeSwitch,
          noOpaqueConsumer: {
            runtime: noOpaqueConsumer,
            passes: noOpaquePasses,
            resources: noOpaqueResources
          },
          allConsumersOff: {
            runtime: allConsumersOff,
            passes: allConsumersOffPasses,
            resources: allConsumersOffResources
          },
          profilerCounters: profile.counters,
          submits: profile.submits
        }
      });
      assertions.push(validationAssertion(
        "shared-color-products-have-distinct-stages",
        allOn.abiVersion === 1 &&
          allOn.opaqueStage === "post-screen-space-diffuse-pre-ssr" &&
          allOn.finalStage === "post-transparency-temporal" &&
          allOn.pyramids.opaqueBuilds === 1 && allOn.pyramids.finalBuilds === 1 &&
          allOnPasses.filter((name) => name === "OpaqueColorPyramid shared producer").length === 1 &&
          allOnPasses.filter((name) => name === "FinalColorPyramid shared producer").length === 1 &&
          allOnResources.filter((name) => name === "OpaqueColorPyramid").length === 1 &&
          allOnResources.filter((name) => name === "FinalColorPyramid").length === 1 &&
          allOnPasses.indexOf("ScreenSpaceDiffuseResolve") <
            allOnPasses.indexOf("OpaqueColorPyramid shared producer") &&
          allOnPasses.indexOf("OpaqueColorPyramid shared producer") <
            allOnPasses.indexOf("SSR stochastic hit shading") &&
          allOnPasses.indexOf("FX-06B Final TAA/TAAU resolve") <
            allOnPasses.indexOf("FinalColorPyramid shared producer"),
        "Opaque and final HDR pyramids remain separate typed products at their frozen source stages",
        { runtime: allOn, passes: allOnPasses, resources: allOnResources },
        "one distinct producer/resource per semantic and ordered SSGI -> opaque pyramid -> SSR; TAA -> final pyramid"
      ));
      assertions.push(validationAssertion(
        "shared-depth-hzb-remains-single-producer",
        allOnPasses.filter((name) => name === "graph_rasterize_triangle_closest").length === 1 &&
          allOnResources.filter((name) => name === "hzb_current").length === 1 &&
          profile.counters["hzb.computeBuilds"] === 1 &&
          (profile.counters["hzb.dispatches"] ?? 0) > 0,
        "GTAO/SSGI/SSR continue to consume the per-view shared depth hierarchy instead of constructing effect-local HZBs",
        { passes: allOnPasses, resources: allOnResources, counters: profile.counters },
        "one current HZB resource/build, positive mip dispatches"
      ));
      assertions.push(validationAssertion(
        "final-pyramid-is-shared-by-bloom-and-exposure",
        allOn.opaqueConsumerCount === 1 && allOn.finalConsumerCount === 2 &&
          allOn.bloomConsumedFinalMips === 5 && allOn.bloomReconstructPasses === 5 &&
          allOn.exposureHistogramPasses === 1 && allOn.exposureMeteringMipLevel > 0 &&
          allOn.exposureMeteringPixels > 0 &&
          allOn.exposureMeteringPixels < originalWidth * originalHeight &&
          !allOnPasses.some((name) => /Bloom downsample|Bloom prefilter/i.test(name)) &&
          !allOnResources.some((name) => /Bloom downscale map/i.test(name)),
        "Bloom reconstruction and low-mip exposure metering consume one FinalColorPyramid without rebuilding equivalent downsample chains",
        allOn,
        "two consumers, one final producer, low-mip histogram and no legacy Bloom downsample pyramid"
      ));
      assertions.push(validationAssertion(
        "ssgi-source-does-not-alias-post-ssgi-pyramid",
        allOn.screenSpaceDiffuseSourcePyramidBuilds === 0 &&
          !allOnResources.some((name) => name === "ScreenSpaceDiffuseSourcePyramid") &&
          allOn.pyramids.allocatedBytes > 0,
        "SSGI keeps its full-resolution pre-SSGI radiance source; the shared opaque pyramid is only the post-diffuse SSR product",
        { runtime: allOn, resources: allOnResources },
        "no unproven SSGI source pyramid and no source-stage alias"
      ));
      assertions.push(validationAssertion(
        "history-contract-declarations-are-complete-and-unique",
        historyNames.length === 6 && new Set(historyNames).size === historyNames.length &&
          historyByName.get("color")?.semantic === "final-temporal-color" &&
          historyByName.get("color")?.resolutionDomain === "output-full" &&
          historyByName.get("color")?.bufferCount === 2 &&
          historyByName.get("ssgi")?.bufferCount === 4 &&
          historyByName.get("ssr")?.preExposure === "working-linear-rescale" &&
          historyByName.get("nss-feedback")?.preExposure === "invalidate-on-change" &&
          historyByName.get("exposure")?.resolutionDomain === "scalar" &&
          historyByName.get("exposure")?.format === "f32-buffer" &&
          ["color", "ssgi", "ssr", "exposure"].every((name) => {
            const history = historyByName.get(name);
            return history?.active === true && history.valid && history.readValid &&
              history.generation > 0 && history.preExposureScale > 0;
          }) &&
          historyByName.get("gtao")?.active === false &&
          historyByName.get("nss-feedback")?.active === false,
        "Every persistent consumer publishes semantic, domain, format, count, generation, validity and pre-exposure policy through one registry",
        allOn.histories,
        "six unique declarations; active histories valid and submission-advanced"
      ));
      assertions.push(validationAssertion(
        "history-reset-reasons-reject-stale-input",
        afterCameraCut.histories.filter((history) => history.active).every((history) =>
          history.lastInvalidationReason === "camera-cut" && !history.readValid &&
          history.invalidationCount > (invalidationsBeforeCameraCut.get(history.name) ?? -1)) &&
          afterResize.histories.filter((history) => history.active).every((history) =>
            history.lastInvalidationReason === "output-resize" && !history.readValid) &&
          afterDiffuseModeSwitch.histories.find((history) => history.name === "gtao")?.active === true &&
          afterDiffuseModeSwitch.histories.find((history) => history.name === "gtao")?.readValid === false &&
          afterDiffuseModeSwitch.histories.find((history) => history.name === "ssgi")?.active === false &&
          afterDiffuseModeSwitch.histories.every((history) =>
            history.lastInvalidationReason === "feature-toggle"),
        "Camera cut, output resize and GTAO/SSGI topology changes invalidate the old logical generation before the new frame reads history",
        { afterCameraCut, afterResize, afterDiffuseModeSwitch },
        "explicit reset reason, readValid=false on the reset frame and mutually exclusive diffuse histories"
      ));
      assertions.push(validationAssertion(
        "shared-products-prune-by-consumer",
        noOpaqueConsumer.pyramids.opaqueBuilds === 0 &&
          noOpaqueConsumer.pyramids.finalBuilds === 1 &&
          noOpaqueConsumer.opaqueConsumerCount === 0 && noOpaqueConsumer.finalConsumerCount === 2 &&
          !noOpaquePasses.includes("OpaqueColorPyramid shared producer") &&
          !noOpaqueResources.includes("OpaqueColorPyramid") &&
          allConsumersOff.pyramids.opaqueBuilds === 0 &&
          allConsumersOff.pyramids.finalBuilds === 0 &&
          allConsumersOff.pyramids.allocatedBytes === 0 &&
          allConsumersOff.opaqueConsumerCount === 0 && allConsumersOff.finalConsumerCount === 0 &&
          !allConsumersOffPasses.some((name) => /ColorPyramid shared producer/.test(name)) &&
          !allConsumersOffResources.some((name) => /ColorPyramid/.test(name)) &&
          allConsumersOff.histories.find((history) => history.name === "exposure")?.active === false,
        "Each shared product is created only for a live consumer and both owners disappear when all consumers are disabled",
        { noOpaqueConsumer, noOpaquePasses, allConsumersOff, allConsumersOffPasses },
        "SSR off prunes opaque only; SSR/Bloom/Exposure off prunes both and exposure history"
      ));
      assertions.push(validationAssertion(
        "shared-products-stay-in-main-submit",
        profile.submits.count === 1 && profile.submits.labels["Renderer/main-0"] === 1 &&
          profile.counters["sharedPyramid.opaqueBuilds"] === 1 &&
          profile.counters["sharedPyramid.finalBuilds"] === 1 &&
          (profile.counters["sharedPyramid.exposureMeteringPixels"] ?? 0) > 0,
        "Shared reductions, Bloom and exposure remain observable inside the single main command submission",
        { submits: profile.submits, counters: profile.counters },
        "one main submit and matching shared-product profiler counters"
      ));
    } else if (request.scenarioId === "ssr-replacement") {
      const renderer = runtime.renderer;
      if (renderer === null) throw new Error("Surface runtime is not initialized");
      await runtime.replaceScene(await createSsrReplacementSource());
      renderer.configure({
        features: { screenSpaceDiffuseMode: "gtao", screenSpaceReflections: true },
        ssr: {
          resolutionScale: 0.5,
          temporalEnabled: true,
          maxDistanceMeters: 16,
          edgeFade: 0.07,
          maxSteps: 128,
          baseThicknessMeters: 0.08,
          distanceThicknessScale: 0.01,
          maxRoughness: 0.65,
          mirrorBias: 0.5,
          temporalStrength: 0.9
        }
      });
      await runtime.waitForFrames(5);
      profile = await runtime.waitForCounters(runtime.frame - 1);
      const on = renderer.screenSpaceReflectionsEvidence();
      const onGraph = renderer.mainFrameGraphEvidence();
      if (onGraph === null) throw new Error("SSR-on frame did not publish FrameGraph evidence");
      const onPasses = onGraph.dump.passes.filter((entry) => !entry.culled).map((entry) => entry.name);
      const onResources = liveFrameGraphResourceNames(onGraph);
      const ssrPasses = onPasses.filter((name) => /SSR|screen.?space reflection/i.test(name));
      const counters = profile.gpuCounters.values;
      const onSubmits = profile.submits;

      renderer.configure({ features: { screenSpaceReflections: false } });
      await runtime.waitForFrames(3);
      const offProfile = await runtime.waitForCounters(profile.frameIndex);
      const off = renderer.screenSpaceReflectionsEvidence();
      const offGraph = renderer.mainFrameGraphEvidence();
      if (offGraph === null) throw new Error("SSR-off frame did not publish FrameGraph evidence");
      const offPasses = offGraph.dump.passes.filter((entry) => !entry.culled).map((entry) => entry.name);
      const offResources = liveFrameGraphResourceNames(offGraph);
      const offSsrPasses = offPasses.filter((name) => /SSR|screen.?space reflection/i.test(name));
      const offSsrResources = offResources.filter((name) => /SSR|ssr_|baseline-specular/i.test(name));

      renderer.configure({
        features: { screenSpaceReflections: true },
        ssr: { temporalEnabled: false }
      });
      await runtime.waitForFrames(3);
      profile = await runtime.waitForCounters(offProfile.frameIndex);
      const noTemporal = renderer.screenSpaceReflectionsEvidence();
      const noTemporalGraph = renderer.mainFrameGraphEvidence();
      if (noTemporalGraph === null) throw new Error("SSR temporal-off frame did not publish FrameGraph evidence");
      const noTemporalPasses = noTemporalGraph.dump.passes
        .filter((entry) => !entry.culled)
        .map((entry) => entry.name);

      Object.assign(evidence, {
        ssrReplacement: {
          on: { runtime: on, passes: ssrPasses, resources: onResources, counters, submits: onSubmits },
          off: { runtime: off, passes: offSsrPasses, resources: offSsrResources },
          temporalOff: { runtime: noTemporal, passes: noTemporalPasses }
        }
      });
      assertions.push(validationAssertion(
        "three-ssr-pinned-production-path",
        on.enabled && on.algorithm === "three-ssr-r186-oengine-hzb-wgsl" &&
          on.upstreamRevision === "148ef33ecb6d2502ff796d4554abd1549c95d519" &&
          on.traceFormat === "rg32uint" && on.rawSpecularFormat === "rgba16float" &&
          on.rawAlphaSemantic === "specular-dominant-ray-length" &&
          on.resolvedAlphaSemantic === "replacement-confidence" &&
          on.correctionMode === "confidence-baseline-replacement",
        "The ordinary opaque path exposes the pinned Three-derived HZB/VNDF SSR and OEngine baseline replacement ABI",
        on,
        "pinned revision, packed trace, ray-length raw alpha and confidence replacement"
      ));
      assertions.push(validationAssertion(
        "ssr-temporal-recurrent-history-closure",
        on.tracePasses === 1 && on.prefilterPasses === 1 && on.resolvePasses === 1 &&
          on.temporalPasses === 1 && on.recurrentDenoisePasses === 1 &&
          on.compositePasses === 1 && on.historyTextureCount === 2 && on.historyValid &&
          on.historyBytes === on.tracePixels * 8 * 2 &&
          ssrPasses.includes("SSR stochastic hit shading") &&
          ssrPasses.includes("SSR temporal reproject") &&
          ssrPasses.includes("SSR recurrent specular denoise") &&
          ssrPasses.includes("SSR specular correction") &&
          ssrPasses.indexOf("SSR stochastic hit shading") < ssrPasses.indexOf("SSR temporal reproject") &&
          ssrPasses.indexOf("SSR temporal reproject") < ssrPasses.indexOf("SSR recurrent specular denoise") &&
          ssrPasses.indexOf("SSR recurrent specular denoise") < ssrPasses.indexOf("SSR specular correction"),
        "TemporalReproject reads external recurrent history and RecurrentDenoise owns the next history before one replacement composite",
        { runtime: on, passes: ssrPasses },
        "one trace/prefilter/hit/temporal/recurrent/correction chain and two rgba16float histories"
      ));
      assertions.push(validationAssertion(
        "ssr-real-gpu-trace-evidence",
        (counters.ssrTracePixels ?? 0) > 0 && (counters.ssrHitPixels ?? 0) > 0 &&
          (counters.ssrTraceSteps ?? 0) > 0 && (counters.ssrMaxTraceSteps ?? 0) > 0 &&
          onSubmits.count === 1 && onSubmits.labels["Renderer/main-0"] === 1,
        "A real GPU trace produces validated screen-space hits and remains inside the single main submission",
        { counters, submits: onSubmits },
        "trace/hit/step counters > 0 and one main submit"
      ));
      assertions.push(validationAssertion(
        "ssr-feature-off-zero-cost",
        !off.enabled && off.algorithm === "disabled" && off.tracePasses === 0 &&
          off.prefilterPasses === 0 && off.resolvePasses === 0 && off.temporalPasses === 0 &&
          off.recurrentDenoisePasses === 0 && off.compositePasses === 0 &&
          off.historyTextureCount === 0 && off.historyBytes === 0 &&
          offSsrPasses.length === 0 && offSsrResources.length === 0 &&
          (offProfile.gpuCounters.values.ssrTracePixels ?? 0) === 0,
        "Disabling SSR removes baseline materialization, owner, graph passes, transient resources, histories and counter dispatch",
        { runtime: off, passes: offSsrPasses, resources: offSsrResources },
        "all SSR work/resources/history absent"
      ));
      assertions.push(validationAssertion(
        "ssr-temporal-off-prunes-history",
        noTemporal.enabled && !noTemporal.temporalEnabled && noTemporal.temporalPasses === 0 &&
          noTemporal.recurrentDenoisePasses === 1 && noTemporal.historyTextureCount === 0 &&
          noTemporal.historyBytes === 0 &&
          !noTemporalPasses.includes("SSR temporal reproject") &&
          noTemporalPasses.includes("SSR recurrent specular denoise"),
        "Temporal-off SSR keeps current-frame recurrent filtering but allocates no history or temporal pass",
        { runtime: noTemporal, passes: noTemporalPasses },
        "recurrent = 1, temporal/history = 0"
      ));
      renderer.configure({ ssr: { temporalEnabled: true } });
      await runtime.waitForFrames(3);
      profile = await runtime.waitForCounters(profile.frameIndex);
    } else if (request.scenarioId === "ssgi-production") {
      const renderer = runtime.renderer;
      if (renderer === null) throw new Error("Surface runtime is not initialized");
      const scene = runtime.scene;
      if (scene === null) throw new Error("Surface scene is not initialized");
      renderer.uploadBrick4LightMap(scene, createBrick4Fixture(1));
      renderer.configure({
        features: { screenSpaceDiffuseMode: "ssgi", screenSpaceReflections: false },
        ssgi: {
          samplingDomain: "screen",
          radiusMeters: 2,
          screenSpaceRadius: 12,
          thicknessMeters: 1,
          aoIntensity: 1,
          giIntensity: 10,
          resolutionScale: 0.5,
          temporalEnabled: true,
          sliceCount: 2,
          stepCount: 8,
          spatialStep: 1,
          temporalBlend: 0.92,
          backfaceLighting: 0
        }
      });
      await runtime.waitForFrames(5);
      const brickProfile = await runtime.waitForCounters(runtime.frame - 1);
      renderer.invalidateBrick4LightMap(scene, 2);
      await runtime.waitForFrames(2);
      profile = await runtime.waitForCounters(runtime.frame - 1);
      const ssgi = renderer.screenSpaceGiEvidence();
      const gtao = renderer.ambientOcclusionEvidence();
      const graph = renderer.mainFrameGraphEvidence();
      if (graph === null) throw new Error("SSGI frame did not publish FrameGraph evidence");
      const passes = graph.dump.passes.filter((entry) => !entry.culled).map((entry) => entry.name);
      const resources = liveFrameGraphResourceNames(graph);
      const counters = profile.gpuCounters.values;
      const brickCounters = brickProfile.gpuCounters.values;
      const evaluated = counters.ssgiEvaluatedPixels ?? 0;
      const accepted = counters.ssgiHistoryAcceptedPixels ?? 0;
      const rejected = counters.ssgiHistoryRejectedPixels ?? 0;
      const providerReceivers =
        (counters.longRangeBrick4Receivers ?? 0) +
        (counters.longRangeProbeReceivers ?? 0) +
        (counters.longRangeIblReceivers ?? 0) +
        (counters.longRangeBlackReceivers ?? 0);
      const providerUnassigned = counters.longRangeProviderUnassigned ?? 0;
      const providerDuplicates = counters.longRangeProviderDuplicates ?? 0;
      Object.assign(evidence, { ssgiProduction: { runtime: ssgi, passes, resources, counters } });
      assertions.push(validationAssertion(
        "receiver-local-provider-generation-fallback",
        (brickCounters.longRangeBrick4Receivers ?? 0) > 0 &&
          (brickCounters.longRangeProbeReceivers ?? 0) === 0 &&
          (brickCounters.longRangeIblReceivers ?? 0) === 0 &&
          (counters.longRangeBrick4Receivers ?? 0) === 0 &&
          (counters.longRangeInvalidGeneration ?? 0) > 0 &&
          (counters.longRangeIblReceivers ?? 0) > 0,
        "A resident Brick4 generation owns covered receivers, then stale generation deterministically falls through to IBL",
        { resident: brickCounters, invalidated: counters },
        "resident: Brick4 only; invalidated: invalid-generation > 0 and IBL fallback > 0"
      ));
      assertions.push(validationAssertion(
        "three-ssgi-pinned-production-path",
        ssgi.enabled && ssgi.algorithm === "three-ssgi-r186-oengine-wgsl" &&
          ssgi.upstreamRevision === "148ef33ecb6d2502ff796d4554abd1549c95d519" &&
          ssgi.samplingDomain === "screen" && ssgi.radiusMeters === 2 &&
          ssgi.radiusWorldUnits === 2 && ssgi.screenSpaceRadius === 12 &&
          ssgi.activeRadius === 12 && ssgi.activeRadiusUnit === "screen-radius" &&
          ssgi.tracePasses === 1 && ssgi.spatialPasses === 1 &&
          ssgi.temporalPasses === 1 && ssgi.resolvePasses === 1,
        "The ordinary opaque-lighting path runs one pinned Three.js r186-derived SSGI trace/filter/history/resolve chain",
        ssgi,
        "one pass per SSGI phase"
      ));
      assertions.push(validationAssertion(
        "ssgi-exclusive-screen-diffuse-owner",
        !gtao.enabled && gtao.historyTextureCount === 0 &&
          !passes.some((name) => /GTAO/i.test(name)) &&
          passes.some((name) => name === "ScreenSpaceDiffuseResolve"),
        "SSGI owns AO, bent normal and near-field diffuse GI without retaining an independent GTAO owner",
        { gtao, passes },
        "no GTAO pass/history and exactly one screen-space diffuse resolve"
      ));
      assertions.push(validationAssertion(
        "ssgi-no-feedback-products",
        resources.some((name) => name === "SSGI incident diffuse GI") &&
          resources.some((name) => name === "pre-SSGI resolved long-range diffuse") &&
          passes.indexOf("Three SSGI r186 horizon-bitfield trace") <
            passes.indexOf("ScreenSpaceDiffuseResolve"),
        "SSGI reads a pre-screen-space-diffuse source and composes only after trace/history resolve",
        { passes, resources },
        "pre-SSGI source ordering and explicit long-range component"
      ));
      assertions.push(validationAssertion(
        "ssgi-temporal-provider-closure",
        evaluated > 0 && accepted + rejected === evaluated &&
          providerReceivers > 0 && providerUnassigned === 0 &&
          providerDuplicates === 0 && profile.submits.count === 1,
        "SSGI samples close temporally while the full-resolution authoritative GI producer assigns exactly one provider in the main submit",
        { evaluated, accepted, rejected, providerReceivers, providerUnassigned, providerDuplicates, submits: profile.submits },
        "accepted + rejected = evaluated; provider receivers > 0; unassigned = duplicate = 0; one submit"
      ));
    } else if (request.scenarioId === "gtao-replacement") {
      const renderer = runtime.renderer;
      if (renderer === null) throw new Error("Surface runtime is not initialized");
      renderer.configure({
        features: { screenSpaceDiffuseMode: "gtao" },
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
      const onResources = liveFrameGraphResourceNames(onGraph);
      const gtaoPasses = onPasses.filter((name) => /GTAO/i.test(name));
      const gtaoResources = onResources.filter((name) => /GTAO|ao_history|ao_output/i.test(name));
      const onCounters = {
        evaluated: profile.gpuCounters.values.aoEvaluatedPixels ?? 0,
        historyAccepted: profile.gpuCounters.values.aoHistoryAcceptedPixels ?? 0,
        historyRejected: profile.gpuCounters.values.aoHistoryRejectedPixels ?? 0
      };

      renderer.configure({ features: { screenSpaceDiffuseMode: "off" } });
      await runtime.waitForFrames(3);
      const offProfile = await runtime.waitForCounters(profile.frameIndex);
      const offAo = renderer.ambientOcclusionEvidence();
      const offGraph = renderer.mainFrameGraphEvidence();
      if (offGraph === null) throw new Error("GTAO-off frame did not publish FrameGraph evidence");
      const offPasses = offGraph.dump.passes.filter((entry) => !entry.culled).map((entry) => entry.name);
      const offResources = liveFrameGraphResourceNames(offGraph);
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
      renderer.configure({ features: { screenSpaceDiffuseMode: "gtao" } });
      await runtime.waitForFrames(4);
      profile = await runtime.waitForCounters(offProfile.frameIndex);
    } else if (request.scenarioId === "lpv-baseline-pruning") {
      const renderer = runtime.renderer;
      if (renderer === null) throw new Error("Surface runtime is not initialized");
      renderer.configure({ features: { screenSpaceReflections: false } });
      await runtime.waitForFrames(2);
      const offProfile = await runtime.waitForCounters(runtime.frame - 1);
      const offGraph = renderer.mainFrameGraphEvidence();
      if (offGraph === null) throw new Error("LPV SSR-off frame did not publish FrameGraph evidence");
      const offPasses = offGraph.dump.passes.filter((entry) => !entry.culled).map((entry) => entry.name);
      const offResources = liveFrameGraphResourceNames(offGraph);

      renderer.configure({ features: { screenSpaceReflections: true } });
      await runtime.waitForFrames(2);
      profile = await runtime.waitForCounters(Math.max(offProfile.frameIndex, runtime.frame - 1));
      const onGraph = renderer.mainFrameGraphEvidence();
      if (onGraph === null) throw new Error("LPV SSR-on frame did not publish FrameGraph evidence");
      const onPasses = onGraph.dump.passes.filter((entry) => !entry.culled).map((entry) => entry.name);
      const onResources = liveFrameGraphResourceNames(onGraph);
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
            liveTransientResources: offGraph.resources.liveTransient
          },
          on: {
            cacheKey: onGraph.cacheKey,
            baselineResources: onBaselineResources,
            ssrPasses: onSsrPasses,
            liveTransientResources: onGraph.resources.liveTransient
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
        "lpv-ssr-topology-changes-live-transients",
        onGraph.resources.liveTransient > offGraph.resources.liveTransient,
        "The SSR-on graph owns more live transient logical resources than the pruned SSR-off graph",
        { off: offGraph.resources.liveTransient, on: onGraph.resources.liveTransient },
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

function createBrick4Fixture(generation: number) {
  const storage = new Uint8Array(32 + 100 * 4);
  const view = new DataView(storage.buffer);
  view.setFloat32(0, -1_000_000, true);
  view.setFloat32(4, -1_000_000, true);
  view.setFloat32(8, -1_000_000, true);
  view.setFloat32(16, 1_000_000, true);
  view.setFloat32(20, 1_000_000, true);
  view.setFloat32(24, 1_000_000, true);
  const words = new Uint32Array(storage.buffer, 32);
  words.fill(93, 0, 64);
  // RGB9E5-like DC near one, then zero-ish signed higher SH bands.
  words[93] = (511 | (511 << 9) | (511 << 18) | (15 << 27)) >>> 0;
  words.fill(0x7f7f7f7f, 94, 100);
  return createBrick4LightMapPackageV1({
    generation,
    storage,
    sourceUri: `validation://brick4/generation-${generation}`
  });
}

/** Deterministic screen-space reflection receiver/occluder workload. */
async function createSsrReplacementSource(): Promise<PackedSceneSource> {
  const mirrorFloor = solidMaterial([0.72, 0.76, 0.82, 1], 0.08, 1);
  const red = solidMaterial([0.95, 0.04, 0.025, 1], 0.22, 0.05);
  const gold = solidMaterial([1.0, 0.55, 0.08, 1], 0.16, 0.82);
  const blue = solidMaterial([0.03, 0.22, 0.95, 1], 0.28, 0.1);
  return createPackedBoxScene([
    { size: [18, 0.4, 18], position: [0, -0.2, 0], materialIndex: 0, debugId: 101 },
    { size: [2.4, 3.4, 2.4], position: [-3.2, 1.7, 0.5], materialIndex: 1, debugId: 102 },
    { size: [2.2, 4.6, 2.2], position: [0, 2.3, -1.4], materialIndex: 2, debugId: 103 },
    { size: [2.8, 2.8, 2.8], position: [3.4, 1.4, 1.2], materialIndex: 3, debugId: 104 }
  ], [mirrorFloor, red, gold, blue]);
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

function liveFrameGraphResourceNames(graph: Readonly<{
  dump: Readonly<{
    resources: readonly Readonly<{
      name: string;
      firstUsePass?: number;
    }>[];
  }>;
}>): string[] {
  return graph.dump.resources
    .filter((entry) => entry.firstUsePass !== undefined)
    .map((entry) => entry.name);
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
