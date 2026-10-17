/** Exact cross-frame tuple. Physical page addresses and frame VisibilityKey are
 * deliberately absent. Scene supplies set/local-slot lineage; geometry supplies
 * asset-local meshlet plus local primitive without packing/truncation. */
export const PRIMARY_SURFACE_IDENTITY_WGSL = /* wgsl */ `
fn primary_surface_identity(lineage: vec4u, instance: OEngineInstanceRecord,
  asset: u32, meshlet: u32, primitive: u32, material_revision: u32) -> array<u32, 16> {
  var result: array<u32, 16>;
  result[0] = lineage.x;
  result[1] = lineage.y;
  result[2] = lineage.z;
  result[3] = lineage.w;
  result[4] = select(0u, instance.product_table_slot, oengine_instance_virtual_geometry(instance));
  result[5] = select(0u, oengine_instance_geometry_generation(instance), oengine_instance_virtual_geometry(instance));
  result[6] = asset;
  result[7] = oengine_instance_geometry_generation(instance);
  result[8] = meshlet;
  result[9] = instance.material_handle;
  result[10] = material_revision;
  result[11] = instance.dynamic_revision;
  result[12] = primitive;
  return result;
}
`;
