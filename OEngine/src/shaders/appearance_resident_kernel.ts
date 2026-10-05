import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import type { AppearanceProgramDescriptor } from "../gpu/AppearanceProgramRegistry.js";
import { lowerAppearanceWgsl, type AppearanceWgslProgram } from "./appearance_program.js";
import {
  GPU_TEXTURE_REF_WGSL,
  GPU_TEXTURE_BANK_ALL_MASK,
  GPU_TEXTURE_CLAMPED_SAMPLE_WGSL,
} from "../gpu/GpuTextureRefAbi.js";
import { GPU_MATERIAL_VISIBILITY_SAMPLER as S } from "../gpu/GpuMaterialVisibilityAbi.js";
import { appearanceInputLayout, appearanceCoordinatePreparation } from "./appearance_demand_inputs.js";

export const APPEARANCE_ROUTE_STRIDE = 64;
export const APPEARANCE_TASK_STRIDE = 16;
export const APPEARANCE_WORKGROUP_SIZE = 64;

export interface AppearanceResidentKernel {
  readonly descriptor: AppearanceProgramDescriptor;
  readonly lowered: AppearanceWgslProgram;
  /** vec4 values followed by two explicit untransformed UV gradients per live sample. */
  readonly inputVectorCount: number;
  readonly bankMask: number;
  readonly productTextureCount: number;
}

export interface AppearanceSampleResourceProfile {
  readonly bank: number;
  /** Index in clamp/mirror/repeat linear then clamp/mirror/repeat nearest. */
  readonly sampler: number;
}

/** Final owners replace task scheduling and storage declarations while sharing
 * the compiler and exact resident sampling semantics. */
export interface AppearanceKernelIntegration {
  readonly entryPoint: string;
  readonly groups: readonly (readonly GPUBindGroupLayoutEntry[])[];
  readonly declarations: string;
  readonly entrySource: string;
  readonly outputBits?: Readonly<Record<string, number>>;
  /** Coverage executes the same compiled numeric and resident sampling program
   * in the fragment stage with invocation-private inputs. */
  readonly shaderStage?: GPUShaderStageFlags;
  readonly coordinateEntry?: boolean;
  readonly sharedTextureAbi?: boolean;
}

/**
 * Deterministic resource/ABI integration of the compiled numeric program.
 * Tasks of one topology may reference different material constant/route offsets;
 * no per-material dispatch or role loop is required. The demand producer owns
 * task/footprint validity and capacity. No atomics, barriers or hidden reads.
 * Resident banks are already decoded by TextureResidency, including linear
 * RGB/sRGB RGB and independently linear alpha. Do not decode these samples twice.
 */
export function appearanceResidentKernel(
  program: CompiledAppearanceGraph,
  resources: readonly AppearanceSampleResourceProfile[],
  productResources: readonly (number | null)[] = [],
  integration?: AppearanceKernelIntegration,
): AppearanceResidentKernel {
  if (
    resources.length !== program.samples.length ||
    resources.some(
      (resource) =>
        !Number.isInteger(resource.bank) ||
        resource.bank < 0 ||
        resource.bank >= 9 ||
        !Number.isInteger(resource.sampler) ||
        resource.sampler < 0 ||
        resource.sampler >= 6,
    )
  ) {
    throw new RangeError("Appearance resource profile does not match the live sampling program");
  }
  const reads = program.productReads ?? [],
    productBindings = new Set<number>();
  if (
    productResources.length !== reads.length ||
    productResources.some((binding, index) => {
      if (reads[index]!.field.constant !== undefined) return binding !== null;
      if (binding === null || !Number.isInteger(binding) || binding < 0) return true;
      productBindings.add(binding);
      return false;
    }) ||
    [...productBindings].some((binding) => binding >= productBindings.size)
  ) {
    throw new RangeError("Appearance product resources must be a dense texture-binding profile");
  }
  const bankMask =
    resources.reduce((mask, resource) => mask | (1 << resource.bank), 0) & GPU_TEXTURE_BANK_ALL_MASK;
  const samplerMask = resources.reduce((mask, resource) => mask | (1 << resource.sampler), 0);
  const lowered = lowerAppearanceWgsl(program, integration?.outputBits);
  const visibility = integration?.shaderStage ?? GPUShaderStage.COMPUTE;
  const group: GPUBindGroupLayoutEntry[] = [
    { binding: 0, visibility, buffer: { type: "read-only-storage", minBindingSize: 4 } },
    {
      binding: 1,
      visibility,
      buffer: { type: "read-only-storage", minBindingSize: APPEARANCE_ROUTE_STRIDE },
    },
    { binding: 2, visibility, buffer: { type: "read-only-storage", minBindingSize: APPEARANCE_TASK_STRIDE } },
    { binding: 3, visibility, buffer: { type: "storage", minBindingSize: 16 } },
    { binding: 4, visibility, buffer: { type: "storage", minBindingSize: 4 } },
    { binding: 5, visibility, buffer: { type: "uniform", minBindingSize: 16 } },
    { binding: 11, visibility, buffer: { type: "read-only-storage", minBindingSize: 4 } },
    { binding: 12, visibility, buffer: { type: "read-only-storage", minBindingSize: 16 } },
  ];
  const textures: GPUBindGroupLayoutEntry[] = [];
  const declarations: string[] = [];
  for (let bank = 0; bank < 9; bank++)
    if ((bankMask & (1 << bank)) !== 0) {
      textures.push({
        binding: bank,
        visibility,
        texture: { sampleType: "float", viewDimension: "2d-array" },
      });
      declarations.push(
        `@group(1) @binding(${bank}) var oengine_texture_bank_${bank}: texture_2d_array<f32>;`,
      );
    }
  const samplerNames = [
    "clamp_linear",
    "mirror_linear",
    "repeat_linear",
    "clamp_nearest",
    "mirror_nearest",
    "repeat_nearest",
  ];
  samplerNames.forEach((name, index) => {
    if ((samplerMask & (1 << index)) === 0) return;
    textures.push({ binding: 9 + index, visibility, sampler: { type: "filtering" } });
    declarations.push(`@group(1) @binding(${9 + index}) var sampler_${name}: sampler;`);
  });
  const sampling =
    bankMask === 0
      ? ""
      : `
${declarations.join("\n")}
${integration?.sharedTextureAbi ? "" : GPU_TEXTURE_REF_WGSL}
${
  integration?.sharedTextureAbi
    ? ""
    : `
const OENGINE_MATERIAL_SAMPLER_ADDRESS_MASK: u32 = ${S.AddressMask}u;
const OENGINE_MATERIAL_SAMPLER_LINEAR: u32 = ${S.LinearBit}u;
const OENGINE_MATERIAL_SAMPLER_MIP_MASK: u32 = ${S.MipMask}u;
const OENGINE_MATERIAL_SAMPLER_MIP_SHIFT: u32 = ${S.MipShift}u;
const OENGINE_MATERIAL_SAMPLER_FULL_MIP_CODE: u32 = ${S.FullMipCode}u;
`
}
${GPU_TEXTURE_CLAMPED_SAMPLE_WGSL}
fn appearance_transform_uv(route: AppearanceRoute, uv: vec2f) -> vec2f {
  let scaled = uv * route.uv.zw;
  return vec2f(route.rotation.x * scaled.x - route.rotation.y * scaled.y,
    route.rotation.y * scaled.x + route.rotation.x * scaled.y);
}
${resources
  .map(
    (resource, index) => `
fn appearance_sample_${index}(uv: vec2f) -> vec4f {
  let gradient_base = appearance_task.z + ${program.inputs.length + index * 2}u;
  return appearance_sample_${index}_footprint(uv,appearance_inputs[gradient_base].xy,appearance_inputs[gradient_base+1u].xy);
}
fn appearance_sample_${index}_footprint(uv: vec2f, source_dx: vec2f, source_dy: vec2f) -> vec4f {
  let route = appearance_routes[appearance_task.y + ${index}u];
  if route.identity.x == OENGINE_TEXTURE_REF_INVALID { return route.fallback; }
  let dx = appearance_transform_uv(route, source_dx);
  let dy = appearance_transform_uv(route, source_dy);
  let value = oengine_sample_texture_clamped(oengine_texture_bank_${resource.bank}, sampler_${samplerNames[resource.sampler]},
    route.identity.x, route.identity.y, appearance_transform_uv(route, uv) + route.uv.xy,
    i32(oengine_texture_ref_layer(route.identity.x)), dx, dy);
  return oengine_texture_ref_apply_routing(route.identity.x, value);
}`,
  )
  .join("\n")}`;
  const productGroup: GPUBindGroupLayoutEntry[] = [];
  const productDeclarations: string[] = [],
    productFunctions: string[] = [];
  const productSamplerBinding = productBindings.size;
  for (const binding of [...productBindings].sort((a, b) => a - b)) {
    productGroup.push({ binding, visibility, texture: { sampleType: "float", viewDimension: "2d-array" } });
    productDeclarations.push(
      `@group(2) @binding(${binding}) var appearance_product_texture_${binding}: texture_2d_array<f32>;`,
    );
  }
  if (productBindings.size > 0) {
    productGroup.push({ binding: productSamplerBinding, visibility, sampler: { type: "filtering" } });
    productDeclarations.push(
      `@group(2) @binding(${productSamplerBinding}) var appearance_product_sampler: sampler;`,
    );
  }
  let productRoute = 0;
  reads.forEach((read, index) => {
    if (read.field.constant !== undefined) return;
    const route = productRoute++;
    productFunctions.push(`
fn appearance_product_sample_${index}(uv: vec2f) -> vec4f {
  let gradient_base = appearance_task.z + ${program.inputs.length + (program.samples.length + route) * 2}u;
  return appearance_product_sample_${index}_footprint(uv,appearance_inputs[gradient_base].xy,appearance_inputs[gradient_base+1u].xy);
}
fn appearance_product_sample_${index}_footprint(uv: vec2f, source_dx: vec2f, source_dy: vec2f) -> vec4f {
  let route = appearance_routes[appearance_task.y + ${program.samples.length + route}u];
  let dx = source_dx * route.uv.zw;
  let dy = source_dy * route.uv.zw;
  return textureSampleGrad(appearance_product_texture_${productResources[index]}, appearance_product_sampler,
    (uv - route.uv.xy) * route.uv.zw, i32(route.identity.x), dx, dy);
}`);
  });
  const regularDeclarations = `
struct AppearanceRoute { identity: vec4u, uv: vec4f, rotation: vec4f, fallback: vec4f }
@group(0) @binding(0) var<storage, read> appearance_constants: array<f32>;
@group(0) @binding(1) var<storage, read> appearance_routes: array<AppearanceRoute>;
@group(0) @binding(2) var<storage, read> appearance_tasks: array<vec4u>;
@group(0) @binding(3) var<storage, read_write> appearance_inputs: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> appearance_outputs: array<f32>;
@group(0) @binding(5) var<uniform> appearance_dispatch: vec4u;
@group(0) @binding(11) var<storage, read> appearance_task_program: array<u32>;
@group(0) @binding(12) var<storage, read> appearance_task_extent: array<vec4u>;
var<private> appearance_task: vec4u;
fn appearance_constant(index: u32) -> f32 { return appearance_constants[appearance_task.x + index]; }
fn appearance_input(index: u32, channel: u32) -> f32 { return appearance_inputs[appearance_task.z + index][channel]; }
`;
  const regularEntry = `
@compute @workgroup_size(${APPEARANCE_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= appearance_task_extent[1u + appearance_dispatch.y * 2u].w { return; }
  let task = appearance_task_extent[2u + appearance_dispatch.y * 2u].y + id.x;
  appearance_task = appearance_tasks[task];
  let value = appearance_evaluate();
${Array.from(
  { length: lowered.outputCount },
  (_, index) => `  appearance_outputs[appearance_task.w + ${index}u] = value[${index}];`,
).join("\n")}
}
`;
  const coordinateEntry = /* wgsl */ `
@compute @workgroup_size(64)
fn prepare_coordinates(@builtin(global_invocation_id) id: vec3u) {
  ${
    integration
      ? `if id.x>=appearance_task_count() { return; }
  let task=appearance_task_index(id.x);`
      : `if id.x>=appearance_task_extent[1u+appearance_dispatch.y*2u].w { return; }
  let task=appearance_task_extent[2u+appearance_dispatch.y*2u].y+id.x;`
  }
  appearance_task=appearance_tasks[task];
  appearance_prepare_coordinates();
}
`;
  const source = `
${integration?.declarations ?? regularDeclarations}
${sampling}
${productDeclarations.join("\n")}
${productFunctions.join("\n")}
${lowered.source}
${appearanceCoordinatePreparation(program, lowered, integration?.outputBits)}
${integration?.coordinateEntry === false ? "" : coordinateEntry}
${integration?.entrySource ?? regularEntry}
`;
  const ownerGroups = integration?.groups ?? [group];
  const groups =
    productBindings.size > 0
      ? [...ownerGroups, textures, productGroup]
      : textures.length === 0
        ? [...ownerGroups]
        : [...ownerGroups, textures];
  return Object.freeze({
    descriptor: Object.freeze({
      source,
      entryPoint: integration?.entryPoint ?? "main",
      workgroupSize: APPEARANCE_WORKGROUP_SIZE,
      groups: Object.freeze(groups),
    }),
    lowered,
    inputVectorCount: appearanceInputLayout(program).vectors,
    bankMask,
    productTextureCount: productBindings.size,
  });
}
