import type { CompiledAppearanceGraph } from "./AppearanceGraphCompiler.js";

export interface AppearanceFieldIdentity {
  /** Exact canonical f32 DAG, independent of unrelated outputs and instruction indices. */
  readonly key: string;
  /** Scalar selectors let internal roots reconnect after source recompilation. */
  readonly components: readonly string[];
  /** Raw sources without explicit content versions are valid only in this process. */
  readonly portable: boolean;
}

const sourceIds = new WeakMap<object, number>();
const session = crypto.randomUUID();
let nextSource = 0;
const bitsBuffer = new DataView(new ArrayBuffer(4));
function bits(value: number): number {
  bitsBuffer.setFloat32(0, value, true); return bitsBuffer.getUint32(0, true);
}

/** Publication/cook-only exact identity. No hash collision or per-pixel validation. */
export function appearanceFieldIdentity(program: CompiledAppearanceGraph, roots: readonly number[]): AppearanceFieldIdentity {
  if (roots.length === 0 || roots.length > 4 || roots.some(ref =>
    !Number.isInteger(ref) || ref < 0 || ref >= program.instructions.length)) throw new RangeError("Invalid Appearance source identity roots");
  const identify = (targets: readonly number[]) => {
    const ids = new Map<number, number>(), nodes: unknown[] = [];
    let portable = true;
    const stack = targets.slice().reverse().map(ref => ({ ref, finish: false }));
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (ids.has(frame.ref)) continue;
      const instruction = program.instructions[frame.ref]!;
      if (!frame.finish) {
        stack.push({ ref: frame.ref, finish: true });
        for (let i = instruction.args.length - 1; i >= 0; i--) stack.push({ ref: instruction.args[i]!, finish: false });
        continue;
      }
      const args = instruction.args.map(ref => ids.get(ref)!);
      let semantic: unknown;
      switch (instruction.kind) {
        case "constant": semantic = ["constant", bits(instruction.value!)]; break;
        case "parameter": semantic = ["parameter", instruction.parameter, instruction.channel, bits(instruction.value!)]; break;
        case "input": {
          const input = program.inputs.find(input => input.name === instruction.input)!;
          semantic = ["input", input.name, input.domain, input.width, instruction.channel]; break;
        }
        case "texture": {
          const sample = program.samples[instruction.sample!]!, binding = sample.binding;
          let source = binding.contentVersion;
          if (source === null) {
            portable = false;
            let id = sourceIds.get(binding.source);
            if (id === undefined) { id = nextSource++; sourceIds.set(binding.source, id); }
            source = `session:${session}:${id}`;
          }
          semantic = ["texture", source, binding.decode, binding.sampler,
            binding.offset.map(bits), binding.scale.map(bits), bits(binding.rotation), binding.fallback.map(bits), instruction.channel];
          break;
        }
        case "operation": semantic = ["operation", instruction.op]; break;
        case "product": case "normal-product": {
          const read = program.productReads![instruction.product!]!;
          portable &&= read.field.sourceIdentity.portable;
          semantic = [instruction.kind, read.field.contentKey, instruction.channel]; break;
        }
        default: throw new RangeError("Appearance identity requires the original source program");
      }
      ids.set(frame.ref, nodes.length);
      nodes.push([semantic, args, instruction.coordinateDomains, instruction.range === undefined ? null :
        [bits(instruction.range.low), bits(instruction.range.high)], instruction.filter]);
    }
    return { key: JSON.stringify(["appearance-field-f32-v1", nodes, targets.map(ref => ids.get(ref)!)]), portable };
  };
  const result = identify(roots);
  return Object.freeze({ ...result, components: Object.freeze(roots.map(ref => identify([ref]).key)) });
}

/** Exact output invalidation facts for the future cache owner; bounded u32 versions. */
export function updateAppearanceFieldVersions(program: CompiledAppearanceGraph,
  previous: ReadonlyMap<string, { readonly key: string; readonly version: number }> = new Map()):
  ReadonlyMap<string, { readonly key: string; readonly version: number; readonly changed: boolean }> {
  const fields = new Map<string, { key: string; version: number; changed: boolean }>();
  for (const [name, roots] of Object.entries(program.outputs)) {
    const key = appearanceFieldIdentity(program, roots).key, old = previous.get(name);
    const changed = old === undefined || old.key !== key;
    const version = old === undefined ? 1 : changed ? old.version + 1 : old.version;
    if (!Number.isInteger(version) || version < 1 || version > 0xffffffff) throw new RangeError("Appearance field version requires a new identity epoch");
    fields.set(name, Object.freeze({ key, version, changed }));
  }
  return fields;
}
