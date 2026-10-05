import { OEGPACK_V3_PAGE_BYTES } from "../assets/GeometryAbiV3.js";
import { reserveGeometryProductGpuBytes } from "./GeometryProductGpuBudget.js";
import type { GeometryProductResidencyProfilePlanV1 } from "./GeometryProductResidencyProfile.js";

// Four bindings remain immutable for every Product generation. The profile
// changes only physical bank capacity; page size and shader binding ABI stay
// fixed. Metadata is tracked separately as bounded overhead.
export const GEOMETRY_PRODUCT_SHARED_BANK_BYTES = 128 * 1024 * 1024;
export const GEOMETRY_PRODUCT_SHARED_BANK_COUNT = 4;
export const GEOMETRY_PRODUCT_SHARED_SLOTS_PER_BANK =
  GEOMETRY_PRODUCT_SHARED_BANK_BYTES / OEGPACK_V3_PAGE_BYTES;

const pools = new WeakMap<GPUDevice, GeometryProductSlotPool>();

export class GeometryProductSlotPool {
  readonly banks: readonly GPUBuffer[];
  readonly bankBytes: number;
  readonly slotsPerBank: number;
  readonly slotCapacity: number;
  readonly profile: GeometryProductResidencyProfilePlanV1;
  readonly #occupied: Uint8Array;
  readonly #releaseReservations: Array<() => void> = [];
  readonly #device: GPUDevice;
  #owners = 0;
  #used = 0;
  #cursor = 0;

  private constructor(device: GPUDevice, profile: GeometryProductResidencyProfilePlanV1) {
    this.#device = device;
    this.profile = profile;
    this.bankBytes = profile.bankBytes;
    this.slotsPerBank = profile.slotsPerBank;
    this.slotCapacity = profile.slotCapacity;
    this.#occupied = new Uint8Array(this.slotCapacity);
    if (
      !profile.enabled ||
      profile.bankCount !== GEOMETRY_PRODUCT_SHARED_BANK_COUNT ||
      device.limits.maxBufferSize < profile.bankBytes ||
      device.limits.maxStorageBufferBindingSize < profile.bankBytes
    ) {
      throw new RangeError("Geometry Product residency profile is unavailable on the negotiated device");
    }
    const buffers: GPUBuffer[] = [];
    try {
      for (let index = 0; index < GEOMETRY_PRODUCT_SHARED_BANK_COUNT; index++) {
        const release = reserveGeometryProductGpuBytes(device, profile.bankBytes, profile.capacityBytes);
        try {
          const bank = device.createBuffer({
            label: `OEngine Geometry Product ${profile.profile} bank ${index}`,
            size: profile.bankBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          });
          buffers.push(bank);
          this.#releaseReservations.push(release);
        } catch (error) {
          release();
          throw error;
        }
      }
    } catch (error) {
      for (const buffer of buffers) buffer.destroy();
      for (const release of this.#releaseReservations.splice(0)) release();
      throw error;
    }
    this.banks = Object.freeze(buffers);
  }

  static retain(device: GPUDevice): GeometryProductSlotPool {
    return GeometryProductSlotPool.retainWithProfile(device, defaultPortableProfile(device));
  }

  static retainWithProfile(
    device: GPUDevice,
    profile: GeometryProductResidencyProfilePlanV1,
  ): GeometryProductSlotPool {
    let pool = pools.get(device);
    if (!pool) {
      pool = new GeometryProductSlotPool(device, profile);
      pools.set(device, pool);
    } else if (
      pool.profile.profile !== profile.profile ||
      pool.bankBytes !== profile.bankBytes ||
      pool.slotCapacity !== profile.slotCapacity
    ) {
      throw new Error("Geometry Product residency profile cannot change while the shared GPU heap is alive");
    }
    pool.#owners++;
    return pool;
  }

  get usedSlots(): number {
    return this.#used;
  }
  get availableSlots(): number {
    return this.slotCapacity - this.#used;
  }

  allocate(): { bankIndex: number; slotIndex: number } | undefined {
    if (this.#used === this.slotCapacity) return undefined;
    for (let offset = 0; offset < this.slotCapacity; offset++) {
      const flat = (this.#cursor + offset) % this.slotCapacity;
      if (this.#occupied[flat] !== 0) continue;
      this.#occupied[flat] = 1;
      this.#used++;
      this.#cursor = (flat + 1) % this.slotCapacity;
      return { bankIndex: Math.floor(flat / this.slotsPerBank), slotIndex: flat % this.slotsPerBank };
    }
    throw new Error("Geometry Product slot pool occupancy is inconsistent");
  }

  release(bankIndex: number, slotIndex: number): void {
    if (
      !Number.isInteger(bankIndex) ||
      bankIndex < 0 ||
      bankIndex >= GEOMETRY_PRODUCT_SHARED_BANK_COUNT ||
      !Number.isInteger(slotIndex) ||
      slotIndex < 0 ||
      slotIndex >= this.slotsPerBank
    ) {
      throw new RangeError("Geometry Product shared slot is out of range");
    }
    const flat = bankIndex * this.slotsPerBank + slotIndex;
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

function defaultPortableProfile(device: GPUDevice): GeometryProductResidencyProfilePlanV1 {
  return Object.freeze({
    abiVersion: 1,
    enabled: true,
    requestedProfile: "Portable",
    profile: "Portable",
    reason: "selected",
    bankCount: GEOMETRY_PRODUCT_SHARED_BANK_COUNT,
    bankBytes: GEOMETRY_PRODUCT_SHARED_BANK_BYTES,
    slotsPerBank: GEOMETRY_PRODUCT_SHARED_SLOTS_PER_BANK,
    slotCapacity: GEOMETRY_PRODUCT_SHARED_BANK_COUNT * GEOMETRY_PRODUCT_SHARED_SLOTS_PER_BANK,
    capacityBytes: GEOMETRY_PRODUCT_SHARED_BANK_COUNT * GEOMETRY_PRODUCT_SHARED_BANK_BYTES,
    negotiatedLimits: Object.freeze({
      maxBufferSize: Number(device.limits.maxBufferSize),
      maxStorageBufferBindingSize: Number(device.limits.maxStorageBufferBindingSize),
      maxStorageBuffersPerShaderStage: Number(device.limits.maxStorageBuffersPerShaderStage ?? 16),
    }),
    runtimeEvidence: Object.freeze({}),
  });
}
