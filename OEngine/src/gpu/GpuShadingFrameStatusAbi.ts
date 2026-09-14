/** Shared fail-closed status for shading consumers that do not need a bin heap. */
export const GPU_SHADING_FRAME_STATUS_ABI_VERSION = 1;
export const GPU_SHADING_FRAME_STATUS_BYTES = 32;

export const GPU_SHADING_FRAME_STATUS_OFFSETS = Object.freeze({
  frameFlags: 0,
  errorCount: 4,
  generation: 8,
  layoutRevision: 12,
  reserved0: 16,
  reserved1: 20,
  reserved2: 24,
  reserved3: 28
} as const);

export interface GpuShadingFrameStatusCpu {
  readonly frameFlags: number;
  readonly errorCount: number;
  readonly generation: number;
  readonly layoutRevision: number;
}

export function packGpuShadingFrameStatus(
  input: GpuShadingFrameStatusCpu
): Uint8Array {
  for (const [label, value] of [
    ["frame flags", input.frameFlags],
    ["error count", input.errorCount],
    ["generation", input.generation],
    ["layout revision", input.layoutRevision]
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`Shading frame status ${label} must be a u32`);
    }
  }
  const bytes = new Uint8Array(GPU_SHADING_FRAME_STATUS_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(GPU_SHADING_FRAME_STATUS_OFFSETS.frameFlags, input.frameFlags >>> 0, true);
  view.setUint32(GPU_SHADING_FRAME_STATUS_OFFSETS.errorCount, input.errorCount >>> 0, true);
  view.setUint32(GPU_SHADING_FRAME_STATUS_OFFSETS.generation, input.generation >>> 0, true);
  view.setUint32(GPU_SHADING_FRAME_STATUS_OFFSETS.layoutRevision, input.layoutRevision >>> 0, true);
  return bytes;
}

export const GPU_SHADING_FRAME_STATUS_WGSL = /* wgsl */ `
struct OEngineShadingFrameStatus {
  frame_flags: atomic<u32>,
  error_count: atomic<u32>,
  generation: u32,
  layout_revision: u32,
  reserved0: u32,
  reserved1: u32,
  reserved2: u32,
  reserved3: u32,
}
`;
