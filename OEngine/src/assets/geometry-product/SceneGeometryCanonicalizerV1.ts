import type { MeshletGeometryBase } from "../../geometry/BoxGeometry.js";
import type { Mesh } from "../../scene/Mesh.js";
import type { Scene } from "../../scene/Scene.js";
import { ShadeDrawSide, ShadeTransparencyMode } from "../../material/enums.js";
import type { StandardShadeMaterial } from "../../material/StandardShadeMaterial.js";
import type { VirtualGeometryGeometryProfile } from "../../gpu/GpuRenderWorld.js";
import {
  WEB_GEOMETRY_ATTRIBUTE_COLOR,
  WEB_GEOMETRY_ATTRIBUTE_NORMAL,
  WEB_GEOMETRY_ATTRIBUTE_POSITION,
  WEB_GEOMETRY_ATTRIBUTE_TANGENT,
  WEB_GEOMETRY_ATTRIBUTE_UV0,
  WEB_GEOMETRY_ATTRIBUTE_UV1,
  WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS,
  WEB_GEOMETRY_MESHLET_BLEND,
  WEB_GEOMETRY_MESHLET_CASTS_SHADOW,
  WEB_GEOMETRY_MESHLET_MASK,
  WEB_GEOMETRY_MESHLET_OPAQUE,
  WEB_GEOMETRY_MESHLET_TWO_SIDED,
  cookWebGeometryWasmV1,
  encodeWebCanonicalGeometryV1,
  encodeWebGeometryCookRecipeV1,
  type EmscriptenWebGeometryCookerModuleV1,
  type WebCanonicalGeometryDomainV1
} from "../web-cook/wasm/WebGeometryCookerAbi.js";
import { createGeometryCookRecipeV3, type GeometryCookRecipeV3 } from "../GeometryCookRecipe.js";
import type { GeometryProductRevisionSourceV1 } from "./GeometryProductV1.js";
import { decodeGeometryProductDescriptorBinaryV1 } from "./GeometryProductBinaryV1.js";
import { cookWasmGeometryProductRevisionV1, type WasmGeometryProductRevisionV1 } from "./WasmGeometryProductV1.js";
import type { VirtualGeometrySceneInstanceV1 } from "./VirtualGeometrySceneSourceV1.js";

/**
 * Runtime ordinary-Scene producer.
 *
 * It converts the packed meshlet geometry an ordinary `Scene` already holds into
 * the same canonical geometry ABI the GLB route feeds the WASM cooker, so a
 * procedural, deserialized or cooked-in-app Scene reaches the identical
 * Geometry Product, residency and Visibility path instead of the V2
 * GeometryAssetPackage owner. It owns no GPU object, never parses files and
 * never uploads.
 */
export interface SceneGeometryCanonicalizationV1 {
  /** One canonical domain per (geometry, material) pair, in stable Scene order. */
  readonly domains: readonly WebCanonicalGeometryDomainV1[];
  /** Per-domain geometry profile, index-aligned with `domains`. */
  readonly profiles: readonly VirtualGeometryGeometryProfile[];
  /** Material dictionary; `instances[].materialIndex` addresses it. */
  readonly materials: readonly StandardShadeMaterial[];
  /** Instances in stable Scene order, addressing `domains` by asset index. */
  readonly instances: readonly VirtualGeometrySceneInstanceV1[];
  /** `mesh.geometry` per domain, for callers that keep a CPU association. */
  readonly geometries: readonly MeshletGeometryBase[];
  /** Canonical cook input; its SHA-256 is the Product source identity. */
  readonly canonicalInput: ArrayBuffer;
}

export interface SceneGeometryProductOptions {
  readonly module: EmscriptenWebGeometryCookerModuleV1;
  readonly producerId: string;
  readonly producerVersion: string;
  readonly recipe?: Partial<GeometryCookRecipeV3>;
  readonly maxDecodedProductBytes: number;
  readonly revision?: number;
  readonly replaces?: Readonly<{ productId: Uint8Array; revision: number }>;
}

export interface CookedSceneGeometryProductV1 {
  readonly revision: WasmGeometryProductRevisionV1;
  readonly canonicalization: SceneGeometryCanonicalizationV1;
  /** Single-revision provider for `Renderer.uploadProductScene`. */
  readonly provider: GeometryProductRevisionSourceV1 & { revisions(signal?: AbortSignal): AsyncIterable<GeometryProductRevisionSourceV1> };
}

const VERTEX_FLOATS = 6;
const TANGENT_FLOATS = 4;
const COLOR_FLOATS = 3;
const UV_FLOATS = 2;

/**
 * Canonicalizes one ordinary Scene into cookable geometry domains plus the
 * instance records the Product scene source needs.
 *
 * A geometry used with two materials becomes two domains, because the Product
 * asset dictionary is material-domain scoped exactly like the GLB route; that
 * keeps `instance.material_handle` single-valued on the GPU.
 */
export function canonicalizeSceneGeometryV1(scene: Scene): SceneGeometryCanonicalizationV1 {
  scene.updateMatrices();
  const meshes = scene.instances.instances.slice();
  if (meshes.length === 0) throw new RangeError("Runtime Geometry Product requires a non-empty Scene");
  const domains: WebCanonicalGeometryDomainV1[] = [];
  const profiles: VirtualGeometryGeometryProfile[] = [];
  const geometries: MeshletGeometryBase[] = [];
  const materials: StandardShadeMaterial[] = [];
  const instances: VirtualGeometrySceneInstanceV1[] = [];
  const domainByKey = new Map<string, number>();
  const materialIndexByMaterial = new Map<StandardShadeMaterial, number>();

  for (const mesh of meshes) {
    if ((mesh as Mesh & { readonly isSkinnedMesh?: boolean }).isSkinnedMesh === true) {
      throw new Error("Runtime Geometry Product does not support SkinnedMesh yet");
    }
    const geometry = mesh.geometry as MeshletGeometryBase;
    const material = mesh.material as StandardShadeMaterial | undefined;
    if (!material || typeof material !== "object") throw new Error(`Scene mesh ${mesh.id} has no material`);
    if (typeof geometry?.getVertexCount !== "function") throw new Error(`Scene mesh ${mesh.id} is not backed by meshlet-packed geometry`);
    let materialIndex = materialIndexByMaterial.get(material);
    if (materialIndex === undefined) {
      materialIndex = materials.length;
      materials.push(material);
      materialIndexByMaterial.set(material, materialIndex);
    }
    const key = `${materialIndex}:${geometry.id}`;
    let domainIndex = domainByKey.get(key);
    if (domainIndex === undefined) {
      const canonical = canonicalizeMeshletGeometry(geometry, material, materialIndex);
      domainIndex = domains.length;
      domains.push(canonical.domain);
      profiles.push(canonical.profile);
      geometries.push(geometry);
      domainByKey.set(key, domainIndex);
    }
    instances.push({
      assetIndex: domainIndex,
      materialIndex,
      transform: Float32Array.from(mesh.transform_global.matrix),
      flags: 0
    });
  }

  const canonicalInput = encodeWebCanonicalGeometryV1(domains);
  return Object.freeze({
    domains: Object.freeze(domains),
    profiles: Object.freeze(profiles),
    materials: Object.freeze(materials),
    instances: Object.freeze(instances),
    geometries: Object.freeze(geometries),
    canonicalInput
  });
}

/** Cooks one ordinary Scene into a Product revision ready for admission. */
export async function cookSceneGeometryProductV1(scene: Scene, options: SceneGeometryProductOptions): Promise<CookedSceneGeometryProductV1> {
  if (!options?.module) throw new RangeError("Runtime Geometry Product requires a WASM cooker module");
  if (options.replaces !== undefined && (options.revision ?? 0) <= options.replaces.revision) throw new RangeError("a replacement revision must be newer than the revision it replaces");
  const canonicalization = canonicalizeSceneGeometryV1(scene);
  const sourceIdentityHash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", canonicalization.canonicalInput));
  const recipeInput = encodeWebGeometryCookRecipeV1(createGeometryCookRecipeV3(options.recipe));
  const revision = await cookWasmGeometryProductRevisionV1(options.module, canonicalization.canonicalInput, recipeInput, {
    producerId: options.producerId,
    producerVersion: options.producerVersion,
    sourceIdentityKind: "content-sha256",
    sourceIdentityHash,
    revision: options.revision ?? 0,
    ...(options.replaces === undefined ? {} : { replaces: options.replaces }),
    maxDecodedProductBytes: options.maxDecodedProductBytes
  });
  return Object.freeze({
    revision,
    canonicalization,
    provider: singleRevisionProvider(revision)
  });
}

/**
 * Provider over one already-cooked revision. `Renderer.uploadProductScene` calls
 * `revisions()` once; the revision stays re-readable because the WASM result
 * keeps its pages until `release()`.
 */
function singleRevisionProvider(revision: WasmGeometryProductRevisionV1): CookedSceneGeometryProductV1["provider"] {
  let consumed = false;
  const source: GeometryProductRevisionSourceV1 = Object.freeze({
    descriptor: decodeDescriptor(revision.descriptor),
    readPage: (pageId: number, signal?: AbortSignal) => signal?.aborted
      ? Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
      : revision.readPage(pageId),
    release: () => revision.release()
  });
  const provider = {
    async *revisions(): AsyncIterable<GeometryProductRevisionSourceV1> {
      if (consumed) return;
      consumed = true;
      yield source;
    }
  };
  return provider as unknown as CookedSceneGeometryProductV1["provider"];
}

interface CanonicalMeshletGeometry {
  readonly domain: WebCanonicalGeometryDomainV1;
  readonly profile: VirtualGeometryGeometryProfile;
}

function canonicalizeMeshletGeometry(geometry: MeshletGeometryBase, material: StandardShadeMaterial, materialId: number): CanonicalMeshletGeometry {
  const vertexCount = geometry.getVertexCount();
  if (!Number.isInteger(vertexCount) || vertexCount < 3) throw new Error(`Scene geometry ${geometry.name || "<unnamed>"} has fewer than three vertices`);
  if (geometry.vertexData.length !== vertexCount * VERTEX_FLOATS) throw new Error(`Scene geometry ${geometry.name || "<unnamed>"} vertex data is not position+normal packed`);
  const vertices = new Float32Array(vertexCount * WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const source = vertex * VERTEX_FLOATS, target = vertex * WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS;
    vertices[target] = geometry.vertexData[source]!;
    vertices[target + 1] = geometry.vertexData[source + 1]!;
    vertices[target + 2] = geometry.vertexData[source + 2]!;
    vertices[target + 3] = geometry.vertexData[source + 3]!;
    vertices[target + 4] = geometry.vertexData[source + 4]!;
    vertices[target + 5] = geometry.vertexData[source + 5]!;
    // W defaults: tangent handedness, uv1 z, and opaque white vertex color.
    vertices[target + 6] = 0;
    vertices[target + 7] = 0;
    vertices[target + 8] = 0;
    vertices[target + 9] = 1;
    vertices[target + 10] = 0;
    vertices[target + 11] = 0;
    vertices[target + 12] = 0;
    vertices[target + 13] = 0;
    vertices[target + 14] = 1;
    vertices[target + 15] = 1;
    vertices[target + 16] = 1;
    vertices[target + 17] = 1;
  }
  let attributeMask = WEB_GEOMETRY_ATTRIBUTE_POSITION | WEB_GEOMETRY_ATTRIBUTE_NORMAL;
  copyStream(geometry.tangentData, TANGENT_FLOATS, vertices, 6, vertexCount, "tangent", geometry);
  if (geometry.tangentData) attributeMask |= WEB_GEOMETRY_ATTRIBUTE_TANGENT;
  copyStream(geometry.uv0Data, UV_FLOATS, vertices, 10, vertexCount, "uv0", geometry);
  if (geometry.uv0Data) attributeMask |= WEB_GEOMETRY_ATTRIBUTE_UV0;
  copyStream(geometry.uv1Data, UV_FLOATS, vertices, 12, vertexCount, "uv1", geometry);
  if (geometry.uv1Data) attributeMask |= WEB_GEOMETRY_ATTRIBUTE_UV1;
  copyStream(geometry.colorData, COLOR_FLOATS, vertices, 14, vertexCount, "color", geometry);
  if (geometry.colorData) attributeMask |= WEB_GEOMETRY_ATTRIBUTE_COLOR;

  const indexCount = geometry.getIndexCount();
  if (indexCount < 3 || indexCount % 3 !== 0) throw new Error(`Scene geometry ${geometry.name || "<unnamed>"} is not a non-empty triangle list`);
  if (geometry.indexData.length !== indexCount) throw new Error(`Scene geometry ${geometry.name || "<unnamed>"} index data length disagrees with its primitive count`);
  const indices = new Uint32Array(indexCount);
  for (let index = 0; index < indexCount; index++) {
    const value = geometry.indexData[index]!;
    if (value >= vertexCount) throw new Error(`Scene geometry ${geometry.name || "<unnamed>"} index ${value} exceeds its vertex count`);
    indices[index] = value;
  }

  const alpha = material.transparency_mode === ShadeTransparencyMode.Transparent
    ? WEB_GEOMETRY_MESHLET_BLEND
    : material.transparency_mode === ShadeTransparencyMode.AlphaTested
      ? WEB_GEOMETRY_MESHLET_MASK
      : WEB_GEOMETRY_MESHLET_OPAQUE;
  const meshletFlags = alpha | WEB_GEOMETRY_MESHLET_CASTS_SHADOW | (material.draw_side === ShadeDrawSide.Double ? WEB_GEOMETRY_MESHLET_TWO_SIDED : 0);
  return Object.freeze({
    domain: Object.freeze({ materialId, meshletFlags, attributeMask, generateNormals: false, vertices, indices }),
    profile: Object.freeze({
      hasAuthoredVertexColor: geometry.colorData !== null,
      hasUv0: geometry.uv0Data !== null,
      hasUv1: geometry.uv1Data !== null,
      hasUv2: false,
      hasNormal: true,
      hasTangent: geometry.tangentData !== null
    })
  });
}

function copyStream(stream: Float32Array | null, itemSize: number, vertices: Float32Array, offset: number, vertexCount: number, name: string, geometry: MeshletGeometryBase): void {
  if (stream === null) return;
  if (stream.length !== vertexCount * itemSize) throw new Error(`Scene geometry ${geometry.name || "<unnamed>"} ${name} data does not match the vertex count`);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const source = vertex * itemSize, target = vertex * WEB_GEOMETRY_CANONICAL_VERTEX_FLOATS + offset;
    for (let component = 0; component < itemSize; component++) {
      const value = stream[source + component]!;
      if (!Number.isFinite(value)) throw new Error(`Scene geometry ${geometry.name || "<unnamed>"} ${name} contains non-finite data`);
      vertices[target + component] = value;
    }
  }
}

function decodeDescriptor(bytes: ArrayBuffer): GeometryProductRevisionSourceV1["descriptor"] {
  // The revision already validated its own descriptor; decode it again so the
  // provider hands admission exactly the frozen descriptor it will verify.
  return decodeGeometryProductDescriptorBinaryV1(bytes);
}
