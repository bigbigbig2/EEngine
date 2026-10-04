import { SURFACE_REFERENCE_WGSL } from "../gpu/GpuSurfaceReferenceAbi.js";
import { surfaceCellSelectionWgsl } from "../gpu/GpuSurfaceCellPlanAbi.js";

/** Publication boundaries guarantee immutable generation and complete payload.
 * Hot consumers resolve a ref once and do not re-probe its key/state. */
export const SURFACE_FIELD_REFERENCE_VALUES_WGSL = /* wgsl */ `
${SURFACE_REFERENCE_WGSL}
${surfaceCellSelectionWgsl("surface_workspace")}
fn surface_field(leaf:u32,field:u32)->vec4f {
  let reference=reference_field(leaf,field);
  switch reference.kind {
    case SURFACE_REFERENCE_PUBLICATION, SURFACE_REFERENCE_DEFAULT: {
      let at=settings.constant_fields_offset+reference.index*64u+4u+field*4u;
      return bitcast<vec4f>(vec4u(appearance_metadata[at],appearance_metadata[at+1u],appearance_metadata[at+2u],appearance_metadata[at+3u]));
    }
    case SURFACE_REFERENCE_TRANSIENT: { return field_values[reference.index]; }
    case SURFACE_REFERENCE_STORE: {
      let at=reference.index*120u+88u;
      return bitcast<vec4f>(vec4u(field_store[at],field_store[at+1u],field_store[at+2u],field_store[at+3u]));
    }
    default: { return vec4f(0.0); }
  }
}
`;
export const SURFACE_SIGNAL_REFERENCE_VALUES_WGSL = /* wgsl */ `
fn surface_signal(leaf:u32,kind:u32)->vec4f {
  let source=reference_plan_leaf(leaf,15u+kind);
  if source==0xffffffffu { return vec4f(0.0); }
  let at=(source*6u+kind)*3u;
  let mode=surface_workspace.signal_references[at];
  let index=surface_workspace.signal_references[at+1u];
  if mode==SURFACE_REFERENCE_TRANSIENT { return signal_values[index]; }
  if mode==SURFACE_REFERENCE_STORE {
    let payload=index*88u+72u;
    // Production stores retain f32; independent packet spill metadata is never
    // interpreted as slot ownership or reference generation.
    return bitcast<vec4f>(vec4u(signal_store[payload],signal_store[payload+1u],signal_store[payload+2u],signal_store[payload+3u]));
  }
  return vec4f(0.0);
}
`;
