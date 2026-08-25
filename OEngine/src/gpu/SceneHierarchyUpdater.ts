/**
 * SceneHierarchyUpdater：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import { FrameGraph } from "../framegraph/FrameGraph.js";
import type { ResourceId } from "../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { CachedComputePipelineDescriptor } from "./GPUDescriptorCaches.js";
import { SCENE_DATABASE_READ_WRITE_WGSL } from "./SceneDatabase.js";

export const SCENE_HIERARCHY_WORKGROUP_SIZE = 256;

export const SCENE_HIERARCHY_NODE_TO_TILE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> input: array<u32>;
@group(0) @binding(1) var<storage, read_write> node_to_tile: array<u32>;

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(global_invocation_id) invocation_id: vec3<u32>) {
    let element_index = invocation_id.x;
    let count = input[0];
    if element_index >= count {
        return;
    }
    let node_index = input[4u + element_index];
    node_to_tile[node_index] = element_index + 1u;
}
`;

export const SCENE_HIERARCHY_UPDATE_WGSL = /* wgsl */ `
${SCENE_DATABASE_READ_WRITE_WGSL}

const SCENE_NODE: u32 = 0u;
const NOT_IN_INPUT: u32 = 0u;
const FLAG_NOT_READY: u32 = 0u;
const FLAG_INCLUSIVE: u32 = 1u;
const MAX_PARENT_WALK: u32 = 256u;
const MAX_SPIN_COUNT: u32 = 4u;
const PARTITION_SIZE: u32 = 256u;
const MAT4_STRIDE: u32 = 16u;

@group(0) @binding(0) var<storage, read> input: array<u32>;
@group(0) @binding(1) var<storage, read_write> scene_database: array<u32>;
@group(0) @binding(2) var<storage, read> node_to_tile: array<u32>;
@group(0) @binding(3) var<storage, read_write> spine: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> published_globals: array<atomic<u32>>;

fn mat4_compose_transform(
    translation: vec3<f32>,
    rotation: vec4<f32>,
    scale: vec3<f32>
) -> mat4x4<f32> {
    let x = rotation.x;
    let y = rotation.y;
    let z = rotation.z;
    let w = rotation.w;
    let x2 = x + x;
    let y2 = y + y;
    let z2 = z + z;
    let xx = x * x2;
    let xy = x * y2;
    let xz = x * z2;
    let yy = y * y2;
    let yz = y * z2;
    let zz = z * z2;
    let wx = w * x2;
    let wy = w * y2;
    let wz = w * z2;
    return mat4x4<f32>(
        vec4<f32>((1.0 - (yy + zz)) * scale.x, (xy + wz) * scale.x, (xz - wy) * scale.x, 0.0),
        vec4<f32>((xy - wz) * scale.y, (1.0 - (xx + zz)) * scale.y, (yz + wx) * scale.y, 0.0),
        vec4<f32>((xz + wy) * scale.z, (yz - wx) * scale.z, (1.0 - (xx + yy)) * scale.z, 0.0),
        vec4<f32>(translation, 1.0),
    );
}

fn publish_global(index: u32, value: mat4x4<f32>) {
    let base = index * MAT4_STRIDE;
    atomicStore(&published_globals[base + 0u], bitcast<u32>(value[0].x));
    atomicStore(&published_globals[base + 1u], bitcast<u32>(value[0].y));
    atomicStore(&published_globals[base + 2u], bitcast<u32>(value[0].z));
    atomicStore(&published_globals[base + 3u], bitcast<u32>(value[0].w));
    atomicStore(&published_globals[base + 4u], bitcast<u32>(value[1].x));
    atomicStore(&published_globals[base + 5u], bitcast<u32>(value[1].y));
    atomicStore(&published_globals[base + 6u], bitcast<u32>(value[1].z));
    atomicStore(&published_globals[base + 7u], bitcast<u32>(value[1].w));
    atomicStore(&published_globals[base + 8u], bitcast<u32>(value[2].x));
    atomicStore(&published_globals[base + 9u], bitcast<u32>(value[2].y));
    atomicStore(&published_globals[base + 10u], bitcast<u32>(value[2].z));
    atomicStore(&published_globals[base + 11u], bitcast<u32>(value[2].w));
    atomicStore(&published_globals[base + 12u], bitcast<u32>(value[3].x));
    atomicStore(&published_globals[base + 13u], bitcast<u32>(value[3].y));
    atomicStore(&published_globals[base + 14u], bitcast<u32>(value[3].z));
    atomicStore(&published_globals[base + 15u], bitcast<u32>(value[3].w));
}

fn read_published_global(index: u32) -> mat4x4<f32> {
    let base = index * MAT4_STRIDE;
    return mat4x4<f32>(
        vec4<f32>(
            bitcast<f32>(atomicLoad(&published_globals[base + 0u])),
            bitcast<f32>(atomicLoad(&published_globals[base + 1u])),
            bitcast<f32>(atomicLoad(&published_globals[base + 2u])),
            bitcast<f32>(atomicLoad(&published_globals[base + 3u])),
        ),
        vec4<f32>(
            bitcast<f32>(atomicLoad(&published_globals[base + 4u])),
            bitcast<f32>(atomicLoad(&published_globals[base + 5u])),
            bitcast<f32>(atomicLoad(&published_globals[base + 6u])),
            bitcast<f32>(atomicLoad(&published_globals[base + 7u])),
        ),
        vec4<f32>(
            bitcast<f32>(atomicLoad(&published_globals[base + 8u])),
            bitcast<f32>(atomicLoad(&published_globals[base + 9u])),
            bitcast<f32>(atomicLoad(&published_globals[base + 10u])),
            bitcast<f32>(atomicLoad(&published_globals[base + 11u])),
        ),
        vec4<f32>(
            bitcast<f32>(atomicLoad(&published_globals[base + 12u])),
            bitcast<f32>(atomicLoad(&published_globals[base + 13u])),
            bitcast<f32>(atomicLoad(&published_globals[base + 14u])),
            bitcast<f32>(atomicLoad(&published_globals[base + 15u])),
        ),
    );
}

@compute @workgroup_size(256, 1, 1)
fn main(
    @builtin(global_invocation_id) invocation_id: vec3<u32>,
    @builtin(local_invocation_id) local_invocation_id: vec3<u32>,
    @builtin(workgroup_id) workgroup_id: vec3<u32>,
) {
    let element_index = invocation_id.x;
    let partition_index = workgroup_id.x;
    let in_range = element_index < input[0];

    if in_range {
        let node_index = input[4u + element_index];
        var node = scene_read_node_rw(&scene_database, node_index);
        scene_write_node_prev_global(&scene_database, node_index, node.global);

        var global = mat4_compose_transform(node.local_translation, node.local_rotation, node.local_scale);
        var parent = node.parent;
        var walk_count = 0u;
        loop {
            if parent == SCENE_NODE { break; }
            if walk_count >= MAX_PARENT_WALK { break; }
            walk_count = walk_count + 1u;

            let tile_plus_one = node_to_tile[parent];
            if tile_plus_one == NOT_IN_INPUT {
                let parent_node = scene_read_node_rw(&scene_database, parent);
                global = parent_node.global * global;
                break;
            }

            let parent_element = tile_plus_one - 1u;
            let parent_partition = parent_element / PARTITION_SIZE;
            if parent_partition < partition_index {
                var spin_count = 0u;
                var ready = false;
                loop {
                    if atomicLoad(&spine[parent_partition]) == FLAG_INCLUSIVE {
                        ready = true;
                        break;
                    }
                    spin_count = spin_count + 1u;
                    if spin_count >= MAX_SPIN_COUNT { break; }
                }
                if ready {
                    global = read_published_global(parent_element) * global;
                    break;
                }
            }

            let parent_node = scene_read_node_rw(&scene_database, parent);
            let parent_local = mat4_compose_transform(
                parent_node.local_translation,
                parent_node.local_rotation,
                parent_node.local_scale
            );
            global = parent_local * global;
            parent = parent_node.parent;
        }

        publish_global(element_index, global);
        scene_write_node_global(&scene_database, node_index, global);
    }

    workgroupBarrier();
    if local_invocation_id.x == 0u {
        atomicStore(&spine[partition_index], FLAG_INCLUSIVE);
    }
}
`;

function alignCeil(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function createHierarchyPipelineDescriptor(
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

function requireCommandContext(value: unknown): ShadeGPUCommandContext {
  if (
    typeof value !== "object" ||
    value === null ||
    !("isGPUCommandContext" in value) ||
    value.isGPUCommandContext !== true
  ) {
    throw new Error("SceneHierarchyUpdater: FrameGraph has no ShadeGPUCommandContext");
  }
  return value as ShadeGPUCommandContext;
}

function requireBuffer(value: unknown, label: string): GPUBuffer {
  if (typeof value !== "object" || value === null || !("size" in value)) {
    throw new Error(`SceneHierarchyUpdater: missing ${label} buffer`);
  }
  return value as GPUBuffer;
}

export class SceneHierarchyUpdater {
  private readonly label: string;
  private readonly setupDispatchPipeline: CachedComputePipelineDescriptor;
  private readonly nodeToTilePipeline: CachedComputePipelineDescriptor;
  private readonly hierarchyPipeline: CachedComputePipelineDescriptor;
  private warnedDispatchLimit = false;

  constructor(device: GPUDevice, label = "SceneHierarchyUpdater") {
    this.label = label;
    const limit = device.limits.maxComputeWorkgroupsPerDimension;
    this.setupDispatchPipeline = createHierarchyPipelineDescriptor(
      `${label}/dispatch-setup`,
      `
@group(0) @binding(0) var<storage, read> input: array<u32>;
@group(0) @binding(1) var<storage, read_write> command: array<u32>;
@compute @workgroup_size(1, 1, 1)
fn main() {
    let desired_x = (input[0] + 255u) / 256u;
    command[0] = min(${limit}u, desired_x);
    command[1] = 1u;
    command[2] = 1u;
}
`,
      ["read-only-storage", "storage"],
    );
    this.nodeToTilePipeline = createHierarchyPipelineDescriptor(
      `${label}/node-to-tile`,
      SCENE_HIERARCHY_NODE_TO_TILE_WGSL,
      ["read-only-storage", "storage"],
    );
    this.hierarchyPipeline = createHierarchyPipelineDescriptor(
      `${label}/hierarchy-update`,
      SCENE_HIERARCHY_UPDATE_WGSL,
      [
        "read-only-storage",
        "storage",
        "read-only-storage",
        "storage",
        "storage",
      ],
    );
  }

  addToGraph(
    graph: FrameGraph,
    sceneDatabase: ResourceId,
    nodeCount: number,
  ): ResourceId {
    if (nodeCount === 0) return sceneDatabase;

    const inputSize = alignCeil(16 + nodeCount * 4, 16);
    const nodeToTileSize = alignCeil(Math.max(nodeCount, 1) * 4, 1024);
    const tileCount = Math.max(
      1,
      Math.ceil(nodeCount / SCENE_HIERARCHY_WORKGROUP_SIZE),
    );
    const spineSize = alignCeil(tileCount * 4, 1024);
    const publishedGlobalsSize = alignCeil(16 * nodeCount * 4, 1024);

    const listData = { buffer: -1 as ResourceId, nodeCount };
    const listPass = graph.add(
      "validate_hit_to_specular",
      listData,
      (data, resources, context) => {
        const command = requireCommandContext(context.encoder);
        const input = requireBuffer(resources.get(data.buffer), "node id list");
        const words = new Uint32Array(4 + data.nodeCount);
        words[0] = data.nodeCount;
        for (let i = 0; i < data.nodeCount; i++) words[4 + i] = i;
        command.writeBuffer(
          input,
          0,
          words.buffer,
          words.byteOffset,
          words.byteLength
        );
      },
    );
    listData.buffer = listPass.create("node id list", {
      kind: "transient_buffer",
      label: `${this.label}/node-id-list`,
      size: inputSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const mappingData = {
      input: listData.buffer,
      command: -1 as ResourceId,
      nodeToTile: -1 as ResourceId,
      tileCount,
    };
    const mappingPass = graph.add(
      "invoke_vi",
      mappingData,
      (data, resources, context) => {
        const command = requireCommandContext(context.encoder);
        if (
          data.tileCount > command.device.limits.maxComputeWorkgroupsPerDimension &&
          !this.warnedDispatchLimit
        ) {
          this.warnedDispatchLimit = true;
          console.warn(
            `scene-graph hierarchy: tile_count(${data.tileCount}) > MAX_DISPATCH(${command.device.limits.maxComputeWorkgroupsPerDimension}); update will be incomplete`,
          );
        }
        const input = requireBuffer(resources.get(data.input), "node id list");
        const indirect = requireBuffer(resources.get(data.command), "setup command");
        const nodeToTile = requireBuffer(
          resources.get(data.nodeToTile),
          "node-to-tile",
        );
        this.encodeDispatchSetup(command, input, indirect);
        this.encodeNodeToTile(command, input, nodeToTile, indirect);
      },
    );
    mappingData.input = mappingPass.read(mappingData.input);
    mappingData.command = mappingPass.create("setup-command", {
      kind: "transient_buffer",
      label: `${this.label}/setup-command`,
      size: 12,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
    });
    mappingData.nodeToTile = mappingPass.create("node_to_tile", {
      kind: "transient_buffer",
      label: `${this.label}/node-to-tile`,
      size: nodeToTileSize,
      usage: GPUBufferUsage.STORAGE,
      ensure_cleared: [0, nodeToTileSize],
    });

    const hierarchyData = {
      input: mappingData.input,
      nodeToTile: mappingData.nodeToTile,
      command: -1 as ResourceId,
      spine: -1 as ResourceId,
      publishedGlobals: -1 as ResourceId,
      sceneDatabase,
    };
    const hierarchyPass = graph.add(
      "light_importance_by_index",
      hierarchyData,
      (data, resources, context) => {
        const command = requireCommandContext(context.encoder);
        const input = requireBuffer(resources.get(data.input), "node id list");
        const indirect = requireBuffer(resources.get(data.command), "update command");
        this.encodeDispatchSetup(command, input, indirect);
        this.encodeHierarchy(
          command,
          input,
          requireBuffer(resources.get(data.sceneDatabase), "scene database"),
          requireBuffer(resources.get(data.nodeToTile), "node-to-tile"),
          requireBuffer(resources.get(data.spine), "spine"),
          requireBuffer(resources.get(data.publishedGlobals), "published globals"),
          indirect,
        );
      },
    );
    hierarchyData.input = hierarchyPass.read(mappingData.input);
    hierarchyData.nodeToTile = hierarchyPass.read(mappingData.nodeToTile);
    hierarchyData.command = hierarchyPass.create("update-command", {
      kind: "transient_buffer",
      label: `${this.label}/update-command`,
      size: 12,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
    });
    hierarchyData.spine = hierarchyPass.create("spine", {
      kind: "transient_buffer",
      label: `${this.label}/spine`,
      size: spineSize,
      usage: GPUBufferUsage.STORAGE,
      ensure_cleared: [0, spineSize],
    });
    hierarchyData.publishedGlobals = hierarchyPass.create("published_globals", {
      kind: "transient_buffer",
      label: `${this.label}/published-globals`,
      size: publishedGlobalsSize,
      usage: GPUBufferUsage.STORAGE,
    });
    hierarchyPass.read(sceneDatabase);
    hierarchyData.sceneDatabase = hierarchyPass.write(sceneDatabase);
    return hierarchyData.sceneDatabase;
  }

  destroy(): void {}

  private encodeDispatchSetup(
    command: ShadeGPUCommandContext,
    input: GPUBuffer,
    output: GPUBuffer
  ): void {
    const pass = command.constructComputePass({
      label: `${this.label}/dispatch-setup`,
      pipeline: this.setupDispatchPipeline,
      bindings: [[{ buffer: input }, { buffer: output }]],
    });
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  private encodeNodeToTile(
    command: ShadeGPUCommandContext,
    input: GPUBuffer,
    nodeToTile: GPUBuffer,
    indirect: GPUBuffer,
  ): void {
    const pass = command.constructComputePass({
      label: `${this.label}/node-to-tile`,
      pipeline: this.nodeToTilePipeline,
      bindings: [[{ buffer: input }, { buffer: nodeToTile }]],
    });
    pass.dispatchWorkgroupsIndirect(indirect, 0);
    pass.end();
  }

  private encodeHierarchy(
    command: ShadeGPUCommandContext,
    input: GPUBuffer,
    sceneDatabase: GPUBuffer,
    nodeToTile: GPUBuffer,
    spine: GPUBuffer,
    publishedGlobals: GPUBuffer,
    indirect: GPUBuffer,
  ): void {
    const pass = command.constructComputePass({
      label: `${this.label}/hierarchy-update`,
      pipeline: this.hierarchyPipeline,
      bindings: [[
        { buffer: input },
        { buffer: sceneDatabase },
        { buffer: nodeToTile },
        { buffer: spine },
        { buffer: publishedGlobals },
      ]],
    });
    pass.dispatchWorkgroupsIndirect(indirect, 0);
    pass.end();
  }
}
