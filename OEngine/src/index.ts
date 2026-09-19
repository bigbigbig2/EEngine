/**
 * 公共 API 入口：集中导出渲染器、场景、资源加载和基础类型。
 */

export { AnimationClipFlags } from "./animation/AnimationClipFlags.js";
export { BoxGeometry, buildBoxSourceGeometry } from "./geometry/BoxGeometry.js";
export {
  SOURCE_DEFAULT_MATERIAL_ID,
  createSourceGeometry
} from "./assets/SourceGeometry.js";
export type {
  SourceAlphaMode,
  SourceGeometry,
  SourceGeometryBounds,
  SourceGeometryInput,
  SourceMaterialRange,
  SourceNumericArray,
  SourceVertexDataType,
  SourceVertexStream,
  SourceVertexStreamInput
} from "./assets/SourceGeometry.js";
export {
  BEVY_MESHLET_REFERENCE_COMMIT,
  GEOMETRY_COOK_RECIPE_VERSION,
  GEOMETRY_COOK_RECIPE_V3_VERSION,
  MESHOPTIMIZER_COOKER_COMMIT,
  NYX_GEOMETRY_REFERENCE_COMMIT,
  createGeometryCookRecipe,
  createGeometryCookRecipeV3,
  geometryCookRecipeV3Key,
  geometryCookRecipeKey
} from "./assets/GeometryCookRecipe.js";
export type {
  DegenerateTrianglePolicy,
  GeometryHierarchyMode,
  GeometryFloatMode,
  GeometryCookRecipe,
  GeometryCookRecipeInput,
  GeometryCookRecipeV3,
  GeometryVertexProfile,
  MissingAttributePolicy,
  NonManifoldPolicy
} from "./assets/GeometryCookRecipe.js";
export {
  RUNTIME_ASSET_FORMAT_VERSION,
  RUNTIME_ASSET_FORMAT_VERSION_V2,
  RUNTIME_ASSET_PACKAGE_SCHEMA_HASH,
  RuntimeAssetPackageError,
  openRuntimeAssetPackage,
  validateRuntimeAssetPackage,
  writeRuntimeAssetPackage
} from "./assets/RuntimeAssetPackage.js";
export {
  RUNTIME_ASSET_MANIFEST_V2_SCHEMA_VERSION,
  RuntimeAssetManifestV2Error,
  openRuntimeAssetPackageV2,
  selectRuntimeAssetVariantV2,
  writeRuntimeAssetPackageV2
} from "./assets/RuntimeAssetManifestV2.js";
export type {
  RuntimeAssetChunkInputV2,
  RuntimeAssetChunkV2,
  RuntimeAssetDependencyV2,
  RuntimeAssetLimitRequirementV2,
  RuntimeAssetManifestV2,
  RuntimeAssetPackageV2,
  RuntimeAssetPackageWriteInputV2,
  RuntimeAssetSourceProvenanceV2,
  RuntimeAssetVariantV2
} from "./assets/RuntimeAssetManifestV2.js";
export {
  BRICK4_BRANCH_WORDS,
  BRICK4_LIGHT_MAP_SCHEMA_VERSION,
  BRICK4_NODE_PROBE_COUNT,
  BRICK4_PROBE_WORDS,
  BRICK4_STORAGE_HEADER_BYTES,
  createBrick4LightMapPackageV1,
  validateBrick4LightMapPackageV1
} from "./assets/Brick4LightMapPackage.js";
export type {
  Brick4LightMapPackageV1,
  Brick4LightMapPackageValidation
} from "./assets/Brick4LightMapPackage.js";
export type { Brick4LightMapEvidence } from "./gpu/Brick4LightMap.js";
export {
  TEXTURE_ASSET_SCHEMA_VERSION,
  TEXTURE_COOKER_VERSION,
  openTextureAssetPackageV2,
  selectTextureAssetVariantV2,
  uploadTextureAssetPackageV2,
  writeEncodedTextureAssetPackageV2
} from "./assets/TextureAssetPackage.js";
export type {
  SelectedTextureVariantV2,
  EncodedTextureMipV2,
  EncodedTextureVariantV2,
  TextureAssetPackageV2,
  TextureAssetLoadEvidenceV2,
  TextureCookRecipeV2,
  TextureCookSourceV2,
  TextureMipV2,
  TextureSemanticV2,
  TextureUploadEvidenceV2,
  TextureUploadOptionsV2,
  TextureVariantMetadataV2,
  UploadedTextureAssetV2
} from "./assets/TextureAssetPackage.js";
export { RuntimeAssetResidencyState } from "./assets/RuntimeAssetResidency.js";
export {
  HttpRangeReadablePackV3,
  MemoryRangeReadablePackV3,
  OegPackV3Error,
  openOegPackV3
} from "./assets/OegPackV3.js";
export type {
  OegPackHeaderV3,
  OegPackV3,
  RangeReadablePackV3
} from "./assets/OegPackV3.js";
export {
  AssetCodecService,
  AssetCodecTaskError,
  defaultAssetCodecWorkerCount
} from "./assets/codec/AssetCodecService.js";
export type {
  AssetCodecIdentityEvidence,
  AssetCodecServiceEvidence,
  AssetCodecServiceOptions
} from "./assets/codec/AssetCodecService.js";
export {
  KTX_SOFTWARE_CODEC_ID,
  KTX_SOFTWARE_CODEC_REVISION,
  KTX_SOFTWARE_TRANSCODE_TARGETS,
  KTX_SOFTWARE_WASM_SHA256,
  createKtx2AssetCodecService,
  createKtx2TranscodeTask,
  encodedTextureVariantFromKtx2Result,
  estimateKtx2TranscodePeakBytes,
  prepareKtx2TextureAssetPackageV2
} from "./assets/codec/Ktx2BasisCodec.js";
export type { PrepareKtx2TextureOptions } from "./assets/codec/Ktx2BasisCodec.js";
export { planTextureDecode } from "./assets/codec/AssetCodecPlanner.js";
export { WebCookCoordinator } from "./assets/web-cook/WebCookCoordinator.js";
export type {
  WebCookCoordinatorEvidence,
  WebCookCoordinatorOptions,
  WebCookProductPage,
  WebCookProductRevision,
  WebCookUnitContext,
  WebRuntimeCooker
} from "./assets/web-cook/WebCookCoordinator.js";
export { WebCookProductProvider } from "./assets/web-cook/WebCookProductProvider.js";
export type {
  WebCookProductProviderEvidence,
  WebCookProductProviderOptions
} from "./assets/web-cook/WebCookProductProvider.js";
export { WebCookClient } from "./assets/web-cook/WebCookClient.js";
export type { WebCookClientEvidence, WebCookClientOptions } from "./assets/web-cook/WebCookClient.js";
export { WebCookBudgetLedger } from "./assets/web-cook/WebCookBudget.js";
export type {
  WebCookBudgetEvidence,
  WebCookBudgetKind,
  WebCookBudgetLease,
  WebCookGlobalBudgetLimits
} from "./assets/web-cook/WebCookBudget.js";
export { WebCookRuntimeAsset } from "./assets/web-cook/WebCookRuntimeAsset.js";
export { createWebCookSceneSource, createWebCookSceneSourceAsync } from "./assets/web-cook/WebCookSceneSource.js";
export type {
  WebCookSceneSourceOptions,
  WebCookSceneSourceResult
} from "./assets/web-cook/WebCookSceneSource.js";
export { load_oegpack_product, OegPackProductAsset } from "./assets/geometry-product/OegPackProductAsset.js";
export type {
  OegPackProductAssetEvidenceV1,
  OegPackProductAssetOptions,
  OegPackProductSourceSelectionV3
} from "./assets/geometry-product/OegPackProductAsset.js";
export { createOegPackSceneSource } from "./assets/geometry-product/OegPackSceneSourceV1.js";
export {
  OEGPACK_SCENE_MANIFEST_SCHEMA_V3,
  OegPackSceneManifestError,
  parseOegPackSceneManifestV3,
  resolveOegPackScenePackUrlV3
} from "./assets/geometry-product/OegPackSceneManifestV3.js";
export type {
  OegPackSceneManifestAssetV3,
  OegPackSceneManifestInstanceV3,
  OegPackSceneManifestPackV3,
  OegPackSceneManifestV3
} from "./assets/geometry-product/OegPackSceneManifestV3.js";
export {
  buildVirtualGeometrySceneSourceV1
} from "./assets/geometry-product/VirtualGeometrySceneSourceV1.js";
export type {
  VirtualGeometrySceneInstanceV1,
  VirtualGeometrySceneSourceOptionsV1,
  VirtualGeometrySceneSourceResultV1
} from "./assets/geometry-product/VirtualGeometrySceneSourceV1.js";
export {
  canonicalizeSceneGeometryV1,
  cookSceneGeometryProductV1
} from "./assets/geometry-product/SceneGeometryCanonicalizerV1.js";
export type {
  SceneGeometryCanonicalizationV1,
  SceneGeometryProductOptions,
  CookedSceneGeometryProductV1
} from "./assets/geometry-product/SceneGeometryCanonicalizerV1.js";
export { createDefaultWebGeometryCookerModule } from "./assets/web-cook/wasm/WebGeometryCookerAbi.js";
export { createWebCookWorker, createWebCookWorkerPool, createDefaultWebCookWorker } from "./assets/web-cook/WebCookWorkerFactory.js";
export type {
  DefaultWebCookWorkerFactoryOptions,
  WebCookWorkerFactoryOptions,
  WebCookRuntimeProfileCapability
} from "./assets/web-cook/WebCookWorkerFactory.js";
export { resolveWebCookRuntimeProfile } from "./assets/web-cook/WebCookWorkerFactory.js";
export { WebCookWorkerPool } from "./assets/web-cook/WebCookWorkerPool.js";
export type { WebCookWorkerPoolOptions } from "./assets/web-cook/WebCookWorkerPool.js";
export {
  GeometryProductAdmissionController
} from "./gpu/GeometryProductAdmission.js";
export type {
  GeometryProductAdmissionControllerEvidenceV1
} from "./gpu/GeometryProductAdmission.js";
export type { GeometryPageRegistrationOptionsV1 } from "./gpu/GeometryPageScheduler.js";
export { GeometryPageSchedulerV1 } from "./gpu/GeometryPageScheduler.js";
export type {
  GeometryPageSchedulerEvidenceV1,
  GeometryPageSchedulerOptionsV1,
  GeometryPageUploadSinkV1
} from "./gpu/GeometryPageScheduler.js";
export {
  GeometryDemandReadbackRingV1,
  GpuGeometryDemandReadbackRingV1
} from "./gpu/GeometryDemandReadbackRing.js";
export type {
  GeometryDemandReadbackResultV1,
  GeometryDemandReadbackSlotV1,
  GeometryDemandReadbackSlotStateV1,
  GpuGeometryDemandReadbackRingOptionsV1
} from "./gpu/GeometryDemandReadbackRing.js";
export { GeometryPageStreamingRuntimeV1 } from "./gpu/GeometryPageStreamingRuntime.js";
export type {
  GeometryPageStreamingPollEvidenceV1,
  GeometryPageStreamingRuntimeEvidenceV1,
  GeometryPageStreamingRuntimeOptionsV1
} from "./gpu/GeometryPageStreamingRuntime.js";
export { VirtualGeometryResidency } from "./gpu/VirtualGeometryResidency.js";
export type {
  GeometryPageLocationV1,
  GeometryProductGpuBindingsV1,
  VirtualGeometryResidencyEvidenceV1
} from "./gpu/VirtualGeometryResidency.js";
export {
  GEOMETRY_PAGE_DEMAND_ABI_VERSION,
  GEOMETRY_PAGE_DEMAND_HEADER_BYTES,
  GEOMETRY_PAGE_DEMAND_RECORD_BYTES,
  GEOMETRY_PAGE_DEMAND_MAX_QUEUE_BYTES_V1,
  GEOMETRY_PAGE_DEMAND_MAX_RECORD_CAPACITY_V1,
  createGeometryPageDemandQueueV1,
  deduplicateGeometryPageDemandsV1,
  packGeometryPageDemandHeaderV1,
  packGeometryPageDemandV1,
  reserveGeometryPageDemandV1,
  unpackGeometryPageDemandHeaderV1,
  unpackGeometryPageDemandV1
} from "./gpu/GeometryPageDemandAbiV1.js";
export type {
  GeometryPageDemandV1,
  GeometryPageDemandQueueHeaderV1,
  GeometryPageDemandQueueStateV1
} from "./gpu/GeometryPageDemandAbiV1.js";
export { WebCookWorkerTransport } from "./assets/web-cook/WebCookWorkerTransport.js";
export type {
  WebCookWorkerPort,
  WebCookWorkerTransportEvidence
} from "./assets/web-cook/WebCookWorkerTransport.js";
export { WebCookWorkerHost, installWebCookWorkerHost } from "./assets/web-cook/WebCookWorkerHost.js";
export type { WebCookWorkerHostOptions, WebCookWorkerHostPort } from "./assets/web-cook/WebCookWorkerHost.js";
export { installWebCookWorkerEntry } from "./assets/web-cook/WebCookWorkerEntry.js";
export type { WebCookWorkerEntryOptions, WebCookWorkerModuleFactory } from "./assets/web-cook/WebCookWorkerEntry.js";
export { selectTextureTranscodeTarget } from "./assets/codec/TextureCodecPolicy.js";
export type {
  AssetCodecEvidence,
  AssetCodecMipResult,
  AssetCodecPriority,
  AssetCodecTask,
  AssetCodecTaskKind,
  AssetCodecTaskResult,
  Ktx2SourceEncoding,
  Ktx2TranscodeTargetFormat,
  Ktx2TranscodeTask
} from "./assets/codec/AssetCodecTypes.js";
export type {
  TextureDecodePlan,
  TextureDecodePlanRequest,
  TexturePlanVariant
} from "./assets/codec/AssetCodecPlanner.js";
export type {
  TextureCodecCapabilities,
  TextureCodecTargetRequest
} from "./assets/codec/TextureCodecPolicy.js";
export type {
  RuntimeAssetRequestState,
  RuntimeAssetResidencyBudget,
  RuntimeAssetResidencyBudgetHooks,
  RuntimeAssetResidencyBudgetRequest,
  RuntimeAssetResidencyEvidence,
  RuntimeAssetResidencyReservation,
  RuntimeAssetPhysicalRange,
  RuntimeAssetResidentRange
} from "./assets/RuntimeAssetResidency.js";
export type {
  RuntimeAssetManifest,
  RuntimeAssetPackage,
  RuntimeAssetPackageOpenOptions,
  RuntimeAssetPackageWriteInput,
  RuntimeAssetSectionInput,
  RuntimeAssetSectionView,
  RuntimeAssetValidationIssue,
  RuntimeAssetValidationReport,
  RuntimeAssetValidationSeverity
} from "./assets/RuntimeAssetPackage.js";
// GeometryAssetPackage/GeometryCooker remain test/tool oracle modules only;
// production consumers enter through the Product ABI below.
export {
  DEFAULT_GEOMETRY_WORK_BUDGET,
  GeometryAdaptiveSseController,
  normalizeGeometryWorkBudget
} from "./render/GeometryWorkBudget.js";
export type {
  GeometryAdaptiveSseOptions,
  GeometryBudgetMode,
  GeometryWorkBudget,
  GeometryWorkSample
} from "./render/GeometryWorkBudget.js";
export type {
  GpuSceneEvidence,
  InstanceMaterialPatch,
  InstancePatchBatch,
  InstancePatchResult,
  InstanceStaticPatch,
  InstanceVisibilityPatch,
  InstanceSetHandle,
  InstanceSource,
  InstanceTransformPatch
} from "./gpu/GpuScene.js";
export { INSTANCE_SOURCE_FLAGS } from "./gpu/GpuScene.js";
export type { GraphicsOwnerCreationEvidence } from "./gpu/GraphicsContext.js";
export type {
  WebGpuApiProbes,
  WebGpuCapabilityRecord,
  WebGpuSpecializationRecord
} from "./gpu/WebGpuCapabilityRecord.js";
export type { TextureBindingSetPolicyRecord } from "./gpu/TextureBindingSetPolicy.js";
export {
  projectedGeometryErrorPixels,
  selectGeometryHierarchy
} from "./geometry/GeometryHierarchy.js";
export type {
  GeometryHierarchyProjection,
  GeometryHierarchySelection,
  GeometryHierarchySelectionOptions
} from "./geometry/GeometryHierarchy.js";
export { Camera } from "./camera/Camera.js";
export { DirectionalLight } from "./light/DirectionalLight.js";
export {
  FramePlan,
  createRendererFramePlan,
  type FramePlanDump,
  type FramePlanStageDefinition,
  type FramePlanStageDump,
  type FramePlanFrequency
} from "./render/pipeline/FramePlan.js";
export { Light } from "./light/Light.js";
export { Mesh } from "./scene/Mesh.js";
export { Node3D } from "./scene/Node3D.js";
export { OrbitalCameraController } from "./camera/OrbitalCameraController.js";
export { OrbitControls } from "./camera/OrbitControls.js";
export { PerspectiveCamera } from "./camera/PerspectiveCamera.js";
export { PointLight } from "./light/PointLight.js";
export { ProjectionMappingType } from "./loaders/ProjectionMappingType.js";
export {
  Renderer,
  type AmbientOcclusionRuntimeEvidence,
  type FinalOutputRuntimeEvidence,
  type RendererCapabilities,
  type ScreenSpaceGiRuntimeEvidence,
  type ScreenSpaceReflectionsRuntimeEvidence,
  type SharedColorPyramidRuntimeEvidence,
  type SharedDerivedProductsRuntimeEvidence,
  type TemporalRuntimeEvidence,
  type TextureResidencyEvidence
} from "./render/Renderer.js";
export type {
  OegPackSceneOptions,
  ProductSceneHandles,
  ProductSceneOptions,
  ProductSceneSourceMapper,
  ProductSceneState,
  WebCookedSceneOptions
} from "./render/pipeline/MainRenderPipeline.js";
export {
  DEFAULT_RENDERER_CONFIG,
  mergeRendererConfig,
  rendererConfigSettingsPatch,
  validateRendererConfig
} from "./render/RendererConfig.js";
export type { RendererConfig } from "./render/RendererConfig.js";
export type {
  RendererDebugConfig,
  ResolvedRendererDebugConfig
} from "./addons/debug/RendererDebugConfig.js";
export type { RendererDebugController } from "./addons/debug/RendererDebugController.js";
export type {
  RendererInfoAvailability,
  RendererInfoRow,
  RendererInfoSection,
  RendererInfoSectionId,
  RendererInfoSnapshot,
  RendererInfoValue
} from "./addons/debug/RendererInfoModel.js";
export { createRenderFrameContract } from "./render/RenderFrameContract.js";
export type { RenderFrameContract } from "./render/RenderFrameContract.js";
export {
  RENDER_FEATURE_CONTRACTS,
  RenderSettings,
  metersToWorldUnits,
  qualityProfilePatch
} from "./render/pipeline/RenderSettings.js";
export type {
  GtaoSettings,
  PhysicalScaleContract,
  PostSettings,
  QualityProfile,
  RenderFeatureContract,
  RenderFeatureSettings,
  RenderSettingsChange,
  RenderSettingsPatch,
  RenderSettingsValues,
  ResolutionSettings,
  ShadowSettings,
  SsgiSamplingDomain,
  SsgiSettings,
  SsrSettings,
  TemporalSettings
} from "./render/pipeline/RenderSettings.js";
export {
  directLightingFrame,
  lightClusterFrame,
  opaqueLightingFrame,
  requireDomain,
  textureDomain
} from "./render/pipeline/FrameProducts.js";
export type {
  AmbientOcclusionFrame,
  FinalTemporalSurfaceFrame,
  DirectLightingFrame,
  LightClusterFrame,
  OpaqueLightingFrame,
  OpaqueTemporalSurfaceFrame,
  ReflectionFrame,
  ScreenSpaceDiffuseMode,
  TemporalSurfaceFrame,
  TextureDomain
} from "./render/pipeline/FrameProducts.js";
export { STATIC_GRAPHICS_ENGINE_ASSETS } from "./render/STATIC_GRAPHICS_ENGINE_ASSETS.js";
export { Scene } from "./scene/Scene.js";
export type {
  SceneChangeSnapshot,
  SceneTransformChange
} from "./scene/SceneChangeSet.js";
export { ShadeAnimationChannel } from "./animation/ShadeAnimationChannel.js";
export { ShadeAnimationClip } from "./animation/ShadeAnimationClip.js";
export { ShadeGPUCommandContext } from "./framegraph/ShadeGPUCommandContext.js";
export { ShadeMaterial } from "./material/ShadeMaterial.js";
export {
  ShadeDrawMode,
  ShadeDrawSide,
  ShadeTransparencyMode
} from "./material/enums.js";
export { ShadeTexture } from "./texture/ShadeTexture.js";
export {
  ShadeDataType,
  ShadeImage
} from "./texture/ShadeTexture.js";
export type { ShadeDataTypeName } from "./texture/ShadeTexture.js";
export { ShadeTextureFlags } from "./texture/ShadeTextureFlags.js";
export { Skin } from "./animation/Skin.js";
export { SkinnedMesh } from "./scene/SkinnedMesh.js";
export { SpotLight } from "./light/SpotLight.js";
export { StandardShadeMaterial } from "./material/StandardShadeMaterial.js";
export { create_frame_loop } from "./render/create_frame_loop.js";
export { deserialize_scene } from "./loaders/deserialize_scene.js";
export { load_environment_avif } from "./loaders/load_environment_avif.js";
export { load_environment_map } from "./loaders/load_environment_map.js";
export { load_gltf, load_gltf_web_product } from "./loaders/load_gltf.js";
export type { LoadGltfOptions } from "./loaders/load_gltf.js";
export { load_scene_from_url } from "./loaders/load_scene_from_url.js";
export { openGlbRangeSource } from "./loaders/gltf/streaming/GlbRangeSource.js";
export type { GlbBufferDescriptor, GlbRangeReadableSource, GlbRangeSourceOptions, GlbSourceIdentity } from "./loaders/gltf/streaming/GlbRangeSource.js";
export { buildGlbSceneCatalog } from "./loaders/gltf/streaming/GlbSceneCatalog.js";
export type { GlbByteRange, GlbCookPrimitive, GlbSceneCatalog } from "./loaders/gltf/streaming/GlbSceneCatalog.js";
export { load_usd } from "./loaders/load_usd.js";
export {
  BENCHMARK_RESULT_SCHEMA_VERSION,
  captureGpuAdapterIdentity,
  captureWebGpuLimits,
  createEnvironmentManifest
} from "./debug/EnvironmentManifest.js";
export type {
  BenchmarkAdapterIdentity,
  BenchmarkBaselineRole,
  BenchmarkEngineIdentity,
  BenchmarkEnvironmentInput,
  BenchmarkEnvironmentManifest,
  BenchmarkFrameEnvironment,
  BenchmarkPlatformIdentity,
  BenchmarkPowerPreference,
  BenchmarkRunEnvironmentInput,
  BenchmarkWebGpuEnvironmentInput
} from "./debug/EnvironmentManifest.js";
export { FrameProfiler } from "./debug/FrameProfiler.js";
export {
  validateBenchmarkEvidence,
  validateIndependentBenchmarkRunGroup
} from "./debug/BenchmarkEvidenceGate.js";
export {
  BENCHMARK_CAPABILITY_EVIDENCE_SCHEMA_VERSION,
  BENCHMARK_FEATURE_SET_EVIDENCE,
  BENCHMARK_GPU_COUNTER_EVIDENCE,
  createBenchmarkCapabilityEvidence
} from "./debug/BenchmarkCapabilityEvidence.js";
export type {
  BenchmarkCapabilityEvidence,
  BenchmarkFeatureSetName,
  CapabilityEvidenceStatus,
  CounterEvidenceDeclaration,
  FeatureSetEvidenceDeclaration,
  SupportedCounterEvidence,
  SupportedFeatureSetEvidence,
  UnsupportedCounterEvidence,
  UnsupportedFeatureSetEvidence
} from "./debug/BenchmarkCapabilityEvidence.js";
export type {
  BenchmarkCapabilityBlocker,
  BenchmarkEvidenceIssue,
  BenchmarkEvidenceReport,
  BenchmarkEvidenceSeverity,
  BenchmarkRunIdentityEvidence,
  IndependentBenchmarkRunGroupReport
} from "./debug/BenchmarkEvidenceGate.js";
export {
  GPU_FRAME_PHASES,
  classifyGpuFramePhase
} from "./debug/GpuFramePhase.js";
export type { GpuFramePhase } from "./debug/GpuFramePhase.js";
export {
  RENDER_DEBUG_VIEW_OPTIONS,
  RenderDebugView,
  getRenderDebugViewStatus,
  isRenderableRenderDebugView
} from "./debug/RenderDebugView.js";
export type {
  RenderDebugViewStatus,
  RenderDebugView as RenderDebugViewName
} from "./debug/RenderDebugView.js";
export type {
  FrameCountEvidence,
  FrameGpuEvidence,
  FrameGpuCounterEvidence,
  FrameGpuPassType,
  FrameGpuSegment,
  FrameGpuTimingInput,
  FrameGraphEvidence,
  FrameProfileListener,
  FrameProfileSnapshot,
  FrameProfilerOptions,
  FrameProfilerMode,
  FrameProfilerDiagnostics,
  FrameReadbackEvidence,
  FrameUploadEvidence
} from "./debug/FrameProfiler.js";
export {
  MetricRegistry,
  DEFAULT_METRIC_DESCRIPTORS,
  summarizeProfileSeries
} from "./debug/profiling/MetricRegistry.js";
export { summarizeMetricCoverage } from "./debug/profiling/ProfileStatistics.js";
export type {
  ProfileCoverageSummary,
  ProfileSeriesSummary
} from "./debug/profiling/ProfileStatistics.js";
export type {
  MetricDescriptor,
  MetricSample,
  MetricSampleAvailability,
  MetricSource,
  MetricUnit,
  MetricMeasurement,
  MetricCost,
  MetricScope,
  MetricAggregation
} from "./debug/profiling/Metric.js";
export { ProfileHistory } from "./debug/profiling/ProfileHistory.js";
export type {
  ProfileFrame,
  ProfileFramePatch
} from "./debug/profiling/ProfileFrame.js";
export type { ProfileSpan, ProfileClockDomain } from "./debug/profiling/ProfileSpan.js";
export {
  ResourceAccounting,
  estimateBufferBytes,
  estimateTextureBytes
} from "./debug/profiling/ResourceAccounting.js";
export type {
  AccountedResourceCategory,
  AccountedResourceKind,
  ResourceCategorySnapshot,
  ResourceAccountedInput,
  ResourceAccountingSnapshot,
  ResourceHandle
} from "./debug/profiling/ResourceAccounting.js";
export {
  GPU_COUNTER_BYTE_SIZE,
  GPU_COUNTER_FIELDS,
  GPU_COUNTER_SCHEMA_VERSION,
  decodeGpuCounterValues
} from "./debug/GpuFrameCounters.js";
export type {
  GpuCounterFieldName,
  GpuCounterValues
} from "./debug/GpuFrameCounters.js";
export {
  BenchmarkHarness,
  serializeBenchmarkResult,
  summarizeSeries
} from "./debug/BenchmarkHarness.js";
export {
  compareBenchmarkResults
} from "./debug/BenchmarkComparison.js";
export type {
  BenchmarkCaseManifest,
  BenchmarkResult,
  BenchmarkSummary,
  SeriesSummary
} from "./debug/BenchmarkHarness.js";
export type {
  BenchmarkComparison,
  BenchmarkDeltaStatus,
  BenchmarkMetricDelta
} from "./debug/BenchmarkComparison.js";
export {
  SURFACE_TIMING_PHASES,
  classifySurfaceTimingPhase,
  surfaceTimingTotalsForFrame
} from "./debug/SurfacePhaseTiming.js";
export type {
  SurfaceTimingPhase,
  SurfaceTimingSegment
} from "./debug/SurfacePhaseTiming.js";
export { BenchmarkRunController } from "./debug/BenchmarkRunController.js";
export type {
  BenchmarkRunOptions,
  BenchmarkRunProgress,
  BenchmarkRunState
} from "./debug/BenchmarkRunController.js";
export {
  BENCHMARK_SCENE_MANIFEST_SCHEMA_VERSION,
  createBenchmarkCaseManifest,
  validateBenchmarkSceneManifest
} from "./debug/BenchmarkSceneManifest.js";
export type {
  BenchmarkAssetManifest,
  BenchmarkAssetRuntimeStatus,
  BenchmarkCameraKeyframe,
  BenchmarkSceneManifest
} from "./debug/BenchmarkSceneManifest.js";
