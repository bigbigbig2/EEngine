/**
 * MaterialMetadataTable：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { ShadeMaterial } from "../material/ShadeMaterial.js";
import { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { materialBucketId } from "../material/materialBucketId.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { BitSet } from "../core/BitSet.js";
import {
  WGSL_f32,
  WGSL_u32,
  WGSL_vec2f,
  WGSL_vec3f,
  WGSL_vec4f
} from "../core/WebGPUTypes.js";
import { StructType } from "../core/WgslStruct.js";
import { GPUIndexedRecordTable } from "./GPUIndexedRecordTable.js";

export const MATERIAL_META_TYPE = StructType.from(
  {
    id: WGSL_u32,
    albedo_color: WGSL_vec4f,
    metallic_factor: WGSL_f32,
    roughness_factor: WGSL_f32,
    transmission_factor: WGSL_f32,
    ior_factor: WGSL_f32,
    emissive_factor: WGSL_vec3f,
    ambient_factors: WGSL_vec2f,
    transparency_mode: WGSL_u32,
    draw_mode: WGSL_u32,
    draw_side: WGSL_u32
  },
  "EventDispatcher"
).pack();

export const MATERIAL_META_STRIDE_BYTES = MATERIAL_META_TYPE.size;
export const MATERIAL_META_STRIDE_U32 = MATERIAL_META_STRIDE_BYTES >>> 2;
export const MATERIAL_META_STRIDE_F32 = MATERIAL_META_STRIDE_BYTES >>> 2;

export const MATERIAL_META_OFF = {
  albedo: MATERIAL_META_TYPE.get("albedo_color").offset,
  emissive: MATERIAL_META_TYPE.get("emissive_factor").offset,
  draw_side: MATERIAL_META_TYPE.get("draw_side").offset,
  ambient: MATERIAL_META_TYPE.get("ambient_factors").offset,
  draw_mode: MATERIAL_META_TYPE.get("draw_mode").offset,
  transparency_mode:
    MATERIAL_META_TYPE.get("transparency_mode").offset,
  ior: MATERIAL_META_TYPE.get("ior_factor").offset,
  transmission:
    MATERIAL_META_TYPE.get("transmission_factor").offset,
  roughness: MATERIAL_META_TYPE.get("roughness_factor").offset,
  metallic: MATERIAL_META_TYPE.get("metallic_factor").offset,
  id: MATERIAL_META_TYPE.get("id").offset
} as const;

export type MaterialMetaCpu = {
  id: number;
  albedo: [number, number, number, number];
  metallic: number;
  roughness: number;
  transmission: number;
  ior: number;
  emissive: [number, number, number];
  ambient: [number, number];
  transparency_mode: number;
  draw_mode: number;
  draw_side: number;
};

export function packMaterialMetaFromSource(mat: ShadeMaterial): MaterialMetaCpu {
  const base: MaterialMetaCpu = {
    id: mat.id >>> 0,
    albedo: [1, 1, 1, 1],
    metallic: 0,
    roughness: 1,
    transmission: 0,
    ior: 1.5,
    emissive: [0, 0, 0],
    ambient: [1, 1],
    transparency_mode: mat.transparency_mode >>> 0,
    draw_mode: mat.draw_mode >>> 0,
    draw_side: mat.draw_side >>> 0
  };

  if (mat instanceof StandardShadeMaterial) {
    const c = mat.diffuse_color;
    base.albedo = [c.r, c.g, c.b, c.a ?? 1];
    base.metallic = mat.metallic_factor;
    base.roughness = mat.roughness_factor;
    base.transmission = mat.transmission_factor;
    base.ior = mat.ior_factor;
    base.emissive = [
      mat.emissive_factor.r,
      mat.emissive_factor.g,
      mat.emissive_factor.b
    ];
    base.ambient = [mat.ambient_factors.a, mat.ambient_factors.b];
  }

  return base;
}

export function packMaterialMeta(
  row: MaterialMetaCpu,
  target: ArrayBuffer = new ArrayBuffer(MATERIAL_META_STRIDE_BYTES),
  byteOffset = 0
): ArrayBuffer {
  if (
    byteOffset < 0 ||
    byteOffset + MATERIAL_META_STRIDE_BYTES > target.byteLength
  ) {
    throw new RangeError("material metadata target is too small");
  }
  const u32 = new Uint32Array(
    target,
    byteOffset,
    MATERIAL_META_STRIDE_U32
  );
  const f32 = new Float32Array(
    target,
    byteOffset,
    MATERIAL_META_STRIDE_F32
  );
  const albedo = MATERIAL_META_OFF.albedo >>> 2;
  const emissive = MATERIAL_META_OFF.emissive >>> 2;
  const ambient = MATERIAL_META_OFF.ambient >>> 2;
  f32[albedo] = row.albedo[0]!;
  f32[albedo + 1] = row.albedo[1]!;
  f32[albedo + 2] = row.albedo[2]!;
  f32[albedo + 3] = row.albedo[3]!;
  f32[emissive] = row.emissive[0]!;
  f32[emissive + 1] = row.emissive[1]!;
  f32[emissive + 2] = row.emissive[2]!;
  u32[MATERIAL_META_OFF.id >>> 2] = row.id >>> 0;
  f32[ambient] = row.ambient[0]!;
  f32[ambient + 1] = row.ambient[1]!;
  f32[MATERIAL_META_OFF.metallic >>> 2] = row.metallic;
  f32[MATERIAL_META_OFF.roughness >>> 2] = row.roughness;
  f32[MATERIAL_META_OFF.transmission >>> 2] = row.transmission;
  f32[MATERIAL_META_OFF.ior >>> 2] = row.ior;
  u32[MATERIAL_META_OFF.transparency_mode >>> 2] =
    row.transparency_mode >>> 0;
  u32[MATERIAL_META_OFF.draw_mode >>> 2] = row.draw_mode >>> 0;
  u32[MATERIAL_META_OFF.draw_side >>> 2] = row.draw_side >>> 0;
  return target;
}

export class MaterialMetadataTable {
  private cpu = new ArrayBuffer(0);
  private _capacity = 0;
  private _count = 0;
  private readonly occupancy = new BitSet();
  private readonly gpuTable: GPUIndexedRecordTable<MaterialMetaCpu> | null;

  constructor(
    device?: GPUDevice,
    initialSize = 0
  ) {
    this.gpuTable =
      device && initialSize > 0
        ? new GPUIndexedRecordTable({
            device,
            type: MATERIAL_META_TYPE,
            recordSizeBytes: MATERIAL_META_STRIDE_BYTES,
            initialSizeBytes: initialSize,
            pack: (value, target, byteOffset) => {
              packMaterialMeta(value, target, byteOffset);
            }
          })
        : null;
  }

  get buffer(): GPUBuffer | null {
    return this.gpuTable?.buffer ?? null;
  }

  get count(): number {
    return this._count;
  }

  get slotCount(): number {
    return this.occupancy.size();
  }

  get version(): number {
    return this._count;
  }

  obtain(mat: ShadeMaterial | null | undefined): number {
    if (!mat) return 0;
    const packed = packMaterialMetaFromSource(mat);
    this.set(packed.id, packed);
    return packed.id;
  }

  set(id: number, row: MaterialMetaCpu): void {
    const idx = id >>> 0;
    this.ensureCapacity(idx + 1);
    this.writeRow(idx, row);
    if (!this.occupancy.getAndSet(idx)) this._count++;
    this.gpuTable?.set(idx, row);
  }

  next(): number {
    return this.occupancy.nextClearBit(0);
  }

  remove(id: number): void {
    const idx = id >>> 0;
    if (this.occupancy.getAndClear(idx)) this._count--;
    this.gpuTable?.remove(idx);
  }

  getModes(id: number): {
    transparency_mode: number;
    draw_mode: number;
    draw_side: number;
  } | null {
    if (id < 0 || !this.occupancy.get(id)) return null;
    const u32 = new Uint32Array(
      this.cpu,
      id * MATERIAL_META_STRIDE_BYTES,
      MATERIAL_META_STRIDE_U32
    );
    return {
      transparency_mode: u32[MATERIAL_META_OFF.transparency_mode >>> 2]! >>> 0,
      draw_mode: u32[MATERIAL_META_OFF.draw_mode >>> 2]! >>> 0,
      draw_side: u32[MATERIAL_META_OFF.draw_side >>> 2]! >>> 0
    };
  }

  getBucketId(materialId: number): number {
    const m = this.getModes(materialId);
    if (!m) return 0;
    return materialBucketId(
      m.transparency_mode,
      m.draw_mode,
      m.draw_side
    );
  }

  buildBucketMap(): Map<number, number> {
    const map = new Map<number, number>();
    for (let id = 0; id < this.occupancy.size(); id++) {
      if (!this.occupancy.get(id)) continue;
      const u32 = new Uint32Array(
        this.cpu,
        id * MATERIAL_META_STRIDE_BYTES,
        MATERIAL_META_STRIDE_U32
      );
      const storedId =
        u32[MATERIAL_META_OFF.id >>> 2]! >>> 0;
      if (storedId !== (id >>> 0)) continue;
      map.set(
        id,
        materialBucketId(
          u32[MATERIAL_META_OFF.transparency_mode >>> 2]! >>> 0,
          u32[MATERIAL_META_OFF.draw_mode >>> 2]! >>> 0,
          u32[MATERIAL_META_OFF.draw_side >>> 2]! >>> 0
        )
      );
    }
    return map;
  }

  update(cmd: ShadeGPUCommandContext, _labelPrefix = "MaterialMetadata"): void {
    this.gpuTable?.update(cmd);
  }

  destroy(): void {
    this.gpuTable?.destroy();
    this.cpu = new ArrayBuffer(0);
    this._capacity = 0;
    this._count = 0;
    this.occupancy.reset();
  }

  private ensureCapacity(slots: number): void {
    if (slots <= this._capacity) return;
    const cap = Math.max(slots, 16, this._capacity * 2);
    const next = new ArrayBuffer(cap * MATERIAL_META_STRIDE_BYTES);
    if (this.cpu.byteLength > 0) {
      new Uint8Array(next).set(new Uint8Array(this.cpu));
    }
    this.cpu = next;
    this._capacity = cap;
  }

  private writeRow(id: number, row: MaterialMetaCpu): void {
    const base = id * MATERIAL_META_STRIDE_BYTES;
    packMaterialMeta(row, this.cpu, base);
  }
}
