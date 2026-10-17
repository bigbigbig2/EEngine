import { PipelineCompilationQueue } from "./PipelineCompilationQueue.js";
import { GPU_INSTANCE_FLAGS, GPU_INSTANCE_RECORD_WGSL } from "./GpuInstanceAbi.js";
import type { GeometryQueryGeometryLease } from "./VirtualGeometryResidency.js";
import type { GeometryQueryInstanceSnapshot } from "./GeometryQueryInstanceSnapshot.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import {
  GEOMETRY_QUERY_DOMAIN_WGSL,
  geometryQueryDomainWords,
  type GeometryQueryDomain,
} from "./GeometryQueryDomain.js";

const coveragePipelines = new WeakMap<GPUDevice, Promise<GPUComputePipeline>>();

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
    accounting?: ResourceAccounting, domain?: GeometryQueryDomain): Promise<GeometryQueryCoverage> {
    const domainWords = geometryQueryDomainWords(domain);
    const entries: { lease: GeometryQueryGeometryLease; asset: number }[] = [];
    for (const lease of leases) {
      for (let asset = 0; asset < lease.cut.assets.length; asset++) {
        entries.push({ lease, asset });
      }
    }
    entries.sort((a, b) => a.lease.productTableSlot - b.lease.productTableSlot ||
      a.lease.productGeneration - b.lease.productGeneration ||
      (a.lease.assetReferenceBegin + a.asset) - (b.lease.assetReferenceBegin + b.asset));
    for (let index = 1; index < entries.length; index++) {
      const a = entries[index - 1]!;
      const b = entries[index]!;
      if (a.lease.productTableSlot === b.lease.productTableSlot &&
          a.lease.productGeneration === b.lease.productGeneration &&
          a.lease.assetReferenceBegin + a.asset === b.lease.assetReferenceBegin + b.asset) {
        throw new Error("Query coverage contains duplicate Product asset identities");
      }
    }
    const assetCount = entries.length;
    const bytes = Math.max(48, assetCount * 48);
    if (bytes > Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize)) {
      throw new RangeError("Query coverage Product directory exceeds the negotiated binding limit");
    }
    if (device.limits.maxComputeInvocationsPerWorkgroup < 128 ||
        device.limits.maxComputeWorkgroupSizeX < 128 ||
        Math.ceil(source.count / 128) > device.limits.maxComputeWorkgroupsPerDimension) {
      throw new RangeError("Query coverage instance domain exceeds negotiated compute limits");
    }
    let pendingPipeline = coveragePipelines.get(device);
    if (pendingPipeline === undefined) {
      const module = device.createShaderModule({ label: "Geometry/query coverage", code: /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
${GEOMETRY_QUERY_DOMAIN_WGSL}
@group(0) @binding(0) var<storage, read> source: array<OEngineInstanceRecord>;
struct AssetCoverage {
  identity: vec4u,
  low: vec4f,
  high: vec4f,
}
@group(0) @binding(1) var<storage, read> products: array<AssetCoverage>;
@group(0) @binding(2) var<storage, read> materials: array<vec4u>;
@group(0) @binding(3) var<storage, read_write> status: array<atomic<u32>>;
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= atomicLoad(&status[2])) {
    return;
  }
  let instance = source[id.x];
  let domain_low = bitcast<vec4f>(vec4u(atomicLoad(&status[4]), atomicLoad(&status[5]),
    atomicLoad(&status[6]), atomicLoad(&status[7])));
  let domain_high = bitcast<vec4f>(vec4u(atomicLoad(&status[8]), atomicLoad(&status[9]),
    atomicLoad(&status[10]), atomicLoad(&status[11])));
  if (!oengine_instance_active(instance) || !query_instance_in_domain(instance, domain_low, domain_high)) {
    return;
  }
  let required = query_instance_local_domain(instance, domain_low, domain_high);
  if (!required.full && any(required.low > required.high)) {
    return;
  }
  var flags = 0u;
  var found = false;
  let generation = oengine_instance_geometry_generation(instance);
  var begin = 0u;
  var end = atomicLoad(&status[3]);
  loop {
    if (begin >= end) {
      break;
    }
    let middle = begin + (end - begin) / 2u;
    let key = products[middle].identity;
    let before = key.x < instance.product_table_slot ||
      (key.x == instance.product_table_slot && (key.y < generation ||
        (key.y == generation && key.z < instance.geometry_record_index)));
    if (before) {
      begin = middle + 1u;
    } else {
      end = middle;
    }
  }
  if (begin < atomicLoad(&status[3])) {
    let range = products[begin];
    if (instance.product_table_slot == range.identity.x &&
        generation == range.identity.y &&
        instance.geometry_record_index == range.identity.z) {
      found = true;
      if (range.identity.w == 0u) {
        flags |= 16u;
      } else if (range.identity.w == 1u) {
        if (required.full || any(required.low < range.low.xyz) || any(required.high > range.high.xyz)) {
          flags |= 16u;
        }
      }
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
      pendingPipeline = PipelineCompilationQueue.forDevice(device).run(() =>
        device.createComputePipelineAsync({ label: "Geometry/query coverage", layout: "auto",
        compute: { module, entryPoint: "main" } }));
      coveragePipelines.set(device, pendingPipeline);
      void pendingPipeline.catch(() => coveragePipelines.delete(device));
    }
    const pipeline = await pendingPipeline;
    const buffers: GPUBuffer[] = [];
    const handles: ResourceHandle[] = [];
    try {
      const ranges = device.createBuffer({ label: "Geometry/query coverage Product ranges",
        size: bytes, usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
      buffers.push(ranges);
      const words = new Uint32Array(ranges.getMappedRange());
      const floats = new Float32Array(words.buffer);
      for (let record = 0; record < entries.length; record++) {
        const { lease, asset } = entries[record]!;
        const demand = lease.cut.assets[asset]!;
        const at = record * 12;
        words.set([lease.productTableSlot, lease.productGeneration,
          lease.assetReferenceBegin + asset, demand.active ? demand.domain === null ? 2 : 1 : 0], at);
        if (demand.domain !== null) {
          floats.set(demand.domain.min, at + 4);
          floats.set(demand.domain.max, at + 8);
        }
      }
      ranges.unmap();
      const status = device.createBuffer({ label: "Geometry/query coverage status", size: 48,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        mappedAtCreation: true });
      buffers.push(status);
      const statusBytes = status.getMappedRange();
      new Uint32Array(statusBytes).set([source.count, assetCount], 2);
      new Float32Array(statusBytes).set(domainWords, 4);
      status.unmap();
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
    command.clearBuffer(this.status, 0, 8);
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
