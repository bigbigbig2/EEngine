import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import { appearanceGeometryInputKind, appearanceInputLayout } from "./appearance_demand_inputs.js";
import { appearanceResidentKernel, type AppearanceResidentKernel, type AppearanceSampleResourceProfile } from "./appearance_resident_kernel.js";
import { lowerAppearanceWgsl } from "./appearance_program.js";

/** Raster publication shares constants/routes/dynamic-input ownership with
 * Appearance. Only the live alpha DAG reaches this fragment program. */
export const COVERAGE_BUFFER_BINDINGS = Object.freeze({ constants: 22, routes: 23, inputs: 24, directory: 25 });
export const COVERAGE_DIRECTORY_STRIDE = 16;

export function appearanceCoverageKernel(program: CompiledAppearanceGraph,
  resources: readonly AppearanceSampleResourceProfile[], products: readonly (number | null)[]): AppearanceResidentKernel {
  const shape = appearanceInputLayout(program), b = COVERAGE_BUFFER_BINDINGS;
  const declarations = /* wgsl */ `
struct AppearanceRoute { identity: vec4u, uv: vec4f, rotation: vec4f, fallback: vec4f }
@group(0) @binding(${b.constants}) var<storage, read> appearance_constants: array<f32>;
@group(0) @binding(${b.routes}) var<storage, read> appearance_routes: array<AppearanceRoute>;
@group(0) @binding(${b.inputs}) var<storage, read> coverage_runtime_inputs: array<vec4f>;
@group(0) @binding(${b.directory}) var<storage, read> coverage_directory: array<vec4u>;
var<private> appearance_task: vec4u;
var<private> appearance_inputs: array<vec4f, ${Math.max(1, shape.vectors)}>;
fn appearance_constant(index: u32) -> f32 { return appearance_constants[appearance_task.x + index]; }
fn appearance_input(index: u32, channel: u32) -> f32 { return appearance_inputs[index][channel]; }
fn appearance_fragment_cutoff() -> f32 { return appearance_constant(${lowerAppearanceWgsl(program).constants.length}u); }
`;
  const values: Readonly<Record<number, string>> = { 1: "vec4f(uv0,0.0,0.0)", 2: "vec4f(uv1,0.0,0.0)",
    3: "vec4f(uv2,0.0,0.0)", 4: "color", 5: "normal", 6: "tangent", 7: "vec4f(position,1.0)",
    8: "vec4f(normalize(camera.transform[3].xyz-world_position),0.0)", 9: "vec4f(camera.transform[3].xyz,1.0)",
    10: "vec4f(world_position,1.0)", 11: "vec4f(world_normal,0.0)", 12: "world_tangent",
    13: "camera.view_matrix*vec4f(world_position,1.0)", 14: "camera.view_matrix*vec4f(world_normal,0.0)" };
  const kinds = program.inputs.map(input => appearanceGeometryInputKind(input, program));
  const world = kinds.some(kind => kind >= 8);
  const worldNormal = kinds.some(kind => kind === 11 || kind === 12 || kind === 14);
  const entry = /* wgsl */ `
fn appearance_fragment_alpha(material: u32, instance: OEngineFrameInstanceRecord, camera: CommandEncoder,
  uv0: vec2f, uv1: vec2f, uv2: vec2f, color: vec4f, normal: vec4f, tangent: vec4f, position: vec3f) -> f32 {
  let published=coverage_directory[material];
  appearance_task=vec4u(published.xy,0u,0u);
${world ? `  let transform=oengine_instance_current_object_to_world(instance.source);
  let world_position=(transform*vec4f(position,1.0)).xyz;` : ""}
${worldNormal ? `  let geometric=normalize(cross(dpdx(world_position),dpdy(world_position)));
  let world_normal=oengine_frame_instance_normal(instance.normal_x,instance.normal_y,instance.normal_z.xyz,normal.xyz,geometric);` : ""}
${kinds.includes(12) ? `  let transformed_tangent=(transform*vec4f(tangent.xyz,0.0)).xyz;
  let projected=transformed_tangent-world_normal*dot(world_normal,transformed_tangent);
  let basis=select(cross(select(vec3f(0.0,0.0,1.0),vec3f(0.0,1.0,0.0),abs(world_normal.z)>0.99),world_normal),projected,dot(projected,projected)>1e-20);
  let world_tangent=vec4f(normalize(basis),tangent.w*sign(instance.normal_x.w));` : ""}
${program.inputs.map((_input, i) => {
    const kind = kinds[i]!, neighbor = shape.neighborBase + i * 2;
    return `  let input_${i}=${kind === 0 ? `coverage_runtime_inputs[published.z+${i}u]` : values[kind]};
  appearance_inputs[${i}u]=input_${i};
  appearance_inputs[${neighbor}u]=input_${i}${kind === 0 ? "" : `+dpdx(input_${i})`};
  appearance_inputs[${neighbor+1}u]=input_${i}${kind === 0 ? "" : `+dpdy(input_${i})`};`;
  }).join("\n")}
  appearance_prepare_coordinates();
  return appearance_evaluate()[0];
}
`;
  return appearanceResidentKernel(program, resources, products, { entryPoint: "appearance_fragment_alpha", groups: [[]],
    declarations, entrySource: entry, shaderStage: GPUShaderStage.FRAGMENT, coordinateEntry: false, sharedTextureAbi: true });
}
