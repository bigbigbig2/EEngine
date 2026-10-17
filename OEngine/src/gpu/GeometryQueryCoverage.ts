import { PipelineCompilationQueue } from "./PipelineCompilationQueue.js";
import { GPU_INSTANCE_FLAGS, GPU_INSTANCE_RECORD_WGSL } from "./GpuInstanceAbi.js";
import type { GeometryQueryGeometryLease } from "./VirtualGeometryResidency.js";
import type { GeometryQueryInstanceSnapshot } from "./GeometryQueryInstanceSnapshot.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";

/** GPU proof over the complete captured instance domain. Missing Product,
 * material or shared deformation is unknown coverage, never empty space.
 * The read-only consumer sees this certificate in the same command. */
export class GeometryQueryCoverage {
  readonly byteLength: number;
  private destroyed = false;

  private constructor(
    private readonly device: GPUDevice,
    readonly status: GPUBuffer,
    private readonly ranges: GPUBuffer,
    private readonly source: GeometryQueryInstanceSnapshot,
    private readonly pipeline: GPUComputePipeline,
    private readonly group: GPUBindGroup,
    private readonly accounting?: ResourceAccounting,
    private readonly handles: readonly ResourceHandle[] = [],
  ) {
    this.byteLength = status.size + ranges.size;
  }

  static async create(device: GPUDevice, source: GeometryQueryInstanceSnapshot,
    leases: readonly GeometryQueryGeometryLease[], materialDirectory: GPUBuffer,
    accounting?: ResourceAccounting): Promise<GeometryQueryCoverage> {
    const bytes = Math.max(16, leases.length * 16);
    if (bytes > Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize)) {
      throw new RangeError("Query coverage Product directory exceeds the negotiated binding limit");
    }
    if (device.limits.maxComputeInvocationsPerWorkgroup < 128 ||
        device.limits.maxComputeWorkgroupSizeX < 128 ||
        Math.ceil(source.count / 128) > device.limits.maxComputeWorkgroupsPerDimension) {
      throw new RangeError("Query coverage instance domain exceeds negotiated compute limits");
    }
    const module = device.createShaderModule({ label: "Geometry/query coverage", code: /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
@group(0) @binding(0) var<storage, read> source: array<OEngineInstanceRecord>;
@group(0) @binding(1) var<storage, read> products: array<vec4u>;
@group(0) @binding(2) var<storage, read> materials: array<vec4u>;
@group(0) @binding(3) var<storage, read_write> status: array<atomic<u32>>;
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${source.count}u) {
    return;
  }
  let instance = source[id.x];
  if (!oengine_instance_active(instance)) {
    return;
  }
  var flags = 0u;
  var found = false;
  for (var product = 0u; product < ${leases.length}u; product++) {
    let range = products[product];
    if (instance.product_table_slot == range.x &&
        oengine_instance_geometry_generation(instance) == range.y &&
        instance.geometry_record_index >= range.z && instance.geometry_record_index - range.z < range.w) {
      found = true;
      break;
    }
  }
  if (!found || !oengine_instance_virtual_geometry(instance)) {
    flags |= 1u;
  }
  // A revision is not a position stream. Until shared deformation is bound,
  // these instances cannot certify the static Product as current geometry.
  if (instance.dynamic_revision != 0u) {
    flags |= 2u;
  }
  if (instance.material_handle >= arrayLength(&materials)) {
    flags |= 4u;
  } else if (materials[instance.material_handle].w == 0u) {
    flags |= 4u;
  }
  if ((instance.flags & ${GPU_INSTANCE_FLAGS.Transparent}u) != 0u) {
    flags |= 8u;
  }
  if (flags != 0u) {
    atomicOr(&status[0], flags);
    atomicAdd(&status[1], 1u);
  }
}
` });
    const pipeline = await PipelineCompilationQueue.forDevice(device).run(() =>
      device.createComputePipelineAsync({ label: "Geometry/query coverage", layout: "auto",
        compute: { module, entryPoint: "main" } }));
    const buffers: GPUBuffer[] = [];
    const handles: ResourceHandle[] = [];
    try {
      const ranges = device.createBuffer({ label: "Geometry/query coverage Product ranges",
        size: bytes, usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
      buffers.push(ranges);
      const words = new Uint32Array(ranges.getMappedRange());
      for (let index = 0; index < leases.length; index++) {
        const lease = leases[index]!;
        words.set([lease.productTableSlot, lease.productGeneration,
          lease.assetReferenceBegin, lease.queryAssets.length], index * 4);
      }
      ranges.unmap();
      const status = device.createBuffer({ label: "Geometry/query coverage status", size: 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      buffers.push(status);
      if (accounting !== undefined) {
        for (const buffer of buffers) {
          handles.push(accounting.created({ kind: "buffer", category: "resident",
            owner: "Geometry/query coverage", label: buffer.label, bytes: buffer.size }, buffer));
        }
      }
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: source.sourceSnapshot } },
        { binding: 1, resource: { buffer: ranges } },
        { binding: 2, resource: { buffer: materialDirectory } },
        { binding: 3, resource: { buffer: status } },
      ] });
      return new GeometryQueryCoverage(device, status, ranges, source, pipeline, group, accounting, handles);
    } catch (error) {
      for (const buffer of buffers) {
        buffer.destroy();
      }
      for (const handle of handles) {
        accounting!.destroyed(handle);
      }
      throw error;
    }
  }

  encode(command: ShadeGPUCommandContext): void {
    if (this.destroyed || command.closed || command.device !== this.device || !this.source.valid) {
      throw new Error("Query coverage requires its live captured scene");
    }
    this.source.encode(command);
    command.clearBuffer(this.status);
    if (this.source.count === 0) {
      return;
    }
    const pass = command.gpu_encoder.beginComputePass({ label: "Geometry/query coverage" });
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
    this.status.destroy();
    this.ranges.destroy();
    for (const handle of this.handles) {
      this.accounting!.destroyed(handle);
    }
  }
}
