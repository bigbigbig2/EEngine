import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import type { NativeSceneQueryLease, NativeSceneQueryMaterial } from "./GpuNativeMaterialScene.js";
import { validateScgiDescriptors } from "../render/gi/ScgiCapacity.js";

export interface NativeQueryMaterialBin {
  readonly index: number;
  readonly material: NativeSceneQueryMaterial;
  readonly constants: GPUBuffer;
}

function sameResource(left: GPUBindingResource, right: GPUBindingResource): boolean {
  if (left === right) {
    return true;
  }
  if ("buffer" in left && "buffer" in right) {
    return left.buffer === right.buffer && (left.offset ?? 0) === (right.offset ?? 0) &&
      (left.size ?? left.buffer.size - (left.offset ?? 0)) ===
        (right.size ?? right.buffer.size - (right.offset ?? 0));
  }
  return false;
}

/** Finite native Program/resource bins over the scene's immutable query graph
 * projections. Only constants and a slot directory are added; textures and
 * cooked material Products remain retained by the existing scene lease. */
export class GpuQueryMaterialPublication {
  readonly directory: GPUBuffer;
  readonly bins: readonly NativeQueryMaterialBin[];
  private destroyed = false;
  private readonly buffers: GPUBuffer[] = [];
  private readonly handles: ResourceHandle[] = [];

  constructor(
    device: GPUDevice,
    readonly source: NativeSceneQueryLease,
    private readonly accounting?: ResourceAccounting,
  ) {
    if (!source.valid || source.materials.length === 0) {
      throw new Error("Query material publication requires a live complete native projection");
    }
    const groups: Array<{ source: NativeSceneQueryMaterial; values: number[] }> = [];
    const routes: Array<{ slot: number; bin: number; base: number }> = [];
    const materialSlots = new Set<number>();
    let slots = 1;
    for (const material of source.materials) {
      if (!Number.isSafeInteger(material.materialSlot) || material.materialSlot < 0 ||
          material.materialSlot >= 0xffffffff || materialSlots.has(material.materialSlot)) {
        throw new RangeError("Query material slots must be unique finite u32 indices");
      }
      materialSlots.add(material.materialSlot);
      let bin = groups.findIndex((candidate) =>
        candidate.source.unlit === material.unlit &&
        candidate.source.binding.program.key === material.binding.program.key &&
        candidate.source.binding.entries.length === material.binding.entries.length &&
        candidate.source.binding.entries.every((entry, index) =>
          entry.binding === material.binding.entries[index]!.binding &&
          sameResource(entry.resource, material.binding.entries[index]!.resource)));
      if (bin < 0) {
        bin = groups.length;
        groups.push({ source: material, values: [] });
      }
      const group = groups[bin]!;
      routes.push({ slot: material.materialSlot, bin, base: group.values.length });
      for (const value of material.constants) {
        group.values.push(value);
      }
      slots = Math.max(slots, material.materialSlot + 1);
    }
    const maximum = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
    if (slots * 16 > maximum || groups.some((group) => group.values.length * 4 > maximum)) {
      throw new RangeError("Query material directory or a complete Program bin exceeds binding capacity");
    }
    for (const group of groups) {
      validateScgiDescriptors(device.limits, [[], [], [], group.source.binding.layoutEntries]);
    }
    const allocate = (label: string, size: number) => {
      const buffer = device.createBuffer({ label, size: Math.max(4, size),
        usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
      this.buffers.push(buffer);
      if (accounting !== undefined) {
        this.handles.push(accounting.created({ kind: "buffer", category: "resident",
          owner: "Native/query material publication", bytes: buffer.size, label }, buffer));
      }
      return buffer;
    };
    try {
      this.bins = Object.freeze(groups.map((group, index) => {
        const values = Float32Array.from(group.values);
        const constants = allocate(`Native/query material constants ${index}`, values.byteLength);
        new Float32Array(constants.getMappedRange()).set(values);
        constants.unmap();
        return Object.freeze({ index, constants,
          material: Object.freeze({ ...group.source, constants: values }) });
      }));
      this.directory = allocate("Native/query material directory", slots * 16);
      const words = new Uint32Array(this.directory.getMappedRange());
      for (const route of routes) {
        words.set([route.base, route.bin, 0, 1], route.slot * 4);
      }
      this.directory.unmap();
    } catch (error) {
      this.destroy();
      throw error;
    }
    void device.lost.then(() => this.destroy());
  }

  get valid(): boolean {
    return !this.destroyed && this.source.valid;
  }

  get byteLength(): number {
    return this.buffers.reduce((bytes, buffer) => bytes + buffer.size, 0);
  }

  /** Does not release the source lease; the complete query scene owns it. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const buffer of this.buffers) {
      buffer.destroy();
    }
    for (const handle of this.handles) {
      this.accounting!.destroyed(handle);
    }
  }
}
