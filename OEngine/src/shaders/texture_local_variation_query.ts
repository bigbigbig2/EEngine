/** GPU consumer of TextureVariationResidency's actual decoded mip hierarchy.
 * Local bounded algorithm; same publication contract as the independent CPU
 * query. Each wrapped rectangle reads <=4 nodes at a selected level. No material
 * textureLoad/sample and no whole-texture bound substituted for local support.
 * Caller supplies UV support including anisotropic taps and LOD range; linear
 * texel halo and all intersecting mips are included here. */
export function textureLocalVariationQueryWgsl(pool = "texture_variation", visitLimit = 0): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(pool)) throw new RangeError("Invalid variation pool identifier");
  return /* wgsl */ `
struct TvRange {low:vec4f,high:vec4f,known:u32,nodes:u32,visits:u32,exhausted:u32,}
struct TvWrap {ranges:array<vec2u,3>,count:u32,}
fn tv_unknown()->TvRange{return TvRange(vec4f(0.0),vec4f(0.0),0u,0u,0u,0u);}
fn tv_wrap(lo:i32,hi:i32,size:u32,mode:u32)->TvWrap {
 var result:TvWrap;
 if mode==0u{result.ranges[0]=vec2u(vec2i(clamp(lo,0,i32(size)-1),clamp(hi,0,i32(size)-1)));result.count=1u;return result;}
 let period=select(size,size*2u,mode==1u);
 if hi-lo+1>=i32(period){result.ranges[0]=vec2u(0u,size-1u);result.count=1u;return result;}
 var position=u32(((lo%i32(period))+i32(period))%i32(period));var remaining=u32(hi-lo+1);
 for(var segment=0u;segment<3u && remaining!=0u;segment++){
  let boundary=select(period,size,position<size);let count=min(remaining,boundary-position);
  if position<size{result.ranges[segment]=vec2u(position,position+count-1u);}
  else{result.ranges[segment]=vec2u(period-position-count,period-position-1u);}
  result.count++;remaining-=count;position=(position+count)%period;
 }
 return result;
}
// identity = slot, generation, revision. wrap=0 clamp,1 mirror,2 repeat.
// filters bit0 linear texel, bit1 linear mip. LOD low/high are post-clamp
// actual sampling LODs, including the published mip range and gradient change.
fn tv_query(identity:vec3u,uv_low:vec2f,uv_high:vec2f,lod:vec2f,wrap:vec2u,filters:u32)->TvRange {
 if identity.x==0u || identity.x>=arrayLength(&${pool})/8u || any(uv_low>uv_high) || lod.x>lod.y ||
  any(uv_low!=uv_low)||any(uv_high!=uv_high)||any(lod!=lod)||any(wrap>vec2u(2u)){return tv_unknown();}
 let descriptor=identity.x*8u;let table=${pool}[descriptor+3u];let mips=${pool}[descriptor+2u];
 if table==0u || mips==0u || ${pool}[descriptor+4u]!=identity.y || ${pool}[descriptor+5u]!=identity.z{return tv_unknown();}
 let clamped=clamp(lod,vec2f(0.0),vec2f(f32(mips-1u)));
 var first=u32(floor(clamped.x+0.5));var last=u32(floor(clamped.y+0.5));
 if (filters&2u)!=0u{first=u32(floor(clamped.x));last=u32(ceil(clamped.y));}
 var result=TvRange(vec4f(3.402823466e38),vec4f(-3.402823466e38),1u,0u,0u,0u);
 for(var mip=first;mip<=last;mip++){
  ${visitLimit > 0 ? `if result.visits >= ${visitLimit}u { return TvRange(vec4f(0.0),vec4f(0.0),0u,result.nodes,result.visits,1u); }` : ""}
  result.visits++;
  let row=table+mip*8u;
  if ${pool}[row+4u]==0u{return tv_unknown();}
  let dimensions=vec2u(${pool}[row],${pool}[row+1u]);let levels=${pool}[row+2u];let level_table=${pool}[row+3u];
  let linear=(filters&1u)!=0u;let halo=select(0.0,0.5,linear);
  let lo=floor(uv_low*vec2f(dimensions)-vec2f(halo));let hi=floor(uv_high*vec2f(dimensions)-vec2f(halo))+vec2f(select(0.0,1.0,linear));
  // Bound f32 integer addressing before conversion, including enormous repeat UV.
  if any(abs(lo)>vec2f(8388607.0))||any(abs(hi)>vec2f(8388607.0)){return tv_unknown();}
  let xs=tv_wrap(i32(lo.x),i32(hi.x),dimensions.x,wrap.x);let ys=tv_wrap(i32(lo.y),i32(hi.y),dimensions.y,wrap.y);
  for(var sy=0u;sy<ys.count;sy++){for(var sx=0u;sx<xs.count;sx++){
   let lower=vec2u(xs.ranges[sx].x,ys.ranges[sy].x);let upper=vec2u(xs.ranges[sx].y,ys.ranges[sy].y);
   var level=0u;
   for(;level+1u<levels;level++){
    ${visitLimit > 0 ? `if result.visits >= ${visitLimit}u { return TvRange(vec4f(0.0),vec4f(0.0),0u,result.nodes,result.visits,1u); }` : ""}
    result.visits++;
    let span=${pool}[level_table+level*4u+2u];if all(upper/span-lower/span<vec2u(2u)){break;}}
   let at=level_table+level*4u;let span=${pool}[at+2u];let width=${pool}[at];let data=${pool}[at+3u];
   let begin=lower/span;let end=upper/span;
   for(var y=begin.y;y<=end.y;y++){for(var x=begin.x;x<=end.x;x++){
    ${visitLimit > 0 ? `if result.visits >= ${visitLimit}u { return TvRange(vec4f(0.0),vec4f(0.0),0u,result.nodes,result.visits,1u); }` : ""}
    result.visits++;
    let node=data+(y*width+x)*8u;
    let low=bitcast<vec4f>(vec4u(${pool}[node],${pool}[node+1u],${pool}[node+2u],${pool}[node+3u]));
    let high=bitcast<vec4f>(vec4u(${pool}[node+4u],${pool}[node+5u],${pool}[node+6u],${pool}[node+7u]));
    result.low=min(result.low,low);result.high=max(result.high,high);result.nodes++;
   }}
  }}
 }
 return result;
}
`;
}
