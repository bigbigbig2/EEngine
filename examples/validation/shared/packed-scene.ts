import {
  StandardShadeMaterial,
  buildBoxSourceGeometry,
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  type GeometryAssetPackage,
  type PackedSceneSource
} from "../../../OEngine/src/index.ts";

export interface PackedBox {
  readonly size: readonly [number, number, number];
  readonly position: readonly [number, number, number];
  readonly materialIndex: number;
  readonly debugId: number;
  readonly segments?: readonly [number, number, number];
}

export async function createPackedBoxScene(
  boxes: readonly PackedBox[],
  materials: readonly StandardShadeMaterial[]
): Promise<PackedSceneSource> {
  const recipe = createGeometryCookRecipe();
  const geometries: GeometryAssetPackage[] = [];
  for (const box of boxes) {
    const segments = box.segments ?? [1, 1, 1];
    geometries.push((await cookGeometryAssetPackage(
      buildBoxSourceGeometry(
        box.size[0], box.size[1], box.size[2],
        segments[0], segments[1], segments[2]
      ),
      recipe
    )).asset);
  }
  const transforms = new Float32Array(boxes.length * 16);
  const boundsSpheres = new Float32Array(boxes.length * 4);
  const boundsMin = new Float32Array(boxes.length * 3);
  const boundsMax = new Float32Array(boxes.length * 3);
  boxes.forEach((box, index) => {
    writeTranslation(transforms, index * 16, ...box.position);
    const halfX = box.size[0] / 2;
    const halfY = box.size[1] / 2;
    const halfZ = box.size[2] / 2;
    boundsSpheres.set([
      ...box.position,
      Math.hypot(halfX, halfY, halfZ)
    ], index * 4);
    boundsMin.set([
      box.position[0] - halfX,
      box.position[1] - halfY,
      box.position[2] - halfZ
    ], index * 3);
    boundsMax.set([
      box.position[0] + halfX,
      box.position[1] + halfY,
      box.position[2] + halfZ
    ], index * 3);
  });
  return {
    geometries,
    materials: [...materials],
    count: boxes.length,
    geometryIndices: Uint32Array.from(boxes, (_, index) => index),
    materialIndices: Uint32Array.from(boxes, (box) => box.materialIndex),
    currentTransforms: transforms,
    previousTransforms: transforms.slice(),
    boundsSpheres,
    boundsMin,
    boundsMax,
    flags: new Uint32Array(boxes.length),
    debugIds: Uint32Array.from(boxes, (box) => box.debugId)
  };
}

export function solidMaterial(
  color: readonly [number, number, number, number],
  roughness = 0.7,
  metallic = 0
): StandardShadeMaterial {
  const material = new StandardShadeMaterial();
  material.diffuse_color.set(...color);
  material.roughness_factor = roughness;
  material.metallic_factor = metallic;
  return material;
}

function writeTranslation(
  target: Float32Array,
  offset: number,
  x: number,
  y: number,
  z: number
): void {
  target.fill(0, offset, offset + 16);
  target[offset] = 1;
  target[offset + 5] = 1;
  target[offset + 10] = 1;
  target[offset + 12] = x;
  target[offset + 13] = y;
  target[offset + 14] = z;
  target[offset + 15] = 1;
}
