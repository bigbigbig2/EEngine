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
  GeometryFloatMode,
  GeometryCookRecipe,
  GeometryCookRecipeInput,
  MissingAttributePolicy,
  NonManifoldPolicy
} from "./assets/GeometryCookRecipe.js";
export {
  RUNTIME_ASSET_FORMAT_VERSION,
  RUNTIME_ASSET_PACKAGE_SCHEMA_HASH,
  RuntimeAssetPackageError,
  openRuntimeAssetPackage,
  validateRuntimeAssetPackage,
  writeRuntimeAssetPackage
} from "./assets/RuntimeAssetPackage.js";
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
export { Camera } from "./camera/Camera.js";
export { DirectionalLight } from "./light/DirectionalLight.js";
export { DynamicResolutionScaling } from "./render/DynamicResolutionScaling.js";
export { Light } from "./light/Light.js";
export { Mesh } from "./scene/Mesh.js";
export { Node3D } from "./scene/Node3D.js";
export { OrbitalCameraController } from "./camera/OrbitalCameraController.js";
export { PerspectiveCamera } from "./camera/PerspectiveCamera.js";
export { PointLight } from "./light/PointLight.js";
export { ProjectionMappingType } from "./loaders/ProjectionMappingType.js";
export { Renderer } from "./render/Renderer.js";
export { STATIC_GRAPHICS_ENGINE_ASSETS } from "./render/STATIC_GRAPHICS_ENGINE_ASSETS.js";
export { Scene } from "./scene/Scene.js";
export type {
  SceneChangeSnapshot,
  SceneTransformChange
} from "./scene/SceneChangeSet.js";
export { ShadeAnimationChannel } from "./animation/ShadeAnimationChannel.js";
export { ShadeAnimationClip } from "./animation/ShadeAnimationClip.js";
export { ShadeGPUCommandContext } from "./framegraph/ShadeGPUCommandContext.js";
export { ShadeIndirectLightingMode } from "./render/ShadeIndirectLightingMode.js";
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
export { load_gltf } from "./loaders/load_gltf.js";
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
export { validateBenchmarkEvidence } from "./debug/BenchmarkEvidenceGate.js";
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
  BenchmarkEvidenceSeverity
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
  FrameProfilerDiagnostics,
  FrameReadbackEvidence,
  FrameUploadEvidence
} from "./debug/FrameProfiler.js";
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
export type {
  BenchmarkCaseManifest,
  BenchmarkResult,
  BenchmarkSummary,
  SeriesSummary
} from "./debug/BenchmarkHarness.js";
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
