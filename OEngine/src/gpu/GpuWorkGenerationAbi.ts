/**
 * R3 frame-local work ABI shared by TypeScript packers and WGSL storage buffers.
 *
 * The records contain only stable table indices. Queue ownership, capacity and
 * lifetime remain internal to the future HierarchicalWorkGenerator module.
 * Reservation provenance and WebGPU differences are recorded in
 * docs/references/porting/R3-01-hierarchical-work-generation.md.
 */

export const GPU_WORK_GENERATION_ABI_VERSION = 1;
export const GPU_WORK_QUEUE_INVALID_OFFSET = 0xffffffff;
export const GPU_DISPATCH_INDIRECT_ARGS_SIZE = 12;
export const GPU_DRAW_INDIRECT_ARGS_SIZE = 16;

type GpuWorkAbiFieldKind = "u32" | "atomic_u32";

export interface GpuWorkAbiField {
  readonly name: string;
  readonly kind: GpuWorkAbiFieldKind;
  readonly byteOffset: number;
}

export interface GpuWorkRecordSchema {
  readonly name: string;
  readonly stride: number;
  readonly fields: readonly GpuWorkAbiField[];
  readonly offsets: Readonly<Record<string, number>>;
  readonly wgsl: string;
}

const TRAVERSAL_WORK_FIELDS: readonly GpuWorkAbiField[] = [
  { name: "instance_record_index", kind: "u32", byteOffset: 0 },
  { name: "cluster_record_index", kind: "u32", byteOffset: 4 }
];

const VISIBLE_CLUSTER_FIELDS: readonly GpuWorkAbiField[] = [
  { name: "instance_record_index", kind: "u32", byteOffset: 0 },
  { name: "geometry_record_index", kind: "u32", byteOffset: 4 },
  { name: "cluster_record_index", kind: "u32", byteOffset: 8 },
  { name: "material_handle", kind: "u32", byteOffset: 12 }
];

const RASTER_WORK_FIELDS: readonly GpuWorkAbiField[] = [
  { name: "visible_cluster_slot", kind: "u32", byteOffset: 0 },
  { name: "meshlet_record_index", kind: "u32", byteOffset: 4 }
];

const WORK_QUEUE_HEADER_FIELDS: readonly GpuWorkAbiField[] = [
  { name: "written", kind: "atomic_u32", byteOffset: 0 },
  { name: "attempted", kind: "atomic_u32", byteOffset: 4 },
  { name: "peak", kind: "atomic_u32", byteOffset: 8 },
  { name: "overflow", kind: "atomic_u32", byteOffset: 12 },
  { name: "fallback", kind: "atomic_u32", byteOffset: 16 },
  { name: "capacity", kind: "u32", byteOffset: 20 },
  { name: "_pad0", kind: "u32", byteOffset: 24 },
  { name: "_pad1", kind: "u32", byteOffset: 28 }
];

export const GPU_TRAVERSAL_WORK_SCHEMA = createSchema(
  "OEngineTraversalWork",
  8,
  TRAVERSAL_WORK_FIELDS
);

export const GPU_VISIBLE_CLUSTER_RECORD_SCHEMA = createSchema(
  "OEngineVisibleClusterRecord",
  16,
  VISIBLE_CLUSTER_FIELDS
);

export const GPU_RASTER_WORK_SCHEMA = createSchema(
  "OEngineRasterWork",
  8,
  RASTER_WORK_FIELDS
);

export const GPU_WORK_QUEUE_HEADER_SCHEMA = createSchema(
  "OEngineWorkQueueHeader",
  32,
  WORK_QUEUE_HEADER_FIELDS
);

export const GPU_WORK_GENERATION_WGSL = /* wgsl */ `
const OENGINE_WORK_QUEUE_INVALID_OFFSET: u32 = ${GPU_WORK_QUEUE_INVALID_OFFSET}u;

${GPU_TRAVERSAL_WORK_SCHEMA.wgsl}
${GPU_VISIBLE_CLUSTER_RECORD_SCHEMA.wgsl}
${GPU_RASTER_WORK_SCHEMA.wgsl}
${GPU_WORK_QUEUE_HEADER_SCHEMA.wgsl}

fn oengine_atomic_saturating_add_u32(
  atomic_value: ptr<storage, atomic<u32>, read_write>,
  value: u32
) {
  var observed = atomicLoad(atomic_value);
  loop {
    if (value == 0u || observed == 0xffffffffu) {
      return;
    }
    let next = observed + min(value, 0xffffffffu - observed);
    let result = atomicCompareExchangeWeak(atomic_value, observed, next);
    if (result.exchanged) {
      return;
    }
    observed = result.old_value;
  }
}

// All-or-nothing reservation: callers write the whole group only when a
// concrete offset is returned. Failure never publishes a partial child range.
fn oengine_try_reserve_work_group(
  header: ptr<storage, OEngineWorkQueueHeader, read_write>,
  count: u32
) -> u32 {
  oengine_atomic_saturating_add_u32(&(*header).attempted, count);
  var observed = atomicLoad(&(*header).written);
  loop {
    if (count == 0u || count > (*header).capacity - min(observed, (*header).capacity)) {
      atomicOr(&(*header).overflow, 1u);
      oengine_atomic_saturating_add_u32(&(*header).fallback, 1u);
      return OENGINE_WORK_QUEUE_INVALID_OFFSET;
    }
    let next = observed + count;
    let result = atomicCompareExchangeWeak(&(*header).written, observed, next);
    if (result.exchanged) {
      atomicMax(&(*header).peak, next);
      return observed;
    }
    observed = result.old_value;
  }
}
`;

export interface TraversalWorkCpu {
  readonly instanceRecordIndex: number;
  readonly clusterRecordIndex: number;
}

export interface VisibleClusterRecordCpu {
  readonly instanceRecordIndex: number;
  readonly geometryRecordIndex: number;
  readonly clusterRecordIndex: number;
  readonly materialHandle: number;
}

export interface RasterWorkCpu {
  readonly visibleClusterSlot: number;
  readonly meshletRecordIndex: number;
}

export interface DrawIndirectArgsCpu {
  readonly vertexCount: number;
  readonly instanceCount: number;
  readonly firstVertex: number;
  readonly firstInstance: number;
}

export interface WorkQueueReservationState {
  capacity: number;
  written: number;
  attempted: number;
  peak: number;
  overflow: number;
  fallback: number;
}

export function packTraversalWork(
  record: TraversalWorkCpu
): Uint8Array<ArrayBuffer> {
  return packU32Record(GPU_TRAVERSAL_WORK_SCHEMA, [
    record.instanceRecordIndex,
    record.clusterRecordIndex
  ]);
}

export function packVisibleClusterRecord(
  record: VisibleClusterRecordCpu
): Uint8Array<ArrayBuffer> {
  return packU32Record(GPU_VISIBLE_CLUSTER_RECORD_SCHEMA, [
    record.instanceRecordIndex,
    record.geometryRecordIndex,
    record.clusterRecordIndex,
    record.materialHandle
  ]);
}

export function packRasterWork(
  record: RasterWorkCpu
): Uint8Array<ArrayBuffer> {
  return packU32Record(GPU_RASTER_WORK_SCHEMA, [
    record.visibleClusterSlot,
    record.meshletRecordIndex
  ]);
}

export function packWorkQueueHeader(
  state: Readonly<WorkQueueReservationState>
): Uint8Array<ArrayBuffer> {
  validateReservationState(state);
  return packFixedU32Values([
    state.written,
    state.attempted,
    state.peak,
    state.overflow,
    state.fallback,
    state.capacity,
    0,
    0
  ], GPU_WORK_QUEUE_HEADER_SCHEMA.stride, "work queue header");
}

export function unpackWorkQueueHeader(
  bytes: Uint8Array,
  byteOffset = 0
): Readonly<WorkQueueReservationState> {
  assertByteRange(
    bytes,
    byteOffset,
    GPU_WORK_QUEUE_HEADER_SCHEMA.stride,
    "work queue header"
  );
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + byteOffset,
    GPU_WORK_QUEUE_HEADER_SCHEMA.stride
  );
  const state: WorkQueueReservationState = {
    written: view.getUint32(0, true),
    attempted: view.getUint32(4, true),
    peak: view.getUint32(8, true),
    overflow: view.getUint32(12, true),
    fallback: view.getUint32(16, true),
    capacity: view.getUint32(20, true)
  };
  validateReservationState(state);
  return Object.freeze(state);
}

export function unpackVisibleClusterRecords(
  bytes: Uint8Array,
  count: number,
  byteOffset = GPU_WORK_QUEUE_HEADER_SCHEMA.stride
): readonly VisibleClusterRecordCpu[] {
  assertU32(count, "VisibleCluster record count");
  const byteLength = count * GPU_VISIBLE_CLUSTER_RECORD_SCHEMA.stride;
  if (!Number.isSafeInteger(byteLength)) {
    throw new RangeError("VisibleCluster record byte length is invalid");
  }
  assertByteRange(bytes, byteOffset, byteLength, "VisibleCluster records");
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + byteOffset,
    byteLength
  );
  const records: VisibleClusterRecordCpu[] = [];
  for (let index = 0; index < count; index++) {
    const base = index * GPU_VISIBLE_CLUSTER_RECORD_SCHEMA.stride;
    records.push(Object.freeze({
      instanceRecordIndex: view.getUint32(base, true),
      geometryRecordIndex: view.getUint32(base + 4, true),
      clusterRecordIndex: view.getUint32(base + 8, true),
      materialHandle: view.getUint32(base + 12, true)
    }));
  }
  return Object.freeze(records);
}

export function packDispatchIndirectArgs(
  workgroupCountX: number,
  workgroupCountY = 1,
  workgroupCountZ = 1
): Uint8Array<ArrayBuffer> {
  return packFixedU32Values(
    [workgroupCountX, workgroupCountY, workgroupCountZ],
    GPU_DISPATCH_INDIRECT_ARGS_SIZE,
    "dispatch indirect arguments"
  );
}

export function packDrawIndirectArgs(
  args: DrawIndirectArgsCpu
): Uint8Array<ArrayBuffer> {
  return packFixedU32Values(
    [args.vertexCount, args.instanceCount, args.firstVertex, args.firstInstance],
    GPU_DRAW_INDIRECT_ARGS_SIZE,
    "draw indirect arguments"
  );
}

export function createWorkQueueReservationState(
  capacity: number
): WorkQueueReservationState {
  assertU32(capacity, "Work queue capacity");
  return {
    capacity,
    written: 0,
    attempted: 0,
    peak: 0,
    overflow: 0,
    fallback: 0
  };
}

/** CPU oracle for the WGSL all-or-nothing group reservation. */
export function reserveWorkQueueGroupReference(
  state: WorkQueueReservationState,
  count: number
): number {
  assertPositiveU32(count, "Work queue reservation count");
  validateReservationState(state);
  state.attempted = saturatingU32Add(state.attempted, count);
  if (count > state.capacity - state.written) {
    state.overflow = 1;
    state.fallback = saturatingU32Add(state.fallback, 1);
    return GPU_WORK_QUEUE_INVALID_OFFSET;
  }
  const offset = state.written;
  state.written += count;
  state.peak = Math.max(state.peak, state.written);
  return offset;
}

function createSchema(
  name: string,
  stride: number,
  fields: readonly GpuWorkAbiField[]
): GpuWorkRecordSchema {
  if (!Number.isInteger(stride) || stride <= 0 || stride % 4 !== 0) {
    throw new Error(`${name} stride must be a positive multiple of four`);
  }
  let cursor = 0;
  const offsets: Record<string, number> = {};
  const members: string[] = [];
  for (const field of fields) {
    if (field.byteOffset !== cursor) {
      throw new Error(`${name}.${field.name} offset ${field.byteOffset} does not match ${cursor}`);
    }
    if (field.name in offsets) throw new Error(`${name}.${field.name} is duplicated`);
    offsets[field.name] = field.byteOffset;
    members.push(`  ${field.name}: ${field.kind === "atomic_u32" ? "atomic<u32>" : "u32"},`);
    cursor += 4;
  }
  if (cursor !== stride) {
    throw new Error(`${name} stride ${stride} does not match WGSL layout ${cursor}`);
  }
  return Object.freeze({
    name,
    stride,
    fields: Object.freeze([...fields]),
    offsets: Object.freeze(offsets),
    wgsl: `struct ${name} {\n${members.join("\n")}\n};`
  });
}

function packU32Record(
  schema: GpuWorkRecordSchema,
  values: readonly number[]
): Uint8Array<ArrayBuffer> {
  if (values.length !== schema.fields.length) {
    throw new Error(`${schema.name} expected ${schema.fields.length} values`);
  }
  return packFixedU32Values(values, schema.stride, schema.name);
}

function packFixedU32Values(
  values: readonly number[],
  byteLength: number,
  label: string
): Uint8Array<ArrayBuffer> {
  if (values.length * 4 !== byteLength) {
    throw new Error(`${label} value count does not match byte length ${byteLength}`);
  }
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    assertU32(value, `${label}[${index}]`);
    view.setUint32(index * 4, value, true);
  }
  return bytes;
}

function validateReservationState(state: Readonly<WorkQueueReservationState>): void {
  assertU32(state.capacity, "Work queue capacity");
  assertU32(state.written, "Work queue written");
  assertU32(state.attempted, "Work queue attempted");
  assertU32(state.peak, "Work queue peak");
  assertU32(state.overflow, "Work queue overflow");
  assertU32(state.fallback, "Work queue fallback");
  if (state.written > state.capacity || state.peak < state.written) {
    throw new RangeError("Work queue reservation state is inconsistent");
  }
}

function assertByteRange(
  bytes: Uint8Array,
  byteOffset: number,
  byteLength: number,
  label: string
): void {
  if (
    !Number.isSafeInteger(byteOffset) ||
    !Number.isSafeInteger(byteLength) ||
    byteOffset < 0 ||
    byteLength < 0 ||
    byteOffset + byteLength > bytes.byteLength
  ) {
    throw new RangeError(`${label} byte range is invalid`);
  }
}

function saturatingU32Add(left: number, right: number): number {
  return Math.min(0xffffffff, left + right);
}

function assertPositiveU32(value: number, label: string): void {
  assertU32(value, label);
  if (value === 0) throw new RangeError(`${label} must be a positive u32`);
}

function assertU32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${label} ${value} is outside u32`);
  }
}
