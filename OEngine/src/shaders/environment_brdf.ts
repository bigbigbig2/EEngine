/**
 * Shared metallic/roughness environment BRDF terms.
 *
 * The split-sum DFG interpretation and multiple-scattering compensation are
 * shared by the receiver-inline and deferred-indirect paths. Keeping this
 * source in one module prevents the two physical schedules from changing PBR
 * semantics. Filament is the mathematical reference recorded by SHADE-PBR in
 * docs/porting/shading.md; this WGSL is OEngine-authored.
 */

export const OENGINE_ENVIRONMENT_BRDF_WGSL = /* wgsl */ `
fn oengine_ibl_directional_albedo(
  split_sum: vec2f,
  specular_f0: vec3f,
  specular_f90: f32
) -> vec3f {
  let single_scatter = specular_f0 * split_sum.x + specular_f90 * split_sum.y;
  let integrated_response = split_sum.x + split_sum.y;
  let missing_response = 1.0 - integrated_response;
  let multiple_scatter = single_scatter * specular_f0 *
    (missing_response / max(integrated_response, 1e-4));
  return single_scatter + multiple_scatter;
}

fn oengine_ibl_diffuse_energy(directional_albedo: vec3f) -> vec3f {
  return clamp(vec3f(1.0) - directional_albedo, vec3f(0.0), vec3f(1.0));
}
`;

export type EnvironmentBrdfVec3 = readonly [number, number, number];

/** CPU oracle for the exact WGSL algebra above. */
export function evaluateEnvironmentBrdfReference(
  splitSum: readonly [number, number],
  specularF0: EnvironmentBrdfVec3,
  specularF90: number
): Readonly<{
  directionalAlbedo: EnvironmentBrdfVec3;
  diffuseEnergy: EnvironmentBrdfVec3;
}> {
  const values = [...splitSum, ...specularF0, specularF90];
  if (!values.every(Number.isFinite)) {
    throw new RangeError("Environment BRDF inputs must be finite");
  }
  const integratedResponse = splitSum[0] + splitSum[1];
  const ratio = (1 - integratedResponse) / Math.max(integratedResponse, 1e-4);
  const directionalAlbedo = specularF0.map((f0) => {
    const singleScatter = f0 * splitSum[0] + specularF90 * splitSum[1];
    return singleScatter + singleScatter * f0 * ratio;
  }) as unknown as EnvironmentBrdfVec3;
  const diffuseEnergy = directionalAlbedo.map((value) =>
    Math.min(1, Math.max(0, 1 - value))) as unknown as EnvironmentBrdfVec3;
  return Object.freeze({
    directionalAlbedo: Object.freeze(directionalAlbedo),
    diffuseEnergy: Object.freeze(diffuseEnergy)
  });
}
