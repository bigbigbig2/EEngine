/**
 * meshlet_read：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

export const MESHLET_READ_WGSL = /* wgsl */ `
struct MeshletHeader {
  bounds_box: array<f32, 6>,
  address: u32,
  primitive_count: u32,
  vertex_count: u32,
  flags: u32,
};

struct MeshletVertex {
  position: vec3f,
  normal: vec3f,
  tangent: vec4f,
  uv: vec2f,
  uv1: vec2f,
  color: vec3f,
};

fn read_meshlet_header(meshlet_id: u32) -> MeshletHeader {
  let offset = meshlet_id * 10u;
  var header: MeshletHeader;
  header.bounds_box = array<f32, 6>(
    bitcast<f32>(meshlet_headers[offset]),
    bitcast<f32>(meshlet_headers[offset + 1u]),
    bitcast<f32>(meshlet_headers[offset + 2u]),
    bitcast<f32>(meshlet_headers[offset + 3u]),
    bitcast<f32>(meshlet_headers[offset + 4u]),
    bitcast<f32>(meshlet_headers[offset + 5u])
  );
  header.address = meshlet_headers[offset + 6u];
  header.primitive_count = meshlet_headers[offset + 7u];
  header.vertex_count = meshlet_headers[offset + 8u];
  header.flags = meshlet_headers[offset + 9u];
  return header;
}

fn read_meshlet_attribute_u32(offset: u32) -> u32 {
  return meshlet_data[offset];
}

fn read_meshlet_attribute_vec2f(offset: u32) -> vec2f {
  return vec2f(
    bitcast<f32>(meshlet_data[offset]),
    bitcast<f32>(meshlet_data[offset + 1u])
  );
}

fn read_meshlet_attribute_vec3f(offset: u32) -> vec3f {
  return vec3f(
    bitcast<f32>(meshlet_data[offset]),
    bitcast<f32>(meshlet_data[offset + 1u]),
    bitcast<f32>(meshlet_data[offset + 2u])
  );
}

fn meshlet_uv_octahedral_unit_decode(encoded: vec2f) -> vec3f {
  var unit = encoded * 2.0 - 1.0;
  var normal = vec3f(unit.x, unit.y, 1.0 - abs(unit.x) - abs(unit.y));
  let fold = max(-normal.z, 0.0);
  normal.x += select(fold, -fold, normal.x > 0.0);
  normal.y += select(fold, -fold, normal.y > 0.0);
  return normalize(normal);
}

fn decode_vertex_color(packed: u32) -> vec3f {
  return unpack4x8unorm(packed).xyz;
}

fn decode_vertex_normal(packed: u32) -> vec3f {
  let encoded = (vec2u(packed) >> vec2u(0u, 16u)) & vec2u(0xFFFFu, 0xFFFFu);
  return meshlet_uv_octahedral_unit_decode(vec2f(encoded) / vec2f(65535.0));
}

fn decode_vertex_tangent(packed: u32) -> vec4f {
  let handedness = f32(packed & 1u) * 2.0 - 1.0;
  let encoded = (vec2u(packed) >> vec2u(1u, 16u)) & vec2u(0x7FFFu, 0xFFFFu);
  let tangent = meshlet_uv_octahedral_unit_decode(
    vec2f(encoded) / vec2f(32767.0, 65535.0)
  );
  return vec4f(tangent, handedness);
}

fn meshlet_compute_attribute_section_offset(header: MeshletHeader) -> u32 {
  let index_words = (header.primitive_count * 3u + 3u) >> 2u;
  return header.address + index_words;
}

fn read_meshlet_vertex(header: MeshletHeader, vertex_id: u32) -> MeshletVertex {
  let attribute_offset = meshlet_compute_attribute_section_offset(header);
  let clamped_vertex_id = min(vertex_id, header.vertex_count - 1u);
  var output: MeshletVertex;
  var offset = attribute_offset;

  output.position = read_meshlet_attribute_vec3f(offset + clamped_vertex_id * 3u);
  offset += header.vertex_count * 3u;

  let normal_compressed = (header.flags & 1u) != 0u;
  let normal_offset = select(clamped_vertex_id, 0u, normal_compressed);
  output.normal = decode_vertex_normal(read_meshlet_attribute_u32(offset + normal_offset));
  offset += select(header.vertex_count, 1u, normal_compressed);

  let tangent_compressed = (header.flags & 2u) != 0u;
  let tangent_offset = select(clamped_vertex_id, 0u, tangent_compressed);
  output.tangent = decode_vertex_tangent(read_meshlet_attribute_u32(offset + tangent_offset));
  offset += select(header.vertex_count, 1u, tangent_compressed);

  let color_compressed = (header.flags & 4u) != 0u;
  let color_offset = select(clamped_vertex_id, 0u, color_compressed);
  output.color = decode_vertex_color(read_meshlet_attribute_u32(offset + color_offset));
  offset += select(header.vertex_count, 1u, color_compressed);

  let uv_compressed = (header.flags & 8u) != 0u;
  let uv_offset = select(clamped_vertex_id, 0u, uv_compressed);
  output.uv = read_meshlet_attribute_vec2f(offset + uv_offset * 2u);
  // 未压缩 UV 每个顶点占两个字，但此处的 UV1 起始偏移只前进一个顶点计数；
  // 这个布局属于当前 Meshlet 数据格式，读取端必须保持一致。
  offset += select(header.vertex_count, 2u, uv_compressed);

  let uv1_compressed = (header.flags & 16u) != 0u;
  let uv1_offset = select(clamped_vertex_id, 0u, uv1_compressed);
  output.uv1 = unpack2x16unorm(read_meshlet_attribute_u32(offset + uv1_offset));

  return output;
}

fn read_meshlet_resolved_index(header: MeshletHeader, draw_index: u32) -> u32 {
  let word_offset = draw_index >> 2u;
  let bit_offset = (draw_index & 0x03u) << 3u;
  let packed = read_meshlet_attribute_u32(header.address + word_offset);
  return (packed >> bit_offset) & 0xFFu;
}

fn read_meshlet_vertex_by_draw_index(
  header: MeshletHeader,
  draw_index: u32
) -> MeshletVertex {
  let last_draw_index = header.primitive_count * 3u - 1u;
  let clamped_draw_index = min(draw_index, last_draw_index);
  let vertex_id = read_meshlet_resolved_index(header, clamped_draw_index);
  return read_meshlet_vertex(header, vertex_id);
}

// 将三个顶点及其属性聚合为后续材质和光栅阶段使用的三角形记录。
struct MeshletTri {
  pa: vec3f,
  pb: vec3f,
  pc: vec3f,
  na: vec3f,
  nb: vec3f,
  nc: vec3f,
  uva: vec2f,
  uvb: vec2f,
  uvc: vec2f,
  ca: vec3f,
  cb: vec3f,
  cc: vec3f,
  ta: vec4f,
  tb: vec4f,
  tc: vec4f,
  uv1a: vec2f,
  uv1b: vec2f,
  uv1c: vec2f,
};

fn read_meshlet_triangle_vertices(meshlet_id: u32, triangle_id: u32) -> MeshletTri {
  let header = read_meshlet_header(meshlet_id);
  let index_offset = triangle_id * 3u;
  let index_a = read_meshlet_resolved_index(header, index_offset);
  let index_b = read_meshlet_resolved_index(header, index_offset + 1u);
  let index_c = read_meshlet_resolved_index(header, index_offset + 2u);
  let a = read_meshlet_vertex(header, index_a);
  let b = read_meshlet_vertex(header, index_b);
  let c = read_meshlet_vertex(header, index_c);
  var output: MeshletTri;
  output.pa = a.position;
  output.pb = b.position;
  output.pc = c.position;
  output.na = a.normal;
  output.nb = b.normal;
  output.nc = c.normal;
  output.uva = a.uv;
  output.uvb = b.uv;
  output.uvc = c.uv;
  output.ca = a.color;
  output.cb = b.color;
  output.cc = c.color;
  output.ta = a.tangent;
  output.tb = b.tangent;
  output.tc = c.tangent;
  output.uv1a = a.uv1;
  output.uv1b = b.uv1;
  output.uv1c = c.uv1;
  return output;
}
`;

export const BARYCENTRIC_UV_WGSL = /* wgsl */ `
struct BaryDeriv {
  lambda: vec3f,
  ddx: vec3f,
  ddy: vec3f,
};

struct UvDeriv {
  uv: vec2f,
  ddx: vec2f,
  ddy: vec2f,
};

fn barycentric_full(pt0: vec4f, pt1: vec4f, pt2: vec4f, pixel: vec2f) -> BaryDeriv {
  var out: BaryDeriv;
  out.lambda = vec3f(1.0, 0.0, 0.0);
  out.ddx = vec3f(0.0);
  out.ddy = vec3f(0.0);

  let invW = 1.0 / vec3f(pt0.w, pt1.w, pt2.w);
  let ndc0 = pt0.xy * invW.x;
  let ndc1 = pt1.xy * invW.y;
  let ndc2 = pt2.xy * invW.z;

  let m = mat2x2f(ndc2 - ndc1, ndc0 - ndc1);
  let det = determinant(m);
  if (abs(det) < 1e-12) {
    return out;
  }
  let det_multiplier = invW / det;

  let m_ddx = vec3f(ndc1.y - ndc2.y, ndc2.y - ndc0.y, ndc0.y - ndc1.y) * det_multiplier;
  let m_ddy = vec3f(ndc2.x - ndc1.x, ndc0.x - ndc2.x, ndc1.x - ndc0.x) * det_multiplier;

  let ddxSum = dot(m_ddx, vec3f(1.0));
  let ddySum = dot(m_ddy, vec3f(1.0));
  let deltaVec = pixel - ndc0;

  let interpInvW = invW.x + deltaVec.x * ddxSum + deltaVec.y * ddySum;
  if (abs(interpInvW) < 1e-12) {
    return out;
  }
  let interpW = 1.0 / interpInvW;

  let m_lambda = vec3f(
    interpW * (invW.x + deltaVec.x * m_ddx.x + deltaVec.y * m_ddy.x),
    interpW * (deltaVec.x * m_ddx.y + deltaVec.y * m_ddy.y),
    interpW * (deltaVec.x * m_ddx.z + deltaVec.y * m_ddy.z)
  );

  let interpW_ddx = 1.0 / (interpInvW + ddxSum);
  let interpW_ddy = 1.0 / (interpInvW + ddySum);
  let liw = m_lambda * interpInvW;

  out.lambda = m_lambda;
  out.ddx = interpW_ddx * (liw + m_ddx) - m_lambda;
  out.ddy = interpW_ddy * (liw + m_ddy) - m_lambda;
  return out;
}

fn interpolate_with_derivatives(bary: BaryDeriv, a: f32, b: f32, c: f32) -> vec3f {
  let value = vec3f(a, b, c);
  return vec3f(dot(value, bary.lambda), dot(value, bary.ddx), dot(value, bary.ddy));
}

fn barycentric_interpolate_uv(bary: BaryDeriv, uv0: vec2f, uv1: vec2f, uv2: vec2f) -> UvDeriv {
  let x = interpolate_with_derivatives(bary, uv0.x, uv1.x, uv2.x);
  let y = interpolate_with_derivatives(bary, uv0.y, uv1.y, uv2.y);
  var out: UvDeriv;
  out.uv = vec2f(x.x, y.x);
  out.ddx = vec2f(x.y, y.y);
  out.ddy = vec2f(x.z, y.z);
  return out;
}

fn interpolate_attribute_3f32(a: vec3f, b: vec3f, c: vec3f, lambda: vec3f) -> vec3f {
  return a * lambda.x + b * lambda.y + c * lambda.z;
}

fn textureSampleBarycentric(
  tex: texture_2d<f32>,
  samp: sampler,
  uvd: UvDeriv
) -> vec4f {
  return textureSampleGrad(tex, samp, uvd.uv, uvd.ddx, uvd.ddy);
}
`;
