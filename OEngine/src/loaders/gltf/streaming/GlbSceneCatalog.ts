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
}

export interface GlbCookMaterialDomain {
  readonly materialIndex: number;
  readonly alphaMode: "OPAQUE" | "MASK" | "BLEND";
  readonly doubleSided: boolean;
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
}

export interface GlbSceneCatalog {
  readonly schemaVersion: 1;
  readonly sourceIdentityHash: Uint8Array;
  readonly scenes: readonly number[];
  readonly primitives: readonly GlbCookPrimitive[];
  readonly sourceBytes: number;
}

/** Builds a compact dependency catalog without reading any BIN payload. */
export function buildGlbSceneCatalog(source: GlbRangeReadableSource): GlbSceneCatalog {
  const json = source.json;
  if (!json || typeof json !== "object") throw new Error("GLB scene catalog requires an object JSON document");
  const document = json as GltfCatalogDocument;
  const nodes = document.nodes ?? [];
  const meshes = document.meshes ?? [];
  const accessors = document.accessors ?? [];
  const views = document.bufferViews ?? [];
  const meshInstances = new Map<number, Set<number>>();
  const visit = (nodeIndex: number, visited: Set<number>): void => {
    if (visited.has(nodeIndex)) throw new Error(`GLB node graph contains a cycle at node ${nodeIndex}`);
    const node = nodes[nodeIndex];
    if (!node) throw new Error(`GLB scene references missing node ${nodeIndex}`);
    visited.add(nodeIndex);
    if (node.mesh !== undefined) {
      if (node.skin !== undefined) throw new Error(`GLB node ${nodeIndex} is skinned; the static Web geometry profile does not admit skins`);
      if (!meshes[node.mesh]) throw new Error(`GLB node ${nodeIndex} references missing mesh ${node.mesh}`);
      const instances = meshInstances.get(node.mesh) ?? new Set<number>();
      instances.add(nodeIndex); meshInstances.set(node.mesh, instances);
    }
    for (const child of node.children ?? []) visit(child, visited);
    visited.delete(nodeIndex);
  };
  const sceneRoots = (document.scenes ?? []).flatMap(scene => scene.nodes ?? []);
  const roots = sceneRoots.length > 0 ? sceneRoots : nodes.map((_, index) => index);
  for (const root of roots) visit(root, new Set());
  const primitives: GlbCookPrimitive[] = [];
  for (const [meshIndex, instanceSet] of [...meshInstances].sort(([a], [b]) => a - b)) {
    const mesh = meshes[meshIndex]!;
    const instanceNodeIndices = Object.freeze([...instanceSet].sort((a, b) => a - b));
    mesh.primitives.forEach((primitive, primitiveIndex) => {
      const mode = primitive.mode ?? 4;
      if (mode !== 4) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} uses unsupported mode ${mode}; only TRIANGLES are admitted`);
      if (primitive.targets && primitive.targets.length > 0) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} has morph targets; the static Web geometry profile does not admit them`);
      if (primitive.extensions?.KHR_draco_mesh_compression !== undefined) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} requires Draco decode before canonical cook`);
      const positionAccessor = primitive.attributes.POSITION;
      if (positionAccessor === undefined) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} has no POSITION accessor`);
      const supportedSemantics = new Set(["POSITION", "NORMAL", "TANGENT", "TEXCOORD_0", "TEXCOORD_1", "COLOR_0"]);
      for (const semantic of Object.keys(primitive.attributes)) if (!supportedSemantics.has(semantic)) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} uses unsupported attribute semantic ${semantic}`);
      const attributes: Partial<Record<GlbCookAttributeSemantic, GlbCookAccessor>> = {};
      for (const semantic of ["POSITION", "NORMAL", "TANGENT", "TEXCOORD_0", "TEXCOORD_1", "COLOR_0"] as const) {
        const accessorIndex = primitive.attributes[semantic];
        if (accessorIndex !== undefined) attributes[semantic] = accessorInfo(accessors, views, document.buffers ?? [], accessorIndex);
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
      const indices = primitive.indices === undefined ? undefined : accessorInfo(accessors, views, document.buffers ?? [], primitive.indices);
      if (indices && (indices.componentCount !== 1 || ![5121, 5123, 5125].includes(indices.componentType) || indices.normalized || indices.byteStride !== componentTypeBytes(indices.componentType) || indices.count === 0 || indices.count % 3 !== 0)) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} has an invalid index accessor`);
      if (!indices && (position.count === 0 || position.count % 3 !== 0)) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} non-indexed vertex count is not a triangle list`);
      const ranges = new Map<string, GlbByteRange>();
      for (const accessor of Object.values(attributes)) addRange(ranges, accessor);
      if (indices) addRange(ranges, indices);
      const material = materialInfo(document.materials ?? [], primitive.material);
      primitives.push(Object.freeze({ nodeIndex: instanceNodeIndices[0]!, instanceNodeIndices, meshIndex, primitiveIndex, materialIndex: material.materialIndex, mode, vertexCount: position.count, triangleCount: (indices?.count ?? position.count) / 3, attributes: Object.freeze(attributes) as GlbCookPrimitive["attributes"], ...(indices ? { indices } : {}), material, ranges: Object.freeze([...ranges.values()].sort(compareRange)) }));
    });
  }
  return Object.freeze({ schemaVersion: 1, sourceIdentityHash: source.sourceIdentity.hash, scenes: Object.freeze(sceneRoots), primitives: Object.freeze(primitives.sort((a, b) => a.nodeIndex - b.nodeIndex || a.meshIndex - b.meshIndex || a.primitiveIndex - b.primitiveIndex)), sourceBytes: source.byteLength });
}

interface GltfCatalogDocument { buffers?: GltfBuffer[]; bufferViews?: GltfBufferView[]; accessors?: GltfAccessor[]; nodes?: GltfNode[]; meshes?: GltfMesh[]; scenes?: GltfScene[]; materials?: GltfMaterial[] }
interface GltfBuffer { byteLength?: unknown; uri?: unknown }
interface GltfBufferView { buffer?: unknown; byteOffset?: unknown; byteLength?: unknown; byteStride?: unknown }
interface GltfAccessor { bufferView?: unknown; byteOffset?: unknown; componentType?: unknown; count?: unknown; type?: unknown; normalized?: unknown; sparse?: unknown }
interface GltfNode { mesh?: number; skin?: number; children?: number[] }
interface GltfMesh { primitives: GltfPrimitive[] }
interface GltfPrimitive { attributes: Record<string, number>; indices?: number; material?: number; mode?: number; targets?: unknown[]; extensions?: { KHR_draco_mesh_compression?: unknown } }
interface GltfScene { nodes?: number[] }
interface GltfMaterial { alphaMode?: unknown; doubleSided?: unknown }

function accessorInfo(accessors: readonly GltfAccessor[], views: readonly GltfBufferView[], buffers: readonly GltfBuffer[], index: number): GlbCookAccessor {
  const accessor = accessors[index];
  if (!accessor || !Number.isSafeInteger(accessor.count) || (accessor.count as number) < 0 || !Number.isSafeInteger(accessor.bufferView) || !Number.isSafeInteger(accessor.componentType)) throw new Error(`GLB accessor ${index} is invalid`);
  if (accessor.sparse !== undefined) throw new Error(`GLB accessor ${index} is sparse; sparse accessors require the dedicated S8 input path`);
  const viewIndex = accessor.bufferView as number, view = views[viewIndex];
  if (!view || !Number.isSafeInteger(view.buffer) || !Number.isSafeInteger(view.byteLength) || (view.byteLength as number) < 0) throw new Error(`GLB bufferView ${viewIndex} is invalid`);
  const buffer = buffers[view.buffer as number];
  if (!buffer || !Number.isSafeInteger(buffer.byteLength)) throw new Error(`GLB accessor ${index} references an invalid buffer`);
  if (typeof buffer.uri === "string") throw new Error(`GLB accessor ${index} uses an external buffer; external .gltf buffers require the dedicated source profile`);
  const componentBytes = componentTypeBytes(accessor.componentType as number), componentCount = typeComponents(accessor.type);
  const elementBytes = componentBytes * componentCount;
  if (view.byteStride !== undefined && (!Number.isSafeInteger(view.byteStride) || (view.byteStride as number) < 4 || (view.byteStride as number) > 252 || (view.byteStride as number) % 4 !== 0)) throw new Error(`GLB accessor ${index} has an invalid byteStride`);
  const stride = Number.isSafeInteger(view.byteStride) ? view.byteStride as number : elementBytes;
  if (stride < elementBytes || stride > 0xffffffff) throw new Error(`GLB accessor ${index} has an invalid byteStride`);
  const viewOffset = Number.isSafeInteger(view.byteOffset) ? view.byteOffset as number : 0;
  const accessorOffset = Number.isSafeInteger(accessor.byteOffset) ? accessor.byteOffset as number : 0;
  const offset = viewOffset + accessorOffset;
  const byteLength = (accessor.count as number) === 0 ? 0 : ((accessor.count as number) - 1) * stride + elementBytes;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(byteLength) || offset < 0 || accessorOffset < 0 || offset % componentBytes !== 0 || accessorOffset + byteLength > (view.byteLength as number) || offset + byteLength > (buffer.byteLength as number)) throw new Error(`GLB accessor ${index} range exceeds its bufferView or violates component alignment`);
  if (accessor.normalized !== undefined && typeof accessor.normalized !== "boolean") throw new Error(`GLB accessor ${index} normalized is not boolean`);
  return Object.freeze({ accessorIndex: index, count: accessor.count as number, componentCount, componentType: accessor.componentType as GlbCookAccessor["componentType"], normalized: accessor.normalized === true, byteStride: stride, bufferIndex: view.buffer as number, byteOffset: offset, byteLength });
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
function materialInfo(materials: readonly GltfMaterial[], index: number | undefined): GlbCookMaterialDomain { if (index === undefined) return Object.freeze({ materialIndex: 0xffffffff, alphaMode: "OPAQUE", doubleSided: false }); const material = materials[index]; if (!material) throw new Error(`GLB primitive references missing material ${index}`); const alphaMode = material.alphaMode ?? "OPAQUE"; if (alphaMode !== "OPAQUE" && alphaMode !== "MASK" && alphaMode !== "BLEND") throw new Error(`GLB material ${index} has invalid alphaMode`); if (material.doubleSided !== undefined && typeof material.doubleSided !== "boolean") throw new Error(`GLB material ${index} has invalid doubleSided`); return Object.freeze({ materialIndex: index, alphaMode, doubleSided: material.doubleSided === true }); }
function addRange(map: Map<string, GlbByteRange>, range: GlbByteRange): void { const value = Object.freeze({ bufferIndex: range.bufferIndex, byteOffset: range.byteOffset, byteLength: range.byteLength }); const key = `${value.bufferIndex}:${value.byteOffset}:${value.byteLength}`; map.set(key, value); }
function compareRange(a: GlbByteRange, b: GlbByteRange): number { return a.bufferIndex - b.bufferIndex || a.byteOffset - b.byteOffset || a.byteLength - b.byteLength; }
function componentTypeBytes(value: number): number { if (value === 5120 || value === 5121) return 1; if (value === 5122 || value === 5123) return 2; if (value === 5125 || value === 5126) return 4; throw new Error(`GLB accessor componentType ${value} is unsupported`); }
function typeComponents(value: unknown): number { switch (value) { case "SCALAR": return 1; case "VEC2": return 2; case "VEC3": return 3; case "VEC4": return 4; case "MAT2": return 4; case "MAT3": return 9; case "MAT4": return 16; default: throw new Error(`GLB accessor type '${String(value)}' is invalid`); } }
