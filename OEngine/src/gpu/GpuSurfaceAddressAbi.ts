/** Stable logical identity for a surface sample. Physical work slots and screen
 * pixels are deliberately excluded; representation/LOD/seam changes advance
 * the source generation and therefore invalidate the address. */
export const GPU_SURFACE_ADDRESS_WGSL = /* wgsl */ `
struct OEngineSurfaceAddress { domain: u32, primitive: u32, material: u32, generation: u32, seam: u32, lod: u32 }
fn oengine_surface_address(instance: OEngineInstanceRecord, work: OEngineMeshletRasterWork,
  local_primitive: u32, seam: u32) -> OEngineSurfaceAddress {
  return OEngineSurfaceAddress(instance.geometry_record_index, (work.meshlet_slot << 7u) | local_primitive,
    work.material_slot_or_range, oengine_instance_geometry_generation(instance), seam,
    (work.packed_profile_lod >> 8u) & 0xffu);
}
fn oengine_surface_address_hash(address: OEngineSurfaceAddress, sample: vec4u) -> u32 {
  var h = 2166136261u;
  h = (h ^ address.domain) * 16777619u; h = (h ^ address.primitive) * 16777619u;
  h = (h ^ address.material) * 16777619u; h = (h ^ address.generation) * 16777619u;
  h = (h ^ address.seam) * 16777619u; h = (h ^ address.lod) * 16777619u;
  h = (h ^ sample.x) * 16777619u; h = (h ^ sample.y) * 16777619u;
  h = (h ^ sample.z) * 16777619u; return (h ^ sample.w) * 16777619u;
}
`;

export interface SurfaceAddressCpu {
  readonly domain: number; readonly primitive: number; readonly material: number;
  readonly generation: number; readonly seam: number; readonly lod: number;
}
export function surfaceAddressKey(value: SurfaceAddressCpu): string {
  for (const n of Object.values(value)) if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError("Surface address field is not u32");
  return `${value.domain}:${value.primitive}:${value.material}:${value.generation}:${value.seam}:${value.lod}`;
}
