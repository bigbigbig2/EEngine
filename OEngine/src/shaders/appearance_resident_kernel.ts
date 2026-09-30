import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import type { AppearanceProgramDescriptor } from "../gpu/AppearanceProgramRegistry.js";
import { lowerAppearanceWgsl, type AppearanceWgslProgram } from "./appearance_program.js";
import { GPU_TEXTURE_REF_WGSL, GPU_TEXTURE_BANK_ALL_MASK, GPU_TEXTURE_CLAMPED_SAMPLE_WGSL } from "../gpu/GpuTextureRefAbi.js";
import { GPU_MATERIAL_VISIBILITY_SAMPLER as S } from "../gpu/GpuMaterialVisibilityAbi.js";

export const APPEARANCE_ROUTE_STRIDE = 64;
export const APPEARANCE_TASK_STRIDE = 16;
export const APPEARANCE_WORKGROUP_SIZE = 64;

export interface AppearanceResidentKernel {
  readonly descriptor: AppearanceProgramDescriptor;
  readonly lowered: AppearanceWgslProgram;
  /** vec4 values followed by two explicit untransformed UV gradients per live sample. */
  readonly inputVectorCount: number;
  readonly bankMask: number;
}

export interface AppearanceSampleResourceProfile {
  readonly bank: number;
  /** Index in clamp/mirror/repeat linear then clamp/mirror/repeat nearest. */
  readonly sampler: number;
}

/**
 * Deterministic resource/ABI integration of the compiled numeric program.
 * Tasks of one topology may reference different material constant/route offsets;
 * no per-material dispatch or role loop is required. The demand producer owns
 * task/footprint validity and capacity. No atomics, barriers or hidden reads.
 * Resident banks are already decoded by TextureResidency, including linear
 * RGB/sRGB RGB and independently linear alpha. Do not decode these samples twice.
 */
export function appearanceResidentKernel(program: CompiledAppearanceGraph,
  resources: readonly AppearanceSampleResourceProfile[]): AppearanceResidentKernel {
  if (resources.length !== program.samples.length || resources.some(resource =>
    !Number.isInteger(resource.bank) || resource.bank < 0 || resource.bank >= 9 ||
    !Number.isInteger(resource.sampler) || resource.sampler < 0 || resource.sampler >= 6)) {
    throw new RangeError("Appearance resource profile does not match the live sampling program");
  }
  const bankMask = resources.reduce((mask, resource) => mask | (1 << resource.bank), 0) & GPU_TEXTURE_BANK_ALL_MASK;
  const samplerMask = resources.reduce((mask, resource) => mask | (1 << resource.sampler), 0);
  const lowered = lowerAppearanceWgsl(program);
  const visibility = GPUShaderStage.COMPUTE;
  const group: GPUBindGroupLayoutEntry[] = [
    { binding: 0, visibility, buffer: { type: "read-only-storage", minBindingSize: 4 } },
    { binding: 1, visibility, buffer: { type: "read-only-storage", minBindingSize: APPEARANCE_ROUTE_STRIDE } },
    { binding: 2, visibility, buffer: { type: "read-only-storage", minBindingSize: APPEARANCE_TASK_STRIDE } },
    { binding: 3, visibility, buffer: { type: "read-only-storage", minBindingSize: 16 } },
    { binding: 4, visibility, buffer: { type: "storage", minBindingSize: 4 } },
    { binding: 5, visibility, buffer: { type: "uniform", minBindingSize: 16 } }
  ];
  const textures: GPUBindGroupLayoutEntry[] = [];
  const declarations: string[] = [];
  for (let bank = 0; bank < 9; bank++) if ((bankMask & (1 << bank)) !== 0) {
    textures.push({ binding: bank, visibility, texture: { sampleType: "float", viewDimension: "2d-array" } });
    declarations.push(`@group(1) @binding(${bank}) var oengine_texture_bank_${bank}: texture_2d_array<f32>;`);
  }
  const samplerNames = ["clamp_linear", "mirror_linear", "repeat_linear", "clamp_nearest", "mirror_nearest", "repeat_nearest"];
  samplerNames.forEach((name, index) => {
    if ((samplerMask & (1 << index)) === 0) return;
    textures.push({ binding: 9 + index, visibility, sampler: { type: "filtering" } });
    declarations.push(`@group(1) @binding(${9 + index}) var sampler_${name}: sampler;`);
  });
  const sampling = bankMask === 0 ? "" : `
${declarations.join("\n")}
${GPU_TEXTURE_REF_WGSL}
const OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK: u32 = ${S.AddressMask}u;
const OENGINE_MATERIAL_SAMPLER_LINEAR: u32 = ${S.LinearBit}u;
const OENGINE_MATERIAL_SAMPLER_MIP_MASK: u32 = ${S.MipMask}u;
const OENGINE_MATERIAL_SAMPLER_MIP_SHIFT: u32 = ${S.MipShift}u;
const OENGINE_MATERIAL_SAMPLER_FULL_MIP_CODE: u32 = ${S.FullMipCode}u;
${GPU_TEXTURE_CLAMPED_SAMPLE_WGSL}
fn appearance_transform_uv(route: AppearanceRoute, uv: vec2f) -> vec2f {
  let scaled = uv * route.uv.zw;
  return vec2f(route.rotation.x * scaled.x - route.rotation.y * scaled.y,
    route.rotation.y * scaled.x + route.rotation.x * scaled.y);
}
${resources.map((resource, index) => `
fn appearance_sample_${index}(uv: vec2f) -> vec4f {
  let route = appearance_routes[appearance_task.y + ${index}u];
  if route.identity.x == OENGINE_TEXTURE_REF_INVALID { return route.fallback; }
  let gradient_base = appearance_task.z + ${program.inputs.length + index * 2}u;
  let dx = appearance_transform_uv(route, appearance_inputs[gradient_base].xy);
  let dy = appearance_transform_uv(route, appearance_inputs[gradient_base + 1u].xy);
  let value = oengine_sample_texture_clamped(oengine_texture_bank_${resource.bank}, sampler_${samplerNames[resource.sampler]},
    route.identity.x, route.identity.y, appearance_transform_uv(route, uv) + route.uv.xy,
    i32(oengine_texture_ref_layer(route.identity.x)), dx, dy);
  return oengine_texture_ref_apply_routing(route.identity.x, value);
}`).join("\n")}`;
  const source = `
struct AppearanceRoute { identity: vec4u, uv: vec4f, rotation: vec4f, fallback: vec4f }
@group(0) @binding(0) var<storage, read> appearance_constants: array<f32>;
@group(0) @binding(1) var<storage, read> appearance_routes: array<AppearanceRoute>;
@group(0) @binding(2) var<storage, read> appearance_tasks: array<vec4u>;
@group(0) @binding(3) var<storage, read> appearance_inputs: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> appearance_outputs: array<f32>;
@group(0) @binding(5) var<uniform> appearance_dispatch: vec4u;
var<private> appearance_task: vec4u;
fn appearance_constant(index: u32) -> f32 { return appearance_constants[appearance_task.x + index]; }
fn appearance_input(index: u32, channel: u32) -> f32 { return appearance_inputs[appearance_task.z + index][channel]; }
${sampling}
${lowered.source}
@compute @workgroup_size(${APPEARANCE_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= appearance_dispatch.x { return; }
  appearance_task = appearance_tasks[appearance_dispatch.y + id.x];
  let value = appearance_evaluate();
${Array.from({ length: lowered.outputCount }, (_, index) =>
    `  appearance_outputs[appearance_task.w + ${index}u] = value[${index}];`).join("\n")}
}
`;
  return Object.freeze({ descriptor: Object.freeze({ source, entryPoint: "main", workgroupSize: APPEARANCE_WORKGROUP_SIZE,
    groups: Object.freeze(textures.length === 0 ? [group] : [group, textures]) }),
    lowered, inputVectorCount: program.inputs.length + program.samples.length * 2, bankMask });
}
