/**
 * 材质 Meshlet 绘制列表：按材质桶整理 Meshlet，并生成后续材质与光照阶段的间接工作。
 */

import type { ShadeMaterial } from "../material/ShadeMaterial.js";
import { FILL_ARGS_GROUP, obtainFillDispatchPipeline } from "./MeshletDrawList.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { CachedComputePipelineDescriptor } from "./GPUDescriptorCaches.js";
import {
  MATERIAL_SORT_COMMANDS_WGSL,
  MATERIAL_SORT_COUNT_WGSL,
  MATERIAL_SORT_DRAW_ARGS_BYTES,
  MATERIAL_SORT_PREFIX_SCAN_WGSL,
  MATERIAL_SORT_SCATTER_WGSL,
  MATERIAL_SORT_TILE_SIZE,
  MATERIAL_SORT_WORKGROUP_SIZE
} from "../shaders/meshlet_material_sort.js";

const DISPATCH_ARGS_BYTES = 12;
const MATERIAL_LIST_HEADER_BYTES = 16;
const MESHLET_ELEMENT_BYTES = 8;

export type MaterialMeshletDrawResult = {
  meshlets: GPUBuffer;
  commands: GPUBuffer;
  material_count: number;
};

export type MaterialMeshletCommandContext = {
  readonly gpu_encoder: GPUCommandEncoder;
  writeBuffer(
    buffer: GPUBuffer,
    bufferOffset: number,
    data: ArrayBuffer,
    dataOffset: number,
    size: number
  ): void;
  clearBuffer(buffer: GPUBuffer, offset?: number, size?: number): void;
};

export class MaterialMeshletDrawList {
  private contextBuffer: GPUBuffer | null = null;
  private countsBuffer: GPUBuffer | null = null;
  private countersBuffer: GPUBuffer | null = null;
  private spineBuffer: GPUBuffer | null = null;
  private sortedBuffer: GPUBuffer | null = null;
  private commandsBuffer: GPUBuffer | null = null;
  private inputDispatchArgs: GPUBuffer | null = null;
  private scanDispatchArgs: GPUBuffer | null = null;

  private countPipeline: GPUComputePipeline | null = null;
  private scanPipeline: GPUComputePipeline | null = null;
  private scatterPipeline: GPUComputePipeline | null = null;
  private commandPipeline: GPUComputePipeline | null = null;

  private readonly device: GPUDevice;

  constructor(private readonly graphics: GraphicsContext) {
    this.device = graphics.device;
  }

  build(
    command: MaterialMeshletCommandContext,
    input: GPUBuffer,
    sceneDatabase: GPUBuffer,
    materials: readonly ShadeMaterial[],
    materialCapacity = materials.length
  ): MaterialMeshletDrawResult | null {
    const materialCount = materials.length;
    if (materialCount === 0) return null;
    const hashTable = buildMaterialLookup(materials);
    const inputElementCapacity = Math.max(
      1,
      Math.floor((input.size - MATERIAL_LIST_HEADER_BYTES) / MESHLET_ELEMENT_BYTES)
    );
    this.ensureBuffers(
      materialLookupByteLength(Math.max(materialCount, materialCapacity)),
      Math.max(materialCount, materialCapacity),
      inputElementCapacity
    );
    if (
      !this.contextBuffer ||
      !this.countsBuffer ||
      !this.countersBuffer ||
      !this.spineBuffer ||
      !this.sortedBuffer ||
      !this.commandsBuffer ||
      !this.inputDispatchArgs ||
      !this.scanDispatchArgs
    ) {
      return null;
    }

    command.writeBuffer(
      this.contextBuffer,
      0,
      hashTable.buffer as ArrayBuffer,
      hashTable.byteOffset,
      hashTable.byteLength
    );
    command.clearBuffer(this.countsBuffer);
    command.clearBuffer(this.countersBuffer);
    command.clearBuffer(this.spineBuffer);
    command.clearBuffer(this.commandsBuffer);
    this.fillDispatch(
      command.gpu_encoder,
      input,
      this.inputDispatchArgs,
      MATERIAL_SORT_WORKGROUP_SIZE,
      "Bp/input-dispatch"
    );
    this.dispatchCounts(
      command.gpu_encoder,
      input,
      sceneDatabase,
      this.inputDispatchArgs
    );
    this.fillDispatch(
      command.gpu_encoder,
      this.countsBuffer,
      this.scanDispatchArgs,
      MATERIAL_SORT_TILE_SIZE,
      "Bp/og-dispatch"
    );
    this.dispatchPrefixScan(command.gpu_encoder, this.scanDispatchArgs);
    this.dispatchScatter(
      command.gpu_encoder,
      input,
      sceneDatabase,
      this.inputDispatchArgs
    );
    this.dispatchCommands(command.gpu_encoder, materialCount);

    return {
      meshlets: this.sortedBuffer,
      commands: this.commandsBuffer,
      material_count: materialCount
    };
  }

  private dispatchCounts(
    encoder: GPUCommandEncoder,
    input: GPUBuffer,
    sceneDatabase: GPUBuffer,
    args: GPUBuffer
  ): void {
    const pipeline = this.obtainCountPipeline();
    const group0 = this.graphics.bind_groups.obtain({
      layout: MATERIAL_COUNT_GROUPS[0]!,
      entries: [
        { buffer: input },
        { buffer: this.countsBuffer! },
        { buffer: this.contextBuffer! }
      ]
    });
    const group1 = this.graphics.bind_groups.obtain({
      layout: MATERIAL_COUNT_GROUPS[1]!,
      entries: [{ buffer: sceneDatabase }]
    });
    const pass = encoder.beginComputePass({ label: "MaterialMeshletDrawList/Bp-dp-counts" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group0);
    pass.setBindGroup(1, group1);
    pass.dispatchWorkgroupsIndirect(args, 0);
    pass.end();
  }

  private dispatchPrefixScan(
    encoder: GPUCommandEncoder,
    args: GPUBuffer
  ): void {
    const pipeline = this.obtainScanPipeline();
    const group = this.graphics.bind_groups.obtain({
      layout: MATERIAL_SCAN_GROUPS[0]!,
      entries: [{ buffer: this.countsBuffer! }, { buffer: this.spineBuffer! }]
    });
    const pass = encoder.beginComputePass({ label: "MaterialMeshletDrawList/Bp-og-prefix" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroupsIndirect(args, 0);
    pass.end();
  }

  private dispatchScatter(
    encoder: GPUCommandEncoder,
    input: GPUBuffer,
    sceneDatabase: GPUBuffer,
    args: GPUBuffer
  ): void {
    const pipeline = this.obtainScatterPipeline();
    const group = this.graphics.bind_groups.obtain({
      layout: MATERIAL_SCATTER_GROUPS[0]!,
      entries: [
        { buffer: input },
        { buffer: this.countsBuffer! },
        { buffer: sceneDatabase },
        { buffer: this.contextBuffer! },
        { buffer: this.countersBuffer! },
        { buffer: this.sortedBuffer! }
      ]
    });
    const pass = encoder.beginComputePass({ label: "MaterialMeshletDrawList/Bp-yp-scatter" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroupsIndirect(args, 0);
    pass.end();
  }

  private dispatchCommands(encoder: GPUCommandEncoder, materialCount: number): void {
    const pipeline = this.obtainCommandPipeline();
    const group = this.graphics.bind_groups.obtain({
      layout: MATERIAL_COMMAND_GROUPS[0]!,
      entries: [{ buffer: this.countsBuffer! }, { buffer: this.commandsBuffer! }]
    });
    const pass = encoder.beginComputePass({ label: "MaterialMeshletDrawList/Bp-hp-commands" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(
      Math.ceil(materialCount / MATERIAL_SORT_WORKGROUP_SIZE)
    );
    pass.end();
  }

  private fillDispatch(
    encoder: GPUCommandEncoder,
    input: GPUBuffer,
    args: GPUBuffer,
    elementsPerWorkgroup: number,
    label: string
  ): void {
    const pipeline = obtainFillDispatchPipeline(
      this.device,
      elementsPerWorkgroup,
      this.graphics
    );
    const group = this.graphics.bind_groups.obtain({
      layout: FILL_ARGS_GROUP,
      entries: [{ buffer: input, offset: 0, size: 4 }, { buffer: args }]
    });
    const pass = encoder.beginComputePass({ label });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  private ensureBuffers(
    contextBytes: number,
    materialCapacity: number,
    meshletCapacity: number
  ): void {
    const countBytes = alignUp(
      MATERIAL_LIST_HEADER_BYTES + Math.max(4, materialCapacity) * 4,
      1024
    );
    const counterBytes = alignUp(Math.max(1, materialCapacity) * 4, 1024);
    const spineBytes = alignUp(
      Math.max(1, Math.ceil(materialCapacity / MATERIAL_SORT_TILE_SIZE)) * 8,
      1024
    );
    const sortedBytes = Math.max(
      MESHLET_ELEMENT_BYTES,
      meshletCapacity * MESHLET_ELEMENT_BYTES
    );
    const commandBytes = Math.max(
      MATERIAL_SORT_DRAW_ARGS_BYTES,
      materialCapacity * MATERIAL_SORT_DRAW_ARGS_BYTES
    );
    this.contextBuffer = this.ensureBuffer(this.contextBuffer, contextBytes, "Bp/material-lookup", GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.countsBuffer = this.ensureBuffer(this.countsBuffer, countBytes, "Bp/material-counts-prefix", GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.countersBuffer = this.ensureBuffer(this.countersBuffer, counterBytes, "Bp/material-counters", GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.spineBuffer = this.ensureBuffer(this.spineBuffer, spineBytes, "Bp/og-spine", GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.sortedBuffer = this.ensureBuffer(this.sortedBuffer, sortedBytes, "Bp/sorted-meshlets", GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.commandsBuffer = this.ensureBuffer(this.commandsBuffer, commandBytes, "Bp/draw-commands", GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
    this.inputDispatchArgs = this.ensureBuffer(this.inputDispatchArgs, DISPATCH_ARGS_BYTES, "Bp/input-dispatch-args", GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT);
    this.scanDispatchArgs = this.ensureBuffer(this.scanDispatchArgs, DISPATCH_ARGS_BYTES, "Bp/scan-dispatch-args", GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT);
  }

  private ensureBuffer(
    current: GPUBuffer | null,
    required: number,
    label: string,
    usage: GPUBufferUsageFlags
  ): GPUBuffer {
    const size = Math.max(4, alignUp(required, 4));
    if (current !== null && current.size >= size) return current;
    current?.destroy();
    return this.device.createBuffer({ label, size, usage });
  }

  private obtainCountPipeline(): GPUComputePipeline {
    if (this.countPipeline) return this.countPipeline;
    return (this.countPipeline = this.graphics.compute_pipelines.obtain(
      materialPipeline("Bp/dp-count", MATERIAL_SORT_COUNT_WGSL, MATERIAL_COUNT_GROUPS)
    ));
  }

  private obtainScanPipeline(): GPUComputePipeline {
    if (this.scanPipeline) return this.scanPipeline;
    return (this.scanPipeline = this.graphics.compute_pipelines.obtain(
      materialPipeline("Bp/og-prefix", MATERIAL_SORT_PREFIX_SCAN_WGSL, MATERIAL_SCAN_GROUPS)
    ));
  }

  private obtainScatterPipeline(): GPUComputePipeline {
    if (this.scatterPipeline) return this.scatterPipeline;
    return (this.scatterPipeline = this.graphics.compute_pipelines.obtain(
      materialPipeline("Bp/yp-scatter", MATERIAL_SORT_SCATTER_WGSL, MATERIAL_SCATTER_GROUPS)
    ));
  }

  private obtainCommandPipeline(): GPUComputePipeline {
    if (this.commandPipeline) return this.commandPipeline;
    return (this.commandPipeline = this.graphics.compute_pipelines.obtain(
      materialPipeline("Bp/hp-command", MATERIAL_SORT_COMMANDS_WGSL, MATERIAL_COMMAND_GROUPS)
    ));
  }

  destroy(): void {
    this.contextBuffer?.destroy();
    this.countsBuffer?.destroy();
    this.countersBuffer?.destroy();
    this.spineBuffer?.destroy();
    this.sortedBuffer?.destroy();
    this.commandsBuffer?.destroy();
    this.inputDispatchArgs?.destroy();
    this.scanDispatchArgs?.destroy();
  }
}

const MATERIAL_COUNT_GROUPS = [
  computeBufferGroup(["read-only-storage", "storage", "read-only-storage"]),
  computeBufferGroup(["read-only-storage"])
] as const;
const MATERIAL_SCAN_GROUPS = [computeBufferGroup(["storage", "storage"])] as const;
const MATERIAL_SCATTER_GROUPS = [computeBufferGroup([
  "read-only-storage",
  "read-only-storage",
  "read-only-storage",
  "read-only-storage",
  "storage",
  "storage"
])] as const;
const MATERIAL_COMMAND_GROUPS = [
  computeBufferGroup(["read-only-storage", "storage"])
] as const;

function computeBufferGroup(
  types: readonly GPUBufferBindingType[]
): GPUBindGroupLayoutDescriptor {
  return {
    label: "",
    entries: types.map((type, binding) => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type }
    }))
  };
}

function materialPipeline(
  label: string,
  code: string,
  bindGroupLayouts: readonly GPUBindGroupLayoutDescriptor[]
): CachedComputePipelineDescriptor {
  return {
    label,
    layout: { label: `${label}-layout`, bindGroupLayouts },
    compute: { module: { label: `${label}-module`, code }, entryPoint: "main" }
  };
}

export function buildMaterialLookup(
  materials: readonly Pick<ShadeMaterial, "id">[]
): Uint32Array {
  const count = materials.length;
  const capacity = nextPowerOfTwo(Math.max(1, 1.3 * count));
  const table = new Uint32Array(2 * capacity + 2);
  table[0] = count;
  table[1] = capacity;
  const mask = capacity - 1;
  for (let materialIndex = 0; materialIndex < count; materialIndex++) {
    const key = materials[materialIndex]!.id >>> 0;
    let slot = hashU32(key) & mask;
    const storedKey = (key + 1) >>> 0;
    while (table[2 + slot * 2] !== 0) {
      const offset = 2 + slot * 2;
      if (table[offset] === storedKey) {
        table[offset + 1] = materialIndex;
        slot = -1;
        break;
      }
      slot = ((slot << 2) + slot + 1) & mask;
    }
    if (slot >= 0) {
      table[2 + slot * 2] = storedKey;
      table[2 + slot * 2 + 1] = materialIndex;
    }
  }
  return table;
}

function hashU32(value: number): number {
  let result = value >>> 0;
  result ^= result >>> 16;
  result = Math.imul(result, 569420461);
  result ^= result >>> 15;
  result = Math.imul(result, 3545902487);
  result ^= result >>> 15;
  return result >>> 0;
}

function nextPowerOfTwo(value: number): number {
  let result = Math.ceil(value) - 1;
  result |= result >> 1;
  result |= result >> 2;
  result |= result >> 4;
  result |= result >> 8;
  result |= result >> 16;
  return (result + 1) >>> 0;
}

function materialLookupByteLength(materialCapacity: number): number {
  return (2 * nextPowerOfTwo(Math.max(1, 1.3 * materialCapacity)) + 2) * 4;
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
