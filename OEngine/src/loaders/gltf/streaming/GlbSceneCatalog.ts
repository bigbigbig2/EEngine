import type { GlbRangeReadableSource } from "./GlbRangeSource.js";

export interface GlbByteRange {
  readonly bufferIndex: number;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export type GlbCookAttributeSemantic = "POSITION" | "NORMAL" | "TANGENT" | "TEXCOORD_0" | "TEXCOORD_1" | "COLOR_0";

export interface GlbCookAccessor {
  readonly accessorIndex: number;
  readonly bufferIndex: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly byteStride: number;
  readonly componentType: 5120 | 5121 | 5122 | 5123 | 5125 | 5126;
  readonly componentCount: number;
  readonly count: number;
  readonly normalized: boolean;
  /** Optional glTF accessor bounds, validated and only present for POSITION. */
  readonly min?: readonly number[];
  readonly max?: readonly number[];
  readonly sparse?: {
    readonly count: number;
    readonly indices: GlbByteRange & { readonly componentType: 5121 | 5123 | 5125 };
    readonly values: GlbByteRange;
  };
}

export interface GlbCookMaterialDomain {
  readonly materialIndex: number;
  readonly alphaMode: "OPAQUE" | "MASK" | "BLEND";
  readonly doubleSided: boolean;
  readonly baseColorFactor: readonly [number, number, number, number];
  readonly metallicFactor: number;
  readonly roughnessFactor: number;
  readonly emissiveFactor: readonly [number, number, number];
  readonly alphaCutoff: number;
  readonly unlit: boolean;
  readonly baseColorTexture?: GlbCookTextureSlot;
  readonly metallicRoughnessTexture?: GlbCookTextureSlot;
  readonly normalTexture?: GlbCookTextureSlot & { readonly normalScale: number };
  readonly occlusionTexture?: GlbCookTextureSlot & { readonly occlusionStrength: number };
  readonly emissiveTexture?: GlbCookTextureSlot;
}

export interface GlbCookTextureSlot {
  readonly textureIndex: number;
  readonly texCoord: number;
  readonly offset: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly rotation: number;
}

export interface GlbCookTextureInfo {
  readonly textureIndex: number;
  readonly sourceIndex: number;
  readonly sampler: Readonly<{ magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }>;
}

export interface GlbCookImageInfo {
  readonly imageIndex: number;
  readonly mimeType?: string;
  readonly uri?: string;
  readonly bufferView?: GlbByteRange;
}

export interface GlbCookPrimitive {
  readonly nodeIndex: number;
  readonly instanceNodeIndices: readonly number[];
  readonly meshIndex: number;
  readonly primitiveIndex: number;
  readonly materialIndex: number;
  readonly mode: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly attributes: Readonly<Partial<Record<GlbCookAttributeSemantic, GlbCookAccessor>> & { readonly POSITION: GlbCookAccessor }>;
  readonly indices?: GlbCookAccessor;
  readonly material: GlbCookMaterialDomain;
  readonly ranges: readonly GlbByteRange[];
  /** Conservative local-space bounds copied from POSITION accessor min/max. */
  readonly boundsMin: readonly [number, number, number];
  readonly boundsMax: readonly [number, number, number];
  readonly boundsSphere: readonly [number, number, number, number];
}

export interface GlbSceneCatalog {
  readonly schemaVersion: 1;
  readonly sourceIdentityHash: Uint8Array;
  readonly scenes: readonly number[];
  readonly primitives: readonly GlbCookPrimitive[];
  readonly instances: readonly GlbSceneInstance[];
  readonly sourceBytes: number;
  readonly textures: readonly GlbCookTextureInfo[];
  readonly images: readonly GlbCookImageInfo[];
}

export interface GlbSceneInstance {
  readonly nodeIndex: number;
  readonly meshIndex: number;
  readonly worldMatrix: Float32Array;
}

/** Builds a compact dependency catalog without reading any BIN payload. */
export function buildGlbSceneCatalog(source: GlbRangeReadableSource): GlbSceneCatalog {
  const json = source.json;
  if (!json || typeof json !== "object") throw new Error("GLB scene catalog requires an object JSON document");
  const document = json as GltfCatalogDocument;
  const requiredExtensions = document.extensionsRequired ?? [];
  if (!Array.isArray(requiredExtensions) || requiredExtensions.some(value => typeof value !== "string")) throw new Error("GLB extensionsRequired must be an array of strings");
  // EXT_texture_webp is decoded by the same browser createImageBitmap path as
  // PNG/JPEG payloads; keeping it in the catalog contract lets the Dungeon GLB
  // reach Product admission instead of failing before any source Range.
  const supportedRequired = new Set(["KHR_texture_transform", "KHR_materials_unlit", "EXT_texture_webp"]);
  for (const extension of requiredExtensions) if (!supportedRequired.has(extension)) throw new Error(`GLB requires unsupported extension '${extension}'`);
  const nodes = document.nodes ?? [];
  const meshes = document.meshes ?? [];
  const accessors = document.accessors ?? [];
  const views = document.bufferViews ?? [];
  const buffers = document.buffers ?? [];
  const meshInstances = new Map<number, Set<number>>();
  const instanceByNode = new Map<number, GlbSceneInstance>();
  const visit = (nodeIndex: number, visited: Set<number>, parentWorld: Float32Array): void => {
    if (visited.has(nodeIndex)) throw new Error(`GLB node graph contains a cycle at node ${nodeIndex}`);
    const node = nodes[nodeIndex];
    if (!node) throw new Error(`GLB scene references missing node ${nodeIndex}`);
    visited.add(nodeIndex);
    const worldMatrix = multiplyMatrix(parentWorld, nodeLocalMatrix(node, nodeIndex));
    if (node.mesh !== undefined) {
      if (node.skin !== undefined) throw new Error(`GLB node ${nodeIndex} is skinned; the static Web geometry profile does not admit skins`);
      if (!meshes[node.mesh]) throw new Error(`GLB node ${nodeIndex} references missing mesh ${node.mesh}`);
      const instances = meshInstances.get(node.mesh) ?? new Set<number>();
      instances.add(nodeIndex); meshInstances.set(node.mesh, instances);
      const previous = instanceByNode.get(nodeIndex);
      if (previous !== undefined && !sameMatrix(previous.worldMatrix, worldMatrix)) {
        throw new Error(`GLB node ${nodeIndex} is reachable with multiple world transforms; static instance publication is ambiguous`);
      }
      instanceByNode.set(nodeIndex, Object.freeze({ nodeIndex, meshIndex: node.mesh, worldMatrix }));
    }
    for (const child of node.children ?? []) visit(child, visited, worldMatrix);
    visited.delete(nodeIndex);
  };
  const sceneRoots = (document.scenes ?? []).flatMap(scene => scene.nodes ?? []);
  const roots = sceneRoots.length > 0 ? sceneRoots : nodes.map((_, index) => index);
  for (const root of roots) visit(root, new Set(), identityMatrix());
  const primitives: GlbCookPrimitive[] = [];
  for (const [meshIndex, instanceSet] of [...meshInstances].sort(([a], [b]) => a - b)) {
    const mesh = meshes[meshIndex]!;
    const instanceNodeIndices = Object.freeze([...instanceSet].sort((a, b) => a - b));
    mesh.primitives.forEach((primitive, primitiveIndex) => {
      const mode = primitive.mode ?? 4;
      if (mode !== 4) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} uses unsupported mode ${mode}; only TRIANGLES are admitted`);
      if (primitive.targets && primitive.targets.length > 0) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} has morph targets; the static Web geometry profile does not admit them`);
      if (primitive.extensions?.KHR_draco_mesh_compression !== undefined) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} requires Draco decode before canonical cook`);
      if (primitive.extensions?.EXT_meshopt_compression !== undefined) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} requires EXT_meshopt_compression decode before canonical cook`);
      const positionAccessor = primitive.attributes.POSITION;
      if (positionAccessor === undefined) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} has no POSITION accessor`);
      const supportedSemantics = new Set(["POSITION", "NORMAL", "TANGENT", "TEXCOORD_0", "TEXCOORD_1", "COLOR_0"]);
      for (const semantic of Object.keys(primitive.attributes)) if (!supportedSemantics.has(semantic)) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} uses unsupported attribute semantic ${semantic}`);
      const attributes: Partial<Record<GlbCookAttributeSemantic, GlbCookAccessor>> = {};
      for (const semantic of ["POSITION", "NORMAL", "TANGENT", "TEXCOORD_0", "TEXCOORD_1", "COLOR_0"] as const) {
        const accessorIndex = primitive.attributes[semantic];
        if (accessorIndex !== undefined) attributes[semantic] = accessorInfo(accessors, views, buffers, accessorIndex);
      }
      const position = attributes.POSITION!;
      requireAttributeShape(position, 3, "POSITION", meshIndex, primitiveIndex);
      requireAttributeEncoding(position, "POSITION", meshIndex, primitiveIndex);
      if (attributes.NORMAL) requireAttributeShape(attributes.NORMAL, 3, "NORMAL", meshIndex, primitiveIndex, position.count);
      if (attributes.TANGENT) requireAttributeShape(attributes.TANGENT, 4, "TANGENT", meshIndex, primitiveIndex, position.count);
      if (attributes.TEXCOORD_0) requireAttributeShape(attributes.TEXCOORD_0, 2, "TEXCOORD_0", meshIndex, primitiveIndex, position.count);
      if (attributes.TEXCOORD_1) requireAttributeShape(attributes.TEXCOORD_1, 2, "TEXCOORD_1", meshIndex, primitiveIndex, position.count);
      if (attributes.COLOR_0 && ![3, 4].includes(attributes.COLOR_0.componentCount)) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} COLOR_0 must be VEC3 or VEC4`);
      if (attributes.COLOR_0 && attributes.COLOR_0.count !== position.count) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} COLOR_0 count differs from POSITION`);
      for (const [semantic, accessor] of Object.entries(attributes) as [GlbCookAttributeSemantic, GlbCookAccessor][]) requireAttributeEncoding(accessor, semantic, meshIndex, primitiveIndex);
      const indices = primitive.indices === undefined ? undefined : accessorInfo(accessors, views, buffers, primitive.indices);
      if (indices && (indices.componentCount !== 1 || ![5121, 5123, 5125].includes(indices.componentType) || indices.normalized || indices.byteStride !== componentTypeBytes(indices.componentType) || indices.count === 0 || indices.count % 3 !== 0)) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} has an invalid index accessor`);
      if (!indices && (position.count === 0 || position.count % 3 !== 0)) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} non-indexed vertex count is not a triangle list`);
      const ranges = new Map<string, GlbByteRange>();
      for (const accessor of Object.values(attributes)) addAccessorRanges(ranges, accessor);
      if (indices) addAccessorRanges(ranges, indices);
      const material = materialInfo(document.materials ?? [], primitive.material, document.textures ?? [], document.samplers ?? []);
      const bounds = positionBounds(position, meshIndex, primitiveIndex);
      primitives.push(Object.freeze({ nodeIndex: instanceNodeIndices[0]!, instanceNodeIndices, meshIndex, primitiveIndex, materialIndex: material.materialIndex, mode, vertexCount: position.count, triangleCount: (indices?.count ?? position.count) / 3, attributes: Object.freeze(attributes) as GlbCookPrimitive["attributes"], ...(indices ? { indices } : {}), material, ranges: Object.freeze([...ranges.values()].sort(compareRange)), ...bounds }));
    });
  }
  const textures = textureInfos(document);
  const images = imageInfos(document, views, buffers, source.sourceIdentity.finalUrl);
  return Object.freeze({ schemaVersion: 1, sourceIdentityHash: source.sourceIdentity.hash, scenes: Object.freeze(sceneRoots), primitives: Object.freeze(primitives.sort((a, b) => a.nodeIndex - b.nodeIndex || a.meshIndex - b.meshIndex || a.primitiveIndex - b.primitiveIndex)), instances: Object.freeze([...instanceByNode.values()].sort((a, b) => a.nodeIndex - b.nodeIndex)), sourceBytes: source.byteLength, textures, images });
}

interface GltfCatalogDocument { buffers?: GltfBuffer[]; bufferViews?: GltfBufferView[]; accessors?: GltfAccessor[]; nodes?: GltfNode[]; meshes?: GltfMesh[]; scenes?: GltfScene[]; materials?: GltfMaterial[]; textures?: GltfTexture[]; images?: GltfImage[]; samplers?: GltfSampler[]; extensionsRequired?: unknown; extensionsUsed?: unknown }
interface GltfBuffer { byteLength?: unknown; uri?: unknown }
interface GltfBufferView { buffer?: unknown; byteOffset?: unknown; byteLength?: unknown; byteStride?: unknown; extensions?: { EXT_meshopt_compression?: unknown } }
interface GltfAccessor { bufferView?: unknown; byteOffset?: unknown; componentType?: unknown; count?: unknown; type?: unknown; normalized?: unknown; sparse?: unknown; min?: unknown; max?: unknown }
interface GltfNode { mesh?: number; skin?: number; children?: number[]; matrix?: unknown; translation?: unknown; rotation?: unknown; scale?: unknown }
interface GltfMesh { primitives: GltfPrimitive[] }
interface GltfPrimitive { attributes: Record<string, number>; indices?: number; material?: number; mode?: number; targets?: unknown[]; extensions?: { KHR_draco_mesh_compression?: unknown; EXT_meshopt_compression?: unknown } }
interface GltfScene { nodes?: number[] }
interface GltfTextureInfo { index?: unknown; texCoord?: unknown; extensions?: { KHR_texture_transform?: { offset?: unknown; scale?: unknown; rotation?: unknown; texCoord?: unknown } } }
interface GltfMaterial { alphaMode?: unknown; doubleSided?: unknown; pbrMetallicRoughness?: { baseColorFactor?: unknown; metallicFactor?: unknown; roughnessFactor?: unknown; baseColorTexture?: GltfTextureInfo; metallicRoughnessTexture?: GltfTextureInfo }; normalTexture?: GltfTextureInfo & { scale?: unknown }; occlusionTexture?: GltfTextureInfo & { strength?: unknown }; emissiveTexture?: GltfTextureInfo; emissiveFactor?: unknown; alphaCutoff?: unknown; extensions?: { KHR_materials_unlit?: unknown } }
interface GltfTexture { source?: unknown; sampler?: unknown; extensions?: { EXT_texture_webp?: { source?: unknown } } }
interface GltfImage { uri?: unknown; bufferView?: unknown; mimeType?: unknown }
interface GltfSampler { magFilter?: unknown; minFilter?: unknown; wrapS?: unknown; wrapT?: unknown }

function accessorInfo(accessors: readonly GltfAccessor[], views: readonly GltfBufferView[], buffers: readonly GltfBuffer[], index: number): GlbCookAccessor {
  const accessor = accessors[index];
  if (!accessor || !Number.isSafeInteger(accessor.count) || (accessor.count as number) < 0 || !Number.isSafeInteger(accessor.componentType)) throw new Error(`GLB accessor ${index} is invalid`);
  if (accessor.bufferView === undefined && accessor.sparse === undefined) throw new Error(`GLB accessor ${index} has neither bufferView nor sparse data`);
  const componentBytes = componentTypeBytes(accessor.componentType as number), componentCount = typeComponents(accessor.type);
  const elementBytes = componentBytes * componentCount;
  const base = accessor.bufferView === undefined
    ? { bufferIndex: 0, byteOffset: 0, byteLength: 0, byteStride: elementBytes }
    : accessorBaseRange(accessor, views, buffers, elementBytes, componentBytes, index);
  if (accessor.normalized !== undefined && typeof accessor.normalized !== "boolean") throw new Error(`GLB accessor ${index} normalized is not boolean`);
  const min = accessor.min === undefined ? undefined : finiteBounds(accessor.min, componentCount, `GLB accessor ${index} min`);
  const max = accessor.max === undefined ? undefined : finiteBounds(accessor.max, componentCount, `GLB accessor ${index} max`);
  if ((min === undefined) !== (max === undefined)) throw new Error(`GLB accessor ${index} must provide both min and max bounds`);
  if (min !== undefined && max !== undefined && min.some((value, axis) => value > max[axis]!)) throw new Error(`GLB accessor ${index} bounds are inverted`);
  const sparse = accessor.sparse === undefined ? undefined : sparseInfo(accessor.sparse, views, buffers, accessor.count as number, elementBytes, index);
  return Object.freeze({ accessorIndex: index, count: accessor.count as number, componentCount, componentType: accessor.componentType as GlbCookAccessor["componentType"], normalized: accessor.normalized === true, byteStride: base.byteStride, bufferIndex: base.bufferIndex, byteOffset: base.byteOffset, byteLength: base.byteLength, ...(min === undefined ? {} : { min, max }), ...(sparse === undefined ? {} : { sparse }) });
}

function accessorBaseRange(accessor: GltfAccessor, views: readonly GltfBufferView[], buffers: readonly GltfBuffer[], elementBytes: number, componentBytes: number, index: number): { bufferIndex: number; byteOffset: number; byteLength: number; byteStride: number } {
  if (!Number.isSafeInteger(accessor.bufferView)) throw new Error(`GLB accessor ${index} bufferView is invalid`);
  const view = views[accessor.bufferView as number];
  if (!view || !Number.isSafeInteger(view.buffer) || !Number.isSafeInteger(view.byteLength) || (view.byteLength as number) < 0) throw new Error(`GLB accessor ${index} bufferView is invalid`);
  if (view.extensions?.EXT_meshopt_compression !== undefined) throw new Error(`GLB accessor ${index} requires EXT_meshopt_compression decode before canonical cook`);
  const buffer = buffers[view.buffer as number];
  if (!buffer || !Number.isSafeInteger(buffer.byteLength)) throw new Error(`GLB accessor ${index} references an invalid buffer`);
  if (view.byteStride !== undefined && (!Number.isSafeInteger(view.byteStride) || (view.byteStride as number) < 4 || (view.byteStride as number) > 252 || (view.byteStride as number) % 4 !== 0)) throw new Error(`GLB accessor ${index} has an invalid byteStride`);
  const stride = Number.isSafeInteger(view.byteStride) ? view.byteStride as number : elementBytes;
  if (stride < elementBytes || stride > 0xffffffff) throw new Error(`GLB accessor ${index} has an invalid byteStride`);
  const viewOffset = Number.isSafeInteger(view.byteOffset) ? view.byteOffset as number : 0;
  const accessorOffset = Number.isSafeInteger(accessor.byteOffset) ? accessor.byteOffset as number : 0;
  const offset = viewOffset + accessorOffset;
  const byteLength = (accessor.count as number) === 0 ? 0 : ((accessor.count as number) - 1) * stride + elementBytes;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(byteLength) || offset < 0 || accessorOffset < 0 || offset % componentBytes !== 0 || accessorOffset + byteLength > (view.byteLength as number) || offset + byteLength > (buffer.byteLength as number)) throw new Error(`GLB accessor ${index} range exceeds its bufferView or violates component alignment`);
  return { bufferIndex: view.buffer as number, byteOffset: offset, byteLength, byteStride: stride };
}

function sparseInfo(raw: unknown, views: readonly GltfBufferView[], buffers: readonly GltfBuffer[], accessorCount: number, elementBytes: number, accessorIndex: number): GlbCookAccessor["sparse"] {
  if (!raw || typeof raw !== "object") throw new Error(`GLB accessor ${accessorIndex} sparse object is invalid`);
  const value = raw as { count?: unknown; indices?: { bufferView?: unknown; byteOffset?: unknown; componentType?: unknown }; values?: { bufferView?: unknown; byteOffset?: unknown } };
  if (!Number.isSafeInteger(value.count) || (value.count as number) <= 0 || (value.count as number) > accessorCount || !value.indices || !value.values) throw new Error(`GLB accessor ${accessorIndex} sparse count/records are invalid`);
  if (![5121, 5123, 5125].includes(value.indices.componentType as number)) throw new Error(`GLB accessor ${accessorIndex} sparse indices componentType is invalid`);
  const indices = sparseRange(value.indices, views, buffers, accessorIndex, "indices", value.count as number, componentTypeBytes(value.indices.componentType as number));
  const values = sparseRange(value.values, views, buffers, accessorIndex, "values", value.count as number, elementBytes);
  return Object.freeze({ count: value.count as number, indices: Object.freeze({ ...indices, componentType: value.indices.componentType as 5121 | 5123 | 5125 }), values: Object.freeze(values) });
}

function sparseRange(raw: { bufferView?: unknown; byteOffset?: unknown }, views: readonly GltfBufferView[], buffers: readonly GltfBuffer[], accessorIndex: number, role: string, count: number, elementBytes: number): GlbByteRange {
  if (!Number.isSafeInteger(raw.bufferView)) throw new Error(`GLB accessor ${accessorIndex} sparse ${role} bufferView is invalid`);
  const view = views[raw.bufferView as number];
  if (!view || !Number.isSafeInteger(view.buffer) || !Number.isSafeInteger(view.byteLength)) throw new Error(`GLB accessor ${accessorIndex} sparse ${role} bufferView is invalid`);
  const buffer = buffers[view.buffer as number];
  if (!buffer || !Number.isSafeInteger(buffer.byteLength)) throw new Error(`GLB accessor ${accessorIndex} sparse ${role} buffer is invalid`);
  const viewOffset = Number.isSafeInteger(view.byteOffset) ? view.byteOffset as number : 0;
  const sparseOffset = Number.isSafeInteger(raw.byteOffset) ? raw.byteOffset as number : 0;
  const byteOffset = viewOffset + sparseOffset;
  const byteLength = count * elementBytes;
  if (!Number.isSafeInteger(byteOffset) || sparseOffset < 0 || byteOffset < viewOffset || byteOffset + byteLength > viewOffset + (view.byteLength as number) || byteOffset + byteLength > (buffer.byteLength as number)) throw new Error(`GLB accessor ${accessorIndex} sparse ${role} range is invalid`);
  return Object.freeze({ bufferIndex: view.buffer as number, byteOffset, byteLength });
}

function finiteBounds(value: unknown, count: number, label: string): readonly number[] {
  if (!Array.isArray(value) || value.length !== count || value.some(item => typeof item !== "number" || !Number.isFinite(item))) throw new Error(`${label} must contain ${count} finite numbers`);
  return Object.freeze(value.slice()) as readonly number[];
}

function positionBounds(accessor: GlbCookAccessor, meshIndex: number, primitiveIndex: number): Pick<GlbCookPrimitive, "boundsMin" | "boundsMax" | "boundsSphere"> {
  // glTF allows POSITION min/max to be omitted. Keep planning conservative in
  // that case; the cooker still derives the authoritative Product bounds from
  // the canonical POSITION stream.
  if (accessor.min === undefined || accessor.max === undefined || accessor.min.length !== 3 || accessor.max.length !== 3) {
    const extent = Number.MAX_VALUE / 4;
    return Object.freeze({ boundsMin: Object.freeze([-extent, -extent, -extent] as const), boundsMax: Object.freeze([extent, extent, extent] as const), boundsSphere: Object.freeze([0, 0, 0, extent * Math.sqrt(3)] as const) });
  }
  const min = [accessor.min[0]!, accessor.min[1]!, accessor.min[2]!] as const;
  const max = [accessor.max[0]!, accessor.max[1]!, accessor.max[2]!] as const;
  const center: [number, number, number] = [(min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5, (min[2] + max[2]) * 0.5];
  const radius = Math.hypot(max[0] - center[0], max[1] - center[1], max[2] - center[2]);
  return Object.freeze({ boundsMin: Object.freeze(min), boundsMax: Object.freeze(max), boundsSphere: Object.freeze([center[0], center[1], center[2], radius] as const) });
}

function requireAttributeShape(accessor: GlbCookAccessor, components: number, semantic: string, mesh: number, primitive: number, count = accessor.count): void { if (accessor.componentCount !== components || accessor.count !== count) throw new Error(`GLB primitive ${mesh}:${primitive} ${semantic} shape/count is invalid`); }
function requireAttributeEncoding(accessor: GlbCookAccessor, semantic: GlbCookAttributeSemantic, mesh: number, primitive: number): void {
  const encodingIs = (types: readonly number[], normalized: boolean): boolean => types.includes(accessor.componentType) && accessor.normalized === normalized;
  const valid = semantic === "POSITION"
    ? encodingIs([5126], false)
    : semantic === "NORMAL" || semantic === "TANGENT"
      ? encodingIs([5126], false) || encodingIs([5120, 5122], true)
      : encodingIs([5126], false) || encodingIs([5121, 5123], true);
  if (!valid) throw new Error(`GLB primitive ${mesh}:${primitive} ${semantic} component encoding is invalid`);
}
function materialInfo(materials: readonly GltfMaterial[], index: number | undefined, textures: readonly GltfTexture[], samplers: readonly GltfSampler[]): GlbCookMaterialDomain {
  if (index === undefined) return Object.freeze({ materialIndex: 0xffffffff, alphaMode: "OPAQUE", doubleSided: false, baseColorFactor: [1, 1, 1, 1] as const, metallicFactor: 0, roughnessFactor: 1, emissiveFactor: [0, 0, 0] as const, alphaCutoff: 0.5, unlit: false });
  const material = materials[index];
  if (!material) throw new Error(`GLB primitive references missing material ${index}`);
  const alphaMode = material.alphaMode ?? "OPAQUE";
  if (alphaMode !== "OPAQUE" && alphaMode !== "MASK" && alphaMode !== "BLEND") throw new Error(`GLB material ${index} has invalid alphaMode`);
  if (material.doubleSided !== undefined && typeof material.doubleSided !== "boolean") throw new Error(`GLB material ${index} has invalid doubleSided`);
  const pbr = material.pbrMetallicRoughness;
  const baseColorFactor = finiteTuple(pbr?.baseColorFactor, 4, [1, 1, 1, 1], `GLB material ${index} baseColorFactor`) as [number, number, number, number];
  const emissiveFactor = finiteTuple(material.emissiveFactor, 3, [0, 0, 0], `GLB material ${index} emissiveFactor`) as [number, number, number];
  const metallicFactor = finiteScalar(pbr?.metallicFactor, 0, `GLB material ${index} metallicFactor`);
  const roughnessFactor = finiteScalar(pbr?.roughnessFactor, 1, `GLB material ${index} roughnessFactor`);
  const alphaCutoff = finiteScalar(material.alphaCutoff, 0.5, `GLB material ${index} alphaCutoff`);
  if (metallicFactor < 0 || metallicFactor > 1 || roughnessFactor < 0 || roughnessFactor > 1 || alphaCutoff < 0 || alphaCutoff > 1) throw new Error(`GLB material ${index} contains an out-of-range scalar factor`);
  return Object.freeze({ materialIndex: index, alphaMode, doubleSided: material.doubleSided === true, baseColorFactor, metallicFactor, roughnessFactor, emissiveFactor, alphaCutoff, unlit: material.extensions?.KHR_materials_unlit !== undefined,
    ...(textureSlot(pbr?.baseColorTexture, textures, samplers, "baseColorTexture") === undefined ? {} : { baseColorTexture: textureSlot(pbr?.baseColorTexture, textures, samplers, "baseColorTexture") }),
    ...(textureSlot(pbr?.metallicRoughnessTexture, textures, samplers, "metallicRoughnessTexture") === undefined ? {} : { metallicRoughnessTexture: textureSlot(pbr?.metallicRoughnessTexture, textures, samplers, "metallicRoughnessTexture") }),
    ...(textureSlot(material.normalTexture, textures, samplers, "normalTexture") === undefined ? {} : { normalTexture: { ...textureSlot(material.normalTexture, textures, samplers, "normalTexture")!, normalScale: finiteScalar(material.normalTexture?.scale, 1, `GLB material ${index} normal scale`) } }),
    ...(textureSlot(material.occlusionTexture, textures, samplers, "occlusionTexture") === undefined ? {} : { occlusionTexture: { ...textureSlot(material.occlusionTexture, textures, samplers, "occlusionTexture")!, occlusionStrength: finiteScalar(material.occlusionTexture?.strength, 1, `GLB material ${index} occlusion strength`) } }),
    ...(textureSlot(material.emissiveTexture, textures, samplers, "emissiveTexture") === undefined ? {} : { emissiveTexture: textureSlot(material.emissiveTexture, textures, samplers, "emissiveTexture") })
  });
}

function textureSlot(info: GltfTextureInfo | undefined, textures: readonly GltfTexture[], samplers: readonly GltfSampler[], role: string): GlbCookTextureSlot | undefined {
  if (info === undefined) return undefined;
  if (!Number.isSafeInteger(info.index) || !textures[info.index as number]) throw new Error(`GLB material ${role} texture index is invalid`);
  const transform = info.extensions?.KHR_texture_transform;
  const texCoordValue = transform?.texCoord ?? info.texCoord ?? 0;
  const texCoord = typeof texCoordValue === "number" ? texCoordValue : NaN;
  if (!Number.isInteger(texCoord) || texCoord < 0 || texCoord > 1) throw new Error(`GLB material ${role} texCoord is unsupported`);
  return Object.freeze({ textureIndex: info.index as number, texCoord, offset: finiteVec2(transform?.offset, [0, 0], `${role} offset`), scale: finiteVec2(transform?.scale, [1, 1], `${role} scale`), rotation: finiteScalar(transform?.rotation, 0, `${role} rotation`) });
}

function textureInfos(document: GltfCatalogDocument): readonly GlbCookTextureInfo[] {
  return Object.freeze((document.textures ?? []).map((texture, index) => {
    const source = texture.source ?? texture.extensions?.EXT_texture_webp?.source;
    if (!Number.isSafeInteger(source) || (source as number) < 0) {
      throw new Error(`GLB texture ${index} source is invalid`);
    }
    if (texture.sampler !== undefined && (!Number.isSafeInteger(texture.sampler) || (texture.sampler as number) < 0)) {
      throw new Error(`GLB texture ${index} sampler is invalid`);
    }
    const image = (document.images ?? [])[source as number];
    if (!image) throw new Error(`GLB texture ${index} image source is missing`);
    const sampler = texture.sampler === undefined ? {} : (document.samplers ?? [])[texture.sampler as number];
    if (texture.sampler !== undefined && !sampler) throw new Error(`GLB texture ${index} references missing sampler ${texture.sampler}`);
    if (sampler?.magFilter !== undefined && ![9728, 9729].includes(sampler.magFilter as number)) throw new Error(`GLB texture ${index} sampler magFilter is invalid`);
    if (sampler?.minFilter !== undefined && ![9728, 9729, 9984, 9985, 9986, 9987].includes(sampler.minFilter as number)) throw new Error(`GLB texture ${index} sampler minFilter is invalid`);
    if (sampler?.wrapS !== undefined && ![33071, 33648, 10497].includes(sampler.wrapS as number)) throw new Error(`GLB texture ${index} sampler wrapS is invalid`);
    if (sampler?.wrapT !== undefined && ![33071, 33648, 10497].includes(sampler.wrapT as number)) throw new Error(`GLB texture ${index} sampler wrapT is invalid`);
    return Object.freeze({
      textureIndex: index,
      sourceIndex: source as number,
      sampler: Object.freeze({
        ...(sampler?.magFilter === undefined ? {} : { magFilter: sampler.magFilter as number }),
        ...(sampler?.minFilter === undefined ? {} : { minFilter: sampler.minFilter as number }),
        ...(sampler?.wrapS === undefined ? {} : { wrapS: sampler.wrapS as number }),
        ...(sampler?.wrapT === undefined ? {} : { wrapT: sampler.wrapT as number })
      })
    });
  }));
}

function imageInfos(document: GltfCatalogDocument, views: readonly GltfBufferView[], buffers: readonly GltfBuffer[], baseUrl: string): readonly GlbCookImageInfo[] {
  return Object.freeze((document.images ?? []).map((image, index) => {
    const uri = typeof image.uri === "string" ? resolveResourceUri(image.uri, baseUrl) : undefined;
    if (image.bufferView !== undefined && (!Number.isSafeInteger(image.bufferView) || (image.bufferView as number) < 0)) {
      throw new Error(`GLB image ${index} bufferView index is invalid`);
    }
    const view = image.bufferView === undefined ? undefined : views[image.bufferView as number];
    let bufferView: GlbByteRange | undefined;
    if (image.bufferView !== undefined && !view) throw new Error(`GLB image ${index} references missing bufferView ${image.bufferView}`);
    if (view) {
      if (!Number.isSafeInteger(view.buffer) || (view.buffer as number) < 0 || !buffers[view.buffer as number]) throw new Error(`GLB image ${index} bufferView buffer is invalid`);
      if (!Number.isSafeInteger(view.byteLength) || (view.byteLength as number) < 0) throw new Error(`GLB image ${index} bufferView byteLength is invalid`);
      const byteOffset = Number.isSafeInteger(view.byteOffset) ? view.byteOffset as number : 0;
      if (byteOffset < 0 || byteOffset + (view.byteLength as number) > (buffers[view.buffer as number]!.byteLength as number)) {
        throw new Error(`GLB image ${index} bufferView exceeds its buffer declaration`);
      }
      bufferView = Object.freeze({ bufferIndex: view.buffer as number, byteOffset, byteLength: view.byteLength as number });
    }
    if (uri === undefined && bufferView === undefined) throw new Error(`GLB image ${index} has no URI or bufferView`);
    if (uri !== undefined && bufferView !== undefined) throw new Error(`GLB image ${index} cannot define both URI and bufferView`);
    const mimeType = image.mimeType === undefined ? undefined : image.mimeType;
    if (mimeType !== undefined && typeof mimeType !== "string") throw new Error(`GLB image ${index} mimeType is invalid`);
    return Object.freeze({ imageIndex: index, ...(mimeType === undefined ? {} : { mimeType }), ...(uri === undefined ? {} : { uri }), ...(bufferView === undefined ? {} : { bufferView }) });
  }));
}

function finiteScalar(value: unknown, fallback: number, label: string): number { if (value === undefined) return fallback; if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`); return value; }
function finiteTuple(value: unknown, length: number, fallback: readonly number[], label: string): readonly number[] { if (value === undefined) return fallback; if (!Array.isArray(value) || value.length !== length || value.some(item => typeof item !== "number" || !Number.isFinite(item))) throw new Error(`${label} must contain ${length} finite numbers`); return Object.freeze(value.slice()) as readonly number[]; }
function finiteVec2(value: unknown, fallback: readonly [number, number], label: string): readonly [number, number] { return finiteTuple(value, 2, fallback, label) as readonly [number, number]; }
function resolveResourceUri(uri: string, baseUrl: string): string { return uri.startsWith("data:") ? uri : new URL(uri, baseUrl).href; }

function identityMatrix(): Float32Array { const matrix = new Float32Array(16); matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1; return matrix; }
function nodeLocalMatrix(node: GltfNode, nodeIndex: number): Float32Array {
  if (node.matrix !== undefined) {
    if (!Array.isArray(node.matrix) || node.matrix.length !== 16 || node.matrix.some(value => typeof value !== "number" || !Number.isFinite(value))) throw new Error(`GLB node ${nodeIndex} matrix must contain 16 finite numbers`);
    return Float32Array.from(node.matrix);
  }
  const translation = finiteTuple(node.translation, 3, [0, 0, 0], `GLB node ${nodeIndex} translation`);
  const scale = finiteTuple(node.scale, 3, [1, 1, 1], `GLB node ${nodeIndex} scale`);
  const rotation = finiteTuple(node.rotation, 4, [0, 0, 0, 1], `GLB node ${nodeIndex} rotation`);
  const x = rotation[0]!, y = rotation[1]!, z = rotation[2]!, w = rotation[3]!;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  const out = identityMatrix();
  out[0] = (1 - 2 * (yy + zz)) * scale[0]!; out[1] = 2 * (xy + wz) * scale[0]!; out[2] = 2 * (xz - wy) * scale[0]!;
  out[4] = 2 * (xy - wz) * scale[1]!; out[5] = (1 - 2 * (xx + zz)) * scale[1]!; out[6] = 2 * (yz + wx) * scale[1]!;
  out[8] = 2 * (xz + wy) * scale[2]!; out[9] = 2 * (yz - wx) * scale[2]!; out[10] = (1 - 2 * (xx + yy)) * scale[2]!;
  out[12] = translation[0]!; out[13] = translation[1]!; out[14] = translation[2]!;
  return out;
}
function multiplyMatrix(a: Float32Array, b: Float32Array): Float32Array { const out = new Float32Array(16); for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) { let value = 0; for (let k = 0; k < 4; k++) value += a[k * 4 + row]! * b[column * 4 + k]!; out[column * 4 + row] = value; } return out; }
function sameMatrix(a: Float32Array, b: Float32Array): boolean { for (let index = 0; index < 16; index++) if (Math.abs(a[index]! - b[index]!) > 1e-6) return false; return true; }
function addAccessorRanges(map: Map<string, GlbByteRange>, accessor: GlbCookAccessor): void {
  if (accessor.byteLength > 0) addRange(map, accessor);
  if (accessor.sparse) { addRange(map, accessor.sparse.indices); addRange(map, accessor.sparse.values); }
}
function addRange(map: Map<string, GlbByteRange>, range: GlbByteRange): void { const value = Object.freeze({ bufferIndex: range.bufferIndex, byteOffset: range.byteOffset, byteLength: range.byteLength }); const key = `${value.bufferIndex}:${value.byteOffset}:${value.byteLength}`; map.set(key, value); }
function compareRange(a: GlbByteRange, b: GlbByteRange): number { return a.bufferIndex - b.bufferIndex || a.byteOffset - b.byteOffset || a.byteLength - b.byteLength; }
function componentTypeBytes(value: number): number { if (value === 5120 || value === 5121) return 1; if (value === 5122 || value === 5123) return 2; if (value === 5125 || value === 5126) return 4; throw new Error(`GLB accessor componentType ${value} is unsupported`); }
function typeComponents(value: unknown): number { switch (value) { case "SCALAR": return 1; case "VEC2": return 2; case "VEC3": return 3; case "VEC4": return 4; case "MAT2": return 4; case "MAT3": return 9; case "MAT4": return 16; default: throw new Error(`GLB accessor type '${String(value)}' is invalid`); } }
