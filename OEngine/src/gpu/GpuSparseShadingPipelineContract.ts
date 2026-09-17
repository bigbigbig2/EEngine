import {
  gpuSparseShadingBindingBudget,
  type GpuSparseShadingBindingBudgetRecord,
  type GpuSparseShadingBindingKind,
  type GpuSparseShadingConcreteBinding
} from "./GpuShadingBindingBudget.js";
import { GPU_SHADING_BIN_WGSL } from "./GpuShadingBinAbi.js";
import {
  encodeGpuShadingBinId,
  GPU_SHADING_PROGRAM,
  GPU_SHADING_PROGRAM_COUNT,
  shadingProgramUsesTextures
} from "./GpuShadingProgramAbi.js";
import type { GpuSparseShadingCapabilityRecord } from "./GpuSparseShadingCapability.js";
import { GPU_SPARSE_SHADING_VIEW_BYTES } from "./GpuSparseShadingFrameAbi.js";
import type { GpuShadingExecutionMode } from "./GpuShadingExecutionMode.js";
import { GPU_TEXTURE_BANK_ALL_MASK, GPU_TEXTURE_BANK_COUNT } from "./GpuTextureRefAbi.js";

export const GPU_SPARSE_SHADING_PIPELINE_SCHEMA_VERSION = 4;
export const GPU_SPARSE_SHADING_ENTRY_POINT = "shading_resolve";

export const GPU_SHADING_OUTPUT_DEPENDENCY = Object.freeze({
  ShadingSurfaceLite: 1 << 0,
  DiffuseSurfaceLite: 1 << 1,
  Velocity: 1 << 2,
  /** Lit receiver evaluates the prepared environment and DFG LUT in-kernel. */
  EnvironmentIBL: 1 << 3
} as const);
export const GPU_SHADING_OUTPUT_DEPENDENCY_VALID_MASK = (1 << 4) - 1;

type BindingResource =
  | Readonly<{ category: "buffer"; type: "uniform" | "read-only-storage" | "storage" }>
  | Readonly<{
      category: "texture";
      sampleType: "uint" | "depth" | "float";
      viewDimension: "2d" | "2d-array";
    }>
  | Readonly<{ category: "sampler"; type: "filtering" | "comparison" }>
  | Readonly<{
      category: "storage-texture";
      access: "write-only";
      format: "rgba16float" | "rgba16uint" | "rgba8unorm" | "rg32uint" | "rg16float";
    }>;

export interface GpuSparseShadingBindingDescriptor
  extends GpuSparseShadingConcreteBinding {
  readonly name: string;
  readonly visibility: "compute";
  readonly resource: BindingResource;
}

export interface GpuSparseShadingBindGroupDescriptor {
  readonly group: 0 | 1 | 2 | 3;
  readonly owner: "frame/bin/output" | "scene/geometry" | "material/TextureBindingSet" | "lighting";
  readonly bindings: readonly Readonly<GpuSparseShadingBindingDescriptor>[];
}

export interface GpuSparseShadingPipelineIdentityInput {
  readonly programId: number;
  readonly textureBindingSetId: number;
  readonly outputDependencyMask: number;
  /** Creation-time physical specialization; false omits every shadow binding and sample. */
  readonly shadowSamplingEnabled: boolean;
  /** Physical consumer ABI. Omitted only by legacy contract fixtures. */
  readonly executionMode?: GpuShadingExecutionMode;
  /** Product geometry consumers opt into metadata and page-bank bindings. */
  readonly virtualGeometry?: boolean;
  /** Static set-local bank signature; defaults to every bounded bank. */
  readonly textureBankMask?: number;
  readonly capability: Pick<GpuSparseShadingCapabilityRecord, "fingerprint" | "formatProfile">;
}

export interface GpuSparseShadingPipelineDescriptor {
  readonly schemaVersion: 4;
  readonly cacheKey: string;
  readonly label: string;
  readonly entryPoint: typeof GPU_SPARSE_SHADING_ENTRY_POINT;
  readonly programId: number;
  readonly textureBindingSetId: number;
  readonly binId: number;
  readonly outputDependencyMask: number;
  readonly shadowSamplingEnabled: boolean;
  readonly executionMode: GpuShadingExecutionMode;
  readonly virtualGeometry: boolean;
  readonly textureBankMask: number;
  readonly capabilityFingerprint: string;
  readonly formatProfile: string;
  readonly groups: readonly Readonly<GpuSparseShadingBindGroupDescriptor>[];
}

/**
 * Finds material TextureBindingSets that consume at least one physical bank.
 * Bank zero is not special: cooked routes may use any bounded bank alone.
 */
export function gpuSparseShadingTextureBindingSetIds(
  pipelines: readonly Pick<GpuSparseShadingPipelineDescriptor, "groups" | "textureBindingSetId">[]
): readonly number[] {
  return Object.freeze([...new Set(
    pipelines
      .filter((pipeline) => pipeline.groups.some((group) =>
        group.bindings.some((binding) => binding.name.startsWith("material_texture_"))))
      .map((pipeline) => pipeline.textureBindingSetId)
  )].sort((left, right) => left - right));
}

const FRAME_OWNER = "frame/bin/output" as const;
const SCENE_OWNER = "scene/geometry" as const;
const MATERIAL_OWNER = "material/TextureBindingSet" as const;
const LIGHTING_OWNER = "lighting" as const;

export function createGpuSparseShadingPipelineDescriptor(
  input: GpuSparseShadingPipelineIdentityInput
): Readonly<GpuSparseShadingPipelineDescriptor> {
  validateProgram(input.programId);
  validateOutputMask(input.outputDependencyMask);
  if (typeof input.shadowSamplingEnabled !== "boolean") {
    throw new TypeError("Sparse shading shadow specialization must be boolean");
  }
  if (input.capability.fingerprint.length === 0 || input.capability.formatProfile.length === 0) {
    throw new RangeError("Sparse shading capability and format profile must not be empty");
  }
  const virtualGeometry = input.virtualGeometry ?? false;
  if (typeof virtualGeometry !== "boolean") {
    throw new TypeError("Sparse shading virtual geometry specialization must be boolean");
  }
  const executionMode = input.executionMode ?? "sparse-microtile";
  if (executionMode !== "sparse-microtile" && executionMode !== "direct-single-bin") {
    throw new RangeError(`Unsupported sparse shading execution mode '${String(executionMode)}'`);
  }
  const textureBankMask = input.textureBankMask ?? GPU_TEXTURE_BANK_ALL_MASK;
  if (!Number.isInteger(textureBankMask) || textureBankMask < 1 ||
      (textureBankMask & ~GPU_TEXTURE_BANK_ALL_MASK) !== 0) {
    throw new RangeError(`Sparse shading texture bank mask must select at least one of ${GPU_TEXTURE_BANK_COUNT} banks`);
  }
  const usesTextures = shadingProgramUsesTextures(input.programId);
  if (!usesTextures && input.textureBindingSetId !== 0) {
    throw new RangeError("Textureless sparse shading pipeline must use TextureBindingSet 0");
  }
  const binId = encodeGpuShadingBinId(input.programId, input.textureBindingSetId);
  const lit = input.programId >= GPU_SHADING_PROGRAM.PbrFactor;
  const needsGeometry = input.programId !== GPU_SHADING_PROGRAM.UnlitFactor ||
    (input.outputDependencyMask & GPU_SHADING_OUTPUT_DEPENDENCY.Velocity) !== 0;
  const publishesShading =
    (input.outputDependencyMask & GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite) !== 0;
  const publishesDiffuse =
    (input.outputDependencyMask & GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite) !== 0;
  const publishesVelocity =
    (input.outputDependencyMask & GPU_SHADING_OUTPUT_DEPENDENCY.Velocity) !== 0;
  const evaluatesEnvironment =
    (input.outputDependencyMask & GPU_SHADING_OUTPUT_DEPENDENCY.EnvironmentIBL) !== 0;

  const frameBindings: GpuSparseShadingBindingDescriptor[] = executionMode === "sparse-microtile"
    ? [
    uniformBinding(0, 0, "shading_bin_settings"),
    storageBufferBinding(0, 1, "shading_bin_heap", "storage"),
    textureBinding(0, 2, "shading_bin_id", "uint"),
    textureBinding(0, 3, "visibility_key", "uint"),
    ...(needsGeometry ? [textureBinding(0, 4, "visibility_depth", "depth")] : []),
    // PreExposure/frame revision are required even by UnlitFactor; geometry
    // specialization only controls depth/scene reconstruction dependencies.
    uniformBinding(0, 5, "shading_view"),
    storageTextureBinding(0, 6, "output_hdr", "rgba16float"),
    ...(publishesShading ? [storageTextureBinding(0, 7, "output_normal", "rgba16uint")] : []),
    ...(publishesDiffuse
      ? [storageTextureBinding(0, 8, "output_albedo_ao", "rgba8unorm")]
      : []),
    ...(publishesShading || publishesDiffuse
      ? [storageTextureBinding(0, 9, "output_material", "rg32uint")]
      : []),
    ...(publishesVelocity
      ? [storageTextureBinding(0, 10, "output_velocity", "rg16float")]
      : [])
  ] : [
    storageBufferBinding(0, 1, "shading_frame_status", "storage"),
    textureBinding(0, 3, "visibility_key", "uint"),
    ...(needsGeometry ? [textureBinding(0, 4, "visibility_depth", "depth")] : []),
    uniformBinding(0, 5, "shading_view"),
    storageTextureBinding(0, 6, "output_hdr", "rgba16float"),
    ...(publishesShading ? [storageTextureBinding(0, 7, "output_normal", "rgba16uint")] : []),
    ...(publishesDiffuse
      ? [storageTextureBinding(0, 8, "output_albedo_ao", "rgba8unorm")]
      : []),
    ...(publishesShading || publishesDiffuse
      ? [storageTextureBinding(0, 9, "output_material", "rg32uint")]
      : []),
    ...(publishesVelocity
      ? [storageTextureBinding(0, 10, "output_velocity", "rg16float")]
      : [])
  ];

  const sceneBindings: GpuSparseShadingBindingDescriptor[] = [
    storageBufferBinding(1, 0, "meshlet_work", "read-only-storage"),
    ...(needsGeometry ? [storageBufferBinding(1, 1, "instance_records", "read-only-storage")] : []),
    ...(needsGeometry ? [storageBufferBinding(1, 2, "asset_metadata_heap", "read-only-storage")] : []),
    ...(needsGeometry ? [storageBufferBinding(1, 3, "vertex_payload_heap", "read-only-storage")] : []),
    ...(needsGeometry && virtualGeometry ? [
      storageBufferBinding(1, 4, "virtual_product_metadata", "read-only-storage"),
      storageBufferBinding(1, 5, "virtual_product_bank_0", "read-only-storage"),
      storageBufferBinding(1, 6, "virtual_product_bank_1", "read-only-storage"),
      storageBufferBinding(1, 7, "virtual_product_bank_2", "read-only-storage"),
      storageBufferBinding(1, 8, "virtual_product_bank_3", "read-only-storage")
    ] : [])
  ];

  const materialBindings: GpuSparseShadingBindingDescriptor[] = [
    storageBufferBinding(2, 0, "material_records", "read-only-storage"),
    ...(usesTextures
      ? [storageBufferBinding(2, 1, "texture_descriptor_routing_heap", "read-only-storage")]
      : []),
    ...(usesTextures
      ? Array.from({ length: 9 }, (_, index) => (textureBankMask & (1 << index)) !== 0
          ? textureBinding(2, 2 + index, `material_texture_${index}`, "float", "2d-array")
          : null).filter((binding): binding is GpuSparseShadingBindingDescriptor => binding !== null)
      : []),
    ...(usesTextures
      ? Array.from({ length: 6 }, (_, index) =>
          samplerBinding(2, 11 + index, `material_sampler_${index}`))
      : [])
  ];

  const lightingBindings: GpuSparseShadingBindingDescriptor[] = lit ? [
    storageBufferBinding(3, 0, "light_database", "read-only-storage"),
    storageBufferBinding(3, 1, "light_cluster_lookup", "read-only-storage"),
    storageBufferBinding(3, 2, "light_cluster_data", "read-only-storage"),
    uniformBinding(3, 3, "light_cluster_parameters"),
    ...(evaluatesEnvironment ? [
      textureBinding(3, 4, "environment_diffuse", "float"),
      textureBinding(3, 5, "environment_specular", "float"),
      textureBinding(3, 6, "split_sum", "float"),
      samplerBinding(3, 7, "environment_sampler")
    ] : []),
    ...(input.shadowSamplingEnabled
      ? [textureBinding(3, evaluatesEnvironment ? 8 : 4, "shadow_atlas", "depth")] : []),
    ...(input.shadowSamplingEnabled
      ? [samplerBinding(3, evaluatesEnvironment ? 9 : 5, "shadow_sampler", "comparison")] : [])
  ] : [];

  const groups: GpuSparseShadingBindGroupDescriptor[] = [
    groupDescriptor(0, FRAME_OWNER, frameBindings),
    groupDescriptor(1, SCENE_OWNER, sceneBindings),
    groupDescriptor(2, MATERIAL_OWNER, materialBindings),
    ...(lit ? [groupDescriptor(3, LIGHTING_OWNER, lightingBindings)] : [])
  ];
  const cacheKey = [
    `s${GPU_SPARSE_SHADING_PIPELINE_SCHEMA_VERSION}`,
    `p${input.programId}`,
    `t${input.textureBindingSetId}`,
    `o${input.outputDependencyMask}`,
    `h${Number(input.shadowSamplingEnabled)}`,
    `m${executionMode}`,
    `v${Number(virtualGeometry)}`,
    `b${textureBankMask.toString(16)}`,
    lengthPrefixed("c", input.capability.fingerprint),
    lengthPrefixed("f", input.capability.formatProfile)
  ].join(":");
  return Object.freeze({
    schemaVersion: GPU_SPARSE_SHADING_PIPELINE_SCHEMA_VERSION,
    cacheKey,
    label: `ADR-0013 shading program ${input.programId} set ${input.textureBindingSetId} outputs ${input.outputDependencyMask}`,
    entryPoint: GPU_SPARSE_SHADING_ENTRY_POINT,
    programId: input.programId,
    textureBindingSetId: input.textureBindingSetId,
    binId,
    outputDependencyMask: input.outputDependencyMask,
    shadowSamplingEnabled: input.shadowSamplingEnabled,
    executionMode,
    virtualGeometry,
    textureBankMask,
    capabilityFingerprint: input.capability.fingerprint,
    formatProfile: input.capability.formatProfile,
    groups: Object.freeze(groups)
  });
}

export function gpuSparseShadingPipelineBindingBudget(
  descriptor: GpuSparseShadingPipelineDescriptor,
  limits: Parameters<typeof gpuSparseShadingBindingBudget>[1]
): Readonly<GpuSparseShadingBindingBudgetRecord> {
  return gpuSparseShadingBindingBudget(
    descriptor.groups.flatMap((group) => group.bindings),
    limits,
    { virtualGeometry: descriptor.virtualGeometry }
  );
}

export function gpuSparseShadingBindGroupLayoutDescriptors(
  descriptor: GpuSparseShadingPipelineDescriptor,
  computeVisibility: GPUShaderStageFlags
): readonly GPUBindGroupLayoutDescriptor[] {
  return Object.freeze(descriptor.groups.map((group) => ({
    label: `ADR-0013 ${group.owner} group ${group.group}`,
    entries: group.bindings.map((binding) => toGpuLayoutEntry(binding, computeVisibility))
  })));
}

export function gpuSparseShadingBindingDeclarationsWgsl(
  descriptor: GpuSparseShadingPipelineDescriptor
): string {
  return descriptor.groups.flatMap((group) => group.bindings)
    .map(bindingDeclarationWgsl)
    .join("\n");
}

/** Test/candidate module proving directive, binding and format contracts before Step 4. */
export function gpuSparseShadingContractModuleWgsl(
  descriptor: GpuSparseShadingPipelineDescriptor,
  enabledFeatures: Iterable<string>
): string {
  const features = new Set([...enabledFeatures].map(String));
  for (const required of ["subgroups", "texture-formats-tier1"]) {
    if (!features.has(required)) {
      throw new Error(`Sparse shading WGSL requires enabled device feature '${required}'`);
    }
  }
  return `enable subgroups;
requires texture_formats_tier1;
${descriptor.executionMode === "sparse-microtile" ? GPU_SHADING_BIN_WGSL : "struct OEngineShadingFrameStatus { frame_flags: atomic<u32>, error_count: atomic<u32>, generation: u32, layout_revision: u32, reserved0: u32, reserved1: u32, reserved2: u32, reserved3: u32, };"}
struct OEngineShadingView { value: vec4u, };
${gpuSparseShadingBindingDeclarationsWgsl(descriptor)}

@compute @workgroup_size(1, 1, 1)
fn ${GPU_SPARSE_SHADING_ENTRY_POINT}() {}
`;
}

function groupDescriptor(
  group: 0 | 1 | 2 | 3,
  owner: GpuSparseShadingBindGroupDescriptor["owner"],
  bindings: GpuSparseShadingBindingDescriptor[]
): Readonly<GpuSparseShadingBindGroupDescriptor> {
  return Object.freeze({ group, owner, bindings: Object.freeze(bindings) });
}

function uniformBinding(
  group: 0 | 1 | 2 | 3,
  binding: number,
  name: string
): GpuSparseShadingBindingDescriptor {
  return bindingDescriptor(group, binding, name, "uniform-buffer", {
    category: "buffer",
    type: "uniform"
  });
}

function storageBufferBinding(
  group: 0 | 1 | 2 | 3,
  binding: number,
  name: string,
  type: "read-only-storage" | "storage"
): GpuSparseShadingBindingDescriptor {
  return bindingDescriptor(group, binding, name, "storage-buffer", {
    category: "buffer",
    type
  });
}

function textureBinding(
  group: 0 | 1 | 2 | 3,
  binding: number,
  name: string,
  sampleType: "uint" | "depth" | "float",
  viewDimension: "2d" | "2d-array" = "2d"
): GpuSparseShadingBindingDescriptor {
  return bindingDescriptor(group, binding, name, "sampled-texture", {
    category: "texture",
    sampleType,
    viewDimension
  });
}

function samplerBinding(
  group: 0 | 1 | 2 | 3,
  binding: number,
  name: string,
  type: "filtering" | "comparison" = "filtering"
): GpuSparseShadingBindingDescriptor {
  return bindingDescriptor(group, binding, name, "sampler", {
    category: "sampler",
    type
  });
}

function storageTextureBinding(
  group: 0 | 1 | 2 | 3,
  binding: number,
  name: string,
  format: Extract<BindingResource, { category: "storage-texture" }>["format"]
): GpuSparseShadingBindingDescriptor {
  return bindingDescriptor(group, binding, name, "storage-texture", {
    category: "storage-texture",
    access: "write-only",
    format
  });
}

function bindingDescriptor(
  group: 0 | 1 | 2 | 3,
  binding: number,
  name: string,
  kind: GpuSparseShadingBindingKind,
  resource: BindingResource
): GpuSparseShadingBindingDescriptor {
  return Object.freeze({ group, binding, name, kind, visibility: "compute", resource });
}

function toGpuLayoutEntry(
  binding: GpuSparseShadingBindingDescriptor,
  visibility: GPUShaderStageFlags
): GPUBindGroupLayoutEntry {
  const common = { binding: binding.binding, visibility };
  switch (binding.resource.category) {
    case "buffer": return {
      ...common,
      buffer: {
        type: binding.resource.type,
        ...(binding.name === "shading_bin_settings"
          ? { hasDynamicOffset: true, minBindingSize: 32 }
          : binding.name === "shading_view"
            ? { minBindingSize: GPU_SPARSE_SHADING_VIEW_BYTES }
            : {})
      }
    };
    case "texture": return {
      ...common,
      texture: {
        sampleType: binding.resource.sampleType,
        viewDimension: binding.resource.viewDimension
      }
    };
    case "sampler": return { ...common, sampler: { type: binding.resource.type } };
    case "storage-texture": return {
      ...common,
      storageTexture: {
        access: binding.resource.access,
        format: binding.resource.format
      }
    };
  }
}

function bindingDeclarationWgsl(binding: GpuSparseShadingBindingDescriptor): string {
  const prefix = `@group(${binding.group}) @binding(${binding.binding})`;
  switch (binding.resource.category) {
    case "buffer": {
      if (binding.name === "shading_bin_settings") {
        return `${prefix} var<uniform> ${binding.name}: OEngineShadingBinSettings;`;
      }
      if (binding.name === "shading_view") {
        return `${prefix} var<uniform> ${binding.name}: OEngineShadingView;`;
      }
      if (binding.name === "shading_bin_heap") {
        return `${prefix} var<storage, read_write> ${binding.name}: OEngineShadingBinHeap;`;
      }
      if (binding.name === "shading_frame_status") {
        return `${prefix} var<storage, read_write> ${binding.name}: OEngineShadingFrameStatus;`;
      }
      const access = binding.resource.type === "storage" ? "read_write" : "read";
      return `${prefix} var<storage, ${access}> ${binding.name}: array<u32>;`;
    }
    case "texture": {
      const dimension = binding.resource.viewDimension === "2d-array" ? "2d_array" : "2d";
      const textureType = binding.resource.sampleType === "uint" ? `texture_${dimension}<u32>`
        : binding.resource.sampleType === "depth" ? "texture_depth_2d"
        : `texture_${dimension}<f32>`;
      return `${prefix} var ${binding.name}: ${textureType};`;
    }
    case "sampler": return `${prefix} var ${binding.name}: ` +
      `${binding.resource.type === "comparison" ? "sampler_comparison" : "sampler"};`;
    case "storage-texture": return `${prefix} var ${binding.name}: ` +
      `texture_storage_2d<${binding.resource.format}, write>;`;
  }
}

function validateProgram(programId: number): void {
  if (!Number.isInteger(programId) || programId < 0 || programId >= GPU_SHADING_PROGRAM_COUNT) {
    throw new RangeError(`Sparse shading program must be in [0, ${GPU_SHADING_PROGRAM_COUNT - 1}]`);
  }
}

function validateOutputMask(mask: number): void {
  if (!Number.isInteger(mask) || mask < 0 ||
      (mask & ~GPU_SHADING_OUTPUT_DEPENDENCY_VALID_MASK) !== 0) {
    throw new RangeError("Sparse shading output dependency mask has reserved bits");
  }
}

function lengthPrefixed(prefix: string, value: string): string {
  return `${prefix}${value.length}:${value}`;
}
