/**
 * AnimationDatabase：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type {
  AnimationCurve,
  AnimationKeyframe,
} from "../animation/AnimationCurve.js";
import { AnimationClipFlags } from "../animation/AnimationClipFlags.js";
import type { ShadeAnimationClip } from "../animation/ShadeAnimationClip.js";
import type { Skin } from "../animation/Skin.js";
import {
  ArrayType,
  CodeChunk,
  WGSL_f32,
  WGSL_mat4x4f,
  WGSL_u32,
  WGSL_vec4u,
} from "../core/WebGPUTypes.js";
import { StructType } from "../core/WgslStruct.js";
import { FrameGraph } from "../framegraph/FrameGraph.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { Node3D } from "../scene/Node3D.js";
import {
  GPUDatabase,
  GPUDatabaseDefinition,
  type GPUTypedTable,
} from "./GPUDatabase.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { CachedComputePipelineDescriptor } from "./GPUDescriptorCaches.js";
import {
  SCENE_DATABASE_READ_CHUNK,
  SCENE_DATABASE_READ_WRITE_CHUNK,
  SCENE_TRANSFORM_DESCRIPTOR,
  type SceneDatabase,
} from "./SceneDatabase.js";
import {
  MATERIAL_META_TYPE,
  type MaterialMetadataTable,
} from "./MaterialMetadataTable.js";
import { SceneHierarchyUpdater } from "./SceneHierarchyUpdater.js";

export const ANIMATION_INVALID_INDEX = 0xffffffff;
export const ANIMATION_BLOCK_CAPACITY = 8;
export const ANIMATION_TICK_MAX_DT = 1 / 15;
export const POSE_ACCUMULATOR_STRIDE_BYTES = 64;
export const SKIN_MATRIX_STRIDE_BYTES = 64;

export type AnimationBindingRecord = {
  track: number;
  instance: number;
  property: number;
};

export type AnimationBoundTrackGroupRecord = {
  bindings: AnimationBindingRecord[];
  count: number;
  next: number;
  clip: number;
};

export type AnimationClipRecord = {
  time: number;
  time_start: number;
  time_end: number;
  bound_track_group_head: number;
  playback_rate: number;
  flags: number;
  playback_weight: number;
};

export type AnimationCurveRecord = {
  kind: number;
  keyframe_block_head: number;
  keyframe_count: number;
  time_min: number;
  time_max: number;
};

export type AnimationKeyframeRecord = {
  time: number;
  value: number;
  inTangent: number;
  outTangent: number;
};

export type AnimationKeyframeBlockRecord = {
  keyframes: AnimationKeyframeRecord[];
  count: number;
  next: number;
};

export type AnimationTrackRecord = {
  mask: number;
  curves: ArrayLike<number>;
};

export type AnimationSkinRecord = {
  joint_block_head: number;
  joint_count: number;
};

export type AnimationSkinJointRecord = {
  node: number;
  inverse_bind: ArrayLike<number>;
};

export type AnimationSkinJointBlockRecord = {
  joints: AnimationSkinJointRecord[];
  count: number;
  next: number;
  skin_matrix_offset: number;
};

export const ANIMATION_BINDING_TYPE = StructType.from(
  {
    track: WGSL_u32,
    instance: WGSL_u32,
    property: WGSL_u32,
  },
  "VsmCoarseBoundsPass",
);

export const ANIMATION_BOUND_TRACK_GROUP_TYPE = StructType.from(
  {
    bindings: ArrayType.from(ANIMATION_BINDING_TYPE, ANIMATION_BLOCK_CAPACITY),
    count: WGSL_u32,
    next: WGSL_u32,
    clip: WGSL_u32,
  },
  "GpuBindlessTextureBinding",
);

export const ANIMATION_CLIP_TYPE = StructType.from(
  {
    time: WGSL_f32,
    time_start: WGSL_f32,
    time_end: WGSL_f32,
    bound_track_group_head: WGSL_u32,
    playback_rate: WGSL_f32,
    flags: WGSL_u32,
    playback_weight: WGSL_f32,
  },
  "DynamicResolutionScaling",
);

export const ANIMATION_CURVE_TYPE = StructType.from({
  kind: WGSL_u32,
  keyframe_block_head: WGSL_u32,
  keyframe_count: WGSL_u32,
  time_min: WGSL_f32,
  time_max: WGSL_f32,
});

export const ANIMATION_KEYFRAME_TYPE = StructType.from({
  time: WGSL_f32,
  value: WGSL_f32,
  inTangent: WGSL_f32,
  outTangent: WGSL_f32,
});

export const ANIMATION_KEYFRAME_BLOCK_TYPE = StructType.from(
  {
    keyframes: ArrayType.from(
      ANIMATION_KEYFRAME_TYPE,
      ANIMATION_BLOCK_CAPACITY,
    ),
    count: WGSL_u32,
    next: WGSL_u32,
  },
  "ShadeImageSerializationAdapter",
);

export const ANIMATION_SKIN_JOINT_TYPE = StructType.from(
  {
    node: WGSL_u32,
    inverse_bind: WGSL_mat4x4f,
  },
  "InstanceBatchAllocationRecord",
).pack();

export const ANIMATION_SKIN_JOINT_BLOCK_TYPE = StructType.from(
  {
    joints: ArrayType.from(ANIMATION_SKIN_JOINT_TYPE, ANIMATION_BLOCK_CAPACITY),
    count: WGSL_u32,
    next: WGSL_u32,
    skin_matrix_offset: WGSL_u32,
  },
  "ViewShadowMaps",
).pack();

export const ANIMATION_SKIN_TYPE = StructType.from({
  joint_block_head: WGSL_u32,
  joint_count: WGSL_u32,
});

export const ANIMATION_TRACK_TYPE = StructType.from({
  mask: WGSL_u32,
  curves: WGSL_vec4u,
});

export const ANIMATION_DATABASE_DEFINITION = GPUDatabaseDefinition.from({
  animation_curves: ANIMATION_CURVE_TYPE,
  animation_keyframe_blocks: ANIMATION_KEYFRAME_BLOCK_TYPE,
  animation_tracks: ANIMATION_TRACK_TYPE,
  animation_clips: ANIMATION_CLIP_TYPE,
  animation_bound_track_groups: ANIMATION_BOUND_TRACK_GROUP_TYPE,
  animation_skins: ANIMATION_SKIN_TYPE,
  animation_skin_joint_blocks: ANIMATION_SKIN_JOINT_BLOCK_TYPE,
});

export const ANIMATION_CURVE_DESCRIPTOR =
  ANIMATION_DATABASE_DEFINITION.get("animation_curves")!;
export const ANIMATION_KEYFRAME_BLOCK_DESCRIPTOR =
  ANIMATION_DATABASE_DEFINITION.get("animation_keyframe_blocks")!;
export const ANIMATION_TRACK_DESCRIPTOR =
  ANIMATION_DATABASE_DEFINITION.get("animation_tracks")!;
export const ANIMATION_CLIP_DESCRIPTOR =
  ANIMATION_DATABASE_DEFINITION.get("animation_clips")!;
export const ANIMATION_BOUND_TRACK_GROUP_DESCRIPTOR =
  ANIMATION_DATABASE_DEFINITION.get("animation_bound_track_groups")!;
export const ANIMATION_SKIN_DESCRIPTOR =
  ANIMATION_DATABASE_DEFINITION.get("animation_skins")!;
export const ANIMATION_SKIN_JOINT_BLOCK_DESCRIPTOR =
  ANIMATION_DATABASE_DEFINITION.get("animation_skin_joint_blocks")!;

const animationEvaluationChunk = CodeChunk.from(
  `
fn animation_inverse_lerp(a: f32, b: f32, value: f32) -> f32 {
    let span = b - a;
    return select((value - a) / span, 0.0, span == 0.0);
}

fn animation_curve_evaluate_piece(
    t: f32,
    previous: ${ANIMATION_KEYFRAME_TYPE.wgsl_ref},
    next: ${ANIMATION_KEYFRAME_TYPE.wgsl_ref}
) -> f32 {
    let duration = next.time - previous.time;
    let previous_tangent = previous.outTangent * duration;
    let next_tangent = next.inTangent * duration;
    let t2 = t * t;
    let t3 = t2 * t;
    let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
    let h10 = t3 - 2.0 * t2 + t;
    let h11 = t3 - t2;
    let h01 = 3.0 * t2 - 2.0 * t3;
    return h00 * previous.value + h10 * previous_tangent + h11 * next_tangent + h01 * next.value;
}

fn animation_curve_evaluate(
    time: f32,
    database: ptr<storage, array<u32>>,
    curve: ${ANIMATION_CURVE_TYPE.wgsl_ref}
) -> f32 {
    let time_clamped = clamp(time, curve.time_min, curve.time_max);
    if (curve.keyframe_count <= 1u) {
        let head = ${ANIMATION_KEYFRAME_BLOCK_DESCRIPTOR.marshalling_method_read}(database, curve.keyframe_block_head);
        return head.keyframes[0].value;
    }

    var result = 0.0;
    var found = false;
    var previous: ${ANIMATION_KEYFRAME_TYPE.wgsl_ref};
    var has_previous = false;
    var block_index = curve.keyframe_block_head;
    loop {
        if (found || block_index == 0xFFFFFFFFu) {
            break;
        }
        let block = ${ANIMATION_KEYFRAME_BLOCK_DESCRIPTOR.marshalling_method_read}(database, block_index);
        for (var i = 0u; i < block.count; i++) {
            let key = block.keyframes[i];
            if (key.time >= time_clamped) {
                if (!has_previous || key.time == previous.time) {
                    result = key.value;
                } else {
                    let t = animation_inverse_lerp(previous.time, key.time, time_clamped);
                    result = animation_curve_evaluate_piece(t, previous, key);
                }
                found = true;
                break;
            }
            previous = key;
            has_previous = true;
        }
        block_index = block.next;
    }
    if (!found && has_previous) {
        result = previous.value;
    }
    return result;
}

fn animation_track_evaluate(
    time: f32,
    track: ${ANIMATION_TRACK_TYPE.wgsl_ref},
    database: ptr<storage, array<u32>>
) -> vec4f {
    var result = vec4f(0.0);
    for (var i = 0u; i < 4u; i++) {
        if ((track.mask & (1u << i)) == 0u) {
            continue;
        }
        let curve = ${ANIMATION_CURVE_DESCRIPTOR.marshalling_method_read}(database, track.curves[i]);
        result[i] = animation_curve_evaluate(time, database, curve);
    }
    return result;
}
`,
  [
    ANIMATION_KEYFRAME_BLOCK_DESCRIPTOR.chunk_read,
    ANIMATION_CURVE_DESCRIPTOR.chunk_read,
    ANIMATION_KEYFRAME_TYPE.declaration_chunk,
    ANIMATION_CURVE_TYPE.declaration_chunk,
    ANIMATION_TRACK_TYPE.declaration_chunk,
  ],
);

export const ANIMATION_DATABASE_READ_CHUNK = CodeChunk.from("", [
  ANIMATION_CURVE_DESCRIPTOR.chunk_read,
  ANIMATION_KEYFRAME_BLOCK_DESCRIPTOR.chunk_read,
  ANIMATION_TRACK_DESCRIPTOR.chunk_read,
  ANIMATION_CLIP_DESCRIPTOR.chunk_read,
  ANIMATION_BOUND_TRACK_GROUP_DESCRIPTOR.chunk_read,
  ANIMATION_SKIN_DESCRIPTOR.chunk_read,
  ANIMATION_SKIN_JOINT_BLOCK_DESCRIPTOR.chunk_read,
  animationEvaluationChunk,
]);
export const ANIMATION_DATABASE_READ_WGSL =
  ANIMATION_DATABASE_READ_CHUNK.compile().text;

const poseAccumulatorChunk = CodeChunk.from(`
const POSE_ACCUMULATOR_STRIDE: u32 = 16u;
const POSE_OFFSET_TRANSLATION: u32 = 0u;
const POSE_OFFSET_ROTATION: u32 = 3u;
const POSE_OFFSET_SCALE: u32 = 7u;
const POSE_OFFSET_DIRTY: u32 = 10u;

const POSE_DIRTY_TX: u32 = 1u;
const POSE_DIRTY_TY: u32 = 2u;
const POSE_DIRTY_TZ: u32 = 4u;
const POSE_DIRTY_R: u32 = 8u;
const POSE_DIRTY_SX: u32 = 16u;
const POSE_DIRTY_SY: u32 = 32u;
const POSE_DIRTY_SZ: u32 = 64u;
const POSE_DIRTY_T_MASK: u32 = POSE_DIRTY_TX | POSE_DIRTY_TY | POSE_DIRTY_TZ;
const POSE_DIRTY_S_MASK: u32 = POSE_DIRTY_SX | POSE_DIRTY_SY | POSE_DIRTY_SZ;

fn pose_accumulator_slot_base(index: u32) -> u32 {
    return index * POSE_ACCUMULATOR_STRIDE;
}

fn pose_accumulator_atomic_add_f32(index: u32, value: f32) {
    loop {
        let old_bits = atomicLoad(&pose_accumulator[index]);
        let new_bits = bitcast<u32>(bitcast<f32>(old_bits) + value);
        let result = atomicCompareExchangeWeak(&pose_accumulator[index], old_bits, new_bits);
        if result.exchanged { break; }
    }
}

fn pose_accumulator_add_translation(index: u32, value: vec3<f32>, mask: u32) {
    let base = pose_accumulator_slot_base(index) + POSE_OFFSET_TRANSLATION;
    var dirty = 0u;
    if (mask & 0x1u) != 0u {
        pose_accumulator_atomic_add_f32(base + 0u, value.x);
        dirty |= POSE_DIRTY_TX;
    }
    if (mask & 0x2u) != 0u {
        pose_accumulator_atomic_add_f32(base + 1u, value.y);
        dirty |= POSE_DIRTY_TY;
    }
    if (mask & 0x4u) != 0u {
        pose_accumulator_atomic_add_f32(base + 2u, value.z);
        dirty |= POSE_DIRTY_TZ;
    }
    if dirty != 0u {
        atomicOr(&pose_accumulator[pose_accumulator_slot_base(index) + POSE_OFFSET_DIRTY], dirty);
    }
}

fn pose_accumulator_add_rotation(index: u32, value: vec4<f32>) {
    let base = pose_accumulator_slot_base(index) + POSE_OFFSET_ROTATION;
    pose_accumulator_atomic_add_f32(base + 0u, value.x);
    pose_accumulator_atomic_add_f32(base + 1u, value.y);
    pose_accumulator_atomic_add_f32(base + 2u, value.z);
    pose_accumulator_atomic_add_f32(base + 3u, value.w);
    atomicOr(&pose_accumulator[pose_accumulator_slot_base(index) + POSE_OFFSET_DIRTY], POSE_DIRTY_R);
}

fn pose_accumulator_add_scale(index: u32, value: vec3<f32>, mask: u32) {
    let base = pose_accumulator_slot_base(index) + POSE_OFFSET_SCALE;
    var dirty = 0u;
    if (mask & 0x1u) != 0u {
        pose_accumulator_atomic_add_f32(base + 0u, value.x);
        dirty |= POSE_DIRTY_SX;
    }
    if (mask & 0x2u) != 0u {
        pose_accumulator_atomic_add_f32(base + 1u, value.y);
        dirty |= POSE_DIRTY_SY;
    }
    if (mask & 0x4u) != 0u {
        pose_accumulator_atomic_add_f32(base + 2u, value.z);
        dirty |= POSE_DIRTY_SZ;
    }
    if dirty != 0u {
        atomicOr(&pose_accumulator[pose_accumulator_slot_base(index) + POSE_OFFSET_DIRTY], dirty);
    }
}
`);

const animationObjectPropertyChunk = CodeChunk.from(
  `
fn write_object_property_material(instance: u32, property: u32, mask: u32, value: vec4f) {
    let index = instance & 0x00FFFFFFu;
    switch property {
        case 0u: {
            if (mask & 0x1u) != 0u { materials[index].albedo_color.x = value.x; }
            if (mask & 0x2u) != 0u { materials[index].albedo_color.y = value.y; }
            if (mask & 0x4u) != 0u { materials[index].albedo_color.z = value.z; }
            if (mask & 0x8u) != 0u { materials[index].albedo_color.w = value.w; }
        }
        default: {}
    }
}

fn write_object_property_node3d(instance: u32, property: u32, mask: u32, value: vec4f) {
    let index = instance & 0x00FFFFFFu;
    switch property {
        case 0u: { pose_accumulator_add_translation(index, value.xyz, mask); }
        case 1u: { pose_accumulator_add_rotation(index, value); }
        case 2u: { pose_accumulator_add_scale(index, value.xyz, mask); }
        default: {}
    }
}

fn write_object_property(instance: u32, property: u32, mask: u32, value: vec4f) {
    let object_type = instance >> 24u;
    switch object_type {
        case 0u: { write_object_property_node3d(instance, property, mask, value); }
        case 1u: { write_object_property_material(instance, property, mask, value); }
        default: {}
    }
}
`,
  [poseAccumulatorChunk, MATERIAL_META_TYPE.declaration_chunk],
);

const boundTrackIteratorPrefix =
  ANIMATION_BOUND_TRACK_GROUP_DESCRIPTOR.page_iterator_symbol_prefix(64);

export const ANIMATION_BOUND_TRACK_EVALUATE_CHUNK = CodeChunk.from(
  `
@group(0) @binding(0) var<storage, read> animation_database: array<u32>;
@group(0) @binding(1) var<storage, read_write> pose_accumulator: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> materials: array<${MATERIAL_META_TYPE.wgsl_ref}>;

@compute @workgroup_size(64, 1, 1)
fn main(
    @builtin(workgroup_id) workgroup_id: vec3<u32>,
    @builtin(local_invocation_index) local_id: u32,
) {
    if !${boundTrackIteratorPrefix}_setup(&animation_database, workgroup_id.x, local_id) {
        return;
    }
    let slot_in_page = ${boundTrackIteratorPrefix}_slot_in_page(local_id);
    if slot_in_page >= ${boundTrackIteratorPrefix}_ELEMENTS_PER_PAGE {
        return;
    }
    if !${boundTrackIteratorPrefix}_is_occupied(slot_in_page) {
        return;
    }

    let group = ${boundTrackIteratorPrefix}_read(&animation_database, slot_in_page);
    let clip = ${ANIMATION_CLIP_DESCRIPTOR.marshalling_method_read}(&animation_database, group.clip);
    let effective_time = clip.time + clip.time_start;
    let weight = clip.playback_weight;

    for (var i = 0u; i < group.count; i++) {
        let binding = group.bindings[i];
        let track = ${ANIMATION_TRACK_DESCRIPTOR.marshalling_method_read}(&animation_database, binding.track);
        let value = animation_track_evaluate(effective_time, track, &animation_database) * weight;
        write_object_property(binding.instance, binding.property, track.mask, value);
    }
}
`,
  [
    ANIMATION_BOUND_TRACK_GROUP_DESCRIPTOR.chunk_iterate(64),
    ANIMATION_CLIP_DESCRIPTOR.chunk_read,
    ANIMATION_TRACK_DESCRIPTOR.chunk_read,
    animationEvaluationChunk,
    animationObjectPropertyChunk,
  ],
);

const transformIteratorPrefix =
  SCENE_TRANSFORM_DESCRIPTOR.page_iterator_symbol_prefix(64, true);

export const ANIMATION_POSE_FLUSH_CHUNK = CodeChunk.from(
  `
@group(0) @binding(0) var<storage, read_write> scene_database: array<u32>;
@group(0) @binding(1) var<storage, read_write> pose_accumulator: array<atomic<u32>>;

@compute @workgroup_size(64, 1, 1)
fn main(
    @builtin(workgroup_id) workgroup_id: vec3<u32>,
    @builtin(local_invocation_index) local_id: u32,
) {
    if !${transformIteratorPrefix}_setup(&scene_database, workgroup_id.x, local_id) {
        return;
    }
    let slot_in_page = ${transformIteratorPrefix}_slot_in_page(local_id);
    if slot_in_page >= ${transformIteratorPrefix}_ELEMENTS_PER_PAGE {
        return;
    }
    if !${transformIteratorPrefix}_is_occupied(slot_in_page) {
        return;
    }

    let node_index = ${transformIteratorPrefix}_slot_to_index(slot_in_page);
    let base = pose_accumulator_slot_base(node_index);
    let dirty_index = base + POSE_OFFSET_DIRTY;
    let dirty = atomicLoad(&pose_accumulator[dirty_index]);
    if dirty == 0u { return; }

    if (dirty & POSE_DIRTY_T_MASK) != 0u {
        let value_base = base + POSE_OFFSET_TRANSLATION;
        var value = scene_read_node_rw(&scene_database, node_index).local_translation;
        if (dirty & POSE_DIRTY_TX) != 0u {
            value.x = bitcast<f32>(atomicLoad(&pose_accumulator[value_base + 0u]));
            atomicStore(&pose_accumulator[value_base + 0u], 0u);
        }
        if (dirty & POSE_DIRTY_TY) != 0u {
            value.y = bitcast<f32>(atomicLoad(&pose_accumulator[value_base + 1u]));
            atomicStore(&pose_accumulator[value_base + 1u], 0u);
        }
        if (dirty & POSE_DIRTY_TZ) != 0u {
            value.z = bitcast<f32>(atomicLoad(&pose_accumulator[value_base + 2u]));
            atomicStore(&pose_accumulator[value_base + 2u], 0u);
        }
        scene_write_node_local_translation(&scene_database, node_index, value);
    }

    if (dirty & POSE_DIRTY_R) != 0u {
        let value_base = base + POSE_OFFSET_ROTATION;
        let value = vec4<f32>(
            bitcast<f32>(atomicLoad(&pose_accumulator[value_base + 0u])),
            bitcast<f32>(atomicLoad(&pose_accumulator[value_base + 1u])),
            bitcast<f32>(atomicLoad(&pose_accumulator[value_base + 2u])),
            bitcast<f32>(atomicLoad(&pose_accumulator[value_base + 3u])),
        );
        atomicStore(&pose_accumulator[value_base + 0u], 0u);
        atomicStore(&pose_accumulator[value_base + 1u], 0u);
        atomicStore(&pose_accumulator[value_base + 2u], 0u);
        atomicStore(&pose_accumulator[value_base + 3u], 0u);
        scene_write_node_local_rotation(&scene_database, node_index, normalize(value));
    }

    if (dirty & POSE_DIRTY_S_MASK) != 0u {
        let value_base = base + POSE_OFFSET_SCALE;
        var value = scene_read_node_rw(&scene_database, node_index).local_scale;
        if (dirty & POSE_DIRTY_SX) != 0u {
            value.x = bitcast<f32>(atomicLoad(&pose_accumulator[value_base + 0u]));
            atomicStore(&pose_accumulator[value_base + 0u], 0u);
        }
        if (dirty & POSE_DIRTY_SY) != 0u {
            value.y = bitcast<f32>(atomicLoad(&pose_accumulator[value_base + 1u]));
            atomicStore(&pose_accumulator[value_base + 1u], 0u);
        }
        if (dirty & POSE_DIRTY_SZ) != 0u {
            value.z = bitcast<f32>(atomicLoad(&pose_accumulator[value_base + 2u]));
            atomicStore(&pose_accumulator[value_base + 2u], 0u);
        }
        scene_write_node_local_scale(&scene_database, node_index, value);
    }
    atomicStore(&pose_accumulator[dirty_index], 0u);
}
`,
  [
    SCENE_TRANSFORM_DESCRIPTOR.chunk_iterate(64, true),
    SCENE_DATABASE_READ_WRITE_CHUNK,
    poseAccumulatorChunk,
  ],
);

const clipIteratorPrefix =
  ANIMATION_CLIP_DESCRIPTOR.page_iterator_symbol_prefix(64, true);

export const ANIMATION_CLIP_ADVANCE_CHUNK = CodeChunk.from(
  `
struct AnimationTickUniform { dt: f32, }
@group(0) @binding(0) var<uniform> tick: AnimationTickUniform;
@group(0) @binding(1) var<storage, read_write> animation_database: array<u32>;

const FLAG_PLAYING: u32 = ${AnimationClipFlags.Playing}u;
const FLAG_LOOP: u32 = ${AnimationClipFlags.Loop}u;

@compute @workgroup_size(64, 1, 1)
fn main(
    @builtin(workgroup_id) workgroup_id: vec3<u32>,
    @builtin(local_invocation_index) local_id: u32,
) {
    if !${clipIteratorPrefix}_setup(&animation_database, workgroup_id.x, local_id) {
        return;
    }
    let slot_in_page = ${clipIteratorPrefix}_slot_in_page(local_id);
    if slot_in_page >= ${clipIteratorPrefix}_ELEMENTS_PER_PAGE {
        return;
    }
    if !${clipIteratorPrefix}_is_occupied(slot_in_page) {
        return;
    }
    let clip = ${clipIteratorPrefix}_read(&animation_database, slot_in_page);
    if (clip.flags & FLAG_PLAYING) == 0u { return; }

    let clip_id = ${clipIteratorPrefix}_slot_to_index(slot_in_page);
    var new_time = clip.time + tick.dt * clip.playback_rate;
    let span = clip.time_end - clip.time_start;
    if span <= 0.0 {
        new_time = 0.0;
    } else if (clip.flags & FLAG_LOOP) != 0u {
        new_time = new_time - floor(new_time / span) * span;
    } else {
        new_time = clamp(new_time, 0.0, span);
    }
    ${ANIMATION_CLIP_DESCRIPTOR.marshalling_method_write_field("time")}(&animation_database, clip_id, new_time);
}
`,
  [
    ANIMATION_CLIP_DESCRIPTOR.chunk_iterate(64, true),
    ANIMATION_CLIP_DESCRIPTOR.wgsl_gen_write_field_code("time"),
  ],
);

const skinJointIteratorPrefix =
  ANIMATION_SKIN_JOINT_BLOCK_DESCRIPTOR.page_iterator_symbol_prefix(64);

export const ANIMATION_SKIN_MATRIX_PREP_CHUNK = CodeChunk.from(
  `
@group(0) @binding(0) var<storage, read> animation_database: array<u32>;
@group(0) @binding(1) var<storage, read> scene_database: array<u32>;
@group(0) @binding(2) var<storage, read_write> skin_matrices: array<mat4x4<f32>>;

@compute @workgroup_size(64, 1, 1)
fn main(
    @builtin(workgroup_id) workgroup_id: vec3<u32>,
    @builtin(local_invocation_index) local_id: u32,
) {
    if !${skinJointIteratorPrefix}_setup(&animation_database, workgroup_id.x, local_id) {
        return;
    }
    let slot_in_page = ${skinJointIteratorPrefix}_slot_in_page(local_id);
    if slot_in_page >= ${skinJointIteratorPrefix}_ELEMENTS_PER_PAGE {
        return;
    }
    if !${skinJointIteratorPrefix}_is_occupied(slot_in_page) {
        return;
    }
    let block = ${skinJointIteratorPrefix}_read(&animation_database, slot_in_page);
    for (var i = 0u; i < block.count; i++) {
        let joint = block.joints[i];
        let node = scene_read_node(&scene_database, joint.node);
        skin_matrices[block.skin_matrix_offset + i] = node.global * joint.inverse_bind;
    }
}
`,
  [
    ANIMATION_SKIN_JOINT_BLOCK_DESCRIPTOR.chunk_iterate(64),
    SCENE_DATABASE_READ_CHUNK,
  ],
);

export const ANIMATION_BOUND_TRACK_EVALUATE_WGSL =
  ANIMATION_BOUND_TRACK_EVALUATE_CHUNK.compile().text;
export const ANIMATION_POSE_FLUSH_WGSL =
  ANIMATION_POSE_FLUSH_CHUNK.compile().text;
export const ANIMATION_CLIP_ADVANCE_WGSL =
  ANIMATION_CLIP_ADVANCE_CHUNK.compile().text;
export const ANIMATION_SKIN_MATRIX_PREP_WGSL =
  ANIMATION_SKIN_MATRIX_PREP_CHUNK.compile().text;

function createAnimationPipelineDescriptor(
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

function requireGraphBuffer(value: unknown, label: string): GPUBuffer {
  if (typeof value !== "object" || value === null || !("size" in value)) {
    throw new Error(`GPUAnimationManager: missing ${label} buffer`);
  }
  return value as GPUBuffer;
}

function requireGraphCommand(value: unknown): ShadeGPUCommandContext {
  if (
    typeof value !== "object" ||
    value === null ||
    !("isGPUCommandContext" in value) ||
    value.isGPUCommandContext !== true
  ) {
    throw new Error("GPUAnimationManager: FrameGraph has no ShadeGPUCommandContext");
  }
  return value as ShadeGPUCommandContext;
}

const EMPTY_KEYFRAME: AnimationKeyframeRecord = Object.freeze({
  time: 0,
  value: 0,
  inTangent: 0,
  outTangent: 0,
});
const EMPTY_BINDING: AnimationBindingRecord = Object.freeze({
  track: 0,
  instance: 0,
  property: 0,
});
const EMPTY_INVERSE_BIND = new Float32Array(16);
const EMPTY_SKIN_JOINT: AnimationSkinJointRecord = Object.freeze({
  node: 0,
  inverse_bind: EMPTY_INVERSE_BIND,
});

export function addLinkedBlocks<T, R>(
  table: GPUTypedTable<R>,
  elements: readonly T[],
  blockCapacity: number,
  makeRecord: (start: number, count: number, next: number) => R,
): number {
  let head = ANIMATION_INVALID_INDEX;
  for (
    let block = Math.ceil(elements.length / blockCapacity) - 1;
    block >= 0;
    block--
  ) {
    const start = block * blockCapacity;
    const count = Math.min(blockCapacity, elements.length - start);
    head = table.add(makeRecord(start, count, head));
  }
  return head;
}

export type AnimationManagerSceneContext = {
  id_mapping: Map<number, number>;
  scene: { node_count: number };
  scene_database: SceneDatabase;
  material_metadata: MaterialMetadataTable;
  skinning?: unknown;
};

type PendingSkin = {
  skin_id: number;
  skin: Skin;
  skin_matrix_offset: number;
  inverse_bind_matrices: Float32Array;
};

type RegisteredClipChannel = {
  track: number;
  target: Node3D | null;
  property: number;
};

type PendingClip = {
  clip_id: number;
  channels: RegisteredClipChannel[];
};

export class GPUAnimationManager {
  readonly database: GPUDatabase;

  private readonly device: GPUDevice;
  private readonly label: string;
  private readonly sceneContext: AnimationManagerSceneContext;
  private readonly skinBuffers: [GPUBuffer | null, GPUBuffer | null] = [
    null,
    null,
  ];
  private currentSkinBuffer = 0;
  private skinBuffersNeedInitialization = true;
  private skinCapacity = 0;
  private skinMatrixCountValue = 0;
  private poseAccumulator: GPUBuffer | null = null;
  private poseCapacity = 0;
  private readonly skinMatrixOffsets = new Map<number, number>();
  private readonly curveIds = new WeakMap<AnimationCurve, number>();
  private readonly trackIds = new Map<string, number>();
  private readonly pendingSkins: PendingSkin[] = [];
  private readonly pendingClips: PendingClip[] = [];
  private readonly boundTrackEvaluatePipeline: CachedComputePipelineDescriptor;
  private readonly poseFlushPipeline: CachedComputePipelineDescriptor;
  private readonly clipAdvancePipeline: CachedComputePipelineDescriptor;
  private readonly skinMatrixPrepPipeline: CachedComputePipelineDescriptor;
  private hierarchyUpdater: SceneHierarchyUpdater | null = null;

  constructor(
    graphics: GraphicsContext,
    label: string,
    sceneContext: AnimationManagerSceneContext,
  ) {
    const device = graphics.device;
    if (device === null) {
      throw new Error("GPUAnimationManager: GraphicsContext has no device");
    }
    this.device = device;
    this.label = label;
    this.sceneContext = sceneContext;
    this.boundTrackEvaluatePipeline = createAnimationPipelineDescriptor(
      `${label}/qI/bound-track-evaluate`,
      ANIMATION_BOUND_TRACK_EVALUATE_WGSL,
      ["read-only-storage", "storage", "storage"],
    );
    this.poseFlushPipeline = createAnimationPipelineDescriptor(
      `${label}/KI/pose-accumulator-flush`,
      ANIMATION_POSE_FLUSH_WGSL,
      ["storage", "storage"],
    );
    this.clipAdvancePipeline = createAnimationPipelineDescriptor(
      `${label}/eF/clip-time-advance`,
      ANIMATION_CLIP_ADVANCE_WGSL,
      ["uniform", "storage"],
    );
    this.skinMatrixPrepPipeline = createAnimationPipelineDescriptor(
      `${label}/aF/skin-matrix-prep`,
      ANIMATION_SKIN_MATRIX_PREP_WGSL,
      ["read-only-storage", "read-only-storage", "storage"],
    );
    this.database = new GPUDatabase({
      device,
      definition: ANIMATION_DATABASE_DEFINITION
    });
  }

  get skin_matrices_buffer(): GPUBuffer | null {
    return this.skinBuffers[this.currentSkinBuffer]!;
  }

  get prev_skin_matrices_buffer(): GPUBuffer | null {
    return this.skinBuffers[1 - this.currentSkinBuffer]!;
  }

  get skin_matrix_count(): number {
    return this.skinMatrixCountValue;
  }

  get pose_accumulator_buffer(): GPUBuffer | null {
    return this.poseAccumulator;
  }

  ensure_pose_accumulator_capacity(elementCount: number): void {
    if (this.poseAccumulator !== null && elementCount <= this.poseCapacity) {
      return;
    }
    let capacity = Math.max(this.poseCapacity, 256);
    while (capacity < elementCount) capacity *= 2;
    this.poseAccumulator?.destroy();
    this.poseAccumulator = this.device.createBuffer({
      label: "",
      size: POSE_ACCUMULATOR_STRIDE_BYTES * capacity,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.poseCapacity = capacity;
  }

  get_skin(index: number): AnimationSkinRecord | undefined {
    return this.skins.get(index);
  }

  get_skin_matrix_offset(index: number): number | undefined {
    return this.skinMatrixOffsets.get(index);
  }

  get curves(): GPUTypedTable<AnimationCurveRecord> {
    return this.database.get(
      "animation_curves",
    ) as GPUTypedTable<AnimationCurveRecord>;
  }

  get keyframeBlocks(): GPUTypedTable<AnimationKeyframeBlockRecord> {
    return this.database.get(
      "animation_keyframe_blocks",
    ) as GPUTypedTable<AnimationKeyframeBlockRecord>;
  }

  get tracks(): GPUTypedTable<AnimationTrackRecord> {
    return this.database.get(
      "animation_tracks",
    ) as GPUTypedTable<AnimationTrackRecord>;
  }

  get clips(): GPUTypedTable<AnimationClipRecord> {
    return this.database.get(
      "animation_clips",
    ) as GPUTypedTable<AnimationClipRecord>;
  }

  get boundTrackGroups(): GPUTypedTable<AnimationBoundTrackGroupRecord> {
    return this.database.get(
      "animation_bound_track_groups",
    ) as GPUTypedTable<AnimationBoundTrackGroupRecord>;
  }

  get skins(): GPUTypedTable<AnimationSkinRecord> {
    return this.database.get(
      "animation_skins",
    ) as GPUTypedTable<AnimationSkinRecord>;
  }

  get skinJointBlocks(): GPUTypedTable<AnimationSkinJointBlockRecord> {
    return this.database.get(
      "animation_skin_joint_blocks",
    ) as GPUTypedTable<AnimationSkinJointBlockRecord>;
  }

  add_curve(curve: AnimationCurve): number {
    const keys = curve.keys;
    const keyframeHead = addLinkedBlocks(
      this.keyframeBlocks,
      keys,
      ANIMATION_BLOCK_CAPACITY,
      (start, count, next) => {
        const records = new Array<AnimationKeyframeRecord>(
          ANIMATION_BLOCK_CAPACITY,
        );
        for (let i = 0; i < ANIMATION_BLOCK_CAPACITY; i++) {
          records[i] =
            i < count
              ? this.normalizeKeyframe(keys[start + i]!)
              : EMPTY_KEYFRAME;
        }
        return { keyframes: records, count, next };
      },
    );
    return this.curves.add({
      kind: 0,
      keyframe_block_head: keyframeHead,
      keyframe_count: keys.length,
      time_min: curve.start_time,
      time_max: curve.end_time,
    });
  }

  add_track(curves: {
    x?: number;
    y?: number;
    z?: number;
    w?: number;
  }): number {
    let mask = 0;
    if (curves.x !== undefined) mask |= 1;
    if (curves.y !== undefined) mask |= 2;
    if (curves.z !== undefined) mask |= 4;
    if (curves.w !== undefined) mask |= 8;
    return this.tracks.add({
      mask,
      curves: new Uint32Array([
        curves.x ?? 0,
        curves.y ?? 0,
        curves.z ?? 0,
        curves.w ?? 0,
      ]),
    });
  }

  add_clip(input: {
    time?: number;
    time_start?: number;
    time_end?: number;
    bindings: AnimationBindingRecord[];
  }): number {
    const time = input.time ?? 0;
    const timeStart = input.time_start ?? 0;
    const timeEnd = input.time_end ?? 0;
    const clipId = this.clips.add({
      time,
      time_start: timeStart,
      time_end: timeEnd,
      bound_track_group_head: ANIMATION_INVALID_INDEX,
      playback_rate: 1,
      flags: 0,
      playback_weight: 1,
    });
    const groupHead = this.addBindingGroups(input.bindings, clipId);
    this.clips.set(clipId, {
      time,
      time_start: timeStart,
      time_end: timeEnd,
      bound_track_group_head: groupHead,
      playback_rate: 1,
      flags: 0,
      playback_weight: 1,
    });
    return clipId;
  }

  set_time(clip: number, value: number): void {
    this.updateClipField(clip, "time", value);
  }

  set_playback_rate(clip: number, value: number): void {
    this.updateClipField(clip, "playback_rate", value);
  }

  set_playback_weight(clip: number, value: number): void {
    this.updateClipField(clip, "playback_weight", value);
  }

  set_flags(clip: number, flags: number): void {
    const record = this.clips.get(clip)!;
    this.updateClipField(clip, "flags", record.flags | flags);
  }

  clear_flags(clip: number, flags: number): void {
    const record = this.clips.get(clip)!;
    this.updateClipField(clip, "flags", record.flags & ~flags);
  }

  start(clip: number): void {
    this.set_flags(clip, AnimationClipFlags.Playing);
  }

  stop(clip: number): void {
    this.clear_flags(clip, AnimationClipFlags.Playing);
  }

  add_skin(input: { joints: AnimationSkinJointRecord[] }): number {
    const jointCount = input.joints.length;
    const matrixOffset = this.skinMatrixCountValue;
    this.skinMatrixCountValue += jointCount;
    this.ensureSkinCapacity(this.skinMatrixCountValue);
    const skinId = this.skins.add({
      joint_block_head: 0,
      joint_count: jointCount,
    });
    this.skinMatrixOffsets.set(skinId, matrixOffset);
    const head = this.addJointBlocks(input.joints, matrixOffset);
    this.skins.set(skinId, {
      joint_block_head: head,
      joint_count: jointCount,
    });
    return skinId;
  }

  register_skin(skin: Skin): number {
    const jointCount = skin.joints.length;
    const matrixOffset = this.skinMatrixCountValue;
    this.skinMatrixCountValue += jointCount;
    this.ensureSkinCapacity(this.skinMatrixCountValue);
    const skinId = this.skins.add({
      joint_block_head: 0,
      joint_count: jointCount,
    });
    this.skinMatrixOffsets.set(skinId, matrixOffset);
    const skinning = this.sceneContext.skinning as
      { bind?: (mesh: unknown, id: number) => void } | undefined;
    if (skinning?.bind) {
      for (const mesh of skin.meshes) {
        skinning.bind(mesh, skinId);
      }
    }
    const pending: PendingSkin = {
      skin_id: skinId,
      skin,
      skin_matrix_offset: matrixOffset,
      inverse_bind_matrices: skin.inverse_bind_matrices,
    };
    if (!this.resolveSkin(pending)) this.pendingSkins.push(pending);
    return skinId;
  }

  register_clip(clip: ShadeAnimationClip): number {
    const channels = new Array<RegisteredClipChannel>(clip.channels.length);
    for (let i = 0; i < clip.channels.length; i++) {
      const channel = clip.channels[i]!;
      const curves: {
        x?: number;
        y?: number;
        z?: number;
        w?: number;
      } = {};
      if (channel.curves.x !== undefined) {
        curves.x = this.obtainCurve(channel.curves.x);
      }
      if (channel.curves.y !== undefined) {
        curves.y = this.obtainCurve(channel.curves.y);
      }
      if (channel.curves.z !== undefined) {
        curves.z = this.obtainCurve(channel.curves.z);
      }
      if (channel.curves.w !== undefined) {
        curves.w = this.obtainCurve(channel.curves.w);
      }
      channels[i] = {
        track: this.obtainTrack(curves),
        target: channel.target,
        property: channel.property,
      };
    }
    const clipId = this.clips.add({
      time: 0,
      time_start: clip.start_time,
      time_end: clip.end_time,
      bound_track_group_head: ANIMATION_INVALID_INDEX,
      playback_rate: 1,
      flags: 0,
      playback_weight: 1,
    });
    const pending = { clip_id: clipId, channels };
    if (!this.resolveClip(pending)) this.pendingClips.push(pending);
    return clipId;
  }

  unregister_clip(clipId: number): void {
    for (let i = this.pendingClips.length - 1; i >= 0; i--) {
      if (this.pendingClips[i]!.clip_id === clipId) {
        this.pendingClips.splice(i, 1);
      }
    }
    const clip = this.clips.get(clipId);
    if (clip === undefined) return;
    let group = clip.bound_track_group_head;
    while (group !== ANIMATION_INVALID_INDEX) {
      const record = this.boundTrackGroups.get(group);
      const next = record?.next ?? ANIMATION_INVALID_INDEX;
      this.boundTrackGroups.remove(group);
      group = next;
    }
    this.clips.remove(clipId);
  }

  unregister_skin(skinId: number): void {
    for (let i = this.pendingSkins.length - 1; i >= 0; i--) {
      if (this.pendingSkins[i]!.skin_id === skinId) {
        this.pendingSkins.splice(i, 1);
      }
    }
    const skinning = this.sceneContext.skinning as
      { unbind_all_by_skin?: (id: number) => void } | undefined;
    skinning?.unbind_all_by_skin?.(skinId);
    const skin = this.skins.get(skinId);
    if (skin === undefined) {
      this.skinMatrixOffsets.delete(skinId);
      return;
    }
    let block = skin.joint_block_head;
    while (block !== ANIMATION_INVALID_INDEX && block !== 0) {
      const record = this.skinJointBlocks.get(block);
      const next = record?.next ?? ANIMATION_INVALID_INDEX;
      this.skinJointBlocks.remove(block);
      block = next;
    }
    this.skins.remove(skinId);
    this.skinMatrixOffsets.delete(skinId);
  }

  update(command: ShadeGPUCommandContext): void {
    this.resolvePendingSkins();
    this.resolvePendingClips();
    this.database.update(command);
  }

  tick(command: ShadeGPUCommandContext, _dt: number): void {
    const dt = Math.min(_dt, ANIMATION_TICK_MAX_DT);
    this.update(command);
    const boundTrackGroups = this.boundTrackGroups.dispatch_group_count(64);
    if (boundTrackGroups === 0) return;

    const clipGroups = this.clips.dispatch_group_count(64);
    if (clipGroups > 0) {
      this.dispatchClipAdvance(command, clipGroups, dt);
    }

    const transforms = this.sceneContext.scene_database.transforms;
    this.ensure_pose_accumulator_capacity(
      transforms.dispatch_page_count * transforms.descriptor.elements_per_page,
    );
    const poseAccumulator = this.poseAccumulator;
    if (poseAccumulator === null) {
      throw new Error("GPUAnimationManager: pose accumulator buffer is unavailable");
    }
    const materialMetadata = this.sceneContext.material_metadata.buffer;
    if (materialMetadata === null) {
      throw new Error("GPUAnimationManager: material metadata buffer is unavailable");
    }

    const graph = new FrameGraph("GPUAnimationManager/Tick");
    const animationDatabase = graph.import_resource(
      "velocity",
      { kind: "imported", label: "animation database" },
      this.database.buffer,
    );
    const sceneDatabase = graph.import_resource(
      "scene_database",
      { kind: "imported", label: "scene database" },
      this.sceneContext.scene_database.buffer,
    );
    const materials = graph.import_resource(
      "materials",
      { kind: "imported", label: "material metadata" },
      materialMetadata,
    );
    const pose = graph.import_resource(
      "types",
      { kind: "imported", label: "pose accumulator" },
      poseAccumulator,
    );

    const evaluateData = {
      animationDatabase,
      materials,
      poseAccumulator: pose,
    };
    const evaluatePass = graph.add(
      "coalesce_dependencies",
      evaluateData,
      (data, resources, context) => {
        this.dispatchBoundTrackEvaluation(
          requireGraphCommand(context.encoder),
          boundTrackGroups,
          requireGraphBuffer(resources.get(data.animationDatabase), "animation database"),
          requireGraphBuffer(resources.get(data.poseAccumulator), "pose accumulator"),
          requireGraphBuffer(resources.get(data.materials), "material metadata"),
        );
      },
    );
    evaluateData.animationDatabase = evaluatePass.read(animationDatabase);
    evaluateData.materials = evaluatePass.write(evaluatePass.read(materials));
    evaluateData.poseAccumulator = evaluatePass.write(evaluatePass.read(pose));

    const transformGroups = transforms.dispatch_group_count(64);
    const flushData = {
      sceneDatabase,
      poseAccumulator: evaluateData.poseAccumulator,
    };
    const flushPass = graph.add(
      "heap32_vector",
      flushData,
      (data, resources, context) => {
        if (transformGroups === 0) return;
        this.dispatchPoseFlush(
          requireGraphCommand(context.encoder),
          transformGroups,
          requireGraphBuffer(resources.get(data.sceneDatabase), "scene database"),
          requireGraphBuffer(resources.get(data.poseAccumulator), "pose accumulator"),
        );
      },
    );
    flushData.sceneDatabase = flushPass.write(flushPass.read(sceneDatabase));
    flushData.poseAccumulator = flushPass.write(
      flushPass.read(evaluateData.poseAccumulator),
    );

    (this.hierarchyUpdater ??= new SceneHierarchyUpdater(
      this.device,
      `${this.label}/SceneHierarchy`,
    )).addToGraph(
      graph,
      flushData.sceneDatabase,
      this.sceneContext.scene.node_count,
    );
    command.encodeGraph(graph);
    this.dispatch_skin_matrix_prep(command);
    const skinning = this.sceneContext.skinning as
      { update?: (cmd: ShadeGPUCommandContext) => void } | undefined;
    skinning?.update?.(command);
  }

  dispatch_skin_matrix_prep(command: ShadeGPUCommandContext): void {
    const groups = this.skinJointBlocks.dispatch_group_count(64);
    if (groups === 0) return;
    this.currentSkinBuffer = 1 - this.currentSkinBuffer;
    const current = this.skinBuffers[this.currentSkinBuffer] ?? null;
    const previous = this.skinBuffers[1 - this.currentSkinBuffer] ?? null;
    if (current === null || previous === null) return;

    const pass = command.constructComputePass({
      label: `${this.label}/aF-skin-matrix-prep`,
      pipeline: this.skinMatrixPrepPipeline,
      bindings: [[
        { buffer: this.database.buffer },
        { buffer: this.sceneContext.scene_database.buffer },
        { buffer: current },
      ]],
    });
    pass.dispatchWorkgroups(groups);
    pass.end();

    if (this.skinBuffersNeedInitialization) {
      command.copyBufferToBuffer(current, 0, previous, 0, current.size);
      this.skinBuffersNeedInitialization = false;
    }
  }

  destroy(): void {
    this.database.destroy();
    for (let i = 0; i < 2; i++) {
      this.skinBuffers[i]?.destroy();
      this.skinBuffers[i] = null;
    }
    this.poseAccumulator?.destroy();
    this.poseAccumulator = null;
    this.hierarchyUpdater?.destroy();
    this.hierarchyUpdater = null;
  }

  private dispatchClipAdvance(
    command: ShadeGPUCommandContext,
    groups: number,
    dt: number,
  ): void {
    const tickUniform = command.allocateTransientBufferAndLoad(
      new Float32Array([dt]).buffer,
      GPUBufferUsage.UNIFORM,
    );
    const pass = command.constructComputePass({
      label: `${this.label}/eF-clip-time-advance`,
      pipeline: this.clipAdvancePipeline,
      bindings: [[
        { buffer: tickUniform },
        { buffer: this.database.buffer },
      ]],
    });
    pass.dispatchWorkgroups(groups);
    pass.end();
  }

  private dispatchBoundTrackEvaluation(
    command: ShadeGPUCommandContext,
    groups: number,
    animationDatabase: GPUBuffer,
    poseAccumulator: GPUBuffer,
    materials: GPUBuffer,
  ): void {
    const pass = command.constructComputePass({
      label: `${this.label}/qI-bound-track-evaluate`,
      pipeline: this.boundTrackEvaluatePipeline,
      bindings: [[
        { buffer: animationDatabase },
        { buffer: poseAccumulator },
        { buffer: materials },
      ]],
    });
    pass.dispatchWorkgroups(groups);
    pass.end();
  }

  private dispatchPoseFlush(
    command: ShadeGPUCommandContext,
    groups: number,
    sceneDatabase: GPUBuffer,
    poseAccumulator: GPUBuffer,
  ): void {
    const pass = command.constructComputePass({
      label: `${this.label}/KI-pose-accumulator-flush`,
      pipeline: this.poseFlushPipeline,
      bindings: [[
        { buffer: sceneDatabase },
        { buffer: poseAccumulator },
      ]],
    });
    pass.dispatchWorkgroups(groups);
    pass.end();
  }

  private normalizeKeyframe(key: AnimationKeyframe): AnimationKeyframeRecord {
    return {
      time: key.time,
      value: key.value,
      inTangent: key.inTangent ?? 0,
      outTangent: key.outTangent ?? 0,
    };
  }

  private updateClipField<K extends keyof AnimationClipRecord>(
    clipId: number,
    field: K,
    value: AnimationClipRecord[K],
  ): void {
    const clip = this.clips.get(clipId);
    this.clips.set(clipId, {
      time: clip!.time,
      time_start: clip!.time_start,
      time_end: clip!.time_end,
      bound_track_group_head: clip!.bound_track_group_head,
      playback_rate: clip!.playback_rate,
      flags: clip!.flags,
      playback_weight: clip!.playback_weight,
      [field]: value,
    });
  }

  private obtainCurve(curve: AnimationCurve): number {
    const existing = this.curveIds.get(curve);
    if (existing !== undefined) return existing;
    const id = this.add_curve(curve);
    this.curveIds.set(curve, id);
    return id;
  }

  private obtainTrack(curves: {
    x?: number;
    y?: number;
    z?: number;
    w?: number;
  }): number {
    const key = `${curves.x ?? -1},${curves.y ?? -1},${curves.z ?? -1},${curves.w ?? -1}`;
    const existing = this.trackIds.get(key);
    if (existing !== undefined) return existing;
    const id = this.add_track(curves);
    this.trackIds.set(key, id);
    return id;
  }

  private addBindingGroups(
    bindings: AnimationBindingRecord[],
    clipId: number,
  ): number {
    return addLinkedBlocks(
      this.boundTrackGroups,
      bindings,
      ANIMATION_BLOCK_CAPACITY,
      (start, count, next) => {
        const records = new Array<AnimationBindingRecord>(
          ANIMATION_BLOCK_CAPACITY,
        );
        for (let i = 0; i < ANIMATION_BLOCK_CAPACITY; i++) {
          records[i] = i < count ? bindings[start + i]! : EMPTY_BINDING;
        }
        return { bindings: records, count, next, clip: clipId };
      },
    );
  }

  private addJointBlocks(
    joints: AnimationSkinJointRecord[],
    matrixOffset: number,
  ): number {
    return addLinkedBlocks(
      this.skinJointBlocks,
      joints,
      ANIMATION_BLOCK_CAPACITY,
      (start, count, next) => {
        const records = new Array<AnimationSkinJointRecord>(
          ANIMATION_BLOCK_CAPACITY,
        );
        for (let i = 0; i < ANIMATION_BLOCK_CAPACITY; i++) {
          records[i] = i < count ? joints[start + i]! : EMPTY_SKIN_JOINT;
        }
        return {
          joints: records,
          count,
          next,
          skin_matrix_offset: matrixOffset + start,
        };
      },
    );
  }

  private resolveSkin(pending: PendingSkin): boolean {
    const joints = pending.skin.joints;
    const records = new Array<AnimationSkinJointRecord>(joints.length);
    for (let i = 0; i < joints.length; i++) {
      const nodeId = this.sceneContext.id_mapping.get(joints[i]!.id);
      if (nodeId === undefined) return false;
      records[i] = {
        node: nodeId,
        inverse_bind: pending.inverse_bind_matrices.subarray(
          i * 16,
          (i + 1) * 16,
        ),
      };
    }
    const head = this.addJointBlocks(records, pending.skin_matrix_offset);
    const skin = this.skins.get(pending.skin_id);
    if (skin !== undefined) {
      this.skins.set(pending.skin_id, {
        joint_block_head: head,
        joint_count: skin.joint_count,
      });
    }
    return true;
  }

  private resolveClip(pending: PendingClip): boolean {
    const bindings = new Array<AnimationBindingRecord>(pending.channels.length);
    for (let i = 0; i < pending.channels.length; i++) {
      const channel = pending.channels[i]!;
      const instance = this.sceneContext.id_mapping.get(channel.target!.id);
      if (instance === undefined) return false;
      bindings[i] = {
        track: channel.track,
        instance,
        property: channel.property,
      };
    }
    const head = this.addBindingGroups(bindings, pending.clip_id);
    this.updateClipField(pending.clip_id, "bound_track_group_head", head);
    return true;
  }

  private resolvePendingSkins(): void {
    for (let i = this.pendingSkins.length - 1; i >= 0; i--) {
      if (this.resolveSkin(this.pendingSkins[i]!)) {
        this.pendingSkins.splice(i, 1);
      }
    }
  }

  private resolvePendingClips(): void {
    for (let i = this.pendingClips.length - 1; i >= 0; i--) {
      if (this.resolveClip(this.pendingClips[i]!)) {
        this.pendingClips.splice(i, 1);
      }
    }
  }

  private ensureSkinCapacity(matrixCount: number): void {
    if (matrixCount <= this.skinCapacity) return;
    let capacity = Math.max(this.skinCapacity, 256);
    while (capacity < matrixCount) capacity *= 2;
    for (let i = 0; i < 2; i++) {
      this.skinBuffers[i]?.destroy();
      this.skinBuffers[i] = this.device.createBuffer({
        label: "",
        size: SKIN_MATRIX_STRIDE_BYTES * capacity,
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.COPY_DST,
      });
    }
    this.skinCapacity = capacity;
    this.skinBuffersNeedInitialization = true;
  }
}
