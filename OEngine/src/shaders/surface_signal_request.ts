import { SURFACE_FIELD_IDENTITY_WORDS, SURFACE_FIELD_EXECUTION_PROFILE_WORD } from "../gpu/GpuSurfaceFieldIdentityAbi.js";
import { SURFACE_CELL_ADDRESS_WORDS, SURFACE_REFERENCE_WGSL } from "../gpu/GpuSurfaceReferenceAbi.js";
import { surfaceCellSelectionWgsl } from "../gpu/GpuSurfaceCellPlanAbi.js";
import { SURFACE_SIGNAL_STORE_KEY_WORDS } from "../gpu/GpuSurfaceSignalStoreAbi.js";
import { SURFACE_FIELD_EXECUTION_WORDS, SURFACE_SIGNAL_EXECUTION_WORDS } from "../gpu/GpuSurfaceExecutionProfileAbi.js";
import { SURFACE_DIRECT_RESIDUAL_FIELDS } from "../material/AppearanceExecutionProfile.js";

/** Exact selected-source witness. Each field contributes its immutable producer
 * and numeric version, or the immutable Store slot/generation chosen by its plan.
 * A transient field deliberately prevents persistent signal admission. Provider
 * revisions are kind-specific; compose-only E/albedo/AO never enter Denv. */
export const SURFACE_SIGNAL_REQUEST_WGSL = /* wgsl */ `
${SURFACE_REFERENCE_WGSL}
${surfaceCellSelectionWgsl("signal_request_workspace", "signal_request_metadata", "signal_request_settings.constants")}
const SIGNAL_REQUEST_KEY_WORDS:u32=${SURFACE_SIGNAL_STORE_KEY_WORDS}u;
fn signal_request_field_descriptor(leaf:u32,field:u32)->u32 {
  return signal_request_settings.identities+(signal_request_workspace.facts[leaf].z*15u+field)*${SURFACE_FIELD_IDENTITY_WORDS}u;
}
fn signal_request_uniform_value(leaf:u32,field:u32)->vec4f {
  let reference=reference_field(leaf,field);
  let at=signal_request_settings.constants+reference.index*64u+4u+field*4u;
  return bitcast<vec4f>(vec4u(signal_request_metadata[at],signal_request_metadata[at+1u],
    signal_request_metadata[at+2u],signal_request_metadata[at+3u]));
}
fn signal_request_fields(leaf:u32,kind:u32)->u32 {
  let field_profile=signal_request_metadata[signal_request_field_descriptor(leaf,0u)+${SURFACE_FIELD_EXECUTION_PROFILE_WORD}u];
  let signal_profile=field_profile+15u*${SURFACE_FIELD_EXECUTION_WORDS}u+kind*${SURFACE_SIGNAL_EXECUTION_WORDS}u;
  var mask=signal_request_metadata[signal_profile+1u];
  if kind == 0u {
    if signal_request_workspace.addresses[leaf * ${SURFACE_CELL_ADDRESS_WORDS}u + 18u] != 3u {
      mask = ${SURFACE_DIRECT_RESIDUAL_FIELDS}u;
    } else {
      let coat = reference_field(leaf, 10u);
      if (coat.kind == SURFACE_REFERENCE_PUBLICATION || coat.kind == SURFACE_REFERENCE_DEFAULT) &&
        signal_request_uniform_value(leaf, 10u).x <= 0.0 { mask &= ~((1u << 12u) | (1u << 14u)); }
    }
  }
  let metallic=reference_field(leaf,2u);
  if (kind==2u || kind==3u) && (metallic.kind==SURFACE_REFERENCE_PUBLICATION || metallic.kind==SURFACE_REFERENCE_DEFAULT) && signal_request_uniform_value(leaf,2u).x==0.0 {
    mask&=~1u;
  }
  return mask;
}
fn signal_request_enabled(leaf:u32)->u32 {
  if signal_request_workspace.facts[leaf].x==0xffffffffu || signal_request_workspace.facts[leaf].z==0xffffffffu { return 0u; }
  var lit=false;
  for(var ordinal=0u;ordinal<4u;ordinal++) {
    let field=array<u32,4>(2u,3u,6u,7u)[ordinal];
    lit=lit || signal_request_metadata[signal_request_field_descriptor(leaf,field)+1u]!=0xffffffffu;
  }
  if !lit { return 0u; }
  var mask=63u;
  let light_fact=signal_request_workspace.facts[leaf].w;
  if light_fact!=0xffffffffu && (light_fact&0x80000000u)!=0u { mask&=~21u; }
  let coat=reference_field(leaf,10u);
  if (coat.kind==SURFACE_REFERENCE_PUBLICATION || coat.kind==SURFACE_REFERENCE_DEFAULT) && signal_request_uniform_value(leaf,10u).x<=0.0 {
    mask&=~48u;
  }
  return mask;
}
fn signal_request_field_word(leaf:u32,field:u32,word:u32)->u32 {
  let source=reference_plan_leaf(leaf,field);
  let selected=select(source,leaf,source==0xffffffffu);
  let reference=reference_field(leaf,field);
  // Store publishes one immutable payload generation; its slot/generation pair
  // proves the entire producer/value witness. Publication IDs occupy the low
  // namespace and combine with their actual per-field numeric version.
  if reference.kind==SURFACE_REFERENCE_STORE {
    return select(0x80000000u|reference.index,reference.generation,word==1u);
  }
  if reference.kind==SURFACE_REFERENCE_TRANSIENT {
    return select(0x40000000u|reference.index,reference.generation,word==1u);
  }
  let descriptor=signal_request_field_descriptor(selected,field);
  switch word {
    case 0u:{return signal_request_metadata[descriptor];}
    case 1u:{let version=signal_request_metadata[descriptor+1u];if version==0xffffffffu{return 0u;}return signal_request_versions[version*4u];}
    default:{return 0u;}
  }
}
fn signal_request_word(leaf:u32,kind:u32,word:u32,fields:u32)->u32 {
  let address=leaf*${SURFACE_CELL_ADDRESS_WORDS}u;
  let direct=(kind&1u)==0u;
  if word>=40u && word<70u {
    let field=(word-40u)/2u;
    if (fields&(1u<<field))==0u { return 0u; }
    return signal_request_field_word(leaf,field,(word-40u)%2u);
  }
  if word>=17u && word<21u { return signal_request_workspace.signal_witnesses[leaf*12u+4u+word-17u]; }
  if word>=21u && word<25u { return signal_request_workspace.signal_witnesses[leaf*12u+8u+word-21u]; }
  if word>=25u && word<29u {
    return select(0u,signal_request_workspace.signal_witnesses[leaf*12u+word-25u],kind!=1u);
  }
  if word>=30u && word<38u {
    if !direct || signal_request_settings.sun_enabled==0u { return 0u; }
    return signal_request_sun[(word-30u)/4u][(word-30u)%4u];
  }
  switch word {
    case 0u:{return kind;}
    case 1u:{return select(signal_request_settings.environment_revision,0u,direct);}
    case 2u:{return select(0u,signal_request_settings.light_revision,direct);}
    case 3u:{return select(0u,signal_request_shadow[0u],direct && signal_request_settings.shadow_enabled!=0u);}
    case 4u:{return select(0u,signal_request_settings.sun_revision,direct && signal_request_settings.sun_enabled!=0u);}
    case 5u:{return select(signal_request_settings.view_revision,0u,kind==1u);}
    case 6u:{return signal_request_workspace.addresses[address+4u];}
    case 7u:{return signal_request_workspace.addresses[address];}
    case 8u:{return signal_request_workspace.addresses[address+1u];}
    case 9u:{return signal_request_workspace.addresses[address+2u];}
    case 10u:{return signal_request_workspace.addresses[address+3u];}
    case 11u:{return signal_request_workspace.addresses[address+5u];}
    case 12u:{return signal_request_workspace.addresses[address+6u];}
    case 13u:{return signal_request_workspace.addresses[address+7u];}
    case 14u:{return signal_request_workspace.addresses[address+8u];}
    case 15u:{return signal_request_workspace.addresses[address+12u];}
    case 16u:{return signal_request_workspace.addresses[address+20u]&1u;}
    case 29u:{return select(0u,signal_request_workspace.addresses[address+13u],direct);}
    case 38u:{return select(0u,signal_request_shadow[2u],direct && signal_request_settings.shadow_enabled!=0u);}
    case 39u:{return select(0u,signal_request_shadow[3u],direct && signal_request_settings.shadow_enabled!=0u);}
    case 70u:{return select(0u, signal_request_workspace.addresses[address + 18u], kind == 0u);}
    case 71u:{return fields;}
    default:{return 0u;}
  }
}
fn signal_request_hash(leaf:u32,kind:u32,fields:u32)->u32 {
  var hash=2166136261u;
  for(var word=0u;word<SIGNAL_REQUEST_KEY_WORDS;word++) { hash=(hash^signal_request_word(leaf,kind,word,fields))*16777619u; }
  return hash;
}
fn signal_request_cacheable(leaf:u32,fields:u32,kind:u32)->bool {
  if (signal_request_workspace.addresses[leaf*${SURFACE_CELL_ADDRESS_WORDS}u+19u]&(1u<<kind))==0u { return false; }
  if (kind&1u)==0u && signal_request_settings.shadow_enabled!=0u && signal_request_shadow[0u]==0xffffffffu { return false; }
  for(var field=0u;field<15u;field++) {
    if (fields&(1u<<field))==0u { continue; }
    let reference=reference_field(leaf,field);
    if reference.kind==SURFACE_REFERENCE_TRANSIENT || reference.kind==SURFACE_REFERENCE_INVALID { return false; }
  }
  return (signal_request_workspace.addresses[leaf*${SURFACE_CELL_ADDRESS_WORDS}u+16u]&1u)!=0u;
}
`;
