import { PipelineCompilationQueue } from "../../gpu/PipelineCompilationQueue.js";
import type {
  GeometryQueryGeometryLease,
  GeometryQueryGeometrySegment
} from "../../gpu/VirtualGeometryResidency.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { scgiQueryGeometryWgsl } from "../../shaders/scgi_query_geometry.js";
import type { ScgiBvhPlan } from "./ScgiBvhLayout.js";
import { scgiInteger } from "./ScgiCapacity.js";
import { GEOMETRY_QUERY_DIRECTORY_HEADER_BYTES } from "../../gpu/GeometryQueryDirectory.js";

/** An immutable asset/shard binding. Its source geometry owner retains pages;
 * this binding borrows them and owns only 64B of immutable scalar settings. */
export class ScgiQueryGeometry {
  private destroyed = false;

  private constructor(
    readonly lease: GeometryQueryGeometryLease,
    readonly asset: number,
    readonly primitiveCount: number,
    private readonly device: GPUDevice,
    private readonly settings: GPUBuffer,
    private readonly scratch: GPUBuffer,
    private readonly pipeline: GPUComputePipeline,
    private readonly bindings: GPUBindGroup,
    private readonly plan: ScgiBvhPlan
  ) {}

  static async create(
    device: GPUDevice,
    plan: ScgiBvhPlan,
    scratch: GPUBuffer,
    lease: GeometryQueryGeometryLease,
    asset: number,
    segment: GeometryQueryGeometrySegment,
    primitiveOffset = 0,
    primitiveCount = segment.queryAssets[asset]?.primitiveCount ?? 0
  ): Promise<ScgiQueryGeometry> {
    scgiInteger(asset, "query asset", 0, segment.queryAssets.length - 1);
    const range = segment.queryAssets[asset]!;
    scgiInteger(primitiveOffset, "query shard primitive offset", 0, range.primitiveCount);
    scgiInteger(primitiveCount, "query shard primitive count", 0, range.primitiveCount - primitiveOffset);
    if (
      !lease.valid ||
      !lease.segments.includes(segment) ||
      primitiveCount > plan.primitiveCapacity ||
      scratch.size < plan.scratch.bytes ||
      Math.ceil(primitiveCount / 128) > device.limits.maxComputeWorkgroupsPerDimension
    ) {
      throw new RangeError("Query asset requires a complete live geometry lease and representable shard");
    }
    const module = device.createShaderModule({
      label: "SCGI/shared Product triangle bounds",
      code: scgiQueryGeometryWgsl(plan)
    });
    const pipeline = await PipelineCompilationQueue.forDevice(device).run(() =>
      device.createComputePipelineAsync({
        label: "SCGI/shared Product triangle bounds",
        layout: "auto",
        compute: { module, entryPoint: "bounds" }
      })
    );
    if (!lease.valid) {
      throw new Error("Query geometry lease retired during pipeline compilation");
    }
    const settings = device.createBuffer({
      label: "SCGI/query geometry parameters",
      size: 64,
      usage: GPUBufferUsage.UNIFORM,
      mappedAtCreation: true
    });
    try {
      new Uint32Array(settings.getMappedRange()).set([
        GEOMETRY_QUERY_DIRECTORY_HEADER_BYTES / 4,
        segment.queryTrianglePrefixWordOffset,
        asset,
        lease.productGeneration,
        range.primitiveBegin + primitiveOffset,
        primitiveCount,
        range.cutBegin,
        range.cutCount,
        lease.productTableSlot,
        lease.assetReferenceBegin + asset,
        0,
        0,
        new DataView(
          lease.cut.descriptor.assetRecords.buffer,
          lease.cut.descriptor.assetRecords.byteOffset
        ).getUint32(asset * 128 + 88, true),
        0,
        0,
        0
      ]);
      settings.unmap();
      const bindings = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: settings } },
          { binding: 1, resource: { buffer: scratch, size: plan.scratch.bytes } },
          { binding: 8, resource: { buffer: segment.metadata } },
          ...lease.banks.map((buffer, index) => ({ binding: 9 + index, resource: { buffer } }))
        ]
      });
      return new ScgiQueryGeometry(
        lease,
        asset,
        primitiveCount,
        device,
        settings,
        scratch,
        pipeline,
        bindings,
        plan
      );
    } catch (error) {
      settings.destroy();
      throw error;
    }
  }

  encodeBounds(command: ShadeGPUCommandContext): void {
    if (
      this.destroyed ||
      !this.lease.valid ||
      command.device !== this.device ||
      command.closed ||
      this.scratch.size < this.plan.scratch.bytes
    ) {
      throw new Error("Query geometry requires its live immutable publication");
    }
    const pass = command.gpu_encoder.beginComputePass({ label: "SCGI/shared Product triangle bounds" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindings);
    pass.dispatchWorkgroups(Math.ceil(this.primitiveCount / 128));
    pass.end();
  }

  /** Geometry lease retirement remains with its publication owner. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.settings.destroy();
  }
}
