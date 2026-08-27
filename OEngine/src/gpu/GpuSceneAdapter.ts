import type { ShadeMaterial } from "../material/ShadeMaterial.js";
import type { Mesh } from "../scene/Mesh.js";
import type { Scene } from "../scene/Scene.js";
import type { MeshletGeometryBase } from "../geometry/BoxGeometry.js";
import type { AssetHandle } from "./GpuAssetStore.js";
import type { InstanceSource } from "./GpuScene.js";

export interface SceneInstanceAdapterOptions {
  readonly geometryHandle: (
    geometry: MeshletGeometryBase,
    mesh: Mesh
  ) => AssetHandle;
  readonly materialHandle?: (
    material: ShadeMaterial,
    mesh: Mesh
  ) => number;
}

/**
 * Converts the ordinary object Scene once into the same structure-of-arrays
 * source consumed by the Packed path. It does not create replacement Mesh or
 * Node3D objects and does not own residency.
 */
export function createInstanceSourceFromScene(
  scene: Scene,
  options: SceneInstanceAdapterOptions
): InstanceSource {
  scene.updateMatrices();
  const meshes = scene.instances.instances;
  if (meshes.length === 0) {
    throw new RangeError("Cannot create an InstanceSource from an empty Scene");
  }
  const geometryHandles: AssetHandle[] = [];
  const geometryIndexByHandle = new Map<AssetHandle, number>();
  const geometryIndices = new Uint32Array(meshes.length);
  const materialHandles = new Uint32Array(meshes.length);
  const currentTransforms = new Float32Array(meshes.length * 16);
  const boundsSpheres = new Float32Array(meshes.length * 4);
  const boundsMin = new Float32Array(meshes.length * 3);
  const boundsMax = new Float32Array(meshes.length * 3);
  const debugIds = new Uint32Array(meshes.length);

  for (let index = 0; index < meshes.length; index++) {
    const mesh = meshes[index]!;
    const handle = options.geometryHandle(mesh.geometry, mesh);
    let geometryIndex = geometryIndexByHandle.get(handle);
    if (geometryIndex === undefined) {
      geometryIndex = geometryHandles.length;
      geometryHandles.push(handle);
      geometryIndexByHandle.set(handle, geometryIndex);
    }
    geometryIndices[index] = geometryIndex;
    materialHandles[index] = (
      options.materialHandle?.(mesh.material, mesh) ?? mesh.material.id
    ) >>> 0;
    currentTransforms.set(mesh.transform_global.matrix, index * 16);
    boundsSpheres.set(mesh.geometry.bounding_sphere, index * 4);
    boundsMin.set(mesh.geometry.bounding_box.subarray(0, 3), index * 3);
    boundsMax.set(mesh.geometry.bounding_box.subarray(3, 6), index * 3);
    debugIds[index] = mesh.id >>> 0;
  }

  return Object.freeze({
    count: meshes.length,
    geometryHandles: Object.freeze(geometryHandles.slice()),
    geometryIndices,
    materialHandles,
    currentTransforms,
    boundsSpheres,
    boundsMin,
    boundsMax,
    debugIds
  });
}
