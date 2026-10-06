import { FRAME_GEOMETRY_MESHLET_STRIDE } from "./GpuWinnerInterpolationAbi.js";
import { GPU_FRAME_VERTEX_ATTRIBUTE_STRIDE } from "./GpuFrameGeometryAttributesAbi.js";

/** Single raw-word Surface binding; producers bind disjoint typed subranges.
 * Directories retain final MeshletWork namespaces separately. No work-slot or
 * physical arena offset is a persistent Appearance identity. */
export const FRAME_GEOMETRY_ARENA_VERSION = 3;
export const FRAME_GEOMETRY_ARENA_HEADER_SIZE = 64;
export const FRAME_GEOMETRY_ARENA_HEADER_WORDS = Object.freeze({
  version: 0,
  workCapacity: 1,
  vertexCapacity: 2,
  triangleCapacity: 3,
  sourceDirectory: 4,
  filteredDirectory: 5,
  clips: 6,
  triangles: 7,
  filteredWorkCapacity: 13,
  attributes: 14,
  attributeCapacity: 15
});
export interface FrameGeometryArenaBudget {
  readonly workCapacity: number;
  /** Zero/absent allocates no second directory for views without late HZB. */
  readonly filteredWorkCapacity?: number;
  readonly vertexCapacity: number;
  readonly triangleCapacity: number;
  readonly maxBytes: number;
}
export interface FrameGeometryArenaRegion {
  readonly offset: number;
  readonly size: number;
}
export interface FrameGeometryArenaLayout {
  readonly metadataBytes: number;
  readonly header: FrameGeometryArenaRegion;
  readonly sourceDirectory: FrameGeometryArenaRegion;
  readonly filteredDirectory: FrameGeometryArenaRegion;
  readonly clips: FrameGeometryArenaRegion;
  readonly triangles: FrameGeometryArenaRegion;
  readonly attributes: FrameGeometryArenaRegion;
  readonly attributeCapacity: number;
  readonly byteLength: number;
}

export function frameGeometryArenaLayout(
  metadataBytes: number,
  budget: FrameGeometryArenaBudget,
  limits: Pick<
    GPUSupportedLimits,
    "minStorageBufferOffsetAlignment" | "maxStorageBufferBindingSize" | "maxBufferSize"
  >
): FrameGeometryArenaLayout {
  if (
    !Number.isSafeInteger(metadataBytes) ||
    metadataBytes < 4 ||
    metadataBytes % 4 !== 0 ||
    !Object.entries(budget).every(
      ([key, n]) => Number.isSafeInteger(n) && (key === "filteredWorkCapacity" ? n >= 0 : n > 0)
    ) ||
    [budget.workCapacity, budget.vertexCapacity, budget.triangleCapacity].some((n) => n > 0xffffffff) ||
    (budget.filteredWorkCapacity ?? 0) > budget.workCapacity
  ) {
    throw new RangeError("Invalid explicit frame geometry arena capacities");
  }
  const alignment = limits.minStorageBufferOffsetAlignment;
  if (!Number.isSafeInteger(alignment) || alignment < 16 || (alignment & (alignment - 1)) !== 0) {
    throw new RangeError("Invalid negotiated storage range alignment");
  }
  let cursor = metadataBytes;
  const region = (size: number): FrameGeometryArenaRegion => {
    const offset = Math.ceil(cursor / alignment) * alignment;
    cursor = offset + size;
    return Object.freeze({ offset, size });
  };
  const header = region(FRAME_GEOMETRY_ARENA_HEADER_SIZE);
  const sourceDirectory = region(16 + budget.workCapacity * FRAME_GEOMETRY_MESHLET_STRIDE);
  const filteredDirectory =
    (budget.filteredWorkCapacity ?? 0) > 0
      ? region(16 + budget.filteredWorkCapacity! * FRAME_GEOMETRY_MESHLET_STRIDE)
      : sourceDirectory;
  const clips = region(budget.vertexCapacity * 16);
  const triangles = region(budget.triangleCapacity * 4);
  const maximum = Math.min(budget.maxBytes, limits.maxBufferSize, limits.maxStorageBufferBindingSize);
  const attributeOffset = Math.ceil(cursor / alignment) * alignment;
  const attributeCapacity = Math.max(
    0,
    Math.min(
      budget.vertexCapacity,
      Math.floor((maximum - attributeOffset) / GPU_FRAME_VERTEX_ATTRIBUTE_STRIDE)
    )
  );
  const attributes = region(Math.max(16, attributeCapacity * GPU_FRAME_VERTEX_ATTRIBUTE_STRIDE));
  if (
    !Number.isSafeInteger(cursor) ||
    cursor > budget.maxBytes ||
    cursor > limits.maxBufferSize ||
    cursor > limits.maxStorageBufferBindingSize ||
    cursor / 4 > 0xffffffff
  ) {
    throw new RangeError("Frame geometry arena exceeds explicit bytes or negotiated single-binding limit");
  }
  return Object.freeze({
    metadataBytes,
    header,
    sourceDirectory,
    filteredDirectory,
    clips,
    triangles,
    attributes,
    attributeCapacity,
    byteLength: cursor
  });
}

export function frameGeometryArenaHeader(
  layout: FrameGeometryArenaLayout,
  budget: FrameGeometryArenaBudget
): Uint32Array<ArrayBuffer> {
  const words = new Uint32Array(FRAME_GEOMETRY_ARENA_HEADER_SIZE / 4),
    at = FRAME_GEOMETRY_ARENA_HEADER_WORDS;
  words[at.version] = FRAME_GEOMETRY_ARENA_VERSION;
  words[at.workCapacity] = budget.workCapacity;
  words[at.filteredWorkCapacity] = budget.filteredWorkCapacity ?? 0;
  words[at.vertexCapacity] = budget.vertexCapacity;
  words[at.triangleCapacity] = budget.triangleCapacity;
  words[at.sourceDirectory] = layout.sourceDirectory.offset / 4;
  words[at.filteredDirectory] = layout.filteredDirectory.offset / 4;
  words[at.clips] = layout.clips.offset / 4;
  words[at.triangles] = layout.triangles.offset / 4;
  words[at.attributes] = layout.attributes.offset / 4;
  words[at.attributeCapacity] = layout.attributeCapacity;
  return words;
}
