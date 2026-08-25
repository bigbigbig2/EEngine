/**
 * GPUSkinningManager：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { Mesh } from "../scene/Mesh.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { WGSL_u32 } from "../core/WebGPUTypes.js";
import { StructType } from "../core/WgslStruct.js";
import type { CachedComputePipelineDescriptor } from "./GPUDescriptorCaches.js";
import { MeshletGpuTable } from "./MeshletGpuTable.js";
import {
  SKINNING_BOUNDS_CLEAR_WGSL,
  SKINNING_BOUNDS_REDUCE_WGSL,
  SKINNING_GEOMETRY_SPHERE_WGSL,
  SKINNING_SCENE_BOUNDS_WGSL,
  SKINNING_VERTEX_WGSL,
} from "./GPUSkinningShaders.js";

export const SKINNING_INVALID_OFFSET = 0xffffffff;

export const SKINNING_BINDING_TYPE = StructType.from(
  {
    skin_matrix_offset: WGSL_u32,
    source_meshlet_metadata_offset: WGSL_u32,
    clone_meshlet_metadata_offset: WGSL_u32,
    meshlet_count: WGSL_u32,
    clone_geometry_index: WGSL_u32,
    mesh_instance_index: WGSL_u32,
  },
  "ColorTarget",
);

export const SKINNING_BINDING_STRIDE_BYTES = SKINNING_BINDING_TYPE.size;

type AnimationManagerLike = {
  get_skin_matrix_offset(index: number): number | undefined;
  skin_matrices_buffer: GPUBuffer | null;
  prev_skin_matrices_buffer: GPUBuffer | null;
};

type SkinningSceneContext = {
  id_mapping: Map<number, number>;
  scene_database_buffer: GPUBuffer | null;
};

type SkinningBinding = {
  skin_id: number;
  mesh: Mesh;
  source_meshlet_metadata_offset: number;
  clone_meshlet_metadata_offset: number;
  meshlet_count: number;
  clone_geometry_index: number;
  previous_position_vertex_offset: number;
};

function createSkinningPipelineDescriptor(
  label: string,
  code: string,
  bindings: readonly GPUBufferBindingType[],
): CachedComputePipelineDescriptor {
  const group0: GPUBindGroupLayoutDescriptor = {
    label: `${label}/group0`,
    entries: bindings.map((type, binding) => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type },
    })),
  };
  return {
    label,
    layout: {
      label: `${label}/layout`,
      bindGroupLayouts: [group0],
    },
    compute: {
      module: { label: `${label}/module`, code },
      entryPoint: "main",
    },
  };
}

export class GPUSkinningManager {
  private readonly device: GPUDevice;
  private readonly geometryTable: MeshletGpuTable;
  private readonly animationManager: AnimationManagerLike;
  private readonly sceneContext: SkinningSceneContext;
  private readonly skinningPipeline: CachedComputePipelineDescriptor;
  private readonly boundsClearPipeline: CachedComputePipelineDescriptor;
  private readonly boundsReducePipeline: CachedComputePipelineDescriptor;
  private readonly geometrySpherePipeline: CachedComputePipelineDescriptor;
  private readonly sceneBoundsPipeline: CachedComputePipelineDescriptor;
  private readonly cloneGeometryByMesh = new Map<Mesh, number>();
  private readonly skinByMesh = new Map<Mesh, number>();
  private readonly bindings: SkinningBinding[] = [];
  private bindingBuffer: GPUBuffer | null = null;
  private bindingCapacity = 0;
  private pairBuffer: GPUBuffer | null = null;
  private pairCapacity = 0;
  private previousPositions: GPUBuffer | null = null;
  private previousPositionCapacity = 0;
  private previousPositionOffsets: GPUBuffer | null = null;
  private previousPositionOffsetCapacity = 0;
  private previousPositionOffsetCpu = new Uint32Array(0);
  private totalMeshletCountValue = 0;
  private totalPreviousVertexCount = 0;
  private dirty = false;

  constructor(options: {
    device: GPUDevice;
    geometries: MeshletGpuTable;
    animation_manager: AnimationManagerLike;
    scene_context: SkinningSceneContext;
  }) {
    this.device = options.device;
    this.geometryTable = options.geometries;
    this.animationManager = options.animation_manager;
    this.sceneContext = options.scene_context;
    this.skinningPipeline = createSkinningPipelineDescriptor(
      "GPUSkinningManager/eL-skinning",
      SKINNING_VERTEX_WGSL,
      [
        "uniform",
        "storage",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "storage",
        "read-only-storage",
      ],
    );
    this.boundsClearPipeline = createSkinningPipelineDescriptor(
      "GPUSkinningManager/UT-bounds-clear",
      SKINNING_BOUNDS_CLEAR_WGSL,
      [
        "uniform",
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "storage",
        "storage",
      ],
    );
    this.boundsReducePipeline = createSkinningPipelineDescriptor(
      "GPUSkinningManager/kT-bounds-reduce",
      SKINNING_BOUNDS_REDUCE_WGSL,
      [
        "uniform",
        "read-only-storage",
        "read-only-storage",
        "read-only-storage",
        "storage",
        "storage",
      ],
    );
    this.geometrySpherePipeline = createSkinningPipelineDescriptor(
      "GPUSkinningManager/bT-geometry-sphere",
      SKINNING_GEOMETRY_SPHERE_WGSL,
      ["uniform", "read-only-storage", "storage"],
    );
    this.sceneBoundsPipeline = createSkinningPipelineDescriptor(
      "GPUSkinningManager/ST-scene-bounds",
      SKINNING_SCENE_BOUNDS_WGSL,
      ["uniform", "read-only-storage", "storage", "read-only-storage"],
    );
  }

  get prev_positions_buffer(): GPUBuffer | null {
    return this.previousPositions;
  }

  get prev_position_offsets_buffer(): GPUBuffer | null {
    return this.previousPositionOffsets;
  }

  get binding_count(): number {
    return this.bindings.length;
  }

  get total_meshlet_count(): number {
    return this.totalMeshletCountValue;
  }

  obtain_geometry_index(mesh: Mesh): number {
    if (mesh.geometry === null) {
      throw new Error("Mesh geometry is null");
    }
    if ((mesh as Mesh & { isSkinnedMesh?: boolean }).isSkinnedMesh === true) {
      const clone = this.ensureClone(mesh);
      this.ensureBinding(mesh, clone);
      return clone;
    }
    return this.geometryTable.obtainGeometry(mesh.geometry);
  }

  bind(mesh: Mesh, skinId: number): void {
    if (this.skinByMesh.has(mesh)) return;
    this.skinByMesh.set(mesh, skinId);
    const clone = this.ensureClone(mesh);
    this.ensureBinding(mesh, clone);
  }

  get_skin_id(mesh: Mesh): number | undefined {
    return this.skinByMesh.get(mesh);
  }

  unbind(mesh: Mesh): void {
    if (!this.skinByMesh.delete(mesh)) return;
    for (let i = this.bindings.length - 1; i >= 0; i--) {
      if (this.bindings[i]!.mesh !== mesh) continue;
      this.totalMeshletCountValue -= this.bindings[i]!.meshlet_count;
      this.bindings.splice(i, 1);
      this.dirty = true;
      break;
    }
  }

  unbind_all_by_skin(skinId: number): void {
    for (let i = this.bindings.length - 1; i >= 0; i--) {
      const binding = this.bindings[i]!;
      if (binding.skin_id !== skinId) continue;
      this.skinByMesh.delete(binding.mesh);
      this.totalMeshletCountValue -= binding.meshlet_count;
      this.bindings.splice(i, 1);
      this.dirty = true;
    }
  }

  update(command: ShadeGPUCommandContext): void {
    if (this.bindings.length === 0) return;
    this.geometryTable.update(command, "GPUSkinningManager/geometries");
    if (this.dirty) {
      this.rebuildBindingBuffer(command);
      this.rebuildPairBuffer(command);
      this.uploadPreviousPositionOffsets(command);
      this.dirty = false;
    }

    const bindingBuffer = this.bindingBuffer;
    const geometryMetadata = this.geometryTable.meshMetaBuffer;
    const sceneDatabase = this.sceneContext.scene_database_buffer;
    if (!bindingBuffer || !geometryMetadata || !sceneDatabase) return;

    const pairCount = this.totalMeshletCountValue;
    if (pairCount > 0) {
      const pairBuffer = this.pairBuffer;
      const meshletHeaders = this.geometryTable.headerBuffer;
      const meshletData = this.geometryTable.dataBuffer;
      const currentSkinMatrices = this.animationManager.skin_matrices_buffer;
      const previousSkinMatrices =
        this.animationManager.prev_skin_matrices_buffer;
      const previousOffsets = this.previousPositionOffsets;
      const previousPositions = this.previousPositions;
      if (
        !pairBuffer ||
        !meshletHeaders ||
        !meshletData ||
        !currentSkinMatrices ||
        !previousSkinMatrices ||
        !previousOffsets ||
        !previousPositions
      ) {
        return;
      }

      this.dispatchSkinning(
        command,
        pairCount,
        bindingBuffer,
        pairBuffer,
        meshletHeaders,
        meshletData,
        currentSkinMatrices,
        previousSkinMatrices,
        previousOffsets,
        previousPositions,
        sceneDatabase,
      );
      this.dispatchBoundsClear(
        command,
        pairCount,
        bindingBuffer,
        pairBuffer,
        meshletHeaders,
        geometryMetadata,
      );
      this.dispatchBoundsReduce(
        command,
        pairCount,
        bindingBuffer,
        pairBuffer,
        meshletHeaders,
        meshletData,
        geometryMetadata,
      );
    }

    this.dispatchGeometrySpheres(command, bindingBuffer, geometryMetadata);
    this.dispatchSceneBounds(
      command,
      bindingBuffer,
      sceneDatabase,
      geometryMetadata,
    );
  }

  destroy(): void {
    this.bindingBuffer?.destroy();
    this.pairBuffer?.destroy();
    this.previousPositions?.destroy();
    this.previousPositionOffsets?.destroy();
    this.bindingBuffer = null;
    this.pairBuffer = null;
    this.previousPositions = null;
    this.previousPositionOffsets = null;
    this.bindings.length = 0;
    this.cloneGeometryByMesh.clear();
    this.skinByMesh.clear();
  }

  private ensureClone(mesh: Mesh): number {
    const existing = this.cloneGeometryByMesh.get(mesh);
    if (existing !== undefined) return existing;
    const geometry = mesh.geometry;
    if (geometry === null) {
      throw new Error("Mesh geometry is null");
    }
    const sourceIndex = this.geometryTable.obtainGeometry(geometry);
    const source = this.geometryTable.getGeometryMeta(sourceIndex);
    const cloneIndex = this.geometryTable.cloneGeometry(geometry);
    const clone = this.geometryTable.getGeometryMeta(cloneIndex);
    this.cloneGeometryByMesh.set(mesh, cloneIndex);

    if (source && clone) {
      const previousBase = this.totalPreviousVertexCount;
      let localVertexOffset = 0;
      this.ensurePreviousPositionOffsetCapacity(
        clone.meshlets_address + clone.meshlet_count,
      );
      for (let i = 0; i < clone.meshlet_count; i++) {
        const vertexCount = this.geometryTable.getMeshletVertexCount(
          source.meshlets_address + i,
        );
        this.previousPositionOffsetCpu[clone.meshlets_address + i] =
          3 * (previousBase + localVertexOffset);
        localVertexOffset += vertexCount;
      }
      this.totalPreviousVertexCount += localVertexOffset;
      this.ensurePreviousPositionsCapacity(this.totalPreviousVertexCount);
      this.dirty = true;
    }
    return cloneIndex;
  }

  private ensureBinding(mesh: Mesh, cloneIndex: number): void {
    const skinId = this.skinByMesh.get(mesh);
    if (skinId === undefined) return;
    for (const binding of this.bindings) {
      if (binding.mesh === mesh) return;
    }
    const geometry = mesh.geometry;
    if (geometry === null) return;
    const sourceIndex = this.geometryTable.obtainGeometry(geometry);
    const source = this.geometryTable.getGeometryMeta(sourceIndex);
    const clone = this.geometryTable.getGeometryMeta(cloneIndex);
    if (!source || !clone) return;
    const previousOffset =
      clone.meshlet_count > 0
        ? (this.previousPositionOffsetCpu[clone.meshlets_address] ?? 0)
        : 0;
    this.bindings.push({
      skin_id: skinId,
      mesh,
      source_meshlet_metadata_offset: source.meshlets_address,
      clone_meshlet_metadata_offset: clone.meshlets_address,
      meshlet_count: clone.meshlet_count,
      clone_geometry_index: cloneIndex,
      previous_position_vertex_offset: previousOffset / 3,
    });
    this.totalMeshletCountValue += clone.meshlet_count;
    this.dirty = true;
  }

  private rebuildBindingBuffer(command: ShadeGPUCommandContext): void {
    const count = this.bindings.length;
    if (count > this.bindingCapacity) {
      let capacity = Math.max(this.bindingCapacity, 16);
      while (capacity < count) capacity *= 2;
      this.bindingBuffer?.destroy();
      this.bindingBuffer = this.device.createBuffer({
        label: "GPUSkinningManager/bindings",
        size: capacity * SKINNING_BINDING_STRIDE_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.bindingCapacity = capacity;
    }
    if (!this.bindingBuffer || count === 0) return;
    const wordsPerRecord = SKINNING_BINDING_STRIDE_BYTES / 4;
    const data = new Uint32Array(count * wordsPerRecord);
    for (let i = 0; i < count; i++) {
      const binding = this.bindings[i]!;
      const nodeIndex = this.sceneContext.id_mapping.get(binding.mesh.id);
      if (nodeIndex === undefined) {
        throw new Error(
          `GPUSkinningManager: mesh ${binding.mesh.id} has no scene database mapping`,
        );
      }
      const skinMatrixOffset = this.animationManager.get_skin_matrix_offset(
        binding.skin_id,
      );
      if (skinMatrixOffset === undefined) {
        throw new Error(
          `GPUSkinningManager: skin ${binding.skin_id} has no matrix offset`,
        );
      }
      const base = i * wordsPerRecord;
      data[base] = skinMatrixOffset;
      data[base + 1] = binding.source_meshlet_metadata_offset;
      data[base + 2] = binding.clone_meshlet_metadata_offset;
      data[base + 3] = binding.meshlet_count;
      data[base + 4] = binding.clone_geometry_index;
      data[base + 5] = nodeIndex - 1;
    }
    command.writeBuffer(
      this.bindingBuffer,
      0,
      data.buffer,
      data.byteOffset,
      data.byteLength
    );
  }

  private rebuildPairBuffer(command: ShadeGPUCommandContext): void {
    const count = this.totalMeshletCountValue;
    if (count > this.pairCapacity) {
      let capacity = Math.max(this.pairCapacity, 256);
      while (capacity < count) capacity *= 2;
      this.pairBuffer?.destroy();
      this.pairBuffer = this.device.createBuffer({
        label: "GPUSkinningManager/binding-meshlet-pairs",
        size: capacity * 8,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.pairCapacity = capacity;
    }
    if (!this.pairBuffer || count === 0) return;
    const pairs = new Uint32Array(2 * count);
    let cursor = 0;
    for (
      let bindingIndex = 0;
      bindingIndex < this.bindings.length;
      bindingIndex++
    ) {
      const binding = this.bindings[bindingIndex]!;
      for (let meshlet = 0; meshlet < binding.meshlet_count; meshlet++) {
        pairs[cursor++] = bindingIndex;
        pairs[cursor++] = meshlet;
      }
    }
    command.writeBuffer(
      this.pairBuffer,
      0,
      pairs.buffer,
      pairs.byteOffset,
      pairs.byteLength
    );
  }

  private ensurePreviousPositionsCapacity(vertexCount: number): void {
    if (this.previousPositions && vertexCount <= this.previousPositionCapacity)
      return;
    let capacity = Math.max(this.previousPositionCapacity, 1024);
    while (capacity < vertexCount) capacity *= 2;
    this.previousPositions?.destroy();
    this.previousPositions = this.device.createBuffer({
      label: "GPUSkinningManager/previous-positions",
      size: 3 * capacity * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.previousPositionCapacity = capacity;
  }

  private ensurePreviousPositionOffsetCapacity(required: number): void {
    if (
      this.previousPositionOffsets &&
      required <= this.previousPositionOffsetCapacity
    ) {
      return;
    }
    let capacity = Math.max(this.previousPositionOffsetCapacity, 1024);
    while (capacity < required) capacity *= 2;
    const next = new Uint32Array(capacity);
    next.fill(SKINNING_INVALID_OFFSET);
    next.set(this.previousPositionOffsetCpu);
    this.previousPositionOffsetCpu = next;
    this.previousPositionOffsets?.destroy();
    this.previousPositionOffsets = this.device.createBuffer({
      label: "GPUSkinningManager/previous-position-offsets",
      size: capacity * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.previousPositionOffsetCapacity = capacity;
  }

  private uploadPreviousPositionOffsets(command: ShadeGPUCommandContext): void {
    if (!this.previousPositionOffsets) return;
    command.writeBuffer(
      this.previousPositionOffsets,
      0,
      this.previousPositionOffsetCpu.buffer,
      this.previousPositionOffsetCpu.byteOffset,
      this.previousPositionOffsetCpu.byteLength
    );
  }

  private transientU32(
    command: ShadeGPUCommandContext,
    value: number,
  ): GPUBuffer {
    return command.allocateTransientBufferAndLoad(
      new Uint32Array([value >>> 0]).buffer,
      GPUBufferUsage.UNIFORM,
    );
  }

  private dispatchSkinning(
    command: ShadeGPUCommandContext,
    pairCount: number,
    bindings: GPUBuffer,
    pairs: GPUBuffer,
    meshletHeaders: GPUBuffer,
    meshletData: GPUBuffer,
    currentSkinMatrices: GPUBuffer,
    previousSkinMatrices: GPUBuffer,
    previousOffsets: GPUBuffer,
    previousPositions: GPUBuffer,
    sceneDatabase: GPUBuffer,
  ): void {
    const limit = this.device.limits.maxComputeWorkgroupsPerDimension;
    for (let offset = 0; offset < pairCount; offset += limit) {
      const groupCount = Math.min(limit, pairCount - offset);
      const dispatchOffset = this.transientU32(command, offset);
      const pass = command.constructComputePass({
        label: "GPUSkinningManager/eL-skinning",
        pipeline: this.skinningPipeline,
        bindings: [[
          { buffer: dispatchOffset },
          { buffer: meshletData },
          { buffer: meshletHeaders },
          { buffer: currentSkinMatrices },
          { buffer: previousSkinMatrices },
          { buffer: bindings },
          { buffer: pairs },
          { buffer: previousOffsets },
          { buffer: previousPositions },
          { buffer: sceneDatabase },
        ]],
      });
      pass.dispatchWorkgroups(groupCount);
      pass.end();
    }
  }

  private dispatchBoundsClear(
    command: ShadeGPUCommandContext,
    pairCount: number,
    bindings: GPUBuffer,
    pairs: GPUBuffer,
    meshletHeaders: GPUBuffer,
    geometryMetadata: GPUBuffer,
  ): void {
    const totalGroups = Math.ceil(pairCount / 64);
    const limit = this.device.limits.maxComputeWorkgroupsPerDimension;
    for (let groupOffset = 0; groupOffset < totalGroups; groupOffset += limit) {
      const groupCount = Math.min(limit, totalGroups - groupOffset);
      const dispatchOffset = this.transientU32(command, groupOffset * 64);
      const totalPairCount = this.transientU32(command, pairCount);
      const pass = command.constructComputePass({
        label: "GPUSkinningManager/UT-bounds-clear",
        pipeline: this.boundsClearPipeline,
        bindings: [[
          { buffer: dispatchOffset },
          { buffer: totalPairCount },
          { buffer: bindings },
          { buffer: pairs },
          { buffer: meshletHeaders },
          { buffer: geometryMetadata },
        ]],
      });
      pass.dispatchWorkgroups(groupCount);
      pass.end();
    }
  }

  private dispatchBoundsReduce(
    command: ShadeGPUCommandContext,
    pairCount: number,
    bindings: GPUBuffer,
    pairs: GPUBuffer,
    meshletHeaders: GPUBuffer,
    meshletData: GPUBuffer,
    geometryMetadata: GPUBuffer,
  ): void {
    const limit = this.device.limits.maxComputeWorkgroupsPerDimension;
    for (let offset = 0; offset < pairCount; offset += limit) {
      const groupCount = Math.min(limit, pairCount - offset);
      const dispatchOffset = this.transientU32(command, offset);
      const pass = command.constructComputePass({
        label: "GPUSkinningManager/kT-bounds-reduce",
        pipeline: this.boundsReducePipeline,
        bindings: [[
          { buffer: dispatchOffset },
          { buffer: bindings },
          { buffer: pairs },
          { buffer: meshletData },
          { buffer: meshletHeaders },
          { buffer: geometryMetadata },
        ]],
      });
      pass.dispatchWorkgroups(groupCount);
      pass.end();
    }
  }

  private dispatchGeometrySpheres(
    command: ShadeGPUCommandContext,
    bindings: GPUBuffer,
    geometryMetadata: GPUBuffer,
  ): void {
    const groupCount = Math.ceil(this.bindings.length / 64);
    if (groupCount === 0) return;
    const bindingCount = this.transientU32(command, this.bindings.length);
    const pass = command.constructComputePass({
      label: "GPUSkinningManager/bT-geometry-sphere",
      pipeline: this.geometrySpherePipeline,
      bindings: [[
        { buffer: bindingCount },
        { buffer: bindings },
        { buffer: geometryMetadata },
      ]],
    });
    pass.dispatchWorkgroups(groupCount);
    pass.end();
  }

  private dispatchSceneBounds(
    command: ShadeGPUCommandContext,
    bindings: GPUBuffer,
    sceneDatabase: GPUBuffer,
    geometryMetadata: GPUBuffer,
  ): void {
    const groupCount = Math.ceil(this.bindings.length / 64);
    if (groupCount === 0) return;
    const bindingCount = this.transientU32(command, this.bindings.length);
    const pass = command.constructComputePass({
      label: "GPUSkinningManager/ST-scene-bounds",
      pipeline: this.sceneBoundsPipeline,
      bindings: [[
        { buffer: bindingCount },
        { buffer: bindings },
        { buffer: sceneDatabase },
        { buffer: geometryMetadata },
      ]],
    });
    pass.dispatchWorkgroups(groupCount);
    pass.end();
  }
}
