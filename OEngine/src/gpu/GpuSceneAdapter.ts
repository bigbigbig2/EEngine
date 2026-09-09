import type { GeometryAssetPackage } from "../assets/GeometryAssetPackage.js";
import type { ShadeMaterial } from "../material/ShadeMaterial.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import type { Mesh } from "../scene/Mesh.js";
import type { Scene } from "../scene/Scene.js";
import type { MeshletGeometryBase } from "../geometry/BoxGeometry.js";
import type { AssetHandle } from "./GpuAssetStore.js";
import type { InstanceSource } from "./GpuScene.js";
import type { PackedSceneSource } from "./GpuRenderWorld.js";

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

/** Explicit CPU geometry-to-package binding used by the ordinary Scene adapter. */
export interface SceneGeometryAssetBinding {
  readonly geometry: MeshletGeometryBase;
  readonly asset: GeometryAssetPackage;
}

export interface AdaptedSceneSource {
  readonly source: PackedSceneSource;
  /** Stable initial instance order used to translate SceneChangeSet nodes to indices. */
  readonly meshes: readonly Mesh[];
}

/**
 * Converts an ordinary Application Scene into the same device-independent
 * source accepted by the authoritative GPU Render World. This function owns
 * no GPU object and never invokes the cooker: callers must supply validated,
 * already-cooked packages explicitly.
 */
export function createPackedSceneSourceFromScene(
  scene: Scene,
  geometryAssets: readonly SceneGeometryAssetBinding[]
): AdaptedSceneSource {
  scene.updateMatrices();
  const meshes = scene.instances.instances.slice();
  if (meshes.length === 0) {
    throw new RangeError("Cannot register an empty ordinary Scene in the GPU Render World");
  }

  const packageByGeometry = new Map<MeshletGeometryBase, GeometryAssetPackage>();
  for (const binding of geometryAssets) {
    const previous = packageByGeometry.get(binding.geometry);
    if (previous !== undefined && previous !== binding.asset) {
      throw new Error("Scene geometry has more than one cooked GeometryAssetPackage binding");
    }
    packageByGeometry.set(binding.geometry, binding.asset);
  }

  const geometries: GeometryAssetPackage[] = [];
  const geometryIndexByGeometry = new Map<MeshletGeometryBase, number>();
  const materials: StandardShadeMaterial[] = [];
  const materialIndexByMaterial = new Map<StandardShadeMaterial, number>();
  const geometryIndices = new Uint32Array(meshes.length);
  const materialIndices = new Uint32Array(meshes.length);
  const currentTransforms = new Float32Array(meshes.length * 16);
  const boundsSpheres = new Float32Array(meshes.length * 4);
  const boundsMin = new Float32Array(meshes.length * 3);
  const boundsMax = new Float32Array(meshes.length * 3);
  const debugIds = new Uint32Array(meshes.length);

  for (let index = 0; index < meshes.length; index++) {
    const mesh = meshes[index]!;
    if ((mesh as Mesh & { readonly isSkinnedMesh?: boolean }).isSkinnedMesh === true) {
      throw new Error(
        "Ordinary Scene SkinnedMesh is unsupported by the current GPU Render World product scope"
      );
    }
    const asset = packageByGeometry.get(mesh.geometry);
    if (asset === undefined) {
      throw new Error(
        `Ordinary Scene mesh ${mesh.id} has no cooked GeometryAssetPackage binding`
      );
    }
    let geometryIndex = geometryIndexByGeometry.get(mesh.geometry);
    if (geometryIndex === undefined) {
      geometryIndex = geometries.length;
      geometries.push(asset);
      geometryIndexByGeometry.set(mesh.geometry, geometryIndex);
    }
    const material = requireStandardMaterial(mesh.material, mesh);
    let materialIndex = materialIndexByMaterial.get(material);
    if (materialIndex === undefined) {
      materialIndex = materials.length;
      materials.push(material);
      materialIndexByMaterial.set(material, materialIndex);
    }
    geometryIndices[index] = geometryIndex;
    materialIndices[index] = materialIndex;
    currentTransforms.set(mesh.transform_global.matrix, index * 16);
    // Culling bounds follow the cooked package that owns the GPU geometry,
    // not a mutable loader/runtime geometry object.
    boundsSpheres.set(asset.directory.boundsSphere, index * 4);
    boundsMin.set(asset.directory.boundsBox.subarray(0, 3), index * 3);
    boundsMax.set(asset.directory.boundsBox.subarray(3, 6), index * 3);
    debugIds[index] = mesh.id >>> 0;
  }

  return Object.freeze({
    meshes: Object.freeze(meshes),
    source: Object.freeze({
      geometries: Object.freeze(geometries),
      materials: Object.freeze(materials),
      count: meshes.length,
      geometryIndices,
      materialIndices,
      currentTransforms,
      previousTransforms: currentTransforms.slice(),
      boundsSpheres,
      boundsMin,
      boundsMax,
      flags: new Uint32Array(meshes.length),
      debugIds
    })
  });
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

function requireStandardMaterial(
  material: ShadeMaterial,
  mesh: Mesh
): StandardShadeMaterial {
  if ((material as StandardShadeMaterial).isStandardShadeMaterial !== true) {
    throw new Error(
      `Ordinary Scene mesh ${mesh.id} uses an unsupported non-standard material`
    );
  }
  return material as StandardShadeMaterial;
}
