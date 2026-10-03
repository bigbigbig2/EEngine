/** Exposure-independent linear Rec.709. Denv is diffuse irradiance (no
 * reflectance, occlusion, scalar AO, 1/pi or E). Ddirect is the production
 * BRDF's already-colored residual. Specular/coat packets are radiance.
 * Reconstruction applies the independent diffuse factors and E, then converts
 * the sum to working Rec.2020 and applies pre-exposure exactly once. Ownership
 * and generation belong to Store metadata, never these semantic flags. */
export const SURFACE_PACKET_KIND_COUNT = 6;
export const SURFACE_PACKET_FLAG_VALID = 1;
export const SURFACE_PACKET_FLAG_SPILL = 2;
export const SURFACE_PACKET_FLAG_RADIANCE = 4;
export const SURFACE_PACKET_FLAG_DIFFUSE = 8;
export const SURFACE_PACKET_FLAG_SPECULAR = 16;
export const SURFACE_PACKET_FLAG_COAT = 32;
export const SURFACE_PACKET_FLAG_ENVIRONMENT = 64;
export const SURFACE_PACKET_FLAG_IRRADIANCE = 128;

export const SURFACE_PACKET_CONTRACT_WGSL = /* wgsl */ `
const SURFACE_PACKET_VALID:u32=${SURFACE_PACKET_FLAG_VALID}u;
const SURFACE_PACKET_SPILL:u32=${SURFACE_PACKET_FLAG_SPILL}u;
const SURFACE_PACKET_RADIANCE:u32=${SURFACE_PACKET_FLAG_RADIANCE}u;
const SURFACE_PACKET_DIFFUSE:u32=${SURFACE_PACKET_FLAG_DIFFUSE}u;
const SURFACE_PACKET_SPECULAR:u32=${SURFACE_PACKET_FLAG_SPECULAR}u;
const SURFACE_PACKET_COAT:u32=${SURFACE_PACKET_FLAG_COAT}u;
const SURFACE_PACKET_ENVIRONMENT:u32=${SURFACE_PACKET_FLAG_ENVIRONMENT}u;
const SURFACE_PACKET_IRRADIANCE:u32=${SURFACE_PACKET_FLAG_IRRADIANCE}u;
`;
