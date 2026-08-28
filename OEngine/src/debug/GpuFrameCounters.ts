import {
  GpuReadbackRing,
  type GpuReadbackRingStats,
  type GpuReadbackTicket
} from "./GpuReadbackRing.js";

export const GPU_COUNTER_SCHEMA_VERSION = 1;
export const GPU_COUNTER_BYTE_SIZE = 256;

/** Stable queueOverflowMask bits; material/light bits are reserved until wired. */
export const GPU_QUEUE_OVERFLOW_BITS = {
  sceneMeshList: 1 << 0,
  meshletList: 1 << 1,
  materialMeshletList: 1 << 2,
  lightList: 1 << 3
} as const;

export const GPU_COUNTER_FIELDS = [
  { name: "candidateInstances", index: 0, semantic: "scene GPU frustum-filter input rows across visibility jobs" },
  { name: "visibleInstances", index: 1, semantic: "scene GPU frustum-filter output rows" },
  { name: "visitedBvhNodes", index: 2, semantic: "hierarchy nodes visited" },
  { name: "candidateClusters", index: 3, semantic: "flat candidate Meshlets or hierarchy nodes visited, selected by implementation evidence" },
  { name: "selectedClusters", index: 4, semantic: "flat RasterWork items or hierarchy VisibleCluster records, selected by implementation evidence" },
  { name: "rejectedFrustum", index: 5, semantic: "scene GPU frustum-filter rejected rows" },
  { name: "rejectedCone", index: 6, semantic: "cone rejects" },
  { name: "rejectedHzb", index: 7, semantic: "HZB rejects" },
  { name: "swClusters", index: 8, semantic: "software raster clusters" },
  { name: "hwClusters", index: 9, semantic: "hardware RasterWork Meshlet records consumed by drawIndirect" },
  { name: "alphaClusters", index: 10, semantic: "alpha-tested clusters" },
  { name: "swTriangles", index: 11, semantic: "software raster triangles" },
  { name: "hwTriangles", index: 12, semantic: "fixed-function raster primitives submitted" },
  { name: "shadedPixels", index: 13, semantic: "resolved visible pixels" },
  { name: "emptyVisibilityPixels", index: 14, semantic: "empty resolve pixels" },
  { name: "activeMaterials", index: 15, semantic: "non-transparent Material Expand fullscreen draws" },
  { name: "activeLights", index: 16, semantic: "active local lights" },
  { name: "queueOverflowMask", index: 17, semantic: "registered queue overflow bits" }
] as const;

export type GpuCounterFieldName = (typeof GPU_COUNTER_FIELDS)[number]["name"];
export type GpuCounterValues = Record<GpuCounterFieldName, number>;

export interface GpuFrameCounterBufferOptions {
  slotCount?: number;
  onResult: (frameIndex: number, values: GpuCounterValues) => void;
  onError?: (frameIndex: number, error: unknown) => void;
}

/** Owner of the fixed GPU counter ABI and its sampled readback ring. */
export class GpuFrameCounterBuffer {
  readonly buffer: GPUBuffer;
  private readonly ring: GpuReadbackRing;

  constructor(device: GPUDevice, options: GpuFrameCounterBufferOptions) {
    this.buffer = device.createBuffer({
      label: "FrameProfiler/GPU counters v1",
      size: GPU_COUNTER_BYTE_SIZE,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST
    });
    this.ring = new GpuReadbackRing(device, {
      byteLength: GPU_COUNTER_BYTE_SIZE,
      slotCount: options.slotCount ?? 3,
      label: "FrameProfiler/GPU counter readback",
      onResult: ({ frameIndex, data }) => {
        options.onResult(frameIndex, decodeGpuCounterValues(new Uint32Array(data)));
      },
      onError: ({ frameIndex, error }) => options.onError?.(frameIndex, error)
    });
  }

  get stats(): GpuReadbackRingStats {
    return this.ring.stats;
  }

  clear(encoder: Pick<GPUCommandEncoder, "clearBuffer">): void {
    encoder.clearBuffer(this.buffer, 0, GPU_COUNTER_BYTE_SIZE);
  }

  copyField(
    encoder: Pick<GPUCommandEncoder, "copyBufferToBuffer">,
    field: GpuCounterFieldName,
    source: GPUBuffer,
    sourceOffset = 0
  ): void {
    encoder.copyBufferToBuffer(
      source,
      sourceOffset,
      this.buffer,
      counterByteOffset(field),
      Uint32Array.BYTES_PER_ELEMENT
    );
  }

  encodeReadback(
    encoder: Pick<GPUCommandEncoder, "copyBufferToBuffer">,
    frameIndex: number
  ): GpuReadbackTicket | null {
    return this.ring.encodeCopy(encoder, this.buffer, 0, frameIndex);
  }

  markSubmitted(ticket: GpuReadbackTicket): void {
    this.ring.markSubmitted(ticket);
  }

  cancel(ticket: GpuReadbackTicket, error: unknown): void {
    this.ring.cancel(ticket, error);
  }

  destroy(): void {
    this.ring.destroy();
    this.buffer.destroy();
  }
}

export function counterByteOffset(field: GpuCounterFieldName): number {
  const definition = GPU_COUNTER_FIELDS.find((candidate) => candidate.name === field);
  if (definition === undefined) throw new RangeError(`Unknown GPU counter '${field}'`);
  return definition.index * Uint32Array.BYTES_PER_ELEMENT;
}

export function decodeGpuCounterValues(values: Uint32Array): GpuCounterValues {
  if (values.byteLength < GPU_COUNTER_BYTE_SIZE) {
    throw new RangeError(`GPU counter payload must contain ${GPU_COUNTER_BYTE_SIZE} bytes`);
  }
  const decoded = {} as GpuCounterValues;
  for (const field of GPU_COUNTER_FIELDS) decoded[field.name] = values[field.index] ?? 0;
  return decoded;
}
