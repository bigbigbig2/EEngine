import { geometryQueryPipelines } from "./GeometryQueryPipelines.js";
import { GeometryQueryTransforms } from "./GeometryQueryTransforms.js";
import { GeometryQueryInstanceSnapshot } from "./GeometryQueryInstanceSnapshot.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import type { ScgiBvhPlan } from "../render/gi/ScgiBvhLayout.js";
import { SCGI_ABI } from "../render/gi/ScgiAbi.js";
import { geometryQueryInstancesWgsl } from "../shaders/geometry_query_instances.js";
import { geometryQueryDomainWords, type GeometryQueryDomain } from "./GeometryQueryDomain.js";

export interface GeometryQueryInstanceTarget {
  readonly productTableSlot: number;
  readonly productGeneration: number;
  readonly assetReference: number;
  readonly root: number;
  readonly shard: number;
  readonly asGeneration: number;
}

/** Geometry-owned candidate snapshot derived from GpuScene's authoritative
 * high-water domain. CPU never walks per-object transforms or visibility.
 * Immutable settings/resources belong to the caller's query publication. */
export class GeometryQueryInstances {
  private destroyed = false;
  private encoded = false;
  private readonly handles: ResourceHandle[] = [];

  private constructor(
    readonly records: GPUBuffer,
    readonly sourceSnapshot: GPUBuffer,
    readonly identitySnapshot: GPUBuffer,
    readonly count: number,
    readonly first: number,
    private readonly device: GPUDevice,
    private readonly source: GeometryQueryInstanceSnapshot,
    private readonly settings: GPUBuffer,
    private readonly group: GPUBindGroup,
    private readonly pipelines: readonly GPUComputePipeline[],
    private readonly transforms: GeometryQueryTransforms,
    private readonly ownsTransforms: boolean,
    private readonly accounting?: ResourceAccounting
  ) {
    for (const buffer of [settings]) {
      if (accounting !== undefined) {
        this.handles.push(
          accounting.created(
            {
              kind: "buffer",
              category: "transient",
              owner: "Geometry/query instances",
              bytes: buffer.size,
              label: buffer.label
            },
            buffer
          )
        );
      }
    }
  }

  static async create(
    device: GPUDevice,
    plan: ScgiBvhPlan,
    scratch: GPUBuffer,
    source: GeometryQueryInstanceSnapshot,
    target: GeometryQueryInstanceTarget,
    accounting?: ResourceAccounting,
    domain?: GeometryQueryDomain,
    sharedTransforms?: GeometryQueryTransforms,
    first = 0,
    count = source.count - first
  ): Promise<GeometryQueryInstances> {
    const domainWords = geometryQueryDomainWords(domain);
    const limits = device.limits;
    if (
      !Number.isInteger(first) ||
      first < 0 ||
      !Number.isInteger(count) ||
      count < 0 ||
      first + count > source.count ||
      count > plan.primitiveCapacity ||
      Math.ceil(count / 128) > limits.maxComputeWorkgroupsPerDimension ||
      !source.valid ||
      scratch.size < plan.scratch.bytes ||
      count * SCGI_ABI.instance.stride > Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize) ||
      !Object.values(target).every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)
    ) {
      throw new RangeError("Query instances require the complete representable GpuScene publication");
    }
    const cache = geometryQueryPipelines(device);
    const entries: GPUBindGroupLayoutEntry[] = [0, 1, 2, 3, 4].map((binding) => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: {
        type:
          binding === 0
            ? ("uniform" as const)
            : binding === 4
              ? ("storage" as const)
              : ("read-only-storage" as const)
      }
    }));
    const layout = cache.layouts.obtainBindGroupLayout({ entries });
    const pipelines = await Promise.all(
      ["classify", "offsets", "scatter"].map((entryPoint) =>
        cache.prepare({
          label: `Geometry/query instances ${entryPoint}`,
          layout: { bindGroupLayouts: [{ entries }] },
          compute: { module: { code: geometryQueryInstancesWgsl(plan) }, entryPoint }
        })
      )
    );
    const transforms = sharedTransforms ?? (await GeometryQueryTransforms.create(device, source, accounting));
    const buffers: GPUBuffer[] = [];
    const allocate = (label: string, size: number, usage: GPUBufferUsageFlags, mappedAtCreation = false) => {
      const buffer = device.createBuffer({ label, size: Math.max(4, size), usage, mappedAtCreation });
      buffers.push(buffer);
      return buffer;
    };
    try {
      const records = transforms.records;
      const { sourceSnapshot, identitySnapshot } = source;
      const settings = allocate("Geometry/query instance parameters", 64, GPUBufferUsage.UNIFORM, true);
      const settingsBytes = settings.getMappedRange();
      new Uint32Array(settingsBytes).set([
        count,
        target.productTableSlot,
        target.productGeneration,
        target.assetReference,
        first,
        Math.ceil(count / 128),
        0,
        0
      ]);
      new Float32Array(settingsBytes).set(domainWords, 8);
      settings.unmap();
      const group = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: settings } },
          { binding: 1, resource: { buffer: sourceSnapshot } },
          { binding: 2, resource: { buffer: records } },
          { binding: 3, resource: { buffer: transforms.bounds } },
          { binding: 4, resource: { buffer: scratch, size: plan.scratch.bytes } }
        ]
      });
      return new GeometryQueryInstances(
        records,
        sourceSnapshot,
        identitySnapshot,
        count,
        first,
        device,
        source,
        settings,
        group,
        pipelines,
        transforms,
        sharedTransforms === undefined,
        accounting
      );
    } catch (error) {
      for (const buffer of buffers) {
        buffer.destroy();
      }
      if (sharedTransforms === undefined) {
        transforms.destroy();
      }
      throw error;
    }
  }

  /** Source upload and this copy are ordered in the existing frame command.
   * A candidate is encoded once; abort/retry creates a fresh publication. */
  encode(command: ShadeGPUCommandContext): void {
    if (this.destroyed || this.encoded || command.closed || command.device !== this.device) {
      throw new Error("Query instances require an unused live candidate");
    }
    this.encoded = true;
    this.transforms.encode(command);
    // offsets publishes an explicit zero count even for an empty window.
    for (let index = 0; index < this.pipelines.length; index++) {
      const pass = command.gpu_encoder.beginComputePass({ label: this.pipelines[index]!.label });
      pass.setPipeline(this.pipelines[index]!);
      pass.setBindGroup(0, this.group);
      pass.dispatchWorkgroups(index === 1 ? 1 : Math.ceil(this.count / 128));
      pass.end();
    }
  }

  /** Call only on pre-submit abort, final successful consumer fence or teardown. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const buffer of [this.settings]) {
      buffer.destroy();
    }
    if (this.ownsTransforms) {
      this.transforms.destroy();
    }
    for (const handle of this.handles) {
      this.accounting!.destroyed(handle);
    }
  }
}
