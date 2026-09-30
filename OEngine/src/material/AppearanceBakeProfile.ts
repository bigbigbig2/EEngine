import { evaluateCompiledAppearance } from "./AppearanceGraphEvaluation.js";
import { APPEARANCE_DEPENDENCY as D, selectAppearanceProductProgram } from "./AppearanceGraphCompiler.js";
import type { CompiledAppearanceGraph } from "./AppearanceGraphCompiler.js";
import type { AppearanceBakeOptions } from "./AppearanceMipCooker.js";

/** Shared static-domain admission and source filtering; no products/GPU ownership. */
export function prepareAppearanceBake(source: CompiledAppearanceGraph,
  roots: Readonly<Record<string, readonly number[]>>, options: AppearanceBakeOptions) {
  const program = selectAppearanceProductProgram(source, roots);
  if (program.productReads?.length) throw new RangeError("Appearance cook requires original source roots before product substitution");
  const dimensions = validateAppearanceBakeOptions(options);
  if (Object.keys(program.outputs).length === 0) throw new RangeError("Appearance cook needs fields");
  if (program.instructions.some(instruction => (instruction.dependency & (D.Geometry | D.Dynamic | D.View | D.Nonlocal)) !== 0)) {
    throw new RangeError("Appearance static cook excludes dynamic/geometry/view/nonlocal dependencies");
  }
  if (program.inputs.length > 1 || program.inputs.some(input => input.domain !== "surface" || input.width !== 2)) {
    throw new RangeError("Appearance cook requires a single two-channel coordinate domain");
  }
  const input = program.inputs[0];
  const coordinate = input === undefined ? null : program.instructions.flatMap((instruction, index) =>
    instruction.kind === "input" && instruction.input === input.name ? [{ index, channel: instruction.channel! }] : []);
  if (coordinate !== null && (!coordinate.some(c => c.channel === 0) || !coordinate.some(c => c.channel === 1))) {
    if (program.samples.length !== 0) throw new RangeError("Appearance source sampling requires both chart coordinates");
  }
  for (const sample of program.samples) {
    if (coordinate === null || sample.uv.some((ref, channel) => !coordinate.some(c => c.index === ref && c.channel === channel))) {
      throw new RangeError("Appearance cook profile requires direct chart UV plus each source's affine sampling transform");
    }
  }
  const domains = [...new Set(program.instructions.flatMap(instruction => instruction.coordinateDomains))];
  if (domains.length > 1) throw new RangeError("Appearance cook cannot merge multiple UV domains");
  if (input !== undefined && [...options.domainMin, ...options.domainMax].some(value =>
    Math.fround(value) < input.range.low || Math.fround(value) > input.range.high)) {
    throw new RangeError("Appearance cook domain violates the source coordinate range");
  }
  const span = options.domainMax.map((value, axis) => value - options.domainMin[axis]!) as [number, number];
  const coordinateAt = (x: number, y: number): readonly [number, number] =>
    [options.domainMin[0] + x * span[0], options.domainMin[1] + y * span[1]];
  const evaluate = (uv: readonly [number, number], lod: number) => evaluateCompiledAppearance(program, {
    inputs: input === undefined ? {} : { [input.name]: uv },
    sample: (binding, transformedUv) => {
      const c = Math.cos(binding.rotation), s = Math.sin(binding.rotation), lodScale = 2 ** lod;
      const x = span[0] / options.width * lodScale * binding.scale[0];
      const y = span[1] / options.height * lodScale * binding.scale[1];
      const ddx: readonly [number, number] = [Math.fround(c * x), Math.fround(s * x)];
      const ddy: readonly [number, number] = [Math.fround(-s * y), Math.fround(c * y)];
      if (![...ddx, ...ddy].every(Number.isFinite)) throw new RangeError("Appearance cook produced a nonfinite source footprint");
      return options.sample(binding, transformedUv, { chartLod: lod, ddx, ddy });
    }
  });
  return { program, dimensions, coordinateDomain: domains[0] ?? null, coordinateAt, evaluate };
}

export function validateAppearanceBakeOptions(options: AppearanceBakeOptions): readonly { width: number; height: number }[] {
  if (options.storagePrecision !== undefined && options.storagePrecision !== "float32" && options.storagePrecision !== "float16") {
    throw new RangeError("Unknown appearance storage precision");
  }
  for (const [name, value] of Object.entries({ width: options.width, height: options.height,
    mipCount: options.mipCount, byteBudget: options.byteBudget, validationProbeBudget: options.validationProbeBudget })) {
    if (!Number.isSafeInteger(value) || value < (name.endsWith("Budget") ? 0 : 1)) throw new RangeError(`Invalid appearance cook ${name}`);
  }
  if (options.width > 16384 || options.height > 16384 || options.mipCount > Math.floor(Math.log2(Math.max(options.width, options.height))) + 1) {
    throw new RangeError("Appearance cook dimensions/mips exceed its offline profile");
  }
  if (options.domainMin.length !== 2 || options.domainMax.length !== 2 ||
      ![...options.domainMin, ...options.domainMax].every(value => Number.isFinite(Math.fround(value))) ||
      options.domainMax.some((value, axis) => value <= options.domainMin[axis]!) ||
      options.domainMax.some((value, axis) => !Number.isFinite(Math.fround(value - options.domainMin[axis]!))) ||
      ![options.error.absolute, options.error.relative].every(value => Number.isFinite(value) && value >= 0)) {
    throw new RangeError("Invalid appearance cook domain/error budget");
  }
  return Array.from({ length: options.mipCount }, (_, level) => ({
    width: Math.max(1, Math.floor(options.width / 2 ** level)),
    height: Math.max(1, Math.floor(options.height / 2 ** level)) }));
}
