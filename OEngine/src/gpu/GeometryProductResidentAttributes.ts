import {
  decodeGroupHeaderV3,
  decodeMeshletHeaderV3,
  OEGPACK_V3_PAGE_BYTES,
  OEGPACK_V3_MESHLET_HEADER_BYTES,
} from "../assets/GeometryAbiV3.js";
import {
  decodeGeometryProductPageRecordV1,
  type GeometryProductDescriptorV1,
} from "../assets/geometry-product/GeometryProductV1.js";
import { geometryProductWorkload } from "../assets/geometry-product/GeometryProductWorkload.js";

export interface ProductResidentPage {
  readonly rawPayloadBytes: number;
  readonly slotCount: 1;
  readonly uploadBytes: number;
  readonly triangleCount: number;
  /** Group id covered first by this page. Page groups are a contiguous range. */
  readonly groupBegin: number;
  readonly groupCount: number;
  /** Object-space AABB per page-local group: 6 floats (min xyz, max xyz). */
  readonly groupBounds: Float32Array;
  /** Product-local refine edges as (fineRefineGroupId, coarseGroupId) pairs. A
   * coarse meshlet's refineGroupId names the *finer* group it simplifies, so the
   * pair reads "coarse group is a parent of fine group". */
  readonly refineEdges: Uint32Array;
}

/** Validate compact geometry before publication, without expanding attributes.
 * Startup admission and runtime streaming share this single numeric owner. */
export function prepareProductResidentAttributes(
  descriptor: GeometryProductDescriptorV1,
  pageId: number,
  bytes: ArrayBuffer,
): ProductResidentPage {
  const page = new DataView(bytes);
  const directory = new DataView(
    descriptor.groupDirectory.buffer,
    descriptor.groupDirectory.byteOffset,
    descriptor.groupDirectory.byteLength,
  );
  const formats = new DataView(
    descriptor.vertexFormats.buffer,
    descriptor.vertexFormats.byteOffset,
    descriptor.vertexFormats.byteLength,
  );
  if (bytes.byteLength !== OEGPACK_V3_PAGE_BYTES) {
    throw new RangeError("Product resident page must be 256 KiB");
  }
  let rawPayloadBytes = 0;
  let triangleCount = 0;
  const pageRecord = decodeGeometryProductPageRecordV1(descriptor, pageId);
  const workload = geometryProductWorkload(descriptor);
  const groupBounds = new Float32Array(pageRecord.groupCount * 6);
  const refineEdges: number[] = [];
  for (let group = pageRecord.firstGroup; group < pageRecord.firstGroup + pageRecord.groupCount; group++) {
    const offset = directory.getUint32(group * 16 + 4, true);
    const payload = directory.getUint32(group * 16 + 8, true);
    rawPayloadBytes = Math.max(rawPayloadBytes, offset + payload);
    if (offset + payload > bytes.byteLength) {
      throw new RangeError("Product group exceeds the decoded page");
    }
    const header = decodeGroupHeaderV3(page, offset);
    if (
      header.payloadBytes !== payload ||
      header.meshletCount < 1 ||
      header.meshletCount > 128 ||
      header.meshletHeaderOffset < 64 ||
      header.meshletHeaderOffset + header.meshletCount * OEGPACK_V3_MESHLET_HEADER_BYTES >
        header.triangleDataOffset ||
      header.triangleDataOffset > header.vertexDataOffset ||
      header.vertexDataOffset > payload ||
      header.vertexFormatId * 16 + 16 > formats.byteLength
    ) {
      throw new RangeError("Product resident group layout is invalid");
    }
    if (header.meshletCount !== workload.groupMeshletCounts[group]) {
      throw new RangeError("Product page meshlet count disagrees with its hierarchy work bound");
    }
    const localGroup = group - pageRecord.firstGroup;
    const bounds = header.bboxMin;
    const boundsMax = header.bboxMax;
    for (let axis = 0; axis < 3; axis++) {
      groupBounds[localGroup * 6 + axis] = bounds[axis]!;
      groupBounds[localGroup * 6 + 3 + axis] = boundsMax[axis]!;
    }
    const format = header.vertexFormatId * 16;
    const stride = formats.getUint16(format, true),
      mask = formats.getUint16(format + 2, true);
    const position = formats.getUint8(format + 4),
      normal = formats.getUint8(format + 5),
      tangent = formats.getUint8(format + 6),
      uv0 = formats.getUint8(format + 7),
      uv1 = formats.getUint8(format + 8),
      color = formats.getUint8(format + 9);
    const hasNormal = (mask & 2) !== 0;
    const hasTangent = (mask & 4) !== 0;
    const hasUv0 = (mask & 8) !== 0;
    const hasUv1 = (mask & 16) !== 0;
    const hasColor = (mask & 32) !== 0;
    const checkField = (field: number, size: number, active: boolean): void => {
      if (active && (field === 255 || field + size > stride)) {
        throw new RangeError("Product resident vertex field exceeds its stride");
      }
    };
    checkField(position, 12, true);
    checkField(normal, 4, hasNormal);
    checkField(tangent, 6, hasTangent);
    checkField(uv0, 4, hasUv0);
    checkField(uv1, 4, hasUv1);
    checkField(color, 3, hasColor);
    for (let local = 0; local < header.meshletCount; local++) {
      const meshlet = decodeMeshletHeaderV3(
        page,
        offset + header.meshletHeaderOffset + local * OEGPACK_V3_MESHLET_HEADER_BYTES,
      );
      if (
        meshlet.vertexCount < 1 ||
        meshlet.vertexCount > 128 ||
        meshlet.triangleCount < 1 ||
        meshlet.triangleCount > 128 ||
        meshlet.vertexByteOffset < header.vertexDataOffset ||
        meshlet.vertexByteOffset + meshlet.vertexCount * stride > payload ||
        meshlet.triangleByteOffset < header.triangleDataOffset ||
        meshlet.triangleByteOffset + meshlet.triangleCount * 3 > header.vertexDataOffset
      ) {
        throw new RangeError("Product resident meshlet layout is invalid");
      }
      triangleCount += meshlet.triangleCount;
      // The refine id names the finer group this coarse meshlet simplifies, so
      // the pair is (fine group, this coarse group). Roots carry no refine id.
      if (meshlet.refineGroupId !== 0xffffffff) {
        refineEdges.push(meshlet.refineGroupId, group);
      }
      const triStart = offset + meshlet.triangleByteOffset;
      const triEnd = triStart + meshlet.triangleCount * 3;
      const vCount = meshlet.vertexCount;
      for (let corner = triStart; corner < triEnd; corner++) {
        if (page.getUint8(corner) >= vCount) {
          throw new RangeError("Product triangle references a missing resident vertex");
        }
      }
      const vertexBase = offset + meshlet.vertexByteOffset;
      for (let vertex = 0; vertex < meshlet.vertexCount; vertex++) {
        const at = vertexBase + vertex * stride;
        for (let axis = 0; axis < 3; axis++) {
          if (!Number.isFinite(page.getFloat32(at + position + axis * 4, true))) {
            throw new RangeError("Product resident attributes contain nonfinite position values");
          }
        }
        // Half-float exponent 31 represents infinity or NaN. Integer normal,
        // tangent and color encodings always decode to finite bounded values.
        for (let set = 0; set < 2; set++) {
          const present = set === 0 ? hasUv0 : hasUv1;
          if (present) {
            const uv = at + (set === 0 ? uv0 : uv1);
            if (
              (page.getUint16(uv, true) & 0x7c00) === 0x7c00 ||
              (page.getUint16(uv + 2, true) & 0x7c00) === 0x7c00
            ) {
              throw new RangeError("Product resident attributes contain nonfinite UV values");
            }
          }
        }
      }
    }
  }
  if (pageRecord.groupCount === 0) {
    throw new RangeError("Product resident page has no groups");
  }
  rawPayloadBytes = Math.ceil(rawPayloadBytes / 4) * 4;
  return Object.freeze({
    rawPayloadBytes,
    slotCount: 1 as const,
    uploadBytes: rawPayloadBytes,
    triangleCount,
    groupBegin: pageRecord.firstGroup,
    groupCount: pageRecord.groupCount,
    groupBounds,
    refineEdges: Uint32Array.from(refineEdges),
  });
}
