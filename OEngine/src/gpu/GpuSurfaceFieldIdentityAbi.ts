import { APPEARANCE_FIELD_NAMES } from "./GpuAppearanceCacheAbi.js";
import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import { selectAppearanceProductProgram } from "../material/AppearanceGraphCompiler.js";
import { lowerAppearanceWgsl } from "../shaders/appearance_program.js";
import { appearanceGeometryInputKind } from "../shaders/appearance_demand_inputs.js";
import type { AppearanceProgramRegistry } from "./AppearanceProgramRegistry.js";

export const SURFACE_FIELD_IDENTITY_WORDS = 8;
export const SURFACE_FIELD_MAX_TEXTURE_DEPENDENCIES = 256;
export const SURFACE_FIELD_DEPENDENCY_BUDGET_BYTES = 8 * 1024 * 1024;
export const SURFACE_FIELD_DEPENDENCY_HEADER_WORDS = 8;
export const SURFACE_FIELD_DEPENDENCY_ENTRY_WORDS = 264;
export const SURFACE_FIELD_DEPENDENCY_WAYS = 4;
export const SURFACE_FIELD_IDENTITY_FLAG = Object.freeze({ uvLocal: 1, view: 2, world: 4, unknown: 8 });

export interface SurfaceFieldIdentityPublication {
  readonly identities: Uint32Array<ArrayBuffer>;
  readonly textureSlots: Uint32Array<ArrayBuffer>;
}

const floatWords = (values: ArrayLike<number>): readonly number[] =>
  [...new Uint32Array(new Float32Array(values).buffer)];

/** Local ABI/compiler glue: complete per-output cold witness, including sample
 * equivalence/author state and product object identity. It intentionally excludes
 * the unrelated scene publication generation and camera epoch. */
export function publishSurfaceFieldIdentities(registry: AppearanceProgramRegistry,
  program: CompiledAppearanceGraph, fieldBase: number,
  textureIdentity: (binding: CompiledAppearanceGraph["samples"][number]["binding"]) => readonly number[],
  runtimeInput: (name: string) => ArrayLike<number> | undefined): SurfaceFieldIdentityPublication {
  const identities = new Uint32Array(APPEARANCE_FIELD_NAMES.length * SURFACE_FIELD_IDENTITY_WORDS);
  const slots: number[] = [];
  const names = Object.keys(program.outputs);
  for (let field = 0; field < APPEARANCE_FIELD_NAMES.length; field++) {
    const name = APPEARANCE_FIELD_NAMES[field]!;
    const roots = program.outputs[name];
    const at = field * SURFACE_FIELD_IDENTITY_WORDS;
    if (roots === undefined) {
      identities.set([registry.internFieldPublication(`default:${name}`), 0xffffffff, 0, 0, slots.length, 0, 0, 0], at);
      continue;
    }
    const closure = selectAppearanceProductProgram(program, { [name]: roots });
    const lowered = lowerAppearanceWgsl(closure);
    const sourceTextures = closure.samples.map(sample => {
      const identity = textureIdentity(sample.binding);
      if (identity[0] !== 0xffffffff) { slots.push(identity[1]!); }
      return [registry.publicationObjectIdentity(sample.binding.source), ...identity,
        sample.binding.contentVersion, sample.binding.sampler, sample.binding.decode,
        floatWords([...sample.binding.offset, ...sample.binding.scale, sample.binding.rotation, ...sample.binding.fallback])];
    });
    if (closure.samples.length > SURFACE_FIELD_MAX_TEXTURE_DEPENDENCIES) {
      throw new RangeError("Field dependency witness exceeds the negotiated complete profile");
    }
    const externalInputs = closure.inputs.map(input => [input.name, input.domain,
      appearanceGeometryInputKind(input, closure) === 0 ? floatWords(runtimeInput(input.name) ?? []) : []]);
    const products = (closure.productReads ?? []).map(read => [registry.publicationObjectIdentity(read.asset), read.field.name,
      read.field.width, read.field.constant === undefined ? null : floatWords(read.field.constant)]);
    const identity = registry.internFieldPublication(JSON.stringify([name, lowered.templateKey,
      floatWords(lowered.constants), externalInputs, sourceTextures, products]));
    const dependency = roots.reduce((mask, root) => mask | program.instructions[root]!.dependency, 0);
    let flags = 0;
    let uvMask = 0;
    for (const input of closure.inputs) {
      const kind = appearanceGeometryInputKind(input, closure);
      flags |= 1 << (8 + kind);
      if (kind >= 1 && kind <= 3) { uvMask |= 1 << (kind - 1); }
      else if (kind !== 4 && kind !== 0) { flags |= SURFACE_FIELD_IDENTITY_FLAG.world; }
      if ([8, 9, 13, 14].includes(kind)) { flags |= SURFACE_FIELD_IDENTITY_FLAG.view; }
      if (input.domain === "dynamic" || input.domain === "nonlocal") { flags |= SURFACE_FIELD_IDENTITY_FLAG.unknown; }
    }
    if ((flags & (SURFACE_FIELD_IDENTITY_FLAG.world | SURFACE_FIELD_IDENTITY_FLAG.view)) === 0) {
      flags |= SURFACE_FIELD_IDENTITY_FLAG.uvLocal;
    }
    const count = sourceTextures.reduce((total, value) => total + (value[1] === 0xffffffff ? 0 : 1), 0);
    identities.set([identity, fieldBase + names.indexOf(name), dependency, flags, slots.length - count, count, uvMask, 0], at);
  }
  return Object.freeze({ identities, textureSlots: Uint32Array.from(slots) });
}
