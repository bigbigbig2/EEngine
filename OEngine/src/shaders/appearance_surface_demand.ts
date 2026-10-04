import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import type { AppearanceResidentKernel, AppearanceKernelIntegration } from "./appearance_resident_kernel.js";
import { appearanceInputLayout, appearanceGeometryInputKind } from "./appearance_demand_inputs.js";
import { APPEARANCE_FIELD_NAMES, APPEARANCE_FIELD_WIDTHS } from "../gpu/GpuAppearanceFieldAbi.js";
import { SURFACE_GEOMETRY_RECORD_WGSL, surfaceGeometryReadWgsl } from "../gpu/GpuSurfaceGeometryRecordAbi.js";
/** Compiler integration: one invocation per actual geometry/material group.
 * Evaluate the union of its missing output closures once. Values retain f32
 * precision and each field writes its nominated producer's independent slot. */
export function appearanceSurfaceDemandIntegration(program: CompiledAppearanceGraph, lowered: AppearanceResidentKernel["lowered"]): AppearanceKernelIntegration {
    const layout = appearanceInputLayout(program);
    const outputBits = Object.fromEntries(APPEARANCE_FIELD_NAMES.map((name, index) => [name, 1 << index]));
    const inputMasks=new Map<string,number>();
    for(const [name,roots] of Object.entries(program.outputs)) {
      const bit=outputBits[name]??0;
      const pending=[...roots],visited=new Set<number>();
      while(pending.length!==0) {
        const ref=pending.pop()!;
        if(visited.has(ref)) {continue;}
        visited.add(ref);
        const node=program.instructions[ref]!;
        if(node.kind==="input") {inputMasks.set(node.input!,(inputMasks.get(node.input!)??0)|bit);}
        pending.push(...node.args);
        if(node.sample!==undefined) {pending.push(...program.samples[node.sample]!.uv);}
        if(node.product!==undefined) {pending.push(...(program.productReads?.[node.product]?.uv??[]));}
      }
    }
    const inputs = program.inputs.map((input, index) => {
        const kind = appearanceGeometryInputKind(input, program);
        const expression = kind === 0 ? `surface_runtime_input(directory[7u]+${index}u)` : `geometry_product_input(leaf,${kind}u,0u)`;
        const x = kind === 0 ? expression : `geometry_product_input(leaf,${kind}u,1u)`;
        const y = kind === 0 ? expression : `geometry_product_input(leaf,${kind}u,2u)`;
        return `if (appearance_missing & ${inputMasks.get(input.name)??0}u)!=0u {
  appearance_inputs[${index}u]=${expression};
  appearance_inputs[${layout.neighborBase + index * 2}u]=${x};
  appearance_inputs[${layout.neighborBase + index * 2 + 1}u]=${y};
  }`;
    }).join("\n  ");
    const writes = APPEARANCE_FIELD_NAMES.map((name, field) => {
        const slots = lowered.outputSlots[name];
        if (slots === undefined) {
            return "";
        }
        const expression = Array.from({ length: 4 }, (_, channel) => channel < APPEARANCE_FIELD_WIDTHS[field]! && slots[channel] !== undefined ? `value[${slots[channel]}u]` : "0.0").join(", ");
        return `if (appearance_missing & ${1 << field}u)!=0u {
    let destination=surface_demand[surface_settings.destinations+leaf*15u+${field}u]-1u;
    surface_values[destination]=vec4f(${expression});
  }`;
    }).join("\n  ");
    const declarations = /* wgsl */ `
${SURFACE_GEOMETRY_RECORD_WGSL}
struct AppearanceRoute { identity:vec4u, uv:vec4f, rotation:vec4f, fallback:vec4f }
struct SurfaceAppearanceSettings {
  program:u32, programs:u32, ordered:u32, masks:u32,
  destinations:u32, directory:u32, runtime_inputs:u32, lookup:u32,
}
@group(0) @binding(0) var<storage,read> appearance_constants:array<f32>;
@group(0) @binding(1) var<storage,read> appearance_routes:array<AppearanceRoute>;
@group(0) @binding(2) var<storage,read> surface_geometry:array<u32>;
@group(0) @binding(3) var<storage,read> surface_demand:array<u32>;
@group(0) @binding(4) var<storage,read> surface_metadata:array<u32>;
@group(0) @binding(5) var<storage,read_write> surface_values:array<vec4f>;
@group(0) @binding(6) var<uniform> surface_settings:SurfaceAppearanceSettings;
${surfaceGeometryReadWgsl("surface_geometry")}
var<private> appearance_task:vec4u;
var<private> appearance_missing:u32;
var<private> appearance_inputs:array<vec4f,${Math.max(1, layout.vectors)}>;
fn appearance_constant(index:u32)->f32 { return appearance_constants[appearance_task.x+index]; }
fn appearance_input(index:u32,channel:u32)->f32 { return appearance_inputs[index][channel]; }
fn surface_runtime_input(index:u32)->vec4f {
  let at=surface_settings.runtime_inputs+index*4u;
  return bitcast<vec4f>(vec4u(surface_metadata[at],surface_metadata[at+1u],surface_metadata[at+2u],surface_metadata[at+3u]));
}
`;
    const entrySource = /* wgsl */ `
@compute @workgroup_size(64)
fn surface_fields(@builtin(global_invocation_id) id:vec3u) {
  let program=surface_settings.programs+surface_settings.program*8u;
  if id.x>=surface_demand[program+3u] { return; }
  let leaf=surface_demand[surface_settings.ordered+surface_demand[program+5u]+id.x];
  appearance_missing=surface_demand[surface_settings.masks+leaf];
  // A numeric-only miss does not need a GeometryRecord. Material identity is
  // carried by the immutable request nominated for one of the missing fields.
  // The directory index is published by the actual group producer.
  let entry=surface_demand[surface_settings.lookup+leaf];
  var directory:array<u32,8>;
  for(var word=0u;word<8u;word++) { directory[word]=surface_metadata[surface_settings.directory+entry*8u+word]; }
  appearance_task=vec4u(directory[2u],directory[3u],0u,0u);
  ${inputs}
  appearance_prepare_coordinates();
  let value=appearance_evaluate();
  ${writes}
}
`;
    const entries: GPUBindGroupLayoutEntry[] = [];
    for (let binding = 0; binding < 6; binding++) {
        entries.push({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: binding === 5 ? "storage" : "read-only-storage" } });
    }
    entries.push({ binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 32 } });
    return { entryPoint: "surface_fields", groups: [entries], declarations, entrySource, outputBits, coordinateEntry: false };
}
