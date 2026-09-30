/** Internal exact closure layout. rgba32uint preserves f32 and identity bits. */
export const SURFACE_SAMPLE_SURFACE_WGSL = /* wgsl */ `
struct RadiometryPreExposure { value:f32, _pad:vec3f, }
struct OEngineSparseSurface {
  base_color:vec3f, alpha:f32,
  shading_normal:vec3f, roughness:f32,
  geometric_normal:vec3f, metallic:f32,
  emissive:vec3f, material_ao:f32,
  position_ws:vec3f, velocity:vec2f,
  view_depth:f32, flags:u32,
  specular_weight:f32, specular_color:vec3f, ior:f32,
  coat_factor:f32, coat_roughness:f32, coat_normal:vec3f,
}
fn sparse_invalid_surface()->OEngineSparseSurface {
  return OEngineSparseSurface(vec3f(0.0),0.0,vec3f(0.0),1.0,vec3f(0.0),0.0,
    vec3f(0.0),1.0,vec3f(0.0),vec2f(0.0),0.0,0u,
    1.0,vec3f(1.0),1.5,0.0,0.0,vec3f(0.0,0.0,1.0));
}
fn surface_error()->OEngineSparseSurface {
  var value=sparse_invalid_surface(); value.base_color=vec3f(1.0,0.0,1.0); value.alpha=1.0;
  return value;
}
`;

export const SURFACE_SAMPLE_LOAD_WGSL = /* wgsl */ `
fn surface_field(result:u32,field:u32)->vec4f {
  return bitcast<vec4f>(textureLoad(sample_results,sample_field_pixel(result,field),0));
}
fn surface_load_closure(result:u32)->OEngineSparseSurface {
  let base=surface_field(result,SAMPLE_FIELD_value); let normal=surface_field(result,SAMPLE_FIELD_normal);
  let emissive=surface_field(result,SAMPLE_FIELD_emissive); let specular=surface_field(result,SAMPLE_FIELD_specular);
  let coat=surface_field(result,SAMPLE_FIELD_coat); let other=textureLoad(sample_results,sample_field_pixel(result,SAMPLE_FIELD_closure),0);
  // Position/geometric normal are target-pixel geometry, never reused closure fields.
  return OEngineSparseSurface(base.xyz,base.w,normal.xyz,normal.w,vec3f(0.0),bitcast<f32>(other.z),
    emissive.xyz,emissive.w,vec3f(0.0),vec2f(0.0),0.0,other.w&SAMPLE_RESULT_flagsMask,
    specular.w,specular.xyz,bitcast<f32>(other.x),coat.w,bitcast<f32>(other.y),coat.xyz);
}
`;

export const SURFACE_SAMPLE_STORE_WGSL = /* wgsl */ `
fn surface_store(result:u32,surface:OEngineSparseSurface,value:vec4f,
  pixel:vec2u,item:OEngineMeshletRasterWork,domain:u32,packed:u32,kind:u32) {
  textureStore(sample_results,sample_field_pixel(result,SAMPLE_FIELD_value),bitcast<vec4u>(value));
  textureStore(sample_results,sample_field_pixel(result,SAMPLE_FIELD_normal),bitcast<vec4u>(vec4f(surface.shading_normal,surface.roughness)));
  if kind==SAMPLE_KIND_split {
    textureStore(sample_results,sample_field_pixel(result,SAMPLE_FIELD_emissive),bitcast<vec4u>(vec4f(surface.emissive,surface.material_ao)));
    textureStore(sample_results,sample_field_pixel(result,SAMPLE_FIELD_specular),bitcast<vec4u>(vec4f(surface.specular_color,surface.specular_weight)));
    textureStore(sample_results,sample_field_pixel(result,SAMPLE_FIELD_coat),bitcast<vec4u>(vec4f(surface.coat_normal,surface.coat_factor)));
  }
  textureStore(sample_results,sample_field_pixel(result,SAMPLE_FIELD_closure),vec4u(bitcast<u32>(surface.ior),bitcast<u32>(surface.coat_roughness),
    bitcast<u32>(surface.metallic),(surface.flags&SAMPLE_RESULT_flagsMask)|(kind<<SAMPLE_RESULT_kindShift)|(packed<<SAMPLE_RESULT_rateShift)));
  textureStore(sample_results,sample_field_pixel(result,SAMPLE_FIELD_footprint),vec4u(bitcast<u32>(surface.view_depth),pixel,item.packed_profile_lod));
  textureStore(sample_results,sample_field_pixel(result,SAMPLE_FIELD_identity),vec4u(item.instance_slot,item.material_slot_or_range,item.geometry_slot,domain));
}
`;
