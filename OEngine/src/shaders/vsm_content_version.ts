/** Local publication glue: version changes only after actual table/depth work
 * or a new VSM generation. A version never wraps; exhaustion disables persistent
 * direct signal admission. The owner namespace survives extent changes. */
export const VSM_CONTENT_VERSION_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> content_generation:vec4u;
@group(0) @binding(1) var<storage,read_write> content_publication:array<atomic<u32>>;
@compute @workgroup_size(1)
fn publish_vsm_content_version() {
  let dirty=atomicLoad(&content_publication[1u]);
  let previous_generation=atomicLoad(&content_publication[2u]);
  if dirty!=0u || previous_generation!=content_generation.x {
    let version=atomicLoad(&content_publication[0u]);
    atomicStore(&content_publication[0u],select(version+1u,0xffffffffu,version>=0xfffffffeu));
    atomicStore(&content_publication[2u],content_generation.x);
  }
  atomicStore(&content_publication[1u],0u);
}
`;
