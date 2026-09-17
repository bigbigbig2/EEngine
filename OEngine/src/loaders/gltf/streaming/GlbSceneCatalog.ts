import type { GlbRangeReadableSource } from "./GlbRangeSource.js";

export interface GlbByteRange {
  readonly bufferIndex: number;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface GlbCookPrimitive {
  readonly nodeIndex: number;
  readonly meshIndex: number;
  readonly primitiveIndex: number;
  readonly materialIndex: number;
  readonly mode: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
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
  const primitives: GlbCookPrimitive[] = [];
  const cookedMeshes = new Set<number>();
  const visit = (nodeIndex: number, visited: Set<number>): void => {
    if (visited.has(nodeIndex)) throw new Error(`GLB node graph contains a cycle at node ${nodeIndex}`);
    const node = nodes[nodeIndex];
    if (!node) throw new Error(`GLB scene references missing node ${nodeIndex}`);
    visited.add(nodeIndex);
    if (node.mesh !== undefined && !cookedMeshes.has(node.mesh)) {
      const meshIndex = node.mesh;
      cookedMeshes.add(meshIndex);
      const mesh = meshes[meshIndex];
      if (!mesh) throw new Error(`GLB node ${nodeIndex} references missing mesh ${meshIndex}`);
      mesh.primitives.forEach((primitive, primitiveIndex) => {
        const mode = primitive.mode ?? 4;
        if (mode !== 4) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} uses unsupported mode ${mode}; only TRIANGLES are admitted`);
        const positionAccessor = primitive.attributes.POSITION;
        if (positionAccessor === undefined) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} has no POSITION accessor`);
        const position = accessorInfo(accessors, views, document.buffers ?? [], positionAccessor);
        if (position.componentCount !== 3) throw new Error(`GLB primitive ${meshIndex}:${primitiveIndex} POSITION is not VEC3`);
        const ranges = new Map<string, GlbByteRange>();
        for (const accessorIndex of Object.values(primitive.attributes)) addRange(ranges, accessorInfo(accessors, views, document.buffers ?? [], accessorIndex).range);
        if (primitive.indices !== undefined) addRange(ranges, accessorInfo(accessors, views, document.buffers ?? [], primitive.indices).range);
        primitives.push(Object.freeze({ nodeIndex, meshIndex, primitiveIndex, materialIndex: primitive.material ?? 0xffffffff, mode, vertexCount: position.count, triangleCount: primitive.indices === undefined ? Math.floor(position.count / 3) : indexTriangleCount(accessors, primitive.indices), ranges: Object.freeze([...ranges.values()].sort(compareRange)) }));
      });
    }
    for (const child of node.children ?? []) visit(child, visited);
    visited.delete(nodeIndex);
  };
  const sceneRoots = (document.scenes ?? []).flatMap(scene => scene.nodes ?? []);
  const roots = sceneRoots.length > 0 ? sceneRoots : nodes.map((_, index) => index);
  for (const root of roots) visit(root, new Set());
  return Object.freeze({ schemaVersion: 1, sourceIdentityHash: source.sourceIdentity.hash, scenes: Object.freeze(sceneRoots), primitives: Object.freeze(primitives.sort((a, b) => a.nodeIndex - b.nodeIndex || a.meshIndex - b.meshIndex || a.primitiveIndex - b.primitiveIndex)), sourceBytes: source.byteLength });
}

interface GltfCatalogDocument { buffers?: GltfBuffer[]; bufferViews?: GltfBufferView[]; accessors?: GltfAccessor[]; nodes?: GltfNode[]; meshes?: GltfMesh[]; scenes?: GltfScene[] }
interface GltfBuffer { byteLength?: unknown; uri?: unknown }
interface GltfBufferView { buffer?: unknown; byteOffset?: unknown; byteLength?: unknown; byteStride?: unknown }
interface GltfAccessor { bufferView?: unknown; byteOffset?: unknown; componentType?: unknown; count?: unknown; type?: unknown; sparse?: unknown }
interface GltfNode { mesh?: number; children?: number[] }
interface GltfMesh { primitives: GltfPrimitive[] }
interface GltfPrimitive { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }
interface GltfScene { nodes?: number[] }

function accessorInfo(accessors: readonly GltfAccessor[], views: readonly GltfBufferView[], buffers: readonly GltfBuffer[], index: number): { count: number; componentCount: number; range: GlbByteRange } {
  const accessor = accessors[index];
  if (!accessor || !Number.isSafeInteger(accessor.count) || (accessor.count as number) < 0 || !Number.isSafeInteger(accessor.bufferView) || !Number.isSafeInteger(accessor.componentType)) throw new Error(`GLB accessor ${index} is invalid`);
  if (accessor.sparse !== undefined) throw new Error(`GLB accessor ${index} is sparse; sparse accessors require the dedicated S8 input path`);
  const viewIndex = accessor.bufferView as number, view = views[viewIndex];
  if (!view || !Number.isSafeInteger(view.buffer) || !Number.isSafeInteger(view.byteLength) || (view.byteLength as number) < 0) throw new Error(`GLB bufferView ${viewIndex} is invalid`);
  const buffer = buffers[view.buffer as number];
  if (!buffer || !Number.isSafeInteger(buffer.byteLength)) throw new Error(`GLB accessor ${index} references an invalid buffer`);
  const componentBytes = componentTypeBytes(accessor.componentType as number), componentCount = typeComponents(accessor.type);
  const elementBytes = componentBytes * componentCount, stride = Number.isSafeInteger(view.byteStride) ? view.byteStride as number : elementBytes;
  if (stride < elementBytes || stride > 0xffffffff) throw new Error(`GLB accessor ${index} has an invalid byteStride`);
  const viewOffset = Number.isSafeInteger(view.byteOffset) ? view.byteOffset as number : 0;
  const accessorOffset = Number.isSafeInteger(accessor.byteOffset) ? accessor.byteOffset as number : 0;
  const offset = viewOffset + accessorOffset;
  const byteLength = (accessor.count as number) === 0 ? 0 : ((accessor.count as number) - 1) * stride + elementBytes;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(byteLength) || offset < 0 || accessorOffset < 0 || accessorOffset + byteLength > (view.byteLength as number) || offset + byteLength > (buffer.byteLength as number)) throw new Error(`GLB accessor ${index} range exceeds its bufferView`);
  return { count: accessor.count as number, componentCount, range: Object.freeze({ bufferIndex: view.buffer as number, byteOffset: offset, byteLength }) };
}

function indexTriangleCount(accessors: readonly GltfAccessor[], index: number): number { const accessor = accessors[index]; if (!accessor || !Number.isSafeInteger(accessor.count)) throw new Error(`GLB index accessor ${index} is invalid`); return Math.floor((accessor.count as number) / 3); }
function addRange(map: Map<string, GlbByteRange>, range: GlbByteRange): void { const key = `${range.bufferIndex}:${range.byteOffset}:${range.byteLength}`; map.set(key, range); }
function compareRange(a: GlbByteRange, b: GlbByteRange): number { return a.bufferIndex - b.bufferIndex || a.byteOffset - b.byteOffset || a.byteLength - b.byteLength; }
function componentTypeBytes(value: number): number { if (value === 5120 || value === 5121) return 1; if (value === 5122 || value === 5123) return 2; if (value === 5125 || value === 5126) return 4; throw new Error(`GLB accessor componentType ${value} is unsupported`); }
function typeComponents(value: unknown): number { switch (value) { case "SCALAR": return 1; case "VEC2": return 2; case "VEC3": return 3; case "VEC4": return 4; case "MAT2": return 4; case "MAT3": return 9; case "MAT4": return 16; default: throw new Error(`GLB accessor type '${String(value)}' is invalid`); } }
