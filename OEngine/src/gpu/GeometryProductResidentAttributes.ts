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
  readonly directoryByteOffset: number;
  readonly rawPayloadBytes: number;
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
  validatedPlan?: ProductResidentPage,
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
  const skipStructuralValidation = validatedPlan !== undefined;
  const groups: { offset: number; descriptorBase: number; meshletCount: number }[] = [];
  const meshlets: ProductResidentMeshlet[] = [];
  let mapWords = 0,
    descriptorWords = 0,
    rawPayloadBytes = 0;
  const pageRecord = decodeGeometryProductPageRecordV1(descriptor, pageId);
  const workload = skipStructuralValidation ? undefined : geometryProductWorkload(descriptor);
  for (let group = pageRecord.firstGroup; group < pageRecord.firstGroup + pageRecord.groupCount; group++) {
    const offset = directory.getUint32(group * 16 + 4, true);
    const payload = directory.getUint32(group * 16 + 8, true);
    rawPayloadBytes = Math.max(rawPayloadBytes, offset + payload);
    const header = decodeGroupHeaderV3(page, offset);
    if (!skipStructuralValidation) {
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
      if (header.meshletCount !== workload!.groupMeshletCounts[group]) {
        throw new RangeError("Product page meshlet count disagrees with its hierarchy work bound");
      }
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
    if (!skipStructuralValidation) {
      const checkField = (field: number, size: number, active: boolean): void => {
        if (active && (field === 255 || field + size > stride))
          throw new RangeError("Product resident vertex field exceeds its stride");
      };
      checkField(position, 12, true);
      checkField(normal, 4, hasNormal);
      checkField(tangent, 6, hasTangent);
      checkField(uv0, 4, hasUv0);
      checkField(uv1, 4, hasUv1);
      checkField(color, 3, hasColor);
    }
    groups.push({ offset, descriptorBase: descriptorWords, meshletCount: header.meshletCount });
    mapWords = Math.max(mapWords, offset / 16 + 1);
    descriptorWords += header.meshletCount;
    for (let local = 0; local < header.meshletCount; local++) {
      const meshlet = decodeMeshletHeaderV3(
        page,
        offset + header.meshletHeaderOffset + local * OEGPACK_V3_MESHLET_HEADER_BYTES,
      );
      if (!skipStructuralValidation) {
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
        const triStart = offset + meshlet.triangleByteOffset;
        const triEnd = triStart + meshlet.triangleCount * 3;
        const vCount = meshlet.vertexCount;
        for (let corner = triStart; corner < triEnd; corner++) {
          if (page.getUint8(corner) >= vCount) {
            throw new RangeError("Product triangle references a missing resident vertex");
          }
        }
      }
      const byteLength = meshlet.vertexCount * GPU_FRAME_ATTRIBUTE_STRIDE;
      const values = new Float32Array(decode ? byteLength / 4 : 0);
      if (decode) {
        const vertexBase = offset + meshlet.vertexByteOffset;
        for (let vertex = 0; vertex < meshlet.vertexCount; vertex++) {
          const at = vertexBase + vertex * stride;
          const target = vertex * (GPU_FRAME_ATTRIBUTE_STRIDE / 4);
          if (hasNormal) {
            writeOctNormal(page, at + normal, values, target);
          } else {
            values[target] = 0;
            values[target + 1] = 0;
            values[target + 2] = 1;
          }
          if (hasTangent) {
            writeOctNormal(page, at + tangent, values, target + 4);
            values[target + 7] = page.getUint16(at + tangent + 4, true) >= 32768 ? -1 : 1;
          } else {
            values[target + 4] = 1;
            values[target + 5] = 0;
            values[target + 6] = 0;
            values[target + 7] = 1;
          }
          if (hasUv0) {
            values[target + 8] = decodeFloat16(page.getUint16(at + uv0, true));
            values[target + 9] = decodeFloat16(page.getUint16(at + uv0 + 2, true));
          }
          if (hasUv1) {
            values[target + 10] = decodeFloat16(page.getUint16(at + uv1, true));
            values[target + 11] = decodeFloat16(page.getUint16(at + uv1 + 2, true));
          }
          if (hasColor) {
            const cAt = at + color;
            values[target + 12] = page.getUint8(cAt) * (1 / 255);
            values[target + 13] = page.getUint8(cAt + 1) * (1 / 255);
            values[target + 14] = page.getUint8(cAt + 2) * (1 / 255);
            values[target + 15] = 1;
          } else {
            values[target + 12] = 1;
            values[target + 13] = 1;
            values[target + 14] = 1;
            values[target + 15] = 1;
          }
          const pAt = at + position;
          const px = page.getFloat32(pAt, true);
          const py = page.getFloat32(pAt + 4, true);
          const pz = page.getFloat32(pAt + 8, true);
          values[target + 20] = px;
          values[target + 21] = py;
          values[target + 22] = pz;
          values[target + 23] = 1;
        }
        for (let i = 0; i < values.length; i++) {
          if (!Number.isFinite(values[i]!)) {
            throw new RangeError("Product resident attributes contain nonfinite values");
          }
        }
      }
      meshlets.push(Object.freeze({ groupOffset: offset, localMeshlet: local, values, byteLength }));
    }
  }
  for (const group of groups) group.descriptorBase += mapWords;
  if (!groups.length) throw new RangeError("Product resident page has no groups");
  if ((mapWords + descriptorWords) * 4 > OEGPACK_V3_PAGE_BYTES)
    throw new RangeError("Product resident directory exceeds one slot");
  const directoryBytes = (mapWords + descriptorWords) * 4;
  rawPayloadBytes = Math.ceil(rawPayloadBytes / 4) * 4;
  const tailOffset = Math.ceil(rawPayloadBytes / 16) * 16;
  const useRawTail = tailOffset + Math.ceil(directoryBytes / 16) * 16 <= OEGPACK_V3_PAGE_BYTES;
  const directoryByteOffset = useRawTail ? tailOffset : 0;
  let slotCount = useRawTail ? 1 : 2,
    cursor = directoryByteOffset + Math.ceil(directoryBytes / 16) * 16;
  let uploadBytes = rawPayloadBytes + directoryBytes;
  for (const meshlet of meshlets) {
    if (cursor + meshlet.byteLength > OEGPACK_V3_PAGE_BYTES) {
      slotCount++;
      cursor = 0;
    }
    cursor += meshlet.byteLength;
    uploadBytes += meshlet.byteLength;
  }
  return Object.freeze({
    directoryByteOffset,
    rawPayloadBytes,
    directoryWords: mapWords + descriptorWords,
    groups: Object.freeze(groups),
    meshlets: Object.freeze(meshlets),
    slotCount,
    uploadBytes,
  });
}

function writeOctNormal(page: DataView, at: number, out: Float32Array, target: number): void {
  const x = Math.max(-1, page.getInt16(at, true) * (1 / 32767)),
    y = Math.max(-1, page.getInt16(at + 2, true) * (1 / 32767));
  let nx = x,
    ny = y;
  const nz = 1 - Math.abs(x) - Math.abs(y);
  if (nz < 0) {
    nx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    ny = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
  }
  const inverse = 1 / Math.hypot(nx, ny, nz);
  out[target] = nx * inverse;
  out[target + 1] = ny * inverse;
  out[target + 2] = nz * inverse;
}
