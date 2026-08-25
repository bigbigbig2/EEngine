/**
 * meshlet_material_sort：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { SCENE_DATABASE_READ_WGSL } from "../gpu/SceneDatabase.js";

export const MATERIAL_SORT_WORKGROUP_SIZE = 128;
export const MATERIAL_SORT_TILE_SIZE = 4096;
export const MATERIAL_SORT_DRAW_ARGS_BYTES = 16;

const MATERIAL_SORT_COMMON_WGSL = /* wgsl */ `
${SCENE_DATABASE_READ_WGSL}
struct MeshletElement { index: u32, mesh: u32, }
struct MeshletList { count: u32, _pad0: u32, _pad1: u32, _pad2: u32, elements: array<MeshletElement>, }
struct MaterialPrefix { count: u32, _pad0: u32, _pad1: u32, _pad2: u32, elements: array<u32>, }
fn random_device(value: u32) -> u32 { var v=value; v^=v>>16u; v*=0x21f0aaadu; v^=v>>15u; v*=0xd35a2d97u; v^=v>>15u; return v; }
fn hash_table_next(index: u32, mask: u32) -> u32 { return ((index << 2u) + index + 1u) & mask; }
fn hash_table_get(table: ptr<storage, array<u32>, read>, offset: u32, key: u32) -> u32 {
  let hash=random_device(key); let capacity=(*table)[offset+1u]; let base=offset+2u; let mask=capacity-1u; var slot=hash & mask;
  for(var probe=0u; probe<32u; probe++){ let address=base+slot*2u; let stored=(*table)[address]; if(stored==0u){return 0xffffffffu;} if(stored-1u==key){return (*table)[address+1u];} slot=hash_table_next(slot,mask); }
  return 0xffffffffu;
}
`;

export const MATERIAL_SORT_COUNT_WGSL = /* wgsl */ `
${MATERIAL_SORT_COMMON_WGSL}
struct MaterialCounts { count: u32, _pad0: u32, _pad1: u32, _pad2: u32, elements: array<atomic<u32>>, }
@group(0) @binding(0) var<storage, read> input: MeshletList;
@group(0) @binding(1) var<storage, read_write> output: MaterialCounts;
@group(0) @binding(2) var<storage, read> context: array<u32>;
@group(1) @binding(0) var<storage, read> scene_database: array<u32>;
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3u){
 let i=gid.x; if(i>=input.count){return;} if(i==0u){output.count=context[0];}
 let item=input.elements[i]; let mesh=scene_read_mesh(&scene_database,item.mesh); let material_index=hash_table_get(&context,0u,mesh.material);
 if(material_index==0xffffffffu){return;} atomicAdd(&output.elements[material_index],1u);
}
`;

export const MATERIAL_SORT_PREFIX_SCAN_WGSL = /* wgsl */ `
enable subgroups;
fn divide_round_up_u32(value:u32, divisor:u32)->u32{return (value+divisor-1u)/divisor;}
struct PrefixAddress { count:u32, _pad0:u32, _pad1:u32, _pad2:u32, elements:array<vec4u>, }
@group(0) @binding(0) var<storage, read_write> address: PrefixAddress;
@group(0) @binding(1) var<storage, read_write> spine: array<array<atomic<u32>,2>>;
const BLOCK_DIM = 256u;
const SPLIT_MEMBERS = 2u;
const MIN_SUBGROUP_SIZE = 4u;
const MAX_PARTIALS_SIZE = BLOCK_DIM / MIN_SUBGROUP_SIZE * 2u;

const VEC4_SPT = 4u;
const VEC_TILE_SIZE = BLOCK_DIM * VEC4_SPT;

const FLAG_NOT_READY = 0u;
const FLAG_READY = 0x40000000u;
const FLAG_INCLUSIVE = 0x80000000u;
const FLAG_MASK = 0xC0000000u;
const VALUE_MASK = 0xffffu;
const ALL_READY = 3u;

const MAX_SPIN_COUNT = 4u;
const LOCKED = 1u;
const UNLOCKED = 0u;

var<workgroup> wg_control: u32;
var<workgroup> wg_broadcast: u32;
var<workgroup> wg_partials: array<u32, MAX_PARTIALS_SIZE>;
var<workgroup> wg_fallback: array<u32, MAX_PARTIALS_SIZE>;

@diagnostic(off, subgroup_uniformity)
fn unsafeShuffle(traced_harmonics: u32, shader_sdf_distance_sqr: u32) -> u32 {
    return subgroupShuffle(traced_harmonics, shader_sdf_distance_sqr);
}


@diagnostic(off, subgroup_uniformity)
fn unsafeBallot(traced_harmonics: bool) -> u32 {
    return subgroupBallot(traced_harmonics).x;
}

fn join(traced_harmonics: u32, shader_sdf_distance_sqr: u32) -> u32 {
    let optimized_move_x = shader_sdf_distance_sqr ^ 1;
    let j = unsafeShuffle(traced_harmonics, optimized_move_x);
    return (traced_harmonics << (16u * shader_sdf_distance_sqr)) | (j << (16u * optimized_move_x));
}

fn split(traced_harmonics: u32, shader_sdf_distance_sqr: u32) -> u32 {
    return (traced_harmonics >> (shader_sdf_distance_sqr * 16u)) & VALUE_MASK;
}

@compute @workgroup_size(BLOCK_DIM)
fn main(
    @builtin(local_invocation_id) thread_id: vec3<u32>,
    @builtin(workgroup_id) workgroup_id: vec3<u32>,
    @builtin(subgroup_invocation_id) lane_id: u32,
    @builtin(subgroup_size) lane_count: u32,
) {

    let vec_size = divide_round_up_u32(address.count, 4);
    let work_tiles = divide_round_up_u32(address.count, 4096);

    let subgroup_id = thread_id.x / lane_count;


    if(thread_id.x == 0u){
        wg_control = LOCKED;
    }

    let tile_id = workgroup_id.x;
    let s_offset = lane_id + subgroup_id * lane_count * VEC4_SPT;

    var t_scan = array<vec4<u32>, VEC4_SPT>();
    {
        var i = s_offset + tile_id * VEC_TILE_SIZE;
        if(tile_id < work_tiles - 1u){
            for(var k = 0u; k < VEC4_SPT; k += 1u){
                t_scan[k] = address.elements[i];
                t_scan[k].y += t_scan[k].x;
                t_scan[k].z += t_scan[k].y;
                t_scan[k].w += t_scan[k].z;
                i += lane_count;
            }
        }

        if(tile_id == work_tiles - 1u){
            for(var k = 0u; k < VEC4_SPT; k += 1u){
                if(i < vec_size){
                    t_scan[k] = address.elements[i];
                    t_scan[k].y += t_scan[k].x;
                    t_scan[k].z += t_scan[k].y;
                    t_scan[k].w += t_scan[k].z;
                }
                i += lane_count;
            }
        }

        var prev = 0u;
        let lane_mask = lane_count - 1u;
        let circular_shift = (lane_id + lane_mask) & lane_mask;
        for(var k = 0u; k < VEC4_SPT; k += 1u){
            let t = subgroupShuffle(subgroupInclusiveAdd(select(prev, 0u, lane_id != 0u) + t_scan[k].w), circular_shift);
            t_scan[k] += select(prev, t, lane_id != 0u);
            prev = t;
        }

        if(lane_id == 0u){
            wg_partials[subgroup_id] = prev;
        }
    }
    workgroupBarrier();


    let lane_log = u32(countTrailingZeros(lane_count));
    let local_spine = BLOCK_DIM >> lane_log;
    let aligned_size = 1u << ((u32(countTrailingZeros(local_spine)) + lane_log - 1u) / lane_log * lane_log);
    {
        var offset = 0u;
        var top_offset = 0u;
        let lane_pred = lane_id == lane_count - 1u;
        for(var j = lane_count; j <= aligned_size; j <<= lane_log){
            let step = local_spine >> offset;
            let pred = thread_id.x < step;
            let t = subgroupInclusiveAdd(select(0u, wg_partials[thread_id.x + top_offset], pred));
            if(pred){
                wg_partials[thread_id.x + top_offset] = t;
                if(lane_pred){
                    wg_partials[subgroup_id + step + top_offset] = t;
                }
            }
            workgroupBarrier();

            if(j != lane_count){
                let rshift = j >> lane_log;
                let index = thread_id.x + rshift;
                if(index < local_spine && (index & (j - 1u)) >= rshift){
                    wg_partials[index] += wg_partials[(index >> offset) + top_offset - 1u];
                }
            }
            top_offset += step;
            offset += lane_log;
        }
    }
    workgroupBarrier();


    if(thread_id.x < SPLIT_MEMBERS){
        let t = split(wg_partials[local_spine - 1u], thread_id.x) | select(FLAG_READY, FLAG_INCLUSIVE, tile_id == 0u);
        atomicStore(&spine[tile_id][thread_id.x], t);
    }


    if(tile_id != 0u){
        var prev_red = 0u;
        var lookback_id = tile_id - 1u;
        var control_flag = workgroupUniformLoad(&wg_control);
        while(control_flag == LOCKED){
            if(thread_id.x < lane_count){
                var spin_count = 0u;
                while(spin_count < MAX_SPIN_COUNT){
                    var flag_payload = select(0u, atomicLoad(&spine[lookback_id][thread_id.x]), thread_id.x < SPLIT_MEMBERS);
                    if(unsafeBallot((flag_payload & FLAG_MASK) > FLAG_NOT_READY) == ALL_READY) {
                        var incl_bal = unsafeBallot((flag_payload & FLAG_MASK) == FLAG_INCLUSIVE);
                        if(incl_bal != 0u) {

                            while(incl_bal != ALL_READY){
                                flag_payload = select(0u, atomicLoad(&spine[lookback_id][thread_id.x]), thread_id.x < SPLIT_MEMBERS);
                                incl_bal = unsafeBallot((flag_payload & FLAG_MASK) == FLAG_INCLUSIVE);
                            }
                            prev_red += join(flag_payload & VALUE_MASK, thread_id.x);
                            if(thread_id.x < SPLIT_MEMBERS){
                                let t = split(prev_red + wg_partials[local_spine - 1u], thread_id.x) | FLAG_INCLUSIVE;
                                atomicStore(&spine[tile_id][thread_id.x], t);
                            }
                            if(thread_id.x == 0u){
                                wg_control = UNLOCKED;
                                wg_broadcast = prev_red;
                            }
                            break;
                        } else {
                            prev_red += join(flag_payload & VALUE_MASK, thread_id.x);
                            spin_count = 0u;
                            lookback_id -= 1u;
                        }
                    } else {
                        spin_count += 1u;
                    }
                }

                if(thread_id.x == 0 && spin_count == MAX_SPIN_COUNT) {
                    wg_broadcast = lookback_id;
                }
            }


            control_flag = workgroupUniformLoad(&wg_control);
            if(control_flag == LOCKED){
                let fallback_id = wg_broadcast;
                {
                    var t_red = 0u;
                    var i = s_offset + fallback_id * VEC_TILE_SIZE;
                    for(var k = 0u; k < VEC4_SPT; k += 1u){
                        let t = address.elements[i];
                        t_red += t.x + t.y + t.z + t.w;
                        i += lane_count;
                    }

                    let s_red = subgroupAdd(t_red);
                    if(lane_id == 0u){
                        wg_fallback[subgroup_id] = s_red;
                    }
                }
                workgroupBarrier();


                var f_red = 0u;
                {
                    var offset = 0u;
                    var top_offset = 0u;
                    let lane_pred = lane_id == lane_count - 1u;
                    for(var j = lane_count; j <= aligned_size; j <<= lane_log){
                        let step = local_spine >> offset;
                        let pred = thread_id.x < step;
                        f_red = subgroupAdd(select(0u, wg_fallback[thread_id.x + top_offset], pred));
                        if(pred && lane_pred){
                            wg_fallback[subgroup_id + step + top_offset] = f_red;
                        }
                        workgroupBarrier();
                        top_offset += step;
                        offset += lane_log;
                    }
                }

                if(thread_id.x < lane_count){
                    let f_split = split(f_red, thread_id.x) | select(FLAG_READY, FLAG_INCLUSIVE, fallback_id == 0u);
                    var f_payload = 0u;
                    if(thread_id.x < SPLIT_MEMBERS) {
                        f_payload = atomicMax(&spine[fallback_id][thread_id.x], f_split);
                    }
                    let incl_found = unsafeBallot((f_payload & FLAG_MASK) == FLAG_INCLUSIVE) == ALL_READY;
                    if(incl_found){
                        prev_red += join(f_payload & VALUE_MASK, thread_id.x);
                    } else {
                        prev_red += f_red;
                    }

                    if(fallback_id == 0u || incl_found){
                        if(thread_id.x < SPLIT_MEMBERS){
                            let t = split(prev_red + wg_partials[local_spine - 1u], thread_id.x) | FLAG_INCLUSIVE;
                            atomicStore(&spine[tile_id][thread_id.x], t);
                        }
                        if(thread_id.x == 0u){
                            wg_control = UNLOCKED;
                            wg_broadcast = prev_red;
                        }
                    } else {
                        lookback_id -= 1u;
                    }
                }
                control_flag = workgroupUniformLoad(&wg_control);
            }
        }
    }

    {
        var i = s_offset + tile_id * VEC_TILE_SIZE;
        let prev = wg_broadcast + select(0u, wg_partials[subgroup_id - 1u], subgroup_id != 0u);
        if(tile_id < work_tiles - 1u){
            for(var k = 0u; k < VEC4_SPT; k += 1u){
                address.elements[i] = t_scan[k] + prev;
                i += lane_count;
            }
        }

        if(tile_id == work_tiles - 1u){
            for(var k = 0u; k < VEC4_SPT; k += 1u){
                if(i < vec_size){
                    address.elements[i] = t_scan[k] + prev;
                }
                i += lane_count;
            }
        }
    }
}
`;

export const MATERIAL_SORT_SCATTER_WGSL = /* wgsl */ `
${MATERIAL_SORT_COMMON_WGSL}
@group(0) @binding(0) var<storage, read> input: MeshletList;
@group(0) @binding(1) var<storage, read> inverse_bind_rotation: MaterialPrefix;
@group(0) @binding(2) var<storage, read> scene_database: array<u32>;
@group(0) @binding(3) var<storage, read> context: array<u32>;
@group(0) @binding(4) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> output: array<MeshletElement>;
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3u){
 let i=gid.x; if(i>=input.count){return;} let item=input.elements[i]; let mesh=scene_read_mesh(&scene_database,item.mesh);
 let material_index=hash_table_get(&context,0u,mesh.material); if(material_index==0xffffffffu){return;}
 let previous=select(0u,inverse_bind_rotation.elements[material_index-1u],material_index>0u);
 let dst=previous+atomicAdd(&counters[material_index],1u); if(dst<arrayLength(&output)){output[dst]=item;}
}
`;

export const MATERIAL_SORT_COMMANDS_WGSL = /* wgsl */ `
struct MaterialPrefix { count:u32, _pad0:u32, _pad1:u32, _pad2:u32, elements:array<u32>, }
struct DrawIndirectArgs { vertexCount:u32, instanceCount:u32, firstVertex:u32, firstInstance:u32, }
@group(0) @binding(0) var<storage, read> prefix: MaterialPrefix;
@group(0) @binding(1) var<storage, read_write> commands: array<DrawIndirectArgs>;
@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid:vec3u){let i=gid.x;if(i>=prefix.count){return;}let previous=select(0u,prefix.elements[i-1u],i>0u);let current=prefix.elements[i];commands[i]=DrawIndirectArgs(384u,current-previous,0u,previous);}
`;
