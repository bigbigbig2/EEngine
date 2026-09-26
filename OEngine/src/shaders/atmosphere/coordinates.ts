/** Non-geospatial scenes place world origin on the Earth surface, with Y up. */
export const ATMOSPHERE_WORLD_COORDINATES_WGSL = /* wgsl */ `
fn atmosphere_world_to_planet(world: vec3f, world_to_unit: f32) -> vec3f {
  return world * world_to_unit + vec3f(0.0, 6360.0, 0.0);
}
`;
