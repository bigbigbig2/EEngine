import type { GpuCounterFieldName } from "../../debug/GpuFrameCounters.js";
import { SURFACE_SAMPLE_COUNTER } from "./SurfaceSampleAbi.js";
import { SURFACE_PROBE_REASONS } from "./SurfaceProbe.js";

/** Observational copies on the existing frame encoder and delayed readback ring. */
export const SURFACE_GPU_COUNTER_SOURCES = [
  { field: "surfaceVisiblePixels", source: "work", offset: SURFACE_SAMPLE_COUNTER.visible * 4 },
  { field: "surfaceMaterialSamples", source: "work", offset: SURFACE_SAMPLE_COUNTER.material * 4 },
  { field: "surfaceLightingSamples", source: "work", offset: SURFACE_SAMPLE_COUNTER.lighting * 4 },
  { field: "surfaceFullSamples", source: "work", offset: SURFACE_SAMPLE_COUNTER.full * 4 },
  { field: "surfaceCoarseSamples", source: "work", offset: SURFACE_SAMPLE_COUNTER.coarse * 4 },
  { field: "surfaceFallbackTiles", source: "work", offset: SURFACE_SAMPLE_COUNTER.fallback * 4 },
  { field: "surfaceRecordOverflowTiles", source: "work", offset: SURFACE_SAMPLE_COUNTER.recordOverflow * 4 },
  { field: "surfaceResultOverflowTiles", source: "work", offset: SURFACE_SAMPLE_COUNTER.resultOverflow * 4 },
  { field: "surfaceImplicitTiles", source: "work", offset: SURFACE_SAMPLE_COUNTER.implicit * 4 },
  { field: "surfaceMixedTiles", source: "work", offset: SURFACE_SAMPLE_COUNTER.mixed * 4 },
  { field: "surfaceLightingRejectedCells", source: "work", offset: SURFACE_SAMPLE_COUNTER.lightingRejected * 4 },
  { field: "surfaceMaterialCoarseSamples", source: "work", offset: SURFACE_SAMPLE_COUNTER.materialCoarse * 4 },
  { field: "surfaceLightingCoarseSamples", source: "work", offset: SURFACE_SAMPLE_COUNTER.lightingCoarse * 4 },
  { field: "surfaceRecordsAttempted", source: "work", offset: SURFACE_SAMPLE_COUNTER.records * 4 },
  { field: "surfaceResultsAttempted", source: "work", offset: SURFACE_SAMPLE_COUNTER.results * 4 },
  { field: "surfaceSetupBuilds", source: "work", offset: SURFACE_SAMPLE_COUNTER.setupBuilds * 4 },
  { field: "surfaceSetupHits", source: "work", offset: SURFACE_SAMPLE_COUNTER.setupHits * 4 },
  { field: "surfaceSetupMisses", source: "work", offset: SURFACE_SAMPLE_COUNTER.setupMisses * 4 },
  { field: "surfaceSplitPixels", source: "work", offset: SURFACE_SAMPLE_COUNTER.splitPixels * 4 },
  { field: "surfaceReconstructionAccepted", source: "work", offset: SURFACE_SAMPLE_COUNTER.reconstructionAccepted * 4 },
  { field: "surfaceReconstructionRejected", source: "work", offset: SURFACE_SAMPLE_COUNTER.reconstructionRejected * 4 },
  { field: "surfacePbrPixels", source: "probe", offset: SURFACE_PROBE_REASONS.pbrPixels * 4 },
  { field: "surfaceProbeCells", source: "probe", offset: SURFACE_PROBE_REASONS.cells * 4 },
  { field: "surfaceRateFullCells", source: "probe", offset: SURFACE_PROBE_REASONS.full * 4 },
  { field: "surfaceRateHorizontalCells", source: "probe", offset: SURFACE_PROBE_REASONS.horizontal * 4 },
  { field: "surfaceRateVerticalCells", source: "probe", offset: SURFACE_PROBE_REASONS.vertical * 4 },
  { field: "surfaceRateQuadCells", source: "probe", offset: SURFACE_PROBE_REASONS.quad * 4 },
  { field: "surfaceSamePrimitivePairs", source: "probe", offset: SURFACE_PROBE_REASONS.samePrimitive * 4 },
  { field: "surfaceCrossPrimitivePairs", source: "probe", offset: SURFACE_PROBE_REASONS.crossPrimitive * 4 },
  { field: "surfaceInvalidRejected", source: "probe", offset: SURFACE_PROBE_REASONS.invalid * 4 },
  { field: "surfaceGeometryRejected", source: "probe", offset: SURFACE_PROBE_REASONS.geometry * 4 },
  { field: "surfaceContinuityRejected", source: "probe", offset: SURFACE_PROBE_REASONS.continuity * 4 },
  { field: "surfaceMaterialRejected", source: "probe", offset: SURFACE_PROBE_REASONS.material * 4 },
  { field: "surfaceResidencyRejected", source: "probe", offset: SURFACE_PROBE_REASONS.residency * 4 },
  { field: "surfaceVariationRejected", source: "probe", offset: SURFACE_PROBE_REASONS.variation * 4 },
  { field: "surfaceUvRejected", source: "probe", offset: SURFACE_PROBE_REASONS.uv * 4 }
] as const satisfies readonly { field: GpuCounterFieldName; source: "work" | "probe"; offset: number }[];
