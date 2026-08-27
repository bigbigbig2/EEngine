/** Temporary adapter between the legacy Geometry model and Cooker input. */

import {
  createSourceGeometry,
  type SourceGeometry,
  type SourceMaterialRange,
  type SourceNumericArray
} from "../assets/SourceGeometry.js";
import { Attribute } from "./Attribute.js";
import { Geometry, GeometryFlag } from "./Geometry.js";

export interface GeometryToSourceOptions {
  readonly sourceId: string;
  readonly materialRanges?: readonly SourceMaterialRange[];
}

export function geometryToSourceGeometry(
  geometry: Geometry,
  options: GeometryToSourceOptions
): SourceGeometry {
  const vertexCount = geometry.getVertexCount();
  const indices = geometry.index?.data ?? sequentialIndices(vertexCount);
  return createSourceGeometry({
    sourceId: options.sourceId,
    indices,
    attributes: geometry.attributes.map((attribute) => ({
      semantic: attribute.spec.name,
      componentCount: attribute.spec.itemSize,
      normalized: attribute.spec.normalized,
      data: attribute.data as SourceNumericArray
    })),
    materialRanges: options.materialRanges
  });
}

export function sourceGeometryToGeometry(source: SourceGeometry): Geometry {
  const geometry = new Geometry();
  geometry.name = source.sourceId;
  geometry.index = Attribute.from(new Uint32Array(source.indices), 1, "index");
  for (const stream of source.attributes.values()) {
    const attribute = Attribute.from(
      cloneNumericArray(stream.data),
      stream.componentCount,
      stream.semantic
    );
    attribute.spec.normalized = stream.normalized;
    geometry.addAttribute(attribute);
  }
  geometry.bounding_box.set(source.bounds.box);
  geometry.bounding_sphere.set(source.bounds.sphere);
  geometry.clearFlag(GeometryFlag.BoundsDirty);
  return geometry;
}

function sequentialIndices(vertexCount: number): Uint32Array {
  const indices = new Uint32Array(vertexCount);
  for (let index = 0; index < vertexCount; index++) indices[index] = index;
  return indices;
}

function cloneNumericArray<T extends SourceNumericArray>(source: T): T {
  const Constructor = source.constructor as new (values: ArrayLike<number>) => T;
  return new Constructor(source);
}
