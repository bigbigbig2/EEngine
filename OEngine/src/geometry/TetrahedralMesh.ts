/**
 * TetrahedralMesh：负责几何数据、Meshlet 或空间结构处理。
 */

import { base64Decode, base64Encode } from "../core/base64Codec.js";
import { orient3d } from "./orient3d.js";
import {
  BinaryEndianness,
  BinaryReader
} from "../loaders/BinaryReader.js";

export const TETRAHEDRAL_MESH_RECORD_BYTES = 32;
export const TETRAHEDRAL_MESH_INVALID_NEIGHBOUR = 0xffff_ffff;

const TETRA_WORDS = TETRAHEDRAL_MESH_RECORD_BYTES >>> 2;

export class TetrahedralMesh {
  readonly isTetrahedralMesh = true;

  private bufferValue: ArrayBuffer;
  private dataUint32Value: Uint32Array;
  private viewValue: DataView;
  private capacityValue: number;
  private usedEnd = 0;
  private readonly free: number[] = [];
  private freePointer = 0;

  constructor(capacity = 128) {
    this.bufferValue = new ArrayBuffer(capacity * TETRAHEDRAL_MESH_RECORD_BYTES);
    this.dataUint32Value = new Uint32Array(this.bufferValue);
    this.viewValue = new DataView(this.bufferValue);
    this.capacityValue = capacity;
  }

  get data_buffer(): ArrayBuffer {
    return this.bufferValue;
  }

  get isCompacted(): boolean {
    return this.freePointer === 0;
  }

  get count(): number {
    return this.usedEnd - this.freePointer;
  }

  forEach(callback: (tetra: number, mesh: TetrahedralMesh) => void, thisArg?: unknown): void {
    for (let tetra = 0; tetra < this.usedEnd; tetra++) {
      if (this.exists(tetra)) callback.call(thisArg, tetra, this);
    }
  }

  getLive(): number[] {
    const result: number[] = [];
    this.forEach((tetra) => result.push(tetra));
    return result;
  }

  clear(): void {
    this.dataUint32Value.fill(0, 0, this.usedEnd);
    this.usedEnd = 0;
    this.freePointer = 0;
    this.free.splice(0, this.free.length);
  }

  setCapacity(capacity: number): void {
    if (capacity === this.capacityValue) return;
    if (capacity < this.capacityValue && capacity < this.usedEnd) {
      throw new Error(
        "Reducing capacity would result in dropping information. This is an illegal operation. If you need to reduce capacity - either drop data or compact the layout first."
      );
    }
    const next = new ArrayBuffer(capacity * TETRAHEDRAL_MESH_RECORD_BYTES);
    new Uint8Array(next).set(
      new Uint8Array(this.bufferValue, 0, Math.min(this.bufferValue.byteLength, next.byteLength))
    );
    this.bufferValue = next;
    this.viewValue = new DataView(next);
    this.dataUint32Value = new Uint32Array(next);
    this.capacityValue = capacity;
  }

  getCapacity(): number {
    return this.capacityValue;
  }

  size(): number {
    console.warn("Deprecated, use .count instead");
    return this.usedEnd;
  }

  growCapacity(required: number): void {
    const current = this.capacityValue;
    this.setCapacity(Math.max(required, Math.ceil(1.2 * current), current + 32));
  }

  ensureCapacity(required: number): void {
    if (this.capacityValue < required) this.growCapacity(required);
  }

  exists(tetra: number): boolean {
    if (tetra < 0 || tetra >= this.usedEnd) return false;
    for (let i = 0; i < this.freePointer; i++) {
      if (tetra === this.free[i]) return false;
    }
    return true;
  }

  getNeighbour(tetra: number, face: number): number {
    return this.viewValue.getUint32(
      TETRAHEDRAL_MESH_RECORD_BYTES * tetra + 4 * (4 + face)
    );
  }

  setNeighbour(tetra: number, face: number, neighbour: number): void {
    this.viewValue.setUint32(
      TETRAHEDRAL_MESH_RECORD_BYTES * tetra + 4 * (4 + face),
      neighbour
    );
  }

  getVertexIndex(tetra: number, corner: number): number {
    return this.viewValue.getUint32(
      TETRAHEDRAL_MESH_RECORD_BYTES * tetra + 4 * corner
    );
  }

  setVertexIndex(tetra: number, corner: number, vertex: number): void {
    this.viewValue.setUint32(
      TETRAHEDRAL_MESH_RECORD_BYTES * tetra + 4 * corner,
      vertex
    );
  }

  tetContainsVertex(tetra: number, vertex: number): boolean {
    for (let corner = 0; corner < 4; corner++) {
      if (this.getVertexIndex(tetra, corner) === vertex) return true;
    }
    return false;
  }

  allocate(): number {
    if (this.freePointer > 0) {
      this.freePointer--;
      return this.free[this.freePointer]!;
    }
    const tetra = this.usedEnd;
    this.usedEnd++;
    if (tetra >= this.capacityValue) this.growCapacity(tetra);
    for (let face = 0; face < 4; face++) {
      this.setNeighbour(tetra, face, TETRAHEDRAL_MESH_INVALID_NEIGHBOUR);
    }
    return tetra;
  }

  append(a: number, b: number, c: number, d: number): number {
    const tetra = this.allocate();
    const byteOffset = tetra * TETRAHEDRAL_MESH_RECORD_BYTES;
    this.viewValue.setUint32(byteOffset, a);
    this.viewValue.setUint32(byteOffset + 4, b);
    this.viewValue.setUint32(byteOffset + 8, c);
    this.viewValue.setUint32(byteOffset + 12, d);
    for (let face = 0; face < 4; face++) {
      this.viewValue.setUint32(
        byteOffset + 16 + face * 4,
        TETRAHEDRAL_MESH_INVALID_NEIGHBOUR
      );
    }
    return tetra;
  }

  disconnect(tetra: number): void {
    for (let face = 0; face < 4; face++) {
      const neighbour = this.getNeighbour(tetra, face);
      if (neighbour !== TETRAHEDRAL_MESH_INVALID_NEIGHBOUR) {
        this.setNeighbour(
          neighbour >>> 2,
          neighbour & 3,
          TETRAHEDRAL_MESH_INVALID_NEIGHBOUR
        );
      }
    }
  }

  delete(tetra: number): void {
    if (tetra === this.usedEnd - 1) {
      this.usedEnd--;
    } else {
      this.free[this.freePointer++] = tetra;
    }
  }

  removeTetrasConnectedToPoints(first: number, last: number): void {
    for (let tetra = this.usedEnd - 1; tetra >= 0; tetra--) {
      for (let corner = 0; corner < 4; corner++) {
        const vertex = this.getVertexIndex(tetra, corner);
        if (vertex >= first && vertex <= last) {
          if (!this.exists(tetra)) break;
          this.disconnect(tetra);
          this.delete(tetra);
          break;
        }
      }
    }
  }

  walkToTetraContainingPoint(
    x: number,
    y: number,
    z: number,
    points: number[],
    startTetrahedron = 0
  ): number {
    let face: number;
    let previousFace = 4;
    let tetra = startTetrahedron;
    for (let remaining = this.count + 1; remaining > 0; remaining--) {
      for (face = 0; face < 4; face++) {
        const corner1 = (face + 1) & 3;
        const corner2 = (face & 2) ^ 3;
        const corner3 = (face + 3) & 2;
        const a = 3 * this.getVertexIndex(tetra, corner1);
        const b = 3 * this.getVertexIndex(tetra, corner2);
        const c = 3 * this.getVertexIndex(tetra, corner3);
        if (
          face !== previousFace &&
          orient3d(
            points[a]!,
            points[a + 1]!,
            points[a + 2]!,
            points[b]!,
            points[b + 1]!,
            points[b + 2]!,
            points[c]!,
            points[c + 1]!,
            points[c + 2]!,
            x,
            y,
            z
          ) < 0
        ) {
          const neighbour = this.getNeighbour(tetra, face);
          if (neighbour === TETRAHEDRAL_MESH_INVALID_NEIGHBOUR) return -1;
          tetra = neighbour >>> 2;
          previousFace = neighbour & 3;
          break;
        }
      }
      if (face === 4) return tetra;
    }
    throw new Error(
      "Failed to find tet, likely mesh is corrupted or non-convex"
    );
  }

  relocate(source: number, destination: number): void {
    if (source === destination) return;
    for (let face = 0; face < 4; face++) {
      const neighbour = this.getNeighbour(source, face);
      if (neighbour !== TETRAHEDRAL_MESH_INVALID_NEIGHBOUR) {
        this.setNeighbour(
          neighbour >>> 2,
          neighbour & 3,
          (destination << 2) | (face & 3)
        );
      }
    }
    this.dataUint32Value.copyWithin(
      destination * TETRA_WORDS,
      source * TETRA_WORDS,
      source * TETRA_WORDS + TETRA_WORDS
    );
  }

  compact(): number {
    this.free
      .splice(0, this.freePointer, ...this.free.slice(0, this.freePointer).sort((a, b) => b - a));
    let relocated = 0;
    let freeStart = 0;
    while (this.freePointer > freeStart) {
      const lastLiveCandidate = this.usedEnd - 1;
      if (this.free[freeStart]! >= lastLiveCandidate) {
        freeStart++;
        this.usedEnd = lastLiveCandidate;
        continue;
      }
      const destination = this.free[this.freePointer - 1]!;
      this.freePointer--;
      if (lastLiveCandidate <= destination) continue;
      this.relocate(lastLiveCandidate, destination);
      relocated++;
      this.usedEnd--;
    }
    this.free.splice(0, this.free.length);
    this.freePointer = 0;
    return relocated;
  }

  serialize(buffer: BinaryReader): void {
    buffer.writeUint32(1);
    buffer.writeUintVar(this.usedEnd);
    buffer.writeUintVar(this.freePointer);
    buffer.writeUint32Array(
      this.dataUint32Value,
      0,
      TETRA_WORDS * this.usedEnd
    );
    buffer.writeUint32Array(this.free, 0, this.freePointer);
  }

  deserialize(buffer: BinaryReader): void {
    const version = buffer.readUint32();
    if (version !== 1) {
      throw new Error(
        `Unsupported version number, expected 1, instead got ${version}`
      );
    }
    this.usedEnd = buffer.readUintVar();
    this.freePointer = buffer.readUintVar();
    this.ensureCapacity(this.usedEnd);
    buffer.readUint32Array(
      this.dataUint32Value,
      0,
      TETRA_WORDS * this.usedEnd
    );
    buffer.readUint32Array(this.free, 0, this.freePointer);
  }

  serialize_base64(): string {
    const buffer = new BinaryReader();
    buffer.endianness = BinaryEndianness.LittleEndian;
    this.serialize(buffer);
    buffer.trim();
    return base64Encode(buffer.data);
  }

  deserialize_base64(value: string): void {
    const data = base64Decode(value);
    const buffer = BinaryReader.fromArrayBuffer(data);
    buffer.endianness = BinaryEndianness.LittleEndian;
    this.deserialize(buffer);
  }
}
