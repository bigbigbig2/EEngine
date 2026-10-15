/** Immutable native publication: 16B header, unchanged 32B directory entries,
 * followed by f32 constants stored as their original u32 bits. */
export const NATIVE_PUBLICATION_HEADER_WORDS = 4;
export function nativePublicationAccessors(buffer: string): string {
  return /* wgsl */ `
fn native_material_count() -> u32 { return ${buffer}[1u]; }
fn native_material_entry(slot: u32) -> NativeMaterialDirectoryEntry {
  let at = ${buffer}[0u] + slot * 8u;
  return NativeMaterialDirectoryEntry(
    ${buffer}[at], ${buffer}[at + 1u], ${buffer}[at + 2u], ${buffer}[at + 3u],
    ${buffer}[at + 4u], ${buffer}[at + 5u], vec2u(${buffer}[at + 6u], ${buffer}[at + 7u]));
}
fn native_material_constant(base: u32, slot: u32) -> f32 {
  return bitcast<f32>(${buffer}[${buffer}[2u] + base + slot]);
}
`;
}
