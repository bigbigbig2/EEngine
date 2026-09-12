import {
  decodeGpuShadingBinId,
  GPU_SHADING_PROGRAM_COUNT
} from "./GpuShadingProgramAbi.js";
import { TEXTURE_BINDING_SET_MAX_RESIDENT_SETS } from "./TextureBindingSetPolicy.js";

/** ADR-0013 sparse shading work ABI. This module owns every CPU/WGSL byte contract. */
export const GPU_SHADING_BIN_ABI_VERSION = 1;
export const GPU_SHADING_BIN_COUNT =
  GPU_SHADING_PROGRAM_COUNT * TEXTURE_BINDING_SET_MAX_RESIDENT_SETS;
export const GPU_SHADING_BIN_INVALID_ID = 0xff;
export const GPU_SHADING_BIN_INVALID_GENERATION = 0;
export const GPU_SHADING_BIN_MACRO_WIDTH = 64;
export const GPU_SHADING_BIN_MACRO_HEIGHT = 64;
export const GPU_SHADING_BIN_MICROTILE_WIDTH = 8;
export const GPU_SHADING_BIN_MICROTILE_HEIGHT = 8;
export const GPU_SHADING_BIN_MICROTILES_PER_MACRO = 64;
export const GPU_SHADING_BIN_CLASSIFIER_WORKGROUP_WIDTH = 16;
export const GPU_SHADING_BIN_CLASSIFIER_WORKGROUP_HEIGHT = 16;
export const GPU_SHADING_BIN_CLASSIFIER_INVOCATIONS = 256;
export const GPU_SHADING_BIN_PIXELS_PER_INVOCATION = 16;
export const GPU_SHADING_BIN_SETTINGS_STRIDE = 32;
export const GPU_SHADING_BIN_SETTINGS_DYNAMIC_STRIDE = 256;
export const GPU_SHADING_BIN_CONTROL_STRIDE = 32;
export const GPU_SHADING_BIN_COUNTER_STRIDE = 16;
export const GPU_SHADING_BIN_LAYOUT_STRIDE = 16;
export const GPU_SHADING_BIN_RECORD_STRIDE = 4;
export const GPU_SHADING_BIN_INDIRECT_STRIDE = 12;
export const GPU_SHADING_BIN_INDIRECT_BYTES =
  GPU_SHADING_BIN_COUNT * GPU_SHADING_BIN_INDIRECT_STRIDE;
export const GPU_SHADING_BIN_CONTROL_OFFSET = 0;
export const GPU_SHADING_BIN_COUNTERS_OFFSET = GPU_SHADING_BIN_CONTROL_STRIDE;
export const GPU_SHADING_BIN_MUTABLE_BYTES =
  GPU_SHADING_BIN_CONTROL_STRIDE + GPU_SHADING_BIN_COUNT * GPU_SHADING_BIN_COUNTER_STRIDE;
export const GPU_SHADING_BIN_LAYOUTS_OFFSET =
  GPU_SHADING_BIN_COUNTERS_OFFSET + GPU_SHADING_BIN_COUNT * GPU_SHADING_BIN_COUNTER_STRIDE;
export const GPU_SHADING_BIN_RECORDS_OFFSET = alignUp(
  GPU_SHADING_BIN_LAYOUTS_OFFSET + GPU_SHADING_BIN_COUNT * GPU_SHADING_BIN_LAYOUT_STRIDE,
  256
);
export const GPU_SHADING_BIN_QUEUE_CLASS = "CorrectnessCritical" as const;
export const GPU_SHADING_BIN_HEAP_USAGE = Object.freeze(["storage", "copy-dst"] as const);
export const GPU_SHADING_BIN_INDIRECT_USAGE = Object.freeze([
  "storage",
  "indirect",
  "copy-dst"
] as const);

export const GPU_SHADING_BIN_FRAME_FLAG = Object.freeze({
  InvalidBin: 1 << 0,
  InactiveBin: 1 << 1,
  LayoutRevisionMismatch: 1 << 2,
  ReservationOverflow: 1 << 3,
  CounterInvariantFailure: 1 << 4,
  IdentityMismatch: 1 << 5
} as const);

export const GPU_SHADING_BIN_LAYOUT_FLAG = Object.freeze({
  Active: 1 << 0
} as const);

export const GPU_SHADING_BIN_SETTINGS_OFFSETS = Object.freeze({
  width: 0,
  height: 4,
  microtilesX: 8,
  generation: 12,
  allowedMaskLo: 16,
  allowedMaskHi: 20,
  maxDispatchDimension: 24,
  layoutRevision: 28
} as const);

export const GPU_SHADING_BIN_CONTROL_OFFSETS = Object.freeze({
  frameFlags: 0,
  errorCount: 4,
  generatedMaskLo: 8,
  generatedMaskHi: 12,
  finalizedGeneration: 16,
  layoutRevision: 20,
  reserved0: 24,
  reserved1: 28
} as const);

export const GPU_SHADING_BIN_COUNTER_OFFSETS = Object.freeze({
  attemptedCount: 0,
  writtenCount: 4,
  overflowCount: 8,
  flags: 12
} as const);

export const GPU_SHADING_BIN_LAYOUT_OFFSETS = Object.freeze({
  recordBase: 0,
  capacity: 4,
  revision: 8,
  flags: 12
} as const);

export const GPU_SHADING_BIN_INDIRECT_OFFSETS = Object.freeze({
  workgroupCountX: 0,
  workgroupCountY: 4,
  workgroupCountZ: 8
} as const);

export interface GpuShadingBinSettingsCpu {
  readonly width: number;
  readonly height: number;
  readonly microtilesX: number;
  readonly generation: number;
  readonly allowedMaskLo: number;
  readonly allowedMaskHi: number;
  readonly maxDispatchDimension: number;
  readonly layoutRevision: number;
}

export interface GpuShadingBinControlCpu {
  readonly frameFlags: number;
  readonly errorCount: number;
  readonly generatedMaskLo: number;
  readonly generatedMaskHi: number;
  readonly finalizedGeneration: number;
  readonly layoutRevision: number;
}

export interface GpuShadingBinCounterCpu {
  readonly attemptedCount: number;
  readonly writtenCount: number;
  readonly overflowCount: number;
  readonly flags: number;
}

export interface GpuShadingBinLayoutCpu {
  readonly recordBase: number;
  readonly capacity: number;
  readonly revision: number;
  readonly flags: number;
}

export interface GpuShadingBinIndirectArgsCpu {
  readonly workgroupCountX: number;
  readonly workgroupCountY: number;
  readonly workgroupCountZ: number;
}

export interface GpuShadingBinSizingLimits {
  readonly maxTextureDimension2D: number;
  readonly maxBufferSize: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxComputeWorkgroupsPerDimension: number;
}

export interface GpuShadingBinSizing {
  readonly width: number;
  readonly height: number;
  readonly microtilesX: number;
  readonly microtilesY: number;
  readonly microtileCount: number;
  readonly activeBinIds: readonly number[];
  readonly allowedMaskLo: number;
  readonly allowedMaskHi: number;
  readonly layouts: readonly Readonly<GpuShadingBinLayoutCpu>[];
  readonly heapBytes: number;
  readonly indirectBytes: number;
}

export interface GpuShadingBinReferenceInput {
  readonly width: number;
  readonly height: number;
  readonly binIds: ArrayLike<number>;
  readonly activeBinIds: readonly number[];
  readonly generation: number;
  readonly layoutRevision: number;
  readonly maxDispatchDimension: number;
  /** Test-only fault injection; production capacity is always full-screen microtile count. */
  readonly capacityOverrides?: Readonly<Record<number, number>>;
  /** Test-only fault injection for finalizer revision mismatch. */
  readonly layoutRevisionOverrides?: Readonly<Record<number, number>>;
}

export interface GpuShadingBinReferenceResult {
  readonly settings: Readonly<GpuShadingBinSettingsCpu>;
  readonly control: Readonly<GpuShadingBinControlCpu>;
  readonly layouts: readonly Readonly<GpuShadingBinLayoutCpu>[];
  readonly counters: readonly Readonly<GpuShadingBinCounterCpu>[];
  readonly recordsByBin: readonly (readonly number[])[];
  readonly records: Uint32Array;
  readonly indirectArgs: readonly Readonly<GpuShadingBinIndirectArgsCpu>[];
}

export function shadingBinMicrotileGrid(width: number, height: number): Readonly<{
  microtilesX: number;
  microtilesY: number;
  microtileCount: number;
}> {
  assertU32(width, "Shading bin width");
  assertU32(height, "Shading bin height");
  const microtilesX = ceilDivide(width, GPU_SHADING_BIN_MICROTILE_WIDTH);
  const microtilesY = ceilDivide(height, GPU_SHADING_BIN_MICROTILE_HEIGHT);
  const microtileCount = checkedMultiply(
    microtilesX,
    microtilesY,
    0xffffffff,
    "Shading bin microtile count"
  );
  return Object.freeze({ microtilesX, microtilesY, microtileCount });
}

export function shadingBinActiveMask(activeBinIds: readonly number[]): Readonly<{
  lo: number;
  hi: number;
}> {
  const normalized = normalizeActiveBinIds(activeBinIds);
  let lo = 0;
  let hi = 0;
  for (const binId of normalized) {
    if (binId < 32) lo = (lo | (1 << binId)) >>> 0;
    else hi = (hi | (1 << (binId - 32))) >>> 0;
  }
  return Object.freeze({ lo, hi });
}

export function createGpuShadingBinLayouts(
  width: number,
  height: number,
  activeBinIds: readonly number[],
  revision: number,
  capacityOverrides?: Readonly<Record<number, number>>,
  revisionOverrides?: Readonly<Record<number, number>>
): readonly Readonly<GpuShadingBinLayoutCpu>[] {
  assertNonZeroU32(revision, "Shading bin layout revision");
  const { microtileCount } = shadingBinMicrotileGrid(width, height);
  const active = new Set(normalizeActiveBinIds(activeBinIds));
  const layouts: GpuShadingBinLayoutCpu[] = [];
  let recordBase = 0;
  for (let binId = 0; binId < GPU_SHADING_BIN_COUNT; binId++) {
    if (!active.has(binId)) {
      layouts.push(Object.freeze({ recordBase: 0, capacity: 0, revision, flags: 0 }));
      continue;
    }
    const capacity = capacityOverrides?.[binId] ?? microtileCount;
    assertU32(capacity, `Shading bin ${binId} capacity`);
    const layoutRevision = revisionOverrides?.[binId] ?? revision;
    assertNonZeroU32(layoutRevision, `Shading bin ${binId} layout revision`);
    assertU32(recordBase, `Shading bin ${binId} record base`);
    layouts.push(Object.freeze({
      recordBase,
      capacity,
      revision: layoutRevision,
      flags: GPU_SHADING_BIN_LAYOUT_FLAG.Active
    }));
    recordBase = checkedAdd(recordBase, capacity, 0xffffffff, "Shading bin record elements");
  }
  return Object.freeze(layouts);
}

export function preflightGpuShadingBinSizing(
  width: number,
  height: number,
  activeBinIds: readonly number[],
  revision: number,
  limits: GpuShadingBinSizingLimits
): Readonly<GpuShadingBinSizing> {
  assertLimit(limits.maxTextureDimension2D, "maxTextureDimension2D");
  assertLimit(limits.maxBufferSize, "maxBufferSize");
  assertLimit(limits.maxStorageBufferBindingSize, "maxStorageBufferBindingSize");
  assertLimit(limits.maxComputeWorkgroupsPerDimension, "maxComputeWorkgroupsPerDimension");
  if (width > limits.maxTextureDimension2D || height > limits.maxTextureDimension2D) {
    throw new RangeError("Shading bin extent exceeds maxTextureDimension2D");
  }
  const normalized = normalizeActiveBinIds(activeBinIds);
  const grid = shadingBinMicrotileGrid(width, height);
  const layouts = createGpuShadingBinLayouts(width, height, normalized, revision);
  const recordElements = checkedMultiply(
    normalized.length,
    grid.microtileCount,
    0xffffffff,
    "Shading bin heap record elements"
  );
  const recordBytes = checkedMultiply(
    recordElements,
    GPU_SHADING_BIN_RECORD_STRIDE,
    Number.MAX_SAFE_INTEGER,
    "Shading bin record bytes"
  );
  const heapBytes = checkedAdd(
    GPU_SHADING_BIN_RECORDS_OFFSET,
    recordBytes,
    Number.MAX_SAFE_INTEGER,
    "Shading bin heap bytes"
  );
  if (heapBytes > limits.maxBufferSize) {
    throw new RangeError("Shading bin heap exceeds maxBufferSize");
  }
  if (heapBytes > limits.maxStorageBufferBindingSize) {
    throw new RangeError("Shading bin heap exceeds maxStorageBufferBindingSize");
  }
  const maximumRecordsPerBin = grid.microtileCount;
  shadingBinDispatchDimensions(
    maximumRecordsPerBin,
    limits.maxComputeWorkgroupsPerDimension
  );
  const mask = shadingBinActiveMask(normalized);
  return Object.freeze({
    width,
    height,
    microtilesX: grid.microtilesX,
    microtilesY: grid.microtilesY,
    microtileCount: grid.microtileCount,
    activeBinIds: normalized,
    allowedMaskLo: mask.lo,
    allowedMaskHi: mask.hi,
    layouts,
    heapBytes,
    indirectBytes: GPU_SHADING_BIN_INDIRECT_BYTES
  });
}

export function shadingBinHeapByteLength(activeBinCount: number, microtileCount: number): number {
  assertRangeInclusive(activeBinCount, 0, GPU_SHADING_BIN_COUNT, "Active shading bin count");
  assertU32(microtileCount, "Shading bin microtile count");
  const records = checkedMultiply(
    activeBinCount,
    microtileCount,
    0xffffffff,
    "Shading bin record elements"
  );
  return checkedAdd(
    GPU_SHADING_BIN_RECORDS_OFFSET,
    checkedMultiply(records, GPU_SHADING_BIN_RECORD_STRIDE, Number.MAX_SAFE_INTEGER, "Shading bin record bytes"),
    Number.MAX_SAFE_INTEGER,
    "Shading bin heap bytes"
  );
}

export function shadingBinDispatchDimensions(
  writtenCount: number,
  maxDispatchDimension: number
): Readonly<GpuShadingBinIndirectArgsCpu> {
  assertU32(writtenCount, "Shading bin written count");
  assertNonZeroU32(maxDispatchDimension, "Shading bin max dispatch dimension");
  if (writtenCount === 0) {
    return Object.freeze({ workgroupCountX: 0, workgroupCountY: 1, workgroupCountZ: 1 });
  }
  const workgroupCountX = Math.min(writtenCount, maxDispatchDimension);
  const workgroupCountY = ceilDivide(writtenCount, workgroupCountX);
  if (workgroupCountY > maxDispatchDimension) {
    throw new RangeError(
      `Shading bin dispatch ${writtenCount} exceeds maxComputeWorkgroupsPerDimension ` +
      `${maxDispatchDimension} squared workgroups`
    );
  }
  return Object.freeze({ workgroupCountX, workgroupCountY, workgroupCountZ: 1 });
}

export function classifyGpuShadingBinsReference(
  input: GpuShadingBinReferenceInput
): Readonly<GpuShadingBinReferenceResult> {
  assertNonZeroU32(input.generation, "Shading bin generation");
  assertNonZeroU32(input.layoutRevision, "Shading bin layout revision");
  assertNonZeroU32(input.maxDispatchDimension, "Shading bin max dispatch dimension");
  const pixelCount = checkedMultiply(
    input.width,
    input.height,
    Number.MAX_SAFE_INTEGER,
    "Shading bin source pixel count"
  );
  if (input.binIds.length !== pixelCount) {
    throw new RangeError(`Shading bin source length ${input.binIds.length} does not match ${pixelCount}`);
  }
  const grid = shadingBinMicrotileGrid(input.width, input.height);
  const activeBinIds = normalizeActiveBinIds(input.activeBinIds);
  const active = new Set(activeBinIds);
  const mask = shadingBinActiveMask(activeBinIds);
  const layouts = createGpuShadingBinLayouts(
    input.width,
    input.height,
    activeBinIds,
    input.layoutRevision,
    input.capacityOverrides,
    input.layoutRevisionOverrides
  );
  const mutableCounters = Array.from({ length: GPU_SHADING_BIN_COUNT }, () => ({
    attemptedCount: 0,
    writtenCount: 0,
    overflowCount: 0,
    flags: 0
  }));
  const mutableRecords = Array.from(
    { length: GPU_SHADING_BIN_COUNT },
    () => [] as number[]
  );
  let frameFlags = 0;
  let errorCount = 0;
  const macroCountX = ceilDivide(input.width, GPU_SHADING_BIN_MACRO_WIDTH);
  const macroCountY = ceilDivide(input.height, GPU_SHADING_BIN_MACRO_HEIGHT);

  for (let macroY = 0; macroY < macroCountY; macroY++) {
    for (let macroX = 0; macroX < macroCountX; macroX++) {
      const macroRecords = Array.from(
        { length: GPU_SHADING_BIN_COUNT },
        () => undefined as Set<number> | undefined
      );
      const pixelBeginX = macroX * GPU_SHADING_BIN_MACRO_WIDTH;
      const pixelBeginY = macroY * GPU_SHADING_BIN_MACRO_HEIGHT;
      const pixelEndX = Math.min(pixelBeginX + GPU_SHADING_BIN_MACRO_WIDTH, input.width);
      const pixelEndY = Math.min(pixelBeginY + GPU_SHADING_BIN_MACRO_HEIGHT, input.height);
      for (let y = pixelBeginY; y < pixelEndY; y++) {
        for (let x = pixelBeginX; x < pixelEndX; x++) {
          const sourceIndex = y * input.width + x;
          const binId = input.binIds[sourceIndex];
          if (binId === GPU_SHADING_BIN_INVALID_ID) continue;
          if (!Number.isInteger(binId) || binId === undefined || binId < 0 || binId >= GPU_SHADING_BIN_COUNT) {
            frameFlags |= GPU_SHADING_BIN_FRAME_FLAG.InvalidBin;
            errorCount = checkedIncrement(errorCount, "Shading bin error count");
            continue;
          }
          if (!active.has(binId)) {
            frameFlags |= GPU_SHADING_BIN_FRAME_FLAG.InactiveBin;
            errorCount = checkedIncrement(errorCount, "Shading bin error count");
            continue;
          }
          const microtileX = Math.floor(x / GPU_SHADING_BIN_MICROTILE_WIDTH);
          const microtileY = Math.floor(y / GPU_SHADING_BIN_MICROTILE_HEIGHT);
          const globalMicrotileId = microtileY * grid.microtilesX + microtileX;
          const records = macroRecords[binId] ?? new Set<number>();
          records.add(globalMicrotileId);
          macroRecords[binId] = records;
        }
      }

      for (let binId = 0; binId < GPU_SHADING_BIN_COUNT; binId++) {
        const macroBinRecords = macroRecords[binId];
        if (macroBinRecords === undefined || macroBinRecords.size === 0) continue;
        const counter = mutableCounters[binId]!;
        const layout = layouts[binId]!;
        if (layout.revision !== input.layoutRevision) {
          frameFlags |= GPU_SHADING_BIN_FRAME_FLAG.LayoutRevisionMismatch;
          counter.flags |= GPU_SHADING_BIN_FRAME_FLAG.LayoutRevisionMismatch;
          errorCount = checkedIncrement(errorCount, "Shading bin error count");
          continue;
        }
        const records = [...macroBinRecords].sort((left, right) => left - right);
        counter.attemptedCount = checkedAdd(
          counter.attemptedCount,
          records.length,
          0xffffffff,
          `Shading bin ${binId} attempted count`
        );
        if (records.length <= layout.capacity - counter.writtenCount) {
          mutableRecords[binId]!.push(...records);
          counter.writtenCount += records.length;
        } else {
          counter.overflowCount = checkedAdd(
            counter.overflowCount,
            records.length,
            0xffffffff,
            `Shading bin ${binId} overflow count`
          );
          counter.flags |= GPU_SHADING_BIN_FRAME_FLAG.ReservationOverflow;
          frameFlags |= GPU_SHADING_BIN_FRAME_FLAG.ReservationOverflow;
          errorCount = checkedIncrement(errorCount, "Shading bin error count");
        }
      }
    }
  }

  const counters = Object.freeze(mutableCounters.map((counter) => Object.freeze({ ...counter })));
  const recordsByBin = Object.freeze(mutableRecords.map((records) => Object.freeze([...records])));
  const finalized = finalizeGpuShadingBinsReference({
    settings: Object.freeze({
      width: input.width,
      height: input.height,
      microtilesX: grid.microtilesX,
      generation: input.generation,
      allowedMaskLo: mask.lo,
      allowedMaskHi: mask.hi,
      maxDispatchDimension: input.maxDispatchDimension,
      layoutRevision: input.layoutRevision
    }),
    layouts,
    counters,
    frameFlags,
    errorCount
  });
  const recordElementCount = layouts.reduce(
    (maximum, layout) => Math.max(maximum, layout.recordBase + layout.capacity),
    0
  );
  const records = new Uint32Array(recordElementCount);
  for (let binId = 0; binId < GPU_SHADING_BIN_COUNT; binId++) {
    records.set(recordsByBin[binId]!, layouts[binId]!.recordBase);
  }
  return Object.freeze({
    settings: finalized.settings,
    control: finalized.control,
    layouts,
    counters: finalized.counters,
    recordsByBin,
    records,
    indirectArgs: finalized.indirectArgs
  });
}

export function finalizeGpuShadingBinsReference(input: {
  readonly settings: Readonly<GpuShadingBinSettingsCpu>;
  readonly layouts: readonly Readonly<GpuShadingBinLayoutCpu>[];
  readonly counters: readonly Readonly<GpuShadingBinCounterCpu>[];
  readonly frameFlags?: number;
  readonly errorCount?: number;
}): Readonly<{
  settings: Readonly<GpuShadingBinSettingsCpu>;
  control: Readonly<GpuShadingBinControlCpu>;
  counters: readonly Readonly<GpuShadingBinCounterCpu>[];
  indirectArgs: readonly Readonly<GpuShadingBinIndirectArgsCpu>[];
}> {
  validateGpuShadingBinSettings(input.settings);
  if (input.layouts.length !== GPU_SHADING_BIN_COUNT ||
      input.counters.length !== GPU_SHADING_BIN_COUNT) {
    throw new RangeError("Shading bin finalizer requires exactly 64 layouts and counters");
  }
  let frameFlags = input.frameFlags ?? 0;
  let errorCount = input.errorCount ?? 0;
  assertU32(frameFlags, "Shading bin frame flags");
  assertU32(errorCount, "Shading bin error count");
  let generatedMaskLo = 0;
  let generatedMaskHi = 0;
  const indirectArgs: GpuShadingBinIndirectArgsCpu[] = [];

  for (let binId = 0; binId < GPU_SHADING_BIN_COUNT; binId++) {
    const layout = input.layouts[binId]!;
    const counter = input.counters[binId]!;
    validateGpuShadingBinLayout(layout);
    validateGpuShadingBinCounter(counter, false);
    if (layout.revision !== input.settings.layoutRevision) {
      frameFlags |= GPU_SHADING_BIN_FRAME_FLAG.LayoutRevisionMismatch;
      errorCount = checkedIncrement(errorCount, "Shading bin error count");
    }
    if (counter.attemptedCount !== counter.writtenCount + counter.overflowCount ||
        counter.writtenCount > layout.capacity) {
      frameFlags |= GPU_SHADING_BIN_FRAME_FLAG.CounterInvariantFailure;
      errorCount = checkedIncrement(errorCount, "Shading bin error count");
    }
    frameFlags |= counter.flags;
    if (counter.overflowCount !== 0) {
      frameFlags |= GPU_SHADING_BIN_FRAME_FLAG.ReservationOverflow;
    }
    if (counter.writtenCount > 0) {
      if (binId < 32) generatedMaskLo = (generatedMaskLo | (1 << binId)) >>> 0;
      else generatedMaskHi = (generatedMaskHi | (1 << (binId - 32))) >>> 0;
    }
    try {
      indirectArgs.push(shadingBinDispatchDimensions(
        counter.writtenCount,
        input.settings.maxDispatchDimension
      ));
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      frameFlags |= GPU_SHADING_BIN_FRAME_FLAG.CounterInvariantFailure;
      errorCount = checkedIncrement(errorCount, "Shading bin error count");
      indirectArgs.push({ workgroupCountX: 0, workgroupCountY: 1, workgroupCountZ: 1 });
    }
  }

  const generatedOutsideAllowed =
    (generatedMaskLo & ~input.settings.allowedMaskLo) !== 0 ||
    (generatedMaskHi & ~input.settings.allowedMaskHi) !== 0;
  if (generatedOutsideAllowed) {
    frameFlags |= GPU_SHADING_BIN_FRAME_FLAG.InactiveBin;
    errorCount = checkedIncrement(errorCount, "Shading bin error count");
  }
  const finalArgs = frameFlags === 0
    ? indirectArgs
    : Array.from({ length: GPU_SHADING_BIN_COUNT }, () => ({
        workgroupCountX: 0,
        workgroupCountY: 1,
        workgroupCountZ: 1
      }));
  return Object.freeze({
    settings: input.settings,
    control: Object.freeze({
      frameFlags: frameFlags >>> 0,
      errorCount,
      generatedMaskLo,
      generatedMaskHi,
      finalizedGeneration: input.settings.generation,
      layoutRevision: input.settings.layoutRevision
    }),
    counters: input.counters,
    indirectArgs: Object.freeze(finalArgs.map((args) => Object.freeze(args)))
  });
}

export function packGpuShadingBinSettings(
  settings: GpuShadingBinSettingsCpu
): Uint8Array<ArrayBuffer> {
  validateGpuShadingBinSettings(settings);
  return packU32([
    settings.width,
    settings.height,
    settings.microtilesX,
    settings.generation,
    settings.allowedMaskLo,
    settings.allowedMaskHi,
    settings.maxDispatchDimension,
    settings.layoutRevision
  ]);
}

export function unpackGpuShadingBinSettings(
  bytes: Uint8Array,
  byteOffset = 0
): Readonly<GpuShadingBinSettingsCpu> {
  const values = unpackU32(bytes, byteOffset, GPU_SHADING_BIN_SETTINGS_STRIDE, 8, "ShadingBinSettings");
  const settings = {
    width: values[0]!, height: values[1]!, microtilesX: values[2]!, generation: values[3]!,
    allowedMaskLo: values[4]!, allowedMaskHi: values[5]!, maxDispatchDimension: values[6]!,
    layoutRevision: values[7]!
  };
  validateGpuShadingBinSettings(settings);
  return Object.freeze(settings);
}

export function packGpuShadingBinControl(
  control: GpuShadingBinControlCpu
): Uint8Array<ArrayBuffer> {
  validateGpuShadingBinControl(control);
  return packU32([
    control.frameFlags, control.errorCount, control.generatedMaskLo,
    control.generatedMaskHi, control.finalizedGeneration, control.layoutRevision, 0, 0
  ]);
}

export function unpackGpuShadingBinControl(
  bytes: Uint8Array,
  byteOffset = 0
): Readonly<GpuShadingBinControlCpu> {
  const values = unpackU32(bytes, byteOffset, GPU_SHADING_BIN_CONTROL_STRIDE, 8, "ShadingBinControl");
  const control = {
    frameFlags: values[0]!, errorCount: values[1]!, generatedMaskLo: values[2]!,
    generatedMaskHi: values[3]!, finalizedGeneration: values[4]!, layoutRevision: values[5]!
  };
  validateGpuShadingBinControl(control);
  return Object.freeze(control);
}

export function packGpuShadingBinCounter(
  counter: GpuShadingBinCounterCpu
): Uint8Array<ArrayBuffer> {
  validateGpuShadingBinCounter(counter, true);
  return packU32([
    counter.attemptedCount, counter.writtenCount, counter.overflowCount, counter.flags
  ]);
}

export function unpackGpuShadingBinCounter(
  bytes: Uint8Array,
  byteOffset = 0
): Readonly<GpuShadingBinCounterCpu> {
  const values = unpackU32(bytes, byteOffset, GPU_SHADING_BIN_COUNTER_STRIDE, 4, "ShadingBinCounter");
  const counter = {
    attemptedCount: values[0]!, writtenCount: values[1]!, overflowCount: values[2]!, flags: values[3]!
  };
  validateGpuShadingBinCounter(counter, true);
  return Object.freeze(counter);
}

export function packGpuShadingBinLayout(
  layout: GpuShadingBinLayoutCpu
): Uint8Array<ArrayBuffer> {
  validateGpuShadingBinLayout(layout);
  return packU32([layout.recordBase, layout.capacity, layout.revision, layout.flags]);
}

export function unpackGpuShadingBinLayout(
  bytes: Uint8Array,
  byteOffset = 0
): Readonly<GpuShadingBinLayoutCpu> {
  const values = unpackU32(bytes, byteOffset, GPU_SHADING_BIN_LAYOUT_STRIDE, 4, "ShadingBinLayout");
  const layout = { recordBase: values[0]!, capacity: values[1]!, revision: values[2]!, flags: values[3]! };
  validateGpuShadingBinLayout(layout);
  return Object.freeze(layout);
}

export function packGpuShadingBinIndirectArgs(
  args: GpuShadingBinIndirectArgsCpu
): Uint8Array<ArrayBuffer> {
  validateGpuShadingBinIndirectArgs(args);
  return packU32([args.workgroupCountX, args.workgroupCountY, args.workgroupCountZ]);
}

export function unpackGpuShadingBinIndirectArgs(
  bytes: Uint8Array,
  byteOffset = 0
): Readonly<GpuShadingBinIndirectArgsCpu> {
  const values = unpackU32(bytes, byteOffset, GPU_SHADING_BIN_INDIRECT_STRIDE, 3, "ShadingBinIndirectArgs");
  const args = { workgroupCountX: values[0]!, workgroupCountY: values[1]!, workgroupCountZ: values[2]! };
  validateGpuShadingBinIndirectArgs(args);
  return Object.freeze(args);
}

export function shadingBinCounterByteOffset(binId: number): number {
  validateBinId(binId);
  return GPU_SHADING_BIN_COUNTERS_OFFSET + binId * GPU_SHADING_BIN_COUNTER_STRIDE;
}

export function shadingBinLayoutByteOffset(binId: number): number {
  validateBinId(binId);
  return GPU_SHADING_BIN_LAYOUTS_OFFSET + binId * GPU_SHADING_BIN_LAYOUT_STRIDE;
}

export function shadingBinIndirectByteOffset(binId: number): number {
  validateBinId(binId);
  return binId * GPU_SHADING_BIN_INDIRECT_STRIDE;
}

export function shadingBinRecordByteOffset(layout: GpuShadingBinLayoutCpu, index: number): number {
  validateGpuShadingBinLayout(layout);
  assertU32(index, "Shading bin record index");
  if (index >= layout.capacity) throw new RangeError("Shading bin record index exceeds capacity");
  return GPU_SHADING_BIN_RECORDS_OFFSET +
    checkedAdd(layout.recordBase, index, 0xffffffff, "Shading bin record element") *
      GPU_SHADING_BIN_RECORD_STRIDE;
}

export const GPU_SHADING_BIN_WGSL = /* wgsl */ `
const OENGINE_SHADING_BIN_ABI_VERSION: u32 = ${GPU_SHADING_BIN_ABI_VERSION}u;
const OENGINE_SHADING_BIN_COUNT: u32 = ${GPU_SHADING_BIN_COUNT}u;
const OENGINE_SHADING_BIN_INVALID_ID: u32 = ${GPU_SHADING_BIN_INVALID_ID}u;
const OENGINE_SHADING_BIN_MACRO_WIDTH: u32 = ${GPU_SHADING_BIN_MACRO_WIDTH}u;
const OENGINE_SHADING_BIN_MACRO_HEIGHT: u32 = ${GPU_SHADING_BIN_MACRO_HEIGHT}u;
const OENGINE_SHADING_BIN_MICROTILE_WIDTH: u32 = ${GPU_SHADING_BIN_MICROTILE_WIDTH}u;
const OENGINE_SHADING_BIN_MICROTILE_HEIGHT: u32 = ${GPU_SHADING_BIN_MICROTILE_HEIGHT}u;
const OENGINE_SHADING_BIN_FRAME_INVALID_BIN: u32 = ${GPU_SHADING_BIN_FRAME_FLAG.InvalidBin}u;
const OENGINE_SHADING_BIN_FRAME_INACTIVE_BIN: u32 = ${GPU_SHADING_BIN_FRAME_FLAG.InactiveBin}u;
const OENGINE_SHADING_BIN_FRAME_LAYOUT_REVISION_MISMATCH: u32 = ${GPU_SHADING_BIN_FRAME_FLAG.LayoutRevisionMismatch}u;
const OENGINE_SHADING_BIN_FRAME_RESERVATION_OVERFLOW: u32 = ${GPU_SHADING_BIN_FRAME_FLAG.ReservationOverflow}u;
const OENGINE_SHADING_BIN_FRAME_COUNTER_INVARIANT_FAILURE: u32 = ${GPU_SHADING_BIN_FRAME_FLAG.CounterInvariantFailure}u;
const OENGINE_SHADING_BIN_FRAME_IDENTITY_MISMATCH: u32 = ${GPU_SHADING_BIN_FRAME_FLAG.IdentityMismatch}u;
const OENGINE_SHADING_BIN_LAYOUT_ACTIVE: u32 = ${GPU_SHADING_BIN_LAYOUT_FLAG.Active}u;

struct OEngineShadingBinSettings {
  width: u32,
  height: u32,
  microtiles_x: u32,
  generation: u32,
  allowed_mask_lo: u32,
  allowed_mask_hi: u32,
  max_dispatch_dimension: u32,
  layout_revision: u32,
};

struct OEngineShadingBinControl {
  frame_flags: atomic<u32>,
  error_count: atomic<u32>,
  generated_mask_lo: u32,
  generated_mask_hi: u32,
  finalized_generation: u32,
  layout_revision: u32,
  reserved0: u32,
  reserved1: u32,
};

struct OEngineShadingBinCounter {
  attempted_count: atomic<u32>,
  written_count: atomic<u32>,
  overflow_count: atomic<u32>,
  flags: atomic<u32>,
};

struct OEngineShadingBinLayout {
  record_base: u32,
  capacity: u32,
  revision: u32,
  flags: u32,
};

struct OEngineShadingBinIndirectArgs {
  workgroup_count_x: u32,
  workgroup_count_y: u32,
  workgroup_count_z: u32,
};

struct OEngineShadingBinHeap {
  control: OEngineShadingBinControl,
  counters: array<OEngineShadingBinCounter, ${GPU_SHADING_BIN_COUNT}>,
  layouts: array<OEngineShadingBinLayout, ${GPU_SHADING_BIN_COUNT}>,
  records_alignment_padding: array<u32, ${(GPU_SHADING_BIN_RECORDS_OFFSET -
    (GPU_SHADING_BIN_LAYOUTS_OFFSET + GPU_SHADING_BIN_COUNT * GPU_SHADING_BIN_LAYOUT_STRIDE)) / 4}>,
  records: array<u32>,
};
`;

function validateGpuShadingBinSettings(settings: GpuShadingBinSettingsCpu): void {
  assertU32(settings.width, "Shading bin width");
  assertU32(settings.height, "Shading bin height");
  assertU32(settings.microtilesX, "Shading bin microtiles X");
  const expected = ceilDivide(settings.width, GPU_SHADING_BIN_MICROTILE_WIDTH);
  if (settings.microtilesX !== expected) {
    throw new RangeError(`Shading bin microtiles X ${settings.microtilesX} does not match ${expected}`);
  }
  assertNonZeroU32(settings.generation, "Shading bin generation");
  assertU32(settings.allowedMaskLo, "Shading bin allowed mask low");
  assertU32(settings.allowedMaskHi, "Shading bin allowed mask high");
  assertNonZeroU32(settings.maxDispatchDimension, "Shading bin max dispatch dimension");
  assertNonZeroU32(settings.layoutRevision, "Shading bin layout revision");
}

function validateGpuShadingBinControl(control: GpuShadingBinControlCpu): void {
  assertU32(control.frameFlags, "Shading bin frame flags");
  assertU32(control.errorCount, "Shading bin error count");
  assertU32(control.generatedMaskLo, "Shading bin generated mask low");
  assertU32(control.generatedMaskHi, "Shading bin generated mask high");
  assertU32(control.finalizedGeneration, "Shading bin finalized generation");
  assertU32(control.layoutRevision, "Shading bin control layout revision");
}

function validateGpuShadingBinCounter(
  counter: GpuShadingBinCounterCpu,
  requireClosure: boolean
): void {
  assertU32(counter.attemptedCount, "Shading bin attempted count");
  assertU32(counter.writtenCount, "Shading bin written count");
  assertU32(counter.overflowCount, "Shading bin overflow count");
  assertU32(counter.flags, "Shading bin counter flags");
  if (requireClosure && counter.attemptedCount !== counter.writtenCount + counter.overflowCount) {
    throw new RangeError("Shading bin counter must satisfy attempted = written + overflow");
  }
}

function validateGpuShadingBinLayout(layout: GpuShadingBinLayoutCpu): void {
  assertU32(layout.recordBase, "Shading bin record base");
  assertU32(layout.capacity, "Shading bin capacity");
  assertNonZeroU32(layout.revision, "Shading bin layout revision");
  assertU32(layout.flags, "Shading bin layout flags");
  const active = (layout.flags & GPU_SHADING_BIN_LAYOUT_FLAG.Active) !== 0;
  if (!active && (layout.capacity !== 0 || layout.recordBase !== 0)) {
    throw new RangeError("Inactive shading bin layouts must have zero base and capacity");
  }
}

function validateGpuShadingBinIndirectArgs(args: GpuShadingBinIndirectArgsCpu): void {
  assertU32(args.workgroupCountX, "Shading bin workgroup count X");
  assertU32(args.workgroupCountY, "Shading bin workgroup count Y");
  assertU32(args.workgroupCountZ, "Shading bin workgroup count Z");
}

function normalizeActiveBinIds(activeBinIds: readonly number[]): readonly number[] {
  const seen = new Set<number>();
  for (const binId of activeBinIds) {
    validateBinId(binId);
    decodeGpuShadingBinId(binId);
    if (seen.has(binId)) throw new RangeError(`Duplicate active ShadingBinId ${binId}`);
    seen.add(binId);
  }
  return Object.freeze([...seen].sort((left, right) => left - right));
}

function validateBinId(binId: number): void {
  if (!Number.isInteger(binId) || binId < 0 || binId >= GPU_SHADING_BIN_COUNT) {
    throw new RangeError(`ShadingBinId must be in [0, ${GPU_SHADING_BIN_COUNT - 1}]`);
  }
}

function packU32(values: readonly number[]): Uint8Array<ArrayBuffer> {
  for (const value of values) assertU32(value, "Packed shading bin field");
  return new Uint8Array(new Uint32Array(values).buffer);
}

function unpackU32(
  bytes: Uint8Array,
  byteOffset: number,
  byteLength: number,
  fieldCount: number,
  label: string
): number[] {
  assertByteRange(bytes, byteOffset, byteLength, label);
  const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset, byteLength);
  return Array.from({ length: fieldCount }, (_, index) => view.getUint32(index * 4, true));
}

function assertByteRange(bytes: Uint8Array, byteOffset: number, byteLength: number, label: string): void {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 ||
      byteOffset + byteLength > bytes.byteLength) {
    throw new RangeError(`${label} byte range is invalid`);
  }
}

function assertU32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${label} ${value} is outside u32`);
  }
}

function assertNonZeroU32(value: number, label: string): void {
  assertU32(value, label);
  if (value === 0) throw new RangeError(`${label} must be non-zero`);
}

function assertLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function assertRangeInclusive(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be in [${minimum}, ${maximum}]`);
  }
}

function checkedAdd(left: number, right: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) {
    throw new RangeError(`${label} operands must be non-negative safe integers`);
  }
  const result = left + right;
  if (!Number.isSafeInteger(result) || result > maximum) {
    throw new RangeError(`${label} exceeds ${maximum}`);
  }
  return result;
}

function checkedMultiply(left: number, right: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) {
    throw new RangeError(`${label} operands must be non-negative safe integers`);
  }
  const result = left * right;
  if (!Number.isSafeInteger(result) || result > maximum) {
    throw new RangeError(`${label} exceeds ${maximum}`);
  }
  return result;
}

function checkedIncrement(value: number, label: string): number {
  return checkedAdd(value, 1, 0xffffffff, label);
}

function ceilDivide(value: number, divisor: number): number {
  return value === 0 ? 0 : Math.floor((value - 1) / divisor) + 1;
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
