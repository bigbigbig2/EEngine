import type { SurfaceProgramClosure, SurfaceResourceRole } from "./SurfaceProducts.js";
import { surfaceMaterialRequirements } from "./SurfaceProducts.js";

/** Physical lowering of one Surface program's logical demand, independent of a scene revision. */
export type SurfaceBindingKind =
  | "read-only-storage" | "uniform" | "sampled-depth"
  | "sampled-array" | "filtering-sampler" | "write-only-rgba16float";

export interface SurfacePhysicalBinding {
  readonly group: 0 | 1 | 2 | 3;
  readonly binding: number;
  readonly role: SurfaceResourceRole;
  readonly element: number;
  readonly kind: SurfaceBindingKind;
}

export interface SurfaceBindingLimits {
  readonly maxBindGroups: number;
  readonly maxBindingsPerBindGroup: number;
  readonly maxStorageBuffersPerShaderStage: number;
  readonly maxStorageTexturesPerShaderStage: number;
  readonly maxSampledTexturesPerShaderStage: number;
  readonly maxSamplersPerShaderStage: number;
  readonly maxUniformBuffersPerShaderStage: number;
}

export interface SurfacePhysicalBindingPlan {
  readonly bindings: readonly Readonly<SurfacePhysicalBinding>[];
  readonly signature: string;
  readonly totals: Readonly<{
    storageBuffers: number;
    storageTextures: number;
    sampledTextures: number;
    samplers: number;
    uniformBuffers: number;
  }>;
}

/** Resolve the immutable layout signature before hashing the program identity. */
export function compileSurfaceProgramLayout(
  input: Readonly<Omit<SurfaceProgramClosure, "layoutSignature">>,
  limits: Readonly<SurfaceBindingLimits>
): Readonly<{ closure: Readonly<SurfaceProgramClosure>; plan: Readonly<SurfacePhysicalBindingPlan> }> {
  const plan = planSurfaceKernelBindings({ ...input, layoutSignature: "pending" }, limits);
  return Object.freeze({
    closure: Object.freeze({ ...input, layoutSignature: plan.signature }),
    plan
  });
}

/**
 * Four groups reflect work/output, scene geometry, material textures and direct
 * light. Locations are newly assigned for ShadingWork; no Sparse owner layout
 * is imported. Only a demanded resource receives a physical slot.
 */
export function planSurfaceKernelBindings(
  closure: Readonly<SurfaceProgramClosure>,
  limits: Readonly<SurfaceBindingLimits>
): Readonly<SurfacePhysicalBindingPlan> {
  const demand = surfaceMaterialRequirements(closure);
  const roles = new Set(demand.roles);
  const bindings: SurfacePhysicalBinding[] = [];
  const add = (
    role: SurfaceResourceRole, group: 0 | 1 | 2 | 3,
    binding: number, kind: SurfaceBindingKind, element = 0
  ) => {
    if (roles.has(role)) bindings.push(Object.freeze({ role, group, binding, kind, element }));
  };

  add("shading-work", 0, 0, "read-only-storage");
  add("meshlet-work", 0, 1, "read-only-storage");
  add("material-records", 0, 2, "read-only-storage");
  add("frame-view", 0, 3, "uniform");
  add("radiance-output", 0, 4, "write-only-rgba16float");
  add("visibility-depth", 0, 5, "sampled-depth");
  add("shading-work-classes", 0, 6, "read-only-storage");

  add("instance-records", 1, 0, "read-only-storage");
  add("geometry-metadata", 1, 1, "read-only-storage");
  add("vertex-payload", 1, 2, "read-only-storage");
  add("virtual-product-metadata", 1, 3, "read-only-storage");
  for (let bank = 0; bank < 4; bank++) {
    add("virtual-product-banks", 1, 4 + bank, "read-only-storage", bank);
  }

  add("texture-routes", 2, 0, "read-only-storage");
  for (let bank = 0; bank < 9; bank++) {
    if ((demand.textureBankMask & (1 << bank)) !== 0) {
      add("texture-banks", 2, 1 + bank, "sampled-array", bank);
    }
  }
  for (let sampler = 0; sampler < 6; sampler++) {
    add("texture-samplers", 2, 10 + sampler, "filtering-sampler", sampler);
  }

  add("direct-light-records", 3, 0, "read-only-storage");
  add("direct-light-cluster-lookup", 3, 1, "read-only-storage");
  add("direct-light-cluster-data", 3, 2, "read-only-storage");
  add("direct-light-cluster-params", 3, 3, "uniform");

  const resolvedRoles = new Set(bindings.map(binding => binding.role));
  for (const role of roles) {
    if (!resolvedRoles.has(role)) throw new Error(`Surface role ${role} has no physical consumer`);
  }
  const occupied = new Set<string>();
  for (const binding of bindings) {
    const slot = `${binding.group}:${binding.binding}`;
    if (occupied.has(slot)) throw new Error(`Surface binding collision at ${slot}`);
    occupied.add(slot);
  }
  const totals = Object.freeze({
    storageBuffers: bindings.filter(binding => binding.kind === "read-only-storage").length,
    storageTextures: bindings.filter(binding => binding.kind === "write-only-rgba16float").length,
    sampledTextures: bindings.filter(binding =>
      binding.kind === "sampled-depth" || binding.kind === "sampled-array").length,
    samplers: bindings.filter(binding => binding.kind === "filtering-sampler").length,
    uniformBuffers: bindings.filter(binding => binding.kind === "uniform").length
  });
  const usedGroups = new Set(bindings.map(binding => binding.group));
  checkLimit("maxBindGroups", Math.max(...usedGroups) + 1, limits.maxBindGroups);
  for (const group of usedGroups) {
    checkLimit("maxBindingsPerBindGroup",
      Math.max(...bindings.filter(binding => binding.group === group)
        .map(binding => binding.binding)) + 1,
      limits.maxBindingsPerBindGroup);
  }
  checkLimit("maxStorageBuffersPerShaderStage", totals.storageBuffers,
    limits.maxStorageBuffersPerShaderStage);
  checkLimit("maxStorageTexturesPerShaderStage", totals.storageTextures,
    limits.maxStorageTexturesPerShaderStage);
  checkLimit("maxSampledTexturesPerShaderStage", totals.sampledTextures,
    limits.maxSampledTexturesPerShaderStage);
  checkLimit("maxSamplersPerShaderStage", totals.samplers,
    limits.maxSamplersPerShaderStage);
  checkLimit("maxUniformBuffersPerShaderStage", totals.uniformBuffers,
    limits.maxUniformBuffersPerShaderStage);
  const signature = JSON.stringify([1, ...bindings.map(binding => [
    binding.group, binding.binding, binding.role, binding.element, binding.kind
  ])]);
  return Object.freeze({ bindings: Object.freeze(bindings), signature, totals });
}

function checkLimit(name: string, needed: number, available: number): void {
  if (!Number.isSafeInteger(available) || available < needed) {
    throw new RangeError(`Surface needs ${name} >= ${needed}, device permits ${available}`);
  }
}

/** Exact device layouts for the selected closure; resource objects are bound per publication. */
export function createSurfaceBindGroupLayouts(
  device: GPUDevice,
  plan: Readonly<SurfacePhysicalBindingPlan>
): readonly GPUBindGroupLayout[] {
  const lastGroup = Math.max(...plan.bindings.map(binding => binding.group));
  return Object.freeze(Array.from({ length: lastGroup + 1 }, (_, group) =>
    device.createBindGroupLayout({
      label: `Surface/compute group ${group}`,
      entries: plan.bindings.filter(binding => binding.group === group).map(binding => {
        const entry: GPUBindGroupLayoutEntry = {
          binding: binding.binding,
          visibility: GPUShaderStage.COMPUTE
        };
        switch (binding.kind) {
          case "read-only-storage":
            entry.buffer = { type: "read-only-storage" };
            break;
          case "uniform":
            entry.buffer = { type: "uniform" };
            break;
          case "sampled-depth":
            entry.texture = { sampleType: "depth" };
            break;
          case "sampled-array":
            entry.texture = { sampleType: "float", viewDimension: "2d-array" };
            break;
          case "filtering-sampler":
            entry.sampler = { type: "filtering" };
            break;
          case "write-only-rgba16float":
            entry.storageTexture = { access: "write-only", format: "rgba16float" };
            break;
        }
        return entry;
      })
    })
  ));
}
