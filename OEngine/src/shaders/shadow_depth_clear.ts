/** Reversed-Z depth clear used by the unified directional shadow pass. */
export const SHADOW_DEPTH_CLEAR_WGSL = /* wgsl */ `
const positions = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f( 3.0, -1.0),
  vec2f(-1.0,  3.0),
);

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  return vec4f(positions[vertex_index], 0.0, 1.0);
}

@fragment
fn fs_main() -> @builtin(frag_depth) f32 {
  return 0.0;
}
`;
