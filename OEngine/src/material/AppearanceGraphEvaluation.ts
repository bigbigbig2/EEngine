import { evaluateAppearanceOperation } from "./AppearanceGraph.js";
import type { AppearanceTextureBinding } from "./AppearanceGraph.js";
import type { CompiledAppearanceGraph } from "./AppearanceGraphCompiler.js";

export interface AppearanceEvaluationContext {
  readonly inputs: Readonly<Record<string, readonly number[]>>;
  /** Sample/decode/filter at transformed UV. Never decode RGB alpha as sRGB. */
  readonly sample: (binding: AppearanceTextureBinding, uv: readonly [number, number]) => readonly number[];
}

/** CPU product/oracle execution. GPU consumers use lowering, not this interpreter. */
export function evaluateCompiledAppearance(program: CompiledAppearanceGraph,
  context: AppearanceEvaluationContext): Readonly<Record<string, readonly number[]>> {
  const values: number[] = [];
  const sampled = new Map<number, readonly number[]>();
  for (const input of program.inputs) {
    const value = context.inputs[input.name];
    if (value === undefined || value.length !== input.width || !value.every(component =>
      Number.isFinite(Math.fround(component)) && Math.fround(component) >= input.range.low && Math.fround(component) <= input.range.high)) {
      throw new RangeError(`Appearance input '${input.name}' violates its publication contract`);
    }
  }
  for (const instruction of program.instructions) {
    switch (instruction.kind) {
      case "constant": values.push(instruction.value!); break;
      case "input": values.push(Math.fround(context.inputs[instruction.input!]![instruction.channel!]!)); break;
      case "texture": {
        let texel = sampled.get(instruction.sample!);
        if (texel === undefined) {
          const sample = program.samples[instruction.sample!]!;
          const binding = sample.binding;
          const f = Math.fround;
          const u = f(values[sample.uv[0]]! * f(binding.scale[0]));
          const v = f(values[sample.uv[1]]! * f(binding.scale[1]));
          const c = f(Math.cos(binding.rotation)), s = f(Math.sin(binding.rotation));
          const transformed: readonly [number, number] = [f(f(binding.offset[0]) + f(f(c * u) - f(s * v))),
            f(f(binding.offset[1]) + f(f(s * u) + f(c * v)))];
          if (!transformed.every(Number.isFinite)) throw new RangeError("Appearance sampling produced a nonfinite UV");
          texel = context.sample(binding, transformed);
          if (texel.length !== 4 || !texel.every(value => Number.isFinite(value) &&
            value >= binding.range.low && value <= binding.range.high)) {
            throw new RangeError("Appearance sampler violates its finite source range contract");
          }
          sampled.set(instruction.sample!, texel.map(f));
        }
        values.push(texel[instruction.channel!]!); break;
      }
      case "operation": values.push(evaluateAppearanceOperation(instruction.op!, instruction.args.map(arg => values[arg]!))); break;
    }
  }
  return Object.freeze(Object.fromEntries(Object.entries(program.outputs).map(([name, refs]) =>
    [name, Object.freeze(refs.map(ref => values[ref]!))])));
}
