import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import type { AppearanceWgslProgram } from "./appearance_program.js";
import { operationWgsl } from "./appearance_program.js";
import { APPEARANCE_FIELD_NAMES, APPEARANCE_FIELD_WIDTHS } from "../gpu/GpuAppearanceFieldAbi.js";
import { APPEARANCE_NORMAL_FILTER_WGSL } from "./appearance_normal_filter.js";
import { appearanceGeometryInputKind } from "./appearance_demand_inputs.js";

/** Publication-time numeric facts, not material sampling or CPU visible work
 * selection. Spatial inputs remain unknown. Finite zero products can prove a
 * numeric constant even with a live source, without erasing that source from
 * the evaluation PSO. Unknown signed zero is distinguished from IEEE-exact data.
 * The publication keeps full f32 values and its submitted epoch. */
export const APPEARANCE_MATERIAL_CONSTANT_WGSL = /* wgsl */ `
${APPEARANCE_NORMAL_FILTER_WGSL}
struct MaterialConstantValue {value:f32,flags:u32,} // known=1, finite=2, zero-sign-unknown=4
struct MaterialConstantResult {mask:u32,exact_mask:u32,guard_safe:u32,values:array<vec4f,15>,}
fn material_constant_value(value:f32)->MaterialConstantValue {
 if value!=value||abs(value)>3.402823466e38{return MaterialConstantValue(0.0,0u);}
 return MaterialConstantValue(value,3u);
}
`;

export function lowerAppearanceMaterialConstants(program: CompiledAppearanceGraph, lowered: AppearanceWgslProgram,
  name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new RangeError("Invalid material constant function name");
  const lines: string[] = [];
  const guardFields = [0, 2, 3, 6, 7, 8, 9, 10, 11, 12];
  const guardLive = new Set<number>();
  const pending = guardFields.flatMap(field => program.outputs[APPEARANCE_FIELD_NAMES[field]!] ?? []);
  while (pending.length !== 0) {
    const id = pending.pop()!;
    if (guardLive.has(id)) { continue; }
    guardLive.add(id);
    // A normalized sample's value bound is independent of its coordinate DAG.
    const node = program.instructions[id]!;
    if (node.kind === "operation") { pending.push(...node.args); }
  }
  const productNames = new Map<number, string>();
  const ref = (id: number): string => `m${id}`;
  program.instructions.forEach((node, id) => {
    const variable = ref(id);
    if (node.kind === "constant" || node.kind === "parameter") {
      lines.push(`let ${variable}=material_constant_value(ab_constant(context,${lowered.instructionConstantSlots[id]}u));`);
      return;
    }
    if (node.kind === "product" || node.kind === "normal-product") {
      const product = node.product!, read = program.productReads![product]!;
      if (read.field.constant !== undefined) {
        let p = productNames.get(product);
        if (!p) {
          p = `mp${product}`; productNames.set(product, p);
          const slots = lowered.productConstantSlots[product]!;
          lines.push(`let ${p}=vec4f(${Array.from({length:4},(_,c)=>c<slots.length?`ab_constant(context,${slots[c]}u)`:"0.0").join(",")});`);
        }
        const value = node.kind === "product" ? `${p}[${node.channel}u]` : node.channel! < 3 ?
          `appearance_decode_normal_moment(${p}.xyz).normal[${node.channel}u]` : node.channel === 3 ?
          `appearance_decode_normal_moment(${p}.xyz).roughness` : `f32(appearance_decode_normal_moment(${p}.xyz).direction_valid)`;
        lines.push(`let ${variable}=material_constant_value(${value});`); return;
      }
    }
    if (node.kind !== "operation") {
      // Input and decoded sample publications promise finite values. No claim
      // that an arbitrary intervening operation remains finite is made.
      lines.push(`let ${variable}=MaterialConstantValue(0.0,2u);`); return;
    }
    const operands = node.args.map(ref);
    const known = operands.map(o=>`(${o}.flags&1u)!=0u`).join("&&");
    const finiteRange = node.range !== undefined && Number.isFinite(node.range.low) && Number.isFinite(node.range.high) &&
      Math.max(Math.abs(node.range.low),Math.abs(node.range.high)) < 1e30;
    lines.push(`var ${variable}=MaterialConstantValue(0.0,${finiteRange?2:0}u);`);
    lines.push(`if ${known} {${variable}=material_constant_value(${operationWgsl(node.op!,operands.map(o=>`${o}.value`))});
      if ${variable}.value==0.0 && ((${operands.map(o=>`${o}.flags`).join("|")})&4u)!=0u {${variable}.flags|=4u;}
    }`);
    if (node.op === "multiply") {
      const [a,b] = operands;
      lines.push(`else if ((${a}.flags&1u)!=0u&&${a}.value==0.0&&(${b}.flags&2u)!=0u)||
        ((${b}.flags&1u)!=0u&&${b}.value==0.0&&(${a}.flags&2u)!=0u) {${variable}=MaterialConstantValue(0.0,7u);}`);
    }
  });
  // Numeric safety is recomputed from current GPU parameter values, never from
  // stale CPU snapshots or author-declared ranges. Unproved leaves stay unknown.
  for (let id = 0; id < program.instructions.length; id++) {
    if (!guardLive.has(id)) { continue; }
    const node = program.instructions[id]!;
    let expression = "ab_unknown()";
    if (node.kind === "constant" || node.kind === "parameter") {
      expression = `ab_exact(ab_constant(context, ${lowered.instructionConstantSlots[id]}u))`;
    } else if (node.kind === "input") {
      const input = program.inputs.find(input => input.name === node.input)!;
      if (appearanceGeometryInputKind(input, program) === 4) {
        // The address publisher validates the actual center color against this
        // envelope before lookup/rate planning. Raw float colors are not assumed UNORM.
        expression = "AppearanceBound(-2.0, 2.0, 1u)";
      }
    } else if (node.kind === "texture") {
      expression = `material_guard_texture(context, ${node.sample}u, ${node.channel}u)`;
    } else if ((node.kind === "product" || node.kind === "normal-product") &&
      program.productReads![node.product!]!.field.constant !== undefined) {
      expression = `ab_checked(ab_exact(m${id}.value), (m${id}.flags & 1u) != 0u)`;
    } else if (node.kind === "normal-product") {
      // The asset reader validates every half texel finite. Moment dot products
      // stay below 3 * 65504^2; decode publishes a unit normal or its finite
      // default, roughness in [0,1], and an integer validity value.
      expression = node.channel! < 3 ? "AppearanceBound(-1.0, 1.0, 1u)" : "AppearanceBound(0.0, 1.0, 1u)";
    } else if (node.kind === "product") {
      expression = "AppearanceBound(-65504.0, 65504.0, 1u)";
    } else if (node.kind === "operation") {
      const operands = node.args.map(ref => `q${ref}`);
      const valid = operands.map(operand => `ab_valid(${operand})`).join(" && ");
      // Unlike spatial bounds, zero * Unknown cannot prove a finite guard.
      expression = `ab_checked(ab_${node.op}(${operands.join(", ")}), ${valid})`;
    }
    lines.push(`let q${id} = ${expression};`);
  }
  lines.push("var result:MaterialConstantResult;");
  const checks = [...guardLive].filter(id => guardFields.some(field =>
    (program.outputs[APPEARANCE_FIELD_NAMES[field]!] ?? []).includes(id))).map(id =>
    `(ab_valid(q${id}) && max(abs(q${id}.low), abs(q${id}.high)) <= 131072.0)`);
  lines.push(`result.guard_safe = u32(${checks.length === 0 ? "true" : checks.join(" && ")});`);
  APPEARANCE_FIELD_NAMES.forEach((field, ordinal) => {
    const roots = program.outputs[field];
    if (!roots) {
      const fallback = field === "normalTS" || field === "coatNormalTS" ? "vec4f(0.0,0.0,1.0,0.0)" :
        field === "ior" ? "vec4f(1.5,0.0,0.0,0.0)" : ["alpha","roughness","occlusion","specularWeight","coatRoughness","normalTSValidity","coatNormalTSValidity"].includes(field) ?
        "vec4f(1.0,0.0,0.0,0.0)" : field === "specularColor" ? "vec4f(1.0,1.0,1.0,0.0)" : "vec4f(0.0)";
      lines.push(`result.values[${ordinal}u]=${fallback};result.mask|=${1<<ordinal}u;result.exact_mask|=${1<<ordinal}u;`); return;
    }
    const width = APPEARANCE_FIELD_WIDTHS[ordinal]!;
    const live = roots.slice(0,width).map(ref);
    lines.push(`if ${live.map(o=>`(${o}.flags&1u)!=0u`).join("&&")} {
      result.mask|=${1<<ordinal}u;
      result.values[${ordinal}u]=vec4f(${Array.from({length:4},(_,c)=>live[c]?`${live[c]}.value`:"0.0").join(",")});
      if ((${live.map(o=>`${o}.flags`).join("|")})&4u)==0u{result.exact_mask|=${1<<ordinal}u;}
    }`);
  });
  lines.push("return result;");
  return `fn ${name}(context:vec4u)->MaterialConstantResult {\n${lines.join("\n")}\n}`;
}
