/** Pure shared BRDF mathematics. No cluster, Surface owner or GPU work protocol. */
export const LIGHTING_BRDF_TYPES_WGSL = /* wgsl */ `
struct StandardMaterial {
  diffuse: vec3f,
  roughness: f32,
  occlusion: f32,
  specularF0: vec3f,
  specularF90: f32,
  energyCompensation: vec3f,
  emissive: vec3f,
  opacity: f32,
  coatFactor: f32,
  coatRoughness: f32,
  coatNormal: vec3f,
}

struct SurfaceGeometry {
  shading_normal: vec3f,
  geometric_normal: vec3f,
  position: vec3f,
  view_direction: vec3f,
}

struct ReflectedLight {
  diffuse: vec3f,
  specular: vec3f,
}

`;

export const LIGHTING_BRDF_MATH_WGSL = /* wgsl */ `
fn D_GGX(alpha_squared: f32, no_h_squared: f32) -> f32 {
  let denominator = no_h_squared * (alpha_squared - 1.0) + 1.0;
  return alpha_squared / (PI * denominator * denominator);
}

fn V_GGX_SmithCorrelated(alpha: f32, no_l: f32, no_v: f32) -> f32 {
  let alpha_squared = alpha * alpha;
  let lambda_v = no_l * sqrt(fma(no_v * no_v, 1.0 - alpha_squared, alpha_squared));
  let lambda_l = no_v * sqrt(fma(no_l * no_l, 1.0 - alpha_squared, alpha_squared));
  return 0.5 / max(lambda_v + lambda_l, EPSILON);
}

fn F_Schlick(f0: vec3f, f90: f32, cosine: f32) -> vec3f {
  // Filament surface BRDF invariant: Schlick's fifth-power Fresnel, with
  // scene-linear F0/F90 endpoints. The old implementation interpolated to
  // (F90 - cosine) with a fourth power, which darkened grazing highlights.
  let one_minus = 1.0 - saturate(cosine);
  let fifth = one_minus * one_minus * one_minus * one_minus * one_minus;
  return f0 + (vec3f(f90) - f0) * fifth;
}

fn BRDF_GGX(
  no_l: f32,
  no_v: f32,
  no_h_squared: f32,
  vo_h: f32,
  f0: vec3f,
  f90: f32,
  alpha: f32
) -> vec3f {
  return F_Schlick(f0, f90, vo_h) *
    V_GGX_SmithCorrelated(alpha, no_l, no_v) *
    D_GGX(alpha * alpha, no_h_squared);
}

fn finite_f32(value: f32) -> bool {
  return value == value && abs(value) <= 3.402823e38;
}

fn re_direct_physical(
  incident: GpuPrimitiveTypeTable,
  geometry: SurfaceGeometry,
  material: StandardMaterial,
  reflected: ptr<function, ReflectedLight>
) {
  let n = geometry.shading_normal;
  let l = incident.direction;
  let v = geometry.view_direction;
  let h = normalize(l + v);
  let no_l = saturate(dot(n, l));
  let no_v = saturate(dot(n, v));
  let vo_h = saturate(dot(v, h));
  let no_h = saturate(dot(n, h));
  let alpha = max(material.roughness * material.roughness, 0.002);
  let radiance = no_l * incident.color;
  let specular = BRDF_GGX(
    no_l,
    no_v,
    no_h * no_h,
    vo_h,
    material.specularF0,
    material.specularF90,
    alpha
  ) * material.energyCompensation;
  // Filament Standard profile uses Lambert for the direct diffuse lobe.
  let diffuse = material.diffuse;
  var base_attenuation = 1.0;
  var coat_radiance = vec3f(0.0);
  if material.coatFactor > 0.0 {
    // Filament clearCoatLobe: GGX D, Kelemen V and fixed 1.5-IOR F0.
    let coat_no_h = saturate(dot(material.coatNormal, h));
    let coat_no_l = saturate(dot(material.coatNormal, l));
    let coat_alpha = max(material.coatRoughness * material.coatRoughness, 0.002);
    let coat_fresnel = (0.04 + 0.96 * pow(1.0 - vo_h, 5.0)) * material.coatFactor;
    let coat_brdf = D_GGX(coat_alpha * coat_alpha, coat_no_h * coat_no_h) *
      (0.25 / max(vo_h * vo_h, 0.0000039)) * coat_fresnel;
    base_attenuation = 1.0 - coat_fresnel;
    coat_radiance = incident.color * coat_no_l * coat_brdf;
  }
  let contribution = radiance * (specular + diffuse * RECIPROCAL_PI) *
    base_attenuation + coat_radiance;
  if !all(vec3<bool>(
    finite_f32(contribution.x), finite_f32(contribution.y), finite_f32(contribution.z)
  )) {
    return;
  }
  (*reflected).specular += radiance * specular * base_attenuation + coat_radiance;
  (*reflected).diffuse += radiance * diffuse * RECIPROCAL_PI * base_attenuation;
}

`;
