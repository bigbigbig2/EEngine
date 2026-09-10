import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { AssetHandle, GpuAssetStore } from "./GpuAssetStore.js";
import { mat4 } from "gl-matrix";
import {
  computePreviousFromCurrent,
  createGpuInstanceMotionScratch,
  readGpuInstanceAffineMatrix,
  writeGpuInstanceAffineMatrix,
  GPU_INSTANCE_ABI_VERSION,
  GPU_INSTANCE_DYNAMIC_RECORD_STRIDE,
  GPU_INSTANCE_FLAGS,
  GPU_INSTANCE_MATERIAL_CLASSIFICATION_MASK,
  GPU_INSTANCE_VISIBILITY_FLAGS_MASK,
  GPU_INSTANCE_RECORD_OFFSETS,
  GPU_INSTANCE_RECORD_STRIDE,
  GPU_INSTANCE_STATIC_RECORD_STRIDE
} from "./GpuInstanceAbi.js";
import { recordGpuQueueUpload } from "./GpuQueueEvidence.js";
import type {
  ResourceAccounting,
  ResourceHandle as AccountingResourceHandle
} from "../debug/profiling/ResourceAccounting.js";

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

/** Low-frequency fields that do not belong to transform or material updates. */
export interface InstanceStaticPatch {
  readonly indices: Uint32Array;
  readonly boundsSpheres?: Float32Array;
  readonly boundsMin?: Float32Array;
  readonly boundsMax?: Float32Array;
  readonly debugIds?: Uint32Array;
}

/** Visibility/lifecycle flags only; material routing bits are preserved. */
export interface InstanceVisibilityPatch {
  readonly indices: Uint32Array;
  readonly flags: Uint32Array;
}

/** One explicit frame batch. Duplicate indices use the final value in the batch. */
export interface InstancePatchBatch {
  readonly frameId: number;
  readonly staticInstances?: InstanceStaticPatch;
  readonly transforms?: InstanceTransformPatch;
  readonly materials?: InstanceMaterialPatch;
  readonly visibility?: InstanceVisibilityPatch;
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
  /** Changes only when the bound GPU buffer identity changes. */
  readonly resourceEpoch: number;
  /** Changes after a committed instance/content mutation. */
  readonly contentRevision: number;
  readonly instances: GPUBuffer;
  readonly recordStride: number;
  readonly highWaterCount: number;
  readonly activeCount: number;
}

export interface InstancePatchResult {
  readonly staticCount: number;
  readonly transformCount: number;
  readonly materialCount: number;
  readonly visibilityCount: number;
  readonly dirtyInstanceCount: number;
  readonly dirtySpanCount: number;
  readonly sourceBytes: number;
  readonly uploadedBytes: number;
  readonly density: number;
}

export interface GpuSceneEvidence {
  readonly schemaVersion: 2;
  readonly abiVersion: number;
  readonly recordStride: number;
  readonly staticRecordStride: number;
  readonly dynamicRecordStride: number;
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
  readonly cpuStaticShadowBytes: number;
  readonly cpuDynamicShadowBytes: number;
  readonly bulkInstantiateCount: number;
  readonly bulkInstanceCount: number;
  readonly patchBatchCount: number;
  readonly patchedTransformCount: number;
  readonly patchedMaterialCount: number;
  readonly patchedStaticCount: number;
  readonly patchedVisibilityCount: number;
  readonly staticPatchBytes: number;
  readonly transformPatchBytes: number;
  readonly materialPatchBytes: number;
  readonly visibilityPatchBytes: number;
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
  private resourceEpoch = 1;
  private contentRevision = 1;
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
  private patchedStaticCount = 0;
  private patchedVisibilityCount = 0;
  private staticPatchBytes = 0;
  private transformPatchBytes = 0;
  private materialPatchBytes = 0;
  private visibilityPatchBytes = 0;
  private profiledStaticPatchBytes = 0;
  private profiledTransformPatchBytes = 0;
  private profiledMaterialPatchBytes = 0;
  private profiledVisibilityPatchBytes = 0;
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
  private readonly accountedBuffers = new Map<GPUBuffer, AccountingResourceHandle>();

  constructor(
    private readonly device: GPUDevice,
    private readonly assets: GpuAssetStore,
    private readonly resourceAccounting?: ResourceAccounting
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
        if (replacement !== null) {
          this.commitReplacement(replacement);
          this.resourceEpoch++;
        }
        this.contentRevision++;
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
    const staticOrders = normalizeStaticPatch(batch.staticInstances, entry.count);
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
    const visibilityOrders = normalizePatch(
      batch.visibility?.indices,
      batch.visibility?.flags,
      1,
      entry.count,
      "visibility"
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
    for (const order of visibilityOrders) {
      assertU32(batch.visibility!.flags[order]!, `visibility flags[${order}]`);
    }
    if (staticOrders.length === 0 && transformOrders.length === 0 &&
        materialOrders.length === 0 && visibilityOrders.length === 0) {
      this.stableNoopCount++;
      return Object.freeze({
        staticCount: 0,
        transformCount: 0,
        materialCount: 0,
        visibilityCount: 0,
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
    markPatchIndices(dirtyMask, batch.staticInstances?.indices, staticOrders);
    markPatchIndices(dirtyMask, batch.transforms?.indices, transformOrders);
    markPatchIndices(dirtyMask, batch.materials?.indices, materialOrders);
    markPatchIndices(dirtyMask, batch.visibility?.indices, visibilityOrders);
    const dirtyIndices = compactDirtyIndices(dirtyMask);
    const previousRecords = copyRecords(entry.bytes, dirtyIndices);
    const previousFrames = new Uint32Array(transformOrders.length);
    const transformIndices = batch.transforms?.indices;
    const transformValues = batch.transforms?.transforms;
    const materialIndices = batch.materials?.indices;
    const materialValues = batch.materials?.materialHandles;
    const materialFlags = batch.materials?.flags;
    const staticPatch = batch.staticInstances;
    const visibilityPatch = batch.visibility;
    const recordView = new DataView(
      entry.bytes.buffer,
      entry.bytes.byteOffset,
      entry.bytes.byteLength
    );

    try {
      for (const order of staticOrders) {
        const localIndex = staticPatch!.indices[order]!;
        const recordOffset = localIndex * GPU_INSTANCE_RECORD_STRIDE;
        if (staticPatch!.boundsSpheres !== undefined) {
          copyFiniteF32(recordView, recordOffset + GPU_INSTANCE_RECORD_OFFSETS.bounds_sphere,
            staticPatch!.boundsSpheres, order * 4, 4, "static boundsSpheres");
        }
        if (staticPatch!.boundsMin !== undefined) {
          copyFiniteF32(recordView, recordOffset + GPU_INSTANCE_RECORD_OFFSETS.bounds_min,
            staticPatch!.boundsMin, order * 3, 3, "static boundsMin");
        }
        if (staticPatch!.boundsMax !== undefined) {
          copyFiniteF32(recordView, recordOffset + GPU_INSTANCE_RECORD_OFFSETS.bounds_max,
            staticPatch!.boundsMax, order * 3, 3, "static boundsMax");
        }
        if (staticPatch!.debugIds !== undefined) {
          const debugId = staticPatch!.debugIds[order]!;
          assertU32(debugId, `static debugIds[${order}]`);
          recordView.setUint32(recordOffset + GPU_INSTANCE_RECORD_OFFSETS.debug_id, debugId, true);
        }
      }
      for (let cursor = 0; cursor < transformOrders.length; cursor++) {
        const order = transformOrders[cursor]!;
        const localIndex = transformIndices![order]!;
        previousFrames[cursor] = entry.lastTransformFrame[localIndex]!;
        const recordOffset = localIndex * GPU_INSTANCE_RECORD_STRIDE;
        const flagsOffset = recordOffset + GPU_INSTANCE_RECORD_OFFSETS.motion_flags;
        const previousFlags = recordView.getUint32(flagsOffset, true);
        const sameFrame = entry.lastTransformFrame[localIndex] === batch.frameId;
        let motionValid = false;
        if (sameFrame && (previousFlags & GPU_INSTANCE_FLAGS.MotionInvalid) !== 0) {
          // The prior-frame transform cannot be reconstructed from an invalid
          // motion record. Keep velocity disabled for the rest of this frame.
          mat4.identity(this.motionScratch.previousFromCurrent);
        } else {
          readGpuInstanceAffineMatrix(
            this.motionScratch.inverseCurrent,
            entry.bytes,
            recordOffset + GPU_INSTANCE_RECORD_OFFSETS.current_affine
          );
          if (sameFrame) {
            readGpuInstanceAffineMatrix(
              this.motionScratch.previous,
              entry.bytes,
              recordOffset + GPU_INSTANCE_RECORD_OFFSETS.previous_from_current_affine
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
        writeGpuInstanceAffineMatrix(
          entry.bytes,
          recordOffset + GPU_INSTANCE_RECORD_OFFSETS.current_affine,
          transformValues!,
          order * 16,
          `transforms[${order}]`
        );
        writeGpuInstanceAffineMatrix(
          entry.bytes,
          recordOffset + GPU_INSTANCE_RECORD_OFFSETS.previous_from_current_affine,
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
        recordView.setUint32(
          recordOffset + GPU_INSTANCE_RECORD_OFFSETS.dynamic_revision,
          batch.frameId,
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
          const previousFlags = recordView.getUint32(flagsOffset, true);
          const persistentFlags = previousFlags &
            ~GPU_INSTANCE_MATERIAL_CLASSIFICATION_MASK;
          const classificationFlags = materialFlags[order]! &
            GPU_INSTANCE_MATERIAL_CLASSIFICATION_MASK;
          recordView.setUint32(
            flagsOffset,
            (persistentFlags | classificationFlags) >>> 0,
            true
          );
        }
      }
      for (const order of visibilityOrders) {
        const localIndex = visibilityPatch!.indices[order]!;
        const flagsOffset = localIndex * GPU_INSTANCE_RECORD_STRIDE + GPU_INSTANCE_RECORD_OFFSETS.flags;
        const previousFlags = recordView.getUint32(flagsOffset, true);
        const flags = visibilityPatch!.flags[order]! & GPU_INSTANCE_VISIBILITY_FLAGS_MASK;
        recordView.setUint32(flagsOffset,
          ((previousFlags & ~GPU_INSTANCE_VISIBILITY_FLAGS_MASK) | flags) >>> 0, true);
      }

      const density = dirtyIndices.length / entry.count;
      let uploadedBytes = 0;
      let uploadCalls = 0;
      let staticUploadedBytes = 0;
      for (const order of staticOrders) {
        const localIndex = staticPatch!.indices[order]!;
        const writes: readonly [number, number, boolean][] = [
          [GPU_INSTANCE_RECORD_OFFSETS.bounds_sphere, 16, staticPatch!.boundsSpheres !== undefined],
          [GPU_INSTANCE_RECORD_OFFSETS.bounds_min, 12, staticPatch!.boundsMin !== undefined],
          [GPU_INSTANCE_RECORD_OFFSETS.bounds_max, 12, staticPatch!.boundsMax !== undefined],
          [GPU_INSTANCE_RECORD_OFFSETS.debug_id, 4, staticPatch!.debugIds !== undefined]
        ];
        for (const [fieldOffset, byteLength, enabled] of writes) {
          if (!enabled) continue;
          const localByteOffset = localIndex * GPU_INSTANCE_RECORD_STRIDE + fieldOffset;
          command.writeBuffer(
            this.buffer,
            (entry.start + localIndex) * GPU_INSTANCE_RECORD_STRIDE + fieldOffset,
            entry.bytes.buffer,
            entry.bytes.byteOffset + localByteOffset,
            byteLength
          );
          recordGpuQueueUpload(this.device.queue, "GpuScene/patch-static", byteLength);
          uploadedBytes += byteLength;
          staticUploadedBytes += byteLength;
          uploadCalls++;
        }
      }
      for (const order of transformOrders) {
        const localIndex = transformIndices![order]!;
        const localByteOffset = localIndex * GPU_INSTANCE_RECORD_STRIDE +
          GPU_INSTANCE_RECORD_OFFSETS.current_affine;
        command.writeBuffer(
          this.buffer,
          (entry.start + localIndex) * GPU_INSTANCE_RECORD_STRIDE +
            GPU_INSTANCE_RECORD_OFFSETS.current_affine,
          entry.bytes.buffer,
          entry.bytes.byteOffset + localByteOffset,
          GPU_INSTANCE_DYNAMIC_RECORD_STRIDE
        );
        recordGpuQueueUpload(this.device.queue, "GpuScene/patch-transform", GPU_INSTANCE_DYNAMIC_RECORD_STRIDE);
        uploadedBytes += GPU_INSTANCE_DYNAMIC_RECORD_STRIDE;
        uploadCalls++;
      }
      for (const order of materialOrders) {
        const localIndex = materialIndices![order]!;
        const byteLength = materialFlags === undefined ? 4 : 8;
        const localByteOffset = localIndex * GPU_INSTANCE_RECORD_STRIDE +
          GPU_INSTANCE_RECORD_OFFSETS.material_handle;
        command.writeBuffer(
          this.buffer,
          (entry.start + localIndex) * GPU_INSTANCE_RECORD_STRIDE +
            GPU_INSTANCE_RECORD_OFFSETS.material_handle,
          entry.bytes.buffer,
          entry.bytes.byteOffset + localByteOffset,
          byteLength
        );
        recordGpuQueueUpload(this.device.queue, "GpuScene/patch-material", byteLength);
        uploadedBytes += byteLength;
        uploadCalls++;
      }
      for (const order of visibilityOrders) {
        const localIndex = visibilityPatch!.indices[order]!;
        const localByteOffset = localIndex * GPU_INSTANCE_RECORD_STRIDE +
          GPU_INSTANCE_RECORD_OFFSETS.flags;
        command.writeBuffer(
          this.buffer,
          (entry.start + localIndex) * GPU_INSTANCE_RECORD_STRIDE +
            GPU_INSTANCE_RECORD_OFFSETS.flags,
          entry.bytes.buffer,
          entry.bytes.byteOffset + localByteOffset,
          4
        );
        recordGpuQueueUpload(this.device.queue, "GpuScene/patch-visibility", 4);
        uploadedBytes += 4;
        uploadCalls++;
      }
      const sourceBytes = staticUploadedBytes + transformOrders.length * 16 * 4 +
        materialOrders.length * (materialFlags === undefined ? 4 : 8) +
        visibilityOrders.length * 4;
      const result = Object.freeze({
        staticCount: staticOrders.length,
        transformCount: transformOrders.length,
        materialCount: materialOrders.length,
        visibilityCount: visibilityOrders.length,
        dirtyInstanceCount: dirtyIndices.length,
        dirtySpanCount: uploadCalls,
        sourceBytes,
        uploadedBytes,
        density
      });
      const upload = { calls: uploadCalls, sourceBytes, uploadedBytes };
      command.onFinished.addOne(() => {
        if (entry.state !== "pending-patch") return;
        entry.state = "resident";
        this.patchBatchCount++;
        this.patchedTransformCount += result.transformCount;
        this.patchedMaterialCount += result.materialCount;
        this.patchedStaticCount += result.staticCount;
        this.patchedVisibilityCount += result.visibilityCount;
        this.staticPatchBytes += staticUploadedBytes;
        this.transformPatchBytes += result.transformCount * GPU_INSTANCE_DYNAMIC_RECORD_STRIDE;
        this.materialPatchBytes += result.materialCount * (materialFlags === undefined ? 4 : 8);
        this.visibilityPatchBytes += result.visibilityCount * 4;
        this.dirtySpanCount += result.dirtySpanCount;
        this.lastPatch = result;
        this.commitUpload(upload);
        this.contentRevision++;
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
        this.contentRevision++;
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
      resourceEpoch: this.resourceEpoch,
      contentRevision: this.contentRevision,
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
      schemaVersion: 2,
      abiVersion: GPU_INSTANCE_ABI_VERSION,
      recordStride: GPU_INSTANCE_RECORD_STRIDE,
      staticRecordStride: GPU_INSTANCE_STATIC_RECORD_STRIDE,
      dynamicRecordStride: GPU_INSTANCE_DYNAMIC_RECORD_STRIDE,
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
      cpuStaticShadowBytes: this.activeInstanceCount * GPU_INSTANCE_STATIC_RECORD_STRIDE,
      cpuDynamicShadowBytes: this.activeInstanceCount * GPU_INSTANCE_DYNAMIC_RECORD_STRIDE +
        this.activeInstanceCount * Uint32Array.BYTES_PER_ELEMENT,
      bulkInstantiateCount: this.bulkInstantiateCount,
      bulkInstanceCount: this.bulkInstanceCount,
      patchBatchCount: this.patchBatchCount,
      patchedTransformCount: this.patchedTransformCount,
      patchedMaterialCount: this.patchedMaterialCount,
      patchedStaticCount: this.patchedStaticCount,
      patchedVisibilityCount: this.patchedVisibilityCount,
      staticPatchBytes: this.staticPatchBytes,
      transformPatchBytes: this.transformPatchBytes,
      materialPatchBytes: this.materialPatchBytes,
      visibilityPatchBytes: this.visibilityPatchBytes,
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

  /** Internal once-per-frame profiler seam; values are deltas since the prior sample. */
  profilePatchByteDeltas(): Readonly<{
    staticPatchBytes: number;
    transformPatchBytes: number;
    materialPatchBytes: number;
    visibilityPatchBytes: number;
  }> {
    const result = Object.freeze({
      staticPatchBytes: this.staticPatchBytes - this.profiledStaticPatchBytes,
      transformPatchBytes: this.transformPatchBytes - this.profiledTransformPatchBytes,
      materialPatchBytes: this.materialPatchBytes - this.profiledMaterialPatchBytes,
      visibilityPatchBytes: this.visibilityPatchBytes - this.profiledVisibilityPatchBytes
    });
    this.profiledStaticPatchBytes = this.staticPatchBytes;
    this.profiledTransformPatchBytes = this.transformPatchBytes;
    this.profiledMaterialPatchBytes = this.materialPatchBytes;
    this.profiledVisibilityPatchBytes = this.visibilityPatchBytes;
    return result;
  }

  destroy(): void {
    if (this.destroyed) return;
    if (this.pendingMutation !== null) {
      throw new Error("GpuScene cannot be destroyed during a pending mutation");
    }
    this.destroyed = true;
    this.destroyBuffer(this.buffer);
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
      writeGpuInstanceAffineMatrix(
        bytes,
        base + GPU_INSTANCE_RECORD_OFFSETS.current_affine,
        source.currentTransforms,
        index * 16,
        "currentTransforms"
      );
      const motionValid = computePreviousFromCurrent(
        this.motionScratch.previousFromCurrent,
        source.currentTransforms,
        source.previousTransforms ?? source.currentTransforms,
        index * 16,
        index * 16,
        this.motionScratch
      );
      flags &= ~GPU_INSTANCE_FLAGS.MotionInvalid;
      view.setUint32(base + GPU_INSTANCE_RECORD_OFFSETS.flags, flags >>> 0, true);
      writeGpuInstanceAffineMatrix(
        bytes,
        base + GPU_INSTANCE_RECORD_OFFSETS.previous_from_current_affine,
        this.motionScratch.previousFromCurrent,
        0,
        "previousFromCurrent"
      );
      view.setUint32(base + GPU_INSTANCE_RECORD_OFFSETS.dynamic_revision, 0, true);
      view.setUint32(
        base + GPU_INSTANCE_RECORD_OFFSETS.motion_flags,
        motionValid ? 0 : GPU_INSTANCE_FLAGS.MotionInvalid,
        true
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
    const next = this.createBuffer({
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
      this.destroyBuffer(replacement.previous);
      this.retiringBytes -= replacement.previous.size;
      this.destroyedRetiredBufferCount++;
    };
    void this.device.queue.onSubmittedWorkDone().then(destroy, destroy);
  }

  private rollbackReplacement(replacement: BufferReplacement): void {
    this.buffer = replacement.previous;
    this.destroyBuffer(replacement.next);
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
    const buffer = this.createBuffer({
      label,
      size,
      usage: STORAGE_USAGE,
      mappedAtCreation: true
    });
    new Uint8Array(buffer.getMappedRange()).fill(0);
    buffer.unmap();
    return buffer;
  }

  private createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer {
    const buffer = this.device.createBuffer(descriptor);
    if (this.resourceAccounting !== undefined) {
      this.accountedBuffers.set(buffer, this.resourceAccounting.created({
        kind: "buffer",
        category: "resident",
        owner: "GpuScene",
        bytes: descriptor.size,
        label: descriptor.label
      }));
    }
    return buffer;
  }

  private destroyBuffer(buffer: GPUBuffer): void {
    const handle = this.accountedBuffers.get(buffer);
    if (handle !== undefined) {
      this.accountedBuffers.delete(buffer);
      this.resourceAccounting!.destroyed(handle);
    }
    buffer.destroy();
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

function normalizeStaticPatch(
  patch: InstanceStaticPatch | undefined,
  instanceCount: number
): Uint32Array {
  if (patch === undefined) return new Uint32Array(0);
  const hasField = patch.boundsSpheres !== undefined || patch.boundsMin !== undefined ||
    patch.boundsMax !== undefined || patch.debugIds !== undefined;
  if (!hasField) throw new RangeError("static-instance patch requires at least one field");
  const orders = normalizePatch(patch.indices, patch.indices, 1, instanceCount, "static-instance");
  if (patch.boundsSpheres !== undefined) {
    assertLength(patch.boundsSpheres, patch.indices.length * 4, "static boundsSpheres");
  }

  if (patch.boundsMin !== undefined) {
    assertLength(patch.boundsMin, patch.indices.length * 3, "static boundsMin");
  }
  if (patch.boundsMax !== undefined) {
    assertLength(patch.boundsMax, patch.indices.length * 3, "static boundsMax");
  }
  if (patch.debugIds !== undefined) {
    assertLength(patch.debugIds, patch.indices.length, "static debugIds");
  }
  return orders;
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
