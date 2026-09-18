import { OEGPACK_V3_PAGE_BYTES } from "../assets/GeometryAbiV3.js";
import { reserveGeometryProductGpuBytes } from "./GeometryProductGpuBudget.js";

// Four bindings remain immutable for every Product generation. The bank/slot
// budget is exactly Nyx/OEngine's fixed 512 MiB / 4 x 128 MiB ABI; metadata is
// tracked separately as bounded overhead.
export const GEOMETRY_PRODUCT_SHARED_BANK_BYTES = 128 * 1024 * 1024;
export const GEOMETRY_PRODUCT_SHARED_BANK_COUNT = 4;
export const GEOMETRY_PRODUCT_SHARED_SLOTS_PER_BANK = GEOMETRY_PRODUCT_SHARED_BANK_BYTES / OEGPACK_V3_PAGE_BYTES;

const pools = new WeakMap<GPUDevice, GeometryProductSlotPool>();

export class GeometryProductSlotPool {
  readonly banks: readonly GPUBuffer[];
  readonly slotCapacity = GEOMETRY_PRODUCT_SHARED_BANK_COUNT * GEOMETRY_PRODUCT_SHARED_SLOTS_PER_BANK;
  readonly #occupied = new Uint8Array(this.slotCapacity);
  readonly #releaseReservations: Array<() => void> = [];
  readonly #device: GPUDevice;
  #owners = 0;
  #used = 0;
  #cursor = 0;

  private constructor(device: GPUDevice) {
    this.#device = device;
    if (device.limits.maxBufferSize < GEOMETRY_PRODUCT_SHARED_BANK_BYTES ||
        device.limits.maxStorageBufferBindingSize < GEOMETRY_PRODUCT_SHARED_BANK_BYTES) {
      throw new RangeError("Geometry Product requires a 128 MiB storage-buffer bank");
    }
    const buffers: GPUBuffer[] = [];
    try {
      for (let index = 0; index < GEOMETRY_PRODUCT_SHARED_BANK_COUNT; index++) {
        const release = reserveGeometryProductGpuBytes(device, GEOMETRY_PRODUCT_SHARED_BANK_BYTES);
        try {
          const bank = device.createBuffer({
            label: `OEngine Geometry Product shared bank ${index}`,
            size: GEOMETRY_PRODUCT_SHARED_BANK_BYTES,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
          });
          buffers.push(bank);
          this.#releaseReservations.push(release);
        } catch (error) { release(); throw error; }
      }
    } catch (error) {
      for (const buffer of buffers) buffer.destroy();
      for (const release of this.#releaseReservations.splice(0)) release();
      throw error;
    }
    this.banks = Object.freeze(buffers);
  }

  static retain(device: GPUDevice): GeometryProductSlotPool {
    let pool = pools.get(device);
    if (!pool) { pool = new GeometryProductSlotPool(device); pools.set(device, pool); }
    pool.#owners++;
    return pool;
  }

  get usedSlots(): number { return this.#used; }
  get availableSlots(): number { return this.slotCapacity - this.#used; }

  allocate(): { bankIndex: number; slotIndex: number } | undefined {
    if (this.#used === this.slotCapacity) return undefined;
    for (let offset = 0; offset < this.slotCapacity; offset++) {
      const flat = (this.#cursor + offset) % this.slotCapacity;
      if (this.#occupied[flat] !== 0) continue;
      this.#occupied[flat] = 1;
      this.#used++;
      this.#cursor = (flat + 1) % this.slotCapacity;
      return { bankIndex: Math.floor(flat / GEOMETRY_PRODUCT_SHARED_SLOTS_PER_BANK), slotIndex: flat % GEOMETRY_PRODUCT_SHARED_SLOTS_PER_BANK };
    }
    throw new Error("Geometry Product slot pool occupancy is inconsistent");
  }

  release(bankIndex: number, slotIndex: number): void {
    if (!Number.isInteger(bankIndex) || bankIndex < 0 || bankIndex >= GEOMETRY_PRODUCT_SHARED_BANK_COUNT ||
        !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= GEOMETRY_PRODUCT_SHARED_SLOTS_PER_BANK) {
      throw new RangeError("Geometry Product shared slot is out of range");
    }
    const flat = bankIndex * GEOMETRY_PRODUCT_SHARED_SLOTS_PER_BANK + slotIndex;
    if (this.#occupied[flat] === 0) throw new Error("Geometry Product shared slot was released twice");
    this.#occupied[flat] = 0;
    this.#used--;
    this.#cursor = Math.min(this.#cursor, flat);
  }

  releaseOwner(): void {
    if (this.#owners <= 0) throw new Error("Geometry Product shared slot pool owner was released twice");
    this.#owners--;
    if (this.#owners !== 0) return;
    if (this.#used !== 0) throw new Error("Geometry Product shared slot pool has leaked slots");
    pools.delete(this.#device);
    for (const bank of this.banks) bank.destroy();
    for (const release of this.#releaseReservations.splice(0)) release();
  }
}
