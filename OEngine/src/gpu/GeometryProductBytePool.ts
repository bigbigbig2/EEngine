import {
  reserveGeometryProductGpuBytes,
  geometryProductGpuBudgetEvidence,
} from "./GeometryProductGpuBudget.js";
import type { GeometryProductResidencyProfilePlanV1 } from "./GeometryProductResidencyProfile.js";
import { OffsetAllocator, type OffsetAllocation } from "./OffsetAllocator.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";

const BANK_COUNT = 4;
const UNIT_BYTES = 16;
const pools = new WeakMap<GPUDevice, GeometryProductBytePool>();

export interface GeometryPageLease {
  readonly bankIndex: number;
  readonly byteOffset: number;
  readonly allocatedBytes: number;
  readonly allocation: OffsetAllocation;
}

interface BankGeneration {
  readonly banks: readonly GPUBuffer[];
  readonly bankBytes: number;
  readonly release: () => void;
}

type BindingListener = (command: ShadeGPUCommandContext, bankBytes: number) => void;

/** Device-owned, exact-length page storage. Live offsets never move.
 * Growth is encoded once before all ordinary-frame consumers, then committed. */
export class GeometryProductBytePool {
  readonly #allocators: OffsetAllocator[];
  readonly #listeners = new Set<BindingListener>();
  readonly #leases = new Set<GeometryPageLease>();
  readonly #retired = new Set<BankGeneration>();
  #active: BankGeneration;
  #candidate?: BankGeneration & { readonly command: ShadeGPUCommandContext; readonly epoch: number };
  #requestedBytes = 0;
  #budgetBlockedBytes = 0;
  #owners = 0;
  #cursor = 0;
  #epoch = 0;
  #serial = 0;
  #destroyed = false;
  #bindingsExposed = false;
  #waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  #lastFailure: "none" | "frozen" | "lease-capacity" | "nodes" | "bytes-or-fragmentation" | "growth-budget" =
    "none";
  #retirementError: string | null = null;

  private constructor(
    readonly device: GPUDevice,
    readonly profile: GeometryProductResidencyProfilePlanV1,
  ) {
    const nodes = profile.maxPageLeases * 2 + 1;
    // Four banks, each conservatively able to hold every admitted lease.
    const cpuBytes = BANK_COUNT * (32 + 1024 + nodes * 37);
    if (cpuBytes > 80 * 1024 * 1024) {
      throw new RangeError("Geometry allocator CPU metadata exceeds its 80MiB budget");
    }
    this.#allocators = Array.from(
      { length: BANK_COUNT },
      () => new OffsetAllocator(profile.initialBankBytes / UNIT_BYTES, nodes),
    );
    this.#active = this.#createBanks(profile.initialBankBytes);
  }

  static retain(device: GPUDevice, profile: GeometryProductResidencyProfilePlanV1): GeometryProductBytePool {
    let pool = pools.get(device);
    if (pool === undefined) {
      pool = new GeometryProductBytePool(device, profile);
      pools.set(device, pool);
    } else if (
      pool.profile.bankBytes !== profile.bankBytes ||
      pool.profile.maxPageLeases !== profile.maxPageLeases
    ) {
      throw new Error("Geometry shared pool capacity contract cannot change while owners are alive");
    }
    pool.#owners++;
    return pool;
  }

  static prepareDeviceFrame(device: GPUDevice, command: ShadeGPUCommandContext): void {
    pools.get(device)?.prepareFrame(command);
  }

  get banks(): readonly GPUBuffer[] {
    return (this.#candidate ?? this.#active).banks;
  }
  get bankBytes(): number {
    return (this.#candidate ?? this.#active).bankBytes;
  }
  get bindingEpoch(): number {
    return this.#candidate?.epoch ?? this.#epoch;
  }
  get frozen(): boolean {
    return this.#candidate !== undefined;
  }

  exposeBindings(): void {
    this.#bindingsExposed = true;
  }

  abortPendingFrame(reason: Error): void {
    this.#candidate?.command.abort(reason);
  }

  onBindings(listener: BindingListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  allocate(payloadBytes: number): GeometryPageLease | undefined {
    const bytes = alignedPayload(payloadBytes);
    if (this.frozen) {
      this.#lastFailure = "frozen";
      return undefined;
    }
    if (this.#leases.size >= this.profile.maxPageLeases) {
      this.#lastFailure = "lease-capacity";
      return undefined;
    }
    let nodesExhausted = false;
    for (let attempt = 0; attempt < BANK_COUNT; attempt++) {
      const bankIndex = (this.#cursor + attempt) % BANK_COUNT;
      const allocator = this.#allocators[bankIndex]!;
      nodesExhausted ||= allocator.availableNodes < 2;
      const allocation = allocator.allocate(bytes / UNIT_BYTES);
      if (allocation === undefined) {
        continue;
      }
      const lease = Object.freeze({
        bankIndex,
        byteOffset: allocation.offset * UNIT_BYTES,
        allocatedBytes: bytes,
        allocation,
      });
      this.#leases.add(lease);
      this.#cursor = (bankIndex + 1) % BANK_COUNT;
      this.#lastFailure = "none";
      return lease;
    }
    this.#lastFailure = nodesExhausted ? "nodes" : "bytes-or-fragmentation";
    if (!nodesExhausted) {
      this.requestGrowth(Math.max(bytes, Math.ceil((this.#active.bankBytes * 1.5) / 16) * 16));
    }
    return undefined;
  }

  release(lease: GeometryPageLease): void {
    if (!this.#leases.delete(lease)) {
      throw new Error("Geometry page lease was released twice or belongs to another pool");
    }
    this.#allocators[lease.bankIndex]!.free(lease.allocation);
  }

  /** Bootstrap reserves the whole activation set before any asynchronous page IO. */
  async reserveActivation(
    payloadBytes: ArrayLike<number>,
    signal?: AbortSignal,
    onReserved?: (leases: readonly GeometryPageLease[]) => void,
  ): Promise<GeometryPageLease[]> {
    if (
      !this.#bindingsExposed &&
      this.#leases.size === 0 &&
      this.#epoch === 0 &&
      this.#candidate === undefined
    ) {
      let bytes = 0;
      let largest = 16;
      for (let index = 0; index < payloadBytes.length; index++) {
        const count = alignedPayload(payloadBytes[index]!);
        bytes += count;
        largest = Math.max(largest, count);
      }
      const target = Math.min(this.profile.bankBytes, Math.max(largest, Math.ceil((bytes * 1.25) / 64) * 16));
      if (target > this.#active.bankBytes) {
        const next = this.#createBanks(target);
        for (const allocator of this.#allocators) {
          allocator.grow(target / UNIT_BYTES);
        }
        const previous = this.#active;
        this.#active = next;
        previous.release();
      }
    }
    for (;;) {
      signal?.throwIfAborted();
      if (this.#destroyed) {
        throw new Error("Geometry byte pool was destroyed during admission");
      }
      const leases: GeometryPageLease[] = [];
      for (let index = 0; index < payloadBytes.length; index++) {
        const lease = this.allocate(payloadBytes[index]!);
        if (lease === undefined) {
          break;
        }
        leases.push(lease);
      }
      if (leases.length === payloadBytes.length) {
        onReserved?.(leases);
        return leases;
      }
      for (const lease of leases) {
        this.release(lease);
      }
      if (!this.#bindingsExposed && this.#requestedBytes > this.#active.bankBytes) {
        throw new RangeError(
          "Geometry bootstrap exceeds its initial window; provide complete descriptors for pinned capacity planning before the first frame",
        );
      }
      if (this.#requestedBytes <= this.#active.bankBytes && !this.frozen) {
        throw new RangeError(`Geometry activation admission failed: ${this.#lastFailure}`);
      }
      await this.waitForGrowth(signal);
    }
  }

  requestGrowth(bankBytes: number): void {
    const target = Math.min(this.profile.bankBytes, Math.ceil(bankBytes / 16) * 16);
    if (target === this.#budgetBlockedBytes) {
      this.#lastFailure = "growth-budget";
      return;
    }
    if (target > this.#active.bankBytes) {
      this.#requestedBytes = Math.max(this.#requestedBytes, target);
    }
  }

  waitForGrowth(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        },
        reject: (error: unknown) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      };
      const abort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) {
          this.#waiters.splice(index, 1);
        }
        waiter.reject(signal?.reason ?? new Error("Geometry admission aborted"));
      };
      if (signal?.aborted) {
        abort();
      } else {
        this.#waiters.push(waiter);
        signal?.addEventListener("abort", abort, { once: true });
      }
    });
  }

  prepareFrame(command: ShadeGPUCommandContext): void {
    if (this.#candidate !== undefined) {
      if (this.#candidate.command !== command) {
        throw new Error("Geometry pool already belongs to another unsubmitted command");
      }
      return;
    }
    if (this.#requestedBytes > this.#active.bankBytes) {
      const bytes = this.#requestedBytes;
      const ledger = geometryProductGpuBudgetEvidence(this.device);
      if (ledger.allocatedBytes + bytes * BANK_COUNT > this.profile.capacityBytes) {
        this.#lastFailure = "growth-budget";
        // Retiring generations may release credit later. A permanent peak failure is explicit.
        if (this.#retired.size === 0) {
          this.#budgetBlockedBytes = bytes;
          this.#requestedBytes = 0;
          this.#settleWaiters(new RangeError("Geometry growth peak exceeds the configured GPU budget"));
        }
      } else {
        const generation = this.#createBanks(bytes);
        const candidate = { ...generation, command, epoch: ++this.#serial };
        const previous = this.#active;
        this.#candidate = candidate;
        command.onAborted.addOne(() => {
          if (this.#candidate !== candidate) {
            return;
          }
          this.#candidate = undefined;
          candidate.release();
          this.#settleWaiters();
        });
        command.onFinished.addOne(() => {
          if (this.#candidate !== candidate) {
            throw new Error("Geometry growth command lost its candidate");
          }
          for (const allocator of this.#allocators) {
            allocator.grow(bytes / UNIT_BYTES);
          }
          this.#active = {
            banks: candidate.banks,
            bankBytes: candidate.bankBytes,
            release: candidate.release,
          };
          this.#candidate = undefined;
          this.#requestedBytes = 0;
          this.#budgetBlockedBytes = 0;
          this.#epoch = candidate.epoch;
          this.#retired.add(previous);
          this.#settleWaiters();
          void command.gpuDone.then(
            () => {
              if (this.#retired.delete(previous)) {
                previous.release();
              }
            },
            (error: unknown) => {
              this.#retirementError = String(error);
            },
          );
        });
        for (let bank = 0; bank < BANK_COUNT; bank++) {
          command.copyBufferToBuffer(previous.banks[bank]!, 0, candidate.banks[bank]!, 0, previous.bankBytes);
        }
      }
    }
    // Metadata owners encode their own candidate copies/header after the bank copy.
    for (const listener of this.#listeners) {
      listener(command, this.bankBytes);
    }
  }

  evidence() {
    let freeBytes = 0;
    let allocatorCpuBytes = 0;
    for (const allocator of this.#allocators) {
      freeBytes += allocator.freeUnits * UNIT_BYTES;
      allocatorCpuBytes += allocator.cpuBytes;
    }
    return Object.freeze({
      bankBytes: this.bankBytes,
      allocatedBytes: this.bankBytes * BANK_COUNT,
      usedBytes: this.#active.bankBytes * BANK_COUNT - freeBytes,
      freeBytes,
      leases: this.#leases.size,
      maxPageLeases: this.profile.maxPageLeases,
      allocatorCpuBytes,
      bindingEpoch: this.bindingEpoch,
      lastFailure: this.#lastFailure,
      retirementError: this.#retirementError,
    });
  }

  releaseOwner(): void {
    if (--this.#owners < 0) {
      throw new Error("Geometry pool owner was released twice");
    }
    if (this.#owners !== 0) {
      return;
    }
    if (this.#leases.size !== 0) {
      throw new Error("Geometry byte pool leaked live leases");
    }
    this.#candidate?.command.abort(new Error("Geometry pool destroyed"));
    this.#destroyed = true;
    pools.delete(this.device);
    this.#active.release();
    for (const generation of this.#retired) {
      generation.release();
    }
    this.#retired.clear();
    this.#listeners.clear();
    this.#settleWaiters(new Error("Geometry pool destroyed"));
  }

  #settleWaiters(error?: unknown): void {
    for (const waiter of this.#waiters.splice(0)) {
      if (error === undefined) {
        waiter.resolve();
      } else {
        waiter.reject(error);
      }
    }
  }

  #createBanks(bankBytes: number): BankGeneration {
    const releaseBudget = reserveGeometryProductGpuBytes(
      this.device,
      bankBytes * BANK_COUNT,
      this.profile.capacityBytes,
    );
    const banks: GPUBuffer[] = [];
    try {
      for (let index = 0; index < BANK_COUNT; index++) {
        banks.push(
          this.device.createBuffer({
            label: `OEngine Geometry byte bank ${index}`,
            size: bankBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
          }),
        );
      }
    } catch (error) {
      for (const bank of banks) {
        bank.destroy();
      }
      releaseBudget();
      throw error;
    }
    let released = false;
    return {
      banks: Object.freeze(banks),
      bankBytes,
      release: () => {
        if (!released) {
          released = true;
          for (const bank of banks) {
            bank.destroy();
          }
          releaseBudget();
        }
      },
    };
  }
}

function alignedPayload(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 256 * 1024 || bytes % 4 !== 0) {
    throw new RangeError("Geometry payload prefix is invalid");
  }
  return Math.ceil(bytes / UNIT_BYTES) * UNIT_BYTES;
}
