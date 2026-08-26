/**
 * MeshletGpuTable：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { MeshletGeometryBase } from "../geometry/BoxGeometry.js";
import {
  MESHLET_HEADER_BYTES,
  MESHLET_HEADER_WORD_OFF
} from "../geometry/niMeshlets.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import {
  MeshletBatchAllocation,
  MeshletGpuPool
} from "./MeshletGpuPool.js";
import { GeometryBlasPool } from "./GeometryBlasPool.js";

export const MESHLET_HEADER_STRIDE_BYTES = MESHLET_HEADER_BYTES;
export const MESHLET_HEADER_STRIDE_U32 = 10;

export const MESH_GEO_META_STRIDE_BYTES = 64;
export const MESH_GEO_META_STRIDE_U32 = 16;
export const MESH_GEO_META_FLAG_MESHLETS = 1;
export const MESH_GEO_META_WORD_OFF = {
  bounding_sphere: 0,
  bounding_box: 4,
  index_count: 10,
  meshlets_address: 11,
  meshlets_count: 12
} as const;

export type MeshGeoMetaCpu = {
  geometry_index: number;
  meshlets_address: number;
  meshlet_count: number;
  flags: number;
  index_count: number;
  bounding_box: Float32Array;
  bounding_sphere: Float32Array;
};

type GeometryAllocation = {
  geometry: MeshletGeometryBase;
  index: number;
  meshlets: MeshletBatchAllocation;
  allocated: boolean;
};

export class MeshletGpuTable {
  readonly meshlets: MeshletGpuPool;
  readonly blas: GeometryBlasPool;
  meshMetaBuffer: GPUBuffer | null;

  private readonly managed = new Map<
    MeshletGeometryBase,
    GeometryAllocation
  >();
  private readonly clones: GeometryAllocation[] = [];
  private readonly recordsByIndex: Array<GeometryAllocation | undefined> = [];
  private meshMeta = new ArrayBuffer(MESH_GEO_META_STRIDE_BYTES);
  private lastGeometryIndex = 0;
  private needsUpdate = true;

  private readonly device: GPUDevice;

  constructor(graphics: GraphicsContext) {
    const device = graphics.device;
    this.device = device;
    this.blas = new GeometryBlasPool(device);
    this.meshlets = new MeshletGpuPool(graphics);
    this.meshMetaBuffer = device.createBuffer({
      label: "MeshletGpuTable/geometry-metadata",
      size: MESH_GEO_META_STRIDE_BYTES,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC
    });
  }

  get headerBuffer(): GPUBuffer {
    return this.meshlets.buffer_metadata;
  }

  get dataBuffer(): GPUBuffer {
    return this.meshlets.buffer_data;
  }

  get meshletCount(): number {
    return this.meshlets.meshlet_count;
  }

  get dataWordCount(): number {
    return this.meshlets.data_word_count;
  }

  get geometryCount(): number {
    return this.lastGeometryIndex;
  }

  get gpu_memory_usage(): number {
    return (
      (this.meshMetaBuffer?.size ?? 0) + this.meshlets.gpu_memory_usage
      + this.blas.gpu_memory_usage
    );
  }

  clear(): void {
    this.managed.clear();
    this.clones.length = 0;
    this.recordsByIndex.length = 0;
    this.lastGeometryIndex = 0;
    this.needsUpdate = true;
  }

  obtainGeometry(geometry: MeshletGeometryBase): number {
    const existing = this.managed.get(geometry);
    if (existing) return existing.index;
    const meshlets = this.meshlets.add_batch(geometry.meshlets);
    meshlets.changed.add(() => {
      console.warn("Meshlet GPU address changed.");
    });
    const record = this.createGeometryRecord(geometry, meshlets);
    this.managed.set(geometry, record);
    this.needsUpdate = true;
    return record.index;
  }

  cloneGeometry(geometry: MeshletGeometryBase): number {
    this.obtainGeometry(geometry);
    const source = this.managed.get(geometry)!;
    const meshlets = this.meshlets.clone_batch_allocation(source.meshlets!);
    const clone = this.createGeometryRecord(geometry, meshlets);
    this.clones.push(clone);
    this.needsUpdate = true;
    return clone.index;
  }

  getGeometryIndex(
    geometry: MeshletGeometryBase
  ): number | undefined {
    return this.managed.get(geometry)?.index;
  }

  getAddress(geometry: MeshletGeometryBase): number {
    const record = this.managed.get(geometry);
    if (!record) throw new Error("Geometry is not registered");
    return record.index;
  }

  has(geometry: MeshletGeometryBase): boolean {
    return this.managed.has(geometry);
  }

  remove(geometry: MeshletGeometryBase): boolean {
    const record = this.managed.get(geometry);
    if (!record) return false;
    this.managed.delete(geometry);
    this.recordsByIndex[record.index] = undefined;
    this.needsUpdate = true;
    return true;
  }

  getGeometryMeta(geometryIndex: number): MeshGeoMetaCpu | null {
    const record = this.recordsByIndex[geometryIndex];
    if (!record) return null;
    const geometry = record.geometry;
    const meshlets = record.meshlets;
    const count = meshlets.meshlet_count;
    return {
      geometry_index: geometryIndex,
      meshlets_address: meshlets.metadata.offset,
      meshlet_count: count,
      flags: count > 0 ? MESH_GEO_META_FLAG_MESHLETS : 0,
      index_count: geometry ? 3 * geometry.primitive_count : 0,
      bounding_sphere: geometry
        ? new Float32Array(geometry.bounding_sphere)
        : new Float32Array(4),
      bounding_box: geometry
        ? new Float32Array(geometry.bounding_box)
        : new Float32Array(6)
    };
  }

  getMeshletPrimitiveCount(globalMeshletId: number): number {
    return this.readOriginalHeaderWord(
      globalMeshletId,
      MESHLET_HEADER_WORD_OFF.primitive_count
    );
  }

  getMeshletVertexCount(globalMeshletId: number): number {
    return this.readOriginalHeaderWord(
      globalMeshletId,
      MESHLET_HEADER_WORD_OFF.vertex_count
    );
  }

  getMeshletBoundsBox(
    globalMeshletId: number,
    out: Float32Array
  ): boolean {
    const located = this.locateMeshlet(globalMeshletId);
    if (!located) return false;
    const view = new Float32Array(
      located.allocation.metadata_buffer_original,
      located.localIndex * MESHLET_HEADER_BYTES,
      MESHLET_HEADER_STRIDE_U32
    );
    for (let i = 0; i < 6; i++) out[i] = view[i]!;
    return true;
  }

  update(
    command: ShadeGPUCommandContext,
    labelPrefix = "MeshletGpuTable"
  ): void {
    if (this.needsUpdate) {
      this.build(labelPrefix);
      this.blas.update(command);
      command.onAborted.addOne(() => {
        this.needsUpdate = true;
      });
    }
    this.meshlets.update(command);
  }

  build(labelPrefix = "MeshletGpuTable"): void {
    const records = [
      ...this.managed.values(),
      ...this.clones
    ];
    records.sort((a, b) => a.index - b.index);
    for (const record of records) {
      this.blas.mapGeometryIndex(record.index, record.geometry);
    }
    const byteLength =
      Math.max(1, this.lastGeometryIndex) * MESH_GEO_META_STRIDE_BYTES;
    this.meshMeta = new ArrayBuffer(byteLength);
    for (const record of records) this.packGeometryRecord(record);

    this.meshMetaBuffer?.destroy();
    this.meshMetaBuffer = this.device.createBuffer({
      label: `${labelPrefix}/geometry-metadata`,
      size: byteLength,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true
    });
    new Uint8Array(this.meshMetaBuffer.getMappedRange()).set(
      new Uint8Array(this.meshMeta)
    );
    this.meshMetaBuffer.unmap();
    this.needsUpdate = false;
  }

  destroy(): void {
    this.meshMetaBuffer?.destroy();
    this.meshMetaBuffer = null;
    this.meshlets.destroy();
    this.blas.destroy();
    this.clear();
  }

  private createGeometryRecord(
    geometry: MeshletGeometryBase,
    meshlets: MeshletBatchAllocation
  ): GeometryAllocation {
    const record: GeometryAllocation = {
      geometry,
      index: this.lastGeometryIndex++,
      meshlets,
      allocated: false
    };
    this.recordsByIndex[record.index] = record;
    return record;
  }

  private packGeometryRecord(record: GeometryAllocation): void {
    const base = record.index * MESH_GEO_META_STRIDE_BYTES;
    const f32 = new Float32Array(
      this.meshMeta,
      base,
      MESH_GEO_META_STRIDE_U32
    );
    const u32 = new Uint32Array(
      this.meshMeta,
      base,
      MESH_GEO_META_STRIDE_U32
    );
    const geometry = record.geometry;
    for (let i = 0; i < 4; i++) {
      f32[MESH_GEO_META_WORD_OFF.bounding_sphere + i] =
        geometry.bounding_sphere[i] ?? 0;
    }
    for (let i = 0; i < 6; i++) {
      f32[MESH_GEO_META_WORD_OFF.bounding_box + i] =
        geometry.bounding_box[i] ?? 0;
    }
    u32[MESH_GEO_META_WORD_OFF.index_count] =
      (3 * geometry.primitive_count) >>> 0;
    u32[MESH_GEO_META_WORD_OFF.meshlets_address] =
      record.meshlets.metadata.offset;
    u32[MESH_GEO_META_WORD_OFF.meshlets_count] =
      record.meshlets.meshlet_count;
  }

  private readOriginalHeaderWord(
    globalMeshletId: number,
    word: number
  ): number {
    const located = this.locateMeshlet(globalMeshletId);
    if (!located) return 0;
    const words = new Uint32Array(
      located.allocation.metadata_buffer_original,
      located.localIndex * MESHLET_HEADER_BYTES,
      MESHLET_HEADER_STRIDE_U32
    );
    return words[word]! >>> 0;
  }

  private locateMeshlet(globalMeshletId: number): {
    allocation: MeshletBatchAllocation;
    localIndex: number;
  } | null {
    if (globalMeshletId < 0) return null;
    for (const record of this.recordsByIndex) {
      const allocation = record?.meshlets;
      if (!allocation) continue;
      const first = allocation.metadata.offset;
      const localIndex = globalMeshletId - first;
      if (localIndex >= 0 && localIndex < allocation.meshlet_count) {
        return { allocation, localIndex };
      }
    }
    return null;
  }
}
