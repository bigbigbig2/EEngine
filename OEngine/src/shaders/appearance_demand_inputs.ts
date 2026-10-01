import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import type { AppearanceWgslProgram } from "./appearance_program.js";
import { operationWgsl } from "./appearance_program.js";

/** Geometry semantics are resolved once at publication. */
export function appearanceGeometryInputKind(input: CompiledAppearanceGraph["inputs"][number], program?: CompiledAppearanceGraph): number {
  if (input.domain !== "geometry" && input.domain !== "surface" && input.domain !== "view") return 0;
  if (input.domain === "view") {
    const kind: Readonly<Record<string,number>> = { viewDirection: 8, cameraPosition: 9, worldPosition: 10,
      worldNormal: 11, worldTangent: 12, viewPosition: 13, viewNormal: 14 };
    const value=kind[input.name];
    if (value===undefined) throw new Error(`Appearance view input '${input.name}' has no GPU semantic`);
    return value;
  }
  const kinds: Readonly<Record<string, number>> = { uv0: 1, uv1: 2, uv2: 3, vertexColor: 4, normal: 5, tangent: 6, position: 7 };
  const domains = new Set(program?.instructions.filter(node => node.kind === "input" && node.input === input.name).flatMap(node => node.coordinateDomains));
  const kind = kinds[input.name] ?? (domains.size === 1 ? kinds[[...domains][0]!] : undefined);
  if (kind === undefined) throw new Error(`Appearance geometry input '${input.name}' has no published semantic`);
  return kind;
}

/** Center inputs and sample gradients keep their established offsets. Neighbor
 * input values follow them, so source/product callbacks use one shared ABI. */
export function appearanceInputLayout(program: CompiledAppearanceGraph): { neighborBase: number; vectors: number } {
  const samples = program.samples.length + (program.productReads ?? []).filter(read => read.field.constant === undefined).length;
  const neighborBase = program.inputs.length + samples * 2;
  return { neighborBase, vectors: neighborBase + program.inputs.length * 2 };
}

/** Compile exact coordinate ancestors at center/X/Y. Texture-driven UVs
 * recursively sample their already-produced coordinate footprint. */
export function appearanceCoordinatePreparation(program: CompiledAppearanceGraph, lowered: AppearanceWgslProgram): string {
  const { neighborBase } = appearanceInputLayout(program), reads = program.productReads ?? [];
  const coordinates = [...program.samples.map(sample => sample.uv), ...reads.filter(read => read.field.constant === undefined).map(read => read.uv!)];
  const live = new Set<number>();
  const visit = (ref: number): void => {
    if (live.has(ref)) return;
    live.add(ref); const node = program.instructions[ref]!;
    node.args.forEach(visit);
    if (node.sample !== undefined) program.samples[node.sample]!.uv.forEach(visit);
    if (node.product !== undefined) reads[node.product]!.uv?.forEach(visit);
  };
  coordinates.forEach(uv => uv.forEach(visit));
  const lines: string[] = [], sampled = new Set<string>();
  const emitSample = (kind: "texture" | "product", index: number, uv: readonly number[], sample: number): string => {
    const name = `${kind}_coordinate_${index}`;
    if (sampled.has(name)) return name;
    sampled.add(name);
    const x = `coordinate_${uv[0]}`, y = `coordinate_${uv[1]}`;
    lines.push(`  let ${name}_dx = vec2f(${x}.y-${x}.x,${y}.y-${y}.x);`);
    lines.push(`  let ${name}_dy = vec2f(${x}.z-${x}.x,${y}.z-${y}.x);`);
    const call = kind === "texture" ? `appearance_sample_${index}_footprint` : `appearance_product_sample_${index}_footprint`;
    lines.push(`  let ${name} = array<vec4f,3>(${["x","y","z"].map(axis=>`${call}(vec2f(${x}.${axis},${y}.${axis}),${name}_dx,${name}_dy)`).join(",")});`);
    const base=program.inputs.length+sample*2;
    lines.push(`  appearance_inputs[appearance_task.z+${base}u]=vec4f(${name}_dx,0.0,0.0);`);
    lines.push(`  appearance_inputs[appearance_task.z+${base+1}u]=vec4f(${name}_dy,0.0,0.0);`);
    return name;
  };
  for (let ref=0;ref<program.instructions.length;ref++) {
    if (!live.has(ref)) continue;
    const node=program.instructions[ref]!; let expression: string;
    if (node.kind === "constant") expression=`vec3f(${floatBits(node.value!)})`;
    else if (node.kind === "parameter") {
      const slot=lowered.parameterSlots[node.parameter!]!.find(value=>value.channel===node.channel)!.slot;
      expression=`vec3f(appearance_constant(${slot}u))`;
    } else if (node.kind === "input") {
      const i=program.inputs.findIndex(input=>input.name===node.input), c=node.channel;
      expression=`vec3f(appearance_input(${i}u,${c}u),appearance_input(${neighborBase+i*2}u,${c}u),appearance_input(${neighborBase+i*2+1}u,${c}u))`;
    } else if (node.kind === "texture") {
      const name=emitSample("texture",node.sample!,program.samples[node.sample!]!.uv,node.sample!);
      expression=`vec3f(${[0,1,2].map(axis=>`${name}[${axis}][${node.channel}]`).join(",")})`;
    } else if (node.kind === "product" || node.kind === "normal-product") {
      const index=node.product!, read=reads[index]!;
      if (read.field.constant !== undefined) {
        if (node.kind === "normal-product") {
          const decoded=`appearance_decode_normal_moment(vec3f(${read.field.constant.slice(0,3).map(floatBits).join(",")}))`;
          expression=`vec3f(${normalComponent(decoded,node.channel!)})`;
        } else expression=`vec3f(${floatBits(read.field.constant[node.channel!]!)})`;
      } else {
        const sample=program.samples.length+reads.slice(0,index).filter(item=>item.field.constant===undefined).length;
        const name=emitSample("product",index,read.uv!,sample);
        expression=`vec3f(${[0,1,2].map(axis=>node.kind==="normal-product"?
          normalComponent(`appearance_decode_normal_moment(${name}[${axis}].xyz)`,node.channel!):`${name}[${axis}][${node.channel}]`).join(",")})`;
      }
    } else expression=operationWgsl(node.op!,node.args.map(arg=>`coordinate_${arg}`)).replaceAll("1.0","vec3f(1.0)");
    lines.push(`  let coordinate_${ref}=${expression};`);
  }
  coordinates.forEach((uv,index)=>{
    const x=`coordinate_${uv[0]}`, y=`coordinate_${uv[1]}`, base=program.inputs.length+index*2;
    lines.push(`  appearance_inputs[appearance_task.z+${base}u]=vec4f(${x}.y-${x}.x,${y}.y-${y}.x,0.0,0.0);`);
    lines.push(`  appearance_inputs[appearance_task.z+${base+1}u]=vec4f(${x}.z-${x}.x,${y}.z-${y}.x,0.0,0.0);`);
  });
  return `fn appearance_prepare_coordinates() {\n${lines.join("\n")}\n}\n`;
}
function normalComponent(value: string, channel: number): string {
  return channel<3?`${value}.normal[${channel}]`:channel===3?`${value}.roughness`:`f32(${value}.direction_valid)`;
}
function floatBits(value: number): string {
  const data=new DataView(new ArrayBuffer(4)); data.setFloat32(0,value,true);
  return `bitcast<f32>(${data.getUint32(0,true)}u)`;
}
