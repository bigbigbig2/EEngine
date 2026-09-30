import { readFile } from "node:fs/promises";
import { encodeWebCanonicalGeometryV1, encodeWebGeometryCookRecipeV1,
  cookWebGeometryWasmV1 } from "../../.test-dist/assets/web-cook/wasm/WebGeometryCookerAbi.js";

async function cookerModule() {
  const path = new URL("../../src/assets/web-cook/wasm/vendor/oengine-web-geometry-cooker.mjs", import.meta.url);
  const { default: factory } = await import(path.href);
  const wasm = await readFile(new URL("oengine-web-geometry-cooker.wasm", path));
  return factory({ instantiateWasm(imports, receive) {
    WebAssembly.instantiate(wasm, imports).then(result => receive(result.instance)); return {};
  } });
}

export async function cookSurfacePlane({ seam = false, mirroredUv = false, attributeSeam } = {}) {
  const module = await cookerModule();
  const positions = [[-1, -1, 0.5], [1, -1, 0.5], [-1, 1, 0.5], [1, 1, 0.5]];
  const split = seam || mirroredUv || attributeSeam !== undefined;
  const corners = split ? [0, 1, 2, 1, 3, 2] : [0, 1, 2, 3];
  const vertices = new Float32Array(corners.length * 18);
  corners.forEach((source, index) => {
    const position = positions[source];
    const offset = index * 18;
    vertices.set(position, offset); vertices[offset + 5] = 1;
    vertices.set([1, 0, 0, 1], offset + 6);
    const uv = [(position[0] + 1) / 2, (position[1] + 1) / 2];
    if (seam && index >= 3) uv[0] += 0.25;
    if (mirroredUv && index >= 3) uv[0] = 1 - uv[0];
    vertices.set(uv, offset + 10); vertices.set(uv, offset + 12);
    vertices.set([1, 1, 1, 1], offset + 14);
    if (index >= 3) {
      if (attributeSeam === "normal") vertices.set([0.6, 0, 0.8], offset + 3);
      if (attributeSeam === "tangent") vertices[offset + 9] = -1;
      if (attributeSeam === "color") vertices[offset + 14] = 0.5;
    }
  });
  const canonical = encodeWebCanonicalGeometryV1([{ materialId: 0, meshletFlags: 17,
    attributeMask: 63, normalUvSet: 0, vertices,
    indices: new Uint32Array(split ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 1, 3, 2]) }]);
  const cooked = cookWebGeometryWasmV1(module, canonical, encodeWebGeometryCookRecipeV1(), 8 * 1024 * 1024);
  const sections = cooked.descriptorSections();
  const page = new Uint8Array(cooked.copyPage(0)); cooked.release();
  return { sections, page };
}

export async function cookSurfaceGrid() {
  const module = await cookerModule();
  const side = 97;
  const vertices = new Float32Array(side * side * 18);
  for (let row = 0; row < side; row++) for (let column = 0; column < side; column++) {
    const offset = (row * side + column) * 18;
    vertices.set([column, row, 0, 0, 0, 1, 1, 0, 0, 1,
      column / (side - 1), row / (side - 1), column / (side - 1), row / (side - 1),
      1, 1, 1, 1], offset);
  }
  const indices = [];
  for (let row = 0; row + 1 < side; row++) for (let column = 0; column + 1 < side; column++) {
    const first = row * side + column;
    indices.push(first, first + 1, first + side, first + 1, first + side + 1, first + side);
  }
  const cooked = cookWebGeometryWasmV1(module, encodeWebCanonicalGeometryV1([
    { materialId: 0, meshletFlags: 1, attributeMask: 63, vertices, indices: new Uint32Array(indices) }
  ]), encodeWebGeometryCookRecipeV1({ groupTargetMeshlets: 128, minimumLodReduction: 1 }), 16 * 1024 * 1024);
  const sections = cooked.descriptorSections();
  const pageCount = cooked.pageCount;
  const pages = Array.from({ length: pageCount }, (_, index) => new Uint8Array(cooked.copyPage(index)));
  cooked.release();
  return { sections, pages, primitiveCount: indices.length / 3 };
}
