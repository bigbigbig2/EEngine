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
import { decodeFloat16 } from "../core/Float16.js";
import { GPU_FRAME_ATTRIBUTE_STRIDE } from "./GpuFrameGeometryAttributesAbi.js";
import { geometryProductWorkload } from "../assets/geometry-product/GeometryProductWorkload.js";

export interface ProductResidentMeshlet {
  readonly groupOffset: number;
  readonly localMeshlet: number;
  readonly values: Float32Array<ArrayBuffer>;
  readonly byteLength: number;
}
export interface ProductResidentPage {
  readonly directoryWords: number;
  readonly groups: readonly {
    readonly offset: number;
    readonly descriptorBase: number;
    readonly meshletCount: number;
  }[];
  readonly meshlets: readonly ProductResidentMeshlet[];
  readonly slotCount: number;
  readonly uploadBytes: number;
}

/** Immutable page fulfillment, using the existing decoded V3 format. Source
 * bounds/offsets are checked here, once, before publishing resident references.
 * No hash identity or cross-LOD correspondence is inferred from vertex values. */
export function prepareProductResidentAttributes(
  descriptor: GeometryProductDescriptorV1,
  pageId: number,
  bytes: ArrayBuffer,
  decode = true,
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
  const groups: { offset: number; descriptorBase: number; meshletCount: number }[] = [];
  const meshlets: ProductResidentMeshlet[] = [];
  let mapWords = 0,
    descriptorWords = 0;
  const pageRecord = decodeGeometryProductPageRecordV1(descriptor, pageId);
  const workload = geometryProductWorkload(descriptor);
  for (let group = pageRecord.firstGroup; group < pageRecord.firstGroup + pageRecord.groupCount; group++) {
    const offset = directory.getUint32(group * 16 + 4, true);
    const payload = directory.getUint32(group * 16 + 8, true);
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
    const format = header.vertexFormatId * 16;
    const stride = formats.getUint16(format, true),
      mask = formats.getUint16(format + 2, true);
    const position = formats.getUint8(format + 4),
      normal = formats.getUint8(format + 5),
      tangent = formats.getUint8(format + 6),
      uv0 = formats.getUint8(format + 7),
      uv1 = formats.getUint8(format + 8),
      color = formats.getUint8(format + 9);
    const checkField = (field: number, size: number, active: boolean): void => {
      if (active && (field === 255 || field + size > stride))
        throw new RangeError("Product resident vertex field exceeds its stride");
    };
    checkField(position, 12, true);
    checkField(normal, 4, (mask & 2) !== 0);
    checkField(tangent, 6, (mask & 4) !== 0);
    checkField(uv0, 4, (mask & 8) !== 0);
    checkField(uv1, 4, (mask & 16) !== 0);
    checkField(color, 3, (mask & 32) !== 0);
    groups.push({ offset, descriptorBase: descriptorWords, meshletCount: header.meshletCount });
    mapWords = Math.max(mapWords, offset / 16 + 1);
    descriptorWords += header.meshletCount;
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
      for (let corner = 0; corner < meshlet.triangleCount * 3; corner++) {
        if (page.getUint8(offset + meshlet.triangleByteOffset + corner) >= meshlet.vertexCount) {
          throw new RangeError("Product triangle references a missing resident vertex");
        }
      }
      const byteLength = meshlet.vertexCount * GPU_FRAME_ATTRIBUTE_STRIDE;
      const values = new Float32Array(decode ? byteLength / 4 : 0);
      for (let vertex = 0; decode && vertex < meshlet.vertexCount; vertex++) {
        const at = offset + meshlet.vertexByteOffset + vertex * stride;
        const target = (vertex * GPU_FRAME_ATTRIBUTE_STRIDE) / 4;
        values.set((mask & 2) !== 0 ? octNormal(page, at + normal) : [0, 0, 1], target);
        values.set((mask & 4) !== 0 ? octNormal(page, at + tangent) : [1, 0, 0], target + 4);
        values[target + 7] = (mask & 4) !== 0 && page.getUint16(at + tangent + 4, true) >= 32768 ? -1 : 1;
        if ((mask & 8) !== 0) values.set(halfUv(page, at + uv0), target + 8);
        if ((mask & 16) !== 0) values.set(halfUv(page, at + uv1), target + 10);
        values.set(
          (mask & 32) !== 0
            ? [
                page.getUint8(at + color) / 255,
                page.getUint8(at + color + 1) / 255,
                page.getUint8(at + color + 2) / 255,
                1,
              ]
            : [1, 1, 1, 1],
          target + 12,
        );
        values.set(
          [
            page.getFloat32(at + position, true),
            page.getFloat32(at + position + 4, true),
            page.getFloat32(at + position + 8, true),
            1,
          ],
          target + 20,
        );
      }
      if (values.some((value) => !Number.isFinite(value)))
        throw new RangeError("Product resident attributes contain nonfinite values");
      meshlets.push(Object.freeze({ groupOffset: offset, localMeshlet: local, values, byteLength }));
    }
  }
  for (const group of groups) group.descriptorBase += mapWords;
  if (!groups.length) throw new RangeError("Product resident page has no groups");
  if ((mapWords + descriptorWords) * 4 > OEGPACK_V3_PAGE_BYTES)
    throw new RangeError("Product resident directory exceeds one slot");
  let slotCount = 2,
    cursor = Math.ceil((mapWords + descriptorWords) / 4) * 16;
  let uploadBytes = OEGPACK_V3_PAGE_BYTES + (mapWords + descriptorWords) * 4;
  for (const meshlet of meshlets) {
    if (cursor + meshlet.byteLength > OEGPACK_V3_PAGE_BYTES) {
      slotCount++;
      cursor = 0;
    }
    cursor += meshlet.byteLength;
    uploadBytes += meshlet.byteLength;
  }
  return Object.freeze({
    directoryWords: mapWords + descriptorWords,
    groups: Object.freeze(groups),
    meshlets: Object.freeze(meshlets),
    slotCount,
    uploadBytes,
  });
}

function halfUv(page: DataView, at: number): readonly number[] {
  return [decodeFloat16(page.getUint16(at, true)), decodeFloat16(page.getUint16(at + 2, true))];
}
function octNormal(page: DataView, at: number): readonly number[] {
  const x = Math.max(-1, page.getInt16(at, true) / 32767),
    y = Math.max(-1, page.getInt16(at + 2, true) / 32767);
  let nx = x,
    ny = y;
  const nz = 1 - Math.abs(x) - Math.abs(y);
  if (nz < 0) {
    nx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    ny = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
  }
  const inverse = 1 / Math.hypot(nx, ny, nz);
  return [nx * inverse, ny * inverse, nz * inverse];
}
