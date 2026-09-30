import { GPU_MATERIAL_VISIBILITY_FLAGS } from "../gpu/GpuMaterialVisibilityAbi.js";
import { GPU_SHADING_PROGRAM, shadingProgramUsesTextures } from "../gpu/GpuShadingProgramAbi.js";
import { gpuSurfaceProgramSpecialization } from "../gpu/GpuSurfaceProgramSpecialization.js";
import { gpuTextureBankSampleWgsl, GPU_TEXTURE_REF_INVALID } from "../gpu/GpuTextureRefAbi.js";
import type { SurfaceKernelProfile } from "./surface_material_kernel.js";
export function textureWgsl(descriptor: Readonly<SurfaceKernelProfile>): string {
  const specialization = gpuSurfaceProgramSpecialization(
    descriptor.programId,
    descriptor.outputDependencyMask
  );
  const slots = [
    specialization.baseTexture !== "never" ? 0 : -1,
    specialization.normalTexture !== "never" ? 1 : -1,
    specialization.ormTexture !== "never" ? 2 : -1,
    specialization.emissiveTexture !== "never" ? 3 : -1,
    specialization.occlusionTexture !== "never" ? 4 : -1
  ].filter((slot) => slot >= 0);
  return /* wgsl */ `
${gpuTextureBankSampleWgsl(descriptor.textureBankMask)}
fn sparse_sample(texture_ref: u32, sampler_class: u32, uv: vec2f, dx: vec2f, dy: vec2f, valid: bool, fallback: vec4f) -> vec4f {
  if valid { return oengine_sample_texture_bank(texture_ref, sampler_class, uv, dx, dy, fallback); }
  return oengine_sample_texture_bank_level_zero(texture_ref, sampler_class, uv, fallback);
}
fn sparse_material_uv_set(material: OEngineShadingMaterialRecord, slot: u32) -> u32 {
  if slot == 4u { return material.payload.occlusion_uv_set; }
  return (material.payload.texture_uv_sets >> (slot * 8u)) & 255u;
}
fn sparse_transform_closure_uv(role: OEngineClosureTextureRole, uv: vec2f, derivative: bool) -> vec2f {
  let value = uv * role.uv_offset_scale.zw;
  let rotated = vec2f(role.uv_rotation.x * value.x - role.uv_rotation.y * value.y,
                      role.uv_rotation.y * value.x + role.uv_rotation.x * value.y);
  return select(role.uv_offset_scale.xy, vec2f(0.0), derivative) + rotated;
}
${slots.map((slot) => textureSlotAccessWgsl(slot)).join("\n")}
`;
}

function textureSlotAccessWgsl(slot: number): string {
  const fields = [
    ["uv_offset_scale", "uv_rotation", "material.payload.sampler_class"],
    ["normal_uv_offset_scale", "normal_uv_rotation", "material.payload.texture_sampler_classes&255u"],
    ["orm_uv_offset_scale", "orm_uv_rotation", "((material.payload.texture_sampler_classes >> 8u) & 255u)"],
    ["emissive_uv_offset_scale", "emissive_uv_rotation", "((material.payload.texture_sampler_classes >> 16u) & 255u)"],
    ["occlusion_uv_offset_scale", "occlusion_uv_rotation", "((material.payload.texture_sampler_classes >> 24u) & 255u)"]
  ][slot];
  if (fields === undefined) throw new RangeError(`Unsupported material texture slot ${slot}`);
  return /* wgsl */ `
fn sparse_transform_uv_${slot}(material: OEngineShadingMaterialRecord, uv: vec2f, derivative: bool) -> vec2f {
  let os=material.payload.${fields[0]}; let rotation=material.payload.${fields[1]};
  let value=uv*os.zw; return select(os.xy,vec2f(0.0),derivative)+vec2f(rotation.x*value.x-rotation.y*value.y,rotation.y*value.x+rotation.x*value.y);
}
fn sparse_sampler_${slot}(material: OEngineShadingMaterialRecord) -> u32 { return ${fields[2]}; }`;
}

export function materialEvaluationWgsl(descriptor: Readonly<SurfaceKernelProfile>,
  dynamicUnlit = false, includeCoat = true): string {
  const s = gpuSurfaceProgramSpecialization(descriptor.programId, descriptor.outputDependencyMask);
  const writesVelocity = s.publishesVelocity;
  const velocityCode = writesVelocity
    ? "let previous_position=oengine_instance_previous_from_current(instance)*vec4f(position,1.0);let previous_clip=shading_view.previous_view_projection*previous_position;let current_clip=shading_view.current_view_projection*vec4f(position,1.0);let velocity=(current_clip.xy/current_clip.w-previous_clip.xy/previous_clip.w)*vec2f(0.5,-0.5);"
    : "let velocity=vec2f(0.0);";
  const motionFlagCode = writesVelocity
    ? "if oengine_instance_motion_valid(instance){surface_flags|=OENGINE_SURFACE_FLAG_MOTION_VALID;}"
    : "";
  const needsBase = s.baseTexture !== "never";
  const needsOrm = s.ormTexture !== "never";
  const needsNormal = s.normalTexture !== "never";
  const needsEmissive = s.emissiveTexture !== "never";
  const needsOcclusion = s.occlusionTexture !== "never";
  const generic = descriptor.programId === GPU_SHADING_PROGRAM.PbrGeneric;
  const normalMapping = needsNormal ? /* wgsl */ `
  var tangent: vec3f;
  var bitangent: vec3f;
  var normal_basis_valid = true;
  if sparse_has_tangent_ref(ref0) {
    let tangent_value=sparse_tangent_ref(ref0)*bary.weights.x+sparse_tangent_ref(ref1)*bary.weights.y+sparse_tangent_ref(ref2)*bary.weights.z;
    let transformed_tangent=mat3x3f(model[0].xyz,model[1].xyz,model[2].xyz)*tangent_value.xyz;
    let orthogonal_tangent=transformed_tangent-normal*dot(normal,transformed_tangent);
    if dot(orthogonal_tangent,orthogonal_tangent)>1e-8 {
      tangent=normalize(orthogonal_tangent);
    } else {
      tangent=sparse_fallback_tangent(normal);
    }
    bitangent=normalize(cross(normal,tangent))*select(-1.0,1.0,tangent_value.w>=0.0);
  } else {
    let normal_uv_set=sparse_material_uv_set(material,1u);
    let normal_uv0=sparse_transform_uv_1(material,sparse_uv_ref(ref0,normal_uv_set),false);
    let normal_uv1=sparse_transform_uv_1(material,sparse_uv_ref(ref1,normal_uv_set),false);
    let normal_uv2=sparse_transform_uv_1(material,sparse_uv_ref(ref2,normal_uv_set),false);
    let edge1=p1.xyz-p0.xyz;
    let edge2=p2.xyz-p0.xyz;
    let duv1=normal_uv1-normal_uv0;
    let duv2=normal_uv2-normal_uv0;
    let determinant=duv1.x*duv2.y-duv1.y*duv2.x;
    if abs(determinant)>1e-8 {
      let inverse_determinant=1.0/determinant;
      let derived_tangent=(edge1*duv2.y-edge2*duv1.y)*inverse_determinant;
      let derived_bitangent=(edge2*duv1.x-edge1*duv2.x)*inverse_determinant;
      let orthogonal_tangent=derived_tangent-normal*dot(normal,derived_tangent);
      if dot(orthogonal_tangent,orthogonal_tangent)>1e-12 {
        tangent=normalize(orthogonal_tangent);
        bitangent=normalize(cross(normal,tangent))*select(-1.0,1.0,dot(cross(normal,tangent),derived_bitangent)>=0.0);
      } else {
        normal_basis_valid=false;
        tangent=sparse_fallback_tangent(normal);
        bitangent=normalize(cross(normal,tangent));
      }
    } else {
      normal_basis_valid=false;
      tangent=sparse_fallback_tangent(normal);
      bitangent=normalize(cross(normal,tangent));
    }
  }
  if normal_basis_valid {
    let mapped=vec3f((sample_1.xy*2.0-1.0)*material.payload.pbr_factors.z,sample_1.z*2.0-1.0);
    normal=normalize(tangent*mapped.x+bitangent*mapped.y+normal*mapped.z);
  }` : "";
  const aoSource = needsOcclusion
    ? `select(sample_2.r,sample_4.r,(material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasOcclusionTexture}u)!=0u)`
    : "sample_2.r";
  const sample = (slot: number, ref: string, fallback: string, condition: string) => `
  if ${condition} {
    if !sparse_texture_route_valid(material_slot, ${slot}u, ${ref}) { sparse_identity_error(); return sparse_invalid_surface(); }
    let uv_set_${slot}=sparse_material_uv_set(material,${slot}u);
    let uv${slot}_0=sparse_uv_ref(ref0,uv_set_${slot});let uv${slot}_1=sparse_uv_ref(ref1,uv_set_${slot});let uv${slot}_2=sparse_uv_ref(ref2,uv_set_${slot});
    let uv_${slot}=uv${slot}_0*bary.weights.x+uv${slot}_1*bary.weights.y+uv${slot}_2*bary.weights.z;let uv_${slot}_dx=(uv${slot}_0*bary.ddx.x+uv${slot}_1*bary.ddx.y+uv${slot}_2*bary.ddx.z)/shading_view.upscale_ratio.x;let uv_${slot}_dy=(uv${slot}_0*bary.ddy.x+uv${slot}_1*bary.ddy.y+uv${slot}_2*bary.ddy.z)/shading_view.upscale_ratio.y;
    let sampled_${slot}=sparse_sample(${ref},sparse_sampler_${slot}(material),sparse_transform_uv_${slot}(material,uv_${slot},false),sparse_transform_uv_${slot}(material,uv_${slot}_dx,true),sparse_transform_uv_${slot}(material,uv_${slot}_dy,true),gradient_valid,${fallback});
    sample_${slot}=sampled_${slot};
  }`;
  const closureSample = (slot: number, role: string, fallback: string) => `
  if material.closure.${role}.texture_ref != ${GPU_TEXTURE_REF_INVALID}u {
    let texture_role = material.closure.${role};
    if !sparse_texture_route_valid(material_slot, ${slot}u, texture_role.texture_ref) {
      sparse_identity_error(); return sparse_invalid_surface();
    }
    let uv0=sparse_uv_ref(ref0,texture_role.uv_set);
    let uv1=sparse_uv_ref(ref1,texture_role.uv_set);
    let uv2=sparse_uv_ref(ref2,texture_role.uv_set);
    let uv=uv0*bary.weights.x+uv1*bary.weights.y+uv2*bary.weights.z;
    let uv_dx=(uv0*bary.ddx.x+uv1*bary.ddx.y+uv2*bary.ddx.z)/shading_view.upscale_ratio.x;
    let uv_dy=(uv0*bary.ddy.x+uv1*bary.ddy.y+uv2*bary.ddy.z)/shading_view.upscale_ratio.y;
    sample_${slot}=sparse_sample(texture_role.texture_ref,texture_role.sampler_class,
      sparse_transform_closure_uv(texture_role,uv,false),
      sparse_transform_closure_uv(texture_role,uv_dx,true),
      sparse_transform_closure_uv(texture_role,uv_dy,true),gradient_valid,${fallback});
  }`;
  const closureDefaults = "1.0,vec3f(1.0),1.5,0.0,0.0,vec3f(0.0,0.0,1.0)";
  if (!s.reconstructTriangle) {
    if (isFastUnlitFactor(descriptor)) return /* wgsl */ `
fn sparse_evaluate_unlit_factor(material:OEngineSparseUnlitFactorRecord)->vec4f{
  return material.base_color_factor;
}`;
    return /* wgsl */ `
fn sparse_evaluate(material_slot:u32,material:OEngineShadingMaterialRecord)->OEngineSparseSurface{
  let factor=material.payload.base_color_factor;
  return OEngineSparseSurface(factor.xyz,factor.w,vec3f(0.0,0.0,1.0),material.payload.pbr_factors.y,vec3f(0.0,0.0,1.0),material.payload.pbr_factors.x,vec3f(0.0),1.0,vec3f(0.0),vec2f(0.0),0.0,OENGINE_SURFACE_FLAG_VALID|OENGINE_SURFACE_FLAG_UNLIT,${closureDefaults});
}`;
  }
  if (!s.lit) {
    const usesBase = dynamicUnlit || descriptor.programId === GPU_SHADING_PROGRAM.UnlitTexture ||
      descriptor.programId === GPU_SHADING_PROGRAM.UnlitTextureColor;
    const usesColor = dynamicUnlit || descriptor.programId === GPU_SHADING_PROGRAM.UnlitFactorColor ||
      descriptor.programId === GPU_SHADING_PROGRAM.UnlitTextureColor;
    return /* wgsl */ `
fn sparse_evaluate_geometry(pixel:vec2u,work:OEngineMeshletRasterWork,primitive:u32,material_slot:u32,material:OEngineShadingMaterialRecord)->OEngineSparseSurface{
  let instance=instance_records[work.instance_slot];let geometry_base=sparse_geometry_base(work.geometry_slot);let meshlet_base=sparse_meshlet_base(work.meshlet_slot);let vertices=sparse_meshlet_vertices_for_work(work,meshlet_base,primitive);let ref0=sparse_vertex_ref_for_work(work,geometry_base,vertices.x);let ref1=sparse_vertex_ref_for_work(work,geometry_base,vertices.y);let ref2=sparse_vertex_ref_for_work(work,geometry_base,vertices.z);let model=sparse_affine(instance);
  let p0=model*vec4f(sparse_position_ref(ref0),1.0);let p1=model*vec4f(sparse_position_ref(ref1),1.0);let p2=model*vec4f(sparse_position_ref(ref2),1.0);let c0=shading_view.current_view_projection*p0;let c1=shading_view.current_view_projection*p1;let c2=shading_view.current_view_projection*p2;let bary=sparse_barycentric(vec2f(pixel)+vec2f(0.5),c0,c1,c2);let position=p0.xyz*bary.weights.x+p1.xyz*bary.weights.y+p2.xyz*bary.weights.z;
  var color=vec3f(1.0);${usesColor ? `${dynamicUnlit ? "if sparse_has_color_ref(ref0) {" : ""}color=sparse_color_ref(ref0)*bary.weights.x+sparse_color_ref(ref1)*bary.weights.y+sparse_color_ref(ref2)*bary.weights.z;${dynamicUnlit ? "}" : ""}` : ""}
  var base_sample=vec4f(1.0);${usesBase ? `${dynamicUnlit ? `if material.payload.texture_ref != ${GPU_TEXTURE_REF_INVALID}u {` : ""}let uv_set=sparse_material_uv_set(material,0u);let u0=sparse_uv_ref(ref0,uv_set);let u1=sparse_uv_ref(ref1,uv_set);let u2=sparse_uv_ref(ref2,uv_set);let uv=u0*bary.weights.x+u1*bary.weights.y+u2*bary.weights.z;let uv_dx=(u0*bary.ddx.x+u1*bary.ddx.y+u2*bary.ddx.z)/shading_view.upscale_ratio.x;let uv_dy=(u0*bary.ddy.x+u1*bary.ddy.y+u2*bary.ddy.z)/shading_view.upscale_ratio.y;if !sparse_texture_route_valid(material_slot,0u,material.payload.texture_ref){sparse_identity_error();return sparse_invalid_surface();}base_sample=sparse_sample(material.payload.texture_ref,sparse_sampler_0(material),sparse_transform_uv_0(material,uv,false),sparse_transform_uv_0(material,uv_dx,true),sparse_transform_uv_0(material,uv_dy,true),bary.valid,vec4f(1.0));${dynamicUnlit ? "}" : ""}` : ""}
  ${velocityCode}let factor=material.payload.base_color_factor;
  var surface_flags=OENGINE_SURFACE_FLAG_VALID|OENGINE_SURFACE_FLAG_UNLIT;${motionFlagCode}${usesBase ? "if !bary.valid{surface_flags|=OENGINE_SURFACE_FLAG_GRADIENT_FALLBACK;}" : ""}
  return OEngineSparseSurface(factor.xyz*color*base_sample.xyz,factor.w*base_sample.a,vec3f(0.0,0.0,1.0),material.payload.pbr_factors.y,vec3f(0.0,0.0,1.0),material.payload.pbr_factors.x,vec3f(0.0),1.0,position,velocity,textureLoad(visibility_depth,vec2i(pixel),0),surface_flags,${closureDefaults});
}`;
  }
  return /* wgsl */ `
fn sparse_evaluate_geometry(pixel:vec2u,work:OEngineMeshletRasterWork,primitive:u32,material_slot:u32,material:OEngineShadingMaterialRecord)->OEngineSparseSurface{
  let instance=instance_records[work.instance_slot];let geometry_base=sparse_geometry_base(work.geometry_slot);let meshlet_base=sparse_meshlet_base(work.meshlet_slot);let vertices=sparse_meshlet_vertices_for_work(work,meshlet_base,primitive);let ref0=sparse_vertex_ref_for_work(work,geometry_base,vertices.x);let ref1=sparse_vertex_ref_for_work(work,geometry_base,vertices.y);let ref2=sparse_vertex_ref_for_work(work,geometry_base,vertices.z);let model=sparse_affine(instance);
  let p0=model*vec4f(sparse_position_ref(ref0),1.0);let p1=model*vec4f(sparse_position_ref(ref1),1.0);let p2=model*vec4f(sparse_position_ref(ref2),1.0);let c0=shading_view.current_view_projection*p0;let c1=shading_view.current_view_projection*p1;let c2=shading_view.current_view_projection*p2;let bary=sparse_barycentric(vec2f(pixel)+vec2f(0.5),c0,c1,c2);
  let position=p0.xyz*bary.weights.x+p1.xyz*bary.weights.y+p2.xyz*bary.weights.z;let local_normal=normalize(sparse_normal_ref(ref0)*bary.weights.x+sparse_normal_ref(ref1)*bary.weights.y+sparse_normal_ref(ref2)*bary.weights.z);let geometric=normalize(cross(p1.xyz-p0.xyz,p2.xyz-p0.xyz));var normal=sparse_world_normal(model,local_normal,geometric);
  var color=vec3f(1.0);${s.authoredVertexColor !== "never" ? "if sparse_has_color_ref(ref0) { color=sparse_color_ref(ref0)*bary.weights.x+sparse_color_ref(ref1)*bary.weights.y+sparse_color_ref(ref2)*bary.weights.z; }" : ""}
  let gradient_valid=bary.valid;
  let vertex_normal=normal;
  var sample_0=vec4f(1.0);var sample_1=vec4f(0.5,0.5,1.0,1.0);var sample_2=vec4f(1.0);var sample_3=vec4f(1.0);var sample_4=vec4f(1.0);
  var sample_5=vec4f(1.0);var sample_6=vec4f(1.0);var sample_7=vec4f(1.0);var sample_8=vec4f(1.0);var sample_9=vec4f(0.5,0.5,1.0,1.0);
  ${needsBase ? sample(0, "material.payload.texture_ref", "vec4f(1.0)", generic ? `(material.payload.texture_ref!=${GPU_TEXTURE_REF_INVALID}u)` : "true") : ""}
  ${needsNormal ? sample(1, "material.payload.normal_texture_ref", "vec4f(0.5,0.5,1.0,1.0)", generic ? `(material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasNormalTexture}u)!=0u` : "true") : ""}
  ${needsOrm ? sample(2, "material.payload.orm_texture_ref", "vec4f(1.0)", generic ? `(material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasOrmTexture}u)!=0u` : "true") : ""}
  ${needsEmissive ? sample(3, "material.payload.emissive_texture_ref", "vec4f(1.0)", generic ? `(material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasEmissiveTexture}u)!=0u` : "true") : ""}
  ${needsOcclusion ? sample(4, "material.payload.occlusion_texture_ref", "vec4f(1.0)", `(material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasOcclusionTexture}u)!=0u`) : ""}
  ${generic ? closureSample(5, "specular", "vec4f(1.0)") : ""}
  ${generic ? closureSample(6, "specular_color", "vec4f(1.0)") : ""}
  ${generic && includeCoat ? closureSample(7, "coat", "vec4f(1.0)") : ""}
  ${generic && includeCoat ? closureSample(8, "coat_roughness", "vec4f(1.0)") : ""}
  ${generic && includeCoat ? closureSample(9, "coat_normal", "vec4f(0.5,0.5,1.0,1.0)") : ""}
  let base=material.payload.base_color_factor.xyz*color*sample_0.xyz;let metallic=clamp(material.payload.pbr_factors.x*sample_2.b,0.0,1.0);let roughness=clamp(material.payload.pbr_factors.y*sample_2.g,0.0,1.0);let ao=mix(1.0,${aoSource},clamp(material.payload.pbr_factors.w,0.0,1.0));let emissive=material.payload.emissive_factor.xyz*sample_3.xyz;
  ${normalMapping}
  var coat_normal=vertex_normal;
  ${generic && includeCoat ? `if material.closure.coat_normal.texture_ref != ${GPU_TEXTURE_REF_INVALID}u {
    let coat_role=material.closure.coat_normal;
    let coat_uv0=sparse_transform_closure_uv(coat_role,
      sparse_uv_ref(ref0,coat_role.uv_set),false);
    let coat_uv1=sparse_transform_closure_uv(coat_role,
      sparse_uv_ref(ref1,coat_role.uv_set),false);
    let coat_uv2=sparse_transform_closure_uv(coat_role,
      sparse_uv_ref(ref2,coat_role.uv_set),false);
    let coat_edge1=p1.xyz-p0.xyz;let coat_edge2=p2.xyz-p0.xyz;
    let coat_duv1=coat_uv1-coat_uv0;let coat_duv2=coat_uv2-coat_uv0;
    let coat_determinant=coat_duv1.x*coat_duv2.y-coat_duv1.y*coat_duv2.x;
    var coat_tangent=tangent;var coat_bitangent=bitangent;
    if abs(coat_determinant)>1e-8 {
      let derived_tangent=(coat_edge1*coat_duv2.y-coat_edge2*coat_duv1.y)/coat_determinant;
      let derived_bitangent=(coat_edge2*coat_duv1.x-coat_edge1*coat_duv2.x)/coat_determinant;
      let orthogonal=derived_tangent-vertex_normal*dot(vertex_normal,derived_tangent);
      if dot(orthogonal,orthogonal)>1e-12 {
        coat_tangent=normalize(orthogonal);
        coat_bitangent=normalize(cross(vertex_normal,coat_tangent))*
          select(-1.0,1.0,dot(cross(vertex_normal,coat_tangent),derived_bitangent)>=0.0);
      }
    }
    let mapped=vec3f((sample_9.xy*2.0-1.0)*material.closure.specular_color_and_normal_scale.w,
      sample_9.z*2.0-1.0);
    coat_normal=normalize(coat_tangent*mapped.x+coat_bitangent*mapped.y+vertex_normal*mapped.z);
  }` : ""}
  let specular_weight=material.closure.factors.y*sample_5.a;
  let specular_color=material.closure.specular_color_and_normal_scale.xyz*sample_6.xyz;
  let coat_factor=${includeCoat ? "material.closure.factors.z*sample_7.r" : "0.0"};
  let coat_roughness=${includeCoat ? "material.closure.factors.w*sample_8.g" : "0.0"};
  ${writesVelocity ? "let previous_position=oengine_instance_previous_from_current(instance)*vec4f(position,1.0);let previous_clip=shading_view.previous_view_projection*previous_position;let current_clip=shading_view.current_view_projection*vec4f(position,1.0);let current_ndc=current_clip.xy/current_clip.w;let previous_ndc=previous_clip.xy/previous_clip.w;let velocity=(current_ndc-previous_ndc)*vec2f(0.5,-0.5);" : "let velocity=vec2f(0.0);"}
  var surface_flags=OENGINE_SURFACE_FLAG_VALID;${motionFlagCode}${shadingProgramUsesTextures(descriptor.programId) ? "if !gradient_valid{surface_flags|=OENGINE_SURFACE_FLAG_GRADIENT_FALLBACK;}" : ""}${generic ? `if (material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasNormalTexture}u)!=0u{surface_flags|=OENGINE_SURFACE_FLAG_NORMAL_TEXTURE;}if (material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasOrmTexture}u)!=0u{surface_flags|=OENGINE_SURFACE_FLAG_ORM_TEXTURE;}if (material.payload.flags&${GPU_MATERIAL_VISIBILITY_FLAGS.HasEmissiveTexture}u)!=0u{surface_flags|=OENGINE_SURFACE_FLAG_EMISSIVE_TEXTURE;}` : `${needsNormal ? "surface_flags|=OENGINE_SURFACE_FLAG_NORMAL_TEXTURE;" : ""}${needsOrm ? "surface_flags|=OENGINE_SURFACE_FLAG_ORM_TEXTURE;" : ""}${needsEmissive ? "surface_flags|=OENGINE_SURFACE_FLAG_EMISSIVE_TEXTURE;" : ""}`}
  return OEngineSparseSurface(base,material.payload.base_color_factor.w*sample_0.a,normal,roughness,geometric,metallic,emissive,ao,position,velocity,textureLoad(visibility_depth,vec2i(pixel),0),surface_flags,specular_weight,specular_color,material.closure.factors.x,coat_factor,coat_roughness,coat_normal);
}`;
}

export function isFastUnlitFactor(descriptor: Readonly<SurfaceKernelProfile>): boolean {
  return descriptor.programId === GPU_SHADING_PROGRAM.UnlitFactor &&
    descriptor.outputDependencyMask === 0;
}
