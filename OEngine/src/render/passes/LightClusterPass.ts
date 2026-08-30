/**
 * 灯光分簇阶段：按屏幕和深度区域组织光源，减少像素着色时需要遍历的灯光数量。
 */

import type { PerspectiveCamera } from "../../camera/PerspectiveCamera.js";
import { mat4Invert } from "../../core/math/Mat4.js";
import type {
  FrameGraph,
  FrameGraphContext
} from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  counterByteOffset,
  GPU_QUEUE_OVERFLOW_BITS
} from "../../debug/GpuFrameCounters.js";
import type { GPULightCollection } from "../../gpu/LightDatabase.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedComputePipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { createNativeTextureView } from "../../gpu/GPUTextureDescriptors.js";
import { writeGpuBuffer } from "../../gpu/GpuQueueEvidence.js";
import {
  assertLightListCapacity,
  LIGHT_LIST_HEADER_BYTES
} from "../ClusteredLightingReference.js";
import {
  LIGHT_CLUSTER_ASSIGN_WGSL,
  LIGHT_CLUSTER_ASSIGN_WORKGROUP,
  LIGHT_CLUSTER_DATA_HEADER_BYTES,
  LIGHT_CLUSTER_DEPTH_SLICES,
  LIGHT_CLUSTER_HZB_FILTER_WGSL,
  LIGHT_CLUSTER_LIST_BYTES,
  LIGHT_CLUSTER_LIST_CAPACITY,
  LIGHT_CLUSTER_METADATA_BYTES,
  LIGHT_CLUSTER_POINT_LIST_WGSL,
  LIGHT_CLUSTER_SETTINGS_BYTES,
  LIGHT_CLUSTER_SPOT_LIST_WGSL,
  LIGHT_CLUSTER_TILE_SIZE
} from "../../shaders/light_cluster.js";

export type LightClusterOutputs = {
  parameters: ResourceId;
  lookup: ResourceId;
  data: ResourceId;
  /** GPU frustum-list producer before the HZB filter. */
  candidateLightList: ResourceId;
  /** GPU-produced count/list consumed by cluster assignment. */
  activeLightList: ResourceId;
  counters: ResourceId | null;
};

export type LightClusterJob = {
  camera: PerspectiveCamera;
  lights: GPULightCollection;
  width: number;
  height: number;
};

const LIGHT_CLUSTER_LIST_GROUPS: readonly GPUBindGroupLayoutDescriptor[] = [
  {
    label: "",
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform" }
    }]
  },
  {
    label: "",
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "read-only-storage" }
    }]
  },
  {
    label: "",
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "storage" }
    }]
  }
];

const LIGHT_CLUSTER_HZB_GROUPS: readonly GPUBindGroupLayoutDescriptor[] = [
  {
    label: "",
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "read-only-storage" }
    }]
  },
  {
    label: "",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "unfilterable-float", viewDimension: "2d" }
      }
    ]
  },
  {
    label: "",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" }
      }
    ]
  }
];

const LIGHT_CLUSTER_ASSIGN_GROUPS: readonly GPUBindGroupLayoutDescriptor[] = [
  {
    label: "",
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
    ]
  },
  {
    label: "",
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "read-only-storage" }
    }]
  },
  {
    label: "",
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ]
  }
];

const LIGHT_CLUSTER_STATS_GROUPS: readonly GPUBindGroupLayoutDescriptor[] = [{
  label: "LightCluster/FX-02 stats",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
  ]
}];

const LIGHT_CLUSTER_STATS_WGSL = /* wgsl */ `
struct LightList { attempted: u32, written: u32, capacity: u32, overflow: u32, data: array<u32>, }
struct ClusterMetadata { offset: u32, point_count: u32, spot_count: u32, flags: u32, }
struct ClusterData { attempted: u32, written: u32, capacity: u32, overflow: u32, data: array<u32>, }

@group(0) @binding(0) var<storage, read> candidate: LightList;
@group(0) @binding(1) var<storage, read> active_list: LightList;
@group(0) @binding(2) var<storage, read> lookup: array<ClusterMetadata>;
@group(0) @binding(3) var<storage, read> cluster_data: ClusterData;
@group(0) @binding(4) var<storage, read_write> counters: array<atomic<u32>>;

fn add_counter(index: u32, value: u32) { atomicAdd(&counters[index], value); }

fn histogram_counter(count: u32) -> u32 {
  if (count == 0u) { return ${counterByteOffset("clusterHistogram0") / 4}u; }
  if (count == 1u) { return ${counterByteOffset("clusterHistogram1") / 4}u; }
  if (count <= 4u) { return ${counterByteOffset("clusterHistogram4") / 4}u; }
  if (count <= 8u) { return ${counterByteOffset("clusterHistogram8") / 4}u; }
  if (count <= 16u) { return ${counterByteOffset("clusterHistogram16") / 4}u; }
  if (count <= 32u) { return ${counterByteOffset("clusterHistogram32") / 4}u; }
  if (count <= 64u) { return ${counterByteOffset("clusterHistogram64") / 4}u; }
  if (count <= 128u) { return ${counterByteOffset("clusterHistogram128") / 4}u; }
  return ${counterByteOffset("clusterHistogram256") / 4}u;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let cluster_index = global_id.x;
  if (cluster_index == 0u) {
    add_counter(${counterByteOffset("candidateLightsAttempted") / 4}u, candidate.attempted);
    add_counter(${counterByteOffset("candidateLightsWritten") / 4}u, candidate.written);
    add_counter(${counterByteOffset("activeLightsAttempted") / 4}u, active_list.attempted);
    add_counter(${counterByteOffset("activeLights") / 4}u, active_list.written);
    add_counter(${counterByteOffset("clusterLightIndicesAttempted") / 4}u, cluster_data.attempted);
    add_counter(${counterByteOffset("clusterLightIndicesWritten") / 4}u, cluster_data.written);
    if (candidate.overflow != 0u || active_list.overflow != 0u || cluster_data.overflow != 0u) {
      atomicOr(&counters[${counterByteOffset("queueOverflowMask") / 4}u], ${GPU_QUEUE_OVERFLOW_BITS.lightList}u);
    }
  }
  if (cluster_index >= arrayLength(&lookup)) { return; }
  let metadata = lookup[cluster_index];
  let fallback = (metadata.flags & 8u) != 0u;
  let clustered_count = metadata.point_count + metadata.spot_count;
  let evaluated_count = select(clustered_count, active_list.written, fallback);
  add_counter(${counterByteOffset("clusterTestedLights") / 4}u, active_list.written);
  add_counter(${counterByteOffset("clusterLightReferences") / 4}u, evaluated_count);
  atomicMax(&counters[${counterByteOffset("clusterMaxLights") / 4}u], evaluated_count);
  add_counter(histogram_counter(evaluated_count), 1u);
  if (metadata.flags != 0u) {
    add_counter(${counterByteOffset("clusterOverflowClusters") / 4}u, 1u);
    atomicOr(&counters[${counterByteOffset("queueOverflowMask") / 4}u], ${GPU_QUEUE_OVERFLOW_BITS.lightList}u);
  }
  if (fallback) {
    add_counter(${counterByteOffset("clusterFallbackLights") / 4}u, active_list.written);
  }
}
`;

export class LightClusterPass {
  private readonly pointListPipeline: GPUComputePipeline;
  private readonly spotListPipeline: GPUComputePipeline;
  private readonly hzbFilterPipeline: GPUComputePipeline;
  private readonly assignPipeline: GPUComputePipeline;
  private readonly statsPipeline: GPUComputePipeline;
  private readonly settingsData = new ArrayBuffer(LIGHT_CLUSTER_SETTINGS_BYTES);
  private readonly inverseView = new Float32Array(16);

  lastClusterCount = 0;
  lastLocalLightCount = 0;

  private readonly device: GPUDevice;

  constructor(private readonly graphics: GraphicsContext) {
    const device = graphics.device;
    if (device === null) {
      throw new Error("LightClusterPass: GraphicsContext has no device");
    }
    this.device = device;
    this.pointListPipeline = this.createPipeline(
      LIGHT_CLUSTER_POINT_LIST_WGSL,
      LIGHT_CLUSTER_LIST_GROUPS
    );
    this.spotListPipeline = this.createPipeline(
      LIGHT_CLUSTER_SPOT_LIST_WGSL,
      LIGHT_CLUSTER_LIST_GROUPS
    );
    this.hzbFilterPipeline = this.createPipeline(
      LIGHT_CLUSTER_HZB_FILTER_WGSL,
      LIGHT_CLUSTER_HZB_GROUPS
    );
    this.assignPipeline = this.createPipeline(
      LIGHT_CLUSTER_ASSIGN_WGSL,
      LIGHT_CLUSTER_ASSIGN_GROUPS
    );
    this.statsPipeline = this.createPipeline(
      LIGHT_CLUSTER_STATS_WGSL,
      LIGHT_CLUSTER_STATS_GROUPS
    );
  }

  addToGraph(
    graph: FrameGraph,
    job: LightClusterJob,
    inputs: {
      camera: ResourceId;
      lightDatabase: ResourceId;
      hzb: ResourceId;
      counters?: ResourceId;
    }
  ): LightClusterOutputs {
    const localLightCount =
      job.lights.pointLights.count + job.lights.spotLights.count;
    assertLightListCapacity(localLightCount, LIGHT_CLUSTER_LIST_CAPACITY);
    const width = Math.max(1, job.width | 0);
    const height = Math.max(1, job.height | 0);
    const clusterWidth = Math.ceil(width / LIGHT_CLUSTER_TILE_SIZE);
    const clusterHeight = Math.ceil(height / LIGHT_CLUSTER_TILE_SIZE);
    const clusterCount =
      LIGHT_CLUSTER_DEPTH_SLICES * clusterWidth * clusterHeight;
    const lookupBytes = LIGHT_CLUSTER_METADATA_BYTES * clusterCount;
    const dataBytes =
      LIGHT_CLUSTER_DATA_HEADER_BYTES +
      4 * lightClusterDataCapacity(clusterCount);
    this.lastClusterCount = clusterCount;

    let visibleList = -1;
    let parameters = -1;
    const listBuilder = graph.add(
      "LightCluster/qz+Nz visible list",
      job,
      (passJob, resources, context) => {
        const encoder = requireGpuEncoder(context);
        const camera = requireGpuBuffer(resources.get(inputs.camera));
        const database = requireGpuBuffer(resources.get(inputs.lightDatabase));
        const output = requireGpuBuffer(resources.get(visibleList));
        const settings = requireGpuBuffer(resources.get(parameters));
        encoder.clearBuffer(output, 0, 16);
        this.packSettings(passJob.camera, width, height);
        writeBuffer(context, this.device, settings, this.settingsData);
        this.dispatchPagedList(
          encoder,
          this.pointListPipeline,
          camera,
          database,
          output,
          passJob.lights.pointLights.dispatch_page_count *
            passJob.lights.pointLights.descriptor.elements_per_page,
          true
        );
        this.dispatchPagedList(
          encoder,
          this.spotListPipeline,
          camera,
          database,
          output,
          passJob.lights.spotLights.dispatch_page_count *
            passJob.lights.spotLights.descriptor.elements_per_page
        );
      }
    );
    visibleList = listBuilder.create("LightCluster/list", {
      kind: "transient_buffer",
      label: "LightCluster/list",
      size: LIGHT_CLUSTER_LIST_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    parameters = listBuilder.create("LightCluster/parameters", {
      kind: "transient_buffer",
      label: "LightCluster/parameters",
      size: LIGHT_CLUSTER_SETTINGS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    listBuilder.read(inputs.camera);
    listBuilder.read(inputs.lightDatabase);

    let filteredList = -1;
    const filterBuilder = graph.add(
      "LightCluster/nE HZB filter",
      job,
      (passJob, resources, context) => {
        const encoder = requireGpuEncoder(context);
        const input = requireGpuBuffer(resources.get(visibleList));
        const output = requireGpuBuffer(resources.get(filteredList));
        encoder.clearBuffer(output, 0, 16);
        const activeLocalLightCount =
          passJob.lights.pointLights.count + passJob.lights.spotLights.count;
        this.lastLocalLightCount = activeLocalLightCount;
        const pipeline = this.hzbFilterPipeline;
        const database = requireGpuBuffer(resources.get(inputs.lightDatabase));
        const camera = requireGpuBuffer(resources.get(inputs.camera));
        const hzb = requireTextureView(resources.get(inputs.hzb));
        const group0 = this.graphics.bind_groups.obtain({
          layout: LIGHT_CLUSTER_HZB_GROUPS[0]!,
          entries: [{ buffer: database }]
        });
        const group1 = this.graphics.bind_groups.obtain({
          layout: LIGHT_CLUSTER_HZB_GROUPS[1]!,
          entries: [
            { buffer: camera },
            hzb
          ]
        });
        const group2 = this.graphics.bind_groups.obtain({
          layout: LIGHT_CLUSTER_HZB_GROUPS[2]!,
          entries: [
            { buffer: input },
            { buffer: output }
          ]
        });
        const pass = encoder.beginComputePass({ label: "LightCluster/nE" });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group0);
        pass.setBindGroup(1, group1);
        pass.setBindGroup(2, group2);
        pass.dispatchWorkgroups(
          Math.max(1, Math.ceil(activeLocalLightCount / 256))
        );
        pass.end();
      }
    );
    filterBuilder.read(visibleList);
    filterBuilder.read(inputs.camera);
    filterBuilder.read(inputs.lightDatabase);
    filterBuilder.read(inputs.hzb);
    filteredList = filterBuilder.create("LightCluster/filtered", {
      kind: "transient_buffer",
      label: "LightCluster/filtered",
      size: LIGHT_CLUSTER_LIST_BYTES,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC
    });

    let lookup = -1;
    let data = -1;
    const assignBuilder = graph.add(
      "LightCluster/yh assign",
      job,
      (_passJob, resources, context) => {
        const encoder = requireGpuEncoder(context);
        const pipeline = this.assignPipeline;
        const camera = requireGpuBuffer(resources.get(inputs.camera));
        const database = requireGpuBuffer(resources.get(inputs.lightDatabase));
        const input = requireGpuBuffer(resources.get(filteredList));
        const settings = requireGpuBuffer(resources.get(parameters));
        const lookupBuffer = requireGpuBuffer(resources.get(lookup));
        const dataBuffer = requireGpuBuffer(resources.get(data));
        encoder.clearBuffer(dataBuffer, 0, 16);
        const group0 = this.graphics.bind_groups.obtain({
          layout: LIGHT_CLUSTER_ASSIGN_GROUPS[0]!,
          entries: [
            { buffer: camera },
            { buffer: input },
            { buffer: settings }
          ]
        });
        const group1 = this.graphics.bind_groups.obtain({
          layout: LIGHT_CLUSTER_ASSIGN_GROUPS[1]!,
          entries: [{ buffer: database }]
        });
        const group2 = this.graphics.bind_groups.obtain({
          layout: LIGHT_CLUSTER_ASSIGN_GROUPS[2]!,
          entries: [
            { buffer: lookupBuffer },
            { buffer: dataBuffer }
          ]
        });
        const pass = encoder.beginComputePass({ label: "LightCluster/yh" });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group0);
        pass.setBindGroup(1, group1);
        pass.setBindGroup(2, group2);
        pass.dispatchWorkgroups(
          Math.ceil(clusterWidth / LIGHT_CLUSTER_ASSIGN_WORKGROUP),
          Math.ceil(clusterHeight / LIGHT_CLUSTER_ASSIGN_WORKGROUP),
          Math.ceil(
            LIGHT_CLUSTER_DEPTH_SLICES / LIGHT_CLUSTER_ASSIGN_WORKGROUP
          )
        );
        pass.end();
      }
    );
    assignBuilder.read(filteredList);
    assignBuilder.read(inputs.camera);
    assignBuilder.read(inputs.lightDatabase);
    assignBuilder.read(parameters);
    lookup = assignBuilder.create("LightCluster/lookup", {
      kind: "transient_buffer",
      label: "LightCluster/lookup",
      size: lookupBytes,
      usage: GPUBufferUsage.STORAGE
    });
    data = assignBuilder.create("LightCluster/data", {
      kind: "transient_buffer",
      label: "LightCluster/data",
      size: dataBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    let counters: ResourceId | null = null;
    if (inputs.counters !== undefined) {
      const statsBuilder = graph.add(
        "LightCluster/FX-02 stats",
        null,
        (_statsJob, resources, context) => {
          const encoder = requireGpuEncoder(context);
          const group = this.graphics.bind_groups.obtain({
            layout: LIGHT_CLUSTER_STATS_GROUPS[0]!,
            entries: [
              { buffer: requireGpuBuffer(resources.get(visibleList)) },
              { buffer: requireGpuBuffer(resources.get(filteredList)) },
              { buffer: requireGpuBuffer(resources.get(lookup)) },
              { buffer: requireGpuBuffer(resources.get(data)) },
              { buffer: requireGpuBuffer(resources.get(inputs.counters!)) }
            ]
          });
          const pass = encoder.beginComputePass({
            label: "LightCluster/FX-02 stats"
          });
          pass.setPipeline(this.statsPipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(Math.max(1, Math.ceil(clusterCount / 256)));
          pass.end();
        }
      );
      statsBuilder.read(visibleList);
      statsBuilder.read(filteredList);
      statsBuilder.read(lookup);
      statsBuilder.read(data);
      counters = statsBuilder.write(inputs.counters);
      statsBuilder.make_side_effect();
    }

    return {
      parameters,
      lookup,
      data,
      candidateLightList: visibleList,
      activeLightList: filteredList,
      counters
    };
  }

  private dispatchPagedList(
    encoder: GPUCommandEncoder,
    pipeline: GPUComputePipeline,
    camera: GPUBuffer,
    database: GPUBuffer,
    output: GPUBuffer,
    elementSlots: number,
    initializeEmpty = false
  ): void {
    if (elementSlots <= 0 && !initializeEmpty) return;
    const group0 = this.graphics.bind_groups.obtain({
      layout: LIGHT_CLUSTER_LIST_GROUPS[0]!,
      entries: [{ buffer: camera }]
    });
    const group1 = this.graphics.bind_groups.obtain({
      layout: LIGHT_CLUSTER_LIST_GROUPS[1]!,
      entries: [{ buffer: database }]
    });
    const group2 = this.graphics.bind_groups.obtain({
      layout: LIGHT_CLUSTER_LIST_GROUPS[2]!,
      entries: [{ buffer: output }]
    });
    const pass = encoder.beginComputePass({ label: "LightCluster/list" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group0);
    pass.setBindGroup(1, group1);
    pass.setBindGroup(2, group2);
    pass.dispatchWorkgroups(Math.max(1, Math.ceil(elementSlots / 128)));
    pass.end();
  }

  private packSettings(
    camera: PerspectiveCamera,
    width: number,
    height: number
  ): void {
    camera.update();
    const f32 = new Float32Array(this.settingsData);
    const u32 = new Uint32Array(this.settingsData);
    f32.fill(0);
    const offsetNear = camera.near + 0.2;
    const zScale = 4.06;
    const blend =
      (camera.far -
        offsetNear *
          Math.pow(2, (LIGHT_CLUSTER_DEPTH_SLICES - 1) / zScale)) /
      (camera.far - offsetNear);
    f32[0] = (1 - blend) / offsetNear;
    f32[1] = blend;
    f32[2] = zScale;
    u32[4] = width >>> 0;
    u32[5] = height >>> 0;
    f32[6] = camera.near;
    f32[7] = camera.far;
    f32.set(camera.frustum, 8);

    if (!mat4Invert(this.inverseView, camera.view_matrix)) {
      throw new Error("LightClusterPass: singular camera view matrix");
    }
    const inverse = this.inverseView;
    const sx = -inverse[8]!;
    const sy = -inverse[9]!;
    const sz = -inverse[10]!;
    const nx = -sx;
    const ny = -sy;
    const nz = -sz;
    const d = -(
      nx * (inverse[12]! + sx * camera.far) +
      ny * (inverse[13]! + sy * camera.far) +
      nz * (inverse[14]! + sz * camera.far)
    );
    f32[28] = nx;
    f32[29] = ny;
    f32[30] = nz;
    f32[31] = d;
  }

  private createPipeline(
    code: string,
    bindGroupLayouts: readonly GPUBindGroupLayoutDescriptor[]
  ): GPUComputePipeline {
    const descriptor: CachedComputePipelineDescriptor = {
      label: "",
      layout: { label: "", bindGroupLayouts },
      compute: {
        module: { label: "", code },
        entryPoint: "main"
      }
    };
    return this.graphics.compute_pipelines.obtain(descriptor);
  }
}

export function lightClusterDataCapacity(clusterCount: number): number {
  const expensiveClusters = Math.ceil(clusterCount * 0.5);
  return Math.ceil(
    Math.max(
      Math.max(0, clusterCount - expensiveClusters) +
        128 * expensiveClusters,
      128 * clusterCount * 0.5,
      1
    )
  );
}

export function lightClusterListCapacity(): number {
  return (LIGHT_CLUSTER_LIST_BYTES - LIGHT_LIST_HEADER_BYTES) / 4;
}

function requireGpuEncoder(context: FrameGraphContext): GPUCommandEncoder {
  if (!context.gpu_encoder) {
    throw new Error("LightClusterPass: no GPU command encoder");
  }
  return context.gpu_encoder;
}

function requireGpuBuffer(value: unknown): GPUBuffer {
  if (!value || typeof value !== "object" || !("size" in value)) {
    throw new Error("LightClusterPass: expected GPUBuffer");
  }
  return value as GPUBuffer;
}

function requireTextureView(value: unknown): GPUTextureView {
  if (value && typeof value === "object" && "createView" in value) {
    return createNativeTextureView(value as GPUTexture);
  }
  if (value && typeof value === "object") {
    return value as GPUTextureView;
  }
  throw new Error("LightClusterPass: expected GPUTexture/GPUTextureView");
}

function writeBuffer(
  context: FrameGraphContext,
  device: GPUDevice,
  buffer: GPUBuffer,
  data: ArrayBuffer
): void {
  const command = context.encoder as ShadeGPUCommandContext | undefined;
  if (command && typeof command.writeBuffer === "function") {
    command.writeBuffer(buffer, 0, data, 0, data.byteLength);
  } else {
    writeGpuBuffer(device.queue, "LightCluster/settings", buffer, 0, data);
  }
}
