import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_FRAME_INSTANCE_WGSL } from "../gpu/GpuFrameInstanceAbi.js";
import { PACKED_CAMERA_TYPE } from "./packed_camera.js";

export const FRAME_INSTANCE_SETTINGS_SIZE = 16;
export const FRAME_INSTANCE_WORKGROUP_SIZE = 64;

/** Dense instance markers are bounded by published scene capacity. Selection
 * never spins: atomicExchange elects one appender, dispatch boundaries publish
 * work and records. All selected meshlets reuse the one instance record. */
export function frameInstanceTransformsWgsl(observe: boolean): string {
  return /* wgsl */ `
${PACKED_CAMERA_TYPE.wgsl_declaration}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
struct FrameInstanceSettings { instance_capacity: u32, work_capacity: u32, max_workgroups: u32, reserved: u32, }
struct FrameInstanceControl { count: atomic<u32>, invalid: atomic<u32>, dispatch_x: u32, dispatch_y: u32, }
@group(0) @binding(0) var<uniform> frame_camera: CommandEncoder;
@group(0) @binding(1) var<uniform> frame_settings: FrameInstanceSettings;
@group(0) @binding(2) var<storage, read> frame_source: array<OEngineInstanceRecord>;
@group(0) @binding(3) var<storage, read> frame_meshlets: OEngineMeshletWorkQueueRead;
@group(0) @binding(4) var<storage, read_write> frame_markers: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> frame_work: array<u32>;
@group(0) @binding(6) var<storage, read_write> frame_records: array<OEngineFrameInstanceRecord>;
@group(0) @binding(7) var<storage, read_write> frame_control: FrameInstanceControl;
@group(1) @binding(0) var<storage, read_write> frame_indirect: vec4u;
@compute @workgroup_size(1)
fn frame_instance_begin() {
  let count = select(min(frame_meshlets.header.written_count, min(frame_meshlets.header.capacity,
    min(frame_settings.work_capacity, arrayLength(&frame_meshlets.elements)))), 0u, frame_meshlets.header.generation == 0u);
  let groups = (count + ${FRAME_INSTANCE_WORKGROUP_SIZE - 1}u) / ${FRAME_INSTANCE_WORKGROUP_SIZE}u;
  let x = min(groups, frame_settings.max_workgroups);
  let y = select((groups + max(x, 1u) - 1u) / max(x, 1u), 1u, groups == 0u);
  frame_indirect = vec4u(x, y, 1u, 0u);
}
@compute @workgroup_size(${FRAME_INSTANCE_WORKGROUP_SIZE})
fn frame_instance_select(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) grid: vec3u) {
  let at = id.y * grid.x * ${FRAME_INSTANCE_WORKGROUP_SIZE}u + id.x;
  let count = min(frame_meshlets.header.written_count, min(frame_meshlets.header.capacity, min(frame_settings.work_capacity, arrayLength(&frame_meshlets.elements))));
  if at >= count || frame_meshlets.header.generation == 0u { return; }
  let instance = frame_meshlets.elements[at].instance_slot;
  if instance >= frame_settings.instance_capacity || instance >= arrayLength(&frame_source) {
    ${observe ? "atomicAdd(&frame_control.invalid, 1u);" : ""}
    return;
  }
  if atomicExchange(&frame_markers[instance], 1u) != 0u { return; }
  // At most instance_capacity distinct slots; no speculative over-capacity write.
  let slot = atomicAdd(&frame_control.count, 1u);
  frame_work[slot] = instance;
}
@compute @workgroup_size(1)
fn frame_instance_finalize() {
  let groups = (atomicLoad(&frame_control.count) + ${FRAME_INSTANCE_WORKGROUP_SIZE - 1}u) / ${FRAME_INSTANCE_WORKGROUP_SIZE}u;
  let x = min(groups, frame_settings.max_workgroups);
  let y = select((groups + max(x, 1u) - 1u) / max(x, 1u), 1u, groups == 0u);
  frame_control.dispatch_x = x; frame_control.dispatch_y = y;
  frame_indirect = vec4u(x, y, 1u, 0u);
}
@compute @workgroup_size(${FRAME_INSTANCE_WORKGROUP_SIZE})
fn frame_instance_build(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let at = (group.y * frame_control.dispatch_x + group.x) * ${FRAME_INSTANCE_WORKGROUP_SIZE}u + lane;
  if at >= atomicLoad(&frame_control.count) { return; }
  let slot = frame_work[at]; let source = frame_source[slot];
  let model = oengine_instance_current_object_to_world(source);
  let x = cross(model[1].xyz, model[2].xyz); let y = cross(model[2].xyz, model[0].xyz); let z = cross(model[0].xyz, model[1].xyz);
  let determinant = dot(model[0].xyz, x);
  frame_records[slot] = OEngineFrameInstanceRecord(source, frame_camera.view_projection_matrix * model,
    vec4f(x, determinant), y, frame_meshlets.header.generation, vec4f(z, 0.0));
}
`;
}
