/** Frame deformation input shared by resident geometry and Surface identity.
 * Joint palettes are published once per scene revision; vertices reference the
 * palette through geometry attributes and are never CPU read back per frame. */
export const GPU_DEFORMATION_JOINT_STRIDE = 64;
export const GPU_DEFORMATION_WGSL = /* wgsl */ `
struct OEngineJointPaletteHeader { base: u32, count: u32, generation: u32, flags: u32 }
struct OEngineJoint { matrix0: vec4f, matrix1: vec4f, matrix2: vec4f, normal0: vec4f, normal1: vec4f, normal2: vec4f }
fn oengine_deform_position(palette: ptr<storage, array<OEngineJoint>, read>, header: OEngineJointPaletteHeader,
  joints: vec4u, weights: vec4f, position: vec3f) -> vec3f {
  var result = vec4f(0.0);
  let ids = array<u32,4>(joints.x, joints.y, joints.z, joints.w);
  let ws = array<f32,4>(weights.x, weights.y, weights.z, weights.w);
  for (var i = 0u; i < 4u; i++) {
    if (ids[i] >= header.count) { continue; }
    let j = (*palette)[header.base + ids[i]];
    result += vec4f(dot(j.matrix0, vec4f(position, 1.0)), dot(j.matrix1, vec4f(position, 1.0)), dot(j.matrix2, vec4f(position, 1.0)), 1.0) * ws[i];
  }
  return result.xyz;
}
`;
