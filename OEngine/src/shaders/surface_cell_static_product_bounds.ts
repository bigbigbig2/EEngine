import { SURFACE_APPEARANCE_BOUND_PROGRAM_WORDS } from "../gpu/GpuSurfaceAppearanceBoundsAbi.js";

/** Actual baked-field consumer: mapping, filtering and mip support match
 * appearance_product_sample_*_footprint. TextureVariationResidency builds the
 * hierarchy from the actual uploaded r/rg/rgba16float layer, including normal
 * r-form moments. No original-source bound is substituted for baked data. */
export const SURFACE_CELL_STATIC_PRODUCT_BOUNDS_WGSL = /* wgsl */ `
fn ab_product(context:vec4u,index:u32,u:AppearanceBound,v:AppearanceBound,udx:AppearanceBound,udy:AppearanceBound,vdx:AppearanceBound,vdy:AppearanceBound)->AppearanceBound4 {
 if cell_product_bound_valid[index]!=0u { cell_texture_reuse_count++;return cell_product_bounds[index]; }
 if cell_proof_queries >= 4u { cell_proof_exhausted = true; return AppearanceBound4(vec4f(0.0),vec4f(0.0),vec4u(0u)); }
 cell_proof_queries++;
 let result=cell_product_bound(context,index,u,v,udx,udy,vdx,vdy);
 cell_product_bounds[index]=result;
 cell_product_bound_valid[index]=1u;
 return result;
}
fn cell_product_bound(context:vec4u,index:u32,u:AppearanceBound,v:AppearanceBound,udx:AppearanceBound,udy:AppearanceBound,vdx:AppearanceBound,vdy:AppearanceBound)->AppearanceBound4 {
 let header=settings.appearance0.z+context.y*${SURFACE_APPEARANCE_BOUND_PROGRAM_WORDS}u;
 let table=settings.appearance0.z+appearance_metadata[header+5u]+index*2u;
 let ordinal=appearance_metadata[table];
 let route=settings.appearance0.y+(cell_directory(context.z).z+appearance_metadata[header+4u]+ordinal)*16u;
 let identity=vec3u(appearance_metadata[route+1u],appearance_metadata[route+2u],appearance_metadata[route+3u]);
 if identity.x==0u{return AppearanceBound4(vec4f(0.0),vec4f(0.0),vec4u(0u));}
 let mapping=bitcast<vec4f>(vec4u(appearance_metadata[route+4u],appearance_metadata[route+5u],appearance_metadata[route+6u],appearance_metadata[route+7u]));
 let mapped_u=ab_multiply(ab_subtract(u,ab_exact(mapping.x)),ab_exact(mapping.z));
 let mapped_v=ab_multiply(ab_subtract(v,ab_exact(mapping.y)),ab_exact(mapping.w));
 let dxu=ab_multiply(udx,ab_exact(mapping.z));let dxv=ab_multiply(vdx,ab_exact(mapping.w));
 let dyu=ab_multiply(udy,ab_exact(mapping.z));let dyv=ab_multiply(vdy,ab_exact(mapping.w));
 if !ab_valid(mapped_u)||!ab_valid(mapped_v)||!ab_valid(dxu)||!ab_valid(dxv)||!ab_valid(dyu)||!ab_valid(dyv){
  return AppearanceBound4(vec4f(0.0),vec4f(0.0),vec4u(0u));
 }
 let descriptor=identity.x*8u;let dimensions=vec2f(f32(texture_variation[descriptor]),f32(texture_variation[descriptor+1u]));
 let lower=max(length(vec2f(cell_min_magnitude(dxu),cell_min_magnitude(dxv))*dimensions),length(vec2f(cell_min_magnitude(dyu),cell_min_magnitude(dyv))*dimensions));
 let upper=max(length(vec2f(cell_max_magnitude(dxu),cell_max_magnitude(dxv))*dimensions),length(vec2f(cell_max_magnitude(dyu),cell_max_magnitude(dyv))*dimensions));
 let lod=vec2f(max(0.0,log2(max(lower,1.0))-1.0),log2(max(upper,1.0))+1.0);
 let range=tv_query(identity,vec2f(mapped_u.low,mapped_v.low),vec2f(mapped_u.high,mapped_v.high),lod,vec2u(0u),3u);
 cell_texture_nodes += range.visits;
 if range.exhausted != 0u { cell_proof_exhausted = true; }
 return AppearanceBound4(range.low,range.high,vec4u(range.known));
}
`;
