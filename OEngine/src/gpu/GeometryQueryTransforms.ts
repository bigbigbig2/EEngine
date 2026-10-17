import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { PipelineCompilationQueue } from "./PipelineCompilationQueue.js";
import type { GeometryQueryInstanceSnapshot } from "./GeometryQueryInstanceSnapshot.js";
import { geometryQueryTransformsWgsl } from "../shaders/geometry_query_instances.js";

/** One affine/bounds derivation per captured scene, shared by every TLAS shard.
 * Slot addressing is the original GpuScene slot; compact TLAS leaves keep that
 * slot as their primitive reference. Neither visibility nor CPU object walks
 * participate in selection. Lifetime belongs to the immutable query scene. */
export class GeometryQueryTransforms {
  private encoded = false;
  private destroyed = false;
  private readonly handles: ResourceHandle[] = [];

  private constructor(
    private readonly device: GPUDevice,
    readonly source: GeometryQueryInstanceSnapshot,
    readonly records: GPUBuffer,
    readonly bounds: GPUBuffer,
    private readonly pipeline: GPUComputePipeline,
    private readonly group: GPUBindGroup,
    private readonly accounting?: ResourceAccounting
  ) {
    for (const buffer of [records, bounds]) {
      if (accounting !== undefined) {
        this.handles.push(
          accounting.created(
            {
              kind: "buffer",
              category: "resident",
              owner: "Geometry/query transforms",
              label: buffer.label,
              bytes: buffer.size
            },
            buffer
          )
        );
      }
    }
  }

  static async create(
    device: GPUDevice,
    source: GeometryQueryInstanceSnapshot,
    accounting?: ResourceAccounting
  ): Promise<GeometryQueryTransforms> {
    const limit = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
    if (
      !source.valid ||
      Math.max(1, source.count) * 128 > limit ||
      Math.ceil(source.count / 128) > device.limits.maxComputeWorkgroupsPerDimension
    ) {
      throw new RangeError("Shared query transforms exceed the complete scene capacity");
    }
    const module = device.createShaderModule({
      label: "Geometry/shared query transforms",
      code: geometryQueryTransformsWgsl()
    });
    const pipeline = await PipelineCompilationQueue.forDevice(device).run(() =>
      device.createComputePipelineAsync({
        label: "Geometry/shared query transforms",
        layout: "auto",
        compute: { module, entryPoint: "main" }
      })
    );
    const buffers: GPUBuffer[] = [];
    try {
      const records = device.createBuffer({
        label: "Geometry/shared query affine instances",
        size: Math.max(128, source.count * 128),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      });
      buffers.push(records);
      const bounds = device.createBuffer({
        label: "Geometry/shared query world bounds",
        size: Math.max(32, source.count * 32),
        usage: GPUBufferUsage.STORAGE
      });
      buffers.push(bounds);
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: source.sourceSnapshot } },
          { binding: 1, resource: { buffer: source.identitySnapshot } },
          { binding: 2, resource: { buffer: records } },
          { binding: 3, resource: { buffer: bounds } }
        ]
      });
      return new GeometryQueryTransforms(device, source, records, bounds, pipeline, group, accounting);
    } catch (error) {
      for (const buffer of buffers) {
        buffer.destroy();
      }
      throw error;
    }
  }

  get byteLength(): number {
    return this.records.size + this.bounds.size;
  }

  encode(command: ShadeGPUCommandContext): void {
    if (this.destroyed || command.closed || command.device !== this.device) {
      throw new Error("Shared query transforms require their live scene command");
    }
    this.source.encode(command);
    if (this.encoded) {
      return;
    }
    this.encoded = true;
    if (this.source.count === 0) {
      return;
    }
    const pass = command.gpu_encoder.beginComputePass({ label: "Geometry/shared query transforms" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(Math.ceil(this.source.count / 128));
    pass.end();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.records.destroy();
    this.bounds.destroy();
    for (const handle of this.handles) {
      this.accounting!.destroyed(handle);
    }
  }
}
