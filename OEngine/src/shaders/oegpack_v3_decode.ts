import {
  OEGPACK_V3_GROUP_HEADER_BYTES,
  OEGPACK_V3_HIERARCHY_STRIDE,
  OEGPACK_V3_MESHLET_HEADER_BYTES
} from "../assets/GeometryAbiV3.js";

/**
 * OEGPACK V3.0 raw-storage decode probe shared by runtime validation.
 * Workgroup: 1x1x1. Access: read-only ABI words and one invocation-owned output.
 * Atomics: none. Capability: WebGPU core.
 */
export const OEGPACK_V3_DECODE_WORKGROUP_SIZE = 1;

export const oegPackV3DecodeWgsl = /* wgsl */ `
const HIERARCHY_WORDS: u32 = ${OEGPACK_V3_HIERARCHY_STRIDE / 4}u;
const GROUP_HEADER_WORDS: u32 = ${OEGPACK_V3_GROUP_HEADER_BYTES / 4}u;
const MESHLET_HEADER_WORDS: u32 = ${OEGPACK_V3_MESHLET_HEADER_BYTES / 4}u;

struct DecodeOffsets {
  hierarchyWord: u32,
  groupWord: u32,
  meshletWord: u32,
  outputWord: u32,
}

@group(0) @binding(0) var<storage, read> abiWords: array<u32>;
@group(0) @binding(1) var<uniform> offsets: DecodeOffsets;
@group(0) @binding(2) var<storage, read_write> decoded: array<u32>;

@compute @workgroup_size(${OEGPACK_V3_DECODE_WORKGROUP_SIZE}, 1, 1)
fn decodeOegPackV3() {
  let h = offsets.hierarchyWord;
  let g = offsets.groupWord;
  let m = offsets.meshletWord;
  let o = offsets.outputWord;
  let groupCounts = abiWords[g + 11u];
  let meshletCounts = abiWords[m];

  decoded[o + 0u] = abiWords[h + 11u];
  decoded[o + 1u] = abiWords[h + 10u];
  decoded[o + 2u] = abiWords[h + 3u];
  decoded[o + 3u] = groupCounts & 0xffffu;
  decoded[o + 4u] = (groupCounts >> 16u) & 0xffu;
  decoded[o + 5u] = (groupCounts >> 24u) & 0xffu;
  decoded[o + 6u] = abiWords[g + 12u];
  decoded[o + 7u] = abiWords[g + 13u];
  decoded[o + 8u] = abiWords[g + 14u];
  decoded[o + 9u] = abiWords[g + 15u];
  decoded[o + 10u] = abiWords[g + 10u];
  decoded[o + 11u] = meshletCounts & 0xffffu;
  decoded[o + 12u] = meshletCounts >> 16u;
  decoded[o + 13u] = abiWords[m + 1u];
  decoded[o + 14u] = abiWords[m + 2u];
  decoded[o + 15u] = abiWords[m + 3u];
  decoded[o + 16u] = abiWords[m + 4u];
  decoded[o + 17u] = abiWords[m + 5u];
  decoded[o + 18u] = abiWords[m + 6u];
  decoded[o + 19u] = abiWords[m + 11u];

  // Keep the ABI constants live so compilation catches accidental non-word strides.
  if (HIERARCHY_WORDS + GROUP_HEADER_WORDS + MESHLET_HEADER_WORDS == 0u) {
    decoded[o] = 0u;
  }
}
`;
