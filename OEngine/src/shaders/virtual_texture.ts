import {
  VT_ATLAS_SIZE,
  VT_TABLE_WIDTH,
  VT_MIP_WORDS,
  VT_FEEDBACK_MAILBOX_WORDS,
  VT_PAGE_CAPACITY,
} from "../gpu/VirtualTextureAbi.js";

/** LibVT 464397d9 (MIT), renderVT.frag::mipmapLevel and non-fallback-entry
 * lookup/physical gradients; Wicked 54518f2c (MIT), ShaderTextureSlot::SampleVirtual
 * dual-mip interpolation. Explicit source gradients, NPOT integer mip records
 * and a complete protected tail replace GL derivatives/POT/bindless assumptions.
 * Notices and unchanged donor source: tests/oracle/reference/vt/. */
export const VIRTUAL_TEXTURE_SAMPLE_WGSL = /* wgsl */ `
struct NativeVtLookup {
  slot: u32,
  generation: u32,
  level: u32,
  page: u32,
  local: vec2f,
  extent: vec2f,
}
fn native_vt_u32(base: u32, at: u32) -> u32 {
  return u32(native_material_constant(base, at)) |
    (u32(native_material_constant(base, at + 1u)) << 16u);
}
fn native_vt_lookup(table: texture_2d_array<u32>, material: u32, metadata: u32,
    levels: u32, tail: u32, target_level: u32, uv: vec2f) -> NativeVtLookup {
  var level = target_level;
  loop {
    let at = metadata + level * ${VT_MIP_WORDS}u;
    let extent = vec2f(native_material_constant(material, at), native_material_constant(material, at + 1u));
    let grid_width = u32(native_material_constant(material, at + 2u));
    let tile = min(vec2u(floor(uv * extent / 128.0)), vec2u(ceil(extent / 128.0)) - 1u);
    let base = native_vt_u32(material, at + 3u);
    let page = base + select(tile.y * grid_width + tile.x, 0u, level >= tail);
    if level == target_level { native_vt_record(page, 1u); }
    let entry = textureLoad(table, vec2i(i32(page % ${VT_TABLE_WIDTH}u),
      i32(page / ${VT_TABLE_WIDTH}u)), 0, 0).rg;
    if entry.x != 0xffffffffu && entry.y != 0u {
      native_vt_record(page, 2u);
      let origin = vec2f(native_material_constant(material, at + 5u),
        native_material_constant(material, at + 6u));
      let local = uv * extent - select(vec2f(tile) * 128.0, vec2f(0.0), level >= tail) + origin + 8.0;
      return NativeVtLookup(entry.x, entry.y, level, page, local, extent);
    }
    // Creation admits and uploads every protected tail before publication.
    // This bound also makes malformed input incapable of an unbounded loop.
    if level + 1u >= levels { break; }
    level += 1u;
  }
  return NativeVtLookup(0u, 0u, level, 0u, vec2f(0.0), vec2f(1.0));
}
fn native_vt_physical(atlas: texture_2d_array<f32>, filtering: sampler,
    hit: NativeVtLookup, dx: vec2f, dy: vec2f, linear: bool) -> vec4f {
  if hit.generation == 0u { return vec4f(0.0); }
  let slot = hit.slot % 256u;
  let offset = vec2f(f32(slot % 16u), f32(slot / 16u)) * 144.0;
  let coordinate = (offset + hit.local) / ${VT_ATLAS_SIZE}.0;
  let layer = i32(hit.slot / 256u);
  // A 1x1 virtual level has a constant cooked gutter. Arbitrarily large
  // derivatives at this terminal mip must not escape into adjacent tail cells.
  if !linear || all(hit.extent == vec2f(1.0)) {
    return textureSampleLevel(atlas, filtering, coordinate, layer, 0.0);
  }
  return textureSampleGrad(atlas, filtering, coordinate, layer,
    dx * hit.extent / ${VT_ATLAS_SIZE}.0, dy * hit.extent / ${VT_ATLAS_SIZE}.0);
}
fn native_vt_sample(table: texture_2d_array<u32>, atlas: texture_2d_array<f32>, filtering: sampler,
    material: u32, metadata: u32, levels: u32, tail: u32, address: u32, linear: bool,
    original_uv: vec2f, source_dx: vec2f, source_dy: vec2f) -> vec4f {
  let extent = vec2f(native_material_constant(material, metadata),
    native_material_constant(material, metadata + 1u));
  // Finite graph inputs can still overflow during footprint multiplication.
  let dx = clamp(select(vec2f(0.0), source_dx, source_dx == source_dx), vec2f(-1e12), vec2f(1e12));
  let dy = clamp(select(vec2f(0.0), source_dy, source_dy == source_dy), vec2f(-1e12), vec2f(1e12));
  let vx = dx * extent;
  let vy = dy * extent;
  let pmax = max(dot(vx, vx), dot(vy, vy));
  let pmin = min(dot(vx, vx), dot(vy, vy));
  let anisotropy = select(1.0, min(ceil(pmax / max(pmin, 1e-30)), 64.0), linear);
  let lambda = clamp(0.5 * log2(max(pmax / max(anisotropy, 1.0), 1e-30)), 0.0, f32(levels - 1u));
  let raw = clamp(select(vec2f(0.0), original_uv, original_uv == original_uv), vec2f(-1e12), vec2f(1e12));
  var uv = clamp(raw, vec2f(0.0), vec2f(1.0));
  var direction = vec2f(1.0);
  for (var axis = 0u; axis < 2u; axis++) {
    let mode = (address >> (axis * 2u)) & 3u;
    if mode == 1u {
      uv[axis] = fract(raw[axis]);
    } else if mode == 2u {
      let wrapped = raw[axis] - floor(raw[axis] * 0.5) * 2.0;
      uv[axis] = select(wrapped, 2.0 - wrapped, wrapped > 1.0);
      direction[axis] = select(1.0, -1.0, wrapped > 1.0);
    }
  }
  let first = u32(select(floor(lambda + 0.5), floor(lambda), linear));
  let a = native_vt_lookup(table, material, metadata, levels, tail, first, uv);
  let color = native_vt_physical(atlas, filtering, a, dx * direction, dy * direction, linear);
  if !linear || first + 1u >= levels { return color; }
  let b = native_vt_lookup(table, material, metadata, levels, tail, first + 1u, uv);
  if a.page == b.page && a.level == b.level { return color; }
  return mix(color, native_vt_physical(atlas, filtering, b, dx * direction, dy * direction, true), fract(lambda));
}
`;

export const VIRTUAL_TEXTURE_FEEDBACK_WGSL = /* wgsl */ `
@group(2) @binding(1) var<storage, read_write> native_vt_feedback: array<atomic<u32>>;
// Direct-mapped workgroup mailbox, zero-initialized by WebGPU. Every occupied
// key owns a global record operation in this dispatch. Collisions only replace
// keys and cause extra records; they can never suppress a different page/kind.
// No barrier: callers may be divergent or return early from Surface.
var<workgroup> native_vt_mailbox: array<atomic<u32>, ${VT_FEEDBACK_MAILBOX_WORDS}>;
fn native_vt_record(page: u32, kind: u32) {
  // Reject out-of-domain IDs before forming a nonzero, nonwrapping key.
  if page >= ${VT_PAGE_CAPACITY}u { return; }
  let key = page * 2u + select(1u, 2u, kind == 2u);
  let bucket = (page ^ (page >> 8u) ^ (page >> 16u)) & 127u;
  let cell = bucket * 2u + select(0u, 1u, kind == 2u);
  if atomicExchange(&native_vt_mailbox[cell], key) == key { return; }
  if atomicLoad(&native_vt_feedback[0u]) == 0u || page >= atomicLoad(&native_vt_feedback[1u]) { return; }
  let word = page >> 5u;
  let mask = 1u << (page & 31u);
  let bits = atomicLoad(&native_vt_feedback[select(6u, 7u, kind == 2u)]);
  // Bits only grow until all Surface readers complete. A repeated texel can
  // skip the contended RMW; racing first writers still merge without loss.
  if (atomicLoad(&native_vt_feedback[bits + word]) & mask) != 0u { return; }
  if (atomicOr(&native_vt_feedback[bits + word], mask) & mask) != 0u { return; }
  let union_offset = atomicLoad(&native_vt_feedback[8u]);
  if (atomicOr(&native_vt_feedback[union_offset + word], mask) & mask) != 0u { return; }
  let at = atomicAdd(&native_vt_feedback[4u], 1u);
  if at < atomicLoad(&native_vt_feedback[3u]) {
    atomicStore(&native_vt_feedback[atomicLoad(&native_vt_feedback[9u]) + at], page);
  } else {
    atomicStore(&native_vt_feedback[5u], 1u);
  }
}
`;

/** First dispatch writes actual append count to indirect args; the second
 * decorates only actual queue entries with wanted/used transport bits. */
export const VIRTUAL_TEXTURE_FINALIZE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> data: array<atomic<u32>>;
@compute @workgroup_size(1)
fn prepare() {
  let count = min(atomicLoad(&data[4u]), atomicLoad(&data[3u]));
  atomicStore(&data[12u], (count + 63u) / 64u);
  atomicStore(&data[13u], 1u);
  atomicStore(&data[14u], 1u);
}
@compute @workgroup_size(64)
fn finalize(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= min(atomicLoad(&data[4u]), atomicLoad(&data[3u])) { return; }
  let index = atomicLoad(&data[9u]) + id.x;
  let page = atomicLoad(&data[index]);
  let word = page >> 5u;
  let mask = 1u << (page & 31u);
  let wanted = (atomicLoad(&data[atomicLoad(&data[6u]) + word]) & mask) != 0u;
  let used = (atomicLoad(&data[atomicLoad(&data[7u]) + word]) & mask) != 0u;
  atomicStore(&data[index], page | select(0u, 0x40000000u, wanted) | select(0u, 0x80000000u, used));
}
`;
