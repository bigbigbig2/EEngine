import type {
  CompiledAppearanceGraph,
  CompiledAppearanceInput
} from "../material/AppearanceGraphCompiler.js";
import { APPEARANCE_DEPENDENCY as DEPENDENCY } from "../material/AppearanceGraphCompiler.js";
import { operationWgsl } from "./appearance_operations.js";
import { APPEARANCE_NORMAL_FILTER_WGSL } from "./appearance_normal_filter.js";

export interface NativeMaterialProgram {
  readonly source: string;
  /** Complete structural key. Instance numbers, texture objects and content versions are data. */
  readonly key: string;
  readonly constants: readonly number[];
  readonly parameterSlots: Readonly<
    Record<string, readonly Readonly<{ slot: number; channel: number; low: number; high: number }>[]>
  >;
  readonly outputs: Readonly<Record<string, readonly number[]>>;
  readonly outputCount: number;
  readonly inputCount: number;
  readonly inputs: readonly CompiledAppearanceInput[];
  readonly textureQueries: readonly number[];
  readonly productQueries: readonly number[];
  /** Six f32 words per source query: offset.xy, scale.xy, cos/sin(rotation). */
  readonly sampleTransformSlots: readonly number[];
  /** Dependency unions are retained; no persistent uniform store is introduced here. */
  readonly dependencies: readonly number[];
  /** Real dependency classes, evaluated inline until a consumer requests an update product. */
  readonly frequencies: readonly NativeMaterialFrequency[];
  /** Binding helper's finite resource change detector; never used as exact identity. */
  readonly resourceRevision?: number;
}

export type NativeMaterialFrequency = "constant" | "material" | "dynamic" | "resource" | "sample";

function nativeFrequency(dependency: number): NativeMaterialFrequency {
  if (
    (dependency & (DEPENDENCY.Surface | DEPENDENCY.Geometry | DEPENDENCY.View | DEPENDENCY.Nonlocal)) !==
    0
  ) {
    return "sample";
  }
  if ((dependency & DEPENDENCY.Dynamic) !== 0) {
    return "dynamic";
  }
  if ((dependency & DEPENDENCY.Texture) !== 0) {
    return "resource";
  }
  return (dependency & DEPENDENCY.Material) !== 0 ? "material" : "constant";
}

/**
 * S1 local native backend. Straight-line scalar IR, no Tape, cache, field masks,
 * private interpreter arrays, barriers or atomics. Only coordinate ancestors
 * evaluate C/X/Y. Texture-driven coordinates retain three explicit samples and
 * the same finite-difference footprint at all three points.
 *
 * Integration supplies native_material_constant(base, slot), and statically
 * named native_material_sample_N(base, uv, dx, dy) / product_N callbacks. These
 * callbacks own the immutable route, sampler, decode and LOD contract. Source
 * UV transforms are instance constants emitted here, including their gradients.
 * Inputs are already recovered by the Geometry/view owner. No implicit dpdx.
 */
export function lowerNativeMaterial(program: CompiledAppearanceGraph): NativeMaterialProgram {
  const count = program.instructions.length;
  const neighbors = new Uint8Array(count);
  const pending: number[] = [];
  for (const sample of program.samples) {
    pending.push(...sample.uv);
  }
  for (const read of program.productReads ?? []) {
    if (read.uv !== null) {
      pending.push(...read.uv);
    }
  }
  while (pending.length > 0) {
    const ref = pending.pop()!;
    if (neighbors[ref]) {
      continue;
    }
    neighbors[ref] = 1;
    pending.push(...program.instructions[ref]!.args);
  }

  const constants: number[] = [];
  const parameterSlots: Record<string, { slot: number; channel: number; low: number; high: number }[]> =
    Object.create(null);
  const expressions: string[][] = [];
  const lines: string[] = [];
  const samples = new Map<number, string[]>();
  const products = new Map<number, string[]>();
  const decoded = new Map<number, string[]>();
  const textureQueries = Array<number>(program.samples.length).fill(0);
  const productQueries = Array<number>(program.productReads?.length ?? 0).fill(0);
  const sampleTransformSlots = Array<number>(program.samples.length).fill(-1);
  const inputSlots = new Map(program.inputs.map((input, slot) => [input.name, slot]));
  const spatial = DEPENDENCY.Surface | DEPENDENCY.Geometry | DEPENDENCY.View | DEPENDENCY.Nonlocal;
  const points = (ref: number): number =>
    neighbors[ref] && (program.instructions[ref]!.dependency & spatial) !== 0 ? 3 : 1;
  const expression = (ref: number, point: number): string =>
    expressions[ref]![point] ?? expressions[ref]![0]!;
  const loadConstant = (value: number): string => {
    const slot = constants.length;
    constants.push(value);
    return `native_material_constant(material_base, ${slot}u)`;
  };
  const queryPoints = (kind: "texture" | "product", index: number): number => {
    // A query shared by several channels must meet their complete neighbor demand.
    return program.instructions.some(
      (node, ref) =>
        (kind === "texture" ? node.sample === index : node.product === index) && points(ref) === 3
    )
      ? 3
      : 1;
  };
  const emitQuery = (
    kind: "sample" | "product",
    index: number,
    uv: readonly [number, number],
    pointCount: number
  ): string[] => {
    const prefix = `${kind}_${index}`;
    const coordinate = (point: number): string =>
      `vec2f(${expression(uv[0], point)}, ${expression(uv[1], point)})`;
    lines.push(`  let ${prefix}_c = ${coordinate(0)};`);
    lines.push(`  let ${prefix}_dx = ${coordinate(1)} - ${prefix}_c;`);
    lines.push(`  let ${prefix}_dy = ${coordinate(2)} - ${prefix}_c;`);
    let transform = (value: string, offset: boolean): string => value;
    if (kind === "sample") {
      const binding = program.samples[index]!.binding;
      sampleTransformSlots[index] = constants.length;
      const components = [
        ...binding.offset,
        ...binding.scale,
        Math.fround(Math.cos(binding.rotation)),
        Math.fround(Math.sin(binding.rotation))
      ];
      const fields = components.map(loadConstant);
      lines.push(`  let ${prefix}_offset = vec2f(${fields[0]}, ${fields[1]});`);
      lines.push(`  let ${prefix}_scale = vec2f(${fields[2]}, ${fields[3]});`);
      lines.push(`  let ${prefix}_rotation = vec2f(${fields[4]}, ${fields[5]});`);
      transform = (value: string, offset: boolean): string =>
        `${offset ? `${prefix}_offset + ` : ""}native_material_rotate(${value} * ${prefix}_scale, ${prefix}_rotation)`;
    }
    return Array.from({ length: pointCount }, (_, point) => {
      const name = `${prefix}_${point}`;
      lines.push(
        `  let ${name} = native_material_${kind}_${index}(material_base, ${transform(coordinate(point), true)}, ${transform(`${prefix}_dx`, false)}, ${transform(`${prefix}_dy`, false)});`
      );
      return name;
    });
  };

  for (let ref = 0; ref < count; ref++) {
    const node = program.instructions[ref]!;
    if (node.kind === "constant" || node.kind === "parameter") {
      if (node.parameter !== undefined) {
        (parameterSlots[node.parameter] ??= []).push({
          slot: constants.length,
          channel: node.channel!,
          low: node.range!.low,
          high: node.range!.high
        });
      }
      const name = `n_${ref}_0`;
      lines.push(`  let ${name} = ${loadConstant(node.value!)};`);
      expressions.push([name]);
      continue;
    }
    if (node.kind === "texture") {
      const index = node.sample!;
      if (!samples.has(index)) {
        const pointCount = queryPoints("texture", index);
        samples.set(index, emitQuery("sample", index, program.samples[index]!.uv, pointCount));
        textureQueries[index] = pointCount;
      }
      expressions.push(samples.get(index)!.map((name) => `${name}.${"rgba"[node.channel!]}`));
      continue;
    }
    if (node.kind === "product" || node.kind === "normal-product") {
      const index = node.product!;
      const read = program.productReads![index]!;
      if (!products.has(index)) {
        if (read.field.constant !== undefined) {
          const components = Array.from({ length: 4 }, (_, channel) =>
            channel < read.field.width ? loadConstant(read.field.constant![channel]!) : "0.0"
          );
          const name = `product_${index}_0`;
          lines.push(`  let ${name} = vec4f(${components.join(", ")});`);
          products.set(index, [name]);
        } else {
          const pointCount = queryPoints("product", index);
          products.set(index, emitQuery("product", index, read.uv!, pointCount));
          productQueries[index] = pointCount;
        }
      }
      if (node.kind === "normal-product") {
        if (!decoded.has(index)) {
          decoded.set(
            index,
            products.get(index)!.map((product, point) => {
              const name = `normal_${index}_${point}`;
              lines.push(`  let ${name} = appearance_decode_normal_moment(${product}.xyz);`);
              return name;
            })
          );
        }
        expressions.push(
          decoded
            .get(index)!
            .map((name) =>
              node.channel! < 3
                ? `${name}.normal.${"xyz"[node.channel!]}`
                : node.channel === 3
                  ? `${name}.roughness`
                  : `f32(${name}.direction_valid)`
            )
        );
      } else {
        expressions.push(products.get(index)!.map((name) => `${name}.${"rgba"[node.channel!]}`));
      }
      continue;
    }
    expressions.push(
      Array.from({ length: points(ref) }, (_, point) => {
        const name = `n_${ref}_${point}`;
        const value =
          node.kind === "input"
            ? `inputs.${["center", "x", "y"][point]}[${inputSlots.get(node.input!)}].${"xyzw"[node.channel!]}`
            : operationWgsl(
                node.op!,
                node.args.map((arg) => expression(arg, point))
              );
        lines.push(`  let ${name}: f32 = ${value};`);
        return name;
      })
    );
  }
  const outputs: Record<string, readonly number[]> = Object.create(null);
  const result: string[] = [];
  for (const [name, refs] of Object.entries(program.outputs)) {
    outputs[name] = Object.freeze(
      refs.map((ref) => {
        const slot = result.length;
        result.push(expression(ref, 0));
        return slot;
      })
    );
  }
  const inputCount = Math.max(program.inputs.length, 1);
  const width = Math.max(result.length, 1);
  const source =
    (decoded.size ? APPEARANCE_NORMAL_FILTER_WGSL : "") +
    /* wgsl */ `
fn native_material_rotate(value: vec2f, rotation: vec2f) -> vec2f {
  return vec2f(rotation.x * value.x - rotation.y * value.y, rotation.y * value.x + rotation.x * value.y);
}
struct NativeMaterialInputs {
  center: array<vec4f, ${inputCount}>,
  x: array<vec4f, ${inputCount}>,
  y: array<vec4f, ${inputCount}>,
}
fn native_material_evaluate(material_base: u32, inputs: NativeMaterialInputs) -> array<f32, ${width}> {
${lines.join("\n")}
  return array<f32, ${width}>(${result.length ? result.join(", ") : "0.0"});
}
`;
  const key = JSON.stringify([
    source,
    program.inputs.map((input) => [input.name, input.width, input.domain]),
    program.samples.map((sample) => [sample.binding.decode, sample.readMask]),
    program.productReads?.map((read) => [read.field.width, read.field.format, read.uv === null]) ?? [],
    outputs
  ]);
  return Object.freeze({
    source,
    key,
    constants: Object.freeze(constants),
    outputs: Object.freeze(outputs),
    outputCount: result.length,
    inputCount: program.inputs.length,
    inputs: program.inputs,
    parameterSlots: Object.freeze(
      Object.fromEntries(
        Object.entries(parameterSlots).map(([name, slots]) => [
          name,
          Object.freeze(slots.map((slot) => Object.freeze(slot)))
        ])
      )
    ),
    textureQueries: Object.freeze(textureQueries),
    productQueries: Object.freeze(productQueries),
    sampleTransformSlots: Object.freeze(sampleTransformSlots),
    dependencies: Object.freeze(program.instructions.map((node) => node.dependency)),
    frequencies: Object.freeze(program.instructions.map((node) => nativeFrequency(node.dependency)))
  });
}

/** Dynamic values use the compiled input slots. Geometry/view CXY remains the shader consumer's responsibility.
 * This is a CPU publication snapshot, not a second GPU uniform store. Every live dynamic input is required. */
export function nativeMaterialDynamicInputs(
  program: NativeMaterialProgram,
  inputs: Readonly<Record<string, readonly number[]>>
): Float32Array<ArrayBuffer> {
  const result = new Float32Array(Math.max(program.inputCount, 1) * 4);
  for (const name of Object.keys(inputs)) {
    if (!program.inputs.some((input) => input.name === name && input.domain === "dynamic")) {
      throw new RangeError(`Unknown native material dynamic input '${name}'`);
    }
  }
  program.inputs.forEach((input, slot) => {
    if (input.domain !== "dynamic") {
      return;
    }
    const value = inputs[input.name];
    if (value === undefined || value.length !== input.width) {
      throw new RangeError(`Native material input '${input.name}' requires ${input.width} components`);
    }
    value.forEach((component, channel) => {
      const rounded = Math.fround(component);
      if (!Number.isFinite(rounded) || rounded < input.range.low || rounded > input.range.high) {
        throw new RangeError(`Native material input '${input.name}' violates its range`);
      }
      result[slot * 4 + channel] = rounded;
    });
  });
  return result;
}

/** Validated numeric edits produce a new CPU snapshot; never mutate a live publication. */
export function nativeMaterialParameters(
  program: NativeMaterialProgram,
  edits: Readonly<Record<string, readonly number[]>> = {}
): Float32Array<ArrayBuffer> {
  const values = Float32Array.from(program.constants);
  for (const [name, components] of Object.entries(edits)) {
    const slots = program.parameterSlots[name];
    if (slots === undefined) {
      throw new RangeError(`Unknown native material parameter '${name}'`);
    }
    if (components.length > 4 || !components.every((value) => Number.isFinite(Math.fround(value)))) {
      throw new RangeError(`Native material parameter '${name}' requires finite f32 components`);
    }
    // DCE may keep only selected channels, but an edit must still supply every live channel.
    for (const slot of slots) {
      const value = Math.fround(components[slot.channel]!);
      if (!Number.isFinite(value) || value < slot.low || value > slot.high) {
        throw new RangeError(`Native material parameter '${name}' violates its range`);
      }
      values[slot.slot] = value;
    }
  }
  return values;
}
