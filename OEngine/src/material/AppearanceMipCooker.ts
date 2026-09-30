import { evaluateCompiledAppearance } from "./AppearanceGraphEvaluation.js";
import { APPEARANCE_DEPENDENCY as D, selectAppearanceProductProgram } from "./AppearanceGraphCompiler.js";
import type { CompiledAppearanceGraph } from "./AppearanceGraphCompiler.js";
import type { AppearanceTextureBinding } from "./AppearanceGraph.js";
import { encodeFloat16, decodeFloat16 } from "../core/Float16.js";
import { prepareAppearanceBake } from "./AppearanceBakeProfile.js";
import type { AppearanceNormalFilterContract } from "./AppearanceNormalFilter.js";

export interface AppearanceSourceFootprint {
  readonly ddx: readonly [number, number];
  readonly ddy: readonly [number, number];
  readonly chartLod: number;
}
export interface AppearanceBakeBudget { readonly absolute: number; readonly relative: number }
export interface AppearanceBakeOptions {
  readonly width: number;
  readonly height: number;
  readonly mipCount: number;
  readonly byteBudget: number;
  readonly validationProbeBudget: number;
  readonly domainMin: readonly [number, number];
  readonly domainMax: readonly [number, number];
  readonly error: AppearanceBakeBudget;
  /** Quantize before the source-vs-product probes; never assert a pre-quantization budget afterward. */
  readonly storagePrecision?: "float32" | "float16";
  /** Source sampler performs its own decode/filter using the supplied transformed footprint. */
  readonly sample: (binding: AppearanceTextureBinding, uv: readonly [number, number],
    footprint: AppearanceSourceFootprint) => readonly number[];
}
export interface AppearanceCookedMip {
  readonly width: number;
  readonly height: number;
  /** Cooker-owned scene-linear f32 intermediate, to transfer into the asset packing owner. */
  readonly data: Float32Array;
}
export interface AppearanceCookedField {
  readonly width: number;
  readonly constant?: readonly number[];
  readonly mips: readonly AppearanceCookedMip[];
}
export interface AppearanceCookedProduct {
  readonly kind: "reevaluated-mip-fields" | "coupled-vmf-moments";
  readonly normalFilters?: readonly AppearanceNormalFilterContract[];
  /** Offline peak includes reference scratch, when an algorithm retains it. */
  readonly peakWorkingBytes?: number;
  readonly coordinateDomain: string | null;
  readonly domainMin: readonly [number, number];
  readonly domainMax: readonly [number, number];
  readonly fields: Readonly<Record<string, AppearanceCookedField>>;
  readonly allocatedBytes: number;
  readonly storagePrecision: "float32" | "float16";
  readonly errorBudget: AppearanceBakeBudget;
  readonly validation: {
    readonly filter: "bilinear-clamp-trilinear";
    readonly probeCount: number;
    readonly maxAbsoluteError: number;
    readonly maxBudgetRatio: number;
  };
}

/**
 * Local ReevaluatedMipAppearanceCooker profile (see next-renderer source ledger).
 * Each mip evaluates filtered source inputs at that mip's own footprint. It never
 * substitutes downsample(expression(level0)) for expression(filteredInputs).
 * A candidate is rejected when the explicit finite spatial/LOD probe budget is
 * exceeded. That is a tested filter contract, not a continuous-domain proof.
 * This is offline numeric cooking; no frame submit/readback/GPU lifetime here.
 */
export function cookAppearanceMipProduct(source: CompiledAppearanceGraph,
  roots: Readonly<Record<string, readonly number[]>>, options: AppearanceBakeOptions): AppearanceCookedProduct {
  const { program, dimensions, coordinateDomain, coordinateAt, evaluate } = prepareAppearanceBake(source, roots, options);
  const outputEntries = Object.entries(program.outputs);

  const fields: Record<string, AppearanceCookedField> = Object.create(null);
  let allocatedBytes = 0;
  const uniformRoots = Object.fromEntries(outputEntries.filter(([, refs]) =>
    refs.every(ref => (program.instructions[ref]!.dependency & ~D.Material) === 0)));
  const uniform = evaluateCompiledAppearance(selectAppearanceProductProgram(program, uniformRoots),
    { inputs: {}, sample: () => { throw new Error("Uniform appearance products have no source sample"); } });
  if (Object.values(uniform).some(values => values.some(value => !Number.isFinite(value)))) {
    throw new RangeError("Appearance cook has a nonfinite uniform field");
  }
  for (const [name, refs] of outputEntries) {
    const constant = refs.every(ref => (program.instructions[ref]!.dependency & ~D.Material) === 0);
    if (!constant) allocatedBytes += dimensions.reduce((sum, size) => sum + size.width * size.height * refs.length * 4, 0);
    fields[name] = { width: refs.length, constant: constant ? uniform[name] : undefined,
      mips: [] };
  }
  if (!Number.isSafeInteger(allocatedBytes) || allocatedBytes > options.byteBudget) {
    throw new RangeError(`Appearance cook requires ${allocatedBytes} bytes, budget ${options.byteBudget}`);
  }
  const variableFields = Object.values(fields).some(field => field.constant === undefined);
  const lods = variableFields ? Array.from({ length: options.mipCount * 2 - 1 }, (_, i) => i / 2) : [];
  const probeCount = lods.reduce((sum, lod) => {
    const size = dimensions[Math.floor(lod)]!;
    return sum + (size.width * 2 + 1) * (size.height * 2 + 1);
  }, 0);
  if (!Number.isSafeInteger(probeCount) || probeCount > options.validationProbeBudget) {
    throw new RangeError(`Appearance cook requires ${probeCount} probes, budget ${options.validationProbeBudget}`);
  }
  const mips: Record<string, AppearanceCookedMip[]> = Object.create(null);
  for (const [name] of outputEntries) mips[name] = [];
  for (let level = 0; variableFields && level < dimensions.length; level++) {
    const size = dimensions[level]!;
    for (const [name, field] of Object.entries(fields)) if (field.constant === undefined) {
      mips[name]!.push(Object.freeze({ ...size, data: new Float32Array(size.width * size.height * field.width) }));
    }
    for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
      const evaluated = evaluate(coordinateAt((x + 0.5) / size.width, (y + 0.5) / size.height), level);
      for (const [name, field] of Object.entries(fields)) if (field.constant === undefined) {
        const data = mips[name]![level]!.data;
        evaluated[name]!.forEach((value, channel) => {
          if (!Number.isFinite(value)) throw new RangeError(`Appearance cook '${name}' produced a nonfinite field`);
          const stored = options.storagePrecision === "float16" ? decodeFloat16(encodeFloat16(value)) : value;
          if (!Number.isFinite(stored)) throw new RangeError(`Appearance cook '${name}' exceeds finite storage precision`);
          data[(y * size.width + x) * field.width + channel] = stored;
        });
      }
    }
  }
  for (const [name, field] of Object.entries(fields)) fields[name] = Object.freeze({ ...field, mips: Object.freeze(mips[name]!) });
  let maxAbsoluteError = 0, maxBudgetRatio = 0;
  for (const lod of lods) {
    const size = dimensions[Math.floor(lod)]!;
    for (let y = 0; y <= size.height * 2; y++) for (let x = 0; x <= size.width * 2; x++) {
      const u = x / (size.width * 2), v = y / (size.height * 2);
      const expected = evaluate(coordinateAt(u, v), lod);
      for (const [name, field] of Object.entries(fields)) {
        const actual = sampleAppearanceCookedField(field, u, v, lod);
        actual.forEach((value, channel) => {
          const reference = expected[name]![channel]!;
          if (!Number.isFinite(reference)) throw new RangeError(`Appearance cook '${name}' validation produced a nonfinite field`);
          const error = Math.abs(value - reference), bound = options.error.absolute + options.error.relative * Math.abs(reference);
          const ratio = bound === 0 ? error === 0 ? 0 : Infinity : error / bound;
          maxAbsoluteError = Math.max(maxAbsoluteError, error); maxBudgetRatio = Math.max(maxBudgetRatio, ratio);
        });
      }
    }
  }
  if (maxBudgetRatio > 1) throw new RangeError(`Appearance cooked filtering exceeds quality budget: ratio ${maxBudgetRatio}, absolute ${maxAbsoluteError}`);
  return Object.freeze({ kind: "reevaluated-mip-fields", coordinateDomain,
    domainMin: Object.freeze([...options.domainMin]) as readonly [number, number],
    domainMax: Object.freeze([...options.domainMax]) as readonly [number, number], fields: Object.freeze({ ...fields }), allocatedBytes,
    storagePrecision: options.storagePrecision ?? "float32", errorBudget: Object.freeze({ ...options.error }),
    validation: Object.freeze({ filter: "bilinear-clamp-trilinear", probeCount, maxAbsoluteError, maxBudgetRatio }) });
}

/** CPU reference for the declared cooked filter, using normalized product coordinates. */
export function sampleAppearanceCookedField(field: AppearanceCookedField, u: number, v: number, lod: number): readonly number[] {
  if (field.constant !== undefined) return field.constant;
  const boundedLod = Math.min(Math.max(lod, 0), field.mips.length - 1);
  const low = Math.floor(boundedLod), high = Math.min(low + 1, field.mips.length - 1);
  const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t;
  const at = (level: number, channel: number): number => {
    const mip = field.mips[level]!;
    const px = Math.min(Math.max(u * mip.width - 0.5, 0), mip.width - 1);
    const py = Math.min(Math.max(v * mip.height - 0.5, 0), mip.height - 1);
    const x0 = Math.floor(px), y0 = Math.floor(py), x1 = Math.min(x0 + 1, mip.width - 1), y1 = Math.min(y0 + 1, mip.height - 1);
    const read = (x: number, y: number) => mip.data[(y * mip.width + x) * field.width + channel]!;
    return mix(mix(read(x0, y0), read(x1, y0), px - x0), mix(read(x0, y1), read(x1, y1), px - x0), py - y0);
  };
  return Array.from({ length: field.width }, (_, channel) => Math.fround(mix(at(low, channel), at(high, channel), boundedLod - low)));
}
