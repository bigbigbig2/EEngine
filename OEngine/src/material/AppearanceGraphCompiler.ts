import { APPEARANCE_F32_MAX, appearanceNodeArguments, evaluateAppearanceOperation } from "./AppearanceGraph.js";
import type { AppearanceGraph, AppearanceInputDomain, AppearanceNode, AppearanceOp,
  AppearanceRange, AppearanceTextureBinding } from "./AppearanceGraph.js";
import type { AppearanceAssetPackage, AppearanceAssetField } from "../assets/AppearanceAssetPackage.js";

export const APPEARANCE_DEPENDENCY = Object.freeze({
  Surface: 1, Texture: 2, Geometry: 4, Dynamic: 8, View: 16, Nonlocal: 32, Material: 64
} as const);
const INPUT_DEPENDENCY: Readonly<Record<AppearanceInputDomain, number>> = Object.freeze({
  surface: APPEARANCE_DEPENDENCY.Surface, geometry: APPEARANCE_DEPENDENCY.Geometry,
  dynamic: APPEARANCE_DEPENDENCY.Dynamic, view: APPEARANCE_DEPENDENCY.View,
  nonlocal: APPEARANCE_DEPENDENCY.Nonlocal
});

export interface AppearanceInstruction {
  readonly kind: "constant" | "parameter" | "input" | "texture" | "operation" | "product" | "normal-product";
  readonly args: readonly number[];
  readonly value?: number;
  readonly input?: string;
  readonly parameter?: string;
  readonly channel?: number;
  readonly sample?: number;
  readonly product?: number;
  readonly op?: AppearanceOp;
  readonly dependency: number;
  readonly coordinateDomains: readonly string[];
  readonly range?: AppearanceRange;
  /** Affine in already decoded/filtered source values, not a promise of atlas equivalence. */
  readonly filter: "constant" | "affine" | "nonlinear";
}

export interface CompiledAppearanceSample {
  readonly binding: AppearanceTextureBinding;
  readonly uv: readonly [number, number];
  readonly readMask: number;
}
export interface CompiledAppearanceInput {
  readonly name: string;
  readonly width: number;
  readonly domain: AppearanceInputDomain;
  readonly range: AppearanceRange;
}
export interface AppearanceProductRoot {
  readonly instruction: number;
  readonly dependency: number;
  readonly coordinateDomains: readonly string[];
  readonly filter: "constant" | "affine" | "nonlinear";
  readonly kind: "constant" | "source-program" | "static-bake-candidate" |
    "dynamic-cache-program" | "per-target";
  readonly operationCost: number;
  readonly parameters: readonly string[];
  readonly dynamicInputs: readonly string[];
  readonly sourceSamples: readonly number[];
}
export interface CompiledAppearanceGraph {
  readonly instructions: readonly AppearanceInstruction[];
  readonly outputs: Readonly<Record<string, readonly number[]>>;
  readonly outputMasks: Readonly<Record<string, number>>;
  readonly inputs: readonly CompiledAppearanceInput[];
  readonly samples: readonly CompiledAppearanceSample[];
  /** Resolved static data leaves, after an explicit source-snapshot substitution. */
  readonly productReads?: readonly CompiledAppearanceProductRead[];
  /** Field roots plus reusable boundaries inside geometry/view/nonlocal expressions. */
  readonly products: readonly AppearanceProductRoot[];
}

export interface CompiledAppearanceProductRead {
  readonly asset: AppearanceAssetPackage;
  readonly field: AppearanceAssetField;
  /** Null for an exact f32 constant field. */
  readonly uv: readonly [number, number] | null;
  /** Original immutable program and field roots preserve invalidation provenance. */
  readonly source: CompiledAppearanceGraph;
  readonly sourceRoots: readonly number[];
}

/**
 * Local compiler profile, informed by MaterialX graph finalization/elision.
 * Scalarization makes output/channel reachability exact. No operand reordering,
 * commutative hashing, or nonlinear filtering identities are used.
 */
export function compileAppearanceGraph(graph: AppearanceGraph,
  demands?: Readonly<Record<string, number>>): CompiledAppearanceGraph {
  const order = validateAndSort(graph);
  const instructions: AppearanceInstruction[] = [];
  const channels: number[][] = Array.from({ length: graph.nodes.length }, () => []);
  const cse = new Map<string, number>();
  const sourceIds = new Map<object, number>();
  const sampleIds = new Map<string, number>();
  const samples: { binding: AppearanceTextureBinding; uv: readonly [number, number] }[] = [];
  const inputs = new Map<string, CompiledAppearanceInput>();
  const append = (key: string, instruction: AppearanceInstruction): number => {
    const prior = cse.get(key);
    if (prior !== undefined) return prior;
    const id = instructions.length;
    instructions.push(instruction);
    cse.set(key, id);
    return id;
  };
  const constant = (value: number): number => {
    const rounded = Math.fround(value);
    if (!Number.isFinite(rounded)) throw new RangeError("Appearance constant must be finite f32");
    return append(`constant:${numericKey(rounded)}`, { kind: "constant", args: [], value: rounded,
      dependency: 0, coordinateDomains: [], range: { low: rounded, high: rounded }, filter: "constant" });
  };
  for (const id of order) {
    const node = graph.nodes[id]!;
    switch (node.kind) {
      case "constant": channels[id] = node.value.map(constant); break;
      case "parameter": {
        channels[id] = node.value.map((value, channel) =>
          append(`parameter:${JSON.stringify([node.name, channel])}`, { kind: "parameter", args: [],
            parameter: node.name, value: Math.fround(value), channel, dependency: APPEARANCE_DEPENDENCY.Material,
            coordinateDomains: [], range: f32Range(node.range), filter: "constant" }));
        break;
      }
      case "input": {
        inputs.set(node.name, Object.freeze({ name: node.name, width: node.width,
          domain: node.domain, range: Object.freeze(f32Range(node.range)) }));
        channels[id] = Array.from({ length: node.width }, (_, channel) =>
          append(`input:${JSON.stringify([node.name, channel])}`, { kind: "input", args: [],
            input: node.name, channel, dependency: INPUT_DEPENDENCY[node.domain],
            coordinateDomains: node.coordinateDomain === undefined ? [] : [node.coordinateDomain],
            range: f32Range(node.range), filter: "affine" }));
        break;
      }
      case "swizzle": channels[id] = node.channels.map(channel => channels[node.source]![channel]!); break;
      case "combine": channels[id] = node.sources.flatMap(source => channels[source]!); break;
      case "texture": {
        // Clone nested state even for callers constructing raw IR instead of using the builder.
        const binding = Object.freeze({ ...node.binding,
          sampler: Object.freeze([...node.binding.sampler]),
          offset: Object.freeze([...node.binding.offset]) as readonly [number, number],
          scale: Object.freeze([...node.binding.scale]) as readonly [number, number],
          fallback: Object.freeze([...node.binding.fallback]) as readonly [number, number, number, number],
          range: Object.freeze(f32Range(node.binding.range)) });
        let source = sourceIds.get(binding.source);
        if (source === undefined) { source = sourceIds.size; sourceIds.set(binding.source, source); }
        const uv = channels[node.uv]! as [number, number];
        const key = JSON.stringify([source, binding.decode, binding.sampler, binding.offset,
          binding.scale, binding.rotation, binding.range, binding.fallback, uv]);
        let sample = sampleIds.get(key);
        if (sample === undefined) {
          sample = samples.length;
          samples.push({ binding, uv: Object.freeze([...uv]) as readonly [number, number] });
          sampleIds.set(key, sample);
        }
        const metadata = dependencies(uv, instructions);
        channels[id] = Array.from({ length: 4 }, (_, channel) =>
          append(`texture:${sample}:${channel}`, { kind: "texture", args: [...uv], sample, channel,
            ...metadata, dependency: metadata.dependency | APPEARANCE_DEPENDENCY.Texture,
            range: samples[sample]!.binding.range, filter: "affine" }));
        break;
      }
      case "operation": {
        channels[id] = Array.from({ length: node.width }, (_, channel) => {
          const args = node.args.map(ref => channels[ref]![graph.nodes[ref]!.width === 1 ? 0 : channel]!);
          const operands = args.map(arg => instructions[arg]!);
          if (operands.every(arg => arg.kind === "constant")) {
            const value = evaluateAppearanceOperation(node.op, operands.map(arg => arg.value!));
            if (!Number.isFinite(value)) throw new RangeError(`Appearance constant ${node.op} has a nonfinite result`);
            return constant(value);
          }
          const identity = identityArgument(node.op, args, instructions);
          if (identity !== undefined) return identity;
          return append(`op:${node.op}:${args.join(",")}`, { kind: "operation", op: node.op, args,
            ...dependencies(args, instructions), range: operationRange(node.op, operands),
            filter: operationFilter(node.op, operands) });
        });
        break;
      }
    }
  }

  const outputs: Record<string, number[]> = Object.create(null);
  const outputMasks: Record<string, number> = Object.create(null);
  if (demands !== undefined) for (const name of Object.keys(demands)) {
    if (!Object.hasOwn(graph.outputs, name)) throw new RangeError(`Unknown appearance output '${name}'`);
  }
  const live = new Set<number>();
  const pending: number[] = [];
  for (const [name, ref] of Object.entries(graph.outputs)) {
    const width = graph.nodes[ref]!.width;
    const mask = demands === undefined ? (1 << width) - 1 : demands[name] ?? 0;
    if (!Number.isInteger(mask) || mask < 0 || mask > (1 << width) - 1) {
      throw new RangeError(`Invalid appearance output mask '${name}'`);
    }
    if (mask === 0) continue;
    outputMasks[name] = mask;
    outputs[name] = channels[ref]!.filter((_, channel) => (mask & (1 << channel)) !== 0);
    pending.push(...outputs[name]!);
  }
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (live.has(id)) continue;
    live.add(id);
    pending.push(...instructions[id]!.args);
  }
  const remap = new Map<number, number>();
  const compact = instructions.filter((_, id) => {
    if (!live.has(id)) return false;
    remap.set(id, remap.size); return true;
  });
  const liveSamples = new Map<number, { id: number; readMask: number }>();
  for (const instruction of compact) if (instruction.kind === "texture") {
    let sample = liveSamples.get(instruction.sample!);
    if (sample === undefined) {
      sample = { id: liveSamples.size, readMask: 0 }; liveSamples.set(instruction.sample!, sample);
    }
    sample.readMask |= 1 << instruction.channel!;
  }
  const finalInstructions = compact.map(instruction => Object.freeze({ ...instruction,
    args: Object.freeze(instruction.args.map(arg => remap.get(arg)!)),
    sample: instruction.sample === undefined ? undefined : liveSamples.get(instruction.sample)!.id,
    coordinateDomains: Object.freeze([...instruction.coordinateDomains]),
    range: instruction.range === undefined ? undefined : Object.freeze({ ...instruction.range }) }));
  const finalOutputs = Object.fromEntries(Object.entries(outputs).map(([name, refs]) =>
    [name, Object.freeze(refs.map(ref => remap.get(ref)!))]));
  const usedInputNames = new Set(finalInstructions.filter(i => i.kind === "input").map(i => i.input!));
  return Object.freeze({ instructions: Object.freeze(finalInstructions),
    outputs: Object.freeze(finalOutputs), outputMasks: Object.freeze({ ...outputMasks }),
    inputs: Object.freeze([...inputs.values()].filter(input => usedInputNames.has(input.name))),
    samples: Object.freeze([...liveSamples.entries()].map(([original, sample]) => {
      const source = samples[original]!;
      return Object.freeze({ binding: source.binding, readMask: sample.readMask,
        uv: Object.freeze(source.uv.map(ref => remap.get(ref)!)) as readonly [number, number] });
    })), products: Object.freeze(productRoots(finalInstructions, finalOutputs)) });
}

/** Extract actual reusable field roots, retaining only their inputs and source reads. */
export function selectAppearanceProductProgram(program: CompiledAppearanceGraph,
  roots: Readonly<Record<string, readonly number[]>>): CompiledAppearanceGraph {
  const live = new Set<number>();
  const pending: number[] = [];
  for (const [name, refs] of Object.entries(roots)) {
    if (refs.length < 1 || refs.length > 4 || refs.some(ref => !Number.isInteger(ref) ||
      ref < 0 || ref >= program.instructions.length)) {
      throw new RangeError(`Invalid appearance product roots '${name}'`);
    }
    pending.push(...refs);
  }
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (live.has(id)) continue;
    live.add(id); pending.push(...program.instructions[id]!.args);
  }
  // Product substitution may introduce coordinate anchors after source roots.
  // Topologically sort the live physical graph rather than trusting source IDs.
  const degree = new Map<number, number>(), consumers = new Map<number, number[]>();
  for (const ref of live) {
    degree.set(ref, program.instructions[ref]!.args.length);
    for (const arg of program.instructions[ref]!.args) {
      const list = consumers.get(arg) ?? []; list.push(ref); consumers.set(arg, list);
    }
  }
  const queue = [...live].filter(ref => degree.get(ref) === 0).sort((a, b) => a - b);
  for (let cursor = 0; cursor < queue.length; cursor++) for (const consumer of consumers.get(queue[cursor]!) ?? []) {
    const next = degree.get(consumer)! - 1; degree.set(consumer, next);
    if (next === 0) queue.push(consumer);
  }
  if (queue.length !== live.size) throw new RangeError("Appearance product substitution has cyclic dependencies");
  const remap = new Map(queue.map((ref, index) => [ref, index]));
  const compact = queue.map(ref => program.instructions[ref]!);
  const samples = new Map<number, { id: number; readMask: number }>();
  const inputNames = new Set<string>();
  const productIndices = new Map<number, number>();
  for (const instruction of compact) {
    if (instruction.kind === "input") inputNames.add(instruction.input!);
    if (instruction.product !== undefined && !productIndices.has(instruction.product)) {
      productIndices.set(instruction.product, productIndices.size);
    }
    if (instruction.kind !== "texture") continue;
    let sample = samples.get(instruction.sample!);
    if (sample === undefined) {
      sample = { id: samples.size, readMask: 0 }; samples.set(instruction.sample!, sample);
    }
    sample.readMask |= 1 << instruction.channel!;
  }
  const instructions = compact.map(instruction => Object.freeze({ ...instruction,
    args: Object.freeze(instruction.args.map(arg => remap.get(arg)!)),
    product: instruction.product === undefined ? undefined : productIndices.get(instruction.product)!,
    sample: instruction.sample === undefined ? undefined : samples.get(instruction.sample)!.id }));
  const outputs = Object.freeze(Object.fromEntries(Object.entries(roots).map(([name, refs]) =>
    [name, Object.freeze(refs.map(ref => remap.get(ref)!))])));
  return Object.freeze({ instructions: Object.freeze(instructions), outputs,
    outputMasks: Object.freeze(Object.fromEntries(Object.entries(roots).map(([name, refs]) => [name, (1 << refs.length) - 1]))),
    inputs: Object.freeze(program.inputs.filter(input => inputNames.has(input.name))),
    samples: Object.freeze([...samples].map(([original, sample]) => {
      const source = program.samples[original]!;
      return Object.freeze({ binding: source.binding, readMask: sample.readMask,
        uv: Object.freeze(source.uv.map(ref => remap.get(ref)!)) as readonly [number, number] });
    })), productReads: Object.freeze([...productIndices.keys()].map(index => {
      const read = program.productReads![index]!;
      return Object.freeze({ ...read, uv: read.uv === null ? null : Object.freeze(read.uv.map(ref => remap.get(ref)!)) as readonly [number, number] });
    })), products: Object.freeze(productRoots(instructions, outputs)) });
}

/** Publication validation + iterative Kahn sort; does not recurse on authored depth. */
function validateAndSort(graph: AppearanceGraph): number[] {
  const count = graph.nodes.length;
  const consumers: number[][] = Array.from({ length: count }, () => []);
  const degree = new Uint32Array(count);
  const inputSignatures = new Map<string, string>();
  const parameterSignatures = new Map<string, string>();
  for (let id = 0; id < count; id++) {
    const node = graph.nodes[id]!;
    if (!Number.isInteger(node.width) || node.width < 1 || node.width > 4) {
      throw new RangeError(`Appearance node ${id} has invalid width`);
    }
    const args = appearanceNodeArguments(node);
    for (const arg of args) {
      if (!Number.isInteger(arg) || arg < 0 || arg >= count) throw new RangeError(`Invalid appearance reference ${arg}`);
      consumers[arg]!.push(id); degree[id] = degree[id]! + 1;
    }
    switch (node.kind) {
      case "constant":
        if (node.value.length !== node.width || !node.value.every(v => Number.isFinite(Math.fround(v)))) {
          throw new RangeError(`Appearance constant ${id} must have finite f32 components`);
        }
        break;
      case "parameter": {
        validateRange(node.range);
        if (node.name.length === 0 || node.value.length !== node.width || !node.value.every(value =>
          Number.isFinite(Math.fround(value)) && Math.fround(value) >= Math.fround(node.range.low) &&
          Math.fround(value) <= Math.fround(node.range.high))) {
          throw new RangeError(`Invalid appearance parameter '${node.name}'`);
        }
        const signature = JSON.stringify([node.width, node.range,
          node.value.map(value => numericKey(Math.fround(value)))]);
        const prior = parameterSignatures.get(node.name);
        if (prior !== undefined && prior !== signature) throw new RangeError(`Conflicting appearance parameter '${node.name}'`);
        parameterSignatures.set(node.name, signature);
        break;
      }
      case "input": {
        if (!Object.hasOwn(INPUT_DEPENDENCY, node.domain) || node.name.length === 0 ||
            (node.domain === "surface" ? !node.coordinateDomain : node.coordinateDomain !== undefined)) {
          throw new RangeError(`Appearance input '${node.name}' has invalid domain`);
        }
        validateRange(node.range);
        const signature = JSON.stringify([node.width, node.domain, node.coordinateDomain, node.range]);
        const prior = inputSignatures.get(node.name);
        if (prior !== undefined && prior !== signature) throw new RangeError(`Conflicting appearance input '${node.name}'`);
        inputSignatures.set(node.name, signature);
        break;
      }
      case "texture":
        if (node.width !== 4 || graph.nodes[node.uv]!.width !== 2 ||
            !["srgb-rgb", "linear-rgb", "linear-alpha"].includes(node.binding.decode) ||
            node.binding.offset.length !== 2 || node.binding.scale.length !== 2 ||
            ![...node.binding.offset, ...node.binding.scale, node.binding.rotation].every(value => Number.isFinite(Math.fround(value))) ||
            node.binding.sampler.length !== 9 || !node.binding.sampler.every(Number.isInteger) ||
            node.binding.fallback.length !== 4 || !node.binding.fallback.every(value => Number.isFinite(Math.fround(value)))) {
          throw new RangeError(`Appearance texture ${id} has invalid sampling signature`);
        }
        validateRange(node.binding.range);
        break;
      case "swizzle":
        if (node.channels.length !== node.width || !node.channels.every(channel => Number.isInteger(channel) &&
            channel >= 0 && channel < graph.nodes[node.source]!.width)) throw new RangeError(`Invalid appearance swizzle ${id}`);
        break;
      case "combine":
        if (node.sources.reduce((sum, arg) => sum + graph.nodes[arg]!.width, 0) !== node.width) {
          throw new RangeError(`Invalid appearance combine ${id}`);
        }
        break;
      case "operation": {
        const arities: Record<AppearanceOp, number> = { add: 2, subtract: 2, multiply: 2,
          divide: 2, min: 2, max: 2, pow: 2, sin: 1, cos: 1, abs: 1, sqrt: 1, mix: 3, clamp: 3 };
        if (!Object.hasOwn(arities, node.op) || args.length !== arities[node.op] ||
            Math.max(...args.map(arg => graph.nodes[arg]!.width)) !== node.width ||
            args.some(arg => graph.nodes[arg]!.width !== 1 && graph.nodes[arg]!.width !== node.width)) {
          throw new RangeError(`Invalid appearance operation ${id}`);
        }
        break;
      }
      default: throw new RangeError(`Unknown appearance node ${id}`);
    }
  }
  for (const ref of Object.values(graph.outputs)) if (!Number.isInteger(ref) || ref < 0 || ref >= count) {
    throw new RangeError(`Invalid appearance output reference ${ref}`);
  }
  const queue: number[] = [];
  for (let id = 0; id < count; id++) if (degree[id] === 0) queue.push(id);
  for (let next = 0; next < queue.length; next++) for (const consumer of consumers[queue[next]!]!) {
    degree[consumer] = degree[consumer]! - 1;
    if (degree[consumer] === 0) queue.push(consumer);
  }
  if (queue.length !== count) throw new RangeError("Appearance graph contains a cycle");
  return queue;
}

function validateRange(range: AppearanceRange): void {
  if (!Number.isFinite(range.low) || !Number.isFinite(range.high) || range.low > range.high ||
      range.low < -APPEARANCE_F32_MAX || range.high > APPEARANCE_F32_MAX) {
    throw new RangeError("Appearance input range must be ordered finite f32");
  }
}
function numericKey(value: number): string { return Object.is(value, -0) ? "-0" : String(value); }
function f32Range(range: AppearanceRange): AppearanceRange {
  return { low: Math.fround(range.low), high: Math.fround(range.high) };
}
function dependencies(args: readonly number[], instructions: readonly AppearanceInstruction[]):
  Pick<AppearanceInstruction, "dependency" | "coordinateDomains"> {
  return { dependency: args.reduce((mask, arg) => mask | instructions[arg]!.dependency, 0),
    coordinateDomains: [...new Set(args.flatMap(arg => instructions[arg]!.coordinateDomains))].sort() };
}
function identityArgument(op: AppearanceOp, args: readonly number[], instructions: readonly AppearanceInstruction[]): number | undefined {
  const a = instructions[args[0]!]!;
  const b = args[1] === undefined ? undefined : instructions[args[1]]!;
  if ((op === "multiply" || op === "divide") && b?.kind === "constant" && b.value === 1) return args[0];
  if (op === "multiply" && a.kind === "constant" && a.value === 1) return args[1];
  if (op === "clamp") {
    const c = instructions[args[2]!]!;
    if (a.range && b?.kind === "constant" && c.kind === "constant" &&
        a.range.low >= b.value! && a.range.high <= c.value! &&
        !(a.range.low <= 0 && a.range.high >= 0 && (b.value === 0 || c.value === 0))) return args[0];
  }
  return undefined;
}
function operationFilter(op: AppearanceOp, args: readonly AppearanceInstruction[]): AppearanceInstruction["filter"] {
  if (args.every(arg => arg.filter === "constant")) return "constant";
  if (args.some(arg => arg.filter === "nonlinear")) return "nonlinear";
  if (op === "add" || op === "subtract") return "affine";
  if (op === "multiply" && args.some(arg => arg.filter === "constant")) return "affine";
  if (op === "divide" && args[1]!.filter === "constant") return "affine";
  if (op === "mix" && args[2]!.filter === "constant") return "affine";
  return "nonlinear";
}
function operationRange(op: AppearanceOp, args: readonly AppearanceInstruction[]): AppearanceRange | undefined {
  const ranges = args.map(arg => arg.range);
  if (ranges.some(range => range === undefined)) return undefined;
  const [a, b, c] = ranges as [AppearanceRange, AppearanceRange, AppearanceRange];
  let candidates: number[];
  switch (op) {
    case "add": candidates = [Math.fround(a.low + b.low), Math.fround(a.high + b.high)]; break;
    case "subtract": candidates = [Math.fround(a.low - b.high), Math.fround(a.high - b.low)]; break;
    case "multiply": candidates = [a.low * b.low, a.low * b.high, a.high * b.low, a.high * b.high].map(Math.fround); break;
    case "divide":
      if (b.low <= 0 && b.high >= 0) return undefined;
      candidates = [a.low / b.low, a.low / b.high, a.high / b.low, a.high / b.high].map(Math.fround); break;
    case "min": candidates = [Math.min(a.low, b.low), Math.min(a.high, b.high)]; break;
    case "max": candidates = [Math.max(a.low, b.low), Math.max(a.high, b.high)]; break;
    case "clamp":
      if (b.high > c.low) return undefined;
      candidates = [Math.min(Math.max(a.low, b.low), c.low), Math.min(Math.max(a.high, b.high), c.high)]; break;
    case "abs": candidates = [a.low <= 0 && a.high >= 0 ? 0 : Math.min(Math.abs(a.low), Math.abs(a.high)),
      Math.max(Math.abs(a.low), Math.abs(a.high))]; break;
    case "sin": case "cos": return { low: -1, high: 1 };
    case "sqrt":
      if (a.low < 0) return undefined;
      candidates = [Math.fround(Math.sqrt(a.low)), Math.fround(Math.sqrt(a.high))]; break;
    case "pow":
      if (a.low <= 0) return undefined;
      candidates = [a.low ** b.low, a.low ** b.high, a.high ** b.low, a.high ** b.high].map(Math.fround); break;
    case "mix":
      // Use the actual f32 evaluation sequence. Rounding can exceed the ideal convex hull.
      if (c.low !== c.high) return undefined;
      candidates = [a.low, a.high].flatMap(x => [b.low, b.high].map(y =>
        evaluateAppearanceOperation("mix", [x, y, c.low]))); break;
  }
  if (!candidates.every(Number.isFinite)) return undefined;
  return { low: Math.min(...candidates), high: Math.max(...candidates) };
}
function productRoots(instructions: readonly AppearanceInstruction[], outputs: Readonly<Record<string, readonly number[]>>): AppearanceProductRoot[] {
  const targetMask = APPEARANCE_DEPENDENCY.Geometry | APPEARANCE_DEPENDENCY.View | APPEARANCE_DEPENDENCY.Nonlocal;
  const roots = new Set(Object.values(outputs).flat());
  for (const instruction of instructions) if ((instruction.dependency & targetMask) !== 0) {
    for (const arg of instruction.args) if ((instructions[arg]!.dependency & targetMask) === 0) roots.add(arg);
  }
  return [...roots].sort((a, b) => a - b).map(root => {
    const value = instructions[root]!;
    const visited = new Set<number>();
    const pending = [root];
    let operationCost = 0;
    const parameters = new Set<string>(), dynamicInputs = new Set<string>(), sourceSamples = new Set<number>();
    while (pending.length > 0) {
      const ref = pending.pop()!;
      if (visited.has(ref)) continue;
      visited.add(ref);
      const instruction = instructions[ref]!;
      if (instruction.kind === "parameter") parameters.add(instruction.parameter!);
      if (instruction.kind === "input" && (instruction.dependency & APPEARANCE_DEPENDENCY.Dynamic) !== 0) dynamicInputs.add(instruction.input!);
      if (instruction.kind === "texture") sourceSamples.add(instruction.sample!);
      operationCost += instruction.kind === "texture" ? 4 : instruction.kind !== "operation" ? 0 :
        ["pow", "sin", "cos", "sqrt"].includes(instruction.op!) ? 8 : 1;
      pending.push(...instruction.args);
    }
    const local = (value.dependency & targetMask) === 0 && value.coordinateDomains.length <= 1;
    const kind: AppearanceProductRoot["kind"] = (value.dependency & ~APPEARANCE_DEPENDENCY.Material) === 0 ? "constant" : !local ? "per-target" :
      operationCost <= 12 ? "source-program" : (value.dependency & APPEARANCE_DEPENDENCY.Dynamic) !== 0 ?
        "dynamic-cache-program" : "static-bake-candidate";
    return Object.freeze({ instruction: root, dependency: value.dependency,
      coordinateDomains: value.coordinateDomains, filter: value.filter, kind, operationCost,
      parameters: Object.freeze([...parameters].sort()), dynamicInputs: Object.freeze([...dynamicInputs].sort()),
      sourceSamples: Object.freeze([...sourceSamples].sort((a, b) => a - b)) });
  });
}
