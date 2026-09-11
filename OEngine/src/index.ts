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
  MESHOPTIMIZER_COOKER_COMMIT,
  createGeometryCookRecipe,
  geometryCookRecipeKey
} from "./assets/GeometryCookRecipe.js";
export type {
  DegenerateTrianglePolicy,
  GeometryHierarchyMode,
  GeometryFloatMode,
  GeometryCookRecipe,
  GeometryCookRecipeInput,
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
export {
  GEOMETRY_ASSET_SCHEMA_VERSION,
  GEOMETRY_COOKER_VERSION,
  GEOMETRY_BVH8_NODE_STRIDE,
  GEOMETRY_CLUSTER_FLAGS,
  GEOMETRY_CLUSTER_RECORD_STRIDE,
  GEOMETRY_DIRECTORY_FLAGS,
  GEOMETRY_VISIBILITY_PATH_MASK,
  GEOMETRY_DIRECTORY_RECORD_STRIDE,
  GEOMETRY_INVALID_INDEX,
  GEOMETRY_MATERIAL_RANGE_STRIDE,
  GEOMETRY_MESHLET_RECORD_STRIDE,
  GEOMETRY_SECTION_TYPES,
  GEOMETRY_VERTEX_PROFILE,
  GEOMETRY_VERTEX_STREAM_FLAGS,
  GEOMETRY_VERTEX_STREAM_DESCRIPTOR_STRIDE,
  GeometryAssetPackageError,
  decodeGeometryColor,
  decodeGeometryNormal,
  decodeGeometryPosition,
  decodeGeometryTangent,
  decodeGeometryUv,
  geometryVisibilityPathFlag,
  geometryVisibilityPathFromFlags,
  openGeometryAssetPackage,
  recommendGeometryVisibilityPath
} from "./assets/GeometryAssetPackage.js";
export type {
  GeometryAssetPackage,
  GeometryAssetValidationReport,
  GeometryBvh8Node,
  GeometryClusterRecord,
  GeometryDirectoryRecord,
  GeometryMaterialRangeRecord,
  GeometryMeshletAlphaMode,
  GeometryMeshletRecord,
  GeometryVisibilityPath,
  GeometryVertexDataType,
  GeometryVertexStreamDescriptor
} from "./assets/GeometryAssetPackage.js";
export { cookGeometryAssetPackage } from "./geometry/GeometryCooker.js";
export type {
  GeometryCookEvidence,
  GeometryCookResult,
  GeometryCookTiming
} from "./geometry/GeometryCooker.js";
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
  AssetHandle,
  AssetResidencyEvidence
} from "./gpu/GpuAssetStore.js";
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
export {
  createInstanceSourceFromScene,
  createPackedSceneSourceFromScene
} from "./gpu/GpuSceneAdapter.js";
export type {
  AdaptedSceneSource,
  SceneGeometryAssetBinding,
  SceneInstanceAdapterOptions
} from "./gpu/GpuSceneAdapter.js";
export type {
  GpuRenderWorldEvidence,
  GpuRenderWorldHandle,
  PackedSceneMaterialPatch,
  PackedScenePatchBatch,
  PackedSceneSource
} from "./gpu/GpuRenderWorld.js";
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
export { DynamicResolutionScaling } from "./render/DynamicResolutionScaling.js";
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
  type RendererCapabilities,
  type ScreenSpaceGiRuntimeEvidence,
  type ScreenSpaceReflectionsRuntimeEvidence,
  type TemporalRuntimeEvidence
} from "./render/Renderer.js";
export {
  DEFAULT_RENDERER_CONFIG,
  mergeRendererConfig,
  rendererConfigSettingsPatch,
  validateRendererConfig
} from "./render/RendererConfig.js";
export type { RendererConfig } from "./render/RendererConfig.js";
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
export { load_gltf, load_gltf_packed } from "./loaders/load_gltf.js";
export type { PackedGltfSource } from "./loaders/load_gltf.js";
export { load_scene_from_url } from "./loaders/load_scene_from_url.js";
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
