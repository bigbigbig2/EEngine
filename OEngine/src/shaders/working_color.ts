/** glTF material, direct-light and atmosphere RGB is linear Rec.709 at source. */
export const LINEAR_REC709_TO_REC2020_WGSL = /* wgsl */ `
fn oengine_linear_rec709_to_rec2020(c:vec3f)->vec3f {
  return mat3x3f(
    vec3f(0.6274040,0.0690970,0.0163916),
    vec3f(0.3292820,0.9195400,0.0880132),
    vec3f(0.0433136,0.0113612,0.8955950))*c;
}
`;
