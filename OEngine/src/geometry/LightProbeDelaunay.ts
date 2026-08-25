/**
 * LightProbeDelaunay：负责几何数据、Meshlet 或空间结构处理。
 */

import { BitSet } from "../core/BitSet.js";
import {
  TetrahedralMesh,
  TETRAHEDRAL_MESH_INVALID_NEIGHBOUR
} from "./TetrahedralMesh.js";
import { orient3d } from "./orient3d.js";
import { insphere } from "./insphere.js";

const SUPER_DIRECTIONS = new Float32Array([
  Math.sqrt(8 / 9), 0, -1 / 3,
  -Math.sqrt(2 / 9), Math.sqrt(2 / 3), -1 / 3,
  -Math.sqrt(2 / 9), -Math.sqrt(2 / 3), -1 / 3,
  0, 0, 1
]);

class Workspace {
  readonly deleted: number[] = [];
  deletedSize = 0;
  readonly boundary: number[] = [];
  boundarySize = 0;

  pushBoundary(a: number, b: number, c: number, d: number, neighbour: number): void {
    const offset = 5 * this.boundarySize++;
    this.boundary[offset] = a;
    this.boundary[offset + 1] = b;
    this.boundary[offset + 2] = c;
    this.boundary[offset + 3] = d;
    this.boundary[offset + 4] = neighbour;
  }

  pushDeleted(tetra: number): void {
    this.deleted[this.deletedSize++] = tetra;
  }

  reset(): void {
    this.deletedSize = 0;
    this.boundarySize = 0;
  }
}

export function buildLightProbeTetrahedralMesh(
  mesh: TetrahedralMesh,
  sourcePositions: Float32Array,
  pointCount = sourcePositions.length / 3
): boolean {
  if (pointCount < 4) return false;
  mesh.ensureCapacity(pointCount + 1);
  const workspace = new Workspace();
  const deleted = BitSet.fixedSize(pointCount);
  const positions = new Float32Array(3 * (pointCount + 4));
  positions.set(sourcePositions.subarray(0, Math.min(sourcePositions.length, positions.length)));
  buildSuperTetra(positions, 3 * pointCount, positions, pointCount);

  const initial = mesh.allocate();
  mesh.setVertexIndex(initial, 0, pointCount);
  mesh.setVertexIndex(initial, 1, pointCount + 1);
  mesh.setVertexIndex(initial, 2, pointCount + 2);
  mesh.setVertexIndex(initial, 3, pointCount + 3);

  let containing = 0;
  for (let point = 0; point < pointCount; point++) {
    containing = walkToContainingTetra(mesh, positions, containing, point);
    markCavity(mesh, positions, deleted, workspace, containing, point);
    containing = rebuildCavity(mesh, deleted, workspace);
  }
  mesh.removeTetrasConnectedToPoints(pointCount, pointCount + 3);
  return true;
}

function buildSuperTetra(
  output: Float32Array,
  outputOffset: number,
  points: Float32Array,
  count: number
): void {
  if (count <= 0) return;
  let x = points[0]!;
  let y = points[1]!;
  let z = points[2]!;
  let d0 = dotDirection(x, y, z, 0);
  let d1 = dotDirection(x, y, z, 3);
  let d2 = dotDirection(x, y, z, 6);
  let d3 = dotDirection(x, y, z, 9);
  let min0 = d0;
  let min1 = d1;
  let min2 = d2;
  let min3 = d3;
  for (let point = 1; point < count; point++) {
    const offset = 3 * point;
    x = points[offset]!;
    y = points[offset + 1]!;
    z = points[offset + 2]!;
    d0 = dotDirection(x, y, z, 0);
    d1 = dotDirection(x, y, z, 3);
    d2 = dotDirection(x, y, z, 6);
    d3 = dotDirection(x, y, z, 9);
    min0 = Math.min(min0, d0);
    min1 = Math.min(min1, d1);
    min2 = Math.min(min2, d2);
    min3 = Math.min(min3, d3);
  }
  min0 -= 10;
  min1 -= 10;
  min2 -= 10;
  min3 -= 10;
  solvePlanes(output, outputOffset, 0, -min0, 3, -min1, 9, -min3);
  solvePlanes(output, outputOffset + 3, 3, -min1, 6, -min2, 9, -min3);
  solvePlanes(output, outputOffset + 6, 0, -min0, 3, -min1, 6, -min2);
  solvePlanes(output, outputOffset + 9, 6, -min2, 0, -min0, 9, -min3);
}

function walkToContainingTetra(
  mesh: TetrahedralMesh,
  positions: Float32Array,
  start: number,
  point: number
): number {
  let previousFace = 4;
  let tetra = start;
  for (;;) {
    let face: number;
    for (face = 0; face < 4; face++) {
      const corner1 = (face + 1) & 3;
      const corner2 = (face & 2) ^ 3;
      const corner3 = (face + 3) & 2;
      if (
        face !== previousFace &&
        orientByIndex(
          positions,
          mesh.getVertexIndex(tetra, corner1),
          mesh.getVertexIndex(tetra, corner2),
          mesh.getVertexIndex(tetra, corner3),
          point
        ) < 0
      ) {
        const neighbour = mesh.getNeighbour(tetra, face);
        tetra = neighbour >>> 2;
        previousFace = neighbour & 3;
        break;
      }
    }
    if (face === 4) return tetra;
  }
}

function markCavity(
  mesh: TetrahedralMesh,
  positions: Float32Array,
  marked: BitSet,
  workspace: Workspace,
  start: number,
  point: number
): void {
  workspace.pushDeleted(start);
  marked.set(start, true);
  for (let index = workspace.deletedSize - 1; index < workspace.deletedSize; index++) {
    const tetra = workspace.deleted[index]!;
    for (let face = 0; face < 4; face++) {
      const neighbour = mesh.getNeighbour(tetra, face);
      const corner1 = (1 << face) & 3;
      const corner2 = (face + 2) % 3;
      const corner3 = 1 + (2 & ~((face + 1) >> 1));
      if (neighbour === TETRAHEDRAL_MESH_INVALID_NEIGHBOUR) {
        workspace.pushBoundary(
          point,
          mesh.getVertexIndex(tetra, corner1),
          mesh.getVertexIndex(tetra, corner2),
          mesh.getVertexIndex(tetra, corner3),
          neighbour
        );
        continue;
      }
      const adjacent = neighbour >>> 2;
      if (marked.get(adjacent)) continue;
      if (
        inSphereByIndex(
          positions,
          mesh.getVertexIndex(adjacent, 0),
          mesh.getVertexIndex(adjacent, 1),
          mesh.getVertexIndex(adjacent, 2),
          mesh.getVertexIndex(adjacent, 3),
          point
        ) < 0
      ) {
        workspace.pushBoundary(
          point,
          mesh.getVertexIndex(tetra, corner1),
          mesh.getVertexIndex(tetra, corner2),
          mesh.getVertexIndex(tetra, corner3),
          neighbour
        );
      } else {
        workspace.pushDeleted(adjacent);
        marked.set(adjacent, true);
      }
    }
  }
}

function rebuildCavity(
  mesh: TetrahedralMesh,
  marked: BitSet,
  workspace: Workspace
): number {
  let deletedCount = workspace.deletedSize;
  const boundaryCount = workspace.boundarySize;
  const deleted = workspace.deleted;
  if (boundaryCount > deletedCount) {
    for (let i = deletedCount; i < boundaryCount; i++) deleted[i] = mesh.allocate();
    deletedCount = boundaryCount;
  }
  const boundary = workspace.boundary;
  const deletedOffset = deletedCount - boundaryCount;
  for (let i = 0; i < boundaryCount; i++) {
    const tetra = deleted[i + deletedOffset]!;
    const offset = 5 * i;
    mesh.setVertexIndex(tetra, 0, boundary[offset]!);
    mesh.setVertexIndex(tetra, 1, boundary[offset + 1]!);
    mesh.setVertexIndex(tetra, 2, boundary[offset + 2]!);
    mesh.setVertexIndex(tetra, 3, boundary[offset + 3]!);
    const neighbour = boundary[offset + 4]!;
    mesh.setNeighbour(tetra, 0, neighbour);
    if (neighbour !== TETRAHEDRAL_MESH_INVALID_NEIGHBOUR) {
      mesh.setNeighbour(neighbour >>> 2, neighbour & 3, tetra << 2);
    }
    marked.set(tetra, false);
  }

  let openFaces = 0;
  for (let i = 0; i < boundaryCount; i++) {
    const tetra = deleted[deletedOffset + i]!;
    for (let face = 0; face < 3; face++) {
      const vertex1 = mesh.getVertexIndex(tetra, ((face + 1) % 3) + 1);
      const vertex2 = mesh.getVertexIndex(tetra, ((face + 2) % 3) + 1);
      const tetraFace = face + 1;
      const packedFace = (tetra << 2) | (tetraFace & 3);
      let match = 0;
      while (
        match < openFaces &&
        (boundary[3 * match] !== vertex1 || boundary[3 * match + 1] !== vertex2)
      ) match++;
      if (match === openFaces) {
        const offset = 3 * openFaces++;
        boundary[offset] = vertex2;
        boundary[offset + 1] = vertex1;
        boundary[offset + 2] = packedFace;
      } else {
        const other = boundary[3 * match + 2]!;
        mesh.setNeighbour(tetra, tetraFace, other);
        mesh.setNeighbour(other >>> 2, other & 3, packedFace);
        openFaces--;
        if (match < openFaces) {
          const source = 3 * openFaces;
          const destination = 3 * match;
          boundary[destination] = boundary[source]!;
          boundary[destination + 1] = boundary[source + 1]!;
          boundary[destination + 2] = boundary[source + 2]!;
        }
      }
    }
  }
  for (let i = 0; i < deletedOffset; i++) mesh.delete(deleted[i]!);
  const next = deleted[deletedOffset]!;
  workspace.reset();
  return next;
}

function orientByIndex(
  positions: Float32Array,
  a: number,
  b: number,
  c: number,
  d: number
): number {
  const ia = 3 * a;
  const ib = 3 * b;
  const ic = 3 * c;
  const id = 3 * d;
  return orient3d(
    positions[ia]!, positions[ia + 1]!, positions[ia + 2]!,
    positions[ib]!, positions[ib + 1]!, positions[ib + 2]!,
    positions[ic]!, positions[ic + 1]!, positions[ic + 2]!,
    positions[id]!, positions[id + 1]!, positions[id + 2]!
  );
}

function inSphereByIndex(
  positions: Float32Array,
  a: number,
  b: number,
  c: number,
  d: number,
  point: number
): number {
  const ia = 3 * a;
  const ib = 3 * b;
  const ic = 3 * c;
  const id = 3 * d;
  const ip = 3 * point;
  return -insphere(
    positions[ia]!, positions[ia + 1]!, positions[ia + 2]!,
    positions[ib]!, positions[ib + 1]!, positions[ib + 2]!,
    positions[ic]!, positions[ic + 1]!, positions[ic + 2]!,
    positions[id]!, positions[id + 1]!, positions[id + 2]!,
    positions[ip]!, positions[ip + 1]!, positions[ip + 2]!
  );
}

function solvePlanes(
  output: Float32Array,
  offset: number,
  ai: number,
  ad: number,
  bi: number,
  bd: number,
  ci: number,
  cd: number
): boolean {
  const a0 = SUPER_DIRECTIONS[ai]!;
  const a1 = SUPER_DIRECTIONS[ai + 1]!;
  const a2 = SUPER_DIRECTIONS[ai + 2]!;
  const b0 = SUPER_DIRECTIONS[bi]!;
  const b1 = SUPER_DIRECTIONS[bi + 1]!;
  const b2 = SUPER_DIRECTIONS[bi + 2]!;
  const c0 = SUPER_DIRECTIONS[ci]!;
  const c1 = SUPER_DIRECTIONS[ci + 1]!;
  const c2 = SUPER_DIRECTIONS[ci + 2]!;
  const cross0 = b1 * c2 - b2 * c1;
  const cross1 = b2 * c0 - b0 * c2;
  const cross2 = b0 * c1 - b1 * c0;
  const crossB0 = c1 * a2 - c2 * a1;
  const crossB1 = c2 * a0 - c0 * a2;
  const crossB2 = c0 * a1 - c1 * a0;
  const crossC0 = a1 * b2 - a2 * b1;
  const crossC1 = a2 * b0 - a0 * b2;
  const crossC2 = a0 * b1 - a1 * b0;
  const determinant = a0 * cross0 + a1 * cross1 + a2 * cross2;
  if (determinant === 0) return false;
  const inverse = 1 / determinant;
  const negatedA = -ad;
  output[offset] = (cross0 * negatedA - crossB0 * bd - crossC0 * cd) * inverse;
  output[offset + 1] = (cross1 * negatedA - crossB1 * bd - crossC1 * cd) * inverse;
  output[offset + 2] = (cross2 * negatedA - crossB2 * bd - crossC2 * cd) * inverse;
  return true;
}

function dotDirection(x: number, y: number, z: number, offset: number): number {
  return x * SUPER_DIRECTIONS[offset]! +
    y * SUPER_DIRECTIONS[offset + 1]! +
    z * SUPER_DIRECTIONS[offset + 2]!;
}
