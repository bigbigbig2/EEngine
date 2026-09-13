import {
  GPU_SHADING_BIN_CLASSIFIER_WORKGROUP_HEIGHT,
  GPU_SHADING_BIN_CLASSIFIER_WORKGROUP_WIDTH,
  GPU_SHADING_BIN_COUNT,
  GPU_SHADING_BIN_INVALID_ID,
  GPU_SHADING_BIN_MACRO_HEIGHT,
  GPU_SHADING_BIN_MACRO_WIDTH,
  GPU_SHADING_BIN_WGSL
} from "../gpu/GpuShadingBinAbi.js";

export const GPU_SHADING_BIN_DIAGNOSTIC_FAULT = Object.freeze({
  InvalidBin: 1 << 0,
  InactiveBin: 1 << 1,
  LayoutRevisionMismatch: 1 << 2,
  CounterInvariant: 1 << 3,
  ReservationOverflow: 1 << 4,
  DispatchOverflow: 1 << 5
} as const);

export function shadingBinClassifierWgsl(diagnostics: boolean): string {
  const faultDeclaration = diagnostics ? /* wgsl */ `
struct OEngineShadingBinDiagnosticFaults {
  flags: u32,
  target_bin: u32,
  capacity_override: u32,
  reserved0: u32,
};
@group(0) @binding(4) var<uniform> shading_bin_faults: OEngineShadingBinDiagnosticFaults;
` : "";
  const classifierCapacity = diagnostics
    ? `select(bin_layout.capacity, shading_bin_faults.capacity_override,
        (shading_bin_faults.flags & ${GPU_SHADING_BIN_DIAGNOSTIC_FAULT.ReservationOverflow}u) != 0u &&
        shading_bin_faults.target_bin == bin_id)`
    : "bin_layout.capacity";
  const finalizerRevision = diagnostics
    ? `select(bin_layout.revision, bin_layout.revision ^ 1u,
        (shading_bin_faults.flags & ${GPU_SHADING_BIN_DIAGNOSTIC_FAULT.LayoutRevisionMismatch}u) != 0u &&
        shading_bin_faults.target_bin == bin_id)`
    : "bin_layout.revision";
  const forcedCounterInvariant = diagnostics
    ? `((shading_bin_faults.flags & ${GPU_SHADING_BIN_DIAGNOSTIC_FAULT.CounterInvariant}u) != 0u &&
      shading_bin_faults.target_bin == bin_id)`
    : "false";
  const forcedFinalizerErrors = diagnostics ? /* wgsl */ `
  if shading_bin_faults.target_bin == bin_id &&
      (shading_bin_faults.flags & ${GPU_SHADING_BIN_DIAGNOSTIC_FAULT.InvalidBin}u) != 0u {
    shading_bin_report_finalizer_error(OENGINE_SHADING_BIN_FRAME_INVALID_BIN);
  }
  if shading_bin_faults.target_bin == bin_id &&
      (shading_bin_faults.flags & ${GPU_SHADING_BIN_DIAGNOSTIC_FAULT.InactiveBin}u) != 0u {
    shading_bin_report_finalizer_error(OENGINE_SHADING_BIN_FRAME_INACTIVE_BIN);
  }` : "";
  const finalizerMaxDispatch = diagnostics
    ? `select(shading_bin_settings.max_dispatch_dimension, 1u,
        (shading_bin_faults.flags & ${GPU_SHADING_BIN_DIAGNOSTIC_FAULT.DispatchOverflow}u) != 0u &&
        shading_bin_faults.target_bin == bin_id)`
    : "shading_bin_settings.max_dispatch_dimension";

  return /* wgsl */ `enable subgroups;
requires texture_formats_tier1;
${GPU_SHADING_BIN_WGSL}
${faultDeclaration}
@group(0) @binding(0) var shading_bin_image: texture_2d<u32>;
@group(0) @binding(1) var<storage, read_write> shading_bin_heap: OEngineShadingBinHeap;
@group(0) @binding(2) var<uniform> shading_bin_settings: OEngineShadingBinSettings;
@group(0) @binding(3) var<storage, read_write>
  shading_bin_indirect: array<OEngineShadingBinIndirectArgs, ${GPU_SHADING_BIN_COUNT}>;

var<workgroup> bin_microtiles: array<atomic<u32>, ${GPU_SHADING_BIN_COUNT * 2}>;
var<workgroup> bin_record_bases: array<u32, ${GPU_SHADING_BIN_COUNT}>;
var<workgroup> finalizer_flags: atomic<u32>;
var<workgroup> finalizer_generated: array<atomic<u32>, 2>;

fn shading_bin_allowed(bin_id: u32) -> bool {
  if bin_id < 32u {
    return (shading_bin_settings.allowed_mask_lo & (1u << bin_id)) != 0u;
  }
  return (shading_bin_settings.allowed_mask_hi & (1u << (bin_id - 32u))) != 0u;
}

fn shading_bin_report_classifier_error(flag: u32, count: u32) {
  atomicOr(&shading_bin_heap.control.frame_flags, flag);
  atomicAdd(&shading_bin_heap.control.error_count, count);
}

fn shading_bin_prefix_count(lo: u32, hi: u32, bit_index: u32) -> u32 {
  if bit_index < 32u {
    let below = select(0u, (1u << bit_index) - 1u, bit_index != 0u);
    return countOneBits(lo & below);
  }
  let high_bit = bit_index - 32u;
  let below = select(0u, (1u << high_bit) - 1u, high_bit != 0u);
  return countOneBits(lo) + countOneBits(hi & below);
}

fn shading_bin_aggregate_word(local_bins: u32, tile_bits: vec2u, high_word: bool) {
  let subgroup_bins = subgroupOr(local_bins);
  let elected = subgroupElect();
  var remaining = subgroup_bins;
  // A fixed trip count keeps every subgroup collective in uniform control flow.
  // Once the sparse mask is exhausted, remaining iterations contribute zero.
  for (var iteration = 0u; iteration < 32u; iteration++) {
    let has_remaining = remaining != 0u;
    let word_bit = select(0u, firstTrailingBit(remaining), has_remaining);
    let lane_has_bin = has_remaining && (local_bins & (1u << word_bit)) != 0u;
    let lane_tiles = select(vec2u(0u), tile_bits, lane_has_bin);
    let subgroup_tiles = subgroupOr(lane_tiles);
    if elected && has_remaining {
      let bin_id = word_bit + select(0u, 32u, high_word);
      atomicOr(&bin_microtiles[bin_id * 2u], subgroup_tiles.x);
      atomicOr(&bin_microtiles[bin_id * 2u + 1u], subgroup_tiles.y);
    }
    remaining &= remaining - select(0u, 1u, has_remaining);
  }
}

@compute @workgroup_size(${GPU_SHADING_BIN_CLASSIFIER_WORKGROUP_WIDTH}, ${GPU_SHADING_BIN_CLASSIFIER_WORKGROUP_HEIGHT}, 1)
fn classify_shading_bins(
  @builtin(local_invocation_id) local_id: vec3u,
  @builtin(local_invocation_index) lane: u32,
  @builtin(workgroup_id) macro_id: vec3u
) {
  if lane < 128u { atomicStore(&bin_microtiles[lane], 0u); }
  if lane < ${GPU_SHADING_BIN_COUNT}u { bin_record_bases[lane] = 0xffffffffu; }
  workgroupBarrier();

  let block_origin = macro_id.xy * vec2u(${GPU_SHADING_BIN_MACRO_WIDTH}u, ${GPU_SHADING_BIN_MACRO_HEIGHT}u) +
    local_id.xy * vec2u(4u, 4u);
  let microtile_in_macro = local_id.xy / vec2u(2u, 2u);
  let microtile_bit_index = microtile_in_macro.y * 8u + microtile_in_macro.x;
  var tile_bits = vec2u(0u);
  if microtile_bit_index < 32u {
    tile_bits.x = 1u << microtile_bit_index;
  } else {
    tile_bits.y = 1u << (microtile_bit_index - 32u);
  }
  var local_bin_mask = vec2u(0u);
  var local_invalid_count = 0u;
  for (var block_y = 0u; block_y < 4u; block_y++) {
    for (var block_x = 0u; block_x < 4u; block_x++) {
      let pixel = block_origin + vec2u(block_x, block_y);
      if pixel.x < shading_bin_settings.width && pixel.y < shading_bin_settings.height {
        let bin_id = textureLoad(shading_bin_image, vec2i(pixel), 0).x;
        if bin_id < 32u {
          local_bin_mask.x |= 1u << bin_id;
        } else if bin_id < ${GPU_SHADING_BIN_COUNT}u {
          local_bin_mask.y |= 1u << (bin_id - 32u);
        } else if bin_id != ${GPU_SHADING_BIN_INVALID_ID}u {
          local_invalid_count += 1u;
        }
      }
    }
  }

  let subgroup_invalid_count = subgroupAdd(local_invalid_count);
  if subgroupElect() && subgroup_invalid_count != 0u {
    shading_bin_report_classifier_error(
      OENGINE_SHADING_BIN_FRAME_INVALID_BIN,
      subgroup_invalid_count
    );
  }
  shading_bin_aggregate_word(local_bin_mask.x, tile_bits, false);
  shading_bin_aggregate_word(local_bin_mask.y, tile_bits, true);
  workgroupBarrier();

  if lane < ${GPU_SHADING_BIN_COUNT}u {
    let bin_id = lane;
    let lo = atomicLoad(&bin_microtiles[bin_id * 2u]);
    let hi = atomicLoad(&bin_microtiles[bin_id * 2u + 1u]);
    let local_count = countOneBits(lo) + countOneBits(hi);
    if local_count != 0u {
      let bin_layout = shading_bin_heap.layouts[bin_id];
      let bin_active = (bin_layout.flags & OENGINE_SHADING_BIN_LAYOUT_ACTIVE) != 0u;
      let allowed = shading_bin_allowed(bin_id);
      let revision_matches = bin_layout.revision == shading_bin_settings.layout_revision;
      if !allowed || !bin_active {
        shading_bin_report_classifier_error(OENGINE_SHADING_BIN_FRAME_INACTIVE_BIN, 1u);
      } else if !revision_matches {
        shading_bin_report_classifier_error(
          OENGINE_SHADING_BIN_FRAME_LAYOUT_REVISION_MISMATCH,
          1u
        );
      } else {
        let capacity = ${classifierCapacity};
        atomicAdd(&shading_bin_heap.counters[bin_id].attempted_count, local_count);
        var old_written = atomicLoad(&shading_bin_heap.counters[bin_id].written_count);
        var reserved = false;
        loop {
          if old_written > capacity { break; }
          if local_count > capacity - old_written { break; }
          let exchanged = atomicCompareExchangeWeak(
            &shading_bin_heap.counters[bin_id].written_count,
            old_written,
            old_written + local_count
          );
          if exchanged.exchanged {
            bin_record_bases[bin_id] = old_written;
            reserved = true;
            break;
          }
          old_written = exchanged.old_value;
        }
        if !reserved {
          atomicAdd(&shading_bin_heap.counters[bin_id].overflow_count, local_count);
          atomicOr(
            &shading_bin_heap.counters[bin_id].flags,
            OENGINE_SHADING_BIN_FRAME_RESERVATION_OVERFLOW
          );
          shading_bin_report_classifier_error(
            OENGINE_SHADING_BIN_FRAME_RESERVATION_OVERFLOW,
            1u
          );
        }
      }
    }
  }
  workgroupBarrier();

  for (var item = lane; item < ${GPU_SHADING_BIN_COUNT * 64}u; item += 256u) {
    let bin_id = item / 64u;
    let microtile = item % 64u;
    let lo = atomicLoad(&bin_microtiles[bin_id * 2u]);
    let hi = atomicLoad(&bin_microtiles[bin_id * 2u + 1u]);
    var present = false;
    if microtile < 32u {
      present = (lo & (1u << microtile)) != 0u;
    } else {
      present = (hi & (1u << (microtile - 32u))) != 0u;
    }
    let reservation_base = bin_record_bases[bin_id];
    if present && reservation_base != 0xffffffffu {
      let rank = shading_bin_prefix_count(lo, hi, microtile);
      let macro_microtile = vec2u(microtile % 8u, microtile / 8u);
      let global_microtile = macro_id.xy * vec2u(8u, 8u) + macro_microtile;
      let global_microtile_id =
        global_microtile.y * shading_bin_settings.microtiles_x + global_microtile.x;
      let bin_layout = shading_bin_heap.layouts[bin_id];
      shading_bin_heap.records[bin_layout.record_base + reservation_base + rank] =
        global_microtile_id;
    }
  }
}

fn shading_bin_report_finalizer_error(flag: u32) {
  atomicOr(&finalizer_flags, flag);
  atomicAdd(&shading_bin_heap.control.error_count, 1u);
}

@compute @workgroup_size(${GPU_SHADING_BIN_COUNT}, 1, 1)
fn finalize_shading_bins(@builtin(local_invocation_index) bin_id: u32) {
  if bin_id == 0u {
    atomicStore(&finalizer_flags, atomicLoad(&shading_bin_heap.control.frame_flags));
    atomicStore(&finalizer_generated[0], 0u);
    atomicStore(&finalizer_generated[1], 0u);
  }
  workgroupBarrier();

  let bin_layout = shading_bin_heap.layouts[bin_id];
  let attempted = atomicLoad(&shading_bin_heap.counters[bin_id].attempted_count);
  let written = atomicLoad(&shading_bin_heap.counters[bin_id].written_count);
  let overflow = atomicLoad(&shading_bin_heap.counters[bin_id].overflow_count);
  let counter_flags = atomicLoad(&shading_bin_heap.counters[bin_id].flags);
  let observed_revision = ${finalizerRevision};
${forcedFinalizerErrors}
  if observed_revision != shading_bin_settings.layout_revision {
    shading_bin_report_finalizer_error(OENGINE_SHADING_BIN_FRAME_LAYOUT_REVISION_MISMATCH);
  }
  var counter_invalid = attempted < written;
  if !counter_invalid {
    counter_invalid = attempted - written != overflow;
  }
  counter_invalid = counter_invalid || written > bin_layout.capacity || ${forcedCounterInvariant};
  if counter_invalid {
    shading_bin_report_finalizer_error(OENGINE_SHADING_BIN_FRAME_COUNTER_INVARIANT_FAILURE);
  }
  if overflow != 0u ||
      (counter_flags & OENGINE_SHADING_BIN_FRAME_RESERVATION_OVERFLOW) != 0u {
    atomicOr(&finalizer_flags, OENGINE_SHADING_BIN_FRAME_RESERVATION_OVERFLOW);
  }
  atomicOr(&finalizer_flags, counter_flags);
  if written != 0u {
    if (bin_layout.flags & OENGINE_SHADING_BIN_LAYOUT_ACTIVE) == 0u || !shading_bin_allowed(bin_id) {
      shading_bin_report_finalizer_error(OENGINE_SHADING_BIN_FRAME_INACTIVE_BIN);
    }
    if bin_id < 32u {
      atomicOr(&finalizer_generated[0], 1u << bin_id);
    } else {
      atomicOr(&finalizer_generated[1], 1u << (bin_id - 32u));
    }
  }
  let max_dispatch_dimension = ${finalizerMaxDispatch};
  if written != 0u {
    let x = min(written, max_dispatch_dimension);
    let y = (written - 1u) / x + 1u;
    if y > max_dispatch_dimension {
      shading_bin_report_finalizer_error(OENGINE_SHADING_BIN_FRAME_COUNTER_INVARIANT_FAILURE);
    }
  }
  workgroupBarrier();

  if bin_id == 0u {
    let generated_lo = atomicLoad(&finalizer_generated[0]);
    let generated_hi = atomicLoad(&finalizer_generated[1]);
    if (generated_lo & ~shading_bin_settings.allowed_mask_lo) != 0u ||
        (generated_hi & ~shading_bin_settings.allowed_mask_hi) != 0u {
      shading_bin_report_finalizer_error(OENGINE_SHADING_BIN_FRAME_INACTIVE_BIN);
    }
    shading_bin_heap.control.generated_mask_lo = generated_lo;
    shading_bin_heap.control.generated_mask_hi = generated_hi;
    shading_bin_heap.control.finalized_generation = shading_bin_settings.generation;
    shading_bin_heap.control.layout_revision = shading_bin_settings.layout_revision;
  }
  workgroupBarrier();

  let frame_flags = atomicLoad(&finalizer_flags);
  if frame_flags != 0u {
    shading_bin_indirect[bin_id] = OEngineShadingBinIndirectArgs(0u, 1u, 1u);
  } else if written == 0u {
    shading_bin_indirect[bin_id] = OEngineShadingBinIndirectArgs(0u, 1u, 1u);
  } else {
    let max_dispatch_dimension = ${finalizerMaxDispatch};
    let x = min(written, max_dispatch_dimension);
    let y = (written - 1u) / x + 1u;
    shading_bin_indirect[bin_id] = OEngineShadingBinIndirectArgs(x, y, 1u);
  }
  workgroupBarrier();
  if bin_id == 0u {
    atomicStore(&shading_bin_heap.control.frame_flags, atomicLoad(&finalizer_flags));
  }
}
`;
}

export const SHADING_BIN_CLASSIFIER_WGSL = shadingBinClassifierWgsl(false);
export const SHADING_BIN_CLASSIFIER_DIAGNOSTICS_WGSL = shadingBinClassifierWgsl(true);
