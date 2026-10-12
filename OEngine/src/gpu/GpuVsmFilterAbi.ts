/** VSM-owned immutable STBN bytes and a shared rotation table. No new binding,
 * pass, atomics or history. Disk4: 16 -> 4 depth loads + two coherent u32
 * rotation loads and one spatially coherent packed-noise load per receiver.
 * Worst case adds 3 * 1,050,624 bytes in fenced lighting allocations; stable
 * reuse uploads zero bytes. Point/gather demand allocates zero filter bytes.
 * Receiver-plane correction adds one normal transform/divide per valid
 * receiver and four small dot products; shares slot/receiver address setup.
 * Removing 12 depth instructions is not a claim about DRAM traffic or FPS. */
export const VSM_FILTER_MODES = { point: 0, gather2x2: 1, disk4: 2 } as const;
export type VsmFilterMode = keyof typeof VSM_FILTER_MODES;
export const VSM_FILTER_NOISE_WIDTH = 128;
export const VSM_FILTER_NOISE_HEIGHT = 128;
export const VSM_FILTER_NOISE_PHASES = 64;
export const VSM_FILTER_NOISE_BYTES =
  VSM_FILTER_NOISE_WIDTH * VSM_FILTER_NOISE_HEIGHT * VSM_FILTER_NOISE_PHASES;
export const VSM_FILTER_ROTATIONS = 256;
export const VSM_FILTER_DATA_BYTES = VSM_FILTER_NOISE_BYTES + VSM_FILTER_ROTATIONS * 8;

export function packVsmFilterData(noise: Uint8Array): Uint8Array<ArrayBuffer> {
  if (noise.byteLength !== VSM_FILTER_NOISE_BYTES) {
    throw new RangeError("VSM requires the complete 128x128x64 scalar STBN sequence");
  }
  const bytes = new Uint8Array(VSM_FILTER_DATA_BYTES);
  bytes.set(noise);
  const rotations = new DataView(bytes.buffer, VSM_FILTER_NOISE_BYTES);
  for (let index = 0; index < VSM_FILTER_ROTATIONS; index++) {
    const angle = index * ((2 * Math.PI) / VSM_FILTER_ROTATIONS);
    rotations.setFloat32(index * 8, Math.cos(angle), true);
    rotations.setFloat32(index * 8 + 4, Math.sin(angle), true);
  }
  return bytes;
}

// Equal-area Vogel disk, r=sqrt((i+.5)/4), theta=i*pi*(3-sqrt(5)).
// Precomputed on the host; the shader never evaluates per-tap trig/sqrt.
export const VSM_VOGEL_POINTS = Object.freeze(
  Array.from({ length: 4 }, (_, index) => {
    const radius = Math.sqrt((index + 0.5) / 4);
    const angle = index * Math.PI * (3 - Math.sqrt(5));
    return Object.freeze([Math.fround(radius * Math.cos(angle)), Math.fround(radius * Math.sin(angle))]);
  }),
);
