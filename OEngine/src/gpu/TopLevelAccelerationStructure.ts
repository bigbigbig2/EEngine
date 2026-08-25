/**
 * TopLevelAccelerationStructure：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { Mesh } from "../scene/Mesh.js";
import {
  submitGpuCommands,
  writeGpuBuffer
} from "./GpuQueueEvidence.js";
import {
  DynamicBvh,
  DYNAMIC_BVH_GPU_NODE_BYTES,
  exportDynamicBvhNodeRange,
  exportDynamicBvhNodes,
  optimizeDynamicBvh,
} from "./DynamicBvh.js";

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function growBuffer(
  device: GPUDevice,
  current: GPUBuffer,
  requiredBytes: number,
): GPUBuffer {
  if (current.size >= requiredBytes) return current;
  const size = alignUp(
    Math.max(requiredBytes, current.size + 1024, current.size * 1.2),
    1024,
  );
  const next = device.createBuffer({
    label: current.label,
    usage: current.usage,
    size,
    mappedAtCreation: false,
  });
  const encoder = device.createCommandEncoder({ label: "" });
  encoder.copyBufferToBuffer(current, 0, next, 0, current.size);
  submitGpuCommands(device, "TopLevelAccelerationStructure/grow", [
    encoder.finish({ label: "" })
  ]);
  current.destroy();
  return next;
}

export class TopLevelAccelerationStructure {
  private readonly cpuBvh = new DynamicBvh();
  private gpuBuffer: GPUBuffer;
  private uploadedVersion = 0;
  private version = 0;
  private readonly instanceNodes = new Map<number, number>();
  private readonly dirtyNodes = new Set<number>();
  private structureDirty = false;

  constructor(private readonly device: GPUDevice) {
    this.gpuBuffer = device.createBuffer({
      size: 1024,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });
  }

  get bvh(): DynamicBvh {
    return this.cpuBvh;
  }

  get buffer(): GPUBuffer {
    return this.gpuBuffer;
  }

  clear(): void {
    this.cpuBvh.release_all();
    this.instanceNodes.clear();
    this.dirtyNodes.clear();
    this.structureDirty = true;
    this.version++;
  }

  instance_add(instanceIndex: number, mesh: Mesh): void {
    const leaf = this.cpuBvh.allocate_node();
    this.cpuBvh.node_set_user_data(leaf, instanceIndex);
    this.cpuBvh.node_set_aabb(leaf, mesh.bounding_box);
    this.cpuBvh.insert_leaf(leaf);
    this.instanceNodes.set(instanceIndex, leaf);
    this.structureDirty = true;
    this.version++;
  }

  instance_update(instanceIndex: number, mesh: Mesh): void {
    const leaf = this.instanceNodes.get(instanceIndex);
    if (leaf === undefined) {
      throw new RangeError(`TLAS has no instance ${instanceIndex}`);
    }
    this.cpuBvh.node_move_aabb(
      leaf,
      mesh.bounding_box,
      (node) => this.dirtyNodes.add(node)
    );
    this.version++;
  }

  push_to_gpu(): void {
    optimizeDynamicBvh(this.cpuBvh);
    const requiredBytes =
      this.cpuBvh.node_capacity * DYNAMIC_BVH_GPU_NODE_BYTES + 4;
    this.gpuBuffer = growBuffer(this.device, this.gpuBuffer, requiredBytes);

    const exportedNodes = exportDynamicBvhNodes(this.cpuBvh);
    const stagingSize =
      Math.max(
        DYNAMIC_BVH_GPU_NODE_BYTES,
        this.cpuBvh.node_capacity * DYNAMIC_BVH_GPU_NODE_BYTES,
      ) + 4;
    const staging = this.device.createBuffer({
      label: "",
      size: stagingSize,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    });
    const mapped = staging.getMappedRange();
    new Uint32Array(mapped, 0, 1)[0] = this.cpuBvh.root;
    new Uint8Array(mapped, 4, exportedNodes.byteLength).set(
      new Uint8Array(exportedNodes),
    );
    staging.unmap();
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(staging, 0, this.gpuBuffer, 0, staging.size);
    submitGpuCommands(this.device, "TopLevelAccelerationStructure/rebuild", [
      encoder.finish()
    ]);
    staging.destroy();
    this.uploadedVersion = this.version;
    this.structureDirty = false;
    this.dirtyNodes.clear();
  }

  private pushDirtyNodesToGpu(): void {
    const nodes = Array.from(this.dirtyNodes).sort((a, b) => a - b);
    let rangeStart = 0;
    while (rangeStart < nodes.length) {
      const firstNode = nodes[rangeStart]!;
      let rangeEnd = rangeStart + 1;
      while (
        rangeEnd < nodes.length &&
        nodes[rangeEnd] === nodes[rangeEnd - 1]! + 1
      ) {
        rangeEnd++;
      }
      const nodeCount = rangeEnd - rangeStart;
      const data = exportDynamicBvhNodeRange(
        this.cpuBvh,
        firstNode,
        nodeCount
      );
      writeGpuBuffer(
        this.device.queue,
        "TopLevelAccelerationStructure/dirty-nodes",
        this.gpuBuffer,
        4 + firstNode * DYNAMIC_BVH_GPU_NODE_BYTES,
        data
      );
      rangeStart = rangeEnd;
    }
    this.dirtyNodes.clear();
    this.uploadedVersion = this.version;
  }

  update(): void {
    if (this.uploadedVersion === this.version) return;
    if (this.structureDirty) this.push_to_gpu();
    else this.pushDirtyNodesToGpu();
  }

  destroy(): void {
    this.gpuBuffer.destroy();
  }
}
