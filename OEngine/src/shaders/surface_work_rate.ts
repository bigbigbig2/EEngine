import { SURFACE_WORK_SETTINGS_WGSL } from "./surface_work.js";
import { surfaceWorkReadWgsl } from "../gpu/GpuSurfaceWorkAbi.js";
import { PACKED_CAMERA_TYPE } from "./packed_camera.js";

/** One tile owns all six rate recipes; intra-workgroup publication precedes
 * Lighting readers. The same complete admission is used by the standalone oracle. */
export const SURFACE_SIGNAL_RATE_ADMISSION_WGSL = /* wgsl */ `
var<workgroup> pixels: array<u32, 64>;
var<workgroup> keys: array<u32, 64>;
var<workgroup> normals: array<vec3u, 64>;
var<workgroup> coat_normals: array<vec3u, 64>;
var<workgroup> views: array<vec3u, 64>;
var<workgroup> coarse: array<u32, 16>;
fn equal_field(a: u32, b: u32, field: u32) -> bool {
  let first = surface_field(a, field);
  let second = surface_field(b, field);
  return all(first == second) && all(abs(first) <= vec4f(3.402823e38));
}
fn surface_prepare_rates(tile: u32, lane: u32) {
  let coordinate = vec2u((tile % settings.tiles_x) * 8u + lane % 8u,
    settings.bank * settings.bank_rows + (tile / settings.tiles_x) * 8u + lane / 8u);
  var key = 0xffffffffu;
  var normal = vec3f(0.0);
  var coat_normal = vec3f(0.0);
  var view_direction = vec3f(0.0);
  let pixel = (coordinate.y - settings.bank * settings.bank_rows) * settings.width + coordinate.x;
  if coordinate.x < settings.width && coordinate.y < settings.height {
    let entry = surface_work_entry(pixel);
    if entry != 0xffffffffu && dag_metadata[settings.palette + entry * 64u + 3u] != 0u {
      normal = surface_work_guide(pixel, false);
      coat_normal = surface_work_guide(pixel, true);
      let position = surface_work_vec4(pixel, 0u);
      let basis = surface_work_vec4(pixel, 4u).xyz;
      let delta = camera.transform[3u].xyz - position.xyz;
      let length2 = dot(delta, delta);
      view_direction = select(basis, delta * inverseSqrt(length2), length2 > 1e-20 && all(delta == delta));
      key = textureLoad(visibility, vec2i(coordinate), 0).x;
    }
  }
  pixels[lane] = pixel;
  keys[lane] = key;
  normals[lane] = bitcast<vec3u>(normal);
  coat_normals[lane] = bitcast<vec3u>(coat_normal);
  views[lane] = bitcast<vec3u>(view_direction);
  workgroupBarrier();
  if lane < 16u {
    let first = (lane / 4u) * 16u + (lane % 4u) * 2u;
    let offsets = array<u32, 4>(0u, 1u, 8u, 9u);
    let anchor = pixels[first];
    let value = bitcast<vec3f>(normals[first]);
    var valid = settings.reuse != 0u && keys[first] != 0xffffffffu &&
      all(value == value) && all(abs(value) <= vec3f(1.0001));
    for (var index = 1u; index < 4u; index++) {
      valid = valid && keys[first + offsets[index]] != 0xffffffffu;
    }
    var diffuse = valid;
    var specular = valid;
    var coat = valid;
    var direct = valid && dag_metadata[settings.domain_base + 4u] != 0u;
    // A publication-constant field of the same snapshot needs no pixel loads.
    // Other snapshots and varying fields compare their complete actual values.
    if valid {
      for (var index = 1u; index < 4u; index++) {
        let at = first + offsets[index];
        let other = pixels[at];
        let normal_equal = all(normals[first] == normals[at]);
        let view_equal = all(views[first] == views[at]);
        let coat_equal = all(coat_normals[first] == coat_normals[at]);
        diffuse = diffuse && normal_equal;
        specular = specular && normal_equal && view_equal;
        coat = coat && coat_equal && view_equal;
        direct = direct && normal_equal && view_equal && coat_equal &&
          all(surface_work_vec4(anchor, 8u).xyz == surface_work_vec4(other, 8u).xyz) &&
          work_heap[anchor * settings.source_payload.y + 7u] == work_heap[other * settings.source_payload.y + 7u];
        let entry = surface_work_entry(anchor);
        let same_snapshot = entry == surface_work_entry(other);
        let constant = dag_metadata[settings.palette + entry * 64u];
        for (var field = 0u; field < 12u; field++) {
          if field == 1u || field == 4u || field == 5u || field == 6u {
            continue;
          }
          var equal = same_snapshot && (constant & (1u << field)) != 0u;
          if !equal {
            equal = equal_field(anchor, other, field);
          }
          direct = direct && equal;
          if field == 10u || field == 11u {
            coat = coat && equal;
          } else {
            specular = specular && equal;
          }
        }
      }
    }
    coarse[lane] = (u32(diffuse) * 2u) | (u32(specular) * 8u) | (u32(coat) * 32u) |
      (u32(direct) * 21u);
  }
  workgroupBarrier();
  if lane == 0u {
    var masks = vec3u(0u);
    for (var quad = 0u; quad < 16u; quad++) {
      for (var kind = 0u; kind < 6u; kind++) {
        masks[kind / 2u] |= ((coarse[quad] >> kind) & 1u) << (quad + (kind & 1u) * 16u);
      }
    }
    var promoted = false;
    if any(masks != vec3u(0u)) {
      let reservation = atomicAdd(&work_control[208u + settings.bank], 1u);
      if reservation >= settings.overlay_capacity {
        masks = vec3u(0u);
        promoted = true;
      }
    }
    // Six independent 16-bit quad masks and one current version, published
    // before any signal writes. Optional exhaustion revokes the whole tile.
    let at = settings.recipe_base + (settings.bank * settings.bank_tiles + tile) * 4u;
    for (var word = 0u; word < 3u; word++) {
      atomicStore(&work_control[at + word], masks[word]);
    }
    atomicStore(&work_control[at + 3u], settings.frame);
    if settings.diagnostics != 0u {
      atomicAdd(&work_control[231u], countOneBits(masks.x >> 16u));
      atomicAdd(&work_control[232u], u32(promoted));
    }
  }
  storageBarrier();
  workgroupBarrier();
}
`;

/** Local Signal Footprint Admission: sufficient, exact dependency equality.
 * Every kind has its own recipe. Directional direct sharing additionally needs
 * the current provider publication to exclude position/cluster/shadow queries.
 * Unproved dependencies take the same complete indexed worker, without error. */
export const SURFACE_WORK_RATE_WGSL = /* wgsl */ `
${SURFACE_WORK_SETTINGS_WGSL}
${PACKED_CAMERA_TYPE.wgsl_declaration}
@group(0) @binding(0) var<uniform> settings: SurfaceWorkSettings;
@group(0) @binding(1) var<storage, read> work_heap: array<u32>;
@group(0) @binding(2) var<storage, read> dag_metadata: array<u32>;
@group(0) @binding(3) var<storage, read_write> work_control: array<atomic<u32>>;
@group(0) @binding(4) var visibility: texture_2d<u32>;
@group(0) @binding(5) var<uniform> camera: CommandEncoder;
${surfaceWorkReadWgsl(false)}
${SURFACE_SIGNAL_RATE_ADMISSION_WGSL}
@compute @workgroup_size(64)
fn rate(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let tile = atomicLoad(&work_control[settings.queue_base + (32u + settings.bank) * settings.bank_tiles + group.x]);
  surface_prepare_rates(tile, lane);
}
`;

export const SURFACE_WORK_SIGNAL_RECIPE_WGSL = /* wgsl */ `
fn surface_signal_owner_in_bank(pixel: u32, kind: u32, bank: u32) -> u32 {
  let coordinate = vec2u(pixel % settings.width, pixel / settings.width);
  let tile = (coordinate.y / 8u) * settings.tiles_x + coordinate.x / 8u;
  let quad = ((coordinate.y % 8u) / 2u) * 4u + (coordinate.x % 8u) / 2u;
  let at = settings.recipe_base + (bank * settings.bank_tiles + tile) * 4u;
  let mask = atomicLoad(&work_control[at + kind / 2u]);
  if (mask & (1u << (quad + (kind & 1u) * 16u))) == 0u {
    return pixel;
  }
  return (coordinate.y & ~1u) * settings.width + (coordinate.x & ~1u);
}
fn surface_signal_owner(pixel: u32, kind: u32) -> u32 {
  return surface_signal_owner_in_bank(pixel, kind, settings.bank);
}
`;
