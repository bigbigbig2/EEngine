import type { ScgiFramePublication } from "./ScgiPublication.js";
import { assertScgiCompoundFact } from "./ScgiPublication.js";
import { SCGI_ABI } from "./ScgiAbi.js";

export interface ScgiFieldCopy {
  readonly source: GPUBuffer;
  readonly sourceOffset: number;
  readonly destinationOffset: number;
  readonly bytes: number;
}

/** Intersect a logical half-field interval with its physical segments. Never
 * assume that a segment boundary falls on a row, including odd extents. */
export function scgiFieldCopies(
  publication: ScgiFramePublication,
  first: number,
  count: number,
  destinationOffset: number,
): readonly ScgiFieldCopy[] {
  assertScgiCompoundFact(publication, {
    generation: publication.generation,
    halfExtent: publication.halfExtent,
    fieldStride: 112,
    identityBytes: 64,
    completeWrite: true,
    domain: "linear-rec709-unexposed",
  });
  if (
    ![first, count, destinationOffset].every(Number.isSafeInteger) ||
    first < 0 ||
    count < 1 ||
    destinationOffset < 0 ||
    destinationOffset % 4 !== 0 ||
    first + count > publication.halfExtent[0] * publication.halfExtent[1]
  ) {
    throw new RangeError("SCGI copy must cover a complete in-domain field interval");
  }
  const copies: ScgiFieldCopy[] = [];
  let segmentFirst = 0;
  let written = 0;
  const stride = SCGI_ABI.halfField.stride;
  for (const segment of publication.candidateWorldField.segments) {
    const range = segment.plan.ranges.worldField!;
    const begin = Math.max(first, segmentFirst);
    const end = Math.min(first + count, segmentFirst + range.count);
    if (begin < end) {
      const bytes = (end - begin) * stride;
      copies.push({
        source: segment.buffer,
        sourceOffset: range.offset + (begin - segmentFirst) * stride,
        destinationOffset: destinationOffset + (begin - first) * stride,
        bytes,
      });
      written += bytes;
    }
    segmentFirst += range.count;
  }
  if (written !== count * stride) {
    throw new Error("SCGI segmented field has a hole in its copy domain");
  }
  return copies;
}
