import { APPEARANCE_DEPENDENCY as D } from "./AppearanceGraphCompiler.js";
import type { CompiledAppearanceGraph } from "./AppearanceGraphCompiler.js";
import { prepareAppearanceBake } from "./AppearanceBakeProfile.js";
import { sampleAppearanceCookedField } from "./AppearanceMipCooker.js";
import type {
  AppearanceBakeOptions,
  AppearanceCookedField,
  AppearanceCookedProduct,
} from "./AppearanceMipCooker.js";
import {
  APPEARANCE_NORMAL_FILTER_MODEL,
  encodeAppearanceNormalMoment,
  decodeAppearanceNormalMoment,
  referenceAppearanceNormalMoment,
  type AppearanceNormalFilterContract,
} from "./AppearanceNormalFilter.js";
import { encodeFloat16, decodeFloat16 } from "../core/Float16.js";
import { appearanceFieldIdentity } from "./AppearanceFieldIdentity.js";

export interface AppearanceNormalBakePair {
  readonly momentField: string;
  readonly normalOutput: string;
  readonly roughnessOutput: string;
  readonly normal: readonly number[];
  readonly roughness: readonly number[];
  readonly maxAngleRadians: number;
  readonly maxRoughnessError: number;
}

/**
 * CoupledVmfAppearanceFilter, offline single-chart profile. Base/coat independent.
 * Evaluate the complete signed normal/roughness subgraph on the base lattice;
 * average JOINT moments with exact area weights, never normalized mip normals.
 * Filtered texture moments retain variance through fractional LOD and spatial
 * interpolation. This is a new declared filter; it is not the old source's
 * filter-before-expression contract. Full source-lattice and fit errors are
 * accounted explicitly; continuous unsampled detail is not proved by probes.
 */
export function cookAppearanceNormalProduct(
  source: CompiledAppearanceGraph,
  pairs: readonly AppearanceNormalBakePair[],
  options: AppearanceBakeOptions,
): AppearanceCookedProduct {
  const names = new Set<string>(),
    outputs = new Set<string>();
  if (pairs.length === 0) throw new RangeError("Appearance normal cook needs pairs");
  const roots: Record<string, readonly number[]> = Object.create(null);
  pairs.forEach((pair, i) => {
    if (
      !pair.momentField ||
      !pair.normalOutput ||
      !pair.roughnessOutput ||
      names.has(pair.momentField) ||
      outputs.has(pair.normalOutput) ||
      outputs.has(pair.roughnessOutput) ||
      pair.normalOutput === pair.roughnessOutput ||
      pair.normal.length !== 3 ||
      pair.roughness.length !== 1 ||
      ![pair.maxAngleRadians, pair.maxRoughnessError].every((n) => Number.isFinite(n) && n >= 0) ||
      pair.maxAngleRadians > Math.PI
    ) {
      throw new RangeError("Invalid Appearance normal pair/filter budget");
    }
    names.add(pair.momentField);
    outputs.add(pair.normalOutput);
    outputs.add(pair.roughnessOutput);
    roots[`normal${i}`] = pair.normal;
    roots[`roughness${i}`] = pair.roughness;
  });
  const { program, dimensions, coordinateDomain, coordinateAt, evaluate } = prepareAppearanceBake(
    source,
    roots,
    options,
  );
  const uniform = pairs.map((_, i) =>
    [...program.outputs[`normal${i}`]!, ...program.outputs[`roughness${i}`]!].every(
      (ref) => (program.instructions[ref]!.dependency & ~D.Material) === 0,
    ),
  );
  const texels = dimensions.reduce((sum, size) => sum + size.width * size.height, 0);
  const variableCount = uniform.filter((v) => !v).length;
  const allocatedBytes = variableCount * texels * 3 * 4;
  // Double reference chain remains alive during probing, in addition to stored f32 intermediates.
  const baseTexels = options.width * options.height;
  const peakWorkingBytes =
    allocatedBytes + (variableCount * baseTexels + (variableCount > 0 ? texels - baseTexels : 0)) * 3 * 8;
  const lods = Array.from({ length: options.mipCount * 2 - 1 }, (_, i) => i / 2);
  const probeCount =
    variableCount === 0
      ? pairs.length
      : pairs.length *
        lods.reduce((sum, lod) => {
          const size = dimensions[Math.floor(lod)]!;
          return sum + (size.width * 2 + 1) * (size.height * 2 + 1);
        }, 0);
  if (!Number.isSafeInteger(peakWorkingBytes) || peakWorkingBytes > options.byteBudget) {
    throw new RangeError(
      `Appearance normal cook requires ${peakWorkingBytes} peak bytes, budget ${options.byteBudget}`,
    );
  }
  if (!Number.isSafeInteger(probeCount) || probeCount > options.validationProbeBudget) {
    throw new RangeError(
      `Appearance normal cook requires ${probeCount} probes, budget ${options.validationProbeBudget}`,
    );
  }
  const baseValues = pairs.map((_, i) => new Float64Array(uniform[i] ? 0 : baseTexels * 3));
  const constants: (readonly number[] | undefined)[] = pairs.map(() => undefined);
  const getMoments = (u: number, v: number) => {
    const result = evaluate(coordinateAt(u, v), 0);
    return pairs.map((_, i) =>
      encodeAppearanceNormalMoment(result[`normal${i}`]!, result[`roughness${i}`]![0]!),
    );
  };
  if (variableCount === 0) {
    getMoments(0.5, 0.5).forEach((moment, i) => {
      constants[i] = moment;
    });
  } else {
    for (let y = 0; y < options.height; y++)
      for (let x = 0; x < options.width; x++) {
        getMoments((x + 0.5) / options.width, (y + 0.5) / options.height).forEach((moment, i) => {
          if (uniform[i]) constants[i] ??= moment;
          else baseValues[i]!.set(moment, (y * options.width + x) * 3);
        });
      }
  }
  const fields: Record<string, AppearanceCookedField> = Object.create(null);
  const contracts: AppearanceNormalFilterContract[] = [];
  const referenceScratch = new Float64Array(variableCount > 0 ? (texels - baseTexels) * 3 : 0);
  let maxAbsoluteError = 0,
    maxBudgetRatio = 0;
  for (const [i, pair] of pairs.entries()) {
    let scratchOffset = 0;
    const reference = uniform[i]
      ? { width: 3, constant: constants[i], mips: [] }
      : {
          width: 3,
          mips: dimensions.map((size, level) => {
            if (level === 0) return { ...size, data: baseValues[i]! };
            const destination = referenceScratch.subarray(
              scratchOffset,
              scratchOffset + size.width * size.height * 3,
            );
            scratchOffset += destination.length;
            return {
              ...size,
              data: areaAverageBase(
                baseValues[i]!,
                options.width,
                options.height,
                size.width,
                size.height,
                destination,
              ),
            };
          }),
        };
    const sourceIdentity = appearanceFieldIdentity(source, [...pair.normal, ...pair.roughness]);
    const field: AppearanceCookedField = uniform[i]
      ? Object.freeze({
          width: 3,
          sourceIdentity,
          constant: Object.freeze(constants[i]!.map(Math.fround)),
          mips: Object.freeze([]),
        })
      : Object.freeze({
          width: 3,
          sourceIdentity,
          mips: Object.freeze(
            reference.mips.map((mip) =>
              Object.freeze({
                width: mip.width,
                height: mip.height,
                data: Float32Array.from(mip.data, (value) =>
                  options.storagePrecision === "float16"
                    ? decodeFloat16(encodeFloat16(value))
                    : Math.fround(value),
                ),
              }),
            ),
          ),
        });
    fields[pair.momentField] = field;
    let maxAngle = 0,
      maxRoughness = 0;
    const probe = (u: number, v: number, lod: number) => {
      const original = sampleReferenceMoment(reference, u, v, lod);
      const stored = sampleAppearanceCookedField(field, u, v, lod);
      const expected = referenceAppearanceNormalMoment(original),
        actual = decodeAppearanceNormalMoment(stored);
      const angularError =
        expected.directionValid !== actual.directionValid
          ? Math.PI
          : !expected.directionValid
            ? 0
            : angle(expected.normal, actual.normal);
      const roughnessError = Math.abs(expected.roughness - actual.roughness);
      maxAngle = Math.max(maxAngle, angularError);
      maxRoughness = Math.max(maxRoughness, roughnessError);
      maxBudgetRatio = Math.max(
        maxBudgetRatio,
        budgetRatio(angularError, pair.maxAngleRadians),
        budgetRatio(roughnessError, pair.maxRoughnessError),
      );
      stored.forEach((value, channel) => {
        const error = Math.abs(value - original[channel]!);
        maxAbsoluteError = Math.max(maxAbsoluteError, error);
        maxBudgetRatio = Math.max(
          maxBudgetRatio,
          budgetRatio(error, options.error.absolute + options.error.relative * Math.abs(original[channel]!)),
        );
      });
    };
    if (variableCount === 0) probe(0.5, 0.5, 0);
    else
      for (const lod of lods) {
        const size = dimensions[Math.floor(lod)]!;
        for (let y = 0; y <= size.height * 2; y++)
          for (let x = 0; x <= size.width * 2; x++) {
            probe(x / (size.width * 2), y / (size.height * 2), lod);
          }
      }
    contracts.push(
      Object.freeze({
        model: APPEARANCE_NORMAL_FILTER_MODEL,
        momentField: pair.momentField,
        normalOutput: pair.normalOutput,
        roughnessOutput: pair.roughnessOutput,
        maxAngleRadians: pair.maxAngleRadians,
        maxRoughnessError: pair.maxRoughnessError,
        measuredAngleRadians: maxAngle,
        measuredRoughnessError: maxRoughness,
      }),
    );
  }
  if (maxBudgetRatio > 1)
    throw new RangeError(`Appearance normal filtering exceeds quality budget: ratio ${maxBudgetRatio}`);
  return Object.freeze({
    kind: "coupled-vmf-moments",
    coordinateDomain,
    domainMin: Object.freeze([...options.domainMin]) as readonly [number, number],
    domainMax: Object.freeze([...options.domainMax]) as readonly [number, number],
    fields: Object.freeze(fields),
    normalFilters: Object.freeze(contracts),
    allocatedBytes,
    peakWorkingBytes,
    storagePrecision: options.storagePrecision ?? "float32",
    errorBudget: Object.freeze({ ...options.error }),
    validation: Object.freeze({
      filter: "bilinear-clamp-trilinear",
      probeCount,
      maxAbsoluteError,
      maxBudgetRatio,
    }),
  });
}

/** NPOT area box from the original lattice; includes every base texel with its exact overlap. */
function areaAverageBase(
  base: Float64Array,
  width: number,
  height: number,
  tw: number,
  th: number,
  data: Float64Array,
): Float64Array {
  data.fill(0);
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      const left = (x * width) / tw,
        right = ((x + 1) * width) / tw;
      const top = (y * height) / th,
        bottom = ((y + 1) * height) / th;
      const area = (right - left) * (bottom - top);
      for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++)
        for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
          const weight =
            ((Math.min(right, sx + 1) - Math.max(left, sx)) *
              (Math.min(bottom, sy + 1) - Math.max(top, sy))) /
            area;
          for (let channel = 0; channel < 3; channel++)
            data[(y * tw + x) * 3 + channel]! += base[(sy * width + sx) * 3 + channel]! * weight;
        }
    }
  return data;
}

/** Double filter oracle, separate from the f32 product sampler. */
function sampleReferenceMoment(
  field: {
    constant?: readonly number[];
    mips: readonly { width: number; height: number; data: Float64Array }[];
  },
  u: number,
  v: number,
  lod: number,
): readonly number[] {
  if (field.constant !== undefined) return field.constant;
  const clamped = Math.min(Math.max(lod, 0), field.mips.length - 1),
    low = Math.floor(clamped);
  const at = (level: number, channel: number) => {
    const mip = field.mips[level]!;
    const px = Math.min(Math.max(u * mip.width - 0.5, 0), mip.width - 1),
      py = Math.min(Math.max(v * mip.height - 0.5, 0), mip.height - 1);
    const x = Math.floor(px),
      y = Math.floor(py),
      tx = px - x,
      ty = py - y;
    const read = (ix: number, iy: number) => mip.data[(iy * mip.width + ix) * 3 + channel]!;
    return (
      read(x, y) * (1 - tx) * (1 - ty) +
      read(Math.min(x + 1, mip.width - 1), y) * tx * (1 - ty) +
      read(x, Math.min(y + 1, mip.height - 1)) * (1 - tx) * ty +
      read(Math.min(x + 1, mip.width - 1), Math.min(y + 1, mip.height - 1)) * tx * ty
    );
  };
  return Array.from(
    { length: 3 },
    (_, channel) =>
      at(low, channel) * (1 - (clamped - low)) +
      at(Math.min(low + 1, field.mips.length - 1), channel) * (clamped - low),
  );
}
function budgetRatio(error: number, budget: number): number {
  return budget === 0 ? (error === 0 ? 0 : Infinity) : error / budget;
}
function angle(a: readonly number[], b: readonly number[]): number {
  const cross = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  return Math.atan2(
    Math.hypot(...cross),
    a.reduce((sum, n, i) => sum + n * b[i]!, 0),
  );
}
