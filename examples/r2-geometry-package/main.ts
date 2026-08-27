import {
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  createSourceGeometry,
  openGeometryAssetPackage,
  selectGeometryHierarchy
} from "../../OEngine/src/index.ts";

const status = requiredElement<HTMLElement>("status");
const summary = requiredElement<HTMLElement>("summary");
const result = requiredElement<HTMLElement>("result");

void run().catch((error: unknown) => {
  status.textContent = "验证失败";
  status.className = "error";
  result.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(error);
});

async function run(): Promise<void> {
  const source = buildSource(32, 32);
  const recipe = createGeometryCookRecipe();
  const first = await cookGeometryAssetPackage(source, recipe);
  // Package load is intentionally only open + validate. It does not import or
  // execute meshoptimizer, hierarchy build or BVH build.
  const reopened = await openGeometryAssetPackage(first.bytes);
  const second = await cookGeometryAssetPackage(source, recipe);
  const projection = {
    cameraPosition: [16, 16, 48] as [number, number, number],
    verticalFovRadians: Math.PI / 3,
    viewportHeight: 1080,
    maxAxisScale: 1
  };
  const coarse = selectGeometryHierarchy(reopened, {
    ...projection,
    sseThreshold: Number.MAX_VALUE
  });
  const fine = selectGeometryHierarchy(reopened, {
    ...projection,
    sseThreshold: 0
  });
  const passed =
    reopened.validate().valid &&
    bytesEqual(first.bytes, second.bytes) &&
    reopened.vertexStreamDescriptors.length === 4 &&
    reopened.materialRanges.length === 2 &&
    reopened.clusters.length > 0 &&
    reopened.bvh8Nodes.length > 0 &&
    coarse.selectedClusterIndices.length === 1 &&
    fine.selectedClusterIndices.length > 1;

  status.textContent = passed ? "验证通过" : "验证失败";
  status.className = passed ? "ok" : "error";
  summary.innerHTML = passed
    ? `<strong>PASS</strong>：完整 Geometry package 可确定性重建、纯 reopen，并通过 hierarchy/BVH8/streams/material validator。`
    : "完整 Geometry package 的确定性、选择器或 validator 未闭环。";
  result.textContent = JSON.stringify({
    passed,
    pureReopen: reopened.package.manifest.contentHash === first.evidence.contentHash,
    deterministic: bytesEqual(first.bytes, second.bytes),
    source: { vertices: source.vertexCount, triangles: source.triangleCount },
    package: {
      streams: reopened.vertexStreamDescriptors.map((stream) => ({
        semantic: stream.semantic,
        type: stream.dataType,
        components: stream.componentCount,
        bytes: stream.dataByteLength
      })),
      materials: reopened.materialRanges,
      meshlets: reopened.meshlets.length,
      clusters: reopened.clusters.length,
      bvh8Nodes: reopened.bvh8Nodes.length,
      depth: first.evidence.hierarchyDepth,
      cookTimeMs: first.timing.cookTimeMs,
      bytes: first.evidence.packageBytes,
      hashes: {
        source: first.evidence.sourceHash,
        recipe: first.evidence.recipeHash,
        content: first.evidence.contentHash,
        file: first.evidence.packageHash
      },
      geometricError: first.evidence.geometricError,
      warnings: first.evidence.warnings
    },
    selector: {
      coarse: { selected: coarse.selectedClusterIndices.length, visited: coarse.visitedClusters },
      fine: { selected: fine.selectedClusterIndices.length, visited: fine.visitedClusters }
    }
  }, null, 2);
  if (!passed) throw new Error("R2-B full Geometry package browser validation failed");
}

function buildSource(widthSegments: number, heightSegments: number) {
  const row = widthSegments + 1;
  const vertexCount = row * (heightSegments + 1);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const tangents = new Float32Array(vertexCount * 4);
  const uv0 = new Uint16Array(vertexCount * 2);
  let vertex = 0;
  for (let y = 0; y <= heightSegments; y++) {
    for (let x = 0; x <= widthSegments; x++, vertex++) {
      positions.set([x, y, Math.sin(x * 0.2) * Math.cos(y * 0.2)], vertex * 3);
      normals.set([0, 0, 1], vertex * 3);
      tangents.set([1, 0, 0, 1], vertex * 4);
      uv0[vertex * 2] = Math.round(x / widthSegments * 65535);
      uv0[vertex * 2 + 1] = Math.round(y / heightSegments * 65535);
    }
  }
  const indices = new Uint32Array(widthSegments * heightSegments * 6);
  let offset = 0;
  for (let y = 0; y < heightSegments; y++) {
    for (let x = 0; x < widthSegments; x++) {
      const a = y * row + x;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices.set([a, b, c, c, b, d], offset);
      offset += 6;
    }
  }
  const triangleCount = indices.length / 3;
  return createSourceGeometry({
    sourceId: "r2-b-browser-full-package",
    indices,
    attributes: [
      { semantic: "position", componentCount: 3, data: positions },
      { semantic: "normal", componentCount: 3, data: normals },
      { semantic: "tangent", componentCount: 4, data: tangents },
      { semantic: "uv0", componentCount: 2, normalized: true, data: uv0 }
    ],
    materialRanges: [
      { firstTriangle: 0, triangleCount: triangleCount / 2, materialId: 7, alphaMode: "opaque", doubleSided: false },
      { firstTriangle: triangleCount / 2, triangleCount: triangleCount / 2, materialId: 11, alphaMode: "mask", doubleSided: true }
    ]
  });
}

function bytesEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}
