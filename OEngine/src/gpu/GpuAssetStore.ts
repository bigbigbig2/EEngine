import {
  GEOMETRY_BVH8_NODE_STRIDE,
  GEOMETRY_INVALID_INDEX,
  GEOMETRY_MATERIAL_RANGE_STRIDE,
  GEOMETRY_SECTION_TYPES,
  GEOMETRY_VERTEX_STREAM_DESCRIPTOR_STRIDE,
  encodeGeometryBvh8Nodes,
  type GeometryAssetPackage,
  type GeometryBvh8Node
} from "../assets/GeometryAssetPackage.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import {
  GPU_CLUSTER_RECORD_STRIDE,
  GPU_FALLBACK_RECORD_INDEX,
  GPU_GEOMETRY_ABI_VERSION,
  GPU_GEOMETRY_RECORD_STRIDE,
  GPU_MESHLET_RECORD_STRIDE,
  GPU_POSITION_FORMAT,
  GPU_UV_FORMAT,
  packGpuClusterRecords,
  packGpuGeometryRecord,
  packGpuMeshletRecords,
  type GpuClusterRecordCpu,
  type GpuMeshletRecordCpu
} from "./GpuGeometryAbi.js";
import {
  recordGpuQueueUpload,
  writeGpuBuffer
} from "./GpuQueueEvidence.js";

declare const ASSET_HANDLE_BRAND: unique symbol;

/** Opaque CPU handle. Buffer offsets and GPU record addresses are intentionally absent. */
export interface AssetHandle {
  readonly [ASSET_HANDLE_BRAND]: true;
}

type AssetCommandSignal = {
  addOne(listener: (...args: any[]) => void): void;
};

/** Structural subset implemented by ShadeGPUCommandContext and browser test commands. */
export interface GpuAssetCommand {
  readonly device: GPUDevice;
  readonly onFinished: AssetCommandSignal;
  readonly onAborted: AssetCommandSignal;
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

export interface GpuAssetBindings {
  readonly abiVersion: number;
  readonly epoch: number;
  readonly geometryRecords: GPUBuffer;
  readonly meshletRecords: GPUBuffer;
  readonly clusterRecords: GPUBuffer;
  readonly bvh8Nodes: GPUBuffer;
  readonly vertexStreamDescriptors: GPUBuffer;
  readonly materialRanges: GPUBuffer;
  readonly vertexStreamData: GPUBuffer;
  readonly indices: GPUBuffer;
  readonly meshletVertexIndices: GPUBuffer;
  readonly meshletTriangleIndices: GPUBuffer;
  readonly clusterChildren: GPUBuffer;
  readonly highWaterCounts: Readonly<{
    geometryRecords: number;
    meshletRecords: number;
    clusterRecords: number;
    bvh8Nodes: number;
    vertexStreamDescriptors: number;
    materialRanges: number;
    vertexStreamBytes: number;
    indices: number;
    meshletVertexIndices: number;
    meshletTriangleBytes: number;
    clusterChildren: number;
  }>;
}

export interface AssetResidencyEvidence {
  readonly schemaVersion: 2;
  readonly abiVersion: number;
  readonly residentAssetCount: number;
  readonly fallbackBytes: number;
  readonly logicalBytes: number;
  readonly residentBytes: number;
  readonly allocatedBytes: number;
  readonly retiringBytes: number;
  readonly peakAllocatedBytes: number;
  readonly reclaimableBytes: number;
  readonly uploadCalls: number;
  readonly uploadSourceBytes: number;
  readonly uploadedBytes: number;
  readonly uploadPaddingBytes: number;
  readonly attemptedGrowCount: number;
  readonly committedGrowCount: number;
  readonly retiredBufferCount: number;
  readonly destroyedRetiredBufferCount: number;
  readonly rejectedPackageCount: number;
  readonly abortedResidencyCount: number;
  readonly releaseCount: number;
  readonly committedResidencyTransactions: number;
  readonly abortedResidencyTransactions: number;
  readonly committedReleaseTransactions: number;
  readonly abortedReleaseTransactions: number;
  readonly largestTransactionPackageCount: number;
  readonly largestTransactionSourceBytes: number;
  readonly privateSubmitCount: 0;
  readonly pendingMutation: "resident" | "release" | null;
  readonly tables: Readonly<Record<BufferName, AssetTableEvidence>>;
}

export interface AssetTableEvidence {
  readonly stride: number;
  readonly highWaterBytes: number;
  readonly highWaterCount: number;
  readonly capacityBytes: number;
}

type BufferName =
  | "geometryRecords"
  | "meshletRecords"
  | "clusterRecords"
  | "bvh8Nodes"
  | "vertexStreamDescriptors"
  | "materialRanges"
  | "vertexStreamData"
  | "indices"
  | "meshletVertexIndices"
  | "meshletTriangleIndices"
  | "clusterChildren";

interface ResidentBuffer {
  readonly name: BufferName;
  readonly label: string;
  readonly stride: number;
  buffer: GPUBuffer;
  cursorBytes: number;
}

interface AssetEntry {
  readonly handle: AssetHandle;
  readonly slot: number;
  readonly generation: number;
  readonly logicalBytes: number;
  readonly residentBytes: number;
  readonly sourcePackageBytes: number;
  readonly contentHash: string;
  state: "pending" | "resident" | "pending-release" | "released" | "aborted";
}

interface SlotState {
  generation: number;
  entry?: AssetEntry;
}

interface UploadSegment {
  readonly target: ResidentBuffer;
  readonly destinationByteOffset: number;
  readonly sourceByteLength: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

interface ResidencyPlan {
  readonly geometryRecordIndex: number;
  readonly segments: readonly UploadSegment[];
  readonly nextCursors: ReadonlyMap<ResidentBuffer, number>;
  readonly logicalBytes: number;
  readonly residentBytes: number;
}

interface BufferReplacement {
  readonly owner: ResidentBuffer;
  readonly previous: GPUBuffer;
  readonly next: GPUBuffer;
}

interface HandleRuntimeState {
  readonly store: GpuAssetStore;
  readonly slot: number;
  readonly generation: number;
}

const HANDLE_STATE = new WeakMap<object, HandleRuntimeState>();
const STORAGE_USAGE =
  GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
const U32_MAX = 0xffffffff;

/**
 * Unique owner for validated Geometry package residency.
 *
 * The allocator is deliberately append/bulk first. Release invalidates the
 * stable record and handle immediately after submission, while payload space
 * remains reclaimable until a later measured compaction policy exists.
 */
export class GpuAssetStore {
  private readonly buffers: Record<BufferName, ResidentBuffer>;
  private readonly orderedBuffers: readonly ResidentBuffer[];
  private readonly slots: SlotState[] = [{ generation: 0 }];
  private readonly freeSlots: number[] = [];
  private pendingMutation: "resident" | "release" | null = null;
  private destroyed = false;
  private epoch = 1;
  private residentAssetCount = 0;
  private logicalBytes = 0;
  private activeResidentBytes = 0;
  private retiringBytes = 0;
  private peakAllocatedBytes = 0;
  private reclaimableBytes = 0;
  private uploadCalls = 0;
  private uploadSourceBytes = 0;
  private uploadedBytes = 0;
  private uploadPaddingBytes = 0;
  private attemptedGrowCount = 0;
  private committedGrowCount = 0;
  private retiredBufferCount = 0;
  private destroyedRetiredBufferCount = 0;
  private rejectedPackageCount = 0;
  private abortedResidencyCount = 0;
  private releaseCount = 0;
  private committedResidencyTransactions = 0;
  private abortedResidencyTransactions = 0;
  private committedReleaseTransactions = 0;
  private abortedReleaseTransactions = 0;
  private largestTransactionPackageCount = 0;
  private largestTransactionSourceBytes = 0;

  constructor(private readonly device: GPUDevice) {
    const definitions: readonly [BufferName, number][] = [
      ["geometryRecords", GPU_GEOMETRY_RECORD_STRIDE],
      ["meshletRecords", GPU_MESHLET_RECORD_STRIDE],
      ["clusterRecords", GPU_CLUSTER_RECORD_STRIDE],
      ["bvh8Nodes", GEOMETRY_BVH8_NODE_STRIDE],
      ["vertexStreamDescriptors", GEOMETRY_VERTEX_STREAM_DESCRIPTOR_STRIDE],
      ["materialRanges", GEOMETRY_MATERIAL_RANGE_STRIDE],
      ["vertexStreamData", 1],
      ["indices", 4],
      ["meshletVertexIndices", 4],
      ["meshletTriangleIndices", 1],
      ["clusterChildren", 4]
    ];
    const created: GPUBuffer[] = [];
    const record = {} as Record<BufferName, ResidentBuffer>;
    try {
      for (const [name, stride] of definitions) {
        const fallbackBytes = Math.max(4, align4(stride));
        const buffer = this.createZeroBuffer(`GpuAssetStore/${name}/fallback`, fallbackBytes);
        created.push(buffer);
        record[name] = {
          name,
          label: `GpuAssetStore/${name}`,
          stride,
          buffer,
          cursorBytes: fallbackBytes
        };
      }
    } catch (error) {
      for (const buffer of created) buffer.destroy();
      throw error;
    }
    this.buffers = record;
    this.orderedBuffers = definitions.map(([name]) => record[name]);
    this.peakAllocatedBytes = this.currentAllocatedBytes();
  }

  resident(
    asset: GeometryAssetPackage,
    command: ShadeGPUCommandContext | GpuAssetCommand
  ): AssetHandle {
    return this.residentMany([asset], command)[0]!;
  }

  /**
   * Reserves, uploads and publishes a complete geometry set as one command
   * transaction. Any validation/encoding/command failure restores every
   * cursor, slot and replacement buffer; partial scene residency is impossible.
   */
  residentMany(
    assets: readonly GeometryAssetPackage[],
    command: ShadeGPUCommandContext | GpuAssetCommand
  ): readonly AssetHandle[] {
    if (assets.length === 0) return Object.freeze([]);
    this.assertMutation(command, "resident");
    const cursorSnapshot = new Map(
      this.orderedBuffers.map((buffer) => [buffer, buffer.cursorBytes] as const)
    );
    const slotSnapshot = this.slots.map((slot) => ({
      generation: slot.generation,
      entry: slot.entry
    }));
    const freeSlotSnapshot = [...this.freeSlots];
    const replacements: BufferReplacement[] = [];
    const entries: AssetEntry[] = [];
    const handles: AssetHandle[] = [];
    const plans: ResidencyPlan[] = [];
    try {
      for (const asset of assets) {
        const report = asset.validate();
        if (!report.valid) {
          throw new Error("GpuAssetStore only accepts fully validated Geometry packages");
        }
        const reusedSlot = this.freeSlots.length > 0;
        const slot = reusedSlot ? this.freeSlots.pop()! : this.slots.length;
        const generation = reusedSlot ? this.slots[slot]!.generation : 1;
        if (!reusedSlot) this.slots.push({ generation });
        const plan = this.buildResidencyPlan(asset, slot);
        this.validatePlanCapacity(plan);
        plans.push(plan);
        for (const [buffer, nextCursor] of plan.nextCursors) {
          buffer.cursorBytes = nextCursor;
        }
        const handle = Object.freeze({}) as AssetHandle;
        const entry: AssetEntry = {
          handle,
          slot,
          generation,
          logicalBytes: plan.logicalBytes,
          residentBytes: plan.residentBytes,
          sourcePackageBytes: asset.package.manifest.totalByteLength,
          contentHash: asset.package.manifest.contentHash,
          state: "pending"
        };
        this.slots[slot]!.entry = entry;
        HANDLE_STATE.set(handle as object, { store: this, slot, generation });
        entries.push(entry);
        handles.push(handle);
      }
      for (const buffer of this.orderedBuffers) {
        if (buffer.cursorBytes > buffer.buffer.size) {
          replacements.push(this.growBuffer(buffer, buffer.cursorBytes, command));
        }
      }
      this.recordProvisionalPeak(replacements);
      for (const plan of plans) {
        for (const segment of plan.segments) this.uploadSegment(segment, command, true);
      }
      command.onFinished.addOne(() => {
        if (entries.some((entry) => entry.state !== "pending")) return;
        for (const entry of entries) {
          entry.state = "resident";
          this.logicalBytes += entry.logicalBytes;
          this.activeResidentBytes += entry.residentBytes;
        }
        this.residentAssetCount += entries.length;
        this.committedResidencyTransactions++;
        this.largestTransactionPackageCount = Math.max(
          this.largestTransactionPackageCount,
          entries.length
        );
        this.largestTransactionSourceBytes = Math.max(
          this.largestTransactionSourceBytes,
          entries.reduce((sum, entry) => sum + entry.sourcePackageBytes, 0)
        );
        this.committedGrowCount += replacements.length;
        this.commitReplacements(replacements);
        this.pendingMutation = null;
      });
      command.onAborted.addOne(() => {
        if (entries.every((entry) => entry.state !== "pending")) return;
        for (const entry of entries) entry.state = "aborted";
        this.rollbackResidencyBatch(
          cursorSnapshot,
          slotSnapshot,
          freeSlotSnapshot,
          replacements
        );
        this.abortedResidencyCount += entries.length;
        this.abortedResidencyTransactions++;
        this.pendingMutation = null;
      });
      return Object.freeze(handles);
    } catch (error) {
      this.rejectedPackageCount++;
      for (const entry of entries) entry.state = "aborted";
      this.rollbackResidencyBatch(
        cursorSnapshot,
        slotSnapshot,
        freeSlotSnapshot,
        replacements
      );
      this.pendingMutation = null;
      throw error;
    }
  }

  release(
    handle: AssetHandle,
    command: ShadeGPUCommandContext | GpuAssetCommand
  ): void {
    this.releaseMany([handle], command);
  }

  /** Invalidates an entire scene geometry dictionary in one command transaction. */
  releaseMany(
    handles: readonly AssetHandle[],
    command: ShadeGPUCommandContext | GpuAssetCommand
  ): void {
    if (handles.length === 0) return;
    this.assertMutation(command, "release");
    try {
      const entries = handles.map((handle) => this.requireEntry(handle, "resident"));
      if (new Set(entries).size !== entries.length) {
        throw new Error("GpuAssetStore release transaction contains duplicate handles");
      }
      const recordBuffer = this.buffers.geometryRecords;
      const zero = new Uint8Array(GPU_GEOMETRY_RECORD_STRIDE);
      for (const entry of entries) {
        entry.state = "pending-release";
        const offset = entry.slot * GPU_GEOMETRY_RECORD_STRIDE;
        command.writeBuffer(recordBuffer.buffer, offset, zero.buffer, 0, zero.byteLength);
        this.recordUpload(zero.byteLength, zero.byteLength);
        recordGpuQueueUpload(this.device.queue, "GpuAssetStore/release-record", zero.byteLength);
      }

      command.onFinished.addOne(() => {
        if (entries.some((entry) => entry.state !== "pending-release")) return;
        for (const entry of entries) {
          entry.state = "released";
          const slot = this.slots[entry.slot]!;
          slot.entry = undefined;
          slot.generation = nextGeneration(slot.generation);
          this.freeSlots.push(entry.slot);
          this.residentAssetCount--;
          this.logicalBytes -= entry.logicalBytes;
          this.activeResidentBytes -= entry.residentBytes;
          this.reclaimableBytes += entry.residentBytes;
          this.releaseCount++;
        }
        this.committedReleaseTransactions++;
        this.epoch++;
        this.pendingMutation = null;
      });
      command.onAborted.addOne(() => {
        if (entries.every((entry) => entry.state !== "pending-release")) return;
        for (const entry of entries) {
          if (entry.state === "pending-release") entry.state = "resident";
        }
        this.abortedReleaseTransactions++;
        this.pendingMutation = null;
      });
    } catch (error) {
      for (const handle of handles) {
        const state = HANDLE_STATE.get(handle as object);
        const entry = state?.store === this ? this.slots[state.slot]?.entry : undefined;
        if (entry?.state === "pending-release") entry.state = "resident";
      }
      this.pendingMutation = null;
      throw error;
    }
  }

  bindings(): GpuAssetBindings {
    this.assertAlive();
    const b = this.buffers;
    return Object.freeze({
      abiVersion: GPU_GEOMETRY_ABI_VERSION,
      epoch: this.epoch,
      geometryRecords: b.geometryRecords.buffer,
      meshletRecords: b.meshletRecords.buffer,
      clusterRecords: b.clusterRecords.buffer,
      bvh8Nodes: b.bvh8Nodes.buffer,
      vertexStreamDescriptors: b.vertexStreamDescriptors.buffer,
      materialRanges: b.materialRanges.buffer,
      vertexStreamData: b.vertexStreamData.buffer,
      indices: b.indices.buffer,
      meshletVertexIndices: b.meshletVertexIndices.buffer,
      meshletTriangleIndices: b.meshletTriangleIndices.buffer,
      clusterChildren: b.clusterChildren.buffer,
      highWaterCounts: Object.freeze({
        geometryRecords: countOf(b.geometryRecords),
        meshletRecords: countOf(b.meshletRecords),
        clusterRecords: countOf(b.clusterRecords),
        bvh8Nodes: countOf(b.bvh8Nodes),
        vertexStreamDescriptors: countOf(b.vertexStreamDescriptors),
        materialRanges: countOf(b.materialRanges),
        vertexStreamBytes: b.vertexStreamData.cursorBytes,
        indices: countOf(b.indices),
        meshletVertexIndices: countOf(b.meshletVertexIndices),
        meshletTriangleBytes: b.meshletTriangleIndices.cursorBytes,
        clusterChildren: countOf(b.clusterChildren)
      })
    });
  }

  /** Internal renderer/debug seam; not exported from OEngine/src/index.ts. */
  recordIndex(handle: AssetHandle): number {
    return this.requireEntry(handle, "pending", "resident").slot;
  }

  evidence(): AssetResidencyEvidence {
    const tables = {} as Record<BufferName, AssetTableEvidence>;
    for (const buffer of this.orderedBuffers) {
      tables[buffer.name] = Object.freeze({
        stride: buffer.stride,
        highWaterBytes: buffer.cursorBytes,
        highWaterCount: countOf(buffer),
        capacityBytes: buffer.buffer.size
      });
    }
    return Object.freeze({
      schemaVersion: 2,
      abiVersion: GPU_GEOMETRY_ABI_VERSION,
      residentAssetCount: this.residentAssetCount,
      fallbackBytes: this.fallbackBytes(),
      logicalBytes: this.logicalBytes,
      residentBytes: this.fallbackBytes() + this.activeResidentBytes,
      allocatedBytes: this.currentAllocatedBytes(),
      retiringBytes: this.retiringBytes,
      peakAllocatedBytes: this.peakAllocatedBytes,
      reclaimableBytes: this.reclaimableBytes,
      uploadCalls: this.uploadCalls,
      uploadSourceBytes: this.uploadSourceBytes,
      uploadedBytes: this.uploadedBytes,
      uploadPaddingBytes: this.uploadPaddingBytes,
      attemptedGrowCount: this.attemptedGrowCount,
      committedGrowCount: this.committedGrowCount,
      retiredBufferCount: this.retiredBufferCount,
      destroyedRetiredBufferCount: this.destroyedRetiredBufferCount,
      rejectedPackageCount: this.rejectedPackageCount,
      abortedResidencyCount: this.abortedResidencyCount,
      releaseCount: this.releaseCount,
      committedResidencyTransactions: this.committedResidencyTransactions,
      abortedResidencyTransactions: this.abortedResidencyTransactions,
      committedReleaseTransactions: this.committedReleaseTransactions,
      abortedReleaseTransactions: this.abortedReleaseTransactions,
      largestTransactionPackageCount: this.largestTransactionPackageCount,
      largestTransactionSourceBytes: this.largestTransactionSourceBytes,
      privateSubmitCount: 0,
      pendingMutation: this.pendingMutation,
      tables: Object.freeze(tables)
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    if (this.pendingMutation !== null) {
      throw new Error("GpuAssetStore cannot be destroyed during a pending mutation");
    }
    this.destroyed = true;
    for (const buffer of this.orderedBuffers) buffer.buffer.destroy();
    for (const slot of this.slots) {
      if (slot.entry !== undefined) slot.entry.state = "released";
      slot.entry = undefined;
    }
    this.freeSlots.length = 0;
  }

  private buildResidencyPlan(asset: GeometryAssetPackage, slot: number): ResidencyPlan {
    const b = this.buffers;
    const starts = new Map<ResidentBuffer, number>();
    const next = new Map<ResidentBuffer, number>();
    for (const buffer of this.orderedBuffers) {
      starts.set(buffer, buffer.cursorBytes);
      next.set(buffer, buffer.cursorBytes);
    }

    const meshletBegin = countOf(b.meshletRecords);
    // Runtime traversal consumes one uniform Cluster ABI. Packages that are
    // intentionally single-level have no serialized Cluster section, so the
    // residency adapter appends one virtual leaf spanning their Meshlets.
    const clusterBegin = countOf(b.clusterRecords);
    const bvhBegin = asset.bvh8Nodes.length === 0 ? 0 : countOf(b.bvh8Nodes);
    const descriptorBegin = asset.vertexStreamDescriptors.length === 0
      ? 0
      : countOf(b.vertexStreamDescriptors);
    const materialBegin = asset.materialRanges.length === 0
      ? 0
      : countOf(b.materialRanges);
    const vertexDataBegin = b.vertexStreamData.cursorBytes;
    const indexBegin = countOf(b.indices);
    const meshletVertexBegin = countOf(b.meshletVertexIndices);
    const meshletTriangleBegin = b.meshletTriangleIndices.cursorBytes;
    const clusterChildBegin = countOf(b.clusterChildren);

    const position = asset.vertexStreamDescriptors.find(
      (descriptor) => descriptor.semantic === "position"
    );
    if (position === undefined) {
      throw new Error("Geometry package has no position stream");
    }
    const positionFormat = position.dataType === "float32" && position.componentCount === 3
      ? GPU_POSITION_FORMAT.Float32x3
      : position.dataType === "float32" && position.componentCount === 4
        ? GPU_POSITION_FORMAT.Float32x4
        : GPU_POSITION_FORMAT.Unknown;
    const uv0 = asset.vertexStreamDescriptors.find(
      (descriptor) => descriptor.semantic === "uv0"
    );
    const uv1 = asset.vertexStreamDescriptors.find(
      (descriptor) => descriptor.semantic === "uv1"
    );
    const uv2 = asset.vertexStreamDescriptors.find(
      (descriptor) => descriptor.semantic === "uv2"
    );

    const meshletRecords: GpuMeshletRecordCpu[] = asset.meshlets.map((meshlet) => ({
      vertexOffset: checkedAdd(meshletVertexBegin, meshlet.vertexOffset, "Meshlet vertex range"),
      vertexCount: meshlet.vertexCount,
      triangleByteOffset: checkedAdd(
        meshletTriangleBegin,
        meshlet.triangleOffset,
        "Meshlet triangle range"
      ),
      triangleCount: meshlet.triangleCount,
      materialRangeIndex: asset.materialRanges.length === 0
        ? 0
        : checkedAdd(materialBegin, meshlet.materialRangeIndex, "Meshlet material range"),
      materialId: meshlet.materialId,
      flags: meshlet.flags,
      boundsMin: meshlet.boundsBox.subarray(0, 3),
      boundsMax: meshlet.boundsBox.subarray(3, 6),
      boundsSphere: [
        meshlet.bounds.centerX,
        meshlet.bounds.centerY,
        meshlet.bounds.centerZ,
        meshlet.bounds.radius
      ],
      coneApex: [meshlet.cone.apexX, meshlet.cone.apexY, meshlet.cone.apexZ, 0],
      coneAxisCutoff: [
        meshlet.cone.axisX,
        meshlet.cone.axisY,
        meshlet.cone.axisZ,
        meshlet.cone.cutoff
      ]
    }));
    const clusterRecords: GpuClusterRecordCpu[] = asset.clusters.map((cluster) => ({
      childBegin: cluster.childCount === 0
        ? 0
        : checkedAdd(clusterChildBegin, cluster.childBegin, "Cluster child range"),
      childCount: cluster.childCount,
      meshletBegin: checkedAdd(meshletBegin, cluster.meshletBegin, "Cluster Meshlet range"),
      meshletCount: cluster.meshletCount,
      parent: cluster.parent === GEOMETRY_INVALID_INDEX
        ? GPU_FALLBACK_RECORD_INDEX
        : checkedAdd(clusterBegin, cluster.parent, "Cluster parent"),
      depth: cluster.depth,
      materialId: cluster.materialId,
      flags: cluster.flags,
      geometricError: cluster.geometricError,
      boundsMin: cluster.boundsBox.subarray(0, 3),
      boundsMax: cluster.boundsBox.subarray(3, 6),
      boundsSphere: [
        cluster.bounds.centerX,
        cluster.bounds.centerY,
        cluster.bounds.centerZ,
        cluster.bounds.radius
      ],
      coneApex: [cluster.cone.apexX, cluster.cone.apexY, cluster.cone.apexZ, 0],
      coneAxisCutoff: [
        cluster.cone.axisX,
        cluster.cone.axisY,
        cluster.cone.axisZ,
        cluster.cone.cutoff
      ]
    }));
    if (clusterRecords.length === 0) {
      clusterRecords.push({
        childBegin: 0,
        childCount: 0,
        meshletBegin,
        meshletCount: asset.meshlets.length,
        parent: GPU_FALLBACK_RECORD_INDEX,
        depth: 0,
        materialId: asset.meshlets[0]?.materialId ?? 0,
        flags: 0,
        geometricError: 0,
        boundsMin: asset.directory.boundsBox.subarray(0, 3),
        boundsMax: asset.directory.boundsBox.subarray(3, 6),
        boundsSphere: asset.directory.boundsSphere,
        coneApex: [
          asset.directory.boundsSphere[0]!,
          asset.directory.boundsSphere[1]!,
          asset.directory.boundsSphere[2]!,
          0
        ],
        // A zero axis with cutoff 1 disables future cone rejection safely.
        coneAxisCutoff: [0, 0, 0, 1]
      });
    }
    const rebasedBvh = asset.bvh8Nodes.map((node) =>
      rebaseBvhNode(node, bvhBegin, clusterBegin)
    );
    const clusterChildren = new Uint32Array(asset.clusterChildren.length);
    for (let index = 0; index < clusterChildren.length; index++) {
      clusterChildren[index] = checkedAdd(
        clusterBegin,
        asset.clusterChildren[index]!,
        "Cluster child reference"
      );
    }
    const descriptors = this.rebaseVertexDescriptors(asset, vertexDataBegin);
    const geometryRecord = packGpuGeometryRecord({
      boundsSphere: asset.directory.boundsSphere,
      boundsMin: asset.directory.boundsBox.subarray(0, 3),
      boundsMax: asset.directory.boundsBox.subarray(3, 6),
      vertexCount: asset.directory.vertexCount,
      indexBegin,
      indexCount: asset.indices.length,
      meshletBegin,
      meshletCount: asset.meshlets.length,
      clusterBegin,
      clusterRoot: asset.clusters.length === 0
        ? clusterBegin
        : checkedAdd(clusterBegin, asset.directory.clusterRoot, "Cluster root"),
      clusterCount: clusterRecords.length,
      bvhBegin,
      bvhRoot: asset.bvh8Nodes.length === 0
        ? 0
        : checkedAdd(bvhBegin, asset.directory.bvhRoot, "BVH root"),
      bvhCount: asset.bvh8Nodes.length,
      materialRangeBegin: materialBegin,
      materialRangeCount: asset.materialRanges.length,
      streamDescriptorBegin: descriptorBegin,
      streamDescriptorCount: asset.vertexStreamDescriptors.length,
      vertexDataByteBegin: vertexDataBegin,
      vertexDataByteLength: asset.vertexStreamData.byteLength,
      positionByteOffset: checkedAdd(
        vertexDataBegin,
        position.dataByteOffset,
        "Position stream offset"
      ),
      positionStride: position.elementStride,
      positionFormat,
      flags: asset.directory.flags,
      uv0ByteOffset: uvByteOffset(uv0, vertexDataBegin),
      uv0Stride: uv0?.elementStride ?? 0,
      uv0Format: uvFormat(uv0),
      uv1ByteOffset: uvByteOffset(uv1, vertexDataBegin),
      uv1Stride: uv1?.elementStride ?? 0,
      uv1Format: uvFormat(uv1),
      uv2ByteOffset: uvByteOffset(uv2, vertexDataBegin),
      uv2Stride: uv2?.elementStride ?? 0,
      uv2Format: uvFormat(uv2)
    });

    const segments: UploadSegment[] = [];
    const append = (
      target: ResidentBuffer,
      bytes: Uint8Array,
      destinationByteOffset = starts.get(target)!
    ): void => {
      if (bytes.byteLength === 0) return;
      const padded = pad4(bytes);
      segments.push({
        target,
        destinationByteOffset,
        sourceByteLength: bytes.byteLength,
        bytes: padded
      });
      next.set(target, Math.max(next.get(target)!, destinationByteOffset + padded.byteLength));
    };

    append(b.geometryRecords, geometryRecord, slot * GPU_GEOMETRY_RECORD_STRIDE);
    append(b.meshletRecords, packGpuMeshletRecords(meshletRecords));
    append(b.clusterRecords, packGpuClusterRecords(clusterRecords));
    append(b.bvh8Nodes, encodeGeometryBvh8Nodes(rebasedBvh));
    append(b.vertexStreamDescriptors, descriptors);
    append(
      b.materialRanges,
      asset.package.section(GEOMETRY_SECTION_TYPES.MaterialRanges)?.bytes ?? new Uint8Array(0)
    );
    append(b.vertexStreamData, asset.vertexStreamData);
    append(b.indices, bytesOf(asset.indices));
    append(b.meshletVertexIndices, bytesOf(asset.meshletVertexIndices));
    append(b.meshletTriangleIndices, asset.meshletTriangleIndices);
    append(b.clusterChildren, bytesOf(clusterChildren));

    const logicalBytes = segments.reduce((sum, segment) => sum + segment.sourceByteLength, 0);
    const residentBytes = segments.reduce((sum, segment) => sum + segment.bytes.byteLength, 0);
    return {
      geometryRecordIndex: slot,
      segments: Object.freeze(segments),
      nextCursors: next,
      logicalBytes,
      residentBytes
    };
  }

  private rebaseVertexDescriptors(
    asset: GeometryAssetPackage,
    vertexDataBegin: number
  ): Uint8Array {
    const section = asset.package.section(GEOMETRY_SECTION_TYPES.VertexStreamDescriptors);
    if (section === undefined) return new Uint8Array(0);
    const bytes = section.bytes.slice();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < section.elementCount; index++) {
      const offset = index * GEOMETRY_VERTEX_STREAM_DESCRIPTOR_STRIDE + 32;
      view.setUint32(
        offset,
        checkedAdd(vertexDataBegin, view.getUint32(offset, true), "Vertex stream range"),
        true
      );
    }
    return bytes;
  }

  private validatePlanCapacity(plan: ResidencyPlan): void {
    for (const [buffer, required] of plan.nextCursors) {
      assertU32(required, `${buffer.name} byte capacity`);
      const limit = Math.min(
        Number(this.device.limits.maxBufferSize ?? Number.MAX_SAFE_INTEGER),
        Number(this.device.limits.maxStorageBufferBindingSize ?? Number.MAX_SAFE_INTEGER)
      );
      if (required > limit) {
        throw new RangeError(`${buffer.name} requires ${required} bytes, adapter limit is ${limit}`);
      }
      if (buffer.stride > 1 && required % buffer.stride !== 0) {
        throw new Error(`${buffer.name} cursor is not record aligned`);
      }
    }
  }

  private growBuffer(
    owner: ResidentBuffer,
    required: number,
    command: ShadeGPUCommandContext | GpuAssetCommand
  ): BufferReplacement {
    const previous = owner.buffer;
    const limit = Math.min(
      Number(this.device.limits.maxBufferSize ?? Number.MAX_SAFE_INTEGER),
      Number(this.device.limits.maxStorageBufferBindingSize ?? Number.MAX_SAFE_INTEGER)
    );
    let size = Math.max(required, previous.size + Math.max(previous.size >>> 1, 4096));
    size = align4(Math.min(size, limit));
    if (size < required) size = align4(required);
    const next = this.device.createBuffer({
      label: `${owner.label}/grow-${size}`,
      size,
      usage: STORAGE_USAGE
    });
    command.copyBufferToBuffer(previous, 0, next, 0, previous.size);
    owner.buffer = next;
    this.attemptedGrowCount++;
    this.epoch++;
    return { owner, previous, next };
  }

  private uploadSegment(
    segment: UploadSegment,
    command: ShadeGPUCommandContext | GpuAssetCommand,
    transactional: boolean
  ): void {
    const { target, destinationByteOffset, bytes } = segment;
    if (destinationByteOffset % 4 !== 0 || bytes.byteLength % 4 !== 0) {
      throw new Error(`${target.name} upload is not WebGPU write aligned`);
    }
    if (transactional) {
      command.writeBuffer(
        target.buffer,
        destinationByteOffset,
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
      );
      recordGpuQueueUpload(this.device.queue, target.label, bytes.byteLength);
    } else {
      writeGpuBuffer(
        this.device.queue,
        target.label,
        target.buffer,
        destinationByteOffset,
        bytes
      );
    }
    this.recordUpload(segment.sourceByteLength, bytes.byteLength);
  }

  private recordUpload(sourceBytes: number, uploaded: number): void {
    this.uploadCalls++;
    this.uploadSourceBytes += sourceBytes;
    this.uploadedBytes += uploaded;
    this.uploadPaddingBytes += uploaded - sourceBytes;
  }

  private commitReplacements(replacements: readonly BufferReplacement[]): void {
    for (const replacement of replacements) {
      this.retiredBufferCount++;
      this.retiringBytes += replacement.previous.size;
      const destroy = (): void => {
        replacement.previous.destroy();
        this.retiringBytes -= replacement.previous.size;
        this.destroyedRetiredBufferCount++;
      };
      void this.device.queue.onSubmittedWorkDone().then(destroy, destroy);
    }
  }

  private rollbackResidencyBatch(
    cursors: ReadonlyMap<ResidentBuffer, number>,
    slots: readonly SlotState[],
    freeSlots: readonly number[],
    replacements: readonly BufferReplacement[]
  ): void {
    for (let index = replacements.length - 1; index >= 0; index--) {
      const replacement = replacements[index]!;
      replacement.owner.buffer = replacement.previous;
      replacement.next.destroy();
    }
    for (const [buffer, cursor] of cursors) buffer.cursorBytes = cursor;
    this.slots.length = 0;
    for (const slot of slots) this.slots.push({
      generation: slot.generation,
      entry: slot.entry
    });
    this.freeSlots.length = 0;
    this.freeSlots.push(...freeSlots);
    this.epoch++;
  }

  private recordProvisionalPeak(replacements: readonly BufferReplacement[]): void {
    const overlap = replacements.reduce((sum, replacement) => sum + replacement.previous.size, 0);
    this.peakAllocatedBytes = Math.max(
      this.peakAllocatedBytes,
      this.currentAllocatedBytes() + this.retiringBytes + overlap
    );
  }

  private requireEntry(
    handle: AssetHandle,
    ...states: AssetEntry["state"][]
  ): AssetEntry {
    const runtime = HANDLE_STATE.get(handle as object);
    if (runtime === undefined || runtime.store !== this) {
      throw new Error("AssetHandle belongs to another store or is invalid");
    }
    const slot = this.slots[runtime.slot];
    const entry = slot?.entry;
    if (
      entry === undefined ||
      entry.generation !== runtime.generation ||
      !states.includes(entry.state)
    ) {
      throw new Error("AssetHandle is stale or not resident");
    }
    return entry;
  }

  private assertMutation(
    command: ShadeGPUCommandContext | GpuAssetCommand,
    kind: "resident" | "release"
  ): void {
    this.assertAlive();
    if (command.device !== this.device) {
      throw new Error("GpuAssetStore command belongs to another GPUDevice");
    }
    if (command.closed === true) throw new Error("GpuAssetStore command is already closed");
    if (this.pendingMutation !== null) {
      throw new Error(`GpuAssetStore already has a pending ${this.pendingMutation} mutation`);
    }
    this.pendingMutation = kind;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("GpuAssetStore has been destroyed");
  }

  private createZeroBuffer(label: string, size: number): GPUBuffer {
    const limit = Math.min(
      Number(this.device.limits.maxBufferSize ?? Number.MAX_SAFE_INTEGER),
      Number(this.device.limits.maxStorageBufferBindingSize ?? Number.MAX_SAFE_INTEGER)
    );
    if (size > limit) throw new RangeError(`${label} exceeds adapter storage buffer limit`);
    const buffer = this.device.createBuffer({
      label,
      size,
      usage: STORAGE_USAGE,
      mappedAtCreation: true
    });
    // Mapped-at-creation buffers are zero initialized by WebGPU. Touching the
    // range makes the initialization invariant explicit for test doubles too.
    new Uint8Array(buffer.getMappedRange()).fill(0);
    buffer.unmap();
    return buffer;
  }

  private currentAllocatedBytes(): number {
    return this.orderedBuffers.reduce((sum, buffer) => sum + buffer.buffer.size, 0);
  }

  private fallbackBytes(): number {
    return this.orderedBuffers.reduce(
      (sum, buffer) => sum + Math.max(4, align4(buffer.stride)),
      0
    );
  }
}

function uvByteOffset(
  descriptor: GeometryAssetPackage["vertexStreamDescriptors"][number] | undefined,
  vertexDataBegin: number
): number {
  return descriptor === undefined
    ? 0
    : checkedAdd(vertexDataBegin, descriptor.dataByteOffset, "UV stream offset");
}

function uvFormat(
  descriptor: GeometryAssetPackage["vertexStreamDescriptors"][number] | undefined
): number {
  if (descriptor === undefined || descriptor.componentCount !== 2) {
    return GPU_UV_FORMAT.Unknown;
  }
  if (descriptor.dataType === "float32") return GPU_UV_FORMAT.Float32x2;
  if (descriptor.dataType === "uint8" && descriptor.normalized) {
    return GPU_UV_FORMAT.Unorm8x2;
  }
  if (descriptor.dataType === "uint16" && descriptor.normalized) {
    return GPU_UV_FORMAT.Unorm16x2;
  }
  return GPU_UV_FORMAT.Unknown;
}

function rebaseBvhNode(
  node: GeometryBvh8Node,
  bvhBegin: number,
  clusterBegin: number
): GeometryBvh8Node {
  const refs = new Uint32Array(8);
  for (let slot = 0; slot < 8; slot++) {
    const valid = (node.validMask & (1 << slot)) !== 0;
    if (!valid) {
      refs[slot] = 0;
      continue;
    }
    const leaf = (node.leafMask & (1 << slot)) !== 0;
    refs[slot] = checkedAdd(
      leaf ? clusterBegin : bvhBegin,
      node.childRefs[slot]!,
      leaf ? "BVH leaf reference" : "BVH child reference"
    );
  }
  return {
    parent: node.parent === GEOMETRY_INVALID_INDEX
      ? GPU_FALLBACK_RECORD_INDEX
      : checkedAdd(bvhBegin, node.parent, "BVH parent"),
    depth: node.depth,
    childCount: node.childCount,
    validMask: node.validMask,
    leafMask: node.leafMask,
    flags: node.flags,
    childRefs: refs,
    childRangeCounts: node.childRangeCounts,
    childBoundsBox: node.childBoundsBox
  };
}

function countOf(buffer: ResidentBuffer): number {
  return buffer.stride === 1
    ? buffer.cursorBytes
    : Math.floor(buffer.cursorBytes / buffer.stride);
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function pad4(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const size = align4(bytes.byteLength);
  const padded = new Uint8Array(size);
  padded.set(bytes);
  return padded;
}

function align4(value: number): number {
  return Math.ceil(value / 4) * 4;
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

function nextGeneration(value: number): number {
  return value >= U32_MAX ? 1 : value + 1;
}
