/**
 * GPULightProbeVolume：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { LightProbeVolume } from "../scene/Scene.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import { LightProbeAtlas } from "./LightProbeAtlas.js";
export { LIGHT_PROBE_RECORD_WGSL } from "./LightProbeRecord.js";
import {
  DynamicBvh,
  DYNAMIC_BVH_GPU_NODE_BYTES,
  exportDynamicBvhNodes
} from "./DynamicBvh.js";

export const LIGHT_PROBE_COEFFICIENT_COUNT = 12;
export const LIGHT_PROBE_CPU_COEFFICIENT_COUNT = 27;
export const LIGHT_PROBE_RECORD_STRIDE_BYTES = 68;
export const LIGHT_PROBE_METADATA_BYTES = 8;
export const LIGHT_PROBE_TETRA_RECORD_BYTES = 32;
export const LIGHT_PROBE_EMPTY_BVH_BYTES = 36;

export const LIGHT_PROBE_RECORD_WORD_OFFSETS = {
  position: 0,
  distanceMax: 3,
  accumulatedSamples: 4,
  coefficients: 5
} as const;

export class GPULightProbeVolume {
  readonly source: LightProbeVolume;
  readonly atlas: LightProbeAtlas;
  private readonly device: GPUDevice;

  private probeBuffer: GPUBuffer;
  private metadataBuffer: GPUBuffer;
  private meshBuffer: GPUBuffer;
  private meshBvhBuffer: GPUBuffer;
  private readonly meshBvh = new DynamicBvh();
  private uploadedVersion = 0;

  constructor(
    graphics: GraphicsContext,
    source: LightProbeVolume
  ) {
    const device = graphics.device;
    this.device = device;
    this.source = source;
    this.probeBuffer = this.createProbeBuffer(
      LIGHT_PROBE_RECORD_STRIDE_BYTES,
      false
    );
    this.metadataBuffer = device.createBuffer({
      label: "Light Probe Volume / metadata",
      size: LIGHT_PROBE_METADATA_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.meshBuffer = device.createBuffer({
      label: "Tetrahedral Mesh",
      size: LIGHT_PROBE_TETRA_RECORD_BYTES,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST
    });
    this.meshBvhBuffer = device.createBuffer({
      label: "LPV Mesh BVH",
      size: LIGHT_PROBE_EMPTY_BVH_BYTES,
      usage: GPUBufferUsage.STORAGE
    });
    this.atlas = new LightProbeAtlas(graphics);
  }

  get buffer_probes(): GPUBuffer {
    return this.probeBuffer;
  }

  get buffer_metadata(): GPUBuffer {
    return this.metadataBuffer;
  }

  get buffer_mesh(): GPUBuffer {
    return this.meshBuffer;
  }

  get buffer_mesh_bvh(): GPUBuffer {
    return this.meshBvhBuffer;
  }

  get probe_resolution(): number {
    return this.atlas.probe_resolution;
  }

  update(): void {
    if (this.source.version !== this.uploadedVersion) {
      this.commit();
    }
  }

  commit(): void {
    this.uploadedVersion = this.source.version;
    this.push_to_gpu();
  }

  push_to_gpu(): void {
    this.rebuildMeshBuffer();
    this.rebuildProbeBuffer();
    const metadata = new Uint32Array([
      this.source.probe_count >>> 0,
      this.probe_resolution >>> 0
    ]);
    this.device.queue.writeBuffer(this.metadataBuffer, 0, metadata);
    this.rebuildMeshBvh();
  }

  get gpu_memory_usage(): number {
    return (
      this.meshBuffer.size +
      this.probeBuffer.size +
      this.metadataBuffer.size +
      this.atlas.gpu_memory_usage
    );
  }

  destroy(): void {
    this.meshBuffer.destroy();
    this.meshBvhBuffer.destroy();
    this.probeBuffer.destroy();
    this.metadataBuffer.destroy();
    this.atlas.destroy();
  }

  async download(): Promise<void> {
    const probes = await this.readProbes();
    for (let probe = 0; probe < probes.length; probe++) {
      const record = probes[probe]!;
      const coefficientOffset = probe * LIGHT_PROBE_CPU_COEFFICIENT_COUNT;
      const positionOffset = probe * 3;
      for (
        let coefficient = 0;
        coefficient < LIGHT_PROBE_CPU_COEFFICIENT_COUNT;
        coefficient++
      ) {
        this.source.coefficients[coefficientOffset + coefficient] =
          record.coefficients[coefficient]!;
      }
      this.source.positions[positionOffset] = record.position[0]!;
      this.source.positions[positionOffset + 1] = record.position[1]!;
      this.source.positions[positionOffset + 2] = record.position[2]!;
    }
  }

  debugReadProbes(): void {
    this.readProbes().then(console.warn);
  }

  private rebuildProbeBuffer(): void {
    const previous = this.probeBuffer;
    const probeCount = this.source.probe_count;
    const byteSize =
      Math.max(1, probeCount) * LIGHT_PROBE_RECORD_STRIDE_BYTES;
    const next = this.createProbeBuffer(byteSize, true);
    const mapped = next.getMappedRange();
    const f32 = new Float32Array(mapped);
    const u32 = new Uint32Array(mapped);
    f32.fill(0);

    const strideWords = LIGHT_PROBE_RECORD_STRIDE_BYTES >>> 2;
    const positions = this.source.positions;
    const coefficients = this.source.coefficients;
    for (let probeIndex = 0; probeIndex < probeCount; probeIndex++) {
      const record = probeIndex * strideWords;
      const position = probeIndex * 3;
      f32[record + LIGHT_PROBE_RECORD_WORD_OFFSETS.position] =
        positions[position]!;
      f32[record + LIGHT_PROBE_RECORD_WORD_OFFSETS.position + 1] =
        positions[position + 1]!;
      f32[record + LIGHT_PROBE_RECORD_WORD_OFFSETS.position + 2] =
        positions[position + 2]!;
      f32[record + LIGHT_PROBE_RECORD_WORD_OFFSETS.distanceMax] = 0;
      u32[record + LIGHT_PROBE_RECORD_WORD_OFFSETS.accumulatedSamples] = 0;

      for (
        let coefficient = 0;
        coefficient < LIGHT_PROBE_CPU_COEFFICIENT_COUNT;
        coefficient++
      ) {
        f32[
          record +
            LIGHT_PROBE_RECORD_WORD_OFFSETS.coefficients +
            coefficient
        ] = coefficients[
          probeIndex * LIGHT_PROBE_CPU_COEFFICIENT_COUNT + coefficient
        ]!;
      }
    }

    const mesh = this.source.mesh;
    for (let tetra = 0; tetra < mesh.count; tetra++) {
      for (let corner = 0; corner < 4; corner++) {
        const vertexA = mesh.getVertexIndex(tetra, corner);
        const offsetA = vertexA * 3;
        const ax = positions[offsetA]!;
        const ay = positions[offsetA + 1]!;
        const az = positions[offsetA + 2]!;
        for (let other = corner + 1; other < 4; other++) {
          const vertexB = mesh.getVertexIndex(tetra, other);
          const offsetB = vertexB * 3;
          const dx = ax - positions[offsetB]!;
          const dy = ay - positions[offsetB + 1]!;
          const dz = az - positions[offsetB + 2]!;
          const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const distanceA =
            vertexA * strideWords + LIGHT_PROBE_RECORD_WORD_OFFSETS.distanceMax;
          const distanceB =
            vertexB * strideWords + LIGHT_PROBE_RECORD_WORD_OFFSETS.distanceMax;
          f32[distanceA] = Math.max(f32[distanceA]!, distance);
          f32[distanceB] = Math.max(f32[distanceB]!, distance);
        }
      }
    }

    next.unmap();
    this.probeBuffer = next;
    previous.destroy();
  }

  private rebuildMeshBuffer(): void {
    const previous = this.meshBuffer;
    const mesh = this.source.mesh;
    const next = this.device.createBuffer({
      label: previous.label,
      usage: previous.usage,
      size: Math.max(1, mesh.count) * LIGHT_PROBE_TETRA_RECORD_BYTES,
      mappedAtCreation: true
    });
    const words = new Uint32Array(next.getMappedRange());
    for (let tetra = 0; tetra < mesh.count; tetra++) {
      const record = tetra * 8;
      for (let corner = 0; corner < 4; corner++) {
        words[record + corner] = mesh.getVertexIndex(tetra, corner);
      }
      for (let face = 0; face < 4; face++) {
        words[record + 4 + face] = mesh.getNeighbour(tetra, face);
      }
    }
    next.unmap();
    this.meshBuffer = next;
    previous.destroy();
  }

  private rebuildMeshBvh(): void {
    const mesh = this.source.mesh;
    const positions = this.source.positions;
    const bvh = this.meshBvh;
    bvh.release_all();
    bvh.node_capacity = Math.max(0, 2 * mesh.count - 1);
    const bounds = bvh.data_float32;
    for (let tetra = 0; tetra < mesh.count; tetra++) {
      const leaf = bvh.allocate_node();
      writeTetraBounds(bounds, leaf * 10, mesh, tetra, positions);
      bvh.node_set_user_data(leaf, tetra);
      bvh.insert_leaf(leaf);
    }
    bvh.trim();

    const previous = this.meshBvhBuffer;
    const exported = exportDynamicBvhNodes(bvh);
    const next = this.device.createBuffer({
      label: previous.label,
      usage: previous.usage,
      size: Math.max(DYNAMIC_BVH_GPU_NODE_BYTES, bvh.node_capacity * DYNAMIC_BVH_GPU_NODE_BYTES) + 4,
      mappedAtCreation: true
    });
    const mapped = next.getMappedRange();
    new Uint32Array(mapped, 0, 1)[0] = bvh.root;
    new Uint8Array(mapped, 4, exported.byteLength).set(new Uint8Array(exported));
    next.unmap();
    this.meshBvhBuffer = next;
    previous.destroy();
  }

  private createProbeBuffer(size: number, mappedAtCreation: boolean): GPUBuffer {
    return this.device.createBuffer({
      label: "Light Probes",
      size,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
      mappedAtCreation
    });
  }

  private async readProbes(): Promise<
    Array<{
      position: Float32Array;
      distance_max: number;
      accumulated_samples: number;
      coefficients: Float32Array;
    }>
  > {
    const count = this.source.probe_count;
    const byteSize = count * LIGHT_PROBE_RECORD_STRIDE_BYTES;
    if (byteSize === 0) return [];
    const readback = this.device.createBuffer({
      label: "Light Probes/readback",
      size: byteSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    const encoder = this.device.createCommandEncoder({ label: "" });
    encoder.copyBufferToBuffer(this.probeBuffer, 0, readback, 0, byteSize);
    this.device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ, 0, byteSize);
    const bytes = readback.getMappedRange(0, byteSize).slice(0);
    readback.unmap();
    readback.destroy();

    const f32 = new Float32Array(bytes);
    const u32 = new Uint32Array(bytes);
    const strideWords = LIGHT_PROBE_RECORD_STRIDE_BYTES >>> 2;
    const result = [];
    for (let probe = 0; probe < count; probe++) {
      const record = probe * strideWords;
      result.push({
        position: f32.slice(record, record + 3),
        distance_max:
          f32[record + LIGHT_PROBE_RECORD_WORD_OFFSETS.distanceMax]!,
        accumulated_samples:
          u32[record + LIGHT_PROBE_RECORD_WORD_OFFSETS.accumulatedSamples]!,
        coefficients: f32.slice(
          record + LIGHT_PROBE_RECORD_WORD_OFFSETS.coefficients,
          record +
            LIGHT_PROBE_RECORD_WORD_OFFSETS.coefficients +
            LIGHT_PROBE_COEFFICIENT_COUNT
        )
      });
    }
    return result;
  }
}

function writeTetraBounds(
  output: Float32Array,
  outputOffset: number,
  mesh: LightProbeVolume["mesh"],
  tetra: number,
  positions: Float32Array
): void {
  const first = mesh.getVertexIndex(tetra, 0) * 3;
  output[outputOffset] = output[outputOffset + 3] = positions[first]!;
  output[outputOffset + 1] = output[outputOffset + 4] = positions[first + 1]!;
  output[outputOffset + 2] = output[outputOffset + 5] = positions[first + 2]!;
  for (let corner = 1; corner < 4; corner++) {
    const source = mesh.getVertexIndex(tetra, corner) * 3;
    const x = positions[source]!;
    const y = positions[source + 1]!;
    const z = positions[source + 2]!;
    if (x < output[outputOffset]!) output[outputOffset] = x;
    else if (x > output[outputOffset + 3]!) output[outputOffset + 3] = x;
    if (y < output[outputOffset + 1]!) output[outputOffset + 1] = y;
    else if (y > output[outputOffset + 4]!) output[outputOffset + 4] = y;
    if (z < output[outputOffset + 2]!) output[outputOffset + 2] = z;
    else if (z > output[outputOffset + 5]!) output[outputOffset + 5] = z;
  }
}
