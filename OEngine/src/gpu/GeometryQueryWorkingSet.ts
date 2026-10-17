import type { GeometryProductDescriptorV1 } from "../assets/geometry-product/GeometryProductV1.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { GPU_INSTANCE_RECORD_WGSL } from "./GpuInstanceAbi.js";
import { PipelineCompilationQueue } from "./PipelineCompilationQueue.js";
import { GpuGeometryDemandReadbackRingV1 } from "./GeometryDemandReadbackRing.js";
import { GeometryQueryInstanceSnapshot } from "./GeometryQueryInstanceSnapshot.js";
import { geometryQueryCut, type GeometryQueryAssetDemand, type GeometryQueryCut } from "./GeometryQueryCut.js";
import { GEOMETRY_QUERY_DOMAIN_WGSL, geometryQueryDomainWords, type GeometryQueryDomain } from "./GeometryQueryDomain.js";
import type { VirtualGeometryResidency } from "./VirtualGeometryResidency.js";
import type { GeometryPageStreamingRuntimeV1 } from "./GeometryPageStreamingRuntime.js";

/** Allocation profile for GPU-generated, world-domain query demand. Voxel size
 * and angular footprint are world units/radians, independent of screen LOD. */
export interface GeometryQueryWorkingSetProfile {
  readonly domain: GeometryQueryDomain;
  readonly voxelSize: number;
  readonly errorFraction: number;
  readonly receiver: readonly [number, number, number];
  readonly angularFootprint: number;
  /** GPU output, three delayed slots and window uniforms. Shared instance
   * snapshot is charged separately by its existing owner. */
  readonly maximumBytes: number;
}

interface WorkingSetWindow {
  readonly begin: number;
  readonly count: number;
  readonly settings: GPUBuffer;
  readonly output: GPUBuffer;
  readonly group: GPUBindGroup;
  readonly ring: GpuGeometryDemandReadbackRingV1;
}

const RECORD_BYTES = 32;
const WINDOW_ASSETS = 4096;
const workingSetPipelines = new WeakMap<GPUDevice, Promise<{
  layout: GPUBindGroupLayout;
  initialize: GPUComputePipeline;
  reduce: GPUComputePipeline;
}>>();

/** Only delayed, complete feedback becomes a cold publication plan. The GPU
 * still checks that every current instance fits the plan when it is consumed.
 * This owner never submits commands and never reads back a current ray count. */
export class GeometryQueryWorkingSet {
  private destroyed = false;
  private readonly pending = new Map<number, Map<number, ArrayBuffer>>();
  private lastFrame = -1;
  private inFlight = 0;
  private failed = false;
  private failure: unknown;
  private readonly windows: WorkingSetWindow[] = [];
  private constructor(
    private readonly device: GPUDevice,
    private readonly source: GeometryQueryInstanceSnapshot,
    private readonly product: VirtualGeometryResidency,
    private readonly descriptor: GeometryProductDescriptorV1,
    private readonly initialize: GPUComputePipeline,
    private readonly reduce: GPUComputePipeline,
  ) {}

  static async create(device: GPUDevice, source: GeometryQueryInstanceSnapshot,
    product: VirtualGeometryResidency, profile: GeometryQueryWorkingSetProfile): Promise<GeometryQueryWorkingSet> {
    const domain = geometryQueryDomainWords(profile.domain);
    if (![profile.voxelSize, profile.errorFraction, profile.angularFootprint, ...profile.receiver].every(Number.isFinite) ||
        profile.voxelSize <= 0 || profile.errorFraction < 0 || profile.angularFootprint < 0 ||
        Math.ceil(source.count / 128) > device.limits.maxComputeWorkgroupsPerDimension ||
        device.limits.maxComputeInvocationsPerWorkgroup < 128 || device.limits.maxComputeWorkgroupSizeX < 128) {
      throw new RangeError("Query working set requires finite world-space quality and representable GPU work");
    }
    const descriptor = product.descriptor;
    const assetCount = descriptor.assetRecords.byteLength / 128;
    const capacity = Math.min(WINDOW_ASSETS, Math.floor(Math.min(device.limits.maxBufferSize,
      device.limits.maxStorageBufferBindingSize) / RECORD_BYTES));
    const bytes = assetCount * RECORD_BYTES * 4 + Math.ceil(assetCount / Math.max(1, capacity)) * 96;
    if (capacity < 1 || !Number.isSafeInteger(profile.maximumBytes) ||
        profile.maximumBytes < bytes || !source.valid) {
      throw new RangeError("Query working set exceeds its admitted resource budget");
    }
    const code = /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
${GEOMETRY_QUERY_DOMAIN_WGSL}
struct Settings {
  product: vec4u,
  window: vec4u,
  low: vec4f,
  high: vec4f,
  quality: vec4f,
  receiver: vec4f,
}
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var<storage, read> instances: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read_write> output: array<atomic<u32>>;
fn ordered(value: f32) -> u32 {
  let bits = bitcast<u32>(value);
  return select(bits ^ 0x80000000u, ~bits, (bits & 0x80000000u) != 0u);
}
@compute @workgroup_size(128)
fn initialize(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= settings.window.y) {
    return;
  }
  let at = id.x * 8u;
  for (var axis = 0u; axis < 3u; axis++) {
    atomicStore(&output[at + axis], 0xffffffffu);
    atomicStore(&output[at + 4u + axis], 0u);
  }
  atomicStore(&output[at + 3u], 0u);
  atomicStore(&output[at + 7u], bitcast<u32>(3.402823466e38));
}
@compute @workgroup_size(128)
fn reduce(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= settings.product.w) {
    return;
  }
  let instance = instances[id.x];
  if (!oengine_instance_active(instance) || !oengine_instance_virtual_geometry(instance) ||
      instance.product_table_slot != settings.product.x ||
      oengine_instance_geometry_generation(instance) != settings.product.y ||
      instance.geometry_record_index < settings.product.z) {
    return;
  }
  let asset = instance.geometry_record_index - settings.product.z;
  if (asset < settings.window.x || asset - settings.window.x >= settings.window.y ||
      !query_instance_in_domain(instance, settings.low, settings.high)) {
    return;
  }
  let local = query_instance_local_domain(instance, settings.low, settings.high);
  if (any(local.low > local.high)) {
    return;
  }
  let at = (asset - settings.window.x) * 8u;
  // Bit 1 forces full asset coverage when inversion could not safely tighten.
  atomicOr(&output[at + 3u], select(1u, 3u, local.full));
  for (var axis = 0u; axis < 3u; axis++) {
    atomicMin(&output[at + axis], ordered(local.low[axis]));
    atomicMax(&output[at + 4u + axis], ordered(local.high[axis]));
  }
  let world_center = oengine_instance_current_object_to_world(instance) *
    vec4f((local.low + local.high) * 0.5, 1.0);
  let radius = length((local.high - local.low) * 0.5) * local.scale;
  let distance = max(0.0, length(world_center.xyz - settings.receiver.xyz) - radius);
  let footprint = max(settings.quality.x, distance * settings.quality.z);
  var error = 0.0;
  if (local.scale > 0.0 && query_finite3(vec3f(local.scale))) {
    error = footprint * settings.quality.y / local.scale;
  }
  if (!(error >= 0.0) || !query_finite3(vec3f(error))) {
    error = 0.0;
  }
  atomicMin(&output[at + 7u], bitcast<u32>(error));
}
`;
    let pendingPipelines = workingSetPipelines.get(device);
    if (pendingPipelines === undefined) {
      pendingPipelines = (async () => {
        const module = device.createShaderModule({ label: "Geometry/query world working set", code });
        // Keep the layout shared: initialize does not read the instance binding.
        const layout = device.createBindGroupLayout({ entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ] });
        const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
        const initialize = await PipelineCompilationQueue.forDevice(device).run(() =>
          device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint: "initialize" } }));
        const reduce = await PipelineCompilationQueue.forDevice(device).run(() =>
          device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint: "reduce" } }));
        return { layout, initialize, reduce };
      })();
      workingSetPipelines.set(device, pendingPipelines);
      void pendingPipelines.catch(() => workingSetPipelines.delete(device));
    }
    const { layout, initialize, reduce } = await pendingPipelines;
    const owner = new GeometryQueryWorkingSet(device, source, product, descriptor, initialize, reduce);
    try {
      for (let begin = 0; begin < assetCount; begin += capacity) {
        const count = Math.min(capacity, assetCount - begin);
        const settings = device.createBuffer({ label: "Geometry/query working-set parameters",
          size: 96, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
        const output = device.createBuffer({ label: "Geometry/query asset demand",
          size: count * RECORD_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        let ring: GpuGeometryDemandReadbackRingV1 | undefined;
        try {
          const bytes = settings.getMappedRange();
          new Uint32Array(bytes).set([product.productTableSlot, product.productGeneration,
            product.assetReferenceBegin, source.count, begin, count, 0, 0]);
          new Float32Array(bytes).set(domain, 8);
          new Float32Array(bytes).set([profile.voxelSize, profile.errorFraction,
            profile.angularFootprint, 0, ...profile.receiver, 0], 16);
          settings.unmap();
          const group = device.createBindGroup({ layout, entries: [
            { binding: 0, resource: { buffer: settings } },
            { binding: 1, resource: { buffer: source.sourceSnapshot } },
            { binding: 2, resource: { buffer: output } },
          ] });
          ring = new GpuGeometryDemandReadbackRingV1({ device, bytesPerSlot: output.size });
          owner.windows.push({ begin, count, settings, output, group, ring });
        } catch (error) {
          settings.destroy();
          output.destroy();
          ring?.destroy();
          throw error;
        }
      }
      void device.lost.then(() => owner.teardown());
      return owner;
    } catch (error) {
      owner.teardown();
      throw error;
    }
  }

  get byteLength(): number {
    // Three staging slots per window, in addition to its GPU output.
    return this.windows.reduce((bytes, window) => bytes + 96 + window.output.size * 4, 0);
  }

  get error(): unknown {
    return this.failure;
  }

  encode(command: ShadeGPUCommandContext, frame: number): void {
    if (this.destroyed || this.failed || command.closed || command.device !== this.device ||
        !this.product.publicationActive ||
        !Number.isSafeInteger(frame) || frame < 0) {
      throw new Error("Query working set requires its live Product and frame");
    }
    this.source.assertCurrent(command);
    this.source.encode(command);
    command.onBeforeFinish.addOne(() => {
      this.source.assertCurrent(command);
      if (!this.product.publicationActive) {
        throw new Error("Query demand Product changed before submission");
      }
    });
    this.inFlight++;
    command.observeSubmission({
      submitted: (fence) => {
        void fence.then(() => { this.inFlight--; }, (error) => {
          this.failed = true;
          this.failure = error;
        });
      },
      aborted: () => { this.inFlight--; },
      failed: (error) => {
        this.failed = true;
        this.failure = error;
      },
    });
    for (const window of this.windows) {
      const pass = command.gpu_encoder.beginComputePass({ label: "Geometry/query working-set reset" });
      pass.setPipeline(this.initialize);
      pass.setBindGroup(0, window.group);
      pass.dispatchWorkgroups(Math.ceil(window.count / 128));
      pass.end();
      if (this.source.count > 0) {
        const reduction = command.gpu_encoder.beginComputePass({ label: "Geometry/query world demand" });
        reduction.setPipeline(this.reduce);
        reduction.setBindGroup(0, window.group);
        reduction.dispatchWorkgroups(Math.ceil(this.source.count / 128));
        reduction.end();
      }
      const slot = window.ring.encode(command.gpu_encoder, window.output, frame, window.output.size);
      if (slot !== undefined) {
        command.onFinished.addOne(() => window.ring.commit(slot));
        command.onAborted.addOne(() => window.ring.cancel(slot));
      }
    }
  }

  /** Called only for a later completed frame. Partial/full-ring feedback never
   * replaces an earlier complete plan and never certifies missing geometry. */
  async consumeCompleted(completedFrame: number, streaming?: GeometryPageStreamingRuntimeV1,
    nowMs = performance.now()): Promise<GeometryQueryCut | undefined> {
    if (this.destroyed || this.failed || !this.product.publicationActive) {
      return undefined;
    }
    for (let index = 0; index < this.windows.length; index++) {
      if (this.destroyed || this.failed || !this.product.publicationActive) {
        return undefined;
      }
      const window = this.windows[index]!;
      for (const result of await window.ring.poll(completedFrame)) {
        try {
          if (this.destroyed || this.failed) {
            return undefined;
          }
          if (result.frameIndex <= this.lastFrame) {
            continue;
          }
          let pieces = this.pending.get(result.frameIndex);
          if (pieces === undefined) {
            pieces = new Map();
            this.pending.set(result.frameIndex, pieces);
          }
          pieces.set(index, result.bytes);
        } finally {
          if (!this.destroyed) {
            window.ring.release(result.slotIndex);
          }
        }
      }
    }
    let newest = -1;
    for (const [frame, pieces] of this.pending) {
      if (pieces.size === this.windows.length) {
        newest = Math.max(newest, frame);
      }
    }
    // Incomplete ring windows must not grow a permanent CPU history.
    for (const frame of this.pending.keys()) {
      if (frame < completedFrame - 3 && frame !== newest) {
        this.pending.delete(frame);
      }
    }
    if (newest < 0) {
      return undefined;
    }
    const pieces = this.pending.get(newest)!;
    const demands: GeometryQueryAssetDemand[] = [];
    for (let index = 0; index < this.windows.length; index++) {
      const window = this.windows[index]!;
      const words = new Uint32Array(pieces.get(index)!);
      const floats = new Float32Array(words.buffer);
      const decode = (ordered: number): number => {
        const bits = new Uint32Array([(ordered & 0x80000000) !== 0 ? ordered ^ 0x80000000 : ~ordered]);
        return new Float32Array(bits.buffer)[0]!;
      };
      for (let asset = 0; asset < window.count; asset++) {
        const at = asset * 8;
        const flags = words[at + 3]!;
        demands.push({ active: flags !== 0, maximumError: floats[at + 7]!,
          domain: (flags & 2) !== 0 || flags === 0 ? null : {
            min: [decode(words[at]!), decode(words[at + 1]!), decode(words[at + 2]!)],
            max: [decode(words[at + 4]!), decode(words[at + 5]!), decode(words[at + 6]!)],
          } });
      }
    }
    const cut = geometryQueryCut(this.descriptor, demands);
    streaming?.requestQueryCut(this.product, cut, nowMs);
    this.lastFrame = newest;
    // Keep at most the three in-flight feedback generations. An incomplete
    // older generation can no longer become the newest complete publication.
    for (const frame of this.pending.keys()) {
      if (frame <= newest || frame < completedFrame - 3) {
        this.pending.delete(frame);
      }
    }
    return cut;
  }

  destroy(): void {
    if (this.inFlight > 0 || this.failed) {
      throw new Error("Query working set is retained by GPU work or failed submission");
    }
    this.teardown();
  }

  private teardown(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.pending.clear();
    for (const window of this.windows) {
      window.settings.destroy();
      window.output.destroy();
      window.ring.destroy();
    }
  }
}
