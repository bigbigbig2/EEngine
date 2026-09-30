import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import type { AppearanceOp } from "../material/AppearanceGraph.js";

export interface AppearanceWgslProgram {
  /** Straight-line function; the owner supplies the three declared integration callbacks. */
  readonly source: string;
  /** Topology + input/sampling semantics, excluding instance values/resources. */
  readonly templateKey: string;
  readonly constants: readonly number[];
  readonly outputSlots: Readonly<Record<string, readonly number[]>>;
  readonly outputCount: number;
  readonly parameterSlots: Readonly<Record<string, readonly Readonly<{ slot: number; channel: number }>[]>>;
}

/**
 * Local lowering of the validated numeric IR, not a GPU bytecode interpreter.
 * No workgroup state/atomics, no runtime role/node loops, no derivatives implicit
 * in divergent control. Sampling callbacks must use explicit footprint/LOD and
 * the publication snapshot's transform, sampler and decode. Device baseline f32.
 * Scheduling and bounded asynchronous pipeline admission belong to the owner.
 */
export function lowerAppearanceWgsl(program: CompiledAppearanceGraph): AppearanceWgslProgram {
  const constants: number[] = [];
  const inputSlots = new Map(program.inputs.map((input, index) => [input.name, index]));
  const lines: string[] = [];
  const sampled = new Set<number>();
  const expressions: string[] = [];
  const parameterSlots: Record<string, { slot: number; channel: number }[]> = Object.create(null);
  let variable = 0;
  const expression = (id: number): string => expressions[id]!;
  for (let id = 0; id < program.instructions.length; id++) {
    const instruction = program.instructions[id]!;
    if (instruction.kind === "constant" || instruction.kind === "parameter") {
      if (instruction.parameter !== undefined) {
        (parameterSlots[instruction.parameter] ??= []).push({ slot: constants.length, channel: instruction.channel! });
      }
      expressions.push(`appearance_constant(${constants.length}u)`);
      constants.push(instruction.value!);
      continue;
    }
    let value: string;
    if (instruction.kind === "input") {
      value = `appearance_input(${inputSlots.get(instruction.input!)}u, ${instruction.channel}u)`;
    } else if (instruction.kind === "texture") {
      const sample = instruction.sample!;
      if (!sampled.has(sample)) {
        const uv = program.samples[sample]!.uv;
        lines.push(`  let texture_${sample} = appearance_sample_${sample}(vec2f(${expression(uv[0])}, ${expression(uv[1])}));`);
        sampled.add(sample);
      }
      value = `texture_${sample}.${"rgba"[instruction.channel!]}`;
    } else {
      value = operationWgsl(instruction.op!, instruction.args.map(expression));
    }
    const name = `value_${variable++}`;
    expressions.push(name);
    lines.push(`  let ${name}: f32 = ${value};`);
  }
  const outputSlots: Record<string, readonly number[]> = Object.create(null);
  const results: string[] = [];
  for (const [name, refs] of Object.entries(program.outputs)) {
    outputSlots[name] = Object.freeze(refs.map(ref => {
      const slot = results.length; results.push(expression(ref)); return slot;
    }));
  }
  const outputCount = results.length;
  // A zero-demand program has no dispatch consumer; WGSL still needs a nonzero array size.
  const width = Math.max(outputCount, 1);
  const source = `fn appearance_evaluate() -> array<f32, ${width}> {\n${lines.join("\n")}\n` +
    `  return array<f32, ${width}>(${results.length === 0 ? "0.0" : results.join(", ")});\n}\n`;
  const templateKey = JSON.stringify([source,
    program.inputs.map(input => [input.width, input.domain]),
    program.samples.map(sample => [sample.binding.decode, sample.readMask])]);
  return Object.freeze({ source, templateKey, constants: Object.freeze(constants),
    outputSlots: Object.freeze({ ...outputSlots }), outputCount,
    parameterSlots: Object.freeze(Object.fromEntries(Object.entries(parameterSlots).map(([name, slots]) =>
      [name, Object.freeze(slots.map(slot => Object.freeze(slot)))]))) });
}

function operationWgsl(op: AppearanceOp, args: readonly string[]): string {
  const [a, b, c] = args;
  switch (op) {
    case "add": return `(${a} + ${b})`;
    case "subtract": return `(${a} - ${b})`;
    case "multiply": return `(${a} * ${b})`;
    case "divide": return `(${a} / ${b})`;
    case "min": case "max": case "pow": return `${op}(${a}, ${b})`;
    case "sin": case "cos": case "abs": case "sqrt": return `${op}(${a})`;
    case "clamp": return `clamp(${a}, ${b}, ${c})`;
    // Keep the explicitly rounded scalar IR sequence; do not silently change to a fused lerp.
    case "mix": return `((${a} * (1.0 - ${c})) + (${b} * ${c}))`;
  }
}
