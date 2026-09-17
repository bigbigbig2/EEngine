/** ADR-0009 compute-shading pipeline-layout budget. */
export interface GpuShadingBindingGroupBudget {
  readonly group: 0 | 1 | 2 | 3;
  readonly owner: "frame" | "scene" | "material" | "lighting";
  readonly sampledTextures: number;
  readonly samplers: number;
  readonly storageBuffers: number;
  readonly storageTextures: number;
  readonly uniformBuffers: number;
}

export interface GpuShadingBindingBudgetRecord {
  readonly schemaVersion: 1;
  readonly groups: readonly GpuShadingBindingGroupBudget[];
  readonly totals: Readonly<{
    sampledTextures: number;
    samplers: number;
    storageBuffers: number;
    storageTextures: number;
    uniformBuffers: number;
  }>;
  readonly consolidation: readonly [
    "asset-metadata-heap",
    "vertex-payload-heap",
    "cluster-metadata-heap",
    "texture-descriptor-routing-heap"
  ];
}

/**
 * One legal WebGPU 2026 Desktop layout envelope for ShadeLightingCS.
 *
 * These are stage totals, not an invitation for every specialization to bind
 * unused resources. Consumer-off products must still be removed from the
 * concrete pipeline layout and FrameGraph.
 */
export const GPU_SHADING_BINDING_GROUP_BUDGETS = Object.freeze([
  Object.freeze({
    group: 0,
    owner: "frame",
    sampledTextures: 3,
    samplers: 0,
    storageBuffers: 1,
    storageTextures: 4,
    uniformBuffers: 2
  }),
  Object.freeze({
    group: 1,
    owner: "scene",
    sampledTextures: 0,
    samplers: 0,
    storageBuffers: 4,
    storageTextures: 0,
    uniformBuffers: 0
  }),
  Object.freeze({
    group: 2,
    owner: "material",
    sampledTextures: 9,
    samplers: 6,
    storageBuffers: 2,
    storageTextures: 0,
    uniformBuffers: 0
  }),
  Object.freeze({
    group: 3,
    owner: "lighting",
    sampledTextures: 4,
    samplers: 2,
    storageBuffers: 3,
    storageTextures: 0,
    uniformBuffers: 2
  })
] as const satisfies readonly GpuShadingBindingGroupBudget[]);

const CONSOLIDATION = Object.freeze([
  "asset-metadata-heap",
  "vertex-payload-heap",
  "cluster-metadata-heap",
  "texture-descriptor-routing-heap"
] as const);

export function gpuShadingBindingBudget(
  limits: Pick<
    GPUSupportedLimits,
    | "maxBindGroups"
    | "maxBindingsPerBindGroup"
    | "maxSampledTexturesPerShaderStage"
    | "maxSamplersPerShaderStage"
    | "maxStorageBuffersPerShaderStage"
    | "maxStorageTexturesPerShaderStage"
    | "maxUniformBuffersPerShaderStage"
  >
): GpuShadingBindingBudgetRecord {
  const totals = Object.freeze(GPU_SHADING_BINDING_GROUP_BUDGETS.reduce(
    (sum, group) => ({
      sampledTextures: sum.sampledTextures + group.sampledTextures,
      samplers: sum.samplers + group.samplers,
      storageBuffers: sum.storageBuffers + group.storageBuffers,
      storageTextures: sum.storageTextures + group.storageTextures,
      uniformBuffers: sum.uniformBuffers + group.uniformBuffers
    }),
    {
      sampledTextures: 0,
      samplers: 0,
      storageBuffers: 0,
      storageTextures: 0,
      uniformBuffers: 0
    }
  ));
  requireLimit(limits.maxBindGroups, 4, "maxBindGroups");
  requireLimit(
    limits.maxBindingsPerBindGroup,
    Math.max(...GPU_SHADING_BINDING_GROUP_BUDGETS.map((group) =>
      group.sampledTextures + group.samplers + group.storageBuffers +
      group.storageTextures + group.uniformBuffers
    )),
    "maxBindingsPerBindGroup"
  );
  requireLimit(
    limits.maxSampledTexturesPerShaderStage,
    totals.sampledTextures,
    "maxSampledTexturesPerShaderStage"
  );
  requireLimit(limits.maxSamplersPerShaderStage, totals.samplers, "maxSamplersPerShaderStage");
  requireLimit(
    limits.maxStorageBuffersPerShaderStage,
    totals.storageBuffers,
    "maxStorageBuffersPerShaderStage"
  );
  requireLimit(
    limits.maxStorageTexturesPerShaderStage,
    totals.storageTextures,
    "maxStorageTexturesPerShaderStage"
  );
  requireLimit(
    limits.maxUniformBuffersPerShaderStage,
    totals.uniformBuffers,
    "maxUniformBuffersPerShaderStage"
  );
  return Object.freeze({
    schemaVersion: 1 as const,
    groups: GPU_SHADING_BINDING_GROUP_BUDGETS,
    totals,
    consolidation: CONSOLIDATION
  });
}

function requireLimit(actualValue: number, required: number, name: string): void {
  const actual = Number(actualValue);
  if (!Number.isFinite(actual) || actual < required) {
    throw new RangeError(
      `ShadeLighting binding budget requires ${name} >= ${required}, device permits ${actual}`
    );
  }
}

export type GpuSparseShadingBindingKind =
  | "sampled-texture"
  | "sampler"
  | "storage-buffer"
  | "storage-texture"
  | "uniform-buffer";

export interface GpuSparseShadingConcreteBinding {
  readonly group: 0 | 1 | 2 | 3;
  readonly binding: number;
  readonly kind: GpuSparseShadingBindingKind;
}

export interface GpuSparseShadingBindingBudgetOptions {
  /** Product geometry specialization adds one metadata heap and four banks. */
  readonly virtualGeometry?: boolean;
}

export interface GpuSparseShadingBindingBudgetRecord {
  readonly schemaVersion: 2;
  readonly groups: readonly GpuShadingBindingGroupBudget[];
  readonly totals: Readonly<{
    sampledTextures: number;
    samplers: number;
    storageBuffers: number;
    storageTextures: number;
    uniformBuffers: number;
  }>;
}

export const GPU_SPARSE_SHADING_BINDING_GROUP_LIMITS = Object.freeze([
  Object.freeze({
    group: 0,
    owner: "frame",
    sampledTextures: 3,
    samplers: 0,
    storageBuffers: 1,
    storageTextures: 5,
    uniformBuffers: 2
  }),
  Object.freeze({
    group: 1,
    owner: "scene",
    sampledTextures: 0,
    samplers: 0,
    storageBuffers: 4,
    storageTextures: 0,
    uniformBuffers: 0
  }),
  Object.freeze({
    group: 2,
    owner: "material",
    sampledTextures: 9,
    samplers: 6,
    storageBuffers: 2,
    storageTextures: 0,
    uniformBuffers: 0
  }),
  Object.freeze({
    group: 3,
    owner: "lighting",
    sampledTextures: 4,
    samplers: 2,
    storageBuffers: 3,
    storageTextures: 0,
    uniformBuffers: 2
  })
] as const satisfies readonly GpuShadingBindingGroupBudget[]);

export const GPU_SPARSE_SHADING_STAGE_LIMITS = Object.freeze({
  bindGroups: 4,
  sampledTextures: 16,
  samplers: 8,
  storageBuffers: 10,
  storageTextures: 5,
  uniformBuffers: 4
} as const);

/** Computes V2 usage from a concrete specialized declaration, not a maximum template. */
export function gpuSparseShadingBindingBudget(
  bindings: readonly GpuSparseShadingConcreteBinding[],
  limits: Pick<
    GPUSupportedLimits,
    | "maxBindGroups"
    | "maxBindingsPerBindGroup"
    | "maxSampledTexturesPerShaderStage"
    | "maxSamplersPerShaderStage"
    | "maxStorageBuffersPerShaderStage"
    | "maxStorageTexturesPerShaderStage"
    | "maxUniformBuffersPerShaderStage"
  >,
  options: GpuSparseShadingBindingBudgetOptions = {}
): Readonly<GpuSparseShadingBindingBudgetRecord> {
  const groupRecords = GPU_SPARSE_SHADING_BINDING_GROUP_LIMITS.map((maximum) => ({
    group: maximum.group,
    owner: maximum.owner,
    sampledTextures: 0,
    samplers: 0,
    storageBuffers: 0,
    storageTextures: 0,
    uniformBuffers: 0
  } satisfies GpuShadingBindingGroupBudget));
  const identities = new Set<string>();
  for (const binding of bindings) {
    if (!Number.isInteger(binding.binding) || binding.binding < 0) {
      throw new RangeError("Sparse shading binding number must be a non-negative integer");
    }
    const identity = `${binding.group}:${binding.binding}`;
    if (identities.has(identity)) {
      throw new Error(`Sparse shading duplicate binding ${identity}`);
    }
    identities.add(identity);
    const record = groupRecords[binding.group]!;
    switch (binding.kind) {
      case "sampled-texture": record.sampledTextures++; break;
      case "sampler": record.samplers++; break;
      case "storage-buffer": record.storageBuffers++; break;
      case "storage-texture": record.storageTextures++; break;
      case "uniform-buffer": record.uniformBuffers++; break;
    }
  }
  const groupLimits = options.virtualGeometry
    ? groupRecords.map((record) => record.group === 1
      ? { ...GPU_SPARSE_SHADING_BINDING_GROUP_LIMITS[1], storageBuffers: 9 }
      : GPU_SPARSE_SHADING_BINDING_GROUP_LIMITS[record.group])
    : GPU_SPARSE_SHADING_BINDING_GROUP_LIMITS;
  for (const record of groupRecords) {
    const maximum = groupLimits[record.group]!;
    for (const field of [
      "sampledTextures",
      "samplers",
      "storageBuffers",
      "storageTextures",
      "uniformBuffers"
    ] as const) {
      if (record[field] > maximum[field]) {
        throw new RangeError(
          `Sparse shading group ${record.group} ${field} ${record[field]} exceeds ${maximum[field]}`
        );
      }
    }
  }
  const totals = Object.freeze(groupRecords.reduce(
    (sum, group) => ({
      sampledTextures: sum.sampledTextures + group.sampledTextures,
      samplers: sum.samplers + group.samplers,
      storageBuffers: sum.storageBuffers + group.storageBuffers,
      storageTextures: sum.storageTextures + group.storageTextures,
      uniformBuffers: sum.uniformBuffers + group.uniformBuffers
    }),
    { sampledTextures: 0, samplers: 0, storageBuffers: 0, storageTextures: 0, uniformBuffers: 0 }
  ));
  requireLimit(limits.maxBindGroups, GPU_SPARSE_SHADING_STAGE_LIMITS.bindGroups, "maxBindGroups");
  const maximumBindingsInGroup = Math.max(
    0,
    ...groupRecords.map((group) => bindings.filter((binding) => binding.group === group.group).length)
  );
  requireLimit(limits.maxBindingsPerBindGroup, maximumBindingsInGroup, "maxBindingsPerBindGroup");
  requireLimit(limits.maxSampledTexturesPerShaderStage, totals.sampledTextures, "maxSampledTexturesPerShaderStage");
  requireLimit(limits.maxSamplersPerShaderStage, totals.samplers, "maxSamplersPerShaderStage");
  const requiredStorageBuffers = options.virtualGeometry
    ? Math.max(14, totals.storageBuffers)
    : totals.storageBuffers;
  requireLimit(limits.maxStorageBuffersPerShaderStage, requiredStorageBuffers, "maxStorageBuffersPerShaderStage");
  requireLimit(limits.maxStorageTexturesPerShaderStage, totals.storageTextures, "maxStorageTexturesPerShaderStage");
  requireLimit(limits.maxUniformBuffersPerShaderStage, totals.uniformBuffers, "maxUniformBuffersPerShaderStage");
  return Object.freeze({
    schemaVersion: 2 as const,
    groups: Object.freeze(groupRecords.map((group) => Object.freeze(group))),
    totals
  });
}
