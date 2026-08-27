import {
  cookGeometryAssetPackage,
  createGeometryCookRecipe,
  createSourceGeometry,
  openGeometryAssetPackage
} from "../../OEngine/src/index.ts";

const status = requiredElement<HTMLElement>("status");
const summary = requiredElement<HTMLElement>("summary");
const variantsBody = requiredElement<HTMLTableSectionElement>("variants");
const result = requiredElement<HTMLElement>("result");

void run().catch((error: unknown) => {
  status.textContent = "验证失败";
  status.className = "error";
  result.textContent = error instanceof Error
    ? error.stack ?? error.message
    : String(error);
  console.error(error);
});

async function run(): Promise<void> {
  const source = buildGridSourceGeometry(16, 16);
  const recipes = [
    ["32/64", createGeometryCookRecipe({
      meshletMaxVertices: 32,
      meshletMaxTriangles: 64
    })],
    ["64/64", createGeometryCookRecipe({
      meshletMaxVertices: 64,
      meshletMaxTriangles: 64
    })],
    ["64/128", createGeometryCookRecipe({
      meshletMaxVertices: 64,
      meshletMaxTriangles: 128
    })]
  ] as const;
  const artifacts = [];
  for (const [name, recipe] of recipes) {
    const cooked = await cookGeometryAssetPackage(source, recipe);
    const reopened = await openGeometryAssetPackage(cooked.bytes);
    artifacts.push({
      name,
      valid: reopened.validate().valid,
      ...cooked.evidence
    });
  }
  const deterministicA = await cookGeometryAssetPackage(source, recipes[2][1]);
  const deterministicB = await cookGeometryAssetPackage(source, recipes[2][1]);
  const deterministic = bytesEqual(deterministicA.bytes, deterministicB.bytes);
  const passed =
    deterministic &&
    artifacts.every((artifact) =>
      artifact.valid && artifact.meshletTriangleCount === source.triangleCount
    ) &&
    artifacts.map((artifact) => artifact.meshletCount).join(",") === "13,8,6";

  variantsBody.innerHTML = artifacts.map((artifact) => `
    <tr>
      <td>${artifact.name}</td>
      <td>${artifact.meshletCount}</td>
      <td>${artifact.meshletVertexIndexCount}</td>
      <td>${artifact.meshletTriangleCount}</td>
      <td>${artifact.packageBytes}</td>
    </tr>
  `).join("");
  status.textContent = passed ? "验证通过" : "验证失败";
  status.className = passed ? "ok" : "error";
  summary.innerHTML = passed
    ? `<strong>PASS</strong>：512 triangles，variants 13 / 8 / 6 Meshlets，byte-identical rebuild。`
    : "Meshlet coverage、variant golden 或 deterministic rebuild 未通过。";
  result.textContent = JSON.stringify({
    passed,
    deterministic,
    source: {
      vertices: source.vertexCount,
      triangles: source.triangleCount
    },
    variants: artifacts
  }, null, 2);
  if (!passed) throw new Error("R2-B-01 Meshlet Cooker browser validation failed");
}

function buildGridSourceGeometry(
  widthSegments: number,
  heightSegments: number
) {
  const row = widthSegments + 1;
  const positions = new Float32Array(row * (heightSegments + 1) * 3);
  let vertexOffset = 0;
  for (let y = 0; y <= heightSegments; y++) {
    for (let x = 0; x <= widthSegments; x++) {
      positions[vertexOffset++] = x;
      positions[vertexOffset++] = y;
      positions[vertexOffset++] = 0;
    }
  }
  const indices = new Uint32Array(widthSegments * heightSegments * 6);
  let indexOffset = 0;
  for (let y = 0; y < heightSegments; y++) {
    for (let x = 0; x < widthSegments; x++) {
      const a = y * row + x;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices[indexOffset++] = a;
      indices[indexOffset++] = b;
      indices[indexOffset++] = c;
      indices[indexOffset++] = c;
      indices[indexOffset++] = b;
      indices[indexOffset++] = d;
    }
  }
  return createSourceGeometry({
    sourceId: `browser-grid:${widthSegments}:${heightSegments}`,
    indices,
    attributes: [{
      semantic: "position",
      componentCount: 3,
      data: positions
    }]
  });
}

function bytesEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing #${id}`);
  return element as T;
}
