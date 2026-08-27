/**
 * Device-independent, owned triangle geometry used as the only Cooker input.
 * Construction copies every typed array so later source-buffer mutation cannot
 * change package identity or validation results.
 */

export const SOURCE_DEFAULT_MATERIAL_ID = 0xffffffff;

export type SourceAlphaMode = "opaque" | "mask" | "blend";

export type SourceNumericArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

export type SourceVertexDataType =
  | "int8"
  | "uint8"
  | "int16"
  | "uint16"
  | "int32"
  | "uint32"
  | "float32"
  | "float64";

export interface SourceVertexStreamInput {
  readonly semantic: string;
  readonly componentCount: number;
  readonly normalized?: boolean;
  readonly data: SourceNumericArray;
}

export interface SourceVertexStream {
  readonly semantic: string;
  readonly componentCount: number;
  readonly normalized: boolean;
  readonly dataType: SourceVertexDataType;
  readonly data: SourceNumericArray;
  readonly vertexCount: number;
}

export interface SourceMaterialRange {
  readonly firstTriangle: number;
  readonly triangleCount: number;
  readonly materialId: number;
  readonly alphaMode: SourceAlphaMode;
  readonly doubleSided: boolean;
}

export interface SourceGeometryBounds {
  readonly box: Float32Array;
  readonly sphere: Float32Array;
}

export interface SourceGeometryInput {
  readonly sourceId: string;
  readonly indices: ArrayLike<number>;
  readonly attributes: readonly SourceVertexStreamInput[];
  readonly materialRanges?: readonly SourceMaterialRange[];
}

export interface SourceGeometry {
  readonly topology: "triangle-list";
  readonly sourceId: string;
  readonly indices: Uint32Array;
  readonly attributes: ReadonlyMap<string, SourceVertexStream>;
  readonly materialRanges: readonly SourceMaterialRange[];
  readonly bounds: SourceGeometryBounds;
  readonly vertexCount: number;
  readonly triangleCount: number;
}

export function createSourceGeometry(
  input: SourceGeometryInput
): SourceGeometry {
  const sourceId = input.sourceId.trim();
  if (sourceId.length === 0) {
    throw new RangeError("SourceGeometry sourceId must not be empty");
  }
  if (input.attributes.length === 0) {
    throw new RangeError("SourceGeometry requires a position attribute");
  }

  const attributes = new Map<string, SourceVertexStream>();
  let vertexCount = -1;
  for (let index = 0; index < input.attributes.length; index++) {
    const source = input.attributes[index]!;
    const semantic = source.semantic.trim();
    if (semantic.length === 0) {
      throw new RangeError(`attributes[${index}].semantic must not be empty`);
    }
    if (attributes.has(semantic)) {
      throw new RangeError(`Duplicate SourceGeometry attribute '${semantic}'`);
    }
    if (
      !Number.isInteger(source.componentCount) ||
      source.componentCount < 1 ||
      source.componentCount > 16
    ) {
      throw new RangeError(
        `SourceGeometry attribute '${semantic}' componentCount must be an integer in [1, 16]`
      );
    }
    if (source.data.length % source.componentCount !== 0) {
      throw new RangeError(
        `SourceGeometry attribute '${semantic}' data length must be divisible by componentCount`
      );
    }
    for (let component = 0; component < source.data.length; component++) {
      if (!Number.isFinite(source.data[component])) {
        throw new RangeError(
          `SourceGeometry attribute '${semantic}' values must be finite`
        );
      }
    }
    const count = source.data.length / source.componentCount;
    if (vertexCount < 0) vertexCount = count;
    if (count !== vertexCount) {
      throw new RangeError(
        `SourceGeometry attribute '${semantic}' vertex count ${count} does not match ${vertexCount}`
      );
    }
    const data = cloneNumericArray(source.data);
    attributes.set(semantic, Object.freeze({
      semantic,
      componentCount: source.componentCount,
      normalized: source.normalized === true,
      dataType: dataTypeOf(data),
      data,
      vertexCount: count
    }));
  }

  const position = attributes.get("position");
  if (position === undefined || position.componentCount !== 3) {
    throw new RangeError(
      "SourceGeometry requires a position attribute with componentCount 3"
    );
  }
  if (vertexCount < 3) {
    throw new RangeError("SourceGeometry requires at least three vertices");
  }
  if (input.indices.length === 0 || input.indices.length % 3 !== 0) {
    throw new RangeError(
      "SourceGeometry indices must contain a non-empty triangle list"
    );
  }

  const indices = new Uint32Array(input.indices.length);
  for (let index = 0; index < input.indices.length; index++) {
    const value = input.indices[index]!;
    if (!Number.isInteger(value) || value < 0 || value >= vertexCount) {
      throw new RangeError(
        `SourceGeometry indices[${index}] ${value} is outside vertex count ${vertexCount}`
      );
    }
    indices[index] = value;
  }

  const triangleCount = indices.length / 3;
  const materialRanges = validateMaterialRanges(
    input.materialRanges,
    triangleCount
  );
  const bounds = calculateBounds(position.data);
  return Object.freeze({
    topology: "triangle-list" as const,
    sourceId,
    indices,
    attributes,
    materialRanges,
    bounds,
    vertexCount,
    triangleCount
  });
}

function validateMaterialRanges(
  ranges: readonly SourceMaterialRange[] | undefined,
  triangleCount: number
): readonly SourceMaterialRange[] {
  if (ranges === undefined) {
    return Object.freeze([Object.freeze({
      firstTriangle: 0,
      triangleCount,
      materialId: SOURCE_DEFAULT_MATERIAL_ID,
      alphaMode: "opaque" as const,
      doubleSided: false
    })]);
  }
  let cursor = 0;
  const output = new Array<SourceMaterialRange>(ranges.length);
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index]!;
    if (
      !Number.isInteger(range.firstTriangle) ||
      !Number.isInteger(range.triangleCount) ||
      range.firstTriangle !== cursor ||
      range.triangleCount <= 0 ||
      range.firstTriangle + range.triangleCount > triangleCount
    ) {
      throw new RangeError(
        "SourceGeometry materialRanges must cover every triangle exactly once in source order"
      );
    }
    if (
      !Number.isInteger(range.materialId) ||
      range.materialId < 0 ||
      range.materialId > 0xffffffff
    ) {
      throw new RangeError(
        `SourceGeometry materialRanges[${index}].materialId must be a u32`
      );
    }
    if (
      range.alphaMode !== "opaque" &&
      range.alphaMode !== "mask" &&
      range.alphaMode !== "blend"
    ) {
      throw new RangeError(
        `SourceGeometry materialRanges[${index}].alphaMode is invalid`
      );
    }
    output[index] = Object.freeze({
      firstTriangle: range.firstTriangle,
      triangleCount: range.triangleCount,
      materialId: range.materialId >>> 0,
      alphaMode: range.alphaMode,
      doubleSided: range.doubleSided === true
    });
    cursor += range.triangleCount;
  }
  if (cursor !== triangleCount) {
    throw new RangeError(
      "SourceGeometry materialRanges must cover every triangle exactly once"
    );
  }
  return Object.freeze(output);
}

function calculateBounds(positions: SourceNumericArray): SourceGeometryBounds {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let offset = 0; offset < positions.length; offset += 3) {
    const x = positions[offset]!;
    const y = positions[offset + 1]!;
    const z = positions[offset + 2]!;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  const centerX = 0.5 * (minX + maxX);
  const centerY = 0.5 * (minY + maxY);
  const centerZ = 0.5 * (minZ + maxZ);
  const radius = 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  return Object.freeze({
    box: new Float32Array([minX, minY, minZ, maxX, maxY, maxZ]),
    sphere: new Float32Array([centerX, centerY, centerZ, radius])
  });
}

function cloneNumericArray<T extends SourceNumericArray>(source: T): T {
  const Constructor = source.constructor as new (values: ArrayLike<number>) => T;
  return new Constructor(source);
}

function dataTypeOf(data: SourceNumericArray): SourceVertexDataType {
  if (data instanceof Int8Array) return "int8";
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
    return "uint8";
  }
  if (data instanceof Int16Array) return "int16";
  if (data instanceof Uint16Array) return "uint16";
  if (data instanceof Int32Array) return "int32";
  if (data instanceof Uint32Array) return "uint32";
  if (data instanceof Float32Array) return "float32";
  return "float64";
}
