import { OEGPACK_V3_PAGE_BYTES } from "../GeometryAbiV3.js";
import { decodeGeometryProductPageRecordV1, type GeometryProductDescriptorV1 } from "./GeometryProductV1.js";

/** Prefix length of the authenticated directory, preserving every group offset. */
export function geometryPagePayloadBytes(descriptor: GeometryProductDescriptorV1, pageId: number): number {
  const record = decodeGeometryProductPageRecordV1(descriptor, pageId);
  const groups = new DataView(
    descriptor.groupDirectory.buffer,
    descriptor.groupDirectory.byteOffset,
    descriptor.groupDirectory.byteLength,
  );
  let end = 0;
  for (let group = record.firstGroup; group < record.firstGroup + record.groupCount; group++) {
    const page = groups.getUint32(group * 16, true);
    const offset = groups.getUint32(group * 16 + 4, true);
    const bytes = groups.getUint32(group * 16 + 8, true);
    if (
      page !== pageId ||
      offset % 16 !== 0 ||
      bytes < 64 ||
      bytes > OEGPACK_V3_PAGE_BYTES ||
      offset > OEGPACK_V3_PAGE_BYTES - bytes
    ) {
      throw new RangeError("Geometry directory page prefix is invalid");
    }
    end = Math.max(end, offset + bytes);
  }
  end = Math.ceil(end / 4) * 4;
  if (end > OEGPACK_V3_PAGE_BYTES) {
    throw new RangeError("Geometry directory page prefix exceeds its logical page");
  }
  return end;
}
