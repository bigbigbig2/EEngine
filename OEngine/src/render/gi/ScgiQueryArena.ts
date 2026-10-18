import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
import { geometryQueryPipelines } from "../../gpu/GeometryQueryPipelines.js";
import type {
  GeometryQueryGeometryLease,
  GeometryQueryGeometrySegment,
} from "../../gpu/VirtualGeometryResidency.js";
import type { GeometryQueryInstanceSnapshot } from "../../gpu/GeometryQueryInstanceSnapshot.js";
import type { GeometryQueryTransforms } from "../../gpu/GeometryQueryTransforms.js";
import type { GpuNativeMaterialPublication } from "../../gpu/GpuNativeMaterialPublication.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../../gpu/GpuInstanceAbi.js";
import { planScgiBvh, type ScgiBvhPlan } from "./ScgiBvhLayout.js";
import { ScgiBvhBuild } from "./ScgiBvhBuild.js";
import { scgiAlign } from "./ScgiCapacity.js";
import type { ScgiQueryBlas } from "./ScgiQueryBlas.js";
import { geometryQueryDomainWords, type GeometryQueryDomain } from "../../gpu/GeometryQueryDomain.js";

/** One descriptor is six vec4u, followed by aligned canonical BLAS copies and
 * exact decoded f32 positions. Source attributes remain in Product pages. */
export const SCGI_QUERY_DESCRIPTOR_WORDS = 24;

export interface ScgiQueryArenaGeometry {
  readonly entry: ScgiQueryBlas;
  readonly lease: GeometryQueryGeometryLease;
  readonly segment: GeometryQueryGeometrySegment;
  readonly asset: number;
  readonly primitiveOffset: number;
  readonly primitiveCount: number;
}

export interface ScgiQueryArenaRoute {
  readonly segment: GeometryQueryGeometrySegment;
  readonly lease: GeometryQueryGeometryLease;
  readonly classIndex: number;
  readonly sourceGroup: number;
  readonly tlas: GPUBuffer;
  readonly group: GPUBindGroup;
  readonly settings: GPUBuffer;
}

/** Finite physical arena. Geometry descriptors are sorted by complete Product
 * asset identity; GPU instance selection never scans every asset per ray. */
interface SharedArenaData {
  readonly buffer: GPUBuffer;
  readonly descriptorWords: Uint32Array;
  references: number;
  submitted: boolean;
  poisoned: boolean;
  handle?: ResourceHandle;
  accounting?: ResourceAccounting;
}

export class ScgiQueryArena {
  readonly routes: ScgiQueryArenaRoute[] = [];
  private readonly owned: GPUBuffer[] = [];
  private destroyed = false;
  private readonly handles: ResourceHandle[] = [];
  private accounting: ResourceAccounting | undefined;
  private constructor(
    private readonly data: SharedArenaData,
    readonly plan: ScgiBvhPlan,
    readonly geometries: readonly ScgiQueryArenaGeometry[],
    readonly descriptorOffsets: readonly number[],
    readonly payloadOffsets: readonly number[],
    readonly pairStride: number,
    private readonly device: GPUDevice,
    private readonly scratch: GPUBuffer,
    private readonly builder: ScgiBvhBuild,
    private readonly pipelines: readonly GPUComputePipeline[],
    private readonly previous?: ScgiQueryArena,
  ) {}

  get buffer(): GPUBuffer {
    return this.data.buffer;
  }

  get byteLength(): number {
    return (
      this.builder.byteLength +
      this.buffer.size +
      this.scratch.size +
      this.owned.reduce((n, b) => n + b.size, 0)
    );
  }

  static async create(
    device: GPUDevice,
    geometries: readonly ScgiQueryArenaGeometry[],
    source: GeometryQueryInstanceSnapshot,
    transforms: GeometryQueryTransforms,
    materials: GpuNativeMaterialPublication,
    subgroup: boolean,
    domain?: GeometryQueryDomain,
    previous?: ScgiQueryArena,
    maximumBytes = Number.MAX_SAFE_INTEGER,
    accounting?: ResourceAccounting,
  ): Promise<ScgiQueryArena> {
    const sorted = [...geometries].sort(
      (a, b) =>
        a.lease.productTableSlot - b.lease.productTableSlot ||
        a.lease.productGeneration - b.lease.productGeneration ||
        a.lease.assetReferenceBegin + a.asset - b.lease.assetReferenceBegin - b.asset ||
        a.segment.queryAssets[a.asset]!.primitiveBegin +
          a.primitiveOffset -
          b.segment.queryAssets[b.asset]!.primitiveBegin -
          b.primitiveOffset,
    );
    let maxChunks = 1;
    let chunks = 0;
    let previousKey = "";
    for (const item of sorted) {
      const key = `${item.lease.productTableSlot}/${item.lease.productGeneration}/${item.lease.assetReferenceBegin + item.asset}`;
      chunks = key === previousKey ? chunks + 1 : 1;
      maxChunks = Math.max(maxChunks, chunks);
      previousKey = key;
    }
    const capacity = Math.max(1, source.count);
    const plan = planScgiBvh(device.limits, capacity);
    const alignment = device.limits.minStorageBufferOffsetAlignment;
    let bytes = scgiAlign(16 + sorted.length * SCGI_QUERY_DESCRIPTOR_WORDS * 4, alignment);
    const offsets: number[] = [];
    const payloads: number[] = [];
    for (const item of sorted) {
      offsets.push(bytes);
      bytes = scgiAlign(bytes + item.entry.buffer.size, alignment);
      payloads.push(bytes);
      bytes = scgiAlign(bytes + item.entry.triangles.size, alignment);
    }
    if (
      bytes > Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize) ||
      Math.ceil(capacity / 128) > device.limits.maxComputeWorkgroupsPerDimension
    ) {
      throw new RangeError("Complete shared query arena exceeds negotiated binding or dispatch limits");
    }
    const segments = [...new Set(sorted.map((item) => item.segment))];
    const routeCount = 1 + segments.length * Math.max(0, materials.rasterClasses.length - 1);
    const requiredBytes =
      bytes +
      plan.scratch.bytes +
      ScgiBvhBuild.allocationBytes(device, plan) +
      routeCount * (64 + plan.hierarchy.bytes);
    if (requiredBytes > maximumBytes) {
      throw new RangeError(
        "Complete shared query arena exceeds remaining publication budget before allocation",
      );
    }
    const descriptorWords = new Uint32Array(4 + sorted.length * SCGI_QUERY_DESCRIPTOR_WORDS);
    descriptorWords.set([sorted.length, maxChunks, 0, 0]);
    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i]!;
      const range = item.segment.queryAssets[item.asset]!;
      descriptorWords.set(
        [
          8,
          item.segment.queryTrianglePrefixWordOffset,
          item.asset,
          item.lease.productGeneration,
          range.primitiveBegin + item.primitiveOffset,
          item.primitiveCount,
          range.cutBegin,
          range.cutCount,
          item.lease.productTableSlot,
          item.lease.assetReferenceBegin + item.asset,
          0,
          0,
          new DataView(
            item.lease.cut.descriptor.assetRecords.buffer,
            item.lease.cut.descriptor.assetRecords.byteOffset,
          ).getUint32(item.asset * 128 + 88, true),
          0,
          0,
          0,
          offsets[i]! / 4,
          item.entry.plan.hierarchy.ranges.nodes!.offset / 4,
          item.entry.plan.hierarchy.ranges.links!.offset / 4,
          payloads[i]! / 4,
          item.primitiveOffset,
          segments.indexOf(item.segment),
          0,
          0,
        ],
        4 + i * SCGI_QUERY_DESCRIPTOR_WORDS,
      );
    }
    const shareData =
      previous !== undefined &&
      !previous.destroyed &&
      previous.data.submitted &&
      !previous.data.poisoned &&
      previous.buffer.size === bytes &&
      previous.geometries.length === sorted.length &&
      previous.geometries.every((item, index) => item.entry === sorted[index]!.entry) &&
      descriptorWords.length === previous.data.descriptorWords.length &&
      descriptorWords.every((value, index) => value === previous.data.descriptorWords[index]);
    let data: SharedArenaData;
    if (shareData) {
      data = previous!.data;
      data.references++;
    } else {
      const buffer = device.createBuffer({
        label: "SCGI/shared AS and intersection arena",
        size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Uint32Array(buffer.getMappedRange()).set(descriptorWords);
      buffer.unmap();
      data = { buffer, descriptorWords, references: 1, submitted: false, poisoned: false, accounting };
      data.handle = accounting?.created(
        {
          kind: "buffer",
          owner: "SCGI/shared static arena",
          category: "resident",
          label: buffer.label,
          bytes,
        },
        buffer,
      );
    }
    const buffer = data.buffer;
    let scratch: GPUBuffer | undefined;
    let builder: ScgiBvhBuild | undefined;
    let owner: ScgiQueryArena | undefined;
    try {
      scratch = device.createBuffer({
        label: "SCGI/scene TLAS scratch",
        size: plan.scratch.bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });
      builder = await ScgiBvhBuild.create(device, plan, subgroup, accounting);
      const cache = geometryQueryPipelines(device);
      const entries: GPUBindGroupLayoutEntry[] = Array.from({ length: 7 }, (_, binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: binding === 0 ? "uniform" : binding === 6 ? "storage" : "read-only-storage" },
      }));
      const layout = cache.layouts.obtainBindGroupLayout({ entries });
      const code = scgiArenaInstancesWgsl(plan);
      const pipelines: GPUComputePipeline[] = [];
      for (const entryPoint of ["classify", "offsets", "scatter"]) {
        pipelines.push(
          await cache.prepare({
            label: `SCGI/scene instances ${entryPoint}`,
            layout: { bindGroupLayouts: [{ entries }] },
            compute: { module: { code }, entryPoint },
          }),
        );
      }
      const compatible =
        previous !== undefined &&
        previous.geometries.length === sorted.length &&
        previous.plan.primitiveCapacity === plan.primitiveCapacity &&
        previous.geometries.every(
          (item, i) =>
            item.entry === sorted[i]!.entry &&
            item.lease.segments.indexOf(item.segment) ===
              sorted[i]!.lease.segments.indexOf(sorted[i]!.segment),
        );
      owner = new ScgiQueryArena(
        data,
        plan,
        sorted,
        offsets,
        payloads,
        maxChunks,
        device,
        scratch,
        builder,
        pipelines,
        compatible ? previous : undefined,
      );
      // Opaque uses one scene-wide route; MASK only uses source banks belonging
      // to that physical segment, with its complete native coverage program.
      for (let segmentIndex = -1; segmentIndex < segments.length; segmentIndex++) {
        const segment = segments[Math.max(0, segmentIndex)]!;
        const item = sorted.find((item) => item.segment === segment)!;
        const classIndices = segmentIndex < 0 ? [0] : materials.rasterClasses.map((_, i) => i).slice(1);
        for (const classIndex of classIndices) {
          const sourceGroup = segmentIndex < 0 ? 0xffffffff : segmentIndex;
          const settings = device.createBuffer({
            label: "SCGI/scene route",
            size: 64,
            usage: GPUBufferUsage.UNIFORM,
            mappedAtCreation: true,
          });
          owner.owned.push(settings);
          const values = settings.getMappedRange();
          new Uint32Array(values).set([capacity, Math.ceil(capacity / 128), sourceGroup, classIndex]);
          new Float32Array(values).set(geometryQueryDomainWords(domain), 8);
          settings.unmap();
          const tlas = device.createBuffer({
            label: "SCGI/scene TLAS",
            size: plan.hierarchy.bytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
          });
          owner.owned.push(tlas);
          const group = device.createBindGroup({
            layout,
            entries: [
              settings,
              source.sourceSnapshot,
              transforms.records,
              transforms.bounds,
              buffer,
              materials.rasterDirectory,
              scratch,
            ].map((resource, binding) => ({ binding, resource: { buffer: resource } })),
          });
          owner.routes.push({ segment, lease: item.lease, classIndex, sourceGroup, tlas, group, settings });
        }
      }
      owner.accounting = accounting;
      if (accounting !== undefined) {
        for (const resource of [scratch, ...owner.owned]) {
          owner.handles.push(
            accounting.created(
              {
                kind: "buffer",
                owner: "SCGI/shared query arena",
                category: "resident",
                label: resource.label,
                bytes: resource.size,
              },
              resource,
            ),
          );
        }
      }
      // Source-group IDs are immutable arena descriptor fields, not material
      // identities. Publish them with an encoder copy before instance building.
      return owner;
    } catch (error) {
      if (owner !== undefined) {
        owner.destroy();
      } else {
        ScgiQueryArena.releaseData(data);
        scratch?.destroy();
        builder?.destroy();
      }
      throw error;
    }
  }

  encode(command: ShadeGPUCommandContext, reusePrevious = false): void {
    if (this.destroyed) {
      throw new Error("Query arena is retired");
    }
    if (!this.data.submitted) {
      for (let i = 0; i < this.geometries.length; i++) {
        const item = this.geometries[i]!;
        command.copyBufferToBuffer(
          item.entry.buffer,
          0,
          this.buffer,
          this.descriptorOffsets[i]!,
          item.entry.buffer.size,
        );
        command.copyBufferToBuffer(
          item.entry.triangles,
          0,
          this.buffer,
          this.payloadOffsets[i]!,
          item.entry.triangles.size,
        );
      }
      command.observeSubmission({
        submitted: (fence) => {
          this.data.submitted = true;
          void fence.catch(() => {
            this.data.poisoned = true;
          });
        },
        aborted: () => {},
        failed: () => {
          this.data.poisoned = true;
        },
      });
    }
    for (let routeIndex = 0; routeIndex < this.routes.length; routeIndex++) {
      const route = this.routes[routeIndex]!;
      for (let phase = 0; phase < 3; phase++) {
        const pass = command.beginComputePass({ label: "SCGI/scene TLAS selection" });
        pass.setPipeline(this.pipelines[phase]!);
        pass.setBindGroup(0, route.group);
        pass.dispatchWorkgroups(phase === 1 ? 1 : Math.ceil(this.plan.primitiveCapacity / 128));
        pass.end();
      }
      const previous =
        !reusePrevious || this.previous?.destroyed ? undefined : this.previous?.routes[routeIndex];
      if (
        previous !== undefined &&
        previous.classIndex === route.classIndex &&
        previous.sourceGroup === route.sourceGroup
      ) {
        command.copyBufferToBuffer(previous.tlas, 0, route.tlas, 0, route.tlas.size);
        this.builder.encodeUpdate(command, route.tlas, this.scratch, this.plan.primitiveCapacity);
      } else {
        this.builder.encode(command, route.tlas, this.scratch, this.plan.primitiveCapacity, true);
      }
    }
  }

  private static releaseData(data: SharedArenaData): void {
    if (--data.references === 0) {
      data.buffer.destroy();
      if (data.handle !== undefined) {
        data.accounting!.destroyed(data.handle);
      }
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.builder.destroy();
    this.scratch.destroy();
    ScgiQueryArena.releaseData(this.data);
    for (const buffer of this.owned) {
      buffer.destroy();
    }
    for (const handle of this.handles) {
      this.accounting!.destroyed(handle);
    }
  }
}

function scgiArenaInstancesWgsl(plan: ScgiBvhPlan): string {
  return /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
struct Settings { count: u32, blocks: u32, source_group: u32, coverage_class: u32,
  reserved: vec4u, domain_low: vec4f, domain_high: vec4f, }
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var<storage, read> source: array<OEngineInstanceRecord>;
@group(0) @binding(2) var<storage, read> instances: array<u32>;
@group(0) @binding(3) var<storage, read> bounds: array<vec4f>;
@group(0) @binding(4) var<storage, read> arena: array<u32>;
@group(0) @binding(5) var<storage, read> materials: array<vec4u>;
@group(0) @binding(6) var<storage, read_write> scratch: array<u32>;
var<workgroup> prefix: array<u32, 128>;
const COUNTS = ${plan.scratch.ranges.selectionCounts!.offset / 4}u;
const OFFSETS = ${plan.scratch.ranges.selectionOffsets!.offset / 4}u;
const BOUNDS = ${plan.scratch.ranges.primitiveBounds!.offset / 4}u;
const INPUT = ${plan.scratch.ranges.input!.offset / 4}u;
fn descriptor(pair: u32) -> u32 {
  let slot = pair;
  if (slot >= arrayLength(&source)) { return 0xffffffffu; }
  let item = source[slot];
  var lo = 0u;
  var hi = arena[0];
  loop {
    if (lo >= hi) { break; }
    let mid = lo + (hi - lo) / 2u;
    let at = 4u + mid * 24u;
    let before = arena[at + 8u] < item.product_table_slot ||
      (arena[at + 8u] == item.product_table_slot && (arena[at + 3u] < oengine_instance_geometry_generation(item) ||
      (arena[at + 3u] == oengine_instance_geometry_generation(item) && arena[at + 9u] < item.geometry_record_index)));
    if (before) { lo = mid + 1u; } else { hi = mid; }
  }
  var index = lo;
  if (settings.source_group != 0xffffffffu) {
    loop {
      if (index >= arena[0]) { break; }
      let at = 4u + index * 24u;
      if (arena[at + 8u] != item.product_table_slot || arena[at + 3u] != oengine_instance_geometry_generation(item) ||
          arena[at + 9u] != item.geometry_record_index || arena[at + 21u] == settings.source_group) { break; }
      index++;
    }
  }
  if (index >= arena[0]) { return 0xffffffffu; }
  let at = 4u + index * 24u;
  if (arena[at + 8u] != item.product_table_slot || arena[at + 3u] != oengine_instance_geometry_generation(item) ||
      arena[at + 9u] != item.geometry_record_index) { return 0xffffffffu; }
  return index;
}
fn selected(pair: u32) -> bool {
  if (pair >= settings.count) { return false; }
  let index = descriptor(pair);
  if (index == 0xffffffffu) { return false; }
  let slot = pair;
  let item = source[slot];
  if (!oengine_instance_active(item) || !oengine_instance_virtual_geometry(item) ||
      item.material_handle >= arrayLength(&materials)) { return false; }
  let route = materials[item.material_handle];
  let at = 4u + index * 24u;
  return route.w != 0u && route.y == settings.coverage_class &&
    (settings.source_group == 0xffffffffu || arena[at + 21u] == settings.source_group) &&
    (settings.domain_low.w == 0.0 ||
      (all(bounds[slot * 2u + 1u].xyz >= settings.domain_low.xyz) &&
       all(bounds[slot * 2u].xyz <= settings.domain_high.xyz)));
}
@compute @workgroup_size(128)
fn classify(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
  prefix[lane] = u32(selected(group.x * 128u + lane));
  workgroupBarrier();
  for (var width = 64u; width > 0u; width >>= 1u) {
    if (lane < width) { prefix[lane] += prefix[lane + width]; }
    workgroupBarrier();
  }
  if (lane == 0u) { scratch[COUNTS + group.x] = prefix[0]; }
}
@compute @workgroup_size(1)
fn offsets() {
  var total = 0u;
  for (var block = 0u; block < settings.blocks; block++) {
    scratch[OFFSETS + block] = total;
    total += scratch[COUNTS + block];
  }
  scratch[INPUT] = total;
}
@compute @workgroup_size(128)
fn scatter(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3u) {
  let pair = group.x * 128u + lane;
  let keep = u32(selected(pair));
  prefix[lane] = keep;
  workgroupBarrier();
  for (var width = 1u; width < 128u; width <<= 1u) {
    var add = 0u;
    if (lane >= width) { add = prefix[lane - width]; }
    workgroupBarrier();
    prefix[lane] += add;
    workgroupBarrier();
  }
  if (keep == 0u) { return; }
  let slot = pair;
  let at = BOUNDS + (scratch[OFFSETS + group.x] + prefix[lane] - 1u) * 8u;
  for (var axis = 0u; axis < 3u; axis++) {
    scratch[at + axis] = bitcast<u32>(bounds[slot * 2u][axis]);
    scratch[at + 4u + axis] = bitcast<u32>(bounds[slot * 2u + 1u][axis]);
  }
  // Full pair ID is reversible without a per-instance descriptor copy.
  scratch[at + 3u] = pair;
  scratch[at + 7u] = 0xffffffffu;
}
`;
}
