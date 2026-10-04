import { SURFACE_CELL_ADDRESS_WORDS } from "../gpu/GpuSurfaceReferenceAbi.js";
import { SURFACE_FIELD_STORE_KEY_WORDS, SURFACE_FIELD_STORE_IDENTITY_WORDS } from "../gpu/GpuSurfaceFieldStoreAbi.js";

/** A request is a narrow (leaf,field) pair. Its complete witness is generated
 * from shared immutable address/publication products at lookup/dedup/admission.
 * Hash only chooses a set; every hit and duplicate compares the actual words. */
export const SURFACE_FIELD_REQUEST_WGSL = /* wgsl */ `
const FIELD_REQUEST_KEY_WORDS:u32=${SURFACE_FIELD_STORE_KEY_WORDS}u;
const FIELD_REQUEST_IDENTITY_WORDS:u32=${SURFACE_FIELD_STORE_IDENTITY_WORDS}u;
fn field_request_descriptor(leaf:u32,field:u32)->u32 {
  return field_request_settings.identities+(field_request_workspace.facts[leaf].z*15u+field)*8u;
}
fn field_request_uv(leaf:u32,field:u32)->u32 {
  let mask=field_request_metadata[field_request_descriptor(leaf,field)+6u];
  if (mask&1u)!=0u { return 0u; }
  if (mask&2u)!=0u { return 1u; }
  if (mask&4u)!=0u { return 2u; }
  return 0xffffffffu;
}
fn field_request_domain(leaf:u32,field:u32,word:u32)->u32 {
  let uv=field_request_uv(leaf,field);
  if uv==0xffffffffu { return 0u; }
  return field_request_workspace.addresses[leaf*${SURFACE_CELL_ADDRESS_WORDS}u+46u+uv*4u+word];
}
fn field_request_gradient(leaf:u32,field:u32,word:u32)->u32 {
  let uv=field_request_uv(leaf,field);
  if uv==0xffffffffu { return 0u; }
  return field_request_workspace.addresses[leaf*${SURFACE_CELL_ADDRESS_WORDS}u+58u+uv*8u+word];
}
fn field_request_cell(leaf:u32,field:u32,axis:u32)->u32 {
  let uv=field_request_uv(leaf,field);
  if uv==0xffffffffu { return 0u; }
  let value=bitcast<f32>(field_request_workspace.addresses[leaf*${SURFACE_CELL_ADDRESS_WORDS}u+16u+uv*6u+axis]);
  if value!=value || abs(value)>16777216.0 { return 0xffffffffu; }
  return bitcast<u32>(i32(floor(value*32.0)));
}
fn field_request_gradient_class(leaf:u32,field:u32,axis:u32)->u32 {
  let uv=field_request_uv(leaf,field);
  if uv==0xffffffffu { return 0u; }
  var maximum=0.0;
  for(var step=0u;step<2u;step++) {
    let component=step*2u+axis;
    maximum=max(maximum,max(abs(bitcast<f32>(field_request_gradient(leaf,field,component))),
      abs(bitcast<f32>(field_request_gradient(leaf,field,component+4u)))));
  }
  if maximum!=maximum || maximum>3.402823466e38 { return 0xffffffffu; }
  // IEEE exponent class, with a one-bit upward envelope for exact powers.
  return select(0u,((bitcast<u32>(maximum)>>23u)&255u)+1u,maximum>0.0);
}
fn field_request_word(leaf:u32,field:u32,word:u32)->u32 {
  let descriptor=field_request_descriptor(leaf,field);
  let flags=field_request_metadata[descriptor+3u];
  let at=leaf*${SURFACE_CELL_ADDRESS_WORDS}u;
  let uv=field_request_uv(leaf,field);
  if word>=FIELD_REQUEST_IDENTITY_WORDS {
    let component=word-FIELD_REQUEST_IDENTITY_WORDS;
    if component<18u {
      let channel_uv=component/6u;
      if (field_request_metadata[descriptor+6u]&(1u<<channel_uv))==0u { return 0u; }
      return field_request_workspace.addresses[at+16u+component];
    }
    if component<30u {
      if (flags&(1u<<12u))==0u { return 0u; }
      return field_request_workspace.addresses[at+16u+component];
    }
    if component<66u {
      let attribute_index=(component-30u)/12u;
      var needed=(flags&((1u<<15u)|(1u<<16u)|(1u<<18u)|(1u<<21u)))!=0u;
      if attribute_index==1u { needed=(flags&((1u<<13u)|(1u<<14u)|(1u<<19u)|(1u<<20u)|(1u<<22u)))!=0u; }
      if attribute_index==2u { needed=(flags&((1u<<14u)|(1u<<20u)))!=0u; }
      return select(0u,field_request_workspace.addresses[at+94u+component-30u],needed);
    }
    if component==66u && (flags&((1u<<13u)|(1u<<14u)|(1u<<19u)|(1u<<20u)|(1u<<22u)))!=0u {
      return field_request_workspace.addresses[at+131u];
    }
    return 0u;
  }
  switch word {
    case 0u:{return field_request_metadata[descriptor];}
    case 1u:{let version=field_request_metadata[descriptor+1u];if version==0xffffffffu{return 0u;}return field_request_versions[version*4u];}
    case 2u:{return field_request_metadata[descriptor+7u];}
    case 3u:{return field_request_workspace.addresses[at+4u];}
    case 4u:{return field_request_workspace.addresses[at];}
    case 5u:{return field_request_workspace.addresses[at+1u];}
    case 6u:{return field_request_workspace.addresses[at+2u];}
    case 7u:{return field_request_workspace.addresses[at+3u];}
    case 8u:{return field_request_workspace.addresses[at+5u];}
    case 9u:{return field_request_workspace.addresses[at+6u];}
    case 10u:{return field_request_workspace.addresses[at+7u];}
    case 11u:{if uv==0xffffffffu{return 0u;}return field_request_workspace.addresses[at+9u+uv];}
    case 12u:{return field_request_workspace.addresses[at+8u];}
    case 13u:{return field_request_metadata[descriptor+6u];}
    case 14u:{return field_request_cell(leaf,field,0u);}
    case 15u:{return field_request_cell(leaf,field,1u);}
    case 16u:{return field_request_gradient_class(leaf,field,0u);}
    case 17u:{return field_request_gradient_class(leaf,field,1u);}
    case 18u:{return field_request_workspace.addresses[at+12u];}
    case 19u:{return select(0u,field_request_settings.view_revision,(flags&2u)!=0u);}
    default:{return 0u;}
  }
}
fn field_request_hash(leaf:u32,field:u32)->u32 {
  var hash=2166136261u;
  for(var word=0u;word<FIELD_REQUEST_IDENTITY_WORDS;word++) { hash=(hash^field_request_word(leaf,field,word))*16777619u; }
  return hash;
}
fn field_request_cacheable(leaf:u32,field:u32)->bool {
  let descriptor=field_request_descriptor(leaf,field);
  let flags=field_request_metadata[descriptor+3u];
  let uv_mask=field_request_metadata[descriptor+6u];
  let at=leaf*${SURFACE_CELL_ADDRESS_WORDS}u;
  if (flags&8u)!=0u || field_request_word(leaf,field,2u)==0xffffffffu { return false; }
  if (field_request_workspace.addresses[at+93u]&7u)!=7u { return false; }
  if (field_request_workspace.addresses[at+15u]&uv_mask)!=uv_mask { return false; }
  return field_request_gradient_class(leaf,field,0u)!=0xffffffffu && field_request_gradient_class(leaf,field,1u)!=0xffffffffu;
}
`;
