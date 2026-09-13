import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { GPU_SHADING_BIN_INDIRECT_STRIDE } from "../../gpu/GpuShadingBinAbi.js";
import { GpuBindGroupResourceCache } from "../../gpu/GpuBindGroupResourceCache.js";
import {
  gpuSparseShadingBindGroupLayoutDescriptors,
  type GpuSparseShadingPipelineDescriptor
} from "../../gpu/GpuSparseShadingPipelineContract.js";
import {
  createSparseShadingShaderVariant,
  type SparseShadingShaderVariant
} from "../../shaders/sparse_shading_resolve.js";

export const SPARSE_SHADING_RESOLVE_LABEL = "ADR-0013 Sparse shading resolve";

export interface SparseShadingResolvePipelineRecord {
  readonly descriptor: Readonly<GpuSparseShadingPipelineDescriptor>;
  readonly pipeline: GPUComputePipeline;
  readonly bindGroupLayouts: readonly GPUBindGroupLayout[];
}

export interface SparseShadingResolveFrameBinding {
  readonly binId: number;
  readonly groups: readonly GPUBindGroup[];
}

export interface SparseShadingResolveDiagnosticsBindings {
  readonly diagnostics: GPUBuffer;
  readonly claims: GPUBuffer;
}

interface CachedSparseShadingResolvePipelineRecord extends SparseShadingResolvePipelineRecord {
  readonly groupCaches: readonly GpuBindGroupResourceCache[];
}

/**
 * Revision-owned cache of creation-time-specialized shading consumers.
 * Step 6 supplies FrameGraph resources/groups; this owner only compiles once,
 * reuses pipelines, and encodes GPU-authored indirect work without submitting.
 */
export class SparseShadingResolvePass {
  private readonly records = new Map<number, Readonly<CachedSparseShadingResolvePipelineRecord>>();
  private readonly device: GPUDevice;
  readonly diagnostics: boolean;
  readonly outputDependencyMask: number;
  readonly publicationRevision: number;
  private destroyed = false;

  private constructor(input: {
    device: GPUDevice;
    diagnostics: boolean;
    outputDependencyMask: number;
    publicationRevision: number;
    records: readonly Readonly<CachedSparseShadingResolvePipelineRecord>[];
  }) {
    this.device = input.device;
    this.diagnostics = input.diagnostics;
    this.outputDependencyMask = input.outputDependencyMask;
    this.publicationRevision = input.publicationRevision;
    for (const record of input.records) this.records.set(record.descriptor.binId, record);
  }

  static async create(
    device: GPUDevice,
    descriptors: readonly Readonly<GpuSparseShadingPipelineDescriptor>[],
    publicationRevision: number,
    diagnostics = false
  ): Promise<SparseShadingResolvePass> {
    if (!Number.isInteger(publicationRevision) || publicationRevision <= 0 || publicationRevision > 0xffffffff) {
      throw new RangeError("Sparse shading publication revision must be a non-zero u32");
    }
    if (descriptors.length === 0) throw new RangeError("Sparse shading requires at least one active bin");
    const outputDependencyMask = descriptors[0]!.outputDependencyMask;
    const seen = new Set<number>();
    for (const descriptor of descriptors) {
      if (descriptor.outputDependencyMask !== outputDependencyMask) {
        throw new Error("Active sparse shading pipelines must share one FramePlan output mask");
      }
      if (seen.has(descriptor.binId)) throw new Error(`Duplicate sparse shading bin ${descriptor.binId}`);
      seen.add(descriptor.binId);
    }

    const records: CachedSparseShadingResolvePipelineRecord[] = [];
    for (const descriptor of descriptors) {
      const variant = createSparseShadingShaderVariant(descriptor, diagnostics);
      records.push(await createPipelineRecord(device, variant));
    }
    return new SparseShadingResolvePass({
      device,
      diagnostics,
      outputDependencyMask,
      publicationRevision,
      records
    });
  }

  get activeBinIds(): readonly number[] {
    return Object.freeze([...this.records.keys()].sort((left, right) => left - right));
  }

  pipelineForBin(binId: number): Readonly<SparseShadingResolvePipelineRecord> {
    this.requireAlive();
    const record = this.records.get(binId);
    if (record === undefined) throw new Error(`Sparse shading bin ${binId} is not active in this revision`);
    return record;
  }

  createFrameBindingsForExecution(
    resource: (name: string) => GPUBindingResource,
    diagnostics?: Readonly<SparseShadingResolveDiagnosticsBindings>
  ): readonly Readonly<SparseShadingResolveFrameBinding>[] {
    this.requireAlive();
    if (this.diagnostics !== (diagnostics !== undefined)) {
      throw new Error("Sparse shading resolve diagnostics bindings must match the pipeline variant");
    }
    const frames: SparseShadingResolveFrameBinding[] = [];
    for (const [binId, record] of this.records) {
      const groups = record.descriptor.groups.map((group, groupIndex) => {
        const resources: GPUBindingResource[] = group.bindings.map((binding) =>
          resource(binding.name));
        const bindings = group.bindings.map((binding) => binding.binding);
        if (groupIndex === 0 && diagnostics !== undefined) {
          resources.push(
            { buffer: diagnostics.diagnostics },
            { buffer: diagnostics.claims }
          );
          bindings.push(11, 12);
        }
        return record.groupCaches[groupIndex]!.obtain(resources, () =>
          this.device.createBindGroup({
            label: `${record.descriptor.label} group ${groupIndex}`,
            layout: record.bindGroupLayouts[groupIndex]!,
            entries: resources.map((bindingResource, index) => ({
              binding: bindings[index]!,
              resource: bindingResource
            }))
          }));
      });
      frames.push(Object.freeze({ binId, groups: Object.freeze(groups) }));
    }
    return Object.freeze(frames);
  }

  bindingCacheEvidence(): Readonly<{
    readonly requests: number;
    readonly creations: number;
  }> {
    let requests = 0;
    let creations = 0;
    for (const record of this.records.values()) {
      for (const cache of record.groupCaches) {
        const evidence = cache.evidence();
        requests += evidence.requestCount;
        creations += evidence.creationCount;
      }
    }
    return Object.freeze({ requests, creations });
  }

  encode(
    command: ShadeGPUCommandContext,
    indirectArgs: GPUBuffer,
    settingsDynamicOffset: number,
    bindings: readonly SparseShadingResolveFrameBinding[],
    publicationRevision: number
  ): void {
    this.requireAlive();
    if (publicationRevision !== this.publicationRevision) {
      throw new Error("Sparse shading bindings do not match the immutable publication revision");
    }
    const byBin = new Map(bindings.map((binding) => [binding.binId, binding]));
    if (byBin.size !== bindings.length || byBin.size !== this.records.size) {
      throw new Error("Sparse shading frame bindings must cover each active bin exactly once");
    }
    for (const [binId, record] of this.records) {
      const frame = byBin.get(binId);
      if (frame === undefined || frame.groups.length !== record.bindGroupLayouts.length) {
        throw new Error(`Sparse shading bin ${binId} bind-group closure is incomplete`);
      }
      const pass = command.beginComputePass({
        label: `${SPARSE_SHADING_RESOLVE_LABEL} bin ${binId}`
      });
      pass.setPipeline(record.pipeline);
      for (let group = 0; group < frame.groups.length; group++) {
        pass.setBindGroup(group, frame.groups[group]!, group === 0 ? [settingsDynamicOffset] : []);
      }
      pass.dispatchWorkgroupsIndirect(indirectArgs, binId * GPU_SHADING_BIN_INDIRECT_STRIDE);
      pass.end();
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const record of this.records.values()) {
      for (const cache of record.groupCaches) cache.clear();
    }
    this.records.clear();
  }

  private requireAlive(): void {
    if (this.destroyed) throw new Error("Sparse shading resolve pass is destroyed");
  }
}

async function createPipelineRecord(
  device: GPUDevice,
  variant: Readonly<SparseShadingShaderVariant>
): Promise<Readonly<CachedSparseShadingResolvePipelineRecord>> {
  const descriptor = variant.descriptor;
  const module = await createCheckedShaderModule(device, descriptor.label, variant.source);
  const nativeDescriptors = gpuSparseShadingBindGroupLayoutDescriptors(
    descriptor,
    GPUShaderStage.COMPUTE
  ).map((layout, group) => variant.diagnostics && group === 0 ? {
    ...layout,
    label: `${layout.label} diagnostics`,
    entries: [
      ...layout.entries,
      { binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" as const } },
      { binding: 12, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" as const } }
    ]
  } : layout);
  const bindGroupLayouts = await checkedValidationScope(device, `${descriptor.label} layouts`, () =>
    nativeDescriptors.map((layout) => device.createBindGroupLayout(layout))
  );
  const pipeline = await checkedValidationScope(device, `${descriptor.label} pipeline`, () => {
    const layout = device.createPipelineLayout({
      label: `${descriptor.label} pipeline layout`,
      bindGroupLayouts
    });
    return device.createComputePipeline({
      label: descriptor.label,
      layout,
      compute: { module, entryPoint: descriptor.entryPoint }
    });
  });
  return Object.freeze({
    descriptor,
    pipeline,
    bindGroupLayouts: Object.freeze(bindGroupLayouts),
    groupCaches: Object.freeze(bindGroupLayouts.map(() => new GpuBindGroupResourceCache()))
  });
}

async function createCheckedShaderModule(
  device: GPUDevice,
  label: string,
  code: string
): Promise<GPUShaderModule> {
  device.pushErrorScope("validation");
  const module = device.createShaderModule({ label, code });
  const [compilationInfo, validationError] = await Promise.all([
    module.getCompilationInfo(),
    device.popErrorScope()
  ]);
  const errors = compilationInfo.messages.filter((message) => message.type === "error");
  if (validationError !== null || errors.length > 0) {
    const details = errors.map((message) =>
      `${message.lineNum}:${message.linePos} ${message.message}`).join("\n");
    throw new Error(`${label} failed compilation/validation` +
      (validationError === null ? "" : `: ${validationError.message}`) +
      (details.length === 0 ? "" : `\n${details}`));
  }
  return module;
}

async function checkedValidationScope<T>(
  device: GPUDevice,
  label: string,
  create: () => T
): Promise<T> {
  device.pushErrorScope("validation");
  let value: T;
  try {
    value = create();
  } catch (error) {
    await device.popErrorScope();
    throw error;
  }
  const validationError = await device.popErrorScope();
  if (validationError !== null) throw new Error(`${label} failed validation: ${validationError.message}`);
  return value;
}
