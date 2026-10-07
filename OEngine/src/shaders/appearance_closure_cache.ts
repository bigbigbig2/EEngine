import {
  APPEARANCE_CACHE_HEADER as H,
  APPEARANCE_CACHE_KEY_WORDS as K,
  APPEARANCE_CACHE_REQUEST_WORDS as R,
  APPEARANCE_CACHE_CELL_WORDS as C,
  APPEARANCE_CACHE_PROBES as PROBES,
  APPEARANCE_CACHE_STORED_REF as STORED_REF,
} from "../gpu/GpuAppearanceClosureCacheAbi.js";

/** All request payloads are immutable before nomination. Atomic request indices
 * nominate owners; they never publish payload from within this dispatch. A weak
 * CAS spuriously observing EMPTY rejects locally, never probes another slot.
 * No spin, cross-workgroup wait, or hash-only identity comparison. */
export const APPEARANCE_CLOSURE_CACHE_ACCESS_WGSL = /* wgsl */ `
fn closure_cache_config(word: u32) -> u32 {
  return atomicLoad(&work_control[${H}u + word]);
}
fn closure_request_address(request: u32) -> u32 {
  return closure_cache_config(3u) + request * closure_cache_config(25u);
}
fn closure_cell_address(slot: u32) -> u32 {
  return closure_cache_config(5u) + slot * closure_cache_config(26u);
}
fn closure_key_equal(left: u32, right: u32, words: u32) -> bool {
  for (var word = 0u; word < words; word++) {
    if atomicLoad(&work_control[left + word]) != atomicLoad(&work_control[right + word]) {
      return false;
    }
  }
  return true;
}
fn closure_key_hash(key: u32, words: u32) -> u32 {
  var hash = 2166136261u;
  for (var word = 0u; word < words; word++) {
    hash = (hash ^ atomicLoad(&work_control[key + word])) * 16777619u;
  }
  return hash;
}
`;

export const APPEARANCE_CLOSURE_CACHE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> work_control: array<atomic<u32>>;
${APPEARANCE_CLOSURE_CACHE_ACCESS_WGSL}
fn closure_nominate(request: u32, bin: u32) {
  let at = closure_request_address(request);
  let words = atomicLoad(&work_control[at + 2u]);
  if words == 0u {
    return;
  }
  let key = at + 8u;
  let mask = closure_cache_config(1u) - 1u;
  let hash = closure_key_hash(key, words);
  // Persistent lookup preceded request allocation. Only true misses enter this
  // phase, with their entire keys already published by the address producer.
  for (var probe = 0u; probe < ${PROBES}u; probe++) {
    let slot = (hash + probe) & mask;
    let nomination = closure_cache_config(4u) + slot;
    var owner = atomicLoad(&work_control[nomination]);
    if owner == 0u {
      let cell = closure_cell_address(slot);
      // Every persistent hit was consumed by the preceding request dispatch.
      // All requests are true misses against that immutable snapshot. An old
      // cell can therefore be nominated for replacement now, but its payload
      // stays unchanged until publish runs after the last resolve reader.
      // Generations never wrap. Exhausted cells remain readable but cannot be
      // recycled until this resource namespace is retired/recreated.
      if atomicLoad(&work_control[cell + 2u]) == 0xffffffffu {
        continue;
      }
      let claim = atomicCompareExchangeWeak(&work_control[nomination], 0u, request + 1u);
      owner = claim.old_value;
      if claim.exchanged {
        atomicStore(&work_control[at + 3u], request + 1u);
        atomicStore(&work_control[at + 4u], slot);
        let index = atomicAdd(&work_control[closure_cache_config(6u) + bin * 2u + 1u], 1u);
        atomicStore(&work_control[closure_cache_config(7u) + bin * closure_cache_config(0u) + index], request);
        if closure_cache_config(11u) != 0u {
          atomicAdd(&work_control[${H + 13}u], 1u);
        }
        return;
      }
      if owner == 0u {
        break;
      }
    }
    let other = closure_request_address(owner - 1u);
    if atomicLoad(&work_control[other + 2u]) == words &&
       closure_key_equal(key, other + 8u, words) {
      atomicStore(&work_control[at + 3u], owner);
      return;
    }
  }
  // A rejected request keeps its published exact inputs for direct evaluation.
  atomicStore(&work_control[at + 3u], 0u);
  if closure_cache_config(11u) != 0u {
    atomicAdd(&work_control[${H + 14}u], 1u);
  }
}
@compute @workgroup_size(64)
fn nominate(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let per_bin = closure_cache_config(0u);
  let count = min(per_bin, atomicLoad(&work_control[closure_cache_config(6u) + group.x * 2u]));
  for (var index = lane; index < count; index += 64u) {
    closure_nominate(group.x * per_bin + index, group.x);
  }
}
@compute @workgroup_size(32)
fn arguments(@builtin(local_invocation_index) bin: u32) {
  let count = atomicLoad(&work_control[closure_cache_config(6u) + bin * 2u + 1u]);
  let at = closure_cache_config(8u) + bin * 4u;
  atomicStore(&work_control[at], (min(count, closure_cache_config(10u)) + 63u) / 64u);
  atomicStore(&work_control[at + 1u], 1u);
  atomicStore(&work_control[at + 2u], 1u);
}
@compute @workgroup_size(64)
fn publish(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let count = atomicLoad(&work_control[closure_cache_config(6u) + group.x * 2u + 1u]);
  let queue = closure_cache_config(7u) + group.x * closure_cache_config(0u);
  for (var index = lane; index < count; index += 64u) {
    let request = atomicLoad(&work_control[queue + index]);
    let at = closure_request_address(request);
    let cell = closure_cell_address(atomicLoad(&work_control[at + 4u]));
    let words = atomicLoad(&work_control[at + 2u]);
    for (var word = 0u; word < words; word++) {
      atomicStore(&work_control[cell + 4u + word], atomicLoad(&work_control[at + 8u + word]));
    }
    for (var word = 0u; word < 4u; word++) {
      atomicStore(&work_control[cell + (4u + closure_cache_config(24u)) + word], atomicLoad(&work_control[at + (8u + closure_cache_config(24u)) + word]));
    }
    atomicStore(&work_control[cell + 1u], words);
    atomicAdd(&work_control[cell + 2u], 1u);
    atomicStore(&work_control[cell], 1u);
  }
}
`;
