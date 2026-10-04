/** SurfaceGeometry-owned analytic address/footprint math. Inputs are primitive
 * setup coefficients and source-corner attributes from the existing geometry
 * arena. This never constructs a full per-pixel GeometryRecord. The fractional
 * affine value extrema are at rectangle corners when D has constant sign;
 * finite-pixel derivatives retain the actual winner interpolation convention.
 * Requires WINNER_INTERPOLATION_WGSL and APPEARANCE_FIELD_BOUND_WGSL. */
export const SURFACE_CELL_ADDRESS_MATH_WGSL = /* wgsl */ `
struct CellScalarFootprint {value:AppearanceBound,dx:AppearanceBound,dy:AppearanceBound,}
fn cell_address_unknown()->CellScalarFootprint{return CellScalarFootprint(ab_unknown(),ab_unknown(),ab_unknown());}
fn cell_affine_range(row:vec3f,ndc_low:vec2f,ndc_high:vec2f)->AppearanceBound {
 let a=dot(row,vec3f(ndc_low,1.0));let b=dot(row,vec3f(ndc_high.x,ndc_low.y,1.0));
 let c=dot(row,vec3f(ndc_low.x,ndc_high.y,1.0));let d=dot(row,vec3f(ndc_high,1.0));
 return ab_expand(min(min(a,b),min(c,d)),max(max(a,b),max(c,d)));
}
fn cell_scalar_footprint(coeff:WinnerCoefficients,values:vec3f,pixel_low:vec2f,pixel_high:vec2f,viewport:vec2f)->CellScalarFootprint {
 if coeff.row0.w==0.0 || any(pixel_low>pixel_high) || any(viewport<=vec2f(0.0)){return cell_address_unknown();}
 let numerator=coeff.row0.xyz*values.x+coeff.row1.xyz*values.y+coeff.row2.xyz*values.z;
 let denominator=coeff.row0.xyz+coeff.row1.xyz+coeff.row2.xyz;
 let low=vec2f(pixel_low.x/viewport.x*2.0-1.0,1.0-pixel_high.y/viewport.y*2.0);
 let high=vec2f(pixel_high.x/viewport.x*2.0-1.0,1.0-pixel_low.y/viewport.y*2.0);
 let ndc_magnitude=vec3f(max(abs(low),abs(high)),1.0);
 // The consumer's q-dot / weighted-attribute sequence differs in rounding
 // from folding attributes into affine numerator rows. Include cancellation
 // error from absolute terms, not only a relative error of the final value.
 let row_d_error=(abs(coeff.row0.xyz)+abs(coeff.row1.xyz)+abs(coeff.row2.xyz))*0.0000019073486328125;
 let row_n_error=(abs(coeff.row0.xyz)*abs(values.x)+abs(coeff.row1.xyz)*abs(values.y)+abs(coeff.row2.xyz)*abs(values.z))*0.0000019073486328125;
 let d_error=dot(row_d_error,ndc_magnitude)+1e-30;let n_error=dot(row_n_error,ndc_magnitude)+1e-30;
 var d=cell_affine_range(denominator,low,high);d.low-=d_error;d.high+=d_error;
 if !ab_valid(d) || (d.low<=0.0&&d.high>=0.0){return cell_address_unknown();}
 let a=dot(numerator,vec3f(low,1.0))/dot(denominator,vec3f(low,1.0));
 let b=dot(numerator,vec3f(high.x,low.y,1.0))/dot(denominator,vec3f(high.x,low.y,1.0));
 let c=dot(numerator,vec3f(low.x,high.y,1.0))/dot(denominator,vec3f(low.x,high.y,1.0));
 let e=dot(numerator,vec3f(high,1.0))/dot(denominator,vec3f(high,1.0));
 var value=ab_expand(min(min(a,b),min(c,e)),max(max(a,b),max(c,e)));
 let value_error=(n_error+d_error*max(abs(value.low),abs(value.high)))/min(abs(d.low),abs(d.high));
 value.low-=value_error;value.high+=value_error;
 // f(x+1)-f(x)=(Nx*D-N*Dx)/(D*(D+Dx)); this numerator is
 // affine in y. The y step is negative in centered NDC, matching winner dx/dy.
 let sx=2.0/viewport.x;let sy=-2.0/viewport.y;
 let nx=numerator.x*sx;let dx=denominator.x*sx;let ny=numerator.y*sy;let dy=denominator.y*sy;
 let xrow=nx*denominator-dx*numerator;let yrow=ny*denominator-dy*numerator;
 var dx_d=cell_affine_range(denominator,low+vec2f(sx,0.0),high+vec2f(sx,0.0));
 var dy_d=cell_affine_range(denominator,low+vec2f(0.0,sy),high+vec2f(0.0,sy));
 let shifted_d_error=d_error+dot(row_d_error,vec3f(abs(sx),abs(sy),0.0));
 dx_d.low-=shifted_d_error;dx_d.high+=shifted_d_error;dy_d.low-=shifted_d_error;dy_d.high+=shifted_d_error;
 let derivative_magnitude=max(abs(value.low),abs(value.high))+1.0;
 // Include finite-difference rounding of the consumer's two recovered values.
 var ddx=ab_divide(cell_affine_range(xrow,low,high),ab_multiply(d,dx_d));
 var ddy=ab_divide(cell_affine_range(yrow,low,high),ab_multiply(d,dy_d));
 let finite_error=2.0*value_error+derivative_magnitude*0.0000019073486328125;
 ddx.low-=finite_error;ddx.high+=finite_error;ddy.low-=finite_error;ddy.high+=finite_error;
 return CellScalarFootprint(value,ddx,ddy);
}
fn cell_rect_from_mask(mask:vec2u,origin:vec2u)->vec4f {
 var low=vec2u(8u);var high=vec2u(0u);
 for(var i=0u;i<64u;i++){
  let word=select(mask.x,mask.y,i>=32u);
  if (word&(1u<<(i&31u)))!=0u{let p=vec2u(i%8u,i/8u);low=min(low,p);high=max(high,p);}
 }
 return vec4f(vec2f(origin+low)+vec2f(0.5),vec2f(origin+high)+vec2f(0.5));
}
fn cell_parameter_scalar_footprint(coeff:WinnerCoefficients,values:vec3f,domain:vec4f,
  gradient_low:vec4f,gradient_high:vec4f)->CellScalarFootprint {
  if coeff.row0.w==0.0 || any(domain.xy>domain.zw) { return cell_address_unknown(); }
  let numerator=coeff.row0.xyz*values.x+coeff.row1.xyz*values.y+coeff.row2.xyz*values.z;
  let denominator=coeff.row0.xyz+coeff.row1.xyz+coeff.row2.xyz;
  let absolute_rows=abs(coeff.row0.xyz)+abs(coeff.row1.xyz)+abs(coeff.row2.xyz);
  let magnitude=vec3f(max(abs(domain.xy),abs(domain.zw)),1.0);
  let d_error=dot(absolute_rows,magnitude)*0.0000019073486328125+1e-30;
  let n_error=dot(abs(coeff.row0.xyz)*abs(values.x)+abs(coeff.row1.xyz)*abs(values.y)+abs(coeff.row2.xyz)*abs(values.z),magnitude)*0.0000019073486328125+1e-30;
  var d=cell_affine_range(denominator,domain.xy,domain.zw);
  d.low-=d_error;d.high+=d_error;
  if !ab_valid(d) || (d.low<=0.0 && d.high>=0.0) { return cell_address_unknown(); }
  // UV clip W is exactly one. Small computed XY denominator residuals are
  // enclosed rather than assumed zero; ill-conditioned UV triangles go unknown.
  let n=cell_affine_range(numerator,domain.xy,domain.zw);
  var expanded=n;expanded.low-=n_error;expanded.high+=n_error;
  let value=ab_divide(expanded,d);
  let du=ab_divide(ab_subtract(ab_multiply(ab_exact(numerator.x),d),
    ab_multiply(expanded,ab_exact(denominator.x))),ab_square(d));
  let dv=ab_divide(ab_subtract(ab_multiply(ab_exact(numerator.y),d),
    ab_multiply(expanded,ab_exact(denominator.y))),ab_square(d));
  var dx=ab_add(ab_multiply(du,AppearanceBound(gradient_low.x,gradient_high.x,1u)),
    ab_multiply(dv,AppearanceBound(gradient_low.y,gradient_high.y,1u)));
  var dy=ab_add(ab_multiply(du,AppearanceBound(gradient_low.z,gradient_high.z,1u)),
    ab_multiply(dv,AppearanceBound(gradient_low.w,gradient_high.w,1u)));
  let rounding=(max(abs(value.low),abs(value.high))+1.0)*0.00000762939453125;
  var result=value;result.low-=rounding;result.high+=rounding;
  dx.low-=rounding;dx.high+=rounding;dy.low-=rounding;dy.high+=rounding;
  return CellScalarFootprint(result,dx,dy);
}
fn cell_normal_box_cone(low:vec3f,high:vec3f)->vec4f {
 // A box enclosing zero cannot certify a shading direction.
 let nearest=select(min(abs(low),abs(high)),vec3f(0.0),(low<=vec3f(0.0))&(high>=vec3f(0.0)));
 if dot(nearest,nearest)<1e-12{return vec4f(0.0,0.0,1.0,-1.0);}
 let center=(low+high)*0.5;let length2=dot(center,center);
 if length2<1e-12{return vec4f(0.0,0.0,1.0,-1.0);}
 let axis=center*inverseSqrt(length2);let radius=(high-low)*0.5;let radius2=dot(radius,radius);
 // The box's enclosing sphere certifies every interior direction, including
 // edge extrema. A sphere containing the origin has no useful angular bound.
 if radius2>=length2{return vec4f(axis,-1.0);}
 let cosine=sqrt(max(0.0,1.0-radius2/length2));
 return vec4f(axis,cosine);
}
`;
