import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import { APPEARANCE_FIELD_NAMES } from "./GpuAppearanceFieldAbi.js";
import { appearanceGeometryInputKind } from "../shaders/appearance_demand_inputs.js";

/** Local publication directory, consumed by Surface field-specific compatibility
 * and bound callbacks. Complete field identities still include program/parameter
 * publication versions; this describes dependency/seam masks, never a hash key. */
export const SURFACE_APPEARANCE_BOUND_PROGRAM_WORDS = 8;
export const SURFACE_APPEARANCE_BOUND_FIELD_WORDS = 4;
export const SURFACE_APPEARANCE_INPUT_DOMAIN = Object.freeze({ uv0: 1, uv1: 2, normal: 4, tangent: 8, color: 16, geometry: 32, uv2: 64 });

export function packSurfaceAppearanceBounds(programs: readonly CompiledAppearanceGraph[]): Uint32Array<ArrayBuffer> {
  const header = Math.max(1, programs.length) * SURFACE_APPEARANCE_BOUND_PROGRAM_WORDS;
  const fieldsPerProgram = APPEARANCE_FIELD_NAMES.length * SURFACE_APPEARANCE_BOUND_FIELD_WORDS;
  const result = new Uint32Array(header + programs.length * fieldsPerProgram + programs.reduce((n, p) => n + p.inputs.length+2*(p.productReads?.length??0), 0));
  let cursor = header;
  programs.forEach((program, index) => {
    const at = index * SURFACE_APPEARANCE_BOUND_PROGRAM_WORDS;
    result[at] = cursor;
    const names = Object.keys(program.outputs);
    APPEARANCE_FIELD_NAMES.forEach((name, field) => {
      const roots = program.outputs[name], fieldAt = cursor + field * SURFACE_APPEARANCE_BOUND_FIELD_WORDS;
      result[fieldAt] = roots ? names.indexOf(name) : 0xffffffff;
      if (!roots) return;
      const live = new Set<number>(), pending = [...roots]; let dependency = 0, seam = 0;
      while (pending.length) {
        const ref = pending.pop()!; if (live.has(ref)) continue; live.add(ref);
        const node = program.instructions[ref]!; dependency |= node.dependency;
        if (node.kind === "input") {
          const input = program.inputs.find(input => input.name === node.input)!;
          const kind = appearanceGeometryInputKind(input, program);
          seam |= kind === 1 ? 1 : kind === 2 ? 2 : kind === 3 ? 64 : kind === 4 ? 16 :
            kind === 5 || kind === 11 || kind === 14 ? 4 : kind === 6 || kind === 12 ? 8 : kind === 0 ? 0 : 32;
        }
        pending.push(...node.args);
      }
      result[fieldAt + 1] = seam; result[fieldAt + 2] = dependency; result[fieldAt + 3] = roots.length;
      // Material numeric parameters are publication leaves, not spatial work.
      if ((dependency & ~64) === 0) result[at + 2]! |= 1 << field;
    });
    cursor += fieldsPerProgram; result[at + 1] = cursor; result[at + 3] = program.inputs.length;
    for (const input of program.inputs) result[cursor++] = appearanceGeometryInputKind(input, program);
    result[at+4]=program.samples.length;result[at+5]=cursor;result[at+6]=program.productReads?.length??0;
    let productRoute=0;for(const read of program.productReads??[]){result[cursor++]=read.field.constant===undefined?productRoute++:0xffffffff;result[cursor++]=read.field.width;}
  });
  return result;
}
