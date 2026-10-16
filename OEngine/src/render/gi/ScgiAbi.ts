import { decodeFloat16, encodeFloat16 } from "../../core/Float16.js";

type Scalar = "u32" | "f32";
interface Field {
  readonly name: string;
  readonly type: Scalar;
  readonly count: number;
  readonly offset: number;
}
type FieldInput = readonly [name: string, type: Scalar, count: number];

function layout(name: string, inputs: readonly FieldInput[]) {
  let stride = 0;
  const fields: Field[] = [];
  for (const [field, type, count] of inputs) {
    fields.push(Object.freeze({ name: field, type, count, offset: stride }));
    stride += count * 4;
  }
  return Object.freeze({ name, stride, fields: Object.freeze(fields) });
}

export const SCGI_CELL_EMPTY = 0xffffffff;
export const SCGI_CELL_CLAIM = 0xfffffffe;
export const SCGI_MAX_CASCADES = 4;

/** Scalar-packed storage ABI. In particular RGB L1 is 12 f32, never vec3[].
 * All arena record bases are 16B aligned except the explicit 8B cell/link arrays. */
export const SCGI_ABI = Object.freeze({
  identity: layout("ScgiIdentity", [
    ["instanceSetId", "u32", 1],
    ["setGeneration", "u32", 1],
    ["localInstanceSlot", "u32", 1],
    ["slotGeneration", "u32", 1],
    ["productTableSlot", "u32", 1],
    ["productGeneration", "u32", 1],
    ["assetRecordIndex", "u32", 1],
    ["geometryGeneration", "u32", 1],
    ["stablePrimitiveId", "u32", 1],
    ["materialHandle", "u32", 1],
    ["materialValueRevision", "u32", 1],
    ["deformationRevision", "u32", 1],
  ]),
  cell: layout("ScgiCell", [
    ["patchIndex", "u32", 1],
    ["patchSlotGeneration", "u32", 1],
  ]),
  cacheState: layout("ScgiCacheState", [
    ["demotionFrame", "u32", 1],
    ["dirty", "u32", 1],
    ["selectionFrame", "u32", 1],
    ["live", "u32", 1],
  ]),
  patch: layout("ScgiPatch", [
    ["positionRadius", "f32", 4],
    ["normalPlaneError", "f32", 4],
    ["identity", "u32", 12],
    ["cellCascadeOrientationGeneration", "u32", 4],
    ["countSerialFlags", "u32", 4],
    ["accessUpdateBirthDirty", "u32", 4],
    ["shortMeanConfidence", "f32", 4],
    ["varianceSeedConfidence", "f32", 4],
    ["a0", "f32", 12],
    ["a2", "f32", 12],
    ["numericEpochs", "u32", 4],
    ["rankPostCohortStatus", "u32", 4],
  ]),
  request: layout("ScgiRequest", [
    ["positionRadius", "f32", 4],
    ["normal", "f32", 3],
    ["source", "u32", 1],
    ["identity", "u32", 12],
    ["cellRankPixelStatus", "u32", 4],
  ]),
  halfField: layout("ScgiHalfField", [
    ["packedCoefficients", "u32", 8],
    ["depth", "f32", 1],
    ["octNormal", "u32", 1],
    ["sourcePixel", "u32", 1],
    ["confidenceFlags", "u32", 1],
    ["identity", "u32", 12],
  ]),
  raw: layout("ScgiRaw", [
    ["coefficients", "f32", 12],
    ["cohortPlanCompletionFault", "u32", 4],
  ]),
  node: layout("ScgiNode", [
    ["leftMin", "f32", 3],
    ["leftRef", "u32", 1],
    ["leftMax", "f32", 3],
    ["leftFlags", "u32", 1],
    ["rightMin", "f32", 3],
    ["rightRef", "u32", 1],
    ["rightMax", "f32", 3],
    ["rightFlags", "u32", 1],
  ]),
  links: layout("ScgiLinks", [
    ["parent", "u32", 1],
    ["escape", "u32", 1],
  ]),
  triangle: layout("ScgiTriangle", [["pageGroupTriangleMaterial", "u32", 4]]),
  directory: layout("ScgiDirectory", [
    ["shardRootCountRef", "u32", 4],
    ["leaseGeometryTopologyFlags", "u32", 4],
  ]),
  instance: layout("ScgiInstance", [
    ["objectToWorld", "f32", 12],
    ["worldToObject", "f32", 12],
    ["slotSetLifetimeRoot", "u32", 4],
    ["shardGenerationMaskFlags", "u32", 4],
  ]),
  ray: layout("ScgiRay", [
    ["originTMin", "f32", 4],
    ["directionTMax", "f32", 4],
    ["idMaskKindSnapshot", "u32", 4],
  ]),
  result: layout("ScgiResult", [
    ["tBarycentric", "f32", 3],
    ["status", "u32", 1],
    ["instancePrimitiveGenerationFront", "u32", 4],
  ]),
  payload: layout("ScgiPayload", [
    ["patchGenerationCohortSample", "u32", 4],
    ["pdfPathLightFlags", "u32", 4],
  ]),
  continuation: layout("ScgiContinuation", [
    ["shardTlasReturnInstance", "u32", 4],
    ["blasReturnPhaseVisit", "u32", 4],
    ["bestT", "f32", 1],
    ["bestInstancePrimitiveStatus", "u32", 3],
    ["candidateRef", "u32", 1],
    ["candidateT", "f32", 1],
    ["binStackCursor", "u32", 2],
  ]),
  worldHeader: layout("ScgiWorldHeader", [
    ["generationDeviceSceneView", "u32", 4],
    ["numericEpochs", "u32", 4],
    ["originScale", "f32", 4],
    ["capacityValidity", "u32", 4],
    ["allocatorStartEndCountSerial", "u32", 4],
    ["bounceCountOverflowStatus", "u32", 4],
    ["cascadeOriginScale", "f32", 16],
    ["cascadeOffsetsRing", "u32", 16],
    ["addressGenerationSampleSerial", "u32", 4],
    ["reserved", "u32", 4],
  ]),
});

export type ScgiRecordKind = keyof typeof SCGI_ABI;
export type ScgiRecordValues = Readonly<Record<string, number | ArrayLike<number>>>;

export function packScgiRecord(kind: ScgiRecordKind, values: ScgiRecordValues): Uint8Array<ArrayBuffer> {
  const definition = SCGI_ABI[kind];
  const bytes = new Uint8Array(definition.stride);
  const view = new DataView(bytes.buffer);
  for (const field of definition.fields) {
    const input = values[field.name];
    if (input === undefined || (typeof input !== "number" && input.length !== field.count)) {
      throw new RangeError(`SCGI ${kind}.${field.name} requires ${field.count} lanes`);
    }
    if (typeof input === "number" && field.count !== 1) {
      throw new RangeError(`SCGI ${kind}.${field.name} requires an array`);
    }
    for (let lane = 0; lane < field.count; lane++) {
      const value = typeof input === "number" ? input : input[lane]!;
      const offset = field.offset + lane * 4;
      if (field.type === "u32") {
        if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
          throw new RangeError(`SCGI ${kind}.${field.name} is not u32`);
        }
        view.setUint32(offset, value, true);
      } else {
        if (!Number.isFinite(Math.fround(value))) {
          throw new RangeError(`SCGI ${kind}.${field.name} is not finite f32`);
        }
        view.setFloat32(offset, value, true);
      }
    }
  }
  return bytes;
}

export function unpackScgiRecord(kind: ScgiRecordKind, bytes: Uint8Array): Record<string, number[]> {
  if (bytes.byteLength !== SCGI_ABI[kind].stride) {
    throw new RangeError("SCGI record size mismatch");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: Record<string, number[]> = {};
  for (const field of SCGI_ABI[kind].fields) {
    const lanes: number[] = [];
    for (let lane = 0; lane < field.count; lane++) {
      const offset = field.offset + lane * 4;
      lanes.push(field.type === "u32" ? view.getUint32(offset, true) : view.getFloat32(offset, true));
    }
    result[field.name] = lanes;
  }
  return result;
}

/** Half storage uses pack2x16float, independent of optional shader-f16 arithmetic. */
export function packScgiCoefficients(
  coefficients: ArrayLike<number>,
  scale: number,
): Uint32Array<ArrayBuffer> {
  if (coefficients.length !== 12 || !Number.isFinite(scale) || scale <= 0) {
    throw new RangeError("SCGI requires 12 coefficients and positive finite scale");
  }
  const packed = new Uint32Array(8);
  for (let coefficient = 0; coefficient < 4; coefficient++) {
    for (let channel = 0; channel < 3; channel++) {
      const value = coefficients[coefficient * 3 + channel]! / scale;
      if (!Number.isFinite(value) || Math.abs(value) > 65504) {
        throw new RangeError("SCGI coefficient exceeds the published half scale");
      }
      const lane = coefficient * 4 + channel;
      packed[lane >>> 1] = (packed[lane >>> 1]! | (encodeFloat16(value) << ((lane & 1) * 16))) >>> 0;
    }
  }
  return packed;
}

export function unpackScgiCoefficients(packed: ArrayLike<number>, scale: number): Float32Array<ArrayBuffer> {
  if (packed.length !== 8 || !Number.isFinite(scale) || scale <= 0) {
    throw new RangeError("SCGI half coefficient header mismatch");
  }
  const result = new Float32Array(12);
  for (let coefficient = 0; coefficient < 4; coefficient++) {
    for (let channel = 0; channel < 3; channel++) {
      const lane = coefficient * 4 + channel;
      result[coefficient * 3 + channel] =
        decodeFloat16((packed[lane >>> 1]! >>> ((lane & 1) * 16)) & 65535) * scale;
    }
  }
  return result;
}

/** Typed storage loads/stores have exactly the same scalar layout as packed arenas.
 * WGSL layout is also checked against independent literal offsets by the GPU oracle. */
export const SCGI_ABI_WGSL =
  Object.values(SCGI_ABI)
    .map((definition) => {
      const fields = definition.fields
        .map((field) => {
          const type = field.count === 1 ? field.type : `array<${field.type}, ${field.count}>`;
          return `  ${field.name}: ${type},`;
        })
        .join("\n");
      return `struct ${definition.name} {\n${fields}\n}`;
    })
    .join("\n\n") +
  /* wgsl */ `

fn scgi_unpack_l1(packed: array<u32, 8>, scale: f32) -> array<f32, 12> {
  var result: array<f32, 12>;
  for (var coefficient = 0u; coefficient < 4u; coefficient++) {
    let xy = unpack2x16float(packed[coefficient * 2u]);
    let zw = unpack2x16float(packed[coefficient * 2u + 1u]);
    result[coefficient * 3u] = xy.x * scale;
    result[coefficient * 3u + 1u] = xy.y * scale;
    result[coefficient * 3u + 2u] = zw.x * scale;
  }
  return result;
}
`;
