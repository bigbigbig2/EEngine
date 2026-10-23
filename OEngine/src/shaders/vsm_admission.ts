import { VSM_MAX_CLIP_LEVELS } from "../gpu/GpuVsmProjectionAbi.js";
import { VSM_PAGE_TABLE_WGSL } from "./vsm_page_table.js";
import { VSM_ADMISSION_ABI } from "../gpu/GpuVsmAdmissionAbi.js";

/** Local screen-benefit admission, not a donor allocator port. Raw demand is
 * immutable. Log2 score tiers bound ranking cost; page-key order breaks ties. */
export const VSM_ADMISSION_WGSL = /* wgsl */ `
${VSM_PAGE_TABLE_WGSL}
struct Constants {
  control: vec4u,
  dimensions: vec4u,
  identity: vec4u,
  clips: array<vec4f, ${VSM_MAX_CLIP_LEVELS}>,
};
@group(0) @binding(0) var<uniform> constants: Constants;
@group(0) @binding(1) var<storage, read> raw: array<u32>;
@group(0) @binding(2) var<storage, read> scores: array<u32>;
@group(0) @binding(3) var<storage, read_write> admitted: array<u32>;
// Histogram[32], cutoff tier, cutoff capacity, raw fine count, admitted count.
@group(0) @binding(4) var<storage, read_write> statistics: array<atomic<u32>>;
var<workgroup> prefix: array<u32, 64>;
var<workgroup> local_histogram: array<atomic<u32>, 32>;

fn score_tier(page: u32) -> u32 {
  return firstLeadingBit(max(1u, scores[page]));
}
fn coarse_page(page: u32) -> bool {
  return vsm_page_entry_coordinates(page, constants.dimensions.x).y == 5u;
}

@compute @workgroup_size(64)
fn histogram(@builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_index) lane: u32) {
  var bits = 0u;
  if (id.x < arrayLength(&raw)) {
    bits = raw[id.x];
  }
  while (bits != 0u) {
    let bit = firstTrailingBit(bits);
    bits &= bits - 1u;
    let page = id.x * 32u + bit;
    if (page < constants.dimensions.z && !coarse_page(page)) {
      atomicAdd(&local_histogram[score_tier(page)], 1u);
    }
  }
  workgroupBarrier();
  if (lane < 32u) {
    let count = atomicLoad(&local_histogram[lane]);
    if (count != 0u) {
      atomicAdd(&statistics[lane], count);
    }
  }
}

@compute @workgroup_size(1)
fn cutoff() {
  var remaining = constants.control.z - constants.identity.z;
  var total = 0u;
  var tier = 0u;
  var allowance = 0u;
  var found = false;
  for (var i = 32u; i > 0u; i--) {
    let count = atomicLoad(&statistics[i - 1u]);
    total += count;
    if (!found) {
      if (count >= remaining) {
        tier = i - 1u;
        allowance = remaining;
        found = true;
      } else {
        remaining -= count;
      }
    }
  }
  if (!found) {
    allowance = atomicLoad(&statistics[0]);
  }
  atomicStore(&statistics[${VSM_ADMISSION_ABI.cutoffTierWord}], tier);
  atomicStore(&statistics[${VSM_ADMISSION_ABI.cutoffAllowanceWord}], allowance);
  atomicStore(&statistics[${VSM_ADMISSION_ABI.rawFineCountWord}], total);
  atomicStore(&statistics[${VSM_ADMISSION_ABI.admittedFineCountWord}], min(total, constants.control.z - constants.identity.z));
}

@compute @workgroup_size(64)
fn admit(@builtin(local_invocation_index) lane: u32) {
  let words = arrayLength(&raw);
  let span = (words + 63u) / 64u;
  let begin = lane * span;
  let end = min(begin + span, words);
  let tier = atomicLoad(&statistics[${VSM_ADMISSION_ABI.cutoffTierWord}]);
  let allowance = atomicLoad(&statistics[${VSM_ADMISSION_ABI.cutoffAllowanceWord}]);
  var ties = 0u;
  for (var word = begin; word < end; word++) {
    var bits = raw[word];
    while (bits != 0u) {
      let bit = firstTrailingBit(bits);
      bits &= bits - 1u;
      let page = word * 32u + bit;
      if (page < constants.dimensions.z && !coarse_page(page) && score_tier(page) == tier) {
        ties++;
      }
    }
  }
  prefix[lane] = ties;
  workgroupBarrier();
  for (var stride = 1u; stride < 64u; stride *= 2u) {
    var prior = 0u;
    if (lane >= stride) {
      prior = prefix[lane - stride];
    }
    workgroupBarrier();
    prefix[lane] += prior;
    workgroupBarrier();
  }
  var rank = prefix[lane] - ties;
  for (var word = begin; word < end; word++) {
    var bits = raw[word];
    var selected = 0u;
    while (bits != 0u) {
      let bit = firstTrailingBit(bits);
      bits &= bits - 1u;
      let page = word * 32u + bit;
      if (page >= constants.dimensions.z) {
        continue;
      }
      if (coarse_page(page)) {
        selected |= 1u << bit;
      } else {
        let priority = score_tier(page);
        if (priority > tier || (priority == tier && rank < allowance)) {
          selected |= 1u << bit;
        }
        if (priority == tier) {
          rank++;
        }
      }
    }
    admitted[word] = selected;
  }
}
`;
