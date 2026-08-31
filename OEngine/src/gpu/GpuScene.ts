import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { AssetHandle, GpuAssetStore } from "./GpuAssetStore.js";
import { mat4 } from "gl-matrix";
import {
  computePreviousFromCurrent,
  createGpuInstanceMotionScratch,
  GPU_INSTANCE_ABI_VERSION,
  GPU_INSTANCE_FLAGS,
  GPU_INSTANCE_RECORD_OFFSETS,
  GPU_INSTANCE_RECORD_STRIDE
} from "./GpuInstanceAbi.js";
import { recordGpuQueueUpload } from "./GpuQueueEvidence.js";

declare const INSTANCE_SET_HANDLE_BRAND: unique symbol;

/** Opaque handle for one contiguous bulk allocation in the GPU Instance table. */
export interface InstanceSetHandle {
  readonly [INSTANCE_SET_HANDLE_BRAND]: true;
}

/**
 * Structure-of-arrays source for bulk/mostly-static instances.
 * Geometry indices address `geometryHandles`, never a GPU record or byte offset.
 */
export interface InstanceSource {
  readonly count: number;
  readonly geometryHandles: readonly AssetHandle[];
  readonly geometryIndices: Uint32Array;
  readonly materialHandles: Uint32Array;
  readonly currentTransforms: Float32Array;
  readonly previousTransforms?: Float32Array;
  readonly boundsSpheres: Float32Array;
  readonly boundsMin?: Float32Array;
  readonly boundsMax?: Float32Array;
  readonly flags?: Uint32Array;
  readonly debugIds?: Uint32Array;
}

export interface InstanceTransformPatch {
  readonly indices: Uint32Array;
  readonly transforms: Float32Array;
}

export interface InstanceMaterialPatch {
  readonly indices: Uint32Array;
  readonly materialHandles: Uint32Array;
  /** Optional classification flags written atomically with each material handle. */
  readonly flags?: Uint32Array;
}

/** One explicit frame batch. Duplicate indices use the final value in the batch. */
export interface InstancePatchBatch {
  readonly frameId: number;
  readonly transforms?: InstanceTransformPatch;
  readonly materials?: InstanceMaterialPatch;
}

type SceneCommandSignal = {
  addOne(listener: (...args: any[]) => void): void;
};

/** Structural subset implemented by ShadeGPUCommandContext and browser evidence commands. */
export interface GpuSceneCommand {
  readonly device: GPUDevice;
  readonly onFinished: SceneCommandSignal;
  readonly onAborted: SceneCommandSignal;
  readonly closed?: boolean;
  copyBufferToBuffer(
    source: GPUBuffer,
    sourceOffset: number,
    destination: GPUBuffer,
    destinationOffset: number,
    size?: number
  ): void;
  writeBuffer(
    buffer: GPUBuffer,
    bufferOffset: number,
    data: ArrayBuffer,
    dataOffset: number,
    size: number
  ): void;
}

export interface GpuSceneBindings {
  readonly abiVersion: number;
  readonly epoch: number;
  readonly instances: GPUBuffer;
  readonly recordStride: number;
  readonly highWaterCount: number;
  readonly activeCount: number;
}

export interface InstancePatchResult {
  readonly transformCount: number;
  readonly materialCount: number;
  readonly dirtyInstanceCount: number;
  readonly dirtySpanCount: number;
  readonly sourceBytes: number;
  readonly uploadedBytes: number;
  readonly density: number;
}

export interface GpuSceneEvidence {
  readonly schemaVersion: 1;
  readonly abiVersion: number;
  readonly recordStride: number;
  readonly instanceSetCount: number;
  readonly activeInstanceCount: number;
  readonly highWaterInstanceCount: number;
  readonly logicalBytes: number;
  readonly residentBytes: number;
  readonly allocatedBytes: number;
  readonly retiringBytes: number;
  readonly peakAllocatedBytes: number;
  readonly reclaimableBytes: number;
  readonly cpuShadowBytes: number;
  readonly bulkInstantiateCount: number;
  readonly bulkInstanceCount: number;
  readonly patchBatchCount: number;
  readonly patchedTransformCount: number;
  readonly patchedMaterialCount: number;
  readonly dirtySpanCount: number;
  readonly stableNoopCount: number;
  readonly uploadCalls: number;
  readonly uploadSourceBytes: number;
  readonly uploadedBytes: number;
  readonly uploadPaddingBytes: number;
  readonly patchExpansionBytes: number;
  readonly attemptedGrowCount: number;
  readonly committedGrowCount: number;
  readonly retiredBufferCount: number;
  readonly destroyedRetiredBufferCount: number;
  readonly abortedMutationCount: number;
  readonly releaseCount: number;
  readonly privateSubmitCount: 0;
  readonly pendingMutation: "instantiate" | "patch" | "release" | null;
  readonly lastPatch: InstancePatchResult | null;
}

type EntryState =
  | "pending"
  | "resident"
  | "pending-patch"
  | "pending-release"
  | "released"
  | "aborted";

interface InstanceSetEntry {
  readonly handle: InstanceSetHandle;
  readonly slot: number;
  readonly generation: number;
  readonly start: number;
  readonly count: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly lastTransformFrame: Uint32Array;
  state: EntryState;
}

interface SlotState {
  generation: number;
  entry?: InstanceSetEntry;
}

interface HandleRuntimeState {
  readonly scene: GpuScene;
  readonly slot: number;
  readonly generation: number;
}

interface BufferReplacement {
  readonly previous: GPUBuffer;
  readonly next: GPUBuffer;
}

interface MutationUpload {
  calls: number;
  sourceBytes: number;
  uploadedBytes: number;
}

const HANDLE_STATE = new WeakMap<object, HandleRuntimeState>();
const STORAGE_USAGE =
  GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
const U32_MAX = 0xffffffff;
const NEVER_PATCHED_FRAME = U32_MAX;

/** Public semantic flags accepted by InstanceSource; byte layout stays internal. */
export const INSTANCE_SOURCE_FLAGS = GPU_INSTANCE_FLAGS;

/**
 * Unique owner of the compact GPU Instance table.
 *
 * The first implementation is append/bulk-first. It deliberately uses the
 * caller's command for grow and patch copies and never creates a private submit.
 */
export class GpuScene {
  private readonly motionScratch = createGpuInstanceMotionScratch();
  private buffer: GPUBuffer;
  private readonly slots: SlotState[] = [{ generation: 0 }];
  private readonly freeSlots: number[] = [];
  private cursorCount = 1;
  private activeInstanceCount = 0;
  private instanceSetCount = 0;
  private epoch = 1;
  private destroyed = false;
  private pendingMutation: GpuSceneEvidence["pendingMutation"] = null;
  private logicalBytes = 0;
  private reclaimableBytes = 0;
  private cpuShadowBytes = 0;
  private retiringBytes = 0;
  private peakAllocatedBytes = 0;
  private bulkInstantiateCount = 0;
  private bulkInstanceCount = 0;
  private patchBatchCount = 0;
  private patchedTransformCount = 0;
  private patchedMaterialCount = 0;
  private dirtySpanCount = 0;
  private stableNoopCount = 0;
  private uploadCalls = 0;
  private uploadSourceBytes = 0;
  private uploadedBytes = 0;
  private attemptedGrowCount = 0;
  private committedGrowCount = 0;
  private retiredBufferCount = 0;
  private destroyedRetiredBufferCount = 0;
  private abortedMutationCount = 0;
  private releaseCount = 0;
  private lastPatch: InstancePatchResult | null = null;

  constructor(
    private readonly device: GPUDevice,
    private readonly assets: GpuAssetStore
  ) {
    this.buffer = this.createZeroBuffer(
      "GpuScene/instances/fallback",
      GPU_INSTANCE_RECORD_STRIDE
    );
    this.peakAllocatedBytes = this.buffer.size;
  }

  instantiate(
    source: InstanceSource,
    command: ShadeGPUCommandContext | GpuSceneCommand
  ): InstanceSetHandle {
    this.assertMutation(command, "instantiate");
    const cursorBefore = this.cursorCount;
    let replacement: BufferReplacement | null = null;
    let entry: InstanceSetEntry | undefined;
    let reusedSlot = false;
    let slot = -1;
    try {
      validateInstanceSource(source);
      const requiredCount = checkedAdd(cursorBefore, source.count, "Instance high-water count");
      this.assertCapacity(requiredCount);
      const records = this.packSource(source);
      if (requiredCount * GPU_INSTANCE_RECORD_STRIDE > this.buffer.size) {
        replacement = this.grow(requiredCount, command);
      }

      slot = this.freeSlots.length > 0
        ? this.freeSlots[this.freeSlots.length - 1]!
        : this.slots.length;
      reusedSlot = slot < this.slots.length;
      const generation = reusedSlot ? this.slots[slot]!.generation : 1;
      if (reusedSlot) this.freeSlots.pop();
      else this.slots.push({ generation });

      const handle = Object.freeze({}) as InstanceSetHandle;
      entry = {
        handle,
        slot,
        generation,
        start: cursorBefore,
        count: source.count,
        bytes: records,
        lastTransformFrame: new Uint32Array(source.count).fill(NEVER_PATCHED_FRAME),
        state: "pending"
      };
      this.slots[slot]!.entry = entry;
      HANDLE_STATE.set(handle as object, { scene: this, slot, generation });
      this.cursorCount = requiredCount;
      const byteOffset = cursorBefore * GPU_INSTANCE_RECORD_STRIDE;
      command.writeBuffer(
        this.buffer,
        byteOffset,
        records.buffer,
        records.byteOffset,
        records.byteLength
      );
      recordGpuQueueUpload(this.device.queue, "GpuScene/bulk-instances", records.byteLength);
      const upload = { calls: 1, sourceBytes: records.byteLength, uploadedBytes: records.byteLength };
      const committed = entry;
      command.onFinished.addOne(() => {
        if (committed.state !== "pending") return;
        committed.state = "resident";
        this.instanceSetCount++;
        this.activeInstanceCount += committed.count;
        this.logicalBytes += committed.bytes.byteLength;
        this.cpuShadowBytes += committed.bytes.byteLength + committed.lastTransformFrame.byteLength;
        this.bulkInstantiateCount++;
        this.bulkInstanceCount += committed.count;
        this.commitUpload(upload);
        if (replacement !== null) this.commitReplacement(replacement);
        this.epoch++;
        this.pendingMutation = null;
      });
      command.onAborted.addOne(() => {
        if (committed.state !== "pending") return;
        committed.state = "aborted";
        this.cursorCount = cursorBefore;
        this.slots[committed.slot]!.entry = undefined;
        if (reusedSlot) this.freeSlots.push(committed.slot);
        else if (committed.slot === this.slots.length - 1) this.slots.pop();
        if (replacement !== null) this.rollbackReplacement(replacement);
        this.abortedMutationCount++;
        this.pendingMutation = null;
      });
      return handle;
    } catch (error) {
      if (entry !== undefined) entry.state = "aborted";
      this.cursorCount = cursorBefore;
      if (slot >= 1) {
        if (!reusedSlot && slot === this.slots.length - 1) this.slots.pop();
        else if (reusedSlot && !this.freeSlots.includes(slot)) this.freeSlots.push(slot);
      }
      if (replacement !== null) this.rollbackReplacement(replacement);
      this.pendingMutation = null;
      throw error;
    }
  }

  patch(
    handle: InstanceSetHandle,
    batch: InstancePatchBatch,
    command: ShadeGPUCommandContext | GpuSceneCommand
  ): InstancePatchResult {
    this.assertAlive();
    const entry = this.requireEntry(handle, "resident");
    assertU32(batch.frameId, "Patch frameId");
    const transformOrders = normalizePatch(
      batch.transforms?.indices,
      batch.transforms?.transforms,
      16,
      entry.count,
      "transform"
    );
    const materialOrders = normalizePatch(
      batch.materials?.indices,
      batch.materials?.materialHandles,
      1,
      entry.count,
      "material"
    );
    if (batch.materials?.flags !== undefined &&
      batch.materials.flags.length !== batch.materials.materialHandles.length) {
      throw new RangeError("material patch flags and materialHandles must match");
    }
    if (batch.transforms !== undefined) {
      for (let index = 0; index < batch.transforms.transforms.length; index++) {
        if (!Number.isFinite(batch.transforms.transforms[index])) {
          throw new RangeError(`transform patch value ${index} must be finite`);
        }
      }
    }
    if (transformOrders.length === 0 && materialOrders.length === 0) {
      this.stableNoopCount++;
      return Object.freeze({
        transformCount: 0,
        materialCount: 0,
        dirtyInstanceCount: 0,
        dirtySpanCount: 0,
        sourceBytes: 0,
        uploadedBytes: 0,
        density: 0
      });
    }
    this.assertMutation(command, "patch");
    entry.state = "pending-patch";

    const dirtyMask = new Uint8Array(entry.count);
    markPatchIndices(dirtyMask, batch.transforms?.indices, transformOrders);
    markPatchIndices(dirtyMask, batch.materials?.indices, materialOrders);
    const dirtyIndices = compactDirtyIndices(dirtyMask);
    const previousRecords = copyRecords(entry.bytes, dirtyIndices);
    const previousFrames = new Uint32Array(transformOrders.length);
    const transformIndices = batch.transforms?.indices;
    const transformValues = batch.transforms?.transforms;
    const materialIndices = batch.materials?.indices;
    const materialValues = batch.materials?.materialHandles;
    const materialFlags = batch.materials?.flags;
    const recordView = new DataView(
      entry.bytes.buffer,
      entry.bytes.byteOffset,
      entry.bytes.byteLength
    );

    try {
      for (let cursor = 0; cursor < transformOrders.length; cursor++) {
        const order = transformOrders[cursor]!;
        const localIndex = transformIndices![order]!;
        previousFrames[cursor] = entry.lastTransformFrame[localIndex]!;
        const recordOffset = localIndex * GPU_INSTANCE_RECORD_STRIDE;
        const flagsOffset = recordOffset + GPU_INSTANCE_RECORD_OFFSETS.flags;
        const previousFlags = recordView.getUint32(flagsOffset, true);
        const sameFrame = entry.lastTransformFrame[localIndex] === batch.frameId;
        let motionValid = false;
        if (sameFrame && (previousFlags & GPU_INSTANCE_FLAGS.MotionInvalid) !== 0) {
          // The prior-frame transform cannot be reconstructed from an invalid
          // motion record. Keep velocity disabled for the rest of this frame.
          mat4.identity(this.motionScratch.previousFromCurrent);
        } else {
          readMatrix(
            this.motionScratch.inverseCurrent,
            entry.bytes,
            recordOffset + GPU_INSTANCE_RECORD_OFFSETS.current_object_to_world
          );
          if (sameFrame) {
            readMatrix(
              this.motionScratch.previous,
              entry.bytes,
              recordOffset + GPU_INSTANCE_RECORD_OFFSETS.previous_from_current
            );
            mat4.multiply(
              this.motionScratch.inverseCurrent,
              this.motionScratch.previous,
              this.motionScratch.inverseCurrent
            );
          }
          motionValid = computePreviousFromCurrent(
            this.motionScratch.previousFromCurrent,
            transformValues!,
            this.motionScratch.inverseCurrent,
            order * 16,
            0,
            this.motionScratch
          );
        }
        writeMatrix(
          entry.bytes,
          recordOffset + GPU_INSTANCE_RECORD_OFFSETS.current_object_to_world,
          transformValues!,
          order * 16,
          `transforms[${order}]`
        );
        writeMatrix(
          entry.bytes,
          recordOffset + GPU_INSTANCE_RECORD_OFFSETS.previous_from_current,
          this.motionScratch.previousFromCurrent,
          0,
          `previousFromCurrent[${order}]`
        );
        recordView.setUint32(
          flagsOffset,
          (motionValid
            ? previousFlags & ~GPU_INSTANCE_FLAGS.MotionInvalid
            : previousFlags | GPU_INSTANCE_FLAGS.MotionInvalid) >>> 0,
          true
        );
        entry.lastTransformFrame[localIndex] = batch.frameId;
      }
      for (let cursor = 0; cursor < materialOrders.length; cursor++) {
        const order = materialOrders[cursor]!;
        const localIndex = materialIndices![order]!;
        const material = materialValues![order]!;
        assertU32(material, `materialHandles[${order}]`);
        recordView.setUint32(
          localIndex * GPU_INSTANCE_RECORD_STRIDE + GPU_INSTANCE_RECORD_OFFSETS.material_handle,
          material,
          true
        );
        if (materialFlags !== undefined) {
          const flagsOffset = localIndex * GPU_INSTANCE_RECORD_STRIDE +
            GPU_INSTANCE_RECORD_OFFSETS.flags;
          const preserved = recordView.getUint32(flagsOffset, true) &
            (GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.MotionInvalid);
          recordView.setUint32(flagsOffset, (preserved | materialFlags[order]!) >>> 0, true);
        }
      }

      const density = dirtyIndices.length / entry.count;
      const spans = coalesceDirtySpans(dirtyIndices, density >= 0.1 ? 8 : 0);
      let uploadedBytes = 0;
      for (const span of spans) {
        const localByteOffset = span.begin * GPU_INSTANCE_RECORD_STRIDE;
        const byteLength = (span.end - span.begin) * GPU_INSTANCE_RECORD_STRIDE;
        command.writeBuffer(
          this.buffer,
          (entry.start + span.begin) * GPU_INSTANCE_RECORD_STRIDE,
          entry.bytes.buffer,
          entry.bytes.byteOffset + localByteOffset,
          byteLength
        );
        recordGpuQueueUpload(this.device.queue, "GpuScene/patch-instances", byteLength);
        uploadedBytes += byteLength;
      }
      const sourceBytes = transformOrders.length * 16 * 4 +
        materialOrders.length * (materialFlags === undefined ? 4 : 8);
      const result = Object.freeze({
        transformCount: transformOrders.length,
        materialCount: materialOrders.length,
        dirtyInstanceCount: dirtyIndices.length,
        dirtySpanCount: spans.length,
        sourceBytes,
        uploadedBytes,
        density
      });
      const upload = { calls: spans.length, sourceBytes, uploadedBytes };
      command.onFinished.addOne(() => {
        if (entry.state !== "pending-patch") return;
        entry.state = "resident";
        this.patchBatchCount++;
        this.patchedTransformCount += result.transformCount;
        this.patchedMaterialCount += result.materialCount;
        this.dirtySpanCount += result.dirtySpanCount;
        this.lastPatch = result;
        this.commitUpload(upload);
        this.epoch++;
        this.pendingMutation = null;
      });
      command.onAborted.addOne(() => {
        if (entry.state !== "pending-patch") return;
        restoreRecords(entry.bytes, dirtyIndices, previousRecords);
        for (let cursor = 0; cursor < transformOrders.length; cursor++) {
          const order = transformOrders[cursor]!;
          entry.lastTransformFrame[transformIndices![order]!] = previousFrames[cursor]!;
        }
        entry.state = "resident";
        this.abortedMutationCount++;
        this.pendingMutation = null;
      });
      return result;
    } catch (error) {
      restoreRecords(entry.bytes, dirtyIndices, previousRecords);
      for (let cursor = 0; cursor < transformOrders.length; cursor++) {
        const order = transformOrders[cursor]!;
        entry.lastTransformFrame[transformIndices![order]!] = previousFrames[cursor]!;
      }
      entry.state = "resident";
      this.pendingMutation = null;
      throw error;
    }
  }

  release(
    handle: InstanceSetHandle,
    command: ShadeGPUCommandContext | GpuSceneCommand
  ): void {
    this.assertMutation(command, "release");
    try {
      const entry = this.requireEntry(handle, "resident");
      entry.state = "pending-release";
      const zero = new Uint8Array(entry.bytes.byteLength);
      command.writeBuffer(
        this.buffer,
        entry.start * GPU_INSTANCE_RECORD_STRIDE,
        zero.buffer,
        0,
        zero.byteLength
      );
      recordGpuQueueUpload(this.device.queue, "GpuScene/release-instances", zero.byteLength);
      command.onFinished.addOne(() => {
        if (entry.state !== "pending-release") return;
        entry.state = "released";
        const slot = this.slots[entry.slot]!;
        slot.entry = undefined;
        slot.generation = nextGeneration(slot.generation);
        this.freeSlots.push(entry.slot);
        this.instanceSetCount--;
        this.activeInstanceCount -= entry.count;
        this.logicalBytes -= entry.bytes.byteLength;
        this.cpuShadowBytes -= entry.bytes.byteLength + entry.lastTransformFrame.byteLength;
        this.reclaimableBytes += entry.bytes.byteLength;
        this.releaseCount++;
        this.commitUpload({
          calls: 1,
          sourceBytes: zero.byteLength,
          uploadedBytes: zero.byteLength
        });
        this.epoch++;
        this.pendingMutation = null;
      });
      command.onAborted.addOne(() => {
        if (entry.state !== "pending-release") return;
        entry.state = "resident";
        this.abortedMutationCount++;
        this.pendingMutation = null;
      });
    } catch (error) {
      this.pendingMutation = null;
      throw error;
    }
  }

  bindings(): GpuSceneBindings {
    this.assertAlive();
    return Object.freeze({
      abiVersion: GPU_INSTANCE_ABI_VERSION,
      epoch: this.epoch,
      instances: this.buffer,
      recordStride: GPU_INSTANCE_RECORD_STRIDE,
      highWaterCount: this.cursorCount,
      activeCount: this.activeInstanceCount
    });
  }

  /** Internal consumer/debug seam; not exported through Renderer. */
  range(handle: InstanceSetHandle): Readonly<{ start: number; count: number }> {
    const entry = this.requireEntry(handle, "pending", "resident", "pending-patch");
    return Object.freeze({ start: entry.start, count: entry.count });
  }

  evidence(): GpuSceneEvidence {
    return Object.freeze({
      schemaVersion: 1,
      abiVersion: GPU_INSTANCE_ABI_VERSION,
      recordStride: GPU_INSTANCE_RECORD_STRIDE,
      instanceSetCount: this.instanceSetCount,
      activeInstanceCount: this.activeInstanceCount,
      highWaterInstanceCount: this.cursorCount,
      logicalBytes: this.logicalBytes,
      residentBytes: this.cursorCount * GPU_INSTANCE_RECORD_STRIDE,
      allocatedBytes: this.buffer.size,
      retiringBytes: this.retiringBytes,
      peakAllocatedBytes: this.peakAllocatedBytes,
      reclaimableBytes: this.reclaimableBytes,
      cpuShadowBytes: this.cpuShadowBytes,
      bulkInstantiateCount: this.bulkInstantiateCount,
      bulkInstanceCount: this.bulkInstanceCount,
      patchBatchCount: this.patchBatchCount,
      patchedTransformCount: this.patchedTransformCount,
      patchedMaterialCount: this.patchedMaterialCount,
      dirtySpanCount: this.dirtySpanCount,
      stableNoopCount: this.stableNoopCount,
      uploadCalls: this.uploadCalls,
      uploadSourceBytes: this.uploadSourceBytes,
      uploadedBytes: this.uploadedBytes,
      uploadPaddingBytes: 0,
      patchExpansionBytes: this.uploadedBytes - this.uploadSourceBytes,
      attemptedGrowCount: this.attemptedGrowCount,
      committedGrowCount: this.committedGrowCount,
      retiredBufferCount: this.retiredBufferCount,
      destroyedRetiredBufferCount: this.destroyedRetiredBufferCount,
      abortedMutationCount: this.abortedMutationCount,
      releaseCount: this.releaseCount,
      privateSubmitCount: 0,
      pendingMutation: this.pendingMutation,
      lastPatch: this.lastPatch
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    if (this.pendingMutation !== null) {
      throw new Error("GpuScene cannot be destroyed during a pending mutation");
    }
    this.destroyed = true;
    this.buffer.destroy();
    for (const slot of this.slots) {
      if (slot.entry !== undefined) slot.entry.state = "released";
      slot.entry = undefined;
    }
    this.freeSlots.length = 0;
  }

  private packSource(source: InstanceSource): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(source.count * GPU_INSTANCE_RECORD_STRIDE);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < source.count; index++) {
      const base = index * GPU_INSTANCE_RECORD_STRIDE;
      const geometryLocal = source.geometryIndices[index]!;
      const geometry = source.geometryHandles[geometryLocal];
      if (geometry === undefined) {
        throw new RangeError(`geometryIndices[${index}] is outside geometryHandles`);
      }
      view.setUint32(
        base + GPU_INSTANCE_RECORD_OFFSETS.geometry_record_index,
        this.assets.recordIndex(geometry),
        true
      );
      view.setUint32(
        base + GPU_INSTANCE_RECORD_OFFSETS.material_handle,
        source.materialHandles[index]!,
        true
      );
      let flags = (source.flags?.[index] ?? 0) | GPU_INSTANCE_FLAGS.Active;
      view.setUint32(
        base + GPU_INSTANCE_RECORD_OFFSETS.debug_id,
        source.debugIds?.[index] ?? index,
        true
      );
      copyFiniteF32(view, base + GPU_INSTANCE_RECORD_OFFSETS.bounds_sphere, source.boundsSpheres, index * 4, 4, "boundsSpheres");
      if (source.boundsMin === undefined) {
        writeDefaultBounds(view, base + GPU_INSTANCE_RECORD_OFFSETS.bounds_min, -1);
      } else {
        copyFiniteF32(view, base + GPU_INSTANCE_RECORD_OFFSETS.bounds_min, source.boundsMin, index * 3, 3, "boundsMin");
      }
      if (source.boundsMax === undefined) {
        writeDefaultBounds(view, base + GPU_INSTANCE_RECORD_OFFSETS.bounds_max, 1);
      } else {
        copyFiniteF32(view, base + GPU_INSTANCE_RECORD_OFFSETS.bounds_max, source.boundsMax, index * 3, 3, "boundsMax");
      }
      copyFiniteF32(view, base + GPU_INSTANCE_RECORD_OFFSETS.current_object_to_world, source.currentTransforms, index * 16, 16, "currentTransforms");
      const motionValid = computePreviousFromCurrent(
        this.motionScratch.previousFromCurrent,
        source.currentTransforms,
        source.previousTransforms ?? source.currentTransforms,
        index * 16,
        index * 16,
        this.motionScratch
      );
      flags = (motionValid
        ? flags & ~GPU_INSTANCE_FLAGS.MotionInvalid
        : flags | GPU_INSTANCE_FLAGS.MotionInvalid) >>> 0;
      view.setUint32(base + GPU_INSTANCE_RECORD_OFFSETS.flags, flags >>> 0, true);
      copyFiniteF32(
        view,
        base + GPU_INSTANCE_RECORD_OFFSETS.previous_from_current,
        this.motionScratch.previousFromCurrent,
        0,
        16,
        "previousFromCurrent"
      );
    }
    return bytes;
  }

  private grow(
    requiredCount: number,
    command: ShadeGPUCommandContext | GpuSceneCommand
  ): BufferReplacement {
    const previous = this.buffer;
    const requiredBytes = requiredCount * GPU_INSTANCE_RECORD_STRIDE;
    const limit = this.storageLimit();
    let nextSize = Math.max(
      requiredBytes,
      previous.size + Math.max(previous.size >>> 1, 4096)
    );
    nextSize = align4(Math.min(nextSize, limit));
    if (nextSize < requiredBytes) nextSize = requiredBytes;
    const next = this.device.createBuffer({
      label: `GpuScene/instances/grow-${nextSize}`,
      size: nextSize,
      usage: STORAGE_USAGE
    });
    command.copyBufferToBuffer(previous, 0, next, 0, previous.size);
    this.buffer = next;
    this.attemptedGrowCount++;
    this.peakAllocatedBytes = Math.max(
      this.peakAllocatedBytes,
      previous.size + next.size + this.retiringBytes
    );
    return { previous, next };
  }

  private commitReplacement(replacement: BufferReplacement): void {
    this.committedGrowCount++;
    this.retiredBufferCount++;
    this.retiringBytes += replacement.previous.size;
    const destroy = (): void => {
      replacement.previous.destroy();
      this.retiringBytes -= replacement.previous.size;
      this.destroyedRetiredBufferCount++;
    };
    void this.device.queue.onSubmittedWorkDone().then(destroy, destroy);
  }

  private rollbackReplacement(replacement: BufferReplacement): void {
    this.buffer = replacement.previous;
    replacement.next.destroy();
  }

  private commitUpload(upload: MutationUpload): void {
    this.uploadCalls += upload.calls;
    this.uploadSourceBytes += upload.sourceBytes;
    this.uploadedBytes += upload.uploadedBytes;
  }

  private requireEntry(
    handle: InstanceSetHandle,
    ...states: EntryState[]
  ): InstanceSetEntry {
    const runtime = HANDLE_STATE.get(handle as object);
    if (runtime === undefined || runtime.scene !== this) {
      throw new Error("InstanceSetHandle belongs to another GpuScene or is invalid");
    }
    const entry = this.slots[runtime.slot]?.entry;
    if (
      entry === undefined ||
      entry.generation !== runtime.generation ||
      !states.includes(entry.state)
    ) {
      throw new Error("InstanceSetHandle is stale or not resident");
    }
    return entry;
  }

  private assertMutation(
    command: ShadeGPUCommandContext | GpuSceneCommand,
    kind: NonNullable<GpuSceneEvidence["pendingMutation"]>
  ): void {
    this.assertAlive();
    if (command.device !== this.device) {
      throw new Error("GpuScene command belongs to another GPUDevice");
    }
    if (command.closed === true) throw new Error("GpuScene command is already closed");
    if (this.pendingMutation !== null) {
      throw new Error(`GpuScene already has a pending ${this.pendingMutation} mutation`);
    }
    this.pendingMutation = kind;
  }

  private assertCapacity(requiredCount: number): void {
    assertU32(requiredCount, "Instance capacity");
    const requiredBytes = requiredCount * GPU_INSTANCE_RECORD_STRIDE;
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes > this.storageLimit()) {
      throw new RangeError(
        `Instance table requires ${requiredBytes} bytes, adapter storage limit is ${this.storageLimit()}`
      );
    }
  }

  private storageLimit(): number {
    return Math.min(
      Number(this.device.limits.maxBufferSize ?? Number.MAX_SAFE_INTEGER),
      Number(this.device.limits.maxStorageBufferBindingSize ?? Number.MAX_SAFE_INTEGER)
    );
  }

  private createZeroBuffer(label: string, size: number): GPUBuffer {
    if (size > this.storageLimit()) throw new RangeError(`${label} exceeds adapter limit`);
    const buffer = this.device.createBuffer({
      label,
      size,
      usage: STORAGE_USAGE,
      mappedAtCreation: true
    });
    new Uint8Array(buffer.getMappedRange()).fill(0);
    buffer.unmap();
    return buffer;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("GpuScene has been destroyed");
  }
}

function validateInstanceSource(source: InstanceSource): void {
  assertU32(source.count, "Instance source count");
  if (source.count === 0) throw new RangeError("Instance source count must be positive");
  if (source.geometryHandles.length === 0) {
    throw new RangeError("Instance source must reference at least one geometry handle");
  }
  assertLength(source.geometryIndices, source.count, "geometryIndices");
  assertLength(source.materialHandles, source.count, "materialHandles");
  assertLength(source.currentTransforms, source.count * 16, "currentTransforms");
  if (source.previousTransforms !== undefined) {
    assertLength(source.previousTransforms, source.count * 16, "previousTransforms");
  }
  assertLength(source.boundsSpheres, source.count * 4, "boundsSpheres");
  if (source.boundsMin !== undefined) assertLength(source.boundsMin, source.count * 3, "boundsMin");
  if (source.boundsMax !== undefined) assertLength(source.boundsMax, source.count * 3, "boundsMax");
  if (source.flags !== undefined) assertLength(source.flags, source.count, "flags");
  if (source.debugIds !== undefined) assertLength(source.debugIds, source.count, "debugIds");
}

function assertLength(value: ArrayLike<unknown>, expected: number, label: string): void {
  if (value.length !== expected) {
    throw new RangeError(`${label} length ${value.length} does not match ${expected}`);
  }
}

function normalizePatch(
  indices: Uint32Array | undefined,
  values: ArrayLike<unknown> | undefined,
  valueStride: number,
  instanceCount: number,
  label: string
): Uint32Array {
  if (indices === undefined && values === undefined) return new Uint32Array(0);
  if (indices === undefined || values === undefined) {
    throw new RangeError(`${label} patch requires both indices and values`);
  }
  if (values.length !== indices.length * valueStride) {
    throw new RangeError(`${label} patch value length does not match its indices`);
  }
  const orders = new Uint32Array(indices.length);
  for (let order = 0; order < indices.length; order++) {
    const index = indices[order]!;
    if (index >= instanceCount) {
      throw new RangeError(`${label} patch index ${index} is outside instance set`);
    }
    orders[order] = order;
  }
  orders.sort((left, right) => {
    const delta = indices[left]! - indices[right]!;
    return delta === 0 ? left - right : delta;
  });
  let write = 0;
  for (let read = 0; read < orders.length;) {
    const index = indices[orders[read]!]!;
    let lastOrder = orders[read]!;
    read++;
    while (read < orders.length && indices[orders[read]!] === index) {
      lastOrder = orders[read]!;
      read++;
    }
    orders[write++] = lastOrder;
  }
  return orders.slice(0, write);
}

function markPatchIndices(
  dirtyMask: Uint8Array,
  indices: Uint32Array | undefined,
  orders: Uint32Array
): void {
  if (indices === undefined) return;
  for (const order of orders) dirtyMask[indices[order]!] = 1;
}

function compactDirtyIndices(mask: Uint8Array): Uint32Array {
  let count = 0;
  for (const value of mask) count += value;
  const result = new Uint32Array(count);
  let cursor = 0;
  for (let index = 0; index < mask.length; index++) {
    if (mask[index] !== 0) result[cursor++] = index;
  }
  return result;
}

function coalesceDirtySpans(
  indices: Uint32Array,
  mergeGapRecords: number
): readonly { begin: number; end: number }[] {
  if (indices.length === 0) return [];
  const spans: { begin: number; end: number }[] = [];
  let begin = indices[0]!;
  let previous = begin;
  for (let cursor = 1; cursor < indices.length; cursor++) {
    const current = indices[cursor]!;
    if (current - previous - 1 > mergeGapRecords) {
      spans.push({ begin, end: previous + 1 });
      begin = current;
    }
    previous = current;
  }
  spans.push({ begin, end: previous + 1 });
  return spans;
}

function copyRecords(source: Uint8Array, indices: Uint32Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(indices.length * GPU_INSTANCE_RECORD_STRIDE);
  for (let cursor = 0; cursor < indices.length; cursor++) {
    const begin = indices[cursor]! * GPU_INSTANCE_RECORD_STRIDE;
    result.set(source.subarray(begin, begin + GPU_INSTANCE_RECORD_STRIDE), cursor * GPU_INSTANCE_RECORD_STRIDE);
  }
  return result;
}

function restoreRecords(
  destination: Uint8Array,
  indices: Uint32Array,
  records: Uint8Array
): void {
  for (let cursor = 0; cursor < indices.length; cursor++) {
    destination.set(
      records.subarray(
        cursor * GPU_INSTANCE_RECORD_STRIDE,
        (cursor + 1) * GPU_INSTANCE_RECORD_STRIDE
      ),
      indices[cursor]! * GPU_INSTANCE_RECORD_STRIDE
    );
  }
}

function copyFiniteF32(
  view: DataView,
  destinationByteOffset: number,
  source: Float32Array,
  sourceOffset: number,
  count: number,
  label: string
): void {
  for (let index = 0; index < count; index++) {
    const value = source[sourceOffset + index]!;
    if (!Number.isFinite(value)) {
      throw new RangeError(`${label}[${sourceOffset + index}] must be finite`);
    }
    view.setFloat32(destinationByteOffset + index * 4, value, true);
  }
}

function writeMatrix(
  destination: Uint8Array,
  destinationByteOffset: number,
  source: Float32Array,
  sourceOffset: number,
  label: string
): void {
  const view = new DataView(destination.buffer, destination.byteOffset, destination.byteLength);
  for (let index = 0; index < 16; index++) {
    const value = source[sourceOffset + index]!;
    if (!Number.isFinite(value)) throw new RangeError(`${label}[${index}] must be finite`);
    view.setFloat32(destinationByteOffset + index * 4, value, true);
  }
}

function readMatrix(
  destination: Float32Array,
  source: Uint8Array,
  sourceByteOffset: number
): void {
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  for (let index = 0; index < 16; index++) {
    destination[index] = view.getFloat32(sourceByteOffset + index * 4, true);
  }
}

function writeDefaultBounds(view: DataView, byteOffset: number, value: number): void {
  view.setFloat32(byteOffset, value, true);
  view.setFloat32(byteOffset + 4, value, true);
  view.setFloat32(byteOffset + 8, value, true);
}

function assertU32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > U32_MAX) {
    throw new RangeError(`${label} ${value} is outside the R2 u32 ABI`);
  }
}

function checkedAdd(left: number, right: number, label: string): number {
  const value = left + right;
  assertU32(value, label);
  return value;
}

function align4(value: number): number {
  return Math.ceil(value / 4) * 4;
}

function nextGeneration(value: number): number {
  return value >= U32_MAX ? 1 : value + 1;
}
