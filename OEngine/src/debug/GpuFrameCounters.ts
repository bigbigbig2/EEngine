import {
  GpuReadbackRing,
  type GpuReadbackRingStats,
  type GpuReadbackTicket
} from "./GpuReadbackRing.js";

export const GPU_COUNTER_SCHEMA_VERSION = 10;
export const GPU_COUNTER_BYTE_SIZE = 512;

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
  { name: "activeMaterials", index: 15, semantic: "active non-transparent MaterialRecords consumed by one Material Resolve draw" },
  { name: "activeLights", index: 16, semantic: "active local lights" },
  { name: "queueOverflowMask", index: 17, semantic: "registered queue overflow bits" },
  { name: "rootStageQueueReservations", index: 18, semantic: "sampled fused root/leaf global bounded queue reservation attempts" },
  { name: "traversalQueueReservations", index: 19, semantic: "sampled post-root hierarchy global bounded queue reservation attempts" },
  { name: "workGenerationDispatchUpdates", index: 20, semantic: "sampled workgroups that publish a next-round indirect dispatch extent" },
  { name: "workGenerationCasRetries", index: 21, semantic: "sampled failed bounded queue compare-exchange attempts" },
  { name: "invalidVisibilityKeys", index: 22, semantic: "final VisibilityKey pixels using the reserved RasterWork slot" },
  { name: "gradientFallbackPixels", index: 23, semantic: "Material Resolve pixels using the conservative analytic-gradient fallback" },
  { name: "reactiveSurfacePixels", index: 24, semantic: "Material Resolve pixels whose temporal history must be rejected" },
  { name: "normalTexturePixels", index: 25, semantic: "Material Resolve pixels using a normal texture feature bit" },
  { name: "ormTexturePixels", index: 26, semantic: "Material Resolve pixels using an ORM texture feature bit" },
  { name: "emissiveTexturePixels", index: 27, semantic: "Material Resolve pixels using an emissive texture feature bit" },
  { name: "unlitSurfacePixels", index: 28, semantic: "Material Resolve pixels using the unlit feature bit" },
  { name: "candidateLightsAttempted", index: 29, semantic: "frustum-visible local light list append attempts" },
  { name: "candidateLightsWritten", index: 30, semantic: "bounded frustum-visible local light list writes" },
  { name: "activeLightsAttempted", index: 31, semantic: "HZB-filtered local light list append attempts" },
  { name: "clusterTestedLights", index: 32, semantic: "light-vs-cluster intersection tests" },
  { name: "clusterLightIndicesAttempted", index: 33, semantic: "cluster index reservations attempted" },
  { name: "clusterLightIndicesWritten", index: 34, semantic: "bounded cluster index writes" },
  { name: "clusterOverflowClusters", index: 35, semantic: "clusters using an explicit overflow flag" },
  { name: "clusterFallbackLights", index: 36, semantic: "active-list light evaluations caused by conservative fallback" },
  { name: "clusterLightReferences", index: 37, semantic: "lights evaluated by direct lighting across all clusters" },
  { name: "clusterMaxLights", index: 38, semantic: "maximum evaluated lights in one cluster" },
  { name: "clusterHistogram0", index: 39, semantic: "clusters evaluating zero local lights" },
  { name: "clusterHistogram1", index: 40, semantic: "clusters evaluating one local light" },
  { name: "clusterHistogram4", index: 41, semantic: "clusters evaluating two to four local lights" },
  { name: "clusterHistogram8", index: 42, semantic: "clusters evaluating five to eight local lights" },
  { name: "clusterHistogram16", index: 43, semantic: "clusters evaluating nine to sixteen local lights" },
  { name: "clusterHistogram32", index: 44, semantic: "clusters evaluating seventeen to thirty-two local lights" },
  { name: "clusterHistogram64", index: 45, semantic: "clusters evaluating thirty-three to sixty-four local lights" },
  { name: "clusterHistogram128", index: 46, semantic: "clusters evaluating sixty-five to one-hundred-twenty-eight local lights" },
  { name: "clusterHistogram256", index: 47, semantic: "clusters evaluating more than one-hundred-twenty-eight local lights" },
  { name: "iblSampledPixels", index: 48, semantic: "valid Surface pixels included in sampled IBL mip evidence" },
  { name: "iblMip0", index: 49, semantic: "IBL pixels whose nearest specular mip is 0" },
  { name: "iblMip1", index: 50, semantic: "IBL pixels whose nearest specular mip is 1" },
  { name: "iblMip2", index: 51, semantic: "IBL pixels whose nearest specular mip is 2" },
  { name: "iblMip3", index: 52, semantic: "IBL pixels whose nearest specular mip is 3" },
  { name: "iblMip4", index: 53, semantic: "IBL pixels whose nearest specular mip is 4" },
  { name: "iblMip5", index: 54, semantic: "IBL pixels whose nearest specular mip is 5" },
  { name: "iblMip6", index: 55, semantic: "IBL pixels whose nearest specular mip is 6" },
  { name: "iblMip7", index: 56, semantic: "IBL pixels whose nearest specular mip is 7" },
  { name: "iblMip8", index: 57, semantic: "IBL pixels whose nearest specular mip is 8 or above" },
  { name: "shadowCascade0RasterWork", index: 58, semantic: "sampled SecondaryRasterWork written for directional cascade 0" },
  { name: "shadowCascade1RasterWork", index: 59, semantic: "sampled SecondaryRasterWork written for directional cascade 1" },
  { name: "shadowCascade2RasterWork", index: 60, semantic: "sampled SecondaryRasterWork written for directional cascade 2" },
  { name: "shadowAtlasPixelsUpdated", index: 61, semantic: "sampled directional shadow atlas pixels updated" },
  { name: "shadowAlphaRasterWork", index: 62, semantic: "sampled alpha-tested directional SecondaryRasterWork" },
  { name: "shadowQueueOverflowMask", index: 63, semantic: "sampled per-cascade SecondaryRasterWork overflow bits" },
  { name: "transparentRasterWork", index: 64, semantic: "sampled bounded TransparentRasterWork written" },
  { name: "transparentTriangles", index: 65, semantic: "sampled exact transparent meshlet triangles" },
  { name: "transparentReactivePixels", index: 66, semantic: "sampled pixels covered by BLEND geometry" },
  { name: "transparentMomentFiniteFailures", index: 67, semantic: "sampled non-finite optical or power-moment pixels" },
  { name: "transparentQueueOverflowMask", index: 68, semantic: "sampled TransparentRasterWork overflow bit" },
  { name: "temporalReactivePixels", index: 69, semantic: "sampled unified opaque/transparent reactive pixels consumed by Temporal" },
  { name: "temporalDisoccludedPixels", index: 70, semantic: "sampled pixels rejected by shared disocclusion confidence" },
  { name: "temporalHistoryRejectedPixels", index: 71, semantic: "sampled pixels rejecting history for global validity, motion, reactive or disocclusion" },
  { name: "aoEvaluatedPixels", index: 72, semantic: "sampled GTAO-resolution pixels evaluated by the temporal evidence reducer" },
  { name: "aoHistoryAcceptedPixels", index: 73, semantic: "sampled GTAO pixels whose current temporal policy assigns non-zero history weight" },
  { name: "aoHistoryRejectedPixels", index: 74, semantic: "sampled GTAO pixels whose current temporal policy rejects history" },
  { name: "ssrTracePixels", index: 75, semantic: "sampled non-background pixels entering the current SSR hierarchical trace" },
  { name: "ssrHitPixels", index: 76, semantic: "sampled SSR trace pixels producing non-zero validated hit confidence" },
  { name: "ssrTraceSteps", index: 77, semantic: "sampled sum of hierarchical SSR trace iterations" },
  { name: "ssrMaxTraceSteps", index: 78, semantic: "sampled maximum hierarchical SSR trace iterations for one pixel" },
  { name: "ssrRoughnessRejectedPixels", index: 79, semantic: "sampled pixels rejected before SSR trace by the active roughness policy; zero on the pre-Q04 implementation" },
  { name: "ssrDistanceRejectedPixels", index: 80, semantic: "sampled pixels rejected by max-distance termination; zero on the pre-Q04 implementation" },
  { name: "ssrHighRoughnessTracePixels", index: 81, semantic: "sampled pixels above the Q00 diagnostic roughness threshold that still entered the pre-Q04 trace" },
  { name: "ssrDistanceLimitExceededPixels", index: 82, semantic: "sampled validated rays longer than requested maxDistance that the pre-Q04 trace did not terminate" },
  { name: "ssrValidationRejectedPixels", index: 83, semantic: "sampled hierarchical hits rejected by current depth, facing, edge or confidence validation" }
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
