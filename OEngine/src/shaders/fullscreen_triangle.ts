export const FULLSCREEN_TRIANGLE_VERTEX_WGSL = /* wgsl */ `
const fullscreen_triangle_positions = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f(3.0, -1.0),
  vec2f(-1.0, 3.0)
);

struct FullscreenTriangleVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn main(@builtin(vertex_index) vertex_index: u32) -> FullscreenTriangleVertexOutput {
  let ndc = fullscreen_triangle_positions[vertex_index];
  var output: FullscreenTriangleVertexOutput;
  output.position = vec4f(ndc, 0.0, 1.0);
  output.uv = fma(ndc, vec2f(0.5, -0.5), vec2f(0.5));
  return output;
}
`;
