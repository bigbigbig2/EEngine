import {
  APPEARANCE_CLOSURE_READ as READ,
  APPEARANCE_CLOSURE_READ_WORDS,
  APPEARANCE_CLOSURE_KEY_PREFIX_WORDS,
} from "../material/AppearanceClosurePlan.js";
import { APPEARANCE_ROUTE_STRIDE } from "./appearance_resident_kernel.js";

/** Exact key words from the same metadata and Geometry input accessor used by
 * Appearance. No bindings or independent geometry recovery owner. The request
 * producer validates capacity once, then publishes every word before lookup. */
export const APPEARANCE_CLOSURE_KEY_WGSL = /* wgsl */ `
fn appearance_closure_key_word(namespace_id: u32, closure: u32, word: u32) -> u32 {
  if word == 0u {
    return namespace_id;
  }
  if word == 1u {
    return dag_code[closure];
  }
  let at = dag_code[closure + 6u] + (word - ${APPEARANCE_CLOSURE_KEY_PREFIX_WORDS}u) * ${APPEARANCE_CLOSURE_READ_WORDS}u;
  let kind = dag_code[at];
  let index = dag_code[at + 1u];
  let semantic = dag_code[at + 2u];
  let channel = dag_code[at + 3u];
  let point = dag_code[at + 4u];
  switch kind {
    case ${READ.constant}u: {
      return dag_metadata[settings.constants + dag_code[dag_entry + 5u] + index];
    }
    case ${READ.uniform}u: {
      let plan = dag_code[dag_entry + 2u];
      return dag_metadata[dag_code[plan + 4u] + index];
    }
    case ${READ.input}u: {
      if semantic == 0u {
        return dag_metadata[settings.inputs + (dag_code[dag_entry + 7u] + index) * 4u + channel];
      }
      return bitcast<u32>(geometry_input(semantic, point)[channel]);
    }
    case ${READ.route}u: {
      return dag_metadata[settings.routes + (dag_code[dag_entry + 6u] + index) * ${APPEARANCE_ROUTE_STRIDE / 4}u + channel];
    }
    case ${READ.routeIdentity}u: {
      // The publication owner compares the complete 16-word route before
      // issuing a non-recycled identity. No route dependency is discarded.
      return dag_metadata[index];
    }
    default: {
      // Compiler-owned records have no dynamic or unknown opcode.
      return 0u;
    }
  }
}
`;
