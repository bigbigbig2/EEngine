import { ATMOSPHERE_RUNTIME_WGSL } from "./atmosphere/runtime.js";

/** Physical sky radiance, evaluated at the current quantized probe location. */
export const PHYSICAL_SKY_RADIANCE_WGSL = /* wgsl */ `
${ATMOSPHERE_RUNTIME_WGSL}
struct SkyProbe {
  sun_direction: vec3f, sky_scale: f32,
  camera_world: vec3f, world_to_unit: f32,
};
@group(0) @binding(0) var<uniform> probe: SkyProbe;
@group(0) @binding(1) var transmittance: texture_2d<f32>;
@group(0) @binding(2) var scattering: texture_3d<f32>;
@group(0) @binding(3) var higher_order: texture_3d<f32>;
@group(0) @binding(4) var lut_sampler: sampler;
@group(0) @binding(5) var output_radiance: texture_storage_2d<rgba16float, write>;
fn oct_decode(uv: vec2f) -> vec3f {
  let p=uv*2.0-1.0;
  var d=vec3f(p,1.0-abs(p.x)-abs(p.y));
  let f=max(-d.z,0.0);
  d.x+=select(f,-f,d.x>0.0);
  d.y+=select(f,-f,d.y>0.0);
  return normalize(d);
}
@compute @workgroup_size(8,8,1)
fn radiance(@builtin(global_invocation_id) id: vec3u) {
  let dimensions=textureDimensions(output_radiance);
  if any(id.xy>=dimensions) { return; }
  let direction=oct_decode((vec2f(id.xy)+0.5)/vec2f(dimensions));
  let position=atmosphere_world_to_planet(probe.camera_world,probe.world_to_unit);
  let value=atmosphere_sky(position,direction,normalize(probe.sun_direction),
    transmittance,scattering,higher_order,lut_sampler)*probe.sky_scale;
  textureStore(output_radiance,id.xy,vec4f(max(value,vec3f(0.0)),1.0));
}
`;

/** Local octahedral physical storage mip construction, before Filament filtering. */
export const PHYSICAL_SKY_MIP_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var output_image: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8,8,1)
fn downsample(@builtin(global_invocation_id) id: vec3u) {
  let size=textureDimensions(output_image);
  if any(id.xy>=size) { return; }
  // Exact box integration also includes the last source row/column for NPOT
  // authored maps. Power-of-two dimensions reduce to the same four taps.
  let ratio=vec2f(textureDimensions(source))/vec2f(size);
  let low=vec2f(id.xy)*ratio; let high=vec2f(id.xy+vec2u(1u))*ratio;
  var value=vec4f(0.0);
  for(var y=i32(floor(low.y));y<i32(ceil(high.y));y++) {
    let wy=max(0.0,min(high.y,f32(y+1))-max(low.y,f32(y)));
    for(var x=i32(floor(low.x));x<i32(ceil(high.x));x++) {
      let wx=max(0.0,min(high.x,f32(x+1))-max(low.x,f32(x)));
      value+=textureLoad(source,vec2i(x,y),0)*(wx*wy);
    }
  }
  textureStore(output_image,id.xy,value/(ratio.x*ratio.y));
}
`;

/** Filament CubemapIBL.cpp::DFV_Multiscatter. R stores Fc and G stores total
 * visibility, matching surface_light_indirect.fs::specularDFG and the energy
 * compensation denominator in surface_shading_lit.fs. */
export const PHYSICAL_SKY_DFG_WGSL = /* wgsl */ `
const PI: f32=3.141592653589793;
@group(0) @binding(0) var output_image: texture_storage_2d<rgba16float, write>;
fn hammersley(i:u32,n:u32)->vec2f { return vec2f(f32(i)/f32(n),f32(reverseBits(i))*2.3283064365386963e-10); }
fn ggx_half(u:vec2f,a:f32)->vec3f {
  let phi=2.0*PI*u.x;
  let a2=a*a;
  let cos_theta=sqrt((1.0-u.y)/max(1.0+(a2-1.0)*u.y,1e-6));
  return vec3f(cos(phi)*sqrt(max(1.0-cos_theta*cos_theta,0.0)),
    sin(phi)*sqrt(max(1.0-cos_theta*cos_theta,0.0)),cos_theta);
}
fn smith_correlated(a:f32,nv:f32,nl:f32)->f32 {
  let a2=a*a;
  let lv=nl*sqrt(nv*nv*(1.0-a2)+a2);
  let ll=nv*sqrt(nl*nl*(1.0-a2)+a2);
  return 0.5/max(lv+ll,1e-6);
}
@compute @workgroup_size(8,8,1)
fn dfg(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(output_image);
  if any(id.xy>=size) { return; }
  let nv=clamp((f32(id.x)+0.5)/f32(size.x),1e-5,1.0);
  let p=clamp((f32(id.y)+0.5)/f32(size.y),0.0,1.0);
  let a=max(p*p,1e-4);
  let v=vec3f(sqrt(max(1.0-nv*nv,0.0)),0.0,nv);
  var result=vec2f(0.0);
  for(var i=0u;i<1024u;i++) {
    let h=ggx_half(hammersley(i,1024u),a);
    let vh=clamp(dot(v,h),0.0,1.0);
    let l=2.0*vh*h-v;
    let nl=clamp(l.z,0.0,1.0);
    if nl>0.0 {
      let visibility=smith_correlated(a,nv,nl)*nl*vh/max(h.z,1e-6);
      let f=pow(1.0-vh,5.0);
      result+=visibility*vec2f(f,1.0);
    }
  }
  textureStore(output_image,id.xy,vec4f(result*(4.0/1024.0),0.0,1.0));
}
`;

/** CubemapIBL.cpp::roughnessFilter: Hammersley GGX, NoL normalization,
 * PDF-based source mip and filtered roughness levels; octahedral views are the
 * WebGPU storage adaptation. The mip-0 path copies radiance exactly. */
export const PHYSICAL_SKY_PREFILTER_WGSL = /* wgsl */ `
const PI: f32=3.141592653589793;
struct FilterParams { perceptual_roughness:f32, sample_count:u32, source_resolution:u32, max_source_mip:u32, };
@group(0) @binding(0) var<uniform> params:FilterParams;
@group(0) @binding(1) var source:texture_2d<f32>;
@group(0) @binding(2) var output_image:texture_storage_2d<rgba16float,write>;
fn oct_sign(p:vec2f)->vec2f { return select(vec2f(1.0),vec2f(-1.0),p<vec2f(0.0)); }
fn oct_encode(d:vec3f)->vec2f {
  var p=d.xy/(abs(d.x)+abs(d.y)+abs(d.z));
  if d.z<0.0 { p=(1.0-abs(p.yx))*oct_sign(p); }
  return p*0.5+0.5;
}
fn wrap(p:vec2i,n:i32)->vec2i {
  let w=((p%n)+n)%n;
  let cx=abs(p.x/n)+i32(p.x<0);
  let cy=abs(p.y/n)+i32(p.y<0);
  return select(w,vec2i(n-1)-w,((cx^cy)&1)!=0);
}
fn bilinear(d:vec3f,mip:u32)->vec3f {
  let n=i32(textureDimensions(source,i32(mip)).x);
  let texel=oct_encode(d)*f32(n)-0.5;
  let base=vec2i(floor(texel)); let f=fract(texel);
  let c00=textureLoad(source,wrap(base,n),i32(mip)).rgb;
  let c10=textureLoad(source,wrap(base+vec2i(1,0),n),i32(mip)).rgb;
  let c01=textureLoad(source,wrap(base+vec2i(0,1),n),i32(mip)).rgb;
  let c11=textureLoad(source,wrap(base+vec2i(1,1),n),i32(mip)).rgb;
  return mix(mix(c00,c10,f.x),mix(c01,c11,f.x),f.y);
}
fn source_at(d:vec3f,lod:f32)->vec3f {
  let l0=u32(floor(lod)); let l1=min(l0+1u,params.max_source_mip);
  return mix(bilinear(d,l0),bilinear(d,l1),fract(lod));
}
fn oct_decode(uv:vec2f)->vec3f {
  let p=uv*2.0-1.0;var d=vec3f(p,1.0-abs(p.x)-abs(p.y));
  let f=max(-d.z,0.0);d.x+=select(f,-f,d.x>0.0);d.y+=select(f,-f,d.y>0.0);
  return normalize(d);
}
fn hammersley(i:u32,n:u32)->vec2f { return vec2f(f32(i)/f32(n),f32(reverseBits(i))*2.3283064365386963e-10); }
fn basis(n:vec3f)->mat3x3f {
  let up=select(vec3f(0.0,0.0,1.0),vec3f(1.0,0.0,0.0),abs(n.z)>0.999);
  let x=normalize(cross(up,n));return mat3x3f(x,cross(n,x),n);
}
fn ggx_half(u:vec2f,a:f32)->vec3f {
  let phi=2.0*PI*u.x;let a2=a*a;
  let h=sqrt((1.0-u.y)/max(1.0+(a2-1.0)*u.y,1e-6));
  let s=sqrt(max(1.0-h*h,0.0));return vec3f(cos(phi)*s,sin(phi)*s,h);
}
@compute @workgroup_size(8,8,1)
fn prefilter(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(output_image);if any(id.xy>=size){return;}
  let n=oct_decode((vec2f(id.xy)+0.5)/vec2f(size));
  if params.perceptual_roughness==0.0 {
    textureStore(output_image,id.xy,vec4f(source_at(n,0.0),1.0));return;
  }
  let a=max(params.perceptual_roughness*params.perceptual_roughness,1e-4);
  let a2=a*a;
  let omega_p=4.0*PI/(f32(params.source_resolution)*f32(params.source_resolution));
  let frame=basis(n);
  var sum=vec3f(0.0);var weight=0.0;
  for(var i=0u;i<params.sample_count;i++) {
    let h=normalize(frame*ggx_half(hammersley(i,params.sample_count),a));
    let nh=clamp(dot(n,h),0.0,1.0);
    let l=normalize(2.0*nh*h-n);
    let nl=clamp(dot(n,l),0.0,1.0);
    if nl>0.0 {
      let denom=nh*nh*(a2-1.0)+1.0;
      let distribution=a2/(PI*denom*denom);
      let pdf=max(distribution*0.25,1e-6);
      let omega_s=1.0/(f32(params.sample_count)*pdf);
      let lod=clamp(0.5*log2(max(omega_s/omega_p,1e-6))+1.0,
        0.0,f32(params.max_source_mip));
      sum+=source_at(l,lod)*nl;weight+=nl;
    }
  }
  textureStore(output_image,id.xy,vec4f(sum/max(weight,1e-5),1.0));
}
`;
