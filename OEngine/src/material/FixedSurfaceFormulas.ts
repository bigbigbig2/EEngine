import type { CompiledAppearanceGraph, AppearanceInstruction } from "./AppearanceGraphCompiler.js";
import type { AppearanceWgslProgram } from "../shaders/appearance_program.js";
import { appearanceGeometryInputKind } from "../shaders/appearance_demand_inputs.js";
import { APPEARANCE_FIELD_NAMES, APPEARANCE_FIELD_WIDTHS } from "../gpu/GpuAppearanceFieldAbi.js";

export const FIXED_SURFACE_FLAG = 0x80000000;
export const FIXED_SURFACE_SAMPLE_COUNT = 15;
export const FIXED_SURFACE_SAMPLE_WORDS = 4;
export const FIXED_SURFACE_FIELD_WORDS = 6;
export const FIXED_SURFACE_PLAN_WORDS = 256;
export const FIXED_SURFACE_FIELDS_BASE = FIXED_SURFACE_SAMPLE_COUNT * FIXED_SURFACE_SAMPLE_WORDS;

/** These are complete, field-specific formula selections, not instructions or
 * temporary slots. No formula references another formula. Unmatched graphs
 * retain their entire exact DAG; parameter values do not choose a formula. */
export const FIXED_SURFACE_FORMULA = Object.freeze({
  leaf: 0,
  scaled: 1,
  colored: 2,
  bounded: 3,
  occlusion: 4,
  normalScaled: 5,
  normalSigned: 6,
  boundedLeaf: 7
});

export function compileFixedSurfaceFormulas(
  program: CompiledAppearanceGraph,
  lowered: AppearanceWgslProgram,
  uniformRefs?: ReadonlyMap<number, number>
): Uint32Array | null {
  const words = new Uint32Array(FIXED_SURFACE_PLAN_WORDS);
  const samples = new Map<string, number>();
  const instruction = (ref: number): AppearanceInstruction => program.instructions[ref]!;
  const operation = (ref: number, name: string): readonly number[] | null => {
    const node = instruction(ref);
    return node.kind === "operation" && node.op === name ? node.args : null;
  };
  const literal = (ref: number, value: number): boolean => {
    const node = instruction(ref);
    return node.kind === "constant" && Object.is(node.value, value);
  };
  const sample = (ref: number, field: number): number | null => {
    const node = instruction(ref);
    const product = node.kind !== "texture";
    const index = product ? node.product! : node.sample!;
    const read = product ? program.productReads![index]! : undefined;
    const key = `${product ? "product" : "texture"}:${index}`;
    let slot = samples.get(key);
    if (slot === undefined) {
      if (samples.size >= FIXED_SURFACE_SAMPLE_COUNT) {
        return null;
      }
      let semantic = 0;
      if (read?.field.constant === undefined) {
        const uv = product ? read!.uv! : program.samples[index]!.uv;
        const u = instruction(uv[0]);
        const v = instruction(uv[1]);
        if (
          u.kind !== "input" ||
          v.kind !== "input" ||
          u.input !== v.input ||
          u.channel !== 0 ||
          v.channel !== 1
        ) {
          return null;
        }
        const input = program.inputs.find((input) => input.name === u.input)!;
        semantic = appearanceGeometryInputKind(input, program);
        if (semantic < 1 || semantic > 3) {
          return null;
        }
      }
      slot = samples.size;
      samples.set(key, slot);
      const base = slot * FIXED_SURFACE_SAMPLE_WORDS;
      words[base] = product ? (read!.field.constant === undefined ? 1 : 2) : 0;
      words[base + 1] = read?.field.constant === undefined ? index : lowered.productConstantSlots[index]![0]!;
      words[base + 2] = semantic;
      if (read?.field.constant !== undefined) {
        words[base] = words[base]! | (read.field.width << 16);
      }
    }
    const base = slot * FIXED_SURFACE_SAMPLE_WORDS;
    words[base + 3] = words[base + 3]! | (1 << field);
    if (node.kind === "normal-product") {
      words[base] = words[base]! | 256;
    }
    return ((node.kind === "normal-product" ? 3 : 2) * 0x10000000 + slot * 8 + node.channel!) >>> 0;
  };
  const leaf = (ref: number, field: number): number | null => {
    const uniform = uniformRefs?.get(ref);
    if (uniform !== undefined) {
      return uniform < 0x10000000 ? (5 * 0x10000000 + uniform) >>> 0 : null;
    }
    const node = instruction(ref);
    if (node.kind === "constant" || node.kind === "parameter") {
      const address = lowered.instructionConstantSlots[ref]!;
      // The complete Generic address is u32. Fixed leaf references reserve
      // four tag bits; an unrepresentable address must select Generic intact.
      return address < 0x10000000 ? address : null;
    }
    if (node.kind === "input") {
      const index = program.inputs.findIndex((input) => input.name === node.input);
      const semantic = appearanceGeometryInputKind(program.inputs[index]!, program);
      // Fixed Standard/Unlit formulas use UV/color and numeric inputs. Other
      // geometry/view expressions retain the complete Generic input closure.
      if (semantic > 4) {
        return null;
      }
      return (
        ((semantic === 0 ? 4 : 1) * 0x10000000 +
          (semantic === 0 ? index : semantic) * 256 +
          node.channel!) >>>
        0
      );
    }
    if (node.kind === "texture" || node.kind === "product" || node.kind === "normal-product") {
      return sample(ref, field);
    }
    return null;
  };
  const leaves = (refs: readonly number[], field: number): number[] | null => {
    const values = refs.map((ref) => leaf(ref, field));
    return values.every((value): value is number => value !== null) ? values : null;
  };
  const root = (ref: number, field: number): number[] | null => {
    const direct = leaf(ref, field);
    if (direct !== null) {
      return [FIXED_SURFACE_FORMULA.leaf, direct];
    }
    const multiply = operation(ref, "multiply");
    if (multiply !== null) {
      const pair = leaves(multiply, field);
      if (pair !== null) {
        return [FIXED_SURFACE_FORMULA.scaled, ...pair];
      }
      if (field === 0) {
        const first = operation(multiply[0]!, "multiply");
        const triple = first === null ? null : leaves([...first, multiply[1]!], field);
        if (triple !== null) {
          return [FIXED_SURFACE_FORMULA.colored, ...triple];
        }
      }
    }
    if (field === 2 || field === 3) {
      const clamp = operation(ref, "clamp");
      if (clamp !== null && literal(clamp[1]!, 0) && literal(clamp[2]!, 1)) {
        const direct = leaf(clamp[0]!, field);
        if (direct !== null) {
          return [FIXED_SURFACE_FORMULA.boundedLeaf, direct];
        }
        const scale = operation(clamp[0]!, "multiply");
        const pair = scale === null ? null : leaves(scale, field);
        if (pair !== null) {
          return [FIXED_SURFACE_FORMULA.bounded, ...pair];
        }
      }
    }
    if (field === 4) {
      const mix = operation(ref, "mix");
      if (mix !== null) {
        const triple = leaves(mix, field);
        if (triple !== null) {
          return [FIXED_SURFACE_FORMULA.occlusion, ...triple];
        }
      }
    }
    if (field === 6 || field === 12) {
      const signedRef = multiply === null ? ref : multiply[0]!;
      const subtract = operation(signedRef, "subtract");
      if (subtract !== null && literal(subtract[1]!, 1)) {
        const twice = operation(subtract[0]!, "multiply");
        if (twice !== null && literal(twice[1]!, 2)) {
          const refs = multiply === null ? [twice[0]!] : [twice[0]!, multiply[1]!];
          const values = leaves(refs, field);
          if (values !== null) {
            return [
              multiply === null ? FIXED_SURFACE_FORMULA.normalSigned : FIXED_SURFACE_FORMULA.normalScaled,
              ...values
            ];
          }
        }
      }
    }
    return null;
  };
  let output = 0;
  for (let field = 0; field < APPEARANCE_FIELD_NAMES.length; field++) {
    const roots = program.outputs[APPEARANCE_FIELD_NAMES[field]!];
    for (let channel = 0; channel < APPEARANCE_FIELD_WIDTHS[field]!; channel++, output++) {
      if (roots === undefined) {
        continue;
      }
      const formula = root(roots[channel]!, field);
      if (formula === null) {
        return null;
      }
      words.set(formula, FIXED_SURFACE_FIELDS_BASE + output * FIXED_SURFACE_FIELD_WORDS);
    }
  }
  words[FIXED_SURFACE_PLAN_WORDS - 1] = samples.size;
  return words;
}
