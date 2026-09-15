import { GEOMETRY_VERTEX_DATA_TYPE_CODE } from "../assets/GeometryAssetPackage.js";
import {
  GPU_COMPUTE_MATERIAL_ABI_WGSL,
  GPU_SHADING_SURFACE_NORMAL_ENCODING,
  GPU_SHADING_SURFACE_LITE_WGSL
} from "../gpu/GpuComputeMaterialAbi.js";
import { GPU_NORMAL_FORMAT, GPU_POSITION_FORMAT, GPU_UV_FORMAT } from "../gpu/GpuGeometryAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_MATERIAL_VISIBILITY_FLAGS } from "../gpu/GpuMaterialVisibilityAbi.js";
import { GPU_SHADING_BIN_FRAME_FLAG, GPU_SHADING_BIN_WGSL } from "../gpu/GpuShadingBinAbi.js";
import { GPU_SHADING_FRAME_STATUS_WGSL } from "../gpu/GpuShadingFrameStatusAbi.js";
import { GPU_SHADING_MATERIAL_WGSL } from "../gpu/GpuShadingMaterialAbi.js";
import {
  GPU_SHADING_PROGRAM,
  GPU_SHADING_PROGRAM_COUNT,
  GPU_SHADING_PROGRAM_NAMES,
  shadingProgramUsesTextures
} from "../gpu/GpuShadingProgramAbi.js";
import { gpuShadingProgramSpecialization } from "../gpu/GpuShadingProgramOracle.js";
import {
  createGpuSparseShadingPipelineDescriptor,
  GPU_SHADING_OUTPUT_DEPENDENCY,
  GPU_SPARSE_SHADING_ENTRY_POINT,
  type GpuSparseShadingPipelineDescriptor
} from "../gpu/GpuSparseShadingPipelineContract.js";
import {
  gpuTextureBankSampleWgsl,
  GPU_TEXTURE_REF_INVALID,
} from "../gpu/GpuTextureRefAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { GPU_SPARSE_SHADING_VIEW_WGSL } from "../gpu/GpuSparseShadingFrameAbi.js";
import { createProductionSparseDirectLightingWgsl } from "./lighting_direct.js";
import { OENGINE_ENVIRONMENT_BRDF_WGSL } from "./environment_brdf.js";
import { OCTAHEDRAL_SAMPLE_WGSL } from "./environment_ibl.js";
import { SPECULAR_AMBIENT_OCCLUSION_WGSL } from "./specular_ambient_occlusion.js";

export const GPU_SPARSE_SHADING_DIAGNOSTIC_WORDS = 4;
export const GPU_SPARSE_SHADING_DIAGNOSTIC_FLAG = Object.freeze({
  Duplicate: 1 << 0,
  Unassigned: 1 << 1,
  IdentityMismatch: 1 << 2
} as const);

export interface SparseShadingShaderVariant {
  readonly descriptor: Readonly<GpuSparseShadingPipelineDescriptor>;
  readonly source: string;
  readonly diagnostics: boolean;
}

/** Diagnostics-only post-consumer scan; production never creates this module or its buffers. */
export const SPARSE_SHADING_DIAGNOSTICS_FINALIZER_WGSL = /* wgsl */ `
struct OEngineSparseDiagnosticsView {
  width: u32,
  height: u32,
  _pad: vec2u,
}
struct OEngineSparseShadingDiagnostics {
  flags: atomic<u32>,
  shaded: atomic<u32>,
  duplicate: atomic<u32>,
  unassigned: atomic<u32>,
}
@group(0) @binding(2) var diagnostics_bin_id: texture_2d<u32>;
@group(0) @binding(5) var<uniform> diagnostics_view: OEngineSparseDiagnosticsView;
@group(0) @binding(11) var<storage, read_write> shading_diagnostics: OEngineSparseShadingDiagnostics;
@group(0) @binding(12) var<storage, read_write> shading_claims: array<atomic<u32>>;

@compute @workgroup_size(8, 8, 1)
fn finalize_sparse_shading_diagnostics(@builtin(global_invocation_id) global_id: vec3u) {
  let pixel = global_id.xy;
  if any(pixel >= vec2u(diagnostics_view.width, diagnostics_view.height)) { return; }
  let bin_id = textureLoad(diagnostics_bin_id, vec2i(pixel), 0).x;
  if bin_id < 64u && atomicLoad(&shading_claims[pixel.y * diagnostics_view.width + pixel.x]) == 0u {
    atomicOr(&shading_diagnostics.flags, ${GPU_SPARSE_SHADING_DIAGNOSTIC_FLAG.Unassigned}u);
    atomicAdd(&shading_diagnostics.unassigned, 1u);
  }
}
`;

/** Creates one fully static program/output variant; no runtime material-class switch is emitted. */
export function createSparseShadingShaderVariant(
  descriptor: Readonly<GpuSparseShadingPipelineDescriptor>,
  diagnostics = false
): Readonly<SparseShadingShaderVariant> {
  const specialization = gpuShadingProgramSpecialization(
    descriptor.programId,
    descriptor.outputDependencyMask
  );
  if (descriptor.binId !== ((descriptor.textureBindingSetId << 4) | descriptor.programId)) {
    throw new Error("Sparse shading descriptor has inconsistent immutable identity");
  }
  const usesTextures = shadingProgramUsesTextures(descriptor.programId);
  const fastUnlit = isFastUnlitFactor(descriptor);
  const source = [
    "requires texture_formats_tier1;",
    descriptor.executionMode === "sparse-microtile" ? GPU_SHADING_BIN_WGSL : GPU_SHADING_FRAME_STATUS_WGSL,
    GPU_VISIBILITY_KEY_WGSL,
    GPU_MESHLET_RASTER_WORK_WGSL,
    fastUnlit ? narrowUnlitMaterialWgsl() : GPU_SHADING_MATERIAL_WGSL,
    frameTypesWgsl(descriptor, fastUnlit),
    frameBindingsWgsl(descriptor, diagnostics),
    identityWgsl(descriptor, diagnostics),
    specialization.reconstructTriangle ? geometryWgsl() : "",
    usesTextures ? textureWgsl(descriptor) : "",
    specialization.lit ? lightingWgsl(
      descriptor.shadowSamplingEnabled,
      (descriptor.outputDependencyMask & GPU_SHADING_OUTPUT_DEPENDENCY.EnvironmentIBL) !== 0
    ) : "",
    materialEvaluationWgsl(descriptor),
    outputWgsl(descriptor),
    consumerWgsl(descriptor, diagnostics)
  ].filter(Boolean).join("\n");
  return Object.freeze({ descriptor, source, diagnostics });
}

/** Enumerates the 16 creation-time program families for a publication/output snapshot. */
export function createSparseShadingProgramFamily(input: {
  readonly textureBindingSetId: number;
  readonly outputDependencyMask: number;
  readonly shadowSamplingEnabled: boolean;
  readonly capability: Parameters<typeof createGpuSparseShadingPipelineDescriptor>[0]["capability"];
  readonly textureBankMask?: number;
  readonly diagnostics?: boolean;
}): readonly Readonly<SparseShadingShaderVariant>[] {
  return Object.freeze(Array.from({ length: GPU_SHADING_PROGRAM_COUNT }, (_, programId) => {
    const textureBindingSetId = shadingProgramUsesTextures(programId)
      ? input.textureBindingSetId
      : 0;
    return createSparseShadingShaderVariant(createGpuSparseShadingPipelineDescriptor({
      programId,
      textureBindingSetId,
      outputDependencyMask: input.outputDependencyMask,
      shadowSamplingEnabled: input.shadowSamplingEnabled,
      textureBankMask: input.textureBankMask,
      capability: input.capability
    }), input.diagnostics ?? false);
  }));
}

function frameTypesWgsl(
  descriptor: Readonly<GpuSparseShadingPipelineDescriptor>,
  fastUnlit: boolean
): string {
  return /* wgsl */ `
const OENGINE_SHADING_BIN_ID: u32 = ${descriptor.binId}u;
const OENGINE_SHADING_PROGRAM_ID: u32 = ${descriptor.programId}u;
const OENGINE_TEXTURE_BINDING_SET_ID: u32 = ${descriptor.textureBindingSetId}u;
const OENGINE_IDENTITY_MISMATCH: u32 = ${GPU_SHADING_BIN_FRAME_FLAG.IdentityMismatch}u;

${GPU_SPARSE_SHADING_VIEW_WGSL}

${fastUnlit ? "" : `${GPU_SHADING_SURFACE_LITE_WGSL}
struct OEngineSparseSurface {
  base_color: vec3f,
  alpha: f32,
  shading_normal: vec3f,
  roughness: f32,
  geometric_normal: vec3f,
  metallic: f32,
  emissive: vec3f,
  material_ao: f32,
  position_ws: vec3f,
  velocity: vec2f,
  view_depth: f32,
  flags: u32,
}`}
`;
}

function narrowUnlitMaterialWgsl(): string {
  return /* wgsl */ `
struct OEngineSparseUnlitFactorRecord {
  program_id: u32,
  texture_binding_set_id: u32,
  material_generation: u32,
  texture_generation: u32,
  publication_revision: u32,
  flags: u32,
  _header_pad: vec2u,
  _factor_prefix: array<vec4u, 4>,
  base_color_factor: vec4f,
  _factor_suffix: array<vec4u, 10>,
}
`;
}

function frameBindingsWgsl(
  descriptor: Readonly<GpuSparseShadingPipelineDescriptor>,
  diagnostics: boolean
): string {
  const sparseDiagnostics = diagnostics && descriptor.executionMode === "sparse-microtile";
  const names = new Set(descriptor.groups.flatMap((group) => group.bindings.map((binding) => binding.name)));
  const lines = [
    ...(names.has("shading_bin_settings")
      ? ["@group(0) @binding(0) var<uniform> shading_bin_settings: OEngineShadingBinSettings;"] : []),
    ...(names.has("shading_bin_heap")
      ? ["@group(0) @binding(1) var<storage, read_write> shading_bin_heap: OEngineShadingBinHeap;"] : []),
    ...(names.has("shading_frame_status")
      ? ["@group(0) @binding(1) var<storage, read_write> shading_frame_status: OEngineShadingFrameStatus;"] : []),
    ...(names.has("shading_bin_id")
      ? ["@group(0) @binding(2) var shading_bin_id: texture_2d<u32>;"] : []),
    ...(names.has("visibility_key")
      ? ["@group(0) @binding(3) var visibility_key: texture_2d<u32>;"] : []),
    ...(names.has("visibility_depth") ? ["@group(0) @binding(4) var visibility_depth: texture_depth_2d;"] : []),
    "@group(0) @binding(5) var<uniform> shading_view: OEngineSparseShadingView;",
    "@group(0) @binding(6) var output_hdr: texture_storage_2d<rgba16float, write>;",
    ...(names.has("output_normal") ? ["@group(0) @binding(7) var output_normal: texture_storage_2d<rgba16uint, write>;"] : []),
    ...(names.has("output_albedo_ao") ? ["@group(0) @binding(8) var output_albedo_ao: texture_storage_2d<rgba8unorm, write>;"] : []),
    ...(names.has("output_material") ? ["@group(0) @binding(9) var output_material: texture_storage_2d<rg32uint, write>;"] : []),
    ...(names.has("output_velocity") ? ["@group(0) @binding(10) var output_velocity: texture_storage_2d<rg16float, write>;"] : []),
    "@group(1) @binding(0) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;",
    ...(names.has("instance_records") ? ["@group(1) @binding(1) var<storage, read> instance_records: array<OEngineInstanceRecord>;"] : []),
    ...(names.has("asset_metadata_heap") ? ["@group(1) @binding(2) var<storage, read> asset_metadata_heap: array<u32>;"] : []),
    ...(names.has("vertex_payload_heap") ? ["@group(1) @binding(3) var<storage, read> vertex_payload_heap: array<u32>;"] : []),
    `@group(2) @binding(0) var<storage, read> material_records: array<${isFastUnlitFactor(descriptor) ? "OEngineSparseUnlitFactorRecord" : "OEngineShadingMaterialRecord"}>;`,
    ...(names.has("texture_descriptor_routing_heap") ? ["@group(2) @binding(1) var<storage, read> texture_descriptor_routing_heap: array<OEngineShadingTextureRoute>;"] : []),
    ...Array.from({ length: 9 }, (_, index) => names.has(`material_texture_${index}`)
      ? `@group(2) @binding(${2 + index}) var oengine_texture_bank_${index}: texture_2d_array<f32>;`
      : "").filter(Boolean),
    ...["repeat_linear", "clamp_linear", "mirror_linear", "repeat_nearest", "clamp_nearest", "mirror_nearest"]
      .map((name, index) => names.has(`material_sampler_${index}`)
        ? `@group(2) @binding(${11 + index}) var sampler_${name}: sampler;`
        : "").filter(Boolean),
    ...(names.has("light_database") ? [
      "@group(3) @binding(0) var<storage, read> node: array<u32>;",
      "@group(3) @binding(1) var<storage, read> cluster_lookup: array<ClusterMetadata>;",
      "@group(3) @binding(2) var<storage, read> cluster_data: ClusterData;",
      "@group(3) @binding(3) var<uniform> cluster_parameters: vec3f;",
      ...(names.has("environment_diffuse")
        ? ["@group(3) @binding(4) var environment_diffuse: texture_2d<f32>;"] : []),
      ...(names.has("environment_specular")
        ? ["@group(3) @binding(5) var environment_specular: texture_2d<f32>;"] : []),
      ...(names.has("split_sum")
        ? ["@group(3) @binding(6) var split_sum: texture_2d<f32>;"] : []),
      ...(names.has("environment_sampler")
        ? ["@group(3) @binding(7) var environment_sampler: sampler;"] : []),
      ...(names.has("shadow_atlas")
        ? [`@group(3) @binding(${names.has("environment_diffuse") ? 8 : 4}) var pass_descriptor: texture_depth_2d;`] : []),
      ...(names.has("shadow_sampler")
        ? [`@group(3) @binding(${names.has("environment_diffuse") ? 9 : 5}) var u_int: sampler_comparison;`] : [])
    ] : []),
    ...(sparseDiagnostics ? [
      "struct OEngineSparseShadingDiagnostics { flags: atomic<u32>, shaded: atomic<u32>, duplicate: atomic<u32>, unassigned: atomic<u32>, }",
      "@group(0) @binding(11) var<storage, read_write> shading_diagnostics: OEngineSparseShadingDiagnostics;",
      "@group(0) @binding(12) var<storage, read_write> shading_claims: array<atomic<u32>>;"
    ] : [])
  ];
  return lines.join("\n");
}

function identityWgsl(descriptor: Readonly<GpuSparseShadingPipelineDescriptor>, diagnostics: boolean): string {
  const materialType = isFastUnlitFactor(descriptor)
    ? "OEngineSparseUnlitFactorRecord"
    : "OEngineShadingMaterialRecord";
  const textureRoute = shadingProgramUsesTextures(descriptor.programId) ? /* wgsl */ `
fn sparse_texture_route_valid(material_slot: u32, slot: u32, texture_ref: u32) -> bool {
  let route = texture_descriptor_routing_heap[material_slot * 4u + slot];
  return route.texture_ref == texture_ref &&
    route.texture_generation == shading_view.texture_generation &&
    route.publication_revision == shading_view.publication_revision &&
    route.texture_binding_set_id == ${descriptor.textureBindingSetId}u;
}
` : "";
  const status = descriptor.executionMode === "sparse-microtile"
    ? "shading_bin_heap.control"
    : "shading_frame_status";
  const sparseDiagnostics = diagnostics && descriptor.executionMode === "sparse-microtile";
  return /* wgsl */ `
fn sparse_identity_error() {
  atomicOr(&${status}.frame_flags, OENGINE_IDENTITY_MISMATCH);
  atomicAdd(&${status}.error_count, 1u);
  ${sparseDiagnostics ? `atomicOr(&shading_diagnostics.flags, ${GPU_SPARSE_SHADING_DIAGNOSTIC_FLAG.IdentityMismatch}u);` : ""}
}

fn sparse_material_identity_valid(record: ${materialType}) -> bool {
  return record.program_id == ${descriptor.programId}u &&
    record.texture_binding_set_id == ${descriptor.textureBindingSetId}u &&
    record.material_generation == shading_view.material_generation &&
    record.texture_generation == shading_view.texture_generation &&
    record.publication_revision == shading_view.publication_revision;
}
${textureRoute}`;
}

function geometryWgsl(): string {
  return /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
const SPARSE_GEOMETRY_WORDS: u32 = 60u;
const SPARSE_MESHLET_WORDS: u32 = 28u;

fn sparse_meta_u32(base: u32, field: u32) -> u32 { return asset_metadata_heap[base + field]; }
fn sparse_meta_f32(base: u32, field: u32) -> f32 { return bitcast<f32>(sparse_meta_u32(base, field)); }
fn sparse_payload_u8(byte_offset: u32) -> u32 {
  let absolute = shading_view.vertex_data_word_base * 4u + byte_offset;
  let word = vertex_payload_heap[absolute >> 2u];
  return (word >> ((absolute & 3u) * 8u)) & 0xffu;
}
fn sparse_payload_u16(byte_offset: u32) -> u32 {
  return sparse_payload_u8(byte_offset) | (sparse_payload_u8(byte_offset + 1u) << 8u);
}
fn sparse_triangle_u8(byte_offset: u32) -> u32 {
  let absolute = shading_view.meshlet_triangle_word_base * 4u + byte_offset;
  let word = vertex_payload_heap[absolute >> 2u];
  return (word >> ((absolute & 3u) * 8u)) & 0xffu;
}
fn sparse_geometry_base(index: u32) -> u32 {
  return shading_view.geometry_word_base + index * SPARSE_GEOMETRY_WORDS;
}
fn sparse_meshlet_base(index: u32) -> u32 {
  return shading_view.meshlet_word_base + index * SPARSE_MESHLET_WORDS;
}
fn sparse_meshlet_vertices(meshlet_base: u32, primitive: u32) -> vec3u {
  let vertex_offset = sparse_meta_u32(meshlet_base, 0u);
  let byte_offset = sparse_meta_u32(meshlet_base, 2u) + primitive * 3u;
  let local = vec3u(sparse_triangle_u8(byte_offset), sparse_triangle_u8(byte_offset + 1u), sparse_triangle_u8(byte_offset + 2u));
  return vec3u(
    vertex_payload_heap[shading_view.meshlet_vertex_word_base + vertex_offset + local.x],
    vertex_payload_heap[shading_view.meshlet_vertex_word_base + vertex_offset + local.y],
    vertex_payload_heap[shading_view.meshlet_vertex_word_base + vertex_offset + local.z]
  );
}
fn sparse_position(geometry_base: u32, vertex: u32) -> vec3f {
  let byte_offset = sparse_meta_u32(geometry_base, 29u) + vertex * sparse_meta_u32(geometry_base, 30u);
  let format = sparse_meta_u32(geometry_base, 31u);
  let absolute_word = shading_view.vertex_data_word_base + (byte_offset >> 2u);
  if format == ${GPU_POSITION_FORMAT.Float32x3}u || format == ${GPU_POSITION_FORMAT.Float32x4}u {
    return vec3f(bitcast<f32>(vertex_payload_heap[absolute_word]), bitcast<f32>(vertex_payload_heap[absolute_word + 1u]), bitcast<f32>(vertex_payload_heap[absolute_word + 2u]));
  }
  if format == ${GPU_POSITION_FORMAT.AabbUnorm16x3}u {
    let q = vec3f(f32(sparse_payload_u16(byte_offset)), f32(sparse_payload_u16(byte_offset + 2u)), f32(sparse_payload_u16(byte_offset + 4u))) / 65535.0;
    let minimum = vec3f(sparse_meta_f32(geometry_base, 4u), sparse_meta_f32(geometry_base, 5u), sparse_meta_f32(geometry_base, 6u));
    let maximum = vec3f(sparse_meta_f32(geometry_base, 8u), sparse_meta_f32(geometry_base, 9u), sparse_meta_f32(geometry_base, 10u));
    return mix(minimum, maximum, q);
  }
  return vec3f(0.0);
}
fn sparse_uv0(geometry_base: u32, vertex: u32) -> vec2f {
  let byte_offset = sparse_meta_u32(geometry_base, 33u) + vertex * sparse_meta_u32(geometry_base, 34u);
  let format = sparse_meta_u32(geometry_base, 35u);
  let word = shading_view.vertex_data_word_base + (byte_offset >> 2u);
  if format == ${GPU_UV_FORMAT.Float32x2}u { return vec2f(bitcast<f32>(vertex_payload_heap[word]), bitcast<f32>(vertex_payload_heap[word + 1u])); }
  if format == ${GPU_UV_FORMAT.Unorm8x2}u { return vec2f(f32(sparse_payload_u8(byte_offset)), f32(sparse_payload_u8(byte_offset + 1u))) / 255.0; }
  if format == ${GPU_UV_FORMAT.Unorm16x2}u { return vec2f(f32(sparse_payload_u16(byte_offset)), f32(sparse_payload_u16(byte_offset + 2u))) / 65535.0; }
  if format == ${GPU_UV_FORMAT.Float16x2}u { return unpack2x16float(vertex_payload_heap[word]); }
  return vec2f(0.0);
}
fn sparse_component(byte_offset: u32, format: u32, normalized: bool) -> f32 {
  if format == ${GEOMETRY_VERTEX_DATA_TYPE_CODE.uint8}u { let v = sparse_payload_u8(byte_offset); return select(f32(v), f32(v) / 255.0, normalized); }
  if format == ${GEOMETRY_VERTEX_DATA_TYPE_CODE.uint16}u { let v = sparse_payload_u16(byte_offset); return select(f32(v), f32(v) / 65535.0, normalized); }
  return bitcast<f32>(vertex_payload_heap[shading_view.vertex_data_word_base + (byte_offset >> 2u)]);
}
fn sparse_stream(geometry_base: u32, offset_field: u32, vertex: u32, fallback: vec4f) -> vec4f {
  let byte_offset = sparse_meta_u32(geometry_base, offset_field) + vertex * sparse_meta_u32(geometry_base, offset_field + 1u);
  let format = sparse_meta_u32(geometry_base, offset_field + 2u);
  let normalized = sparse_meta_u32(geometry_base, offset_field + 3u) != 0u;
  if format == 0u { return fallback; }
  let bytes = select(4u, select(2u, 1u, format <= 2u), format <= 4u);
  return vec4f(sparse_component(byte_offset, format, normalized), sparse_component(byte_offset + bytes, format, normalized), sparse_component(byte_offset + bytes * 2u, format, normalized), sparse_component(byte_offset + bytes * 3u, format, normalized));
}
fn sparse_normal(geometry_base: u32, vertex: u32) -> vec3f {
  let byte_offset = sparse_meta_u32(geometry_base, 45u) + vertex * sparse_meta_u32(geometry_base, 46u);
  if sparse_meta_u32(geometry_base, 47u) == ${GPU_NORMAL_FORMAT.OctSnorm16x2}u {
    let encoded = unpack2x16snorm(vertex_payload_heap[shading_view.vertex_data_word_base + (byte_offset >> 2u)]);
    var n = vec3f(encoded, 1.0 - abs(encoded.x) - abs(encoded.y));
    if n.z < 0.0 { n = vec3f((1.0 - abs(n.y)) * select(-1.0, 1.0, n.x >= 0.0), (1.0 - abs(n.x)) * select(-1.0, 1.0, n.y >= 0.0), n.z); }
    return normalize(n);
  }
  return normalize(sparse_stream(geometry_base, 45u, vertex, vec4f(0.0, 0.0, 1.0, 0.0)).xyz);
}
fn sparse_tangent(geometry_base: u32, vertex: u32) -> vec4f { return sparse_stream(geometry_base, 49u, vertex, vec4f(1.0, 0.0, 0.0, 1.0)); }
fn sparse_color(geometry_base: u32, vertex: u32) -> vec3f { return sparse_stream(geometry_base, 53u, vertex, vec4f(1.0)).xyz; }

struct SparseBarycentric { weights: vec3f, ddx: vec3f, ddy: vec3f, valid: bool, }
fn sparse_projected_pixel(value: vec4f) -> vec2f {
  let ndc = value.xy / value.w;
  return vec2f(
    (ndc.x * 0.5 + 0.5) * f32(shading_view.width),
    (0.5 - ndc.y * 0.5) * f32(shading_view.height)
  );
}
fn sparse_barycentric(pixel: vec2f, c0: vec4f, c1: vec4f, c2: vec4f) -> SparseBarycentric {
  var result = SparseBarycentric(vec3f(1.0, 0.0, 0.0), vec3f(0.0), vec3f(0.0), false);
  let p0 = sparse_projected_pixel(c0); let p1 = sparse_projected_pixel(c1); let p2 = sparse_projected_pixel(c2);
  let d = (p1.y-p2.y)*(p0.x-p2.x)+(p2.x-p1.x)*(p0.y-p2.y);
  if abs(d) < 1e-8 { return result; }
  let l0=((p1.y-p2.y)*(pixel.x-p2.x)+(p2.x-p1.x)*(pixel.y-p2.y))/d;
  let l1=((p2.y-p0.y)*(pixel.x-p2.x)+(p0.x-p2.x)*(pixel.y-p2.y))/d;
  let s=vec3f(l0,l1,1.0-l0-l1); let sx=vec3f(p1.y-p2.y,p2.y-p0.y,p0.y-p1.y)/d; let sy=vec3f(p2.x-p1.x,p0.x-p2.x,p1.x-p0.x)/d;
  let rw=1.0/vec3f(c0.w,c1.w,c2.w); let w=s*rw; let wx=sx*rw; let wy=sy*rw; let sum=dot(w,vec3f(1.0));
  if abs(sum) < 1e-8 { return result; }
  let ix=dot(wx,vec3f(1.0)); let iy=dot(wy,vec3f(1.0)); let inverse=1.0/sum;
  result.weights=w*inverse; result.ddx=(wx*sum-w*ix)*inverse*inverse; result.ddy=(wy*sum-w*iy)*inverse*inverse; result.valid=true; return result;
}
fn sparse_affine(instance: OEngineInstanceRecord) -> mat4x4f { return oengine_instance_current_object_to_world(instance); }
`;
}

function textureWgsl(descriptor: Readonly<GpuSparseShadingPipelineDescriptor>): string {
  const specialization = gpuShadingProgramSpecialization(
    descriptor.programId,
    descriptor.outputDependencyMask
  );
  const slots = [
    specialization.baseTexture !== "never" ? 0 : -1,
    specialization.normalTexture !== "never" ? 1 : -1,
    specialization.ormTexture !== "never" ? 2 : -1,
    specialization.emissiveTexture !== "never" ? 3 : -1
  ].filter((slot) => slot >= 0);
  return /* wgsl */ `
${gpuTextureBankSampleWgsl(descriptor.textureBankMask)}
fn sparse_sample(texture_ref: u32, sampler_class: u32, uv: vec2f, dx: vec2f, dy: vec2f, valid: bool, fallback: vec4f) -> vec4f {
  if valid { return oengine_sample_texture_bank(texture_ref, sampler_class, uv, dx, dy, fallback); }
  return oengine_sample_texture_bank_level_zero(texture_ref, sampler_class, uv, fallback);
}
${slots.map((slot) => textureSlotAccessWgsl(slot)).join("\n")}
`;
}

function textureSlotAccessWgsl(slot: number): string {
  const fields = [
    ["uv_offset_scale", "uv_rotation", "material.payload.sampler_class"],
    ["normal_uv_offset_scale", "normal_uv_rotation", "material.payload.texture_sampler_classes&255u"],
    ["orm_uv_offset_scale", "orm_uv_rotation", "(material.payload.texture_sampler_classes>>8u)&255u"],
    ["emissive_uv_offset_scale", "emissive_uv_rotation", "(material.payload.texture_sampler_classes>>16u)&255u"]
  ][slot];
  if (fields === undefined) throw new RangeError(`Unsupported material texture slot ${slot}`);
  return /* wgsl */ `
fn sparse_transform_uv_${slot}(material: OEngineShadingMaterialRecord, uv: vec2f, derivative: bool) -> vec2f {
  let os=material.payload.${fields[0]}; let rotation=material.payload.${fields[1]};
  let value=uv*os.zw; return select(os.xy,vec2f(0.0),derivative)+vec2f(rotation.x*value.x-rotation.y*value.y,rotation.y*value.x+rotation.x*value.y);
}
fn sparse_sampler_${slot}(material: OEngineShadingMaterialRecord) -> u32 { return ${fields[2]}; }`;
}

function lightingWgsl(
  shadowSamplingEnabled: boolean,
  environmentIblEnabled: boolean
): string {
  return /* wgsl */ `
${createProductionSparseDirectLightingWgsl(shadowSamplingEnabled)}
${environmentIblEnabled ? `${OCTAHEDRAL_SAMPLE_WGSL}
${OENGINE_ENVIRONMENT_BRDF_WGSL}
${SPECULAR_AMBIENT_OCCLUSION_WGSL}` : ""}
fn sparse_direct(surface:OEngineSparseSurface,pixel:vec2u)->vec3f{
  if (oengine_surface_has_flag(surface.flags, OENGINE_SURFACE_FLAG_UNLIT)) {
    return surface.emissive;
  }
  var material: StandardMaterial;
  material.diffuse = surface.base_color * (1.0 - surface.metallic);
  material.occlusion = surface.material_ao;
  material.roughness = max(surface.roughness, 0.02);
  material.specularF0 = metalness_to_specular_color(surface.metallic, surface.base_color);
  material.specularF90 = 1.0;
  material.emissive = surface.emissive;
  material.opacity = surface.alpha;
  let geometry = SurfaceGeometry(
    surface.shading_normal,
    surface.geometric_normal,
    surface.position_ws,
    normalize(shading_view.camera_position.xyz - surface.position_ws)
  );
  random_initialize(
    vec3u(pixel, shading_view.frame_index),
    vec3u(0xEE6B2807u, 7u, 0xD0974829u)
  );
  let direct = shade_standard_material_direct(
    material,
    geometry,
    vec2f(pixel) + vec2f(0.5),
    surface.view_depth
  );
  ${environmentIblEnabled ? `
  let no_v = clamp(dot(surface.shading_normal, geometry.view_direction), 0.0, 1.0);
  let dfg = textureSampleLevel(
    split_sum,
    environment_sampler,
    vec2f(no_v, material.roughness),
    0.0
  ).rg;
  let specular_direction = normalize(mix(
    reflect(-geometry.view_direction, surface.shading_normal),
    surface.shading_normal,
    material.roughness * material.roughness
  ));
  let radiance = sample_prefiltered_environment(
    environment_specular,
    specular_direction,
    material.roughness
  );
  let irradiance = sample_prefiltered_environment(
    environment_diffuse,
    surface.shading_normal,
    0.0
  );
  let directional_albedo = oengine_ibl_directional_albedo(
    dfg,
    material.specularF0,
    material.specularF90
  );
  let energy = oengine_ibl_diffuse_energy(directional_albedo);
  let specular_ao = oengine_specular_ao_cones(
    specular_direction,
    surface.shading_normal,
    material.occlusion,
    material.roughness
  );
  let environment_specular_contribution = radiance * directional_albedo * specular_ao;
  let environment_diffuse_contribution = irradiance * material.diffuse *
    energy * ${1 / Math.PI} * material.occlusion;
  return direct + environment_specular_contribution + environment_diffuse_contribution;` : `
  return direct;`}
}
`;
}

function materialEvaluationWgsl(descriptor: Readonly<GpuSparseShadingPipelineDescriptor>): string {
  const s = gpuShadingProgramSpecialization(descriptor.programId, descriptor.outputDependencyMask);
  const writesVelocity = s.publishesVelocity;
  const velocityCode = writesVelocity
    ? "let previous_position=oengine_instance_previous_from_current(instance)*vec4f(position,1.0);let previous_clip=shading_view.previous_view_projection*previous_position;let current_clip=shading_view.current_view_projection*vec4f(position,1.0);let velocity=(current_clip.xy/current_clip.w-previous_clip.xy/previous_clip.w)*vec2f(0.5,-0.5);"
    : "let velocity=vec2f(0.0);";
  const motionFlagCode = writesVelocity
    ? "if oengine_instance_motion_valid(instance){surface_flags|=OENGINE_SURFACE_FLAG_MOTION_VALID;}"
    : "";
  const needsBase = s.baseTexture !== "never";
  const needsOrm = s.ormTexture !== "never";
  const needsNormal = s.normalTexture !== "never";
  const needsEmissive = s.emissiveTexture !== "never";
  const generic = descriptor.programId === GPU_SHADING_PROGRAM.PbrGeneric;
  const sample = (slot: number, ref: string, fallback: string, condition: string) => `
  if ${condition} {
    if !sparse_texture_route_valid(material_slot, ${slot}u, ${ref}) { sparse_identity_error(); return OEngineSparseSurface(vec3f(0.0),0.0,vec3f(0.0),1.0,vec3f(0.0),0.0,vec3f(0.0),1.0,vec3f(0.0),vec2f(0.0),0.0,0u); }
    let sampled_${slot}=sparse_sample(${ref},sparse_sampler_${slot}(material),sparse_transform_uv_${slot}(material,uv,false),sparse_transform_uv_${slot}(material,uv_dx,true),sparse_transform_uv_${slot}(material,uv_dy,true),gradient_valid,${fallback});
    sample_${slot}=sampled_${slot};
  }`;
  if (!s.reconstructTriangle) {
    if (isFastUnlitFactor(descriptor)) return /* wgsl */ `
fn sparse_evaluate_unlit_factor(material:OEngineSparseUnlitFactorRecord)->vec4f{
  return material.base_color_factor;
}`;
    return /* wgsl */ `
fn sparse_evaluate(material_slot:u32,material:OEngineShadingMaterialRecord)->OEngineSparseSurface{
  let factor=material.payload.base_color_factor;
  return OEngineSparseSurface(factor.xyz,factor.w,vec3f(0.0,0.0,1.0),material.payload.pbr_factors.y,vec3f(0.0,0.0,1.0),material.payload.pbr_factors.x,vec3f(0.0),1.0,vec3f(0.0),vec2f(0.0),0.0,OENGINE_SURFACE_FLAG_VALID|OENGINE_SURFACE_FLAG_UNLIT);
}`;
  }
  if (!s.lit) {
    const usesBase = descriptor.programId === GPU_SHADING_PROGRAM.UnlitTexture ||
      descriptor.programId === GPU_SHADING_PROGRAM.UnlitTextureColor;
    const usesColor = descriptor.programId === GPU_SHADING_PROGRAM.UnlitFactorColor ||
      descriptor.programId === GPU_SHADING_PROGRAM.UnlitTextureColor;
    return /* wgsl */ `
fn sparse_evaluate_geometry(pixel:vec2u,work:OEngineMeshletRasterWork,primitive:u32,material_slot:u32,material:OEngineShadingMaterialRecord)->OEngineSparseSurface{
  let instance=instance_records[work.instance_slot];let geometry_base=sparse_geometry_base(work.geometry_slot);let meshlet_base=sparse_meshlet_base(work.meshlet_slot);let vertices=sparse_meshlet_vertices(meshlet_base,primitive);let model=sparse_affine(instance);
  let p0=model*vec4f(sparse_position(geometry_base,vertices.x),1.0);let p1=model*vec4f(sparse_position(geometry_base,vertices.y),1.0);let p2=model*vec4f(sparse_position(geometry_base,vertices.z),1.0);let c0=shading_view.current_view_projection*p0;let c1=shading_view.current_view_projection*p1;let c2=shading_view.current_view_projection*p2;let bary=sparse_barycentric(vec2f(pixel)+vec2f(0.5),c0,c1,c2);let position=p0.xyz*bary.weights.x+p1.xyz*bary.weights.y+p2.xyz*bary.weights.z;
  var color=vec3f(1.0);${usesColor ? "color=sparse_color(geometry_base,vertices.x)*bary.weights.x+sparse_color(geometry_base,vertices.y)*bary.weights.y+sparse_color(geometry_base,vertices.z)*bary.weights.z;" : ""}
  var base_sample=vec4f(1.0);${usesBase ? `let u0=sparse_uv0(geometry_base,vertices.x);let u1=sparse_uv0(geometry_base,vertices.y);let u2=sparse_uv0(geometry_base,vertices.z);let uv=u0*bary.weights.x+u1*bary.weights.y+u2*bary.weights.z;let uv_dx=(u0*bary.ddx.x+u1*bary.ddx.y+u2*bary.ddx.z)/shading_view.upscale_ratio.x;let uv_dy=(u0*bary.ddy.x+u1*bary.ddy.y+u2*bary.ddy.z)/shading_view.upscale_ratio.y;if !sparse_texture_route_valid(material_slot,0u,material.payload.texture_ref){sparse_identity_error();return OEngineSparseSurface(vec3f(0.0),0.0,vec3f(0.0),1.0,vec3f(0.0),0.0,vec3f(0.0),1.0,vec3f(0.0),vec2f(0.0),0.0,0u);}base_sample=sparse_sample(material.payload.texture_ref,sparse_sampler_0(material),sparse_transform_uv_0(material,uv,false),sparse_transform_uv_0(material,uv_dx,true),sparse_transform_uv_0(material,uv_dy,true),bary.valid,vec4f(1.0));` : ""}
  ${velocityCode}let factor=material.payload.base_color_factor;
  var surface_flags=OENGINE_SURFACE_FLAG_VALID|OENGINE_SURFACE_FLAG_UNLIT;${motionFlagCode}${usesBase ? "if !bary.valid{surface_flags|=OENGINE_SURFACE_FLAG_GRADIENT_FALLBACK;}" : ""}
  return OEngineSparseSurface(factor.xyz*color*base_sample.xyz,factor.w*base_sample.a,vec3f(0.0,0.0,1.0),material.payload.pbr_factors.y,vec3f(0.0,0.0,1.0),material.payload.pbr_factors.x,vec3f(0.0),1.0,position,velocity,textureLoad(visibility_depth,vec2i(pixel),0),surface_flags);
}`;
  }
  return /* wgsl */ `
fn sparse_evaluate_geometry(pixel:vec2u,work:OEngineMeshletRasterWork,primitive:u32,material_slot:u32,material:OEngineShadingMaterialRecord)->OEngineSparseSurface{
  let instance=instance_records[work.instance_slot];let geometry_base=sparse_geometry_base(work.geometry_slot);let meshlet_base=sparse_meshlet_base(work.meshlet_slot);let vertices=sparse_meshlet_vertices(meshlet_base,primitive);let model=sparse_affine(instance);
  let p0=model*vec4f(sparse_position(geometry_base,vertices.x),1.0);let p1=model*vec4f(sparse_position(geometry_base,vertices.y),1.0);let p2=model*vec4f(sparse_position(geometry_base,vertices.z),1.0);let c0=shading_view.current_view_projection*p0;let c1=shading_view.current_view_projection*p1;let c2=shading_view.current_view_projection*p2;let bary=sparse_barycentric(vec2f(pixel)+vec2f(0.5),c0,c1,c2);
  let position=p0.xyz*bary.weights.x+p1.xyz*bary.weights.y+p2.xyz*bary.weights.z;let local_normal=normalize(sparse_normal(geometry_base,vertices.x)*bary.weights.x+sparse_normal(geometry_base,vertices.y)*bary.weights.y+sparse_normal(geometry_base,vertices.z)*bary.weights.z);var normal=normalize(mat3x3f(model[0].xyz,model[1].xyz,model[2].xyz)*local_normal);let geometric=normalize(cross(p1.xyz-p0.xyz,p2.xyz-p0.xyz));
  var color=vec3f(1.0);${s.authoredVertexColor !== "never" ? "if sparse_meta_u32(geometry_base,44u)!=0u { color=sparse_color(geometry_base,vertices.x)*bary.weights.x+sparse_color(geometry_base,vertices.y)*bary.weights.y+sparse_color(geometry_base,vertices.z)*bary.weights.z; }" : ""}
  var uv=vec2f(0.0);var uv_dx=vec2f(0.0);var uv_dy=vec2f(0.0);let gradient_valid=bary.valid;
  ${shadingProgramUsesTextures(descriptor.programId) ? "let u0=sparse_uv0(geometry_base,vertices.x);let u1=sparse_uv0(geometry_base,vertices.y);let u2=sparse_uv0(geometry_base,vertices.z);uv=u0*bary.weights.x+u1*bary.weights.y+u2*bary.weights.z;uv_dx=(u0*bary.ddx.x+u1*bary.ddx.y+u2*bary.ddx.z)/shading_view.upscale_ratio.x;uv_dy=(u0*bary.ddy.x+u1*bary.ddy.y+u2*bary.ddy.z)/shading_view.upscale_ratio.y;" : ""}
  var sample_0=vec4f(1.0);var sample_1=vec4f(0.5,0.5,1.0,1.0);var sample_2=vec4f(1.0);var sample_3=vec4f(1.0);
  ${needsBase ? sample(0, "material.payload.texture_ref", "vec4f(1.0)", generic ? `(material.payload.texture_ref!=${GPU_TEXTURE_REF_INVALID}u)` : "true") : ""}
  ${needsNormal ? sample(1, "material.payload.normal_texture_ref", "vec4f(0.5,0.5,1.0,1.0)", generic ? `(material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasNormalTexture}u)!=0u` : "true") : ""}
  ${needsOrm ? sample(2, "material.payload.orm_texture_ref", "vec4f(1.0)", generic ? `(material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasOrmTexture}u)!=0u` : "true") : ""}
  ${needsEmissive ? sample(3, "material.payload.emissive_texture_ref", "vec4f(1.0)", generic ? `(material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasEmissiveTexture}u)!=0u` : "true") : ""}
  let base=material.payload.base_color_factor.xyz*color*sample_0.xyz;let metallic=clamp(material.payload.pbr_factors.x*sample_2.b,0.0,1.0);let roughness=clamp(material.payload.pbr_factors.y*sample_2.g,0.0,1.0);let ao=mix(1.0,sample_2.r,clamp(material.payload.pbr_factors.w,0.0,1.0));let emissive=material.payload.emissive_factor.xyz*sample_3.xyz;
  ${needsNormal ? "let tangent_value=sparse_tangent(geometry_base,vertices.x)*bary.weights.x+sparse_tangent(geometry_base,vertices.y)*bary.weights.y+sparse_tangent(geometry_base,vertices.z)*bary.weights.z;let tangent=normalize(mat3x3f(model[0].xyz,model[1].xyz,model[2].xyz)*tangent_value.xyz);let bitangent=normalize(cross(normal,tangent))*select(-1.0,1.0,tangent_value.w>=0.0);let mapped=vec3f((sample_1.xy*2.0-1.0)*material.payload.pbr_factors.z,sample_1.z*2.0-1.0);normal=normalize(tangent*mapped.x+bitangent*mapped.y+normal*mapped.z);" : ""}
  ${writesVelocity ? "let previous_position=oengine_instance_previous_from_current(instance)*vec4f(position,1.0);let previous_clip=shading_view.previous_view_projection*previous_position;let current_clip=shading_view.current_view_projection*vec4f(position,1.0);let current_ndc=current_clip.xy/current_clip.w;let previous_ndc=previous_clip.xy/previous_clip.w;let velocity=(current_ndc-previous_ndc)*vec2f(0.5,-0.5);" : "let velocity=vec2f(0.0);"}
  var surface_flags=OENGINE_SURFACE_FLAG_VALID;${motionFlagCode}${shadingProgramUsesTextures(descriptor.programId) ? "if !gradient_valid{surface_flags|=OENGINE_SURFACE_FLAG_GRADIENT_FALLBACK;}" : ""}${generic ? `if (material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasNormalTexture}u)!=0u{surface_flags|=OENGINE_SURFACE_FLAG_NORMAL_TEXTURE;}if (material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasOrmTexture}u)!=0u{surface_flags|=OENGINE_SURFACE_FLAG_ORM_TEXTURE;}if (material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasEmissiveTexture}u)!=0u{surface_flags|=OENGINE_SURFACE_FLAG_EMISSIVE_TEXTURE;}` : `${needsNormal ? "surface_flags|=OENGINE_SURFACE_FLAG_NORMAL_TEXTURE;" : ""}${needsOrm ? "surface_flags|=OENGINE_SURFACE_FLAG_ORM_TEXTURE;" : ""}${needsEmissive ? "surface_flags|=OENGINE_SURFACE_FLAG_EMISSIVE_TEXTURE;" : ""}`}
  return OEngineSparseSurface(base,material.payload.base_color_factor.w*sample_0.a,normal,roughness,geometric,metallic,emissive,ao,position,velocity,textureLoad(visibility_depth,vec2i(pixel),0),surface_flags);
}`;
}

function outputWgsl(descriptor: Readonly<GpuSparseShadingPipelineDescriptor>): string {
  if (isFastUnlitFactor(descriptor)) {
    return /* wgsl */ `
fn sparse_store_unlit_factor(pixel:vec2u,factor:vec4f){
  textureStore(output_hdr,vec2i(pixel),vec4f(factor.xyz*shading_view.pre_exposure,factor.w));
}`;
  }
  const lit = descriptor.programId >= GPU_SHADING_PROGRAM.PbrFactor;
  const shading = (descriptor.outputDependencyMask & GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite) !== 0;
  const diffuse = (descriptor.outputDependencyMask & GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite) !== 0;
  const velocity = (descriptor.outputDependencyMask & GPU_SHADING_OUTPUT_DEPENDENCY.Velocity) !== 0;
  return /* wgsl */ `
${shading || diffuse ? `${GPU_COMPUTE_MATERIAL_ABI_WGSL}
fn sparse_rgbe9995_encode(rgb:vec3f)->u32{let clamped=clamp(rgb,vec3f(0.0),vec3f(bitcast<f32>(0x477f8000u)));let maximum=max(bitcast<f32>(0x37800000u),max(clamped.x,max(clamped.y,clamped.z)));let exponent=bitcast<f32>((bitcast<u32>(maximum)+0x07804000u)&0x7f800000u);let mantissas=bitcast<vec3u>(clamped+exponent);return ((bitcast<u32>(exponent)<<4u)+0x10000000u)|(mantissas.b<<18u)|(mantissas.g<<9u)|(mantissas.r&0x1ffu);}` : ""}
${shading ? `fn sparse_encode_surface_normal(normal:vec3f)->vec2u{
  let unit=normalize(normal);let denominator=abs(unit.x)+abs(unit.y)+abs(unit.z);var encoded=unit.xy/denominator;
  if unit.z<0.0{let signs=select(vec2f(-1.0),vec2f(1.0),encoded>=vec2f(0.0));encoded=(vec2f(1.0)-abs(encoded.yx))*signs;}
  return vec2u((vec2f(0.5)+encoded*0.5)*${GPU_SHADING_SURFACE_NORMAL_ENCODING.maxValue}.0);
}` : ""}
fn sparse_store(pixel:vec2u,surface:OEngineSparseSurface){
  let radiance=${lit ? "sparse_direct(surface,pixel)" : "surface.base_color"}*shading_view.pre_exposure;
  textureStore(output_hdr,vec2i(pixel),vec4f(radiance,surface.alpha));
  ${shading ? "textureStore(output_normal,vec2i(pixel),vec4u(sparse_encode_surface_normal(surface.shading_normal),sparse_encode_surface_normal(surface.geometric_normal)));" : ""}
  ${shading || diffuse ? "let unlit=(surface.flags&OENGINE_SURFACE_FLAG_UNLIT)!=0u;let encoded_emissive=select(surface.emissive,surface.base_color,unlit);textureStore(output_material,vec2i(pixel),vec4u(oengine_surface_lite_pack_material(surface.metallic,surface.roughness,surface.flags),sparse_rgbe9995_encode(encoded_emissive),0u,0u));" : ""}
  ${diffuse ? "textureStore(output_albedo_ao,vec2i(pixel),select(vec4f(surface.base_color,surface.material_ao),vec4f(0.0,0.0,0.0,1.0),unlit));" : ""}
  ${velocity ? "textureStore(output_velocity,vec2i(pixel),vec4f(surface.velocity,0.0,0.0));" : ""}
}`;
}

function consumerWgsl(descriptor: Readonly<GpuSparseShadingPipelineDescriptor>, diagnostics: boolean): string {
  const reconstruct = gpuShadingProgramSpecialization(
    descriptor.programId,
    descriptor.outputDependencyMask
  ).reconstructTriangle;
  const evaluation = isFastUnlitFactor(descriptor)
    ? "let factor=sparse_evaluate_unlit_factor(material);"
    : reconstruct
      ? "if work.geometry_slot>=shading_view.geometry_count||work.instance_slot>=arrayLength(&instance_records)||instance_records[work.instance_slot].geometry_record_index!=work.geometry_slot||asset_metadata_heap[shading_view.geometry_generation_word_base+work.geometry_slot]!=oengine_instance_geometry_generation(instance_records[work.instance_slot]){sparse_identity_error();return;}let surface=sparse_evaluate_geometry(pixel,work,oengine_visibility_key_local_primitive(key),material_slot,material);"
      : "let surface=sparse_evaluate(material_slot,material);";
  const store = isFastUnlitFactor(descriptor)
    ? "sparse_store_unlit_factor(pixel,factor);"
    : "sparse_store(pixel,surface);";
  const direct = descriptor.executionMode === "direct-single-bin";
  const directEvaluation = isFastUnlitFactor(descriptor)
    ? "let factor=sparse_evaluate_unlit_factor(material);"
    : reconstruct
      ? "if work.geometry_slot>=shading_view.geometry_count||work.instance_slot>=arrayLength(&instance_records)||instance_records[work.instance_slot].geometry_record_index!=work.geometry_slot||asset_metadata_heap[shading_view.geometry_generation_word_base+work.geometry_slot]!=oengine_instance_geometry_generation(instance_records[work.instance_slot]){sparse_identity_error();return;}let surface=sparse_evaluate_geometry(pixel,work,oengine_visibility_key_local_primitive(key),material_slot,material);"
      : "let surface=sparse_evaluate(material_slot,material);";
  const directStatusCheck = "if atomicLoad(&shading_frame_status.frame_flags)!=0u{return;}";
  const diagnosticsStore = diagnostics && descriptor.executionMode === "sparse-microtile"
    ? `let claim=atomicAdd(&shading_claims[pixel.y*shading_view.width+pixel.x],1u);if claim!=0u{atomicOr(&shading_diagnostics.flags,${GPU_SPARSE_SHADING_DIAGNOSTIC_FLAG.Duplicate}u);atomicAdd(&shading_diagnostics.duplicate,1u);return;}atomicAdd(&shading_diagnostics.shaded,1u);`
    : "";
  const sparseHeader = `if shading_bin_heap.control.finalized_generation!=shading_bin_settings.generation{return;}let written=atomicLoad(&shading_bin_heap.counters[OENGINE_SHADING_BIN_ID].written_count);let dispatch_x=min(written,shading_bin_settings.max_dispatch_dimension);let record_index=group_id.y*dispatch_x+group_id.x;if record_index>=written{return;}
  let bin_layout=shading_bin_heap.layouts[OENGINE_SHADING_BIN_ID];if bin_layout.revision!=shading_bin_settings.layout_revision{if all(local_id.xy==vec2u(0u)){sparse_identity_error();}return;}
  let microtile=shading_bin_heap.records[bin_layout.record_base+record_index];let pixel=vec2u((microtile%shading_bin_settings.microtiles_x)*8u,(microtile/shading_bin_settings.microtiles_x)*8u)+local_id.xy;if any(pixel>=vec2u(shading_view.width,shading_view.height)){return;}
  if textureLoad(shading_bin_id,vec2i(pixel),0).x!=OENGINE_SHADING_BIN_ID{return;}let key=textureLoad(visibility_key,vec2i(pixel),0).x;if !oengine_visibility_key_is_valid(key){sparse_identity_error();return;}let work_slot=oengine_visibility_key_meshlet_work_slot(key);if work_slot>=meshlet_work.header.written_count||meshlet_work.header.generation==0u{sparse_identity_error();return;}let work=meshlet_work.elements[work_slot];if ((work.packed_raster_flags>>8u)&63u)!=OENGINE_SHADING_BIN_ID{sparse_identity_error();return;}let material_slot=work.material_slot_or_range;if material_slot>=shading_view.material_count{sparse_identity_error();return;}let material=material_records[material_slot];if !sparse_material_identity_valid(material){sparse_identity_error();return;}`;
  const directHeader = `let pixel=global_id.xy;if any(pixel>=vec2u(shading_view.width,shading_view.height)){return;}let key=textureLoad(visibility_key,vec2i(pixel),0).x;if !oengine_visibility_key_is_valid(key){return;}let work_slot=oengine_visibility_key_meshlet_work_slot(key);if work_slot>=meshlet_work.header.written_count||meshlet_work.header.generation==0u{sparse_identity_error();return;}let work=meshlet_work.elements[work_slot];if ((work.packed_raster_flags>>8u)&63u)!=OENGINE_SHADING_BIN_ID{sparse_identity_error();return;}let material_slot=work.material_slot_or_range;if material_slot>=shading_view.material_count{sparse_identity_error();return;}let material=material_records[material_slot];if !sparse_material_identity_valid(material){sparse_identity_error();return;}`;
  return /* wgsl */ `
@compute @workgroup_size(8,8,1)
fn ${GPU_SPARSE_SHADING_ENTRY_POINT}(${direct ? "@builtin(global_invocation_id) global_id:vec3u" : "@builtin(workgroup_id) group_id:vec3u,@builtin(local_invocation_id) local_id:vec3u"}){
  ${direct ? directHeader : sparseHeader}
  ${direct ? directEvaluation : evaluation}
  ${direct ? directStatusCheck : "if (atomicLoad(&shading_bin_heap.control.frame_flags)&OENGINE_IDENTITY_MISMATCH)!=0u{return;}"}
  ${direct ? "" : diagnosticsStore}
  ${store}
}`;
}

function isFastUnlitFactor(descriptor: Readonly<GpuSparseShadingPipelineDescriptor>): boolean {
  return descriptor.programId === GPU_SHADING_PROGRAM.UnlitFactor &&
    descriptor.outputDependencyMask === 0;
}

export function sparseShadingVariantName(programId: number): string {
  return GPU_SHADING_PROGRAM_NAMES[programId] ?? `Invalid(${programId})`;
}
