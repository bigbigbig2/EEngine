import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import type { NativeMaterialProgram } from "../shaders/native_material.js";
import { nativeMaterialParameters } from "../shaders/native_material.js";
import { AppearanceProgramRegistry } from "./AppearanceProgramRegistry.js";
import type { AppearanceProgramDescriptor, AppearanceProgramLease } from "./AppearanceProgramRegistry.js";
import { nativeMaterialRevision } from "./NativeMaterialBindings.js";

export interface NativeMaterialPublicationSource {
  readonly materialSlot: number;
  /** Compatible complete physical material resources, including Product payloads;
   * not merely TextureResidency's owner-local source-bank set number. */
  readonly bindingSet: number;
  readonly program: NativeMaterialProgram;
  /** Full composed native shader and explicit resource layout, including route callbacks. */
  readonly descriptor: AppearanceProgramDescriptor;
  /** Complete resource-limited native continuation; both pipelines publish atomically. */
  readonly continuation?: AppearanceProgramDescriptor;
  readonly parameters?: Readonly<Record<string, readonly number[]>>;
  readonly inputs?: Float32Array<ArrayBuffer>;
  /** Scene-owned monotonic nonzero value revision, when available. */
  readonly valueRevision?: number;
  /** Additional real resource-owner revision; combined with the binding helper's revision. */
  readonly resourceRevision?: number;
  /** Raster and shading share these two instance constants immediately after program.constants. */
  readonly raster?: Readonly<{
    alphaCutoff: number;
    alphaMask: boolean;
    hasEmissiveTexture?: boolean;
  }>;
}

export interface NativeMaterialPublishedEntry {
  readonly materialSlot: number;
  readonly constantBase: number;
  readonly programIndex: number;
  readonly bindingSet: number;
  readonly program: NativeMaterialProgram;
  readonly executionBin: number;
  readonly signature: number;
  readonly valueRevision: number;
}

export interface NativeMaterialExecutionBin {
  readonly programIndex: number;
  readonly bindingSet: number;
}

/** Slot-indexed native material lookup. Invalid slots have programIndex = 0xffffffff. */
export const NATIVE_MATERIAL_DIRECTORY_WORDS = 4;
export const NATIVE_MATERIAL_RASTER_CONSTANT_WORDS = 2;
export const NATIVE_MATERIAL_DIRECTORY_WGSL = /* wgsl */ `
struct NativeMaterialDirectoryEntry {
  constant_base: u32,
  program_index: u32,
  binding_set: u32,
  execution_bin: u32,
}
`;

/**
 * S1 isolated native publication: immutable candidate buffers and asynchronous
 * program leases. No dependency on GpuAppearancePublication, Tape or Surface.
 * The caller owns the active pointer and frame fence. Creation/abort do not
 * change an active snapshot; commit only admits a completely ready candidate.
 * Nothing submits GPU work, allocates a Surface heap or mutates scene ownership.
 */
export class GpuNativeMaterialPublication {
  readonly entries: readonly NativeMaterialPublishedEntry[];
  readonly bins: readonly NativeMaterialExecutionBin[];
  readonly constants: GPUBuffer;
  readonly directory: GPUBuffer;
  /** Slot-indexed vec2u(signature, value_revision); unpublished slots are zero. */
  readonly versions: GPUBuffer;
  readonly materialSlotCount: number;
  readonly ready: Promise<void>;
  private readonly physicalBytes: number;
  private readonly accountingHandles: ResourceHandle[] = [];
  private pipelines: readonly Awaited<AppearanceProgramLease["ready"]>[] | null = null;
  private state: "preparing" | "ready" | "committed" | "retiring" | "destroyed" = "preparing";
  private readonly leases: AppearanceProgramLease[] = [];
  private readonly descriptors: AppearanceProgramDescriptor[] = [];
  private readonly continuations: (AppearanceProgramDescriptor | null)[] = [];
  private readonly primaryLeaseIndices: number[] = [];
  private readonly continuationLeaseIndices: (number | null)[] = [];
  private continuationPipelines: readonly (Awaited<AppearanceProgramLease["ready"]> | null)[] = [];
  private stopListening: (() => void) | null = null;

  constructor(
    device: GPUDevice,
    registry: AppearanceProgramRegistry,
    sources: readonly NativeMaterialPublicationSource[],
    private readonly accounting?: ResourceAccounting
  ) {
    const values: number[] = [];
    const entries: NativeMaterialPublishedEntry[] = [];
    const slots = new Set<number>();
    const programIndices = new Map<string, number>();
    const bins: NativeMaterialExecutionBin[] = [];
    const binIndices = new Map<string, number>();
    let directoryCount = 1;
    // Validate every source and total allocation before acquiring or creating resources.
    for (const source of sources) {
      if (
        !Number.isSafeInteger(source.materialSlot) ||
        source.materialSlot < 0 ||
        source.materialSlot >= 0xffffffff ||
        slots.has(source.materialSlot)
      ) {
        throw new RangeError("Native material slots must be unique finite u32 indices");
      }
      if (
        !Number.isSafeInteger(source.bindingSet) ||
        source.bindingSet < 0 ||
        source.bindingSet >= 0xffffffff
      ) {
        throw new RangeError("Native material binding set must be a finite u32 index");
      }
      registry.preflight(source.descriptor);
      if (source.continuation !== undefined) {
        registry.preflight(source.continuation);
      }
      for (const revision of [source.valueRevision, source.resourceRevision]) {
        if (
          revision !== undefined &&
          (!Number.isInteger(revision) || revision < 1 || revision > 0xffffffff)
        ) {
          throw new RangeError("Native material revisions must be nonzero u32 values");
        }
      }
      slots.add(source.materialSlot);
      directoryCount = Math.max(directoryCount, source.materialSlot + 1);
      const parameters = nativeMaterialParameters(source.program, source.parameters);
      const alphaCutoff = Math.fround(source.raster?.alphaCutoff ?? 0.5);
      if (
        !Number.isFinite(alphaCutoff) ||
        (source.raster !== undefined && typeof source.raster.alphaMask !== "boolean") ||
        (source.raster?.hasEmissiveTexture !== undefined &&
          typeof source.raster.hasEmissiveTexture !== "boolean")
      ) {
        throw new RangeError("Native material raster requires a finite cutoff and boolean flags");
      }
      const instanceInputs = source.program.instanceInputs ? source.inputs : undefined;
      if (
        source.program.instanceInputs &&
        (instanceInputs === undefined ||
          instanceInputs.length !== Math.max(1, source.program.inputCount) * 4 ||
          !instanceInputs.every(Number.isFinite))
      ) {
        throw new RangeError("Native instance input publication requires every compiled input slot");
      }
      const data = new Float32Array(
        parameters.length + NATIVE_MATERIAL_RASTER_CONSTANT_WORDS + (instanceInputs?.length ?? 0)
      );
      data.set(parameters);
      data[parameters.length] = Math.max(0, Math.min(1, alphaCutoff));
      data[parameters.length + 1] =
        Number(source.raster?.alphaMask ?? false) | (Number(source.raster?.hasEmissiveTexture ?? false) << 1);
      if (instanceInputs !== undefined) {
        data.set(instanceInputs, parameters.length + NATIVE_MATERIAL_RASTER_CONSTANT_WORDS);
      }
      const bits = new Uint32Array(data.buffer, data.byteOffset, data.length);
      // These hashes only reject temporal reuse after changes. They are not exact identity,
      // cache keys, or substitutes for a scene owner's monotonic value revision.
      const signature = nativeMaterialRevision([source.program.key, source.bindingSet]);
      const valueRevision =
        source.valueRevision ??
        nativeMaterialRevision([source.program.resourceRevision ?? 0, source.resourceRevision ?? 0, ...bits]);
      entries.push(
        Object.freeze({
          materialSlot: source.materialSlot,
          bindingSet: source.bindingSet,
          constantBase: values.length,
          programIndex: 0,
          executionBin: 0,
          signature,
          valueRevision,
          program: source.program
        })
      );
      for (const value of data) {
        values.push(value);
      }
    }
    const constantBytes = Math.max(values.length * 4, 4);
    const directoryBytes = directoryCount * NATIVE_MATERIAL_DIRECTORY_WORDS * 4;
    const versionBytes = directoryCount * 8;
    const maximum = Math.min(
      Number(device.limits.maxBufferSize),
      Number(device.limits.maxStorageBufferBindingSize)
    );
    if (constantBytes > maximum || directoryBytes > maximum || versionBytes > maximum) {
      throw new RangeError("Native material publication exceeds negotiated buffer limits");
    }
    this.physicalBytes = constantBytes + directoryBytes + versionBytes;
    this.materialSlotCount = directoryCount;
    const buffers: GPUBuffer[] = [];
    try {
      sources.forEach((source, index) => {
        const lease = registry.acquire(source.descriptor);
        let continuation: AppearanceProgramLease | null = null;
        try {
          continuation = source.continuation === undefined ? null : registry.acquire(source.continuation);
        } catch (error) {
          lease.release();
          throw error;
        }
        const programKey = JSON.stringify([lease.key, continuation?.key ?? null]);
        let programIndex = programIndices.get(programKey);
        if (programIndex === undefined) {
          programIndex = this.descriptors.length;
          programIndices.set(programKey, programIndex);
          this.primaryLeaseIndices.push(this.leases.length);
          this.leases.push(lease);
          this.continuationLeaseIndices.push(continuation === null ? null : this.leases.length);
          if (continuation !== null) {
            this.leases.push(continuation);
          }
          const descriptor = structuredClone(source.descriptor);
          for (const group of descriptor.groups) {
            for (const entry of group) {
              for (const field of ["buffer", "sampler", "texture", "storageTexture"] as const) {
                if (entry[field] !== undefined) {
                  Object.freeze(entry[field]);
                }
              }
              Object.freeze(entry);
            }
            Object.freeze(group);
          }
          Object.freeze(descriptor.groups);
          this.descriptors.push(Object.freeze(descriptor));
          const next = source.continuation === undefined ? null : structuredClone(source.continuation);
          if (next !== null) {
            for (const group of next.groups) {
              for (const entry of group) {
                for (const field of ["buffer", "sampler", "texture", "storageTexture"] as const) {
                  if (entry[field] !== undefined) {
                    Object.freeze(entry[field]);
                  }
                }
                Object.freeze(entry);
              }
              Object.freeze(group);
            }
            Object.freeze(next.groups);
            Object.freeze(next);
          }
          this.continuations.push(next);
        } else {
          lease.release();
          continuation?.release();
        }
        const binKey = `${programIndex}/${source.bindingSet}`;
        let executionBin = binIndices.get(binKey);
        if (executionBin === undefined) {
          executionBin = bins.length;
          binIndices.set(binKey, executionBin);
          bins.push(Object.freeze({ programIndex, bindingSet: source.bindingSet }));
        }
        entries[index] = Object.freeze({ ...entries[index]!, programIndex, executionBin });
      });
      this.entries = Object.freeze(entries);
      this.bins = Object.freeze(bins);
      this.constants = device.createBuffer({
        label: "SurfaceV4/material constants",
        size: constantBytes,
        usage: GPUBufferUsage.STORAGE,
        mappedAtCreation: true
      });
      buffers.push(this.constants);
      new Float32Array(this.constants.getMappedRange()).set(values);
      this.constants.unmap();
      this.directory = device.createBuffer({
        label: "SurfaceV4/material directory",
        size: directoryBytes,
        usage: GPUBufferUsage.STORAGE,
        mappedAtCreation: true
      });
      buffers.push(this.directory);
      const directory = new Uint32Array(this.directory.getMappedRange());
      for (let slot = 0; slot < directoryCount; slot++) {
        directory[slot * NATIVE_MATERIAL_DIRECTORY_WORDS + 1] = 0xffffffff;
        directory[slot * NATIVE_MATERIAL_DIRECTORY_WORDS + 3] = 0xffffffff;
      }
      for (const entry of entries) {
        directory.set(
          [entry.constantBase, entry.programIndex, entry.bindingSet, entry.executionBin],
          entry.materialSlot * NATIVE_MATERIAL_DIRECTORY_WORDS
        );
      }
      this.directory.unmap();
      this.versions = device.createBuffer({
        label: "SurfaceV4/material versions",
        size: versionBytes,
        usage: GPUBufferUsage.STORAGE,
        mappedAtCreation: true
      });
      buffers.push(this.versions);
      const versions = new Uint32Array(this.versions.getMappedRange());
      for (const entry of entries) {
        versions.set([entry.signature, entry.valueRevision], entry.materialSlot * 2);
      }
      this.versions.unmap();
      for (const buffer of buffers) {
        const handle = accounting?.created(
          {
            kind: "buffer",
            category: "resident",
            owner: "GpuNativeMaterialPublication",
            bytes: buffer.size,
            label: buffer.label
          },
          buffer
        );
        if (handle !== undefined) {
          this.accountingHandles.push(handle);
        }
      }
    } catch (error) {
      buffers.forEach((buffer) => buffer.destroy());
      this.leases.forEach((lease) => lease.release());
      throw error;
    }
    this.ready = Promise.all(this.leases.map((lease) => lease.ready))
      .then((pipelines) => {
        if (this.state !== "preparing") {
          throw new Error("Native material publication was cancelled");
        }
        this.pipelines = Object.freeze(this.primaryLeaseIndices.map((index) => pipelines[index]!));
        this.continuationPipelines = Object.freeze(
          this.continuationLeaseIndices.map((index) => (index === null ? null : pipelines[index]!))
        );
        this.state = "ready";
      })
      .catch((error: unknown) => {
        this.destroy();
        throw error;
      });
    void this.ready.catch(() => undefined);
    this.stopListening = registry.onStopped(() => this.destroy());
  }

  commit(): void {
    if (this.state !== "ready") {
      throw new Error("Only a complete native publication can commit");
    }
    this.state = "committed";
  }

  get allocatedBytes(): number {
    return this.state === "destroyed" ? 0 : this.physicalBytes;
  }

  pipeline(programIndex: number): Awaited<AppearanceProgramLease["ready"]> {
    if (this.state !== "ready" && this.state !== "committed") {
      throw new Error("Native material publication is not available for encoding");
    }
    const result = this.pipelines?.[programIndex];
    if (result === undefined) {
      throw new RangeError("Unknown native program index");
    }
    return result;
  }

  /** Immutable publication-time layout/source snapshot, with the same encoding availability as pipeline(). */
  descriptor(programIndex: number): AppearanceProgramDescriptor {
    this.pipeline(programIndex);
    return this.descriptors[programIndex]!;
  }

  continuation(
    programIndex: number
  ): { descriptor: AppearanceProgramDescriptor; pipeline: Awaited<AppearanceProgramLease["ready"]> } | null {
    this.pipeline(programIndex);
    const descriptor = this.continuations[programIndex];
    const pipeline = this.continuationPipelines[programIndex];
    return descriptor && pipeline ? { descriptor, pipeline } : null;
  }

  /** Candidate cancellation. Committed GPU ownership must retire against its actual frame fence. */
  abort(): void {
    if (this.state === "committed" || this.state === "retiring") {
      throw new Error("A committed native publication requires fence retirement");
    }
    this.destroy();
  }

  retire(completion: Promise<void>): Promise<void> {
    if (this.state !== "committed") {
      throw new Error("Only a committed native publication can retire");
    }
    this.state = "retiring";
    this.accountingHandles.forEach((handle) => this.accounting?.setRetired(handle, true));
    return completion.finally(() => this.destroy());
  }

  /** Device/owner teardown. Ordinary committed replacement uses retire(fence). */
  destroy(): void {
    if (this.state === "destroyed") {
      return;
    }
    this.state = "destroyed";
    this.stopListening?.();
    this.stopListening = null;
    this.constants.destroy();
    this.directory.destroy();
    this.versions.destroy();
    this.accountingHandles.forEach((handle) => this.accounting?.destroyed(handle));
    this.accountingHandles.length = 0;
    this.leases.forEach((lease) => lease.release());
    this.pipelines = null;
    this.continuationPipelines = [];
  }
}
