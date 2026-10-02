import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import { selectAppearanceProductProgram } from "../material/AppearanceGraphCompiler.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { TextureSurfacePublication } from "./TextureVariation.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import { AppearanceProgramRegistry, type AppearanceProgramLease, type AppearanceProgramDescriptor } from "./AppearanceProgramRegistry.js";
import { appearanceResidentKernel, APPEARANCE_ROUTE_STRIDE, type AppearanceResidentKernel,
  APPEARANCE_WORKGROUP_SIZE, type AppearanceSampleResourceProfile, type AppearanceKernelIntegration } from "../shaders/appearance_resident_kernel.js";
import { decodeGpuTextureRef, GPU_TEXTURE_REF_INVALID } from "./GpuTextureRefAbi.js";
import { encodeSamplerClass, GPU_MATERIAL_VISIBILITY_SAMPLER } from "./GpuMaterialVisibilityAbi.js";
import { AppearanceStaticResidency, appearanceStaticTextureKey, type AppearanceStaticLease } from "./AppearanceStaticResidency.js";
import type { AppearanceAssetPackage } from "../assets/AppearanceAssetPackage.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { standardAppearanceParameters } from "../material/AppearanceRuntimeInputs.js";
import { appearanceCachePlan, appearanceCacheIntegration, type AppearanceCachePlan } from "../shaders/appearance_cache.js";
import { APPEARANCE_FIELD_NAMES, APPEARANCE_FIELD_WIDTHS, APPEARANCE_SURFACE_CHANNELS, APPEARANCE_SURFACE_LAYER_COUNT, APPEARANCE_PACKED_SLOT_RECORD_COUNT } from "./GpuAppearanceCacheAbi.js";
import type { GpuAppearanceCache, PreparedAppearanceCache } from "./GpuAppearanceCache.js";
import { GPU_VISIBILITY_KEY_WGSL, GPU_VISIBILITY_KEY_EMPTY, GPU_VISIBILITY_KEY_INVALID } from "./GpuVisibilityKeyAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "./GpuMeshletRasterWorkAbi.js";
import { appearanceInputLayout, appearanceGeometryInputKind } from "../shaders/appearance_demand_inputs.js";
import { appearanceCoverageKernel, COVERAGE_DIRECTORY_STRIDE } from "../shaders/appearance_coverage.js";
import { ShadeTransparencyMode } from "../material/enums.js";

const APPEARANCE_FRAME_MAX_TASKS = 262144;
const APPEARANCE_FRAME_MAX_PIXELS = 4194304;
const APPEARANCE_FRAME_MAX_INPUT_VECTORS = 96;
const APPEARANCE_FRAME_MAX_OUTPUTS = 64;
const APPEARANCE_CACHE_STAGES = ["cache_reset", "cache_request", "cache_nominate", "cache_publish", "cache_consume"] as const;

const SURFACE_SETTINGS_WGSL = `
struct SurfaceSettings {
  width: u32, height: u32, record_count: u32, entry_index: u32,
  cache_capacity: u32, field_version: u32, residency_version: u32, reserved: u32
};
`;

function surfaceFieldExpr(slots: readonly number[] | undefined): string {
  return `vec4f(${Array.from({ length: 4 }, (_, channel) =>
    slots?.[channel] === undefined ? "0.0" : `value[${slots[channel]}u]`).join(",")})`;
}

function surfaceIdentityHash(value: string): number {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Integrates the already compiled resident program with SurfaceWork.  Each
 * invocation consumes one compact miss, fills private geometry inputs, runs
 * the exact compiled graph and publishes the same six physical surface
 * layers.  No fallback material math is introduced here.
 */
function surfaceKernelIntegration(program: CompiledAppearanceGraph,
  lowered: AppearanceResidentKernel["lowered"]): AppearanceKernelIntegration {
  const inputLayout = appearanceInputLayout(program);
  const inputDeclarations = program.inputs.map((input, index) => {
    const kind = appearanceGeometryInputKind(input, program);
    const value = kind === 0 ? `surface_runtime_inputs[surface_directory[directory_base+7u]+${index}u]` : kind === 1 ? "geometry[base + 3u].xy" :
      kind === 2 ? "geometry[base + 3u].zw" :
      kind === 3 ? "geometry[base + 4u].xy" :
      kind === 4 ? "geometry[base + 11u]" :
      kind === 5 ? "geometry[base + 2u]" :
      kind === 6 ? "geometry[base + 5u]" :
      kind === 7 ? "geometry[base + 0u]" :
      kind === 8 ? "geometry[base + 6u]" :
      kind === 9 ? "geometry[base + 0u]" :
      kind === 10 ? "geometry[base + 0u]" :
      kind === 11 ? "geometry[base + 2u]" :
      kind === 12 ? "geometry[base + 5u]" :
      kind === 13 ? "geometry[base + 0u]" :
      kind === 14 ? "geometry[base + 2u]" : "vec4f(0.0)";
    const center = `appearance_inputs[${index}u]=${value};`;
    const dx = kind === 1 ? "geometry[base + 7u].xy" : "vec2f(0.0)";
    const dy = kind === 1 ? "geometry[base + 7u].zw" : "vec2f(0.0)";
    return `${center} appearance_inputs[${inputLayout.neighborBase + index * 2}u]=${value} + vec4f(${dx},0.0,0.0); appearance_inputs[${inputLayout.neighborBase + index * 2 + 1}u]=${value} + vec4f(${dy},0.0,0.0);`;
  }).join("\n  ");
  const layers = `${Array.from({ length: APPEARANCE_SURFACE_LAYER_COUNT }, (_, layer) => `var layer${layer}=vec4f(0.0);`).join("\n  ")}\n  var validityBits=0u;`;
  const writes = APPEARANCE_FIELD_NAMES.map((name, field) => {
    const expression = surfaceFieldExpr(lowered.outputSlots[name]);
    const [layer, channel] = APPEARANCE_SURFACE_CHANNELS[field]!;
    if (field >= 13) return `validityBits = validityBits | (u32(clamp(${expression}.x,0.0,1.0)*1.0) << ${field - 13}u);`;
    if (APPEARANCE_FIELD_WIDTHS[field] === 3) return `layer${layer}.xyz=${expression}.xyz;`;
    return `layer${layer}[${channel}]=${expression}.x;`;
  }).join("\n  ");
  const declarations = `
${SURFACE_SETTINGS_WGSL}
struct AppearanceRoute { identity: vec4u, uv: vec4f, rotation: vec4f, fallback: vec4f }
@group(0) @binding(0) var<storage, read> appearance_constants: array<f32>;
@group(0) @binding(1) var<storage, read> appearance_routes: array<AppearanceRoute>;
@group(0) @binding(5) var<uniform> appearance_dispatch: vec4u;
@group(0) @binding(13) var<storage, read> surface_geometry: array<vec4f>;
@group(0) @binding(14) var<storage, read> surface_misses: array<u32>;
@group(0) @binding(15) var<storage, read> surface_hit_mask: array<u32>;
@group(0) @binding(16) var<storage, read> surface_material_lookup: array<u32>;
@group(0) @binding(17) var<storage, read> surface_directory: array<u32>;
@group(0) @binding(18) var surface_fields: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(19) var<uniform> surface_settings: SurfaceSettings;
@group(0) @binding(20) var<storage, read_write> surface_cache: array<vec4u>;
@group(0) @binding(21) var<storage, read_write> surface_cache_values: array<vec4f>;
@group(0) @binding(22) var<storage, read> surface_identity: array<vec4u>;
@group(0) @binding(23) var<storage, read> surface_counters: array<u32>;
@group(0) @binding(24) var<storage, read> surface_field_versions: array<u32>;
@group(0) @binding(25) var<storage, read> surface_residency_versions: array<u32>;
@group(0) @binding(26) var<storage, read> surface_runtime_inputs: array<vec4f>;
@group(0) @binding(27) var<storage, read> surface_work: array<u32>;
var<private> appearance_task: vec4u;
var<private> appearance_inputs: array<vec4f, ${Math.max(1, inputLayout.vectors)}>;
fn appearance_constant(index:u32)->f32 { return appearance_constants[appearance_task.x+index]; }
fn appearance_input(index:u32,channel:u32)->f32 { return appearance_inputs[index][channel]; }
fn surface_cache_hash(identity:u32, material:u32, field:u32, residency:u32, publication:u32)->u32 { var x=identity^(material*16777619u)^(field*2246822519u)^(residency*3266489917u)^publication; x^=x>>16u; x*=0x7feb352du; x^=x>>15u; x*=0x846ca68bu; return x^(x>>16u); }
fn surface_geometry_identity(geometry_slot:u32, meshlet_slot:u32, instance_slot:u32, primitive:u32, material:u32)->u32 { var x=geometry_slot*16777619u^meshlet_slot*2246822519u^instance_slot*3266489917u^primitive*668265263u^material; x^=x>>16u; x*=0x7feb352du; return x^(x>>15u); }
`;
  const entrySource = `
@compute @workgroup_size(${APPEARANCE_WORKGROUP_SIZE})
fn surface_main(@builtin(global_invocation_id) id: vec3u) {
  let miss=id.x;
  if (miss>=surface_settings.record_count || miss>=surface_counters[4u+surface_settings.entry_index*8u+4u]) { return; }
  let record=surface_misses[miss];
  if (surface_hit_mask[record]!=0u) { return; }
  let base=record*12u;
  let material=bitcast<u32>(surface_geometry[base+10u].y);
  if (material>=arrayLength(&surface_material_lookup)) { return; }
  let entry=surface_material_lookup[material];
  if (entry==0xffffffffu || surface_directory[entry*8u+1u]!=surface_settings.entry_index) { return; }
  let directory_base=entry*8u;
  appearance_task=vec4u(surface_directory[directory_base+2u],surface_directory[directory_base+3u],0u,0u);
  ${inputDeclarations}
  appearance_prepare_coordinates();
  let value=appearance_evaluate();
  ${layers}
  ${writes}
  layer5.w=bitcast<f32>(validityBits);
  let pixel_word=surface_work[surface_settings.reserved/4u+record*8u];
  let pixel=vec2i(pixel_word%surface_settings.width,pixel_word/surface_settings.width);
  textureStore(surface_fields,pixel,0,layer0); textureStore(surface_fields,pixel,1,layer1);
  textureStore(surface_fields,pixel,2,layer2); textureStore(surface_fields,pixel,3,layer3);
  textureStore(surface_fields,pixel,4,layer4); textureStore(surface_fields,pixel,5,layer5);
  let stable=surface_geometry_identity(bitcast<u32>(surface_geometry[base+9u].w),bitcast<u32>(surface_geometry[base+9u].y),bitcast<u32>(surface_geometry[base+9u].z),bitcast<u32>(surface_geometry[base+10u].w),material);
  let field=select(0u,surface_field_versions[0u],arrayLength(&surface_field_versions)>0u);
  let residency=select(0u,surface_residency_versions[0u],arrayLength(&surface_residency_versions)>0u);
  let identityRecord=surface_identity[entry];
  let hash=surface_cache_hash(stable,material,field,residency,identityRecord.x^identityRecord.y^identityRecord.z^identityRecord.w);
  let cell=hash&(surface_settings.cache_capacity-1u);
  surface_cache[cell]=vec4u(hash,stable,material,identityRecord.z);
  surface_cache_values[cell*${APPEARANCE_SURFACE_LAYER_COUNT}u+0u]=layer0;
  surface_cache_values[cell*${APPEARANCE_SURFACE_LAYER_COUNT}u+1u]=layer1;
  surface_cache_values[cell*${APPEARANCE_SURFACE_LAYER_COUNT}u+2u]=layer2;
  surface_cache_values[cell*${APPEARANCE_SURFACE_LAYER_COUNT}u+3u]=layer3;
  surface_cache_values[cell*${APPEARANCE_SURFACE_LAYER_COUNT}u+4u]=layer4;
  surface_cache_values[cell*${APPEARANCE_SURFACE_LAYER_COUNT}u+5u]=layer5;
}
`;
  const fixed: GPUBindGroupLayoutEntry[] = [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 4 } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: APPEARANCE_ROUTE_STRIDE } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 16 } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: 16 } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: 16 } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } },
    { binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 4 } },
    { binding: 12, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 16 } },
    { binding: 13, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 16 } },
    { binding: 14, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 4 } },
    { binding: 15, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 4 } },
    { binding: 16, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 4 } },
    { binding: 17, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 4 } },
    { binding: 18, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float", viewDimension: "2d-array" } },
    { binding: 19, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 32 } },
    { binding: 20, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: 16 } },
    { binding: 21, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage", minBindingSize: 16 } },
    { binding: 22, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 16 } }
    ,{ binding: 23, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 16 } }
    ,{ binding: 24, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 4 } }
    ,{ binding: 25, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 4 } }
    ,{ binding: 26, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 16 } }
    ,{ binding: 27, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 4 } }
  ];
  return { entryPoint: "surface_main", groups: [fixed], declarations, entrySource };
}
const APPEARANCE_DEMAND_WGSL = /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
struct Settings { width: u32, height: u32, task_capacity: u32, max_inputs: u32, max_outputs: u32, frame: u32, row_start: u32, row_count: u32,
  frame_header: u32, frame_directory: u32, program_count: u32, reserved: u32 }
@group(0) @binding(0) var visibility: texture_2d<u32>;
@group(0) @binding(1) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var<storage, read> material_lookup: array<u32>;
@group(0) @binding(3) var<storage, read> directory: array<u32>;
@group(0) @binding(4) var<storage, read> runtime_inputs: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> tasks: array<vec4u>;
@group(0) @binding(6) var<storage, read_write> task_inputs: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> task_program: array<u32>;
@group(0) @binding(8) var<storage, read_write> pixel_tasks: array<u32>;
@group(0) @binding(9) var<storage, read_write> control: array<atomic<u32>>;
@group(0) @binding(10) var<storage, read_write> indirect: array<atomic<u32>>;
@group(0) @binding(11) var<storage, read_write> metadata: array<vec4u>;
@group(0) @binding(13) var<uniform> settings: Settings;
@compute @workgroup_size(8, 8)
fn demand(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= settings.width || id.y >= settings.row_count { return; }
  let position = vec2u(id.x, id.y + settings.row_start);
  let pixel = position.y * settings.width + position.x;
  if pixel >= arrayLength(&pixel_tasks) { return; }
  let key = textureLoad(visibility, vec2i(position), 0).x;
  if key == ${GPU_VISIBILITY_KEY_EMPTY}u || key == ${GPU_VISIBILITY_KEY_INVALID}u { pixel_tasks[pixel] = 0xffffffffu; return; }
  let decoded = oengine_visibility_key_decode(key);
  if decoded.valid == 0u { pixel_tasks[pixel] = 0xffffffffu; return; }
  if decoded.meshlet_work_slot >= meshlet_work.header.written_count { pixel_tasks[pixel] = 0xffffffffu; return; }
  let work = meshlet_work.elements[decoded.meshlet_work_slot];
  if work.material_slot_or_range >= arrayLength(&material_lookup) { pixel_tasks[pixel] = 0xffffffffu; return; }
  let entry = material_lookup[work.material_slot_or_range];
  if entry == 0xffffffffu { pixel_tasks[pixel] = 0xffffffffu; return; }
  let program = directory[entry * 8u + 1u];
  let slot = atomicAdd(&control[0], 1u);
  if slot >= settings.task_capacity { atomicAdd(&control[1], 1u); pixel_tasks[pixel] = 0xffffffffu; return; }
  let source = entry * 8u;
  let input_base = directory[source + 7u];
  let input_shape = metadata[program];
  let input_count = input_shape.x;
  let task_input_base = slot * settings.max_inputs;
  for (var i = 0u; i < input_count; i++) {
    task_inputs[task_input_base + i] = runtime_inputs[input_base + i];
  }
  tasks[slot] = vec4u(directory[source + 2u], directory[source + 3u], task_input_base, slot * settings.max_outputs);
  task_program[slot] = program;
  metadata[settings.program_count + slot] = vec4u(work.material_slot_or_range, directory[source + 5u], pixel, program);
  atomicAdd(&indirect[4u + program * 8u + 4u], 1u);
  pixel_tasks[pixel] = slot;
}
@compute @workgroup_size(1)
fn finalize() {
  let count = min(atomicLoad(&control[0]), settings.task_capacity);
  atomicAdd(&control[2], count);
  atomicAdd(&control[3], atomicLoad(&control[0]));
  atomicStore(&indirect[0], (count + 63u) / 64u); atomicStore(&indirect[1], 1u); atomicStore(&indirect[2], 1u);
  atomicStore(&indirect[3], count);
  var prefix = 0u;
  for (var program = 0u; program < settings.program_count; program++) {
    let at = 4u + program * 8u;
    let tasks = atomicLoad(&indirect[at + 4u]);
    let x = (tasks + 63u) / 64u;
    atomicStore(&indirect[at], x); atomicStore(&indirect[at + 1u], 1u); atomicStore(&indirect[at + 2u], 1u); atomicStore(&indirect[at + 3u], tasks);
    atomicStore(&indirect[at + 5u], prefix); atomicStore(&indirect[at + 7u], x);
    prefix += tasks;
  }
}
`;
const APPEARANCE_SCATTER_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> source_tasks: array<vec4u>;
@group(0) @binding(1) var<storage, read> source_metadata: array<vec4u>;
@group(0) @binding(2) var<storage, read> buckets: array<vec4u>;
@group(0) @binding(3) var<storage, read_write> cursors: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> ordered_tasks: array<vec4u>;
@group(0) @binding(5) var<storage, read_write> ordered_programs: array<u32>;
@group(0) @binding(6) var<storage, read_write> ordered_metadata: array<vec4u>;
@group(0) @binding(7) var<storage, read_write> pixels: array<u32>;
@group(0) @binding(8) var<uniform> program_count: vec4u;
@compute @workgroup_size(64)
fn scatter(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= buckets[0].w { return; }
  let meta = source_metadata[program_count.x + id.x];
  let bucket = buckets[2u + meta.w * 2u];
  let target = bucket.y + atomicAdd(&cursors[4u + meta.w], 1u);
  ordered_tasks[target] = source_tasks[id.x];
  ordered_programs[target] = meta.w;
  ordered_metadata[target] = meta;
  pixels[meta.z] = target;
}
`;
const APPEARANCE_RESOLVE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> resolve_tasks: array<vec4u>;
@group(0) @binding(1) var<storage, read> resolve_program: array<u32>;
@group(0) @binding(2) var<storage, read> resolve_pixels: array<u32>;
@group(0) @binding(3) var<storage, read> resolve_outputs: array<f32>;
@group(0) @binding(4) var resolve_settings: texture_storage_2d_array<rgba16float, write>;
struct ResolveSettings { extent: vec4u, stripe: vec4u }
@group(0) @binding(5) var<uniform> resolve_settings_data: ResolveSettings;
@group(0) @binding(6) var<storage, read> resolve_field_slots: array<vec4u>;
@compute @workgroup_size(8, 8)
fn resolve(@builtin(global_invocation_id) id: vec3u) {
  let resolve_size = resolve_settings_data.extent;
  if id.x >= resolve_size.x || id.y >= resolve_settings_data.stripe.y { return; }
  let position = vec2u(id.x, id.y + resolve_settings_data.stripe.x);
  let pixel = position.y * resolve_size.x + position.x;
  let task = resolve_pixels[pixel];
  if task == 0xffffffffu {
    for (var field = 0u; field < resolve_size.z; field++) {
      textureStore(resolve_settings, vec2i(position), i32(field), vec4f(0.0));
    }
    return;
  }
  let base = resolve_tasks[task].w;
  let program = resolve_program[task];
  for (var field = 0u; field < resolve_size.z; field++) {
    let slots = resolve_field_slots[program * ${APPEARANCE_PACKED_SLOT_RECORD_COUNT}u + field];
    var value = vec4f(0.0);
    for (var channel = 0u; channel < 4u; channel++) {
      if slots[channel] != 0xffffffffu { value[channel] = resolve_outputs[base + slots[channel]]; }
    }
    if field==5u {
      let flags=resolve_field_slots[program*${APPEARANCE_PACKED_SLOT_RECORD_COUNT}u+${APPEARANCE_SURFACE_LAYER_COUNT}u];
      var valid=vec2u(1u);
      for(var lobe=0u;lobe<2u;lobe++) {
        if flags[lobe]!=0xffffffffu { valid[lobe]=select(0u,1u,resolve_outputs[base+flags[lobe]]>0.5); }
      }
      value.w=f32(valid.x|(valid.y<<1u));
    }
    textureStore(resolve_settings, vec2i(position), i32(field), value);
  }
}
`;

export const APPEARANCE_DIRECTORY_STRIDE = 32;
/** u32 version, scalar output base, width, dependency mask. */
export const APPEARANCE_FIELD_RECORD_STRIDE = 16;

export interface AppearancePublicationSource {
  readonly material: StandardShadeMaterial;
  readonly materialSlot: number;
  readonly textureBindingSetId: number;
  readonly program: CompiledAppearanceGraph;
  readonly fieldVersions?: ReadonlyMap<string, { readonly version: number }>;
  readonly textureRefs: ReadonlyMap<ShadeTexture, number>;
}

export interface AppearancePublishedEntry {
  readonly material: StandardShadeMaterial;
  readonly inputBase: number;
  readonly materialSlot: number;
  readonly textureBindingSetId: number;
  readonly constantBase: number;
  readonly routeBase: number;
  readonly programIndex: number;
  /** Tasks may share a dispatch only when both PSO and physical resource set agree. */
  readonly resourceSetIndex: number;
  readonly kernel: AppearanceResidentKernel;
  readonly program: CompiledAppearanceGraph;
  readonly productTextures: readonly GPUTexture[];
  readonly fieldBase: number;
  readonly cachePlan: AppearanceCachePlan;
  readonly coverage: AppearancePublishedCoverage;
}

export interface AppearancePublishedCoverage {
  readonly material: StandardShadeMaterial;
  readonly materialSlot: number;
  readonly textureBindingSetId: number;
  readonly constantBase: number;
  readonly routeBase: number;
  readonly inputBase: number;
  readonly program: CompiledAppearanceGraph;
  readonly kernel: AppearanceResidentKernel;
  readonly productTextures: readonly GPUTexture[];
  readonly productViews: readonly GPUTextureView[];
  /** Zero is the shared opaque raster program. Alpha programs begin at one. */
  readonly rasterProgram: number;
  readonly cutoffSlot: number;
  readonly viewDependent: boolean;
}

/** Immutable, actual-sized scene publication. Owns buffers and program leases. */
export class GpuAppearancePublication {
  readonly entries: readonly AppearancePublishedEntry[];
  readonly constants: GPUBuffer;
  readonly routes: GPUBuffer;
  readonly fields: GPUBuffer;
  /** Numeric dynamic inputs, one vec4 per compiled named input. Geometry and
   * surface inputs are supplied by the shared geometry consumer, not this table. */
  readonly runtimeInputs: GPUBuffer;
  /** Material-slot lookup and stable publication identity consumed by SurfaceWork. */
  readonly materialLookup: GPUBuffer;
  readonly surfaceIdentity: GPUBuffer;
  readonly surfaceProgramCount: number;
  readonly surfaceMaxInputVectors: number;
  readonly surfaceMaxOutputs: number;
  readonly cache!: PreparedAppearanceCache;
  /** Eight u32s: material, PSO, constants, routes, resources, field base, field count, reserved. */
  readonly directory: GPUBuffer;
  /** Material-slot indexed fragment constants/routes/input directory. */
  readonly coverageDirectory: GPUBuffer;
  readonly allocatedBytes: number;
  readonly ready: Promise<void>;
  private readonly leases: readonly AppearanceProgramLease[];
  private readonly cacheStageLeases: AppearanceProgramLease[][] = [];
  private readonly coordinateLeases: AppearanceProgramLease[] = [];
  private readonly staticLeases: AppearanceStaticLease[] = [];
  private readonly buffers: GPUBuffer[] = [];
  private readonly surfaceLeases: AppearanceProgramLease[] = [];
  private surfacePipelines: readonly Awaited<AppearanceProgramLease["ready"]>[] | null = null;
  private constantValues!: Float32Array<ArrayBuffer>;
  private inputValues!: Float32Array<ArrayBuffer>;
  private fieldWords!: Uint32Array<ArrayBuffer>;
  private fieldDependencies: readonly (readonly number[])[] = [];
  private readonly accountingHandles: ResourceHandle[] = [];
  private pipelines: readonly Awaited<AppearanceProgramLease["ready"]>[] | null = null;
  private readonly cancelReadiness: (reason: Error) => void;
  private unwatchRegistry: (() => void) | null = null;
  private readonly destroyedListeners = new Set<() => void>();
  private releasing: ShadeGPUCommandContext | null = null;
  private state: "staging" | "ready" | "resident" | "retiring" | "destroyed" = "staging";

  constructor(private readonly device: GPUDevice, registry: AppearanceProgramRegistry,
    sources: readonly AppearancePublicationSource[], command: ShadeGPUCommandContext,
    mipRanges: ReadonlyMap<ShadeTexture, readonly [number, number]>,
    texturePublications: ReadonlyMap<ShadeTexture, TextureSurfacePublication>,
    private readonly accounting?: ResourceAccounting, staticResidency?: AppearanceStaticResidency,
    private readonly cacheOwner?: GpuAppearanceCache) {
    if (command.device !== device || command.closed) throw new Error("Appearance requires an open command on its GPUDevice");
    const entries: AppearancePublishedEntry[] = [];
    const leaseList: AppearanceProgramLease[] = [];
    const descriptors: AppearanceProgramDescriptor[] = [];
    const surfaceDescriptors: AppearanceProgramDescriptor[] = [];
    const surfaceKernels: AppearanceResidentKernel[] = [];
    const leaseIndices = new Map<string, number>();
    const resourceSets = new Map<string, number>();
    const coveragePrograms = new Map<string, number>();
    const constants: number[] = [];
    const runtimeInputs: number[] = [];
    const fieldDependencies: number[][] = [];
    const fields: number[] = [];
    const routes: ArrayBuffer[] = [];
    const directoryWords = APPEARANCE_DIRECTORY_STRIDE / 4;
    const directory = new Uint32Array(sources.length * directoryWords);
    const assets = new Map<string, AppearanceAssetPackage>();
    const productTargets: { assetId: string; field: string; textures: GPUTexture[]; binding: number }[] = [];
    try {
      for (const [index, source] of sources.entries()) {
        if (!Number.isInteger(source.materialSlot) || source.materialSlot < 0 || source.materialSlot > 0xffffffff) {
          throw new RangeError("Appearance material slot is not u32");
        }
        const resources: AppearanceSampleResourceProfile[] = [];
        const routeBase = routes.length;
        for (const sample of source.program.samples) {
          const ref = source.textureRefs.get(sample.binding.texture) ?? GPU_TEXTURE_REF_INVALID;
          const decoded = decodeGpuTextureRef(ref);
          // Invalid references preserve the published role's semantic fallback;
          // bank 0 exists in every TextureResidency binding set.
          const publication = texturePublications.get(sample.binding.texture);
          const route = packRoute(sample.binding, ref, mipRanges.get(sample.binding.texture), publication);
          const samplerClass = new DataView(route).getUint32(4, true);
          const address = samplerClass & GPU_MATERIAL_VISIBILITY_SAMPLER.AddressMask;
          const sampler = (samplerClass & GPU_MATERIAL_VISIBILITY_SAMPLER.LinearBit) !== 0 ? 0 : 3;
          resources.push({ bank: decoded?.bankClass ?? 0, sampler: sampler + (address === 0 ? 0 : address === 2 ? 1 : 2) });
          routes.push(route);
        }
        // A named parameter's numeric values never enter the compiled source.
        const productBindings = new Map<string, number>(), productTextures: GPUTexture[] = [];
        const productResources = (source.program.productReads ?? []).map(read => {
          if (read.field.constant !== undefined) return null;
          if (staticResidency === undefined) throw new Error("Appearance products require the long-lived static residency owner");
          const key = appearanceStaticTextureKey(read.asset, read.field)!;
          let binding = productBindings.get(key);
          if (binding === undefined) {
            binding = productBindings.size; productBindings.set(key, binding);
            productTargets.push({ assetId: read.asset.runtime.manifest.assetId, field: read.field.name, textures: productTextures, binding });
          }
          const layer = read.asset.fields.filter(field => appearanceStaticTextureKey(read.asset, field) === key).findIndex(field => field.name === read.field.name);
          routes.push(packProductRoute(read.asset, layer));
          assets.set(read.asset.runtime.manifest.assetId, read.asset);
          return binding;
        });
        const cachePlan = appearanceCachePlan(source.program, appearanceInputLayout(source.program).vectors, 64);
        const hasCachedFields = cachePlan.fields.some(field => field.cells > 0);
        const candidate = appearanceResidentKernel(source.program, resources, productResources,
          hasCachedFields ? appearanceCacheIntegration(cachePlan) : undefined);
        const kernelKey = candidate.descriptor.source + ":resident-linear:" + JSON.stringify([
          resources, productResources, source.textureBindingSetId, [...productBindings.keys()], candidate.lowered.outputSlots,
          source.program.inputs.map(input => [input.name, input.domain]),
          source.program.instructions.filter(instruction => instruction.kind === "input").map(instruction => instruction.coordinateDomains)
        ]);
        // Metadata (output names and parameter provenance) belongs to each
        // material program even when its WGSL topology shares the same PSO.
        const kernel = candidate;
        const resourceKey = JSON.stringify([source.textureBindingSetId, [...productBindings.keys()]]);
        let resourceSetIndex = resourceSets.get(resourceKey);
        if (resourceSetIndex === undefined) { resourceSetIndex = resourceSets.size; resourceSets.set(resourceKey, resourceSetIndex); }
        let programIndex = leaseIndices.get(kernelKey);
        if (programIndex === undefined) {
          programIndex = descriptors.length;
          descriptors.push(kernel.descriptor);
          const surfaceKernel = appearanceResidentKernel(source.program, resources, productResources,
            surfaceKernelIntegration(source.program, kernel.lowered));
          surfaceKernels.push(surfaceKernel);
          surfaceDescriptors.push(surfaceKernel.descriptor);
          leaseIndices.set(kernelKey, programIndex);
        }
        const constantBase = constants.length;
        const inputBase = runtimeInputs.length / 4;
        for (const input of source.program.inputs) {
          const gpuInput=appearanceGeometryInputKind(input,source.program)!==0;
          const value = gpuInput ? undefined : source.material.appearance_inputs.get(input.name);
          if (!gpuInput && value?.length !== input.width) {
            throw new RangeError(`Appearance input '${input.name}' requires ${input.width} live components`);
          }
          runtimeInputs.push(...Array.from({ length: 4 }, (_, channel) => value?.[channel] ?? 0));
        }
        const fieldBase = fields.length / (APPEARANCE_FIELD_RECORD_STRIDE / 4);
        for (const [name, outputs] of Object.entries(kernel.lowered.outputSlots)) {
          const version = source.fieldVersions === undefined ? 1 : source.fieldVersions.get(name)?.version;
          if (version === undefined || !Number.isInteger(version) || version < 1 || version > 0xffffffff) throw new RangeError("Appearance output field requires a nonzero u32 version");
          const dependency = source.program.outputs[name]!.reduce((mask, ref) => mask | source.program.instructions[ref]!.dependency, 0);
          fields.push(version, outputs[0]!, outputs.length, dependency);
          const live = new Set<number>(), pending = [...source.program.outputs[name]!];
          const numeric = new Set<number>();
          while (pending.length) {
            const ref = pending.pop()!;
            if (live.has(ref)) continue;
            live.add(ref); const instruction = source.program.instructions[ref]!;
            if (instruction.kind === "parameter") {
              for (const slot of kernel.lowered.parameterSlots[instruction.parameter!] ?? []) numeric.add(constantBase + slot.slot);
            }
            if (instruction.kind === "input") {
              const index = source.program.inputs.findIndex(input => input.name === instruction.input);
              const input = source.program.inputs[index]!;
              if (appearanceGeometryInputKind(input,source.program)===0) numeric.add(-1 - (inputBase + index) * 4 - instruction.channel!);
            }
            pending.push(...instruction.args);
          }
          fieldDependencies.push([...numeric]);
        }
        // Values must come from this instance even when its topology reuses a kernel.
        constants.push(...candidate.lowered.constants);
        const alpha = source.program.outputs.alpha;
        if (alpha?.length !== 1) throw new Error("Published Appearance requires a scalar coverage root");
        const coverageProgram = selectAppearanceProductProgram(source.program, { alpha });
        const coverageRouteBase = routes.length;
        const coverageResources: AppearanceSampleResourceProfile[] = [];
        for (const sample of coverageProgram.samples) {
          const ref = source.textureRefs.get(sample.binding.texture) ?? GPU_TEXTURE_REF_INVALID;
          const route = packRoute(sample.binding, ref, mipRanges.get(sample.binding.texture), texturePublications.get(sample.binding.texture));
          const samplerClass = new DataView(route).getUint32(4, true);
          const address = samplerClass & GPU_MATERIAL_VISIBILITY_SAMPLER.AddressMask;
          coverageResources.push({ bank: decodeGpuTextureRef(ref)?.bankClass ?? 0,
            sampler: ((samplerClass & GPU_MATERIAL_VISIBILITY_SAMPLER.LinearBit) !== 0 ? 0 : 3) + (address === 0 ? 0 : address === 2 ? 1 : 2) });
          routes.push(route);
        }
        const coverageProductBindings = new Map<string, number>(), coverageProductTextures: GPUTexture[] = [];
        const coverageProducts = (coverageProgram.productReads ?? []).map(read => {
          if (read.field.constant !== undefined) return null;
          if (!staticResidency) throw new Error("Coverage products require static residency");
          const key = appearanceStaticTextureKey(read.asset, read.field)!;
          let binding = coverageProductBindings.get(key);
          if (binding === undefined) {
            binding = coverageProductBindings.size; coverageProductBindings.set(key, binding);
            productTargets.push({ assetId: read.asset.runtime.manifest.assetId, field: read.field.name, textures: coverageProductTextures, binding });
          }
          const layer = read.asset.fields.filter(field => appearanceStaticTextureKey(read.asset, field) === key).findIndex(field => field.name === read.field.name);
          routes.push(packProductRoute(read.asset, layer)); assets.set(read.asset.runtime.manifest.assetId, read.asset);
          return binding;
        });
        const coverageKernel = appearanceCoverageKernel(coverageProgram, coverageResources, coverageProducts);
        const coverageConstantBase = constants.length, coverageInputBase = runtimeInputs.length / 4;
        constants.push(...coverageKernel.lowered.constants);
        const cutoffSlot = constants.length;
        if (!Number.isFinite(Math.fround(source.material.alpha_cutoff))) throw new RangeError("Coverage cutoff must be finite f32");
        constants.push(Math.max(0,Math.min(1,source.material.alpha_cutoff)));
        for (const input of coverageProgram.inputs) {
          const inputIndex = source.program.inputs.findIndex(candidate => candidate.name === input.name);
          runtimeInputs.push(...runtimeInputs.slice((inputBase + inputIndex) * 4, (inputBase + inputIndex + 1) * 4));
        }
        const coverageKey = coverageKernel.descriptor.source + JSON.stringify([source.textureBindingSetId, [...coverageProductBindings.keys()]]);
        let rasterProgram = 0;
        if (source.material.transparency_mode === ShadeTransparencyMode.AlphaTested) {
          const existingProgram = coveragePrograms.get(coverageKey);
          rasterProgram = existingProgram ?? coveragePrograms.size + 1;
          if (existingProgram === undefined) coveragePrograms.set(coverageKey, rasterProgram);
        }
        const coverage: AppearancePublishedCoverage = Object.freeze({ material: source.material, materialSlot: source.materialSlot,
          textureBindingSetId: source.textureBindingSetId, constantBase: coverageConstantBase, routeBase: coverageRouteBase,
          inputBase: coverageInputBase, program: coverageProgram, kernel: coverageKernel, productTextures: coverageProductTextures, productViews: [], rasterProgram,
          cutoffSlot, viewDependent: coverageProgram.inputs.some(input => [8,9,13,14].includes(appearanceGeometryInputKind(input,coverageProgram))) });
        entries.push(Object.freeze({ material: source.material, inputBase, materialSlot: source.materialSlot, textureBindingSetId: source.textureBindingSetId,
          constantBase, routeBase, programIndex, resourceSetIndex, kernel, program: source.program, productTextures, fieldBase, cachePlan, coverage }));
        directory.set([source.materialSlot, programIndex, constantBase, routeBase, resourceSetIndex, fieldBase,
          Object.keys(kernel.lowered.outputSlots).length, inputBase], index * directoryWords);
      }
      const constantData = new Float32Array(Math.max(constants.length, 1));
      constantData.set(constants);
      const routeData = new Uint8Array(Math.max(routes.length, 1) * APPEARANCE_ROUTE_STRIDE);
      routes.forEach((route, index) => routeData.set(new Uint8Array(route), index * APPEARANCE_ROUTE_STRIDE));
      const directoryData = sources.length === 0 ? new Uint32Array(directoryWords) : directory;
      const fieldData = new Uint32Array(Math.max(fields.length, APPEARANCE_FIELD_RECORD_STRIDE / 4)); fieldData.set(fields);
      const inputData = new Float32Array(Math.max(runtimeInputs.length, 4)); inputData.set(runtimeInputs);
      const maxMaterialSlot = Math.max(0, ...sources.map(source => source.materialSlot));
      const materialLookupData = new Uint32Array(maxMaterialSlot + 1); materialLookupData.fill(0xffffffff);
      const identityData = new Uint32Array(Math.max(4, sources.length * 4));
      sources.forEach((source, index) => {
        materialLookupData[source.materialSlot] = index;
        const fieldIdentity = [...(source.fieldVersions?.entries() ?? [])]
          .sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}:${value.version}`).join("|");
        const routeIdentity = [...source.textureRefs.entries()]
          .map(([texture, ref]) => `${texture.appearance_content_version ?? texture.label}:${ref}`).sort().join("|");
        const variationIdentity = [...source.textureRefs.keys()]
          .map(texture => `${texture.appearance_content_version ?? texture.label}:${texturePublications.get(texture)?.revision ?? 0}`).sort().join("|");
        identityData[index * 4 + 0] = surfaceIdentityHash(fieldIdentity);
        identityData[index * 4 + 1] = surfaceIdentityHash(routeIdentity);
        identityData[index * 4 + 2] = surfaceIdentityHash(variationIdentity);
        identityData[index * 4 + 3] = directoryData[index * directoryWords + 1] ?? 0;
      });
      const maximum = Math.min(Number(device.limits.maxBufferSize), Number(device.limits.maxStorageBufferBindingSize));
      for (const data of [constantData, routeData, directoryData, fieldData, inputData, materialLookupData, identityData]) if (data.byteLength > maximum) {
        throw new RangeError(`Appearance publication ${data.byteLength} bytes exceed negotiated storage limit ${maximum}`);
      }
      // Publication byte admission precedes every shader/layout/pipeline/buffer creation.
      for (const descriptor of descriptors) registry.preflight(descriptor);
      for (const descriptor of surfaceDescriptors) registry.preflight(descriptor);
      for (const descriptor of descriptors) registry.preflight({ ...descriptor, entryPoint: "prepare_coordinates" });
      for (let index = 0; index < descriptors.length; index++) {
        const plan = entries.find(entry => entry.programIndex === index)!.cachePlan;
        if (plan.fields.some(field => field.cells > 0)) {
          for (const entryPoint of APPEARANCE_CACHE_STAGES) registry.preflight({ ...descriptors[index]!, entryPoint });
        }
      }
      for (const descriptor of descriptors) leaseList.push(registry.acquire(descriptor));
      for (const descriptor of surfaceDescriptors) this.surfaceLeases.push(registry.acquire(descriptor));
      for (const descriptor of descriptors) this.coordinateLeases.push(registry.acquire({ ...descriptor, entryPoint: "prepare_coordinates" }));
      for (let index = 0; index < descriptors.length; index++) {
        const plan = entries.find(entry => entry.programIndex === index)!.cachePlan;
        this.cacheStageLeases.push(plan.fields.some(field => field.cells > 0)
          ? APPEARANCE_CACHE_STAGES.map(entryPoint => registry.acquire({ ...descriptors[index]!, entryPoint })) : []);
      }
      const assetLeases = new Map<string, AppearanceStaticLease>();
      for (const [id, asset] of assets) {
        const lease = staticResidency!.acquire(asset, command);
        this.staticLeases.push(lease); assetLeases.set(id, lease);
      }
      for (const target of productTargets) target.textures[target.binding] = assetLeases.get(target.assetId)!.destination(target.field).texture;
      for (const entry of entries) {
        Object.freeze(entry.productTextures); Object.freeze(entry.coverage.productTextures);
        (entry.coverage.productViews as GPUTextureView[]).push(...entry.coverage.productTextures.map(texture => texture.createView({ dimension: "2d-array" })));
        Object.freeze(entry.coverage.productViews);
      }
      this.constants = this.upload(device, command, "constants", constantData);
      this.routes = this.upload(device, command, "routes", routeData);
      this.directory = this.upload(device, command, "directory", directoryData);
      this.fields = this.upload(device, command, "fields", fieldData);
      this.runtimeInputs = this.upload(device, command, "runtime-inputs", inputData);
      this.materialLookup = this.upload(device, command, "surface-material-lookup", materialLookupData);
      this.surfaceIdentity = this.upload(device, command, "surface-publication-identity", identityData);
      const coverageDirectoryData = new Uint32Array((maxMaterialSlot + 1) * COVERAGE_DIRECTORY_STRIDE / 4);
      if (coverageDirectoryData.byteLength > maximum) throw new RangeError("Coverage directory exceeds negotiated storage limit");
      entries.forEach(entry => coverageDirectoryData.set([entry.coverage.constantBase, entry.coverage.routeBase, entry.coverage.inputBase, entry.coverage.rasterProgram], entry.materialSlot * 4));
      this.coverageDirectory = this.upload(device, command, "coverage-directory", coverageDirectoryData);
      if (!cacheOwner) throw new Error("Appearance publication requires the shared cache owner");
      this.cache = cacheOwner.prepare(descriptors.map((_descriptor, index) => entries.find(entry => entry.programIndex === index)!.cachePlan));
      this.constantValues = constantData; this.inputValues = inputData; this.fieldWords = fieldData;
      this.fieldDependencies = fieldDependencies;
       this.entries = Object.freeze(entries);
       this.leases = Object.freeze(leaseList);
       this.surfaceProgramCount = surfaceDescriptors.length;
       this.surfaceMaxInputVectors = Math.max(1, ...surfaceKernels.map(kernel => kernel.inputVectorCount));
       this.surfaceMaxOutputs = Math.max(1, ...surfaceKernels.map(kernel => kernel.lowered.outputCount));
       this.allocatedBytes = this.buffers.reduce((bytes, buffer) => bytes + buffer.size, 0);
      let cancel!: (reason: Error) => void;
      const cancellation = new Promise<never>((_resolve, reject) => { cancel = reject; });
      this.cancelReadiness = cancel;
       this.ready = Promise.race([cancellation, Promise.all([
         Promise.all(leaseList.map(lease => lease.ready)),
         Promise.all(this.surfaceLeases.map(lease => lease.ready)),
         Promise.all(this.cacheStageLeases.map(leases => Promise.all(leases.map(lease => lease.ready)))),
         Promise.all(this.coordinateLeases.map(lease => lease.ready))
       ]).then(([pipelines, surfacePipelines]) => {
         if (this.state !== "staging") throw new Error("Appearance publication cancelled before program readiness");
         this.pipelines = Object.freeze(pipelines);
         this.surfacePipelines = Object.freeze(surfacePipelines);
         this.state = "ready";
      })]);
      void this.ready.catch(() => undefined);
      command.onBeforeFinish.addOne(() => {
        if (this.state !== "ready") throw new Error("Appearance programs must be ready before scene submission");
      });
      command.onFinished.addOne(() => { if (this.state === "ready") this.state = "resident"; });
      command.onAborted.addOne(() => this.destroy());
      this.unwatchRegistry = registry.onStopped(() => this.destroy());
    } catch (error) {
      for (const lease of leaseList) lease.release();
      for (const lease of this.surfaceLeases) lease.release();
      for (const lease of this.coordinateLeases) lease.release();
      for (const leases of this.cacheStageLeases) for (const lease of leases) lease.release();
      for (const lease of this.staticLeases) lease.release();
      for (const buffer of this.buffers) buffer.destroy();
      if (this.cache) this.cacheOwner?.release(this.cache);
      for (const handle of this.accountingHandles) accounting?.destroyed(handle);
      throw error;
    }
  }

  program(index: number): Awaited<AppearanceProgramLease["ready"]> {
    if (this.state !== "ready" && this.state !== "resident") throw new Error("Appearance publication is not consumable");
    const value = this.pipelines?.[index];
    if (value === undefined) throw new RangeError("Appearance program index is outside this publication");
    return value;
  }

  /** Encode edits into the main frame transaction. Only affected field versions
   * advance; abort leaves CPU authority unchanged so the upload is retried. */
  syncRuntime(command: ShadeGPUCommandContext): boolean {
    if (command.device !== this.device || command.closed || (this.state !== "ready" && this.state !== "resident")) throw new Error("Appearance edits require an open resident frame");
    const constants = this.constantValues.slice(), inputs = this.inputValues.slice();
    const parameters = new Map<StandardShadeMaterial, ReadonlyMap<string, number>>();
    for (const entry of [...this.entries, ...this.entries.map(entry => entry.coverage)]) {
      if ("cutoffSlot" in entry) {
        if (!Number.isFinite(Math.fround(entry.material.alpha_cutoff))) throw new RangeError("Coverage cutoff must be finite f32");
        constants[entry.cutoffSlot] = Math.max(0,Math.min(1,entry.material.alpha_cutoff));
      }
      let values = parameters.get(entry.material);
      if (!values) { values = standardAppearanceParameters(entry.material); parameters.set(entry.material, values); }
      for (const [name, slots] of Object.entries(entry.kernel.lowered.parameterSlots)) {
        const authored = entry.material.appearance_inputs.get(name);
        for (const slot of slots) {
          const value = authored?.[slot.channel] ?? values.get(name) ?? constants[entry.constantBase + slot.slot]!;
          if (!Number.isFinite(Math.fround(value))) throw new RangeError(`Appearance parameter '${name}' is not finite f32`);
          constants[entry.constantBase + slot.slot] = value;
        }
      }
      entry.program.inputs.forEach((input, index) => {
        if (appearanceGeometryInputKind(input,entry.program)!==0) return;
        const value = entry.material.appearance_inputs.get(input.name);
        if (value?.length !== input.width) throw new RangeError(`Appearance input '${input.name}' width changed`);
        inputs.set(value, (entry.inputBase + index) * 4);
      });
    }
    const changed = new Set<number>();
    for (let i = 0; i < constants.length; i++) if (!Object.is(constants[i], this.constantValues[i])) changed.add(i);
    for (let i = 0; i < inputs.length; i++) if (!Object.is(inputs[i], this.inputValues[i])) changed.add(-1 - i);
    const coverageChanged = this.entries.some(({coverage}) => {
      if (coverage.material.transparency_mode !== ShadeTransparencyMode.AlphaTested) return false;
      if (changed.has(coverage.cutoffSlot)) return true;
      for (let slot = 0; slot < coverage.kernel.lowered.constants.length; slot++) if (changed.has(coverage.constantBase + slot)) return true;
      for (let slot = 0; slot < coverage.program.inputs.length * 4; slot++) if (changed.has(-1 - coverage.inputBase * 4 - slot)) return true;
      return false;
    });
    if (changed.size === 0) return false;
    const fields = this.fieldWords.slice();
    this.fieldDependencies.forEach((dependencies, field) => {
      if (!dependencies.some(ref => changed.has(ref))) return;
      const word = field * 4;
      if (fields[word] === 0xffffffff) throw new RangeError("Appearance field version exhausted; republish the scene");
      fields[word] = fields[word]! + 1;
    });
    for (const [buffer, data] of [[this.constants, constants], [this.runtimeInputs, inputs], [this.fields, fields]] as const) {
      command.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
    }
    command.onFinished.addOne(() => { this.constantValues = constants; this.inputValues = inputs; this.fieldWords = fields; });
    return coverageChanged;
  }

  get viewDependentCoverage(): boolean {
    return this.entries.some(entry => entry.coverage.viewDependent && entry.material.transparency_mode === ShadeTransparencyMode.AlphaTested);
  }

  /** Encode the exact compiled publication kernels for compact Surface misses. */
  encodeSurfaceMissEvaluation(command: ShadeGPUCommandContext, input: {
    readonly geometry: GPUBuffer;
    readonly work: GPUBuffer;
    readonly misses: GPUBuffer;
    readonly hitMask: GPUBuffer;
    readonly counters: GPUBuffer;
    readonly fieldVersions: GPUBuffer;
    readonly residencyVersions: GPUBuffer;
    readonly fields: GPUTextureView;
    readonly cache: GPUBuffer;
    readonly cacheValues: GPUBuffer;
    readonly indirect: GPUBuffer;
    readonly width: number;
    readonly height: number;
    readonly recordCount: number;
    readonly cacheCapacity: number;
    readonly sampleOffset: number;
    readonly textureBanks: readonly (readonly GPUTextureView[])[];
  }): void {
    if (command.device !== this.device || command.closed || (this.state !== "ready" && this.state !== "resident")) {
      throw new Error("Surface appearance evaluation requires an open resident frame");
    }
    const pipelines = this.surfacePipelines;
    if (!pipelines || pipelines.length !== this.surfaceProgramCount) throw new Error("Surface publication kernels are not ready");
    const dummy = command.allocateTransientBuffer(GPUBufferUsage.STORAGE, 16);
    const taskProgram = command.allocateTransientBuffer(GPUBufferUsage.STORAGE, 16);
    const taskExtent = command.allocateTransientBuffer(GPUBufferUsage.STORAGE, 32);
    const dispatch = command.allocateTransientBuffer(GPUBufferUsage.UNIFORM, 16);
    const settings = command.allocateTransientBuffer(GPUBufferUsage.UNIFORM, 32);
    for (let programIndex = 0; programIndex < pipelines.length; programIndex++) {
      const entry = this.entries.find(candidate => candidate.programIndex === programIndex);
      if (!entry) continue;
      command.writeBuffer(settings, 0, new Uint32Array([
        input.width, input.height, input.recordCount, programIndex,
        input.cacheCapacity, 0, 0, input.sampleOffset
      ]).buffer, 0, 32);
      command.writeBuffer(dispatch, 0, new Uint32Array([0, programIndex, 0, 0]).buffer, 0, 16);
      const ready = pipelines[programIndex]!;
      const group0 = this.device.createBindGroup({ layout: ready.layouts[0]!, entries: [
        { binding: 0, resource: { buffer: this.constants } }, { binding: 1, resource: { buffer: this.routes } },
        { binding: 2, resource: { buffer: dummy } }, { binding: 3, resource: { buffer: dummy } },
        { binding: 4, resource: { buffer: dummy } }, { binding: 5, resource: { buffer: dispatch } },
        { binding: 11, resource: { buffer: taskProgram } }, { binding: 12, resource: { buffer: taskExtent } },
        { binding: 13, resource: { buffer: input.geometry } }, { binding: 14, resource: { buffer: input.misses } },
        { binding: 15, resource: { buffer: input.hitMask } }, { binding: 16, resource: { buffer: this.materialLookup } },
        { binding: 17, resource: { buffer: this.directory } }, { binding: 18, resource: input.fields },
        { binding: 19, resource: { buffer: settings } }, { binding: 20, resource: { buffer: input.cache } },
        { binding: 21, resource: { buffer: input.cacheValues } }, { binding: 22, resource: { buffer: this.surfaceIdentity } },
        { binding: 23, resource: { buffer: input.counters } },
        { binding: 24, resource: { buffer: input.fieldVersions } },
        { binding: 25, resource: { buffer: input.residencyVersions } },
        { binding: 26, resource: { buffer: this.runtimeInputs } }
        ,{ binding: 27, resource: { buffer: input.work } }
      ] });
      const groups: GPUBindGroup[] = [group0];
      const textureLayout = ready.layouts[1];
      const textureDescriptors = entry.kernel.descriptor.groups[1] ?? [];
      if (textureLayout) {
        const textureEntries: GPUBindGroupEntry[] = [];
        const banks = input.textureBanks[entry.textureBindingSetId] ?? [];
        for (const descriptor of textureDescriptors) {
          if (descriptor.texture) {
            const view = banks[descriptor.binding];
            if (!view) throw new Error(`Surface texture bank ${entry.textureBindingSetId}:${descriptor.binding} is missing`);
            textureEntries.push({ binding: descriptor.binding, resource: view });
          } else if (descriptor.sampler) {
            const samplerIndex = descriptor.binding - 9;
            const addressMode = (["clamp-to-edge", "mirror-repeat", "repeat"] as const)[samplerIndex % 3]!;
            const filter = samplerIndex < 3 ? "linear" : "nearest";
            textureEntries.push({ binding: descriptor.binding, resource: this.device.createSampler({
              minFilter: filter, magFilter: filter, mipmapFilter: filter,
              addressModeU: addressMode, addressModeV: addressMode
            }) });
          }
        }
        groups.push(this.device.createBindGroup({ layout: textureLayout, entries: textureEntries }));
      }
      const productLayout = ready.layouts[2];
      if (productLayout) {
        const productEntries: GPUBindGroupEntry[] = entry.productTextures.map((texture, binding) => ({
          binding, resource: texture.createView({ dimension: "2d-array" })
        }));
        if (entry.productTextures.length > 0) productEntries.push({ binding: entry.productTextures.length,
          resource: this.device.createSampler({ minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }) });
        groups.push(this.device.createBindGroup({ layout: productLayout, entries: productEntries }));
      }
      const pass = command.beginComputePass({ label: `Surface/material publication kernel ${programIndex}` });
      pass.setPipeline(ready.pipeline); groups.forEach((group, index) => pass.setBindGroup(index, group));
      pass.dispatchWorkgroupsIndirect(input.indirect, 16 + programIndex * 32);
      pass.end();
    }
  }

  /*
  encodeDemand(command: ShadeGPUCommandContext, input: {
    readonly visibility: GPUTextureView;
    readonly meshletWork: GPUBuffer;
    readonly geometry: GPUBuffer;
    readonly attributes: GPUBuffer;
    readonly frameInstances: GPUBuffer;
    readonly camera: GPUBuffer;
    readonly vertexPayload: GPUBuffer;
    readonly source: GpuSparseShadingAssetHeapBindings;
    readonly productMetadata?: GPUBuffer;
    readonly productBanks?: readonly GPUBuffer[];
    readonly frameHeaderWord: number;
    readonly frameDirectoryWord: number;
    readonly textureBanks: readonly (readonly GPUTextureView[])[];
    readonly width: number;
    readonly height: number;
    readonly fields: GPUTextureView;
    readonly frame: number;
  }): void {
    if (command.device !== this.device || command.closed || (this.state !== "ready" && this.state !== "resident")) {
      throw new Error("Appearance demand requires an open resident frame");
    }
    if (input.width < 1 || input.height < 1 || input.width * input.height > this.maxFramePixels) {
      throw new RangeError("Appearance demand extent exceeds the negotiated frame pixel budget");
    }
    // Extent-derived stripes guarantee enough space even when every pixel is
    // visible. They use the same compiled programs and publication protocol;
    // no GPU count is read by the CPU and all stripes remain in this encoder.
    const rowsPerStripe = Math.floor(this.maxFrameTasks / input.width);
    if (rowsPerStripe < 1) throw new RangeError("Appearance task capacity cannot cover one render row");
    command.gpu_encoder.clearBuffer(this.frameControl);
    for (let row = 0; row < input.height; row += rowsPerStripe) {
      const rowCount = Math.min(rowsPerStripe, input.height - row);
      const demand = this.demandPipeline;
      const finalize = this.demandFinalizePipeline;
      const resolve = this.resolvePipeline;
      const makeUniform = (data: Uint32Array): GPUBuffer => command.allocateTransientBufferAndLoad(data.buffer as ArrayBuffer, GPUBufferUsage.UNIFORM);
      command.gpu_encoder.clearBuffer(this.frameControl, 0, 4);
      if (this.leases.length) command.gpu_encoder.clearBuffer(this.frameControl, 16);
      command.gpu_encoder.clearBuffer(this.frameIndirect);
      const settings = new Uint32Array([input.width, input.height, this.maxFrameTasks, this.maxFrameInputs, this.maxFrameOutputs, input.frame, row, rowCount,
        input.frameHeaderWord, input.frameDirectoryWord, this.leases.length, 0]);
      command.writeBuffer(this.frameSettings, 0, settings.buffer as ArrayBuffer, 0, settings.byteLength);
      const demandGroup = this.device.createBindGroup({ layout: this.demandLayout, entries: [
        { binding: 0, resource: input.visibility }, { binding: 1, resource: { buffer: input.meshletWork } },
        { binding: 2, resource: { buffer: this.materialLookup } }, { binding: 3, resource: { buffer: this.directory } },
        { binding: 4, resource: { buffer: this.runtimeInputs } }, { binding: 5, resource: { buffer: this.frameTasks } },
        { binding: 6, resource: { buffer: this.frameInputs } }, { binding: 7, resource: { buffer: this.framePrograms } },
        { binding: 8, resource: { buffer: this.framePixels } }, { binding: 9, resource: { buffer: this.frameControl } },
        { binding: 10, resource: { buffer: this.frameIndirect } }, { binding: 11, resource: { buffer: this.frameMetadata } },
        { binding: 13, resource: { buffer: this.frameSettings } }
      ] });
      const pass = command.gpu_encoder.beginComputePass({ label: "Appearance GPU demand" });
      pass.setPipeline(demand); pass.setBindGroup(0, demandGroup);
      pass.dispatchWorkgroups(Math.ceil(input.width / 8), Math.ceil(rowCount / 8));
      pass.setPipeline(finalize); pass.dispatchWorkgroups(1); pass.end();
      const programCount = makeUniform(new Uint32Array([this.leases.length, 0, 0, 0]));
      const scatterPass = command.gpu_encoder.beginComputePass({ label: "Appearance task scatter" });
      scatterPass.setPipeline(this.scatterPipeline);
      scatterPass.setBindGroup(0, this.device.createBindGroup({ layout: this.scatterLayout, entries: [
        ...[this.frameTasks, this.frameMetadata, this.frameIndirect, this.frameControl, this.frameOrderedTasks,
          this.framePrograms, this.frameTaskMetadata, this.framePixels].map((buffer, binding) => ({ binding, resource: { buffer } })),
        { binding: 8, resource: { buffer: programCount } }
      ] }));
      scatterPass.dispatchWorkgroupsIndirect(this.frameIndirect, 0); scatterPass.end();

      const product = input.productMetadata !== undefined;
      if (product && input.productBanks?.length !== 4) throw new Error("Surface Product source requires four actual resident banks");
      const source = input.source;
      const geometrySettings = makeUniform(new Uint32Array([
        input.width, input.height, input.frame, 0, input.frameHeaderWord, input.frameDirectoryWord, 0, 0,
        source.geometryWordBase, source.meshletWordBase, source.meshletVertexWordBase, source.meshletTriangleWordBase,
        source.vertexDataWordBase, 0, 0, 0
      ]));
      const geometryBuffers = [this.frameOrderedTasks, this.frameTaskMetadata, this.frameInputs, this.constants,
        this.frameIndirect, input.meshletWork, input.geometry, input.attributes, input.frameInstances, input.vertexPayload,
        ...(product ? [input.productMetadata!, ...input.productBanks!] : [])];
      const geometryPass = command.gpu_encoder.beginComputePass({ label: "Appearance real geometry inputs" });
      geometryPass.setPipeline(this.geometryPipelines[Number(product)]!);
      geometryPass.setBindGroup(0, this.device.createBindGroup({ layout: this.geometryLayouts[Number(product)]!, entries: [
        { binding: 0, resource: { buffer: geometrySettings } }, { binding: 1, resource: input.visibility },
        ...geometryBuffers.map((buffer, index) => ({ binding: index + 2, resource: { buffer } })),
        { binding: 18, resource: { buffer: input.camera } }
      ] }));
      geometryPass.dispatchWorkgroupsIndirect(this.frameIndirect, 0); geometryPass.end();
      for (let programIndex = 0; programIndex < this.leases.length; programIndex++) {
        const lease = this.program(programIndex), entry = this.entries.find(candidate => candidate.programIndex === programIndex);
        if (!entry) continue;
        const layout = lease.layouts[0]!;
        const cacheCells = this.cache.programs[programIndex];
        const dispatch = makeUniform(cacheCells
          ? new Uint32Array([this.maxFrameTasks, programIndex, input.frame, this.cache.maxAge])
          : new Uint32Array([this.maxFrameTasks, programIndex, programIndex, input.frame]));
        const common: GPUBindGroupEntry[] = [
          { binding: 0, resource: { buffer: this.constants } }, { binding: 1, resource: { buffer: this.routes } },
          { binding: 2, resource: { buffer: this.frameOrderedTasks } }, { binding: 3, resource: { buffer: this.frameInputs } },
          { binding: 4, resource: { buffer: this.frameOutputs } }, { binding: 5, resource: { buffer: dispatch } },
          { binding: 11, resource: { buffer: this.framePrograms } },
          ...(cacheCells ? [
            { binding: 6, resource: { buffer: cacheCells } }, { binding: 7, resource: { buffer: this.frameCacheRequests } },
            { binding: 8, resource: { buffer: this.fields } }, { binding: 9, resource: { buffer: this.frameIndirect } },
            { binding: 10, resource: { buffer: this.frameTaskMetadata } }
          ] : [{ binding: 12, resource: { buffer: this.frameIndirect } }])
        ];
        const programGroup = this.device.createBindGroup({ layout, entries: common });
        const textures = entry.kernel.descriptor.groups[1];
        const textureEntries: GPUBindGroupEntry[] = [];
        for (const descriptor of textures ?? []) {
          if (descriptor.texture) textureEntries.push({ binding: descriptor.binding, resource: input.textureBanks[entry.textureBindingSetId]![descriptor.binding]! });
          else if (descriptor.sampler) {
            const samplerIndex = descriptor.binding - 9;
            const addressMode = (["clamp-to-edge", "mirror-repeat", "repeat"] as const)[samplerIndex % 3]!;
            const filter = samplerIndex < 3 ? "linear" : "nearest";
            textureEntries.push({ binding: descriptor.binding, resource: this.device.createSampler({
              minFilter: filter, magFilter: filter, mipmapFilter: filter, addressModeU: addressMode, addressModeV: addressMode
            }) });
          }
        }
        const groups: GPUBindGroup[] = [programGroup];
        if (lease.layouts[1]) groups.push(this.device.createBindGroup({ layout: lease.layouts[1], entries: textureEntries }));
        if (lease.layouts[2]) {
          const productEntries: GPUBindGroupEntry[] = entry.productTextures.map((texture, binding) => ({ binding, resource: texture.createView({ dimension: "2d-array" }) }));
          productEntries.push({ binding: entry.productTextures.length, resource: this.device.createSampler({ minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }) });
          groups.push(this.device.createBindGroup({ layout: lease.layouts[2], entries: productEntries }));
        }
        const encodeProgram = (pipeline: GPUComputePipeline, label: string, cells = false) => {
          const programPass = command.gpu_encoder.beginComputePass({ label: `Appearance/${label} program ${programIndex}` });
          programPass.setPipeline(pipeline); groups.forEach((group, index) => programPass.setBindGroup(index, group));
          if (cells) programPass.dispatchWorkgroups(Math.ceil(Math.max(...entry.cachePlan.fields.map(field => field.cells)) / 64));
          else programPass.dispatchWorkgroupsIndirect(this.frameIndirect, 16 + programIndex * 32);
          programPass.end();
        };
        if (cacheCells) {
          if (entry.program.samples.length || entry.kernel.productTextureCount) encodeProgram(this.coordinatePipelines[programIndex]!.pipeline, "coordinate footprints");
          const stages = this.cacheStagePipelines[programIndex]!;
          encodeProgram(stages[0]!.pipeline, "cache reset", true);
          encodeProgram(stages[1]!.pipeline, "cache request");
          encodeProgram(stages[2]!.pipeline, "cache nominate");
          encodeProgram(stages[3]!.pipeline, "cache publish", true);
          encodeProgram(lease.pipeline, "cache evaluate");
          encodeProgram(stages[4]!.pipeline, "cache consume");
        } else {
          if (entry.program.samples.length || entry.kernel.productTextureCount) encodeProgram(this.coordinatePipelines[programIndex]!.pipeline, "coordinate footprints");
          encodeProgram(lease.pipeline, "evaluate");
        }
      }
      const resolveSize = makeUniform(new Uint32Array([input.width, input.height, APPEARANCE_SURFACE_LAYER_COUNT, this.maxFrameOutputs, row, rowCount, 0, 0]));
      const resolveGroup = this.device.createBindGroup({ layout: this.resolveLayout, entries: [
        { binding: 0, resource: { buffer: this.frameOrderedTasks } }, { binding: 1, resource: { buffer: this.framePrograms } },
        { binding: 2, resource: { buffer: this.framePixels } }, { binding: 3, resource: { buffer: this.frameOutputs } },
        { binding: 4, resource: input.fields }, { binding: 5, resource: { buffer: resolveSize } },
        { binding: 6, resource: { buffer: this.frameFieldSlots } }
      ] });
      const resolvePass = command.gpu_encoder.beginComputePass({ label: "Appearance field publication" });
      resolvePass.setPipeline(resolve); resolvePass.setBindGroup(0, resolveGroup);
      resolvePass.dispatchWorkgroups(Math.ceil(input.width / 8), Math.ceil(rowCount / 8)); resolvePass.end();
      }
  }
  */

  evidence(): Readonly<{ allocatedBytes: number; residentBytes: number; retiringBytes: number; stagingBytes: number }> {
    const bytes = this.state === "destroyed" ? 0 : this.allocatedBytes;
    return Object.freeze({ allocatedBytes: bytes,
      residentBytes: this.state === "resident" ? bytes : 0,
      retiringBytes: this.state === "retiring" ? bytes : 0,
      stagingBytes: this.state === "staging" || this.state === "ready" ? bytes : 0 });
  }

  onDestroyed(callback: () => void): void {
    if (this.state === "destroyed") callback(); else this.destroyedListeners.add(callback);
  }

  /** Abort preserves the old publication; committed release retires after GPU completion. */
  release(command: ShadeGPUCommandContext): void {
    if (this.state !== "resident" || this.releasing !== null || command.closed || command.device !== this.device) {
      throw new Error("Appearance release requires one open resident transaction on its GPUDevice");
    }
    this.releasing = command;
    command.onAborted.addOne(() => { this.releasing = null; });
    command.onFinished.addOne(() => {
      this.state = "retiring";
      void command.gpuDone.then(() => this.destroy(), () => this.destroy());
    });
  }

  destroy(): void {
    if (this.state === "destroyed") return;
    this.state = "destroyed";
    this.unwatchRegistry?.();
    this.unwatchRegistry = null;
    this.cancelReadiness(new Error("Appearance publication cancelled or destroyed"));
    this.pipelines = null;
    this.surfacePipelines = null;
    for (const buffer of this.buffers) buffer.destroy();
    if (this.cache) this.cacheOwner?.release(this.cache);
    for (const handle of this.accountingHandles) this.accounting?.destroyed(handle);
    for (const lease of this.leases) lease.release();
    for (const lease of this.surfaceLeases) lease.release();
    for (const lease of this.coordinateLeases) lease.release();
    for (const leases of this.cacheStageLeases) for (const lease of leases) lease.release();
    for (const lease of this.staticLeases) lease.release();
    for (const callback of this.destroyedListeners) callback();
    this.destroyedListeners.clear();
  }

  private upload(device: GPUDevice, command: ShadeGPUCommandContext, name: string, data: Float32Array | Uint8Array | Uint32Array): GPUBuffer {
    const label = `GpuAppearancePublication/${name}`;
    const buffer = device.createBuffer({ label, size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.buffers.push(buffer);
    if (this.accounting !== undefined) this.accountingHandles.push(this.accounting.created({
      kind: "buffer", category: "resident", owner: "GpuAppearancePublication", label, bytes: data.byteLength }));
    command.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    return buffer;
  }
}

function packProductRoute(asset: AppearanceAssetPackage, layer: number): ArrayBuffer {
  const data = new ArrayBuffer(APPEARANCE_ROUTE_STRIDE), view = new DataView(data);
  view.setUint32(0, layer, true);
  const mapping = [...asset.domainMin, ...asset.domainMax.map((max, axis) => 1 / (max - asset.domainMin[axis]!))];
  if (!mapping.every(value => Number.isFinite(Math.fround(value)))) throw new RangeError("Appearance product coordinate mapping exceeds f32 publication range");
  mapping
    .forEach((value, index) => view.setFloat32(16 + index * 4, value, true));
  return data;
}

function packRoute(binding: CompiledAppearanceGraph["samples"][number]["binding"], ref: number,
  mipRange: readonly [number, number] | undefined, publication: TextureSurfacePublication | undefined): ArrayBuffer {
  // Sampling author state is the compilation snapshot, not a later mutable texture.
  const samplerSnapshot = { wrapS: binding.sampler[4], wrapT: binding.sampler[5],
    minFilter: binding.sampler[1], magFilter: binding.sampler[2],
    runtime_asset_package_v2: binding.texture.runtime_asset_package_v2 } as ShadeTexture;
  const sampler = encodeSamplerClass(samplerSnapshot, mipRange);
  const data = new ArrayBuffer(APPEARANCE_ROUTE_STRIDE);
  const view = new DataView(data);
  [ref, sampler.value, publication?.slot ?? 0, publication?.revision ?? 0]
    .forEach((value, index) => view.setUint32(index * 4, value, true));
  const values = [...binding.offset, ...binding.scale, Math.cos(binding.rotation), Math.sin(binding.rotation), 0, 0,
    ...binding.fallback];
  values.forEach((value, index) => view.setFloat32(16 + index * 4, value, true));
  return data;
}
