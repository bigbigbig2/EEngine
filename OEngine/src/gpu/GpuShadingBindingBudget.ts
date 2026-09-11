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
