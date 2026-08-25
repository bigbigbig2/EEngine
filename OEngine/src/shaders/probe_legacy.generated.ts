/**
 * probe_legacy.generated：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

export const PROBE_LEGACY_DERING_WGSL = /* wgsl */ `struct GpuCommandRecorder{
    probe_count : u32,
    probe_resolution : u32,
}
struct Uint32Buffer{
    position : array< f32, 3 >,
    distance_max : f32,
    accumulated_samples : u32,
    coefficients : array< f32, 12 >,
}
struct Struct_34{
    start : u32,
}
const PI : f32 = 3.1415926535897932384626433832795;

fn pose_bounding_sphere_intersects(traced_harmonics: f32, shader_sdf_distance_sqr:f32)-> f32{
   if (traced_harmonics == 0) {
       return 1.0;
   } else if (traced_harmonics >= shader_sdf_distance_sqr) {
       return 0.0;
   }
   

   var optimized_move_x = (PI * traced_harmonics) / shader_sdf_distance_sqr;

   optimized_move_x = sin(optimized_move_x) / (optimized_move_x + 1e-9);




   return pow(optimized_move_x, 4);
}


fn resample(traced_harmonics:i32, shader_sdf_distance_sqr:i32)-> i32{
    
    return shader_sdf_distance_sqr * (shader_sdf_distance_sqr + 1) + traced_harmonics;

}

fn stats( traced_harmonics:array<f32, 9>, shader_sdf_distance_sqr:f32 ) -> array<f32, 9>{


    let optimized_move_x = 1.0;
    let j = pose_bounding_sphere_intersects(1, shader_sdf_distance_sqr);
    let cursor = pose_bounding_sphere_intersects(2, shader_sdf_distance_sqr);
    
    return array<f32,9>(

        traced_harmonics[0] * optimized_move_x,

        traced_harmonics[1] * j,
        traced_harmonics[2] * j,
        traced_harmonics[3] * j,

        traced_harmonics[4] * cursor,
        traced_harmonics[5] * cursor,
        traced_harmonics[6] * cursor,
        traced_harmonics[7] * cursor,
        traced_harmonics[8] * cursor,
    );
}


const SQRT1_2 = 0.7071067811865476;


    const SH3_COEFFICIENTS = array<f32,9>(
        0.28209479177387814,    
        
        0.4886025119029199,   
        0.4886025119029199,     
        0.4886025119029199,    
        
        1.0925484305920792,    
        1.0925484305920792,    
        0.31539156525252005,   
        1.0925484305920792,   
        0.5462742152960396   
    ); 
    

fn fit_rotation_curves( traced_harmonics:array<f32,9>, shader_sdf_distance_sqr:mat3x3<f32> ) -> array<f32,9>{

    let optimized_move_x = shader_sdf_distance_sqr[0][0];
    let j = shader_sdf_distance_sqr[0][1];
    let cursor = shader_sdf_distance_sqr[0][2];

    let t3 = shader_sdf_distance_sqr[1][0];
    let gi_radiance = shader_sdf_distance_sqr[1][1];
    let needs_destructor_signature = shader_sdf_distance_sqr[1][2];

    let raw_destructor_signature = shader_sdf_distance_sqr[2][0];
    let seed_budget_ms = shader_sdf_distance_sqr[2][1];
    let texture = shader_sdf_distance_sqr[2][2];

    var format:array <f32,9>;
    

    format[0] = traced_harmonics[0];


    format[1] = gi_radiance * traced_harmonics[1] - seed_budget_ms * traced_harmonics[2] + j * traced_harmonics[3];
    format[2] = -needs_destructor_signature * traced_harmonics[1] + texture * traced_harmonics[2] - cursor * traced_harmonics[3];
    format[3] = t3 * traced_harmonics[1] - raw_destructor_signature * traced_harmonics[2] + optimized_move_x * traced_harmonics[3];


    let dst = t3 * optimized_move_x;
    let message = gi_radiance * j;
    let color_texture = gi_radiance * seed_budget_ms;
    let redundant = t3 * raw_destructor_signature;
    let bucket_index_count = raw_destructor_signature * raw_destructor_signature;
    let local_total_indirect_diffuse = texture * texture;
    let num_occluded = seed_budget_ms * seed_budget_ms;
    let u8array = optimized_move_x * raw_destructor_signature;
    let meshlet_buckets = j * seed_budget_ms;
    let allocator_textures = j * j;
    let meshlet = t3 * t3;
    let filter_mitchell = gi_radiance * gi_radiance;
    let rel_name = optimized_move_x * optimized_move_x;
    let chunk_scene_bounding_box = needs_destructor_signature * needs_destructor_signature;
    let ve = cursor * cursor;

    const raw_type = 0.1732050808e1;
    const fields = 0.5773502693e0;
    const probe_volume_scattering = 0.1154700539e1;
    const distinct = 0.2886751347e0;
    const m_base = 0.8660254040e0;
    
    var instance_vertex_position : array<f32,25>;

    instance_vertex_position[0] = gi_radiance * optimized_move_x + t3 * j;
    instance_vertex_position[1] = -t3 * seed_budget_ms - gi_radiance * raw_destructor_signature;
    instance_vertex_position[2] = raw_type * raw_destructor_signature * seed_budget_ms;
    instance_vertex_position[3] = -j * raw_destructor_signature - optimized_move_x * seed_budget_ms;
    instance_vertex_position[4] = optimized_move_x * j - t3 * gi_radiance;
    instance_vertex_position[5] = -gi_radiance * cursor - needs_destructor_signature * j;
    instance_vertex_position[6] = gi_radiance * texture + needs_destructor_signature * seed_budget_ms;
    instance_vertex_position[7] = -raw_type * texture * seed_budget_ms;
    instance_vertex_position[8] = cursor * seed_budget_ms + j * texture;
    instance_vertex_position[9] = -j * cursor + gi_radiance * needs_destructor_signature;
    instance_vertex_position[10] = -fields * (dst + message) + probe_volume_scattering * needs_destructor_signature * cursor;
    instance_vertex_position[11] = fields * (color_texture + redundant) - probe_volume_scattering * needs_destructor_signature * texture;
    instance_vertex_position[12] = -0.5 * (bucket_index_count + num_occluded) + local_total_indirect_diffuse;
    instance_vertex_position[13] = fields * (u8array + meshlet_buckets) - probe_volume_scattering * cursor * texture;
    instance_vertex_position[14] = distinct * (meshlet - allocator_textures + filter_mitchell - rel_name) - fields * (chunk_scene_bounding_box - ve);
    instance_vertex_position[15] = -t3 * cursor - needs_destructor_signature * optimized_move_x;
    instance_vertex_position[16] = t3 * texture + needs_destructor_signature * raw_destructor_signature;
    instance_vertex_position[17] = -raw_type * texture * raw_destructor_signature;
    instance_vertex_position[18] = optimized_move_x * texture + cursor * raw_destructor_signature;
    instance_vertex_position[19] = -optimized_move_x * cursor + t3 * needs_destructor_signature;
    instance_vertex_position[20] = dst - message;
    instance_vertex_position[21] = -redundant + color_texture;
    instance_vertex_position[22] = m_base * (bucket_index_count - num_occluded);
    instance_vertex_position[23] = meshlet_buckets - u8array;
    instance_vertex_position[24] = 0.5 * (rel_name - allocator_textures - meshlet + filter_mitchell);

    for (var chunk_ss_trace_mip = 0; chunk_ss_trace_mip < 5; chunk_ss_trace_mip++) {
        let prim_children = chunk_ss_trace_mip * 5;

        format[4 + chunk_ss_trace_mip] = instance_vertex_position[prim_children + 0] * traced_harmonics[4]
            + instance_vertex_position[prim_children + 1] * traced_harmonics[5]
            + instance_vertex_position[prim_children + 2] * traced_harmonics[6]
            + instance_vertex_position[prim_children + 3] * traced_harmonics[7]
            + instance_vertex_position[prim_children + 4] * traced_harmonics[8]
        ;
    }

    return format;
}


fn get_binary_promise(traced_harmonics: array<f32, 9>) -> vec3<f32>{
    return normalize(vec3<f32>(
        traced_harmonics[3],
        traced_harmonics[1],
        traced_harmonics[2]
    ));
}
    

fn update_score(traced_harmonics:f32, shader_sdf_distance_sqr:f32, optimized_move_x:f32, j:f32, cursor:f32)->f32{
    return (shader_sdf_distance_sqr * traced_harmonics * traced_harmonics + optimized_move_x * traced_harmonics + j) + (cursor * traced_harmonics * sqrt(1.0 - traced_harmonics * traced_harmonics));
}


fn validate_against_device(traced_harmonics:f32, shader_sdf_distance_sqr:f32, optimized_move_x:f32, j:f32)->f32{
    let cursor = (traced_harmonics * traced_harmonics - 1.0) * (j - 2.0 * j * traced_harmonics * traced_harmonics + (optimized_move_x + 2.0 * shader_sdf_distance_sqr * traced_harmonics) * sqrt(1.0 - traced_harmonics * traced_harmonics));
    let t3 = (3.0 * j * traced_harmonics - 2.0 * j * traced_harmonics * traced_harmonics * traced_harmonics - 2.0 * shader_sdf_distance_sqr * pow(max(0,1 - traced_harmonics * traced_harmonics), 1.5));


    return select(cursor, cursor / t3 , abs(t3) > 1e-8);
}


fn build_orthonormal_matrix_n( traced_harmonics : vec3<f32> ) -> mat3x3<f32>{
    var shader_sdf_distance_sqr: vec3<f32>;
    var optimized_move_x: vec3<f32>;
    
    if(traced_harmonics.z < 0.0){
    
        let j = 1.0 / (1.0 - traced_harmonics.z);
        let cursor = traced_harmonics.x * traced_harmonics.y * j;
        
        shader_sdf_distance_sqr = vec3(1.0 - traced_harmonics.x * traced_harmonics.x * j, -cursor, traced_harmonics.x);
        optimized_move_x = vec3(cursor, traced_harmonics.y * traced_harmonics.y * j - 1.0, -traced_harmonics.y);
        
    }else{
        let j = 1.0 / (1.0 + traced_harmonics.z);
        let cursor = -traced_harmonics.x * traced_harmonics.y * j;
        
        shader_sdf_distance_sqr = vec3(1.0 - traced_harmonics.x * traced_harmonics.x * j, cursor, -traced_harmonics.x);
        optimized_move_x = vec3(cursor, 1.0 - traced_harmonics.y * traced_harmonics.y * j, -traced_harmonics.y);
        
    }
    
    return mat3x3(
        shader_sdf_distance_sqr,
        optimized_move_x,
        traced_harmonics
    );
}


fn v3_normalize_tetrahedral_barycentric(traced_harmonics:array<f32, 9>) -> f32{

    let shader_sdf_distance_sqr = get_binary_promise(traced_harmonics);
    
    let optimized_move_x = build_orthonormal_matrix_n(shader_sdf_distance_sqr);

    let j = transpose(optimized_move_x);

    let cursor = fit_rotation_curves(traced_harmonics, j);




    let t3 = SH3_COEFFICIENTS[8] * sqrt(cursor[8] * cursor[8] + cursor[4] * cursor[4]);


    let gi_radiance = 3 * SH3_COEFFICIENTS[6] * cursor[6] + t3;
    let needs_destructor_signature = SH3_COEFFICIENTS[2] * cursor[2];
    let raw_destructor_signature = SH3_COEFFICIENTS[0] * cursor[0] - SH3_COEFFICIENTS[6] * cursor[6] - t3;

    let seed_budget_ms = -needs_destructor_signature / (2.0 * gi_radiance);
    let texture = gi_radiance * seed_budget_ms * seed_budget_ms + needs_destructor_signature * seed_budget_ms + raw_destructor_signature;
    let format = min(gi_radiance + needs_destructor_signature + raw_destructor_signature, gi_radiance - needs_destructor_signature + raw_destructor_signature);

    var dst:f32;
    
    if(gi_radiance > 0 && seed_budget_ms >= -1 && seed_budget_ms <= 1){
        dst= texture ;
    } else{
        dst= format;
    }


    let message = SH3_COEFFICIENTS[4] * sqrt(cursor[5] * cursor[5] + cursor[7] * cursor[7]);


    var color_texture = dst - 0.5 * message;

    if (color_texture < 0) {



        var redundant:f32;
        var bucket_index_count = -SQRT1_2;
        
        const local_total_indirect_diffuse = 8;
        
        for(var num_occluded=0; num_occluded < local_total_indirect_diffuse; num_occluded++){
        
            color_texture = update_score(bucket_index_count, gi_radiance, needs_destructor_signature, raw_destructor_signature, message);
            redundant = validate_against_device(bucket_index_count, gi_radiance, needs_destructor_signature, message);
            bucket_index_count = bucket_index_count - redundant;
            

            
            if(abs(bucket_index_count) > 1.0 || abs(redundant) <= 1e-5){
                break;
            }
            
        }

        if (abs(bucket_index_count) > 1) {

            color_texture = min(update_score(1, gi_radiance, needs_destructor_signature, raw_destructor_signature, message), update_score(-1, gi_radiance, needs_destructor_signature, raw_destructor_signature, message));
        }
    }

    return color_texture;
}


fn set_viewport_size(traced_harmonics: array<vec3<f32>,9>) -> array< array<f32,9>, 3 >{
    var shader_sdf_distance_sqr:array<array<f32,9>,3>;
    
    for(var optimized_move_x = 0; optimized_move_x<9; optimized_move_x++){
        
        for(var j = 0; j < 3; j++){
       
            shader_sdf_distance_sqr[j][optimized_move_x] = traced_harmonics[optimized_move_x][ j ];
        
        }
        
    }
    
    return shader_sdf_distance_sqr;
}
    

fn gpu_test( 
    traced_harmonics: array<f32, 9>,
    shader_sdf_distance_sqr: array<f32, 9>,
    optimized_move_x: array<f32, 9>
) -> array< vec3<f32>, 9 >{
    var j:array< vec3<f32>, 9 >;
    
    const cursor = 3;
    
    for(var t3 = 0; t3<9; t3++){
        
        j[ t3 ].x = traced_harmonics[t3];
        j[ t3 ].y = shader_sdf_distance_sqr[t3];
        j[ t3 ].z = optimized_move_x[t3];
        
    }
    
    return j;
}
    

fn sh3_color_dering_optimize_positive(traced_harmonics: array<vec3<f32>,9>)-> array<vec3<f32>, 9>{
    const shader_sdf_distance_sqr = 3;
    const optimized_move_x = 3;
    

    const j = 24;
    

    var cursor = f32( shader_sdf_distance_sqr * 4 + 1);
    

    let t3 = set_viewport_size(traced_harmonics);
        
    for(var gi_radiance=0; gi_radiance < optimized_move_x; gi_radiance++){
        

        var needs_destructor_signature = f32(shader_sdf_distance_sqr);
        var raw_destructor_signature = cursor;
        
        var seed_budget_ms = t3[gi_radiance];

        for (var texture = 0; texture < j && (needs_destructor_signature + 0.1) < raw_destructor_signature; texture++) {

            let format = 0.5 * (needs_destructor_signature + raw_destructor_signature);

            let dst = stats(t3[gi_radiance], format);

            if (v3_normalize_tetrahedral_barycentric(dst) < 0.0) {
                raw_destructor_signature = format;
            } else {
                needs_destructor_signature = format;
            }

        }


        cursor = min(cursor, needs_destructor_signature);
        
    }
    

    var message:array<array<f32,9>,3>;
        
    for(var gi_radiance = 0; gi_radiance< 3; gi_radiance++){
        message[gi_radiance] = stats(t3[gi_radiance], cursor);
    }
    
    return gpu_test(message[0], message[1], message[2]);
}


    
@group(0) @binding(0) var<uniform> lpv_metadata:GpuCommandRecorder;
@group(0) @binding(1) var<storage,read_write> end:array<Uint32Buffer>;

@group(1) @binding(0) var<uniform> settings:Struct_34;

@compute @workgroup_size(256,1,1)
fn main(
    @builtin(global_invocation_id) traced_harmonics : vec3<u32>,
    @builtin(local_invocation_id) shader_sdf_distance_sqr : vec3<u32>,
){

    let optimized_move_x = (traced_harmonics.x + settings.start) % lpv_metadata.probe_count;

    var j = end[optimized_move_x].coefficients;
    
    end[optimized_move_x].coefficients = sh3_color_dering_optimize_positive(j);
}
    `;

export const PROBE_LEGACY_BAKE_WGSL = /* wgsl */ `
fn f32_array_as_vec3(traced_harmonics: array< f32, 3 > ) -> vec3<f32>{
    return vec3<f32>(
        traced_harmonics[0], traced_harmonics[1], traced_harmonics[2]
    );
}
struct OrthographicCameraManager{
    shading_normal : vec3<f32>,
    geometric_normal : vec3<f32>,
    position : vec3<f32>,
    view_direction : vec3<f32>,
}
struct UvUnwrapper{
    diffuse : vec3<f32>,
    roughness : f32,
    occlusion : f32,
    specularF0 : vec3<f32>,
    specularF90 : f32,
    emissive : vec3<f32>,
    opacity : f32,
}
struct Struct_41{
    irradiance : vec3<f32>,
    distance : f32,
    bounces : u32,
}
const RECIPROCAL_PI : f32 = 0.318309886183790671537767526745028724;

fn hash_vec2f_to_vec3f(traced_harmonics:vec2<f32>) -> vec3<f32>{

    let shader_sdf_distance_sqr = vec2<u32>(traced_harmonics * 16777215.0);
    

    
    let optimized_move_x = shader_sdf_distance_sqr.x & 0xFFFFu; 
    let j = ((shader_sdf_distance_sqr.x >> 16u) & 0xFFu) | ((shader_sdf_distance_sqr.y & 0xFFu) << 8u);
    let cursor = (shader_sdf_distance_sqr.y >> 8u) & 0xFFFFu; 
    

    return vec3<f32>(
        f32(optimized_move_x) / 65535.0,
        f32(j) / 65535.0,
        f32(cursor) / 65535.0
    );
}
    
struct Struct_37{
    direction : vec3<f32>,
    distance : f32,
    emission : vec3<f32>,
    pdf : f32,
}
struct Struct_38{
    index : u32,
    pdf : f32,
    light_type : u32,
}

const POINT_LIGHTS_PAGE_LIMIT: u32 = 4096u;
const POINT_LIGHTS_OCCUPANCY_BITMAP_WORDS: u32 = 86u;
const POINT_LIGHTS_ELEMENTS_PER_PAGE: u32 = 2723u;

fn point_lights_page_address(traced_harmonics: ptr<storage, array<u32>, read>, shader_sdf_distance_sqr: u32) -> u32 {
    return traced_harmonics[shader_sdf_distance_sqr + 0u];
}

fn point_lights_page_bitmap_word(traced_harmonics: ptr<storage, array<u32>, read>, shader_sdf_distance_sqr: u32, optimized_move_x: u32) -> u32 {

    return traced_harmonics[shader_sdf_distance_sqr + 1u + optimized_move_x];
}

fn point_lights_slot_to_index(traced_harmonics: u32, shader_sdf_distance_sqr: u32) -> u32 {
    return traced_harmonics * 2723u + shader_sdf_distance_sqr;
}
    

const SPOT_LIGHTS_PAGE_LIMIT: u32 = 4096u;
const SPOT_LIGHTS_OCCUPANCY_BITMAP_WORDS: u32 = 64u;
const SPOT_LIGHTS_ELEMENTS_PER_PAGE: u32 = 2043u;

fn spot_lights_page_address(traced_harmonics: ptr<storage, array<u32>, read>, shader_sdf_distance_sqr: u32) -> u32 {
    return traced_harmonics[shader_sdf_distance_sqr + 8192u];
}

fn spot_lights_page_bitmap_word(traced_harmonics: ptr<storage, array<u32>, read>, shader_sdf_distance_sqr: u32, optimized_move_x: u32) -> u32 {

    return traced_harmonics[shader_sdf_distance_sqr + 1u + optimized_move_x];
}

fn spot_lights_slot_to_index(traced_harmonics: u32, shader_sdf_distance_sqr: u32) -> u32 {
    return traced_harmonics * 2043u + shader_sdf_distance_sqr;
}
    

fn directional_lights_iteration_mask(traced_harmonics: ptr<storage, array<u32>, read>) -> u32 {
    let shader_sdf_distance_sqr = traced_harmonics[4096u];
    if (shader_sdf_distance_sqr == ~0u) {
        return 0u;
    }

    return traced_harmonics[shader_sdf_distance_sqr + 1u];
}
    
struct AtlasPacker{
    position : vec3<f32>,
    distance : f32,
    color : vec3<f32>,
    radius : f32,
    flags : u32,
    near_clip_distance : f32,
    shadow_id : u32,
}
fn database_read_AtlasPacker_0_2723_element(database: ptr<storage, array<u32>>, index: u32) -> AtlasPacker {
    let page_index = index / 2723u;
    let page_offset = index % 2723u;
    let page_lookup_index = page_index + 0u;
    let page_address = database[page_lookup_index];
    let base_offset = page_address + 87u + page_offset * 12u;
    return AtlasPacker(
        vec3<f32>(
            bitcast<f32>(database[base_offset + 0]), 
            bitcast<f32>(database[base_offset + 1]), 
            bitcast<f32>(database[base_offset + 2])),
        bitcast<f32>(database[base_offset + 3]),
        vec3<f32>(
            bitcast<f32>(database[base_offset + 4]), 
            bitcast<f32>(database[base_offset + 5]), 
            bitcast<f32>(database[base_offset + 6])),
        bitcast<f32>(database[base_offset + 7]),
        u32(database[base_offset + 8]),
        bitcast<f32>(database[base_offset + 9]),
        u32(database[base_offset + 10])
    );
}
struct Struct_2{
    position : vec3<f32>,
    distance : f32,
    direction : vec3<f32>,
    radius : f32,
    color : vec3<f32>,
    coneCos : f32,
    penumbraCos : f32,
    flags : u32,
    near_clip_distance : f32,
    shadow_id : u32,
}
fn database_read_Struct_2_2_2043_element(database: ptr<storage, array<u32>>, index: u32) -> Struct_2 {
    let page_index = index / 2043u;
    let page_offset = index % 2043u;
    let page_lookup_index = page_index + 8192u;
    let page_address = database[page_lookup_index];
    let base_offset = page_address + 65u + page_offset * 16u;
    return Struct_2(
        vec3<f32>(
            bitcast<f32>(database[base_offset + 0]), 
            bitcast<f32>(database[base_offset + 1]), 
            bitcast<f32>(database[base_offset + 2])),
        bitcast<f32>(database[base_offset + 3]),
        vec3<f32>(
            bitcast<f32>(database[base_offset + 4]), 
            bitcast<f32>(database[base_offset + 5]), 
            bitcast<f32>(database[base_offset + 6])),
        bitcast<f32>(database[base_offset + 7]),
        vec3<f32>(
            bitcast<f32>(database[base_offset + 8]), 
            bitcast<f32>(database[base_offset + 9]), 
            bitcast<f32>(database[base_offset + 10])),
        bitcast<f32>(database[base_offset + 11]),
        bitcast<f32>(database[base_offset + 12]),
        u32(database[base_offset + 13]),
        bitcast<f32>(database[base_offset + 14]),
        u32(database[base_offset + 15])
    );
}
struct GpuSceneManager{
    direction : vec3<f32>,
    disk_radius : f32,
    color : vec3<f32>,
    flags : u32,
    near_clip_distance : f32,
    shadow_id : u32,
}
fn database_read_GpuSceneManager_1_2723_element(database: ptr<storage, array<u32>>, index: u32) -> GpuSceneManager {
    let page_index = index / 2723u;
    let page_offset = index % 2723u;
    let page_lookup_index = page_index + 4096u;
    let page_address = database[page_lookup_index];
    let base_offset = page_address + 87u + page_offset * 12u;
    return GpuSceneManager(
        vec3<f32>(
            bitcast<f32>(database[base_offset + 0]), 
            bitcast<f32>(database[base_offset + 1]), 
            bitcast<f32>(database[base_offset + 2])),
        bitcast<f32>(database[base_offset + 3]),
        vec3<f32>(
            bitcast<f32>(database[base_offset + 4]), 
            bitcast<f32>(database[base_offset + 5]), 
            bitcast<f32>(database[base_offset + 6])),
        u32(database[base_offset + 7]),
        bitcast<f32>(database[base_offset + 8]),
        u32(database[base_offset + 9])
    );
}

fn pow4(traced_harmonics:f32)->f32{
    let shader_sdf_distance_sqr = traced_harmonics*traced_harmonics;
    return shader_sdf_distance_sqr*shader_sdf_distance_sqr;
}


fn light_get_spot_attenuation( traced_harmonics:f32, shader_sdf_distance_sqr:f32,  optimized_move_x:f32 ) -> f32{
    return smoothstep( traced_harmonics, shader_sdf_distance_sqr, optimized_move_x );
}
    

fn rgb_to_luminance(traced_harmonics: vec3f) -> f32 {
    
    const shader_sdf_distance_sqr = vec3f(0.212639005871510, 0.715168678767756, 0.072192315360734);
    
    return dot(
        traced_harmonics,
        shader_sdf_distance_sqr
    );
    
}


fn light_importance_directional(
    traced_harmonics: GpuSceneManager,
    shader_sdf_distance_sqr: vec3<f32>,
    optimized_move_x: vec3<f32>
) -> f32 {
    let j = max(0.0, dot(optimized_move_x, -traced_harmonics.direction));
    return rgb_to_luminance(traced_harmonics.color) * j;
}
    

fn oren_nayar_fujii_diffuse_dir_albedo(traced_harmonics: f32, shader_sdf_distance_sqr: f32, optimized_move_x: f32) -> f32 {
    let j = 1.0 - traced_harmonics;
    

    const cursor = 0.0571085289;
    const t3 = 0.491881867;
    const gi_radiance = -0.332181442;
    const needs_destructor_signature = 0.0714429953;


    let raw_destructor_signature = fma(j, needs_destructor_signature, gi_radiance);
    let seed_budget_ms = fma(j, raw_destructor_signature, t3);
    let texture = fma(j, seed_budget_ms, cursor);
    let format = j * texture;


    return optimized_move_x * fma(shader_sdf_distance_sqr, format, 1.0);
}    
    

fn oren_nayar_fujii_diffuse_avg_albedo(roughness: f32, A: f32) -> f32 {
    return A * fma(0.07248821245692394, roughness, 1.0);
}
    

fn oren_nayar_compensated_diffuse(
    NoV: f32, 
    NoL: f32, 
    LoV: f32, 
    roughness: f32, 
    color: vec3f
) -> vec3f {


    let A = 1.0 / fma(0.2877934092108062, roughness, 1.0);
                            

    let dirAlbedoV = oren_nayar_fujii_diffuse_dir_albedo(NoV, roughness, A);
    let dirAlbedoL = oren_nayar_fujii_diffuse_dir_albedo(NoL, roughness, A);
    let avgAlbedo = oren_nayar_fujii_diffuse_avg_albedo(roughness, A);

    let s = LoV - NoL * NoV;
    let stinv = select(s, s / max(1e-7, max(NoL, NoV)), s > 0.0);
    
    let lobeSingleScatter = color * A * fma(roughness, stinv, 1.0);
    
    let color2 = color * color;
    let colorMultiScatter = color2 * avgAlbedo /
                            (vec3f(1.0) - color * max(0.0, 1.0 - avgAlbedo));
   
    const M_FLOAT_EPS = 1e-8;
    
    let lobeMultiScatter = colorMultiScatter *
                           max(M_FLOAT_EPS, 1.0 - dirAlbedoV) *
                           max(M_FLOAT_EPS, 1.0 - dirAlbedoL) /
                           max(M_FLOAT_EPS, 1.0 - avgAlbedo);


    return lobeSingleScatter + lobeMultiScatter;
}
    
struct Struct_40{
    albedo : vec3<f32>,
    opacity : f32,
    roughness : f32,
    metalness : f32,
    transmission : f32,
    ior : f32,
    emissive : vec3<f32>,
    normal_shading : vec3<f32>,
    normal_geometric : vec3<f32>,
}

fn interpolate_attribute_4f32(traced_harmonics:vec4<f32>, shader_sdf_distance_sqr:vec4<f32>, optimized_move_x:vec4<f32>, j:vec3<f32>)->vec4<f32>{

    return vec4<f32>(
        traced_harmonics[0] * j.x + shader_sdf_distance_sqr[0] * j.y + optimized_move_x[0] * j.z,
        traced_harmonics[1] * j.x + shader_sdf_distance_sqr[1] * j.y + optimized_move_x[1] * j.z,
        traced_harmonics[2] * j.x + shader_sdf_distance_sqr[2] * j.y + optimized_move_x[2] * j.z,
        traced_harmonics[3] * j.x + shader_sdf_distance_sqr[3] * j.y + optimized_move_x[3] * j.z,
    );

}

fn compute_normal_matrix_from_m4( traced_harmonics: mat4x4<f32> ) -> mat3x3<f32>{
    let shader_sdf_distance_sqr = traced_harmonics[0].xyz;
    let optimized_move_x = traced_harmonics[1].xyz;
    let j = traced_harmonics[2].xyz;
    
    return mat3x3<f32>(
        cross(optimized_move_x, j),
        cross(j, shader_sdf_distance_sqr),
        cross(shader_sdf_distance_sqr, optimized_move_x)
    );
}


fn build_orthonormal_matrix_nt(
    traced_harmonics:vec3<f32>,
    shader_sdf_distance_sqr:vec4<f32>
) -> mat3x3<f32>{
    let optimized_move_x = shader_sdf_distance_sqr.xyz;
    

    let j = normalize(optimized_move_x - traced_harmonics * dot(traced_harmonics, optimized_move_x));
    
    let cursor = normalize(cross(traced_harmonics, j) * shader_sdf_distance_sqr.w);

    return mat3x3(
        j,
        cursor,
        traced_harmonics
    );
    
}


fn texture_octahedral_wrap_texel_coordinates(traced_harmonics:vec2<i32>, shader_sdf_distance_sqr:i32) -> vec2<u32>{
    let optimized_move_x = ((traced_harmonics % shader_sdf_distance_sqr) + shader_sdf_distance_sqr) % shader_sdf_distance_sqr;

    let j = abs(traced_harmonics.x / shader_sdf_distance_sqr) + i32(traced_harmonics.x < 0);
    let cursor = abs(traced_harmonics.y / shader_sdf_distance_sqr) + i32(traced_harmonics.y < 0);

    let t3 = ((j ^ cursor) & 1) != 0;
    
    return select(
        vec2<u32>(optimized_move_x),
        vec2<u32>(shader_sdf_distance_sqr - (optimized_move_x + vec2(1))),
        t3,
    );
    
}


fn get_bilinear_weights(traced_harmonics:vec2<f32>) -> vec4<f32>{
    
    let shader_sdf_distance_sqr = traced_harmonics.x;
    let optimized_move_x = traced_harmonics.y;
    
    let j = ( 1.0 - shader_sdf_distance_sqr );
    let cursor = ( 1.0 - optimized_move_x );
    
    return vec4(
        j * cursor,
        shader_sdf_distance_sqr * cursor,
        j * optimized_move_x,
        shader_sdf_distance_sqr * optimized_move_x
    );
}


fn uv_to_texel_coordinate(
    traced_harmonics: vec2<f32>,
    shader_sdf_distance_sqr: vec2<u32>
) -> vec2<f32> {
    return fma(traced_harmonics, vec2<f32>(shader_sdf_distance_sqr), vec2(-0.5));
}


fn pow2(traced_harmonics:f32)->f32{
    return traced_harmonics*traced_harmonics;
}


fn max_v3(traced_harmonics: vec3<f32>) -> f32{
    return max(traced_harmonics.x, max(traced_harmonics.y, traced_harmonics.z));
}
    

fn russian_roulette(
   traced_harmonics: u32,
   shader_sdf_distance_sqr: u32,
   optimized_move_x : ptr< function, vec3<f32> >,
) -> bool{

    if(traced_harmonics == shader_sdf_distance_sqr - 1){

        return true;
    }

    if(traced_harmonics == 0){

        return false;
    }
    
    let j = saturate(max_v3(*optimized_move_x));
    let cursor = random();
    
    if(cursor > j){
        return true;
    }
    
    *optimized_move_x /= j;
    return false;
}
    

fn shadow_terminator_term(traced_harmonics: vec3<f32>, shader_sdf_distance_sqr: vec3<f32>, optimized_move_x: vec3<f32>) -> f32{

    let j: f32 = 0.05;


    let cursor: f32 = mix(sin(j + 0.1), sin(j), dot(optimized_move_x, shader_sdf_distance_sqr));


    let t3: f32 = max(0.0, min(1.0, dot(shader_sdf_distance_sqr, traced_harmonics) / cursor));


    return smoothstep(0.0, 1.0, t3);
}
    

fn v3_matrix4_rotate(traced_harmonics:vec3<f32>, shader_sdf_distance_sqr: mat4x4<f32>) -> vec3<f32>{

     return normalize(
         shader_sdf_distance_sqr[0].xyz * traced_harmonics.x
       + shader_sdf_distance_sqr[1].xyz * traced_harmonics.y 
       + shader_sdf_distance_sqr[2].xyz * traced_harmonics.z 
    );

}

const BVH_NULL_NODE = 4294967295u;

fn max4(traced_harmonics:f32, shader_sdf_distance_sqr:f32, optimized_move_x:f32, j:f32) -> f32 {
    return max( max(traced_harmonics, shader_sdf_distance_sqr), max(optimized_move_x, j) );
}


fn min4(traced_harmonics:f32, shader_sdf_distance_sqr:f32, optimized_move_x:f32, j:f32) -> f32 {
    return min( min(traced_harmonics, shader_sdf_distance_sqr), min(optimized_move_x, j) );
}


fn aabb3_intersects_ray(
    traced_harmonics:array<f32, 6>,
    shader_sdf_distance_sqr:vec3<f32>,
    optimized_move_x:vec3<f32>,
    j: f32,
) -> bool{
    let cursor = vec3(traced_harmonics[0], traced_harmonics[1], traced_harmonics[2]);
    let t3 = vec3(traced_harmonics[3], traced_harmonics[4], traced_harmonics[5]);


    let gi_radiance = (cursor - shader_sdf_distance_sqr) * optimized_move_x;
    let needs_destructor_signature = (t3 - shader_sdf_distance_sqr) * optimized_move_x;
    
    let raw_destructor_signature = min(gi_radiance, needs_destructor_signature);
    let seed_budget_ms = max(gi_radiance, needs_destructor_signature);
    
    let texture = min4(j, seed_budget_ms.x, seed_budget_ms.y, seed_budget_ms.z);
    let format = max4(0.0, raw_destructor_signature.x, raw_destructor_signature.y, raw_destructor_signature.z);
    
    return texture >= format;

}
const EPSILON  :f32 = 1e-6;
struct Bvh8{
    origin : vec3<f32>,
    direction : vec3<f32>,
    tmax : f32,
}

fn ray_triangle_compute_intersection_barycentric(
        traced_harmonics: ptr< function, vec3<f32>>,
        shader_sdf_distance_sqr:Bvh8, 
        optimized_move_x:vec3<f32>, j:vec3<f32>, cursor:vec3<f32>
) -> bool {
    let t3 = j - optimized_move_x;
    let gi_radiance = cursor - optimized_move_x;

    let needs_destructor_signature = cross(shader_sdf_distance_sqr.direction, gi_radiance);
    
    let raw_destructor_signature = dot(t3, needs_destructor_signature);
    
    if(abs(raw_destructor_signature) < EPSILON ){

        return false;
    }
    
    let seed_budget_ms = 1.0 / raw_destructor_signature;
    
    let texture = shader_sdf_distance_sqr.origin - optimized_move_x;
    
    let format = dot(texture, needs_destructor_signature) * seed_budget_ms;
    
    if(format < 0.0 || format > 1.0){

        return false;
    }
    
    let dst = cross(texture, t3);
    
    let message = dot(shader_sdf_distance_sqr.direction, dst) * seed_budget_ms;
    
    if(message < 0.0 || format + message > 1.0){

        return false;
    }
    

    let color_texture = dot(gi_radiance, dst) * seed_budget_ms;
    
    if(color_texture <= EPSILON ){

        return false;
    }
    
    *traced_harmonics = vec3(format, message, color_texture);
    
    return color_texture < shader_sdf_distance_sqr.tmax;
}
  

fn mat4_inverse(traced_harmonics: mat4x4<f32>)->mat4x4<f32>{

    let shader_sdf_distance_sqr = traced_harmonics[0][0];
    let optimized_move_x = traced_harmonics[0][1];
    let j = traced_harmonics[0][2];
    let cursor = traced_harmonics[0][3];
    
    let t3 = traced_harmonics[1][0];
    let gi_radiance = traced_harmonics[1][1];
    let needs_destructor_signature = traced_harmonics[1][2];
    let raw_destructor_signature = traced_harmonics[1][3];
    
    let seed_budget_ms = traced_harmonics[2][0];
    let texture = traced_harmonics[2][1];
    let format = traced_harmonics[2][2];
    let dst = traced_harmonics[2][3];
    
    let message = traced_harmonics[3][0];
    let color_texture = traced_harmonics[3][1];
    let redundant = traced_harmonics[3][2];
    let bucket_index_count = traced_harmonics[3][3];
    
    let local_total_indirect_diffuse = shader_sdf_distance_sqr * gi_radiance - optimized_move_x * t3;
    let num_occluded = shader_sdf_distance_sqr * needs_destructor_signature - j * t3;
    let u8array = shader_sdf_distance_sqr * raw_destructor_signature - cursor * t3;
    let meshlet_buckets = optimized_move_x * needs_destructor_signature - j * gi_radiance;
    let result = optimized_move_x * raw_destructor_signature - cursor * gi_radiance;
    let allocator_textures = j * raw_destructor_signature - cursor * needs_destructor_signature;
    let meshlet = seed_budget_ms * color_texture - texture * message;
    let filter_mitchell = seed_budget_ms * redundant - format * message;
    let rel_name = seed_budget_ms * bucket_index_count - dst * message;
    let chunk_scene_bounding_box = texture * redundant - format * color_texture;
    let ve = texture * bucket_index_count - dst * color_texture;
    let raw_type = format * bucket_index_count - dst * redundant;


    let fields =
        local_total_indirect_diffuse * raw_type - num_occluded * ve + u8array * chunk_scene_bounding_box + meshlet_buckets * rel_name - result * filter_mitchell + allocator_textures * meshlet;

    let probe_volume_scattering = 1.0 / fields;

    return mat4x4(
        (gi_radiance * raw_type - needs_destructor_signature * ve + raw_destructor_signature * chunk_scene_bounding_box) * probe_volume_scattering,
        (j * ve - optimized_move_x * raw_type - cursor * chunk_scene_bounding_box) * probe_volume_scattering,
        (color_texture * allocator_textures - redundant * result + bucket_index_count * meshlet_buckets) * probe_volume_scattering,
        (format * result - texture * allocator_textures - dst * meshlet_buckets) * probe_volume_scattering,
        
        (needs_destructor_signature * rel_name - t3 * raw_type - raw_destructor_signature * filter_mitchell) * probe_volume_scattering,
        (shader_sdf_distance_sqr * raw_type - j * rel_name + cursor * filter_mitchell) * probe_volume_scattering,
        (redundant * u8array - message * allocator_textures - bucket_index_count * num_occluded) * probe_volume_scattering,
        (seed_budget_ms * allocator_textures - format * u8array + dst * num_occluded) * probe_volume_scattering,
        
        (t3 * ve - gi_radiance * rel_name + raw_destructor_signature * meshlet) * probe_volume_scattering,
        (optimized_move_x * rel_name - shader_sdf_distance_sqr * ve - cursor * meshlet) * probe_volume_scattering,
        (message * result - color_texture * u8array + bucket_index_count * local_total_indirect_diffuse) * probe_volume_scattering,
        (texture * u8array - seed_budget_ms * result - dst * local_total_indirect_diffuse) * probe_volume_scattering,
        
        (gi_radiance * filter_mitchell - t3 * chunk_scene_bounding_box - needs_destructor_signature * meshlet) * probe_volume_scattering,
        (shader_sdf_distance_sqr * chunk_scene_bounding_box - optimized_move_x * filter_mitchell + j * meshlet) * probe_volume_scattering,
        (color_texture * num_occluded - message * meshlet_buckets - redundant * local_total_indirect_diffuse) * probe_volume_scattering,
        (seed_budget_ms * meshlet_buckets - texture * num_occluded + format * local_total_indirect_diffuse) * probe_volume_scattering,
    );
}
    
struct Struct_36{
    barycentrics : vec2<f32>,
    triangle : u32,
    geometry : u32,
    instance : u32,
    t : f32,
}

fn meshlet_compute_attribute_section_offset(
    traced_harmonics: Struct_0, 
) -> u32{
    

    
    let shader_sdf_distance_sqr = ( traced_harmonics.primitive_count * 3u  + 3u) >> 2u;
    
    return traced_harmonics.address + shader_sdf_distance_sqr;
    
}
    

fn read_meshlet_attribute_vec3f(traced_harmonics:u32) -> vec3f{    
    return vec3(
        history_raw_type[traced_harmonics],
        history_raw_type[traced_harmonics + 1],
        history_raw_type[traced_harmonics + 2],
    );
}
    

fn read_meshlet_attribute_vec2f(traced_harmonics:u32) -> vec2f{    
    return vec2(
        history_raw_type[traced_harmonics],
        history_raw_type[traced_harmonics+1],
    );
}
    

fn decode_vertex_color(traced_harmonics : u32) -> vec3<f32>{
    return unpack4x8unorm(traced_harmonics).xyz;
}
    
struct Struct_0{
    bounds_box : array< f32, 6 >,
    address : u32,
    primitive_count : u32,
    vertex_count : u32,
    flags : u32,
}

fn read_meshlet_attribute_u32(traced_harmonics:u32) -> u32{    
    return bitcast<u32>( history_raw_type[traced_harmonics] );
}
    

fn read_meshlet_resolved_index(
    traced_harmonics: Struct_0, 
    shader_sdf_distance_sqr: u32,
) -> u32{
    
    let optimized_move_x = shader_sdf_distance_sqr >> 2u;
    

    let j = ( shader_sdf_distance_sqr & 0x03u ) << 3;
    
    let cursor = read_meshlet_attribute_u32(traced_harmonics.address + optimized_move_x);
    

    return (cursor >> j) & 0xFF;    
}
    

fn decode_meshlet_element(traced_harmonics: u32) -> vec2u{
    return vec2u(
        (traced_harmonics >> 8),
        (traced_harmonics & 0xFF)
    );
}
    
struct Struct_39{
    opacity : f32,
    geometric_normal : vec3<f32>,
    position : vec3<f32>,
}
struct GpuAnimationManager{
    position : vec3<f32>,
    normal : vec3<f32>,
    tangent : vec4<f32>,
    uv : vec2<f32>,
    uv1 : vec2<f32>,
    color : vec3<f32>,
}
struct Struct_35{
    a : GpuAnimationManager,
    b : GpuAnimationManager,
    c : GpuAnimationManager,
}

fn coordinate_wrap_repeat(traced_harmonics: f32, shader_sdf_distance_sqr: f32) -> f32{
    return fract( traced_harmonics / shader_sdf_distance_sqr ) * shader_sdf_distance_sqr;
}    
    

fn compute_triangle_face_normal(
    traced_harmonics: vec3<f32>,
    shader_sdf_distance_sqr: vec3<f32>,
    optimized_move_x: vec3<f32>,
) -> vec3<f32> {

    let j = optimized_move_x - shader_sdf_distance_sqr;
    let cursor = traced_harmonics - shader_sdf_distance_sqr;
    
    let t3 = cross(j, cursor);

    return normalize(t3);
    
}
    

fn v3_matrix4_project(traced_harmonics: vec3<f32>, shader_sdf_distance_sqr: mat4x4<f32>) -> vec3<f32>{
   
    let optimized_move_x = shader_sdf_distance_sqr * vec4<f32>(traced_harmonics, 1.0);
    

    return optimized_move_x.xyz / optimized_move_x.w ;
    
}


fn interpolate_attribute_3f32(
    traced_harmonics:vec3<f32>,
    shader_sdf_distance_sqr:vec3<f32>,
    optimized_move_x:vec3<f32>,
    j:vec3<f32>
) -> vec3<f32>{

    return vec3<f32>(
        traced_harmonics[0] * j.x + shader_sdf_distance_sqr[0] * j.y + optimized_move_x[0] * j.z,
        traced_harmonics[1] * j.x + shader_sdf_distance_sqr[1] * j.y + optimized_move_x[1] * j.z,
        traced_harmonics[2] * j.x + shader_sdf_distance_sqr[2] * j.y + optimized_move_x[2] * j.z,
    );

}

fn interpolate_attribute_2f32(traced_harmonics:vec2<f32>,shader_sdf_distance_sqr:vec2<f32>,optimized_move_x:vec2<f32>, j:vec3<f32>)->vec2<f32>{

    return vec2<f32>(
        traced_harmonics[0] * j.x + shader_sdf_distance_sqr[0] * j.y + optimized_move_x[0] * j.z,
        traced_harmonics[1] * j.x + shader_sdf_distance_sqr[1] * j.y + optimized_move_x[1] * j.z,
    );

}

fn dielectric_specular_color(traced_harmonics: f32, shader_sdf_distance_sqr: f32, optimized_move_x: vec3<f32>) -> vec3<f32> {
    let j = (traced_harmonics - 1.0) / (traced_harmonics + 1.0);
    let cursor = vec3<f32>(j * j);
    return mix(cursor, optimized_move_x, shader_sdf_distance_sqr);
}
    

fn F_Hauber( traced_harmonics: vec3<f32>, shader_sdf_distance_sqr: f32, optimized_move_x: f32 ) -> vec3<f32> {
	let j = 1.0 - optimized_move_x;
    let cursor = j * j;
    let t3 = cursor * cursor;
	
	let gi_radiance = vec3(shader_sdf_distance_sqr - optimized_move_x);
	
	return mix( traced_harmonics, gi_radiance, t3 );
}
    

fn offset_ray(traced_harmonics: vec3<f32>, shader_sdf_distance_sqr:vec3<f32>) -> vec3<f32>{
    const optimized_move_x = 1.0f / 32.0f;
    const j = 1.0f / 65536.0f;
    const cursor = 256.0f;

    var t3 = vec3<i32>(cursor * shader_sdf_distance_sqr);

    let gi_radiance = bitcast<vec3<f32>>(
        bitcast<vec3<i32>>(traced_harmonics) + select(t3, -t3,  traced_harmonics < vec3(0))
    );
    
    let needs_destructor_signature = fma(vec3(j), shader_sdf_distance_sqr, traced_harmonics);
    
    return select(gi_radiance, needs_destructor_signature, abs(traced_harmonics) < vec3(optimized_move_x));
}

struct CascadedSceneShadowmap{
    bounding_sphere : vec4<f32>,
    bounding_box : array< f32, 6 >,
    geometry : u32,
    material : u32,
    node : u32,
}
fn database_read_CascadedSceneShadowmap_0_2043_element(database: ptr<storage, array<u32>>, index: u32) -> CascadedSceneShadowmap {
    let page_index = index / 2043u;
    let page_offset = index % 2043u;
    let page_lookup_index = page_index + 0u;
    let page_address = database[page_lookup_index];
    let base_offset = page_address + 65u + page_offset * 16u;
    return CascadedSceneShadowmap(
        vec4<f32>(
            bitcast<f32>(database[base_offset + 0]), 
            bitcast<f32>(database[base_offset + 1]), 
            bitcast<f32>(database[base_offset + 2]), 
            bitcast<f32>(database[base_offset + 3])),
        array< f32, 6 >(
            bitcast<f32>(database[base_offset + 4]),
            bitcast<f32>(database[base_offset + 5]),
            bitcast<f32>(database[base_offset + 6]),
            bitcast<f32>(database[base_offset + 7]),
            bitcast<f32>(database[base_offset + 8]),
            bitcast<f32>(database[base_offset + 9])
        ),
        u32(database[base_offset + 10]),
        u32(database[base_offset + 11]),
        u32(database[base_offset + 12])
    );
}
struct Struct_10{
    local_rotation : vec4<f32>,
    global : mat4x4<f32>,
    prev_global : mat4x4<f32>,
    local_translation : vec3<f32>,
    parent : u32,
    local_scale : vec3<f32>,
}
fn database_read_Struct_10_1_744_element(database: ptr<storage, array<u32>>, index: u32) -> Struct_10 {
    let page_index = index / 744u;
    let page_offset = index % 744u;
    let page_lookup_index = page_index + 4096u;
    let page_address = database[page_lookup_index];
    let base_offset = page_address + 25u + page_offset * 44u;
    return Struct_10(
        vec4<f32>(
            bitcast<f32>(database[base_offset + 0]), 
            bitcast<f32>(database[base_offset + 1]), 
            bitcast<f32>(database[base_offset + 2]), 
            bitcast<f32>(database[base_offset + 3])),
        mat4x4<f32>(
            vec4<f32>(
                bitcast<f32>(database[base_offset + 4]), 
                bitcast<f32>(database[base_offset + 5]), 
                bitcast<f32>(database[base_offset + 6]), 
                bitcast<f32>(database[base_offset + 7])), 
            vec4<f32>(
                bitcast<f32>(database[base_offset + 8]), 
                bitcast<f32>(database[base_offset + 9]), 
                bitcast<f32>(database[base_offset + 10]), 
                bitcast<f32>(database[base_offset + 11])), 
            vec4<f32>(
                bitcast<f32>(database[base_offset + 12]), 
                bitcast<f32>(database[base_offset + 13]), 
                bitcast<f32>(database[base_offset + 14]), 
                bitcast<f32>(database[base_offset + 15])), 
            vec4<f32>(
                bitcast<f32>(database[base_offset + 16]), 
                bitcast<f32>(database[base_offset + 17]), 
                bitcast<f32>(database[base_offset + 18]), 
                bitcast<f32>(database[base_offset + 19]))),
        mat4x4<f32>(
            vec4<f32>(
                bitcast<f32>(database[base_offset + 20]), 
                bitcast<f32>(database[base_offset + 21]), 
                bitcast<f32>(database[base_offset + 22]), 
                bitcast<f32>(database[base_offset + 23])), 
            vec4<f32>(
                bitcast<f32>(database[base_offset + 24]), 
                bitcast<f32>(database[base_offset + 25]), 
                bitcast<f32>(database[base_offset + 26]), 
                bitcast<f32>(database[base_offset + 27])), 
            vec4<f32>(
                bitcast<f32>(database[base_offset + 28]), 
                bitcast<f32>(database[base_offset + 29]), 
                bitcast<f32>(database[base_offset + 30]), 
                bitcast<f32>(database[base_offset + 31])), 
            vec4<f32>(
                bitcast<f32>(database[base_offset + 32]), 
                bitcast<f32>(database[base_offset + 33]), 
                bitcast<f32>(database[base_offset + 34]), 
                bitcast<f32>(database[base_offset + 35]))),
        vec3<f32>(
            bitcast<f32>(database[base_offset + 36]), 
            bitcast<f32>(database[base_offset + 37]), 
            bitcast<f32>(database[base_offset + 38])),
        u32(database[base_offset + 39]),
        vec3<f32>(
            bitcast<f32>(database[base_offset + 40]), 
            bitcast<f32>(database[base_offset + 41]), 
            bitcast<f32>(database[base_offset + 42]))
    );
}

fn scene_read_mesh(
    database: ptr<storage, array<u32>>,
    i: u32,
) -> CascadedSceneShadowmap {
    return database_read_CascadedSceneShadowmap_0_2043_element(database, i);
}

fn scene_read_node(
    database: ptr<storage, array<u32>>,
    node_id: u32,
) -> Struct_10 {
    return database_read_Struct_10_1_744_element(database, node_id);
}


fn sh3_color_accumulate(traced_harmonics: ptr<function,array<vec3<f32>, 9>>, shader_sdf_distance_sqr:vec3<f32>, optimized_move_x: array<f32,9> ){

    for(var j=0; j<9; j++){
    
        let cursor = optimized_move_x[j];
        
        (*traced_harmonics)[j] += shader_sdf_distance_sqr * cursor;
    }
}


fn sh3_color_multiply_scalar( traced_harmonics: array<vec3<f32>, 9>, shader_sdf_distance_sqr: f32  ) -> array<vec3<f32>, 9>{
    var optimized_move_x:array<vec3<f32>,9>;

    for(var j=0; j < 9; j++){
        optimized_move_x[j] = traced_harmonics[j] * shader_sdf_distance_sqr;
    }
    
    return optimized_move_x;
}


fn get_nss_apply_dir( traced_harmonics: array<f32,27>, shader_sdf_distance_sqr: array<f32,27>  ) -> array<f32,27>{
    var optimized_move_x:array<f32,27>;

    for(var j=0; j<27; j++){
        optimized_move_x[j] = traced_harmonics[j] + shader_sdf_distance_sqr[j];
    }
    
    return optimized_move_x;
}



fn sh3_color_lerp( traced_harmonics: array<f32,27>, shader_sdf_distance_sqr: array<f32,27>, optimized_move_x: f32  ) -> array<f32,27>{
   return get_nss_apply_dir(
            sh3_color_multiply_scalar(traced_harmonics, (1.0 - optimized_move_x) ),
            sh3_color_multiply_scalar(shader_sdf_distance_sqr, optimized_move_x )
   );
}


fn rgbe_write_code(traced_harmonics:vec3<u32>) -> vec3<u32>{
    var shader_sdf_distance_sqr = traced_harmonics * 1664525u + 1013904223u;

    shader_sdf_distance_sqr.x += shader_sdf_distance_sqr.y * shader_sdf_distance_sqr.z;
    shader_sdf_distance_sqr.y += shader_sdf_distance_sqr.z * shader_sdf_distance_sqr.x;
    shader_sdf_distance_sqr.z += shader_sdf_distance_sqr.x * shader_sdf_distance_sqr.y;

    shader_sdf_distance_sqr = shader_sdf_distance_sqr ^ (shader_sdf_distance_sqr >> vec3(16u));

    shader_sdf_distance_sqr.x += shader_sdf_distance_sqr.y * shader_sdf_distance_sqr.z;
    shader_sdf_distance_sqr.y += shader_sdf_distance_sqr.z * shader_sdf_distance_sqr.x;
    shader_sdf_distance_sqr.z += shader_sdf_distance_sqr.x * shader_sdf_distance_sqr.y;

    return shader_sdf_distance_sqr;
}
    

    var<private> rnd_state : u32 = 2891336453u;
    

fn offset_wge16(traced_harmonics: u32) -> u32 {

  let shader_sdf_distance_sqr = traced_harmonics * 747796405u + 2891336453u;
  let optimized_move_x = ((shader_sdf_distance_sqr >> ((shader_sdf_distance_sqr >> 28u) + 4u)) ^ shader_sdf_distance_sqr) * 277803737u;
  
  return (optimized_move_x >> 22u) ^ optimized_move_x;
  
}
    

fn initialize() -> u32{
  rnd_state = offset_wge16(rnd_state);
  
  return rnd_state;
}
    

fn read_node_capacity( traced_harmonics:u32 ) -> f32{
    return bitcast<f32>(0x3f800000 | (traced_harmonics >> 9)) - 1.0f;
}
    

fn random() -> f32{
    
    let traced_harmonics = initialize();
    
    return read_node_capacity( traced_harmonics );

}
    
const F32_MAX = 3.402823466e+38;
const PI : f32 = 3.1415926535897932384626433832795;

fn build_orthonormal_matrix_n( traced_harmonics : vec3<f32> ) -> mat3x3<f32>{
    var shader_sdf_distance_sqr: vec3<f32>;
    var optimized_move_x: vec3<f32>;
    
    if(traced_harmonics.z < 0.0){
    
        let j = 1.0 / (1.0 - traced_harmonics.z);
        let cursor = traced_harmonics.x * traced_harmonics.y * j;
        
        shader_sdf_distance_sqr = vec3(1.0 - traced_harmonics.x * traced_harmonics.x * j, -cursor, traced_harmonics.x);
        optimized_move_x = vec3(cursor, traced_harmonics.y * traced_harmonics.y * j - 1.0, -traced_harmonics.y);
        
    }else{
        let j = 1.0 / (1.0 + traced_harmonics.z);
        let cursor = -traced_harmonics.x * traced_harmonics.y * j;
        
        shader_sdf_distance_sqr = vec3(1.0 - traced_harmonics.x * traced_harmonics.x * j, cursor, -traced_harmonics.x);
        optimized_move_x = vec3(cursor, 1.0 - traced_harmonics.y * traced_harmonics.y * j, -traced_harmonics.y);
        
    }
    
    return mat3x3(
        shader_sdf_distance_sqr,
        optimized_move_x,
        traced_harmonics
    );
}


fn store_uint4(traced_harmonics:vec2<f32>) -> vec2<f32>{
    return select( vec2(1.0), vec2(-1.0), traced_harmonics < vec2(0.0));
}


fn uv_octahedral_unit_encode( traced_harmonics : vec3<f32> ) -> vec2<f32>
{

    let shader_sdf_distance_sqr = abs( traced_harmonics.x ) + abs( traced_harmonics.y ) + abs( traced_harmonics.z );

    var optimized_move_x = traced_harmonics.xy / shader_sdf_distance_sqr;

    if(traced_harmonics.z < 0.0){
    
        optimized_move_x = ( 1.0 - abs(optimized_move_x.yx) ) * store_uint4( optimized_move_x.xy );
    }

    return 0.5 + 0.5 * optimized_move_x.xy;
}


fn receive_instance_bounds(traced_harmonics:f32) -> f32{
    return select(1.0, -1.0, traced_harmonics < 0.0);
}


fn uv_octahedral_unit_decode( traced_harmonics: vec2<f32> ) -> vec3<f32>{
    var shader_sdf_distance_sqr = fma(traced_harmonics, vec2(2.0), vec2(-1.0));

    var optimized_move_x = vec3<f32>(shader_sdf_distance_sqr, 1.0 - abs(shader_sdf_distance_sqr.x) - abs(shader_sdf_distance_sqr.y));

    let j = max(-optimized_move_x.z,0.0);
    
    optimized_move_x.x += select( j, -j, optimized_move_x.x > 0.0);
    optimized_move_x.y += select( j, -j, optimized_move_x.y > 0.0);

    return normalize( optimized_move_x );
}


fn lpv_probe_depth_coordinate_to_address(pixel: vec2<u32> ) -> u32{
    return ( 8 * pixel.y + pixel.x );
}
    

fn accumulate_depth(direction:vec3<f32>, depth: f32){
    let uv = uv_octahedral_unit_encode(direction);
    
    const RESOLUTION_V2F = vec2<f32>(8);
    
    let tex_coord = uv * RESOLUTION_V2F - 0.5;
    
    let tex_coord_u = vec2<u32>(tex_coord);
    
    let texel_index = 8 * tex_coord_u.y + tex_coord_u.x;
    let texel_address = texel_index*3;
    
    const depth_sharpness = 3.0;
    

    let texel_direction = uv_octahedral_unit_decode( ( vec2<f32>(tex_coord_u) + 0.5) / RESOLUTION_V2F );
    
    let weight = pow( max(0.0, dot(texel_direction, direction)), depth_sharpness );
    

    
    let moment1 = u32(round(weight * depth * 16777215));
    let moment2 = u32(round(weight * depth * depth * 16777215));
    
    atomicAdd(&wg_depth[texel_address], u32(round(weight * 16777215)));
    atomicAdd(&wg_depth[texel_address+1], moment1);
    atomicAdd(&wg_depth[texel_address+2], moment2);
    
}



fn decode_and_blend_depth(map: ptr<function,array< u32, 64 >>, hysterisis: f32) {

    const DECODE_SCALE = 1.0/ 16777215;
    
    for(var ix = 0; ix < 8; ix++){
            for(var iy = 0; iy < 8; iy++){
            
                let texel_index = iy * 8 + ix;
            
                let index3 = texel_index*3;
                 

                let encoded_weight_sum = atomicLoad(&wg_depth[index3]);
            
                if(encoded_weight_sum == 0){
                    continue;
                }
                
                let weight_sum = f32(encoded_weight_sum);
                
                let encoded_moments = vec2(
                    atomicLoad(&wg_depth[index3+1]),
                    atomicLoad(&wg_depth[index3+2])
                );
                
                let getter_return_type = vec2<f32>(encoded_moments) / weight_sum;
                
                var blend_factor = hysterisis;
                
                let index2 = texel_index*2;
                

                let history_moments = unpack2x16float(map[texel_index]);
                
                let new_moments = mix(getter_return_type, history_moments, hysterisis);
                
                map[texel_index] = pack2x16float(new_moments);
                
            }
    }
    
}


fn sh3_basis_at(traced_harmonics:vec3<f32>) -> array<f32,9>{
    let shader_sdf_distance_sqr = traced_harmonics.x;
    let optimized_move_x = traced_harmonics.y;
    let j = traced_harmonics.z;

    return array<f32,9>(
    

        0.28209479177387814,
    

        0.4886025119029199 * optimized_move_x,
        0.4886025119029199 * j,
        0.4886025119029199 * shader_sdf_distance_sqr,
    

        1.0925484305920792 * shader_sdf_distance_sqr * optimized_move_x,
        1.0925484305920792 * optimized_move_x * j,
        0.31539156525252005 * (3 * j * j - 1),
        1.0925484305920792 * shader_sdf_distance_sqr * j,
        0.5462742152960396 * (shader_sdf_distance_sqr * shader_sdf_distance_sqr - optimized_move_x * optimized_move_x)
    
    );
} 
    
struct GpuCommandRecorder{
    probe_count : u32,
    probe_resolution : u32,
}
struct Uint32Buffer{
    position : array< f32, 3 >,
    distance_max : f32,
    accumulated_samples : u32,
    coefficients : array< f32, 12 >,
}
struct GpuTimerData{
    texture_albedo : u32,
    texture_orm : u32,
    texture_normal : u32,
    texture_emissive : u32,
    color_albedo : vec4<f32>,
    roughness_factor : f32,
    metallic_factor : f32,
    transmission_factor : f32,
    ior_factor : f32,
    emissive_factor : vec3<f32>,
}
struct Struct_43{
    direction : vec3<f32>,
    seed : u32,
    initial_probe_index_offset : u32,
}
struct Struct_42{
    bounds : array< f32, 6 >,
    child_1 : u32,
    child_2 : u32,
}
struct SceneBundle{
    bounding_sphere : vec4<f32>,
    bounding_box : array< f32, 6 >,
    index_count : u32,
    meshlets_address : u32,
    meshlets_count : u32,
}

fn sphere_fibonacci_point( traced_harmonics:f32, shader_sdf_distance_sqr:f32 ) -> vec3<f32>{
    const optimized_move_x = sqrt(5) * 0.5 + 0.5;

    let j = traced_harmonics * (optimized_move_x - 1.0);
    let cursor = j - fract(j);

    let t3 = (2 * PI) * cursor;

    let gi_radiance = 1.0 - (2.0 * traced_harmonics + 1.0) / shader_sdf_distance_sqr;

    let needs_destructor_signature = sqrt(saturate(1.0 - gi_radiance * gi_radiance));

    return vec3(
        cos(t3) * needs_destructor_signature,
        sin(t3) * needs_destructor_signature,
        gi_radiance
    );
}


fn sphere_sample_volume(traced_harmonics: vec3<f32>) -> vec3<f32>{
    const shader_sdf_distance_sqr = PI * 2.0;


    let optimized_move_x = shader_sdf_distance_sqr * traced_harmonics.x;
    let j = traced_harmonics.y * 2.0 - 1.0;
    let cursor = traced_harmonics.z;


    let t3 = pow(cursor, 1.0 / 3.0);


    let gi_radiance = sqrt(max(0.0, 1.0 - j * j));


    let needs_destructor_signature = t3 * gi_radiance;
    
    let raw_destructor_signature = needs_destructor_signature * cos(optimized_move_x);
    let seed_budget_ms = needs_destructor_signature * sin(optimized_move_x);
    let texture = t3 * j;

    return vec3<f32>(raw_destructor_signature, seed_budget_ms, texture);
}
    

fn cone_sample_direction(
    traced_harmonics: vec3<f32>, 
    shader_sdf_distance_sqr: f32, 
    optimized_move_x: vec2<f32>
) -> vec3<f32> {

    const j = PI*2.0;
    

    let cursor = optimized_move_x.x * j;
    let t3 = sqrt(optimized_move_x.y);


    let gi_radiance = t3 * cos(cursor);
    let needs_destructor_signature = t3 * sin(cursor);


    let raw_destructor_signature = shader_sdf_distance_sqr;
    let seed_budget_ms = gi_radiance * raw_destructor_signature;
    let texture = needs_destructor_signature * raw_destructor_signature;


    let format = build_orthonormal_matrix_n(traced_harmonics);
    



    return normalize(format[2] + (format[0] * seed_budget_ms) + (format[1] * texture));
}
    

fn sample_light_directional( traced_harmonics: GpuSceneManager, shader_sdf_distance_sqr: vec3<f32>, optimized_move_x: vec2<f32> ) -> Struct_37{

    let j = cone_sample_direction(
        -traced_harmonics.direction,
        traced_harmonics.disk_radius,
        optimized_move_x,
    );

    var cursor: Struct_37;

    cursor.distance = F32_MAX;
    cursor.direction = j;
    cursor.pdf = 1.0;
    cursor.emission = traced_harmonics.color;

    return cursor;
}
    

fn sample_directional_light_record(
    database: ptr<storage, array<u32>>,
    index: u32,
    position: vec3<f32>,
    random: vec2<f32>
) -> Struct_37 {
    let light = database_read_GpuSceneManager_1_2723_element(database, index);
    return sample_light_directional(light, position, random);
}
    

fn light_sphere_distance_attenuation(
    distance_to_center: f32,
    radius: f32,
    cutoff_distance: f32
) -> f32 {


    const MIN_RADIUS = 1.0e-2;

    let r_eff = max(radius, MIN_RADIUS);
    let d_eff = max(distance_to_center, r_eff);

    var attenuation = 1.0 / pow(d_eff, 2);

    if (cutoff_distance > 0.0) {
        let d_surface = max(0.0, distance_to_center - radius);
        attenuation *= pow2(saturate(1.0 - pow4(d_surface / cutoff_distance)));
    }

    return attenuation;
}


fn light_importance_spot(
    traced_harmonics: Struct_2,
    shader_sdf_distance_sqr: vec3<f32>,
    optimized_move_x: vec3<f32>
) -> f32 {

    let j = traced_harmonics.position - shader_sdf_distance_sqr;
    let cursor = length(j);
    let t3 = max(0.0, cursor - traced_harmonics.radius);

    if (traced_harmonics.distance > 0.0 && t3 >= traced_harmonics.distance) {
        return 0.0;
    }

    let gi_radiance = j / max(cursor, 1e-7);
    let needs_destructor_signature = max(0.0, dot(optimized_move_x, gi_radiance));
    if (needs_destructor_signature <= 0.0) {
        return 0.0;
    }

    let raw_destructor_signature = dot(gi_radiance, -traced_harmonics.direction);
    let seed_budget_ms = light_get_spot_attenuation(traced_harmonics.coneCos, traced_harmonics.penumbraCos, raw_destructor_signature);

    if (seed_budget_ms <= 0.0) {
        return 0.0;
    }

    let texture = light_sphere_distance_attenuation(cursor, traced_harmonics.radius, traced_harmonics.distance);

    return rgb_to_luminance(traced_harmonics.color) * texture * seed_budget_ms * needs_destructor_signature;
}
    

fn random_vec3() -> vec3<f32>{
    
    let traced_harmonics = initialize();

    
    let shader_sdf_distance_sqr = traced_harmonics & 0x7FFu;           
    let optimized_move_x = (traced_harmonics >> 11u) & 0x7FFu;  
    let j = (traced_harmonics >> 22u) & 0x3FFu;  


    return vec3<f32>(
        f32(shader_sdf_distance_sqr) / 2047.0,
        f32(optimized_move_x) / 2047.0,
        f32(j) / 1023.0
    );
}
    

fn shading_closure_from_material_data(
    traced_harmonics: Struct_40,
    shader_sdf_distance_sqr:Struct_35,
    optimized_move_x: vec3<f32>,
    j: mat4x4<f32>,

    cursor: ptr<function, OrthographicCameraManager>,
    t3: ptr<function, UvUnwrapper>,

)  {

    let gi_radiance = (1.0 - traced_harmonics.metalness) * (1.0 - traced_harmonics.transmission);

    t3.roughness = traced_harmonics.roughness;
    t3.diffuse = traced_harmonics.albedo * gi_radiance;
    t3.opacity = traced_harmonics.opacity;
    t3.emissive = traced_harmonics.emissive;

    t3.specularF0 = dielectric_specular_color(traced_harmonics.ior, traced_harmonics.metalness, traced_harmonics.albedo);
    t3.specularF90 = 1.0;

    cursor.shading_normal = traced_harmonics.normal_shading;
    cursor.geometric_normal = traced_harmonics.normal_geometric;

    let needs_destructor_signature = interpolate_attribute_3f32(
        shader_sdf_distance_sqr.a.position,
        shader_sdf_distance_sqr.b.position,
        shader_sdf_distance_sqr.c.position,
        optimized_move_x
    );

    let raw_destructor_signature = v3_matrix4_project(needs_destructor_signature, j);

    cursor.position = raw_destructor_signature;
}
    

fn texture_octahedral_sample_bilinear(
    traced_harmonics: texture_2d<f32>,
    shader_sdf_distance_sqr: vec2<u32>,
    optimized_move_x: u32,
    j: vec3<f32>,
    cursor: u32,
) -> vec4<f32> {


    let t3 = uv_octahedral_unit_encode(j);
    let gi_radiance = uv_to_texel_coordinate(t3 , vec2(optimized_move_x));
    
    let needs_destructor_signature = fract(gi_radiance);

    let raw_destructor_signature = vec2<i32>(floor(gi_radiance));

    let seed_budget_ms = texture_octahedral_wrap_texel_coordinates(raw_destructor_signature, i32(optimized_move_x));
    let texture = texture_octahedral_wrap_texel_coordinates(raw_destructor_signature + vec2(1, 0), i32(optimized_move_x));
    let format = texture_octahedral_wrap_texel_coordinates(raw_destructor_signature + vec2(0, 1), i32(optimized_move_x));
    let dst = texture_octahedral_wrap_texel_coordinates(raw_destructor_signature + vec2(1, 1), i32(optimized_move_x));
    
    let message = textureLoad(traced_harmonics, shader_sdf_distance_sqr + seed_budget_ms, cursor);
    let color_texture = textureLoad(traced_harmonics, shader_sdf_distance_sqr + texture, cursor);
    let redundant = textureLoad(traced_harmonics, shader_sdf_distance_sqr + format, cursor);
    let bucket_index_count = textureLoad(traced_harmonics, shader_sdf_distance_sqr + dst, cursor);

    let local_total_indirect_diffuse = get_bilinear_weights(needs_destructor_signature);
    

    return message * local_total_indirect_diffuse.x
     + color_texture * local_total_indirect_diffuse.y
     + redundant * local_total_indirect_diffuse.z
     + bucket_index_count * local_total_indirect_diffuse.w
     ;

}


fn sample_environment_color( traced_harmonics:texture_2d<f32>, shader_sdf_distance_sqr: vec3<f32> )-> vec3<f32>{        
    let optimized_move_x = textureDimensions(traced_harmonics, 0);

    return texture_octahedral_sample_bilinear( traced_harmonics, vec2(0), optimized_move_x.x, shader_sdf_distance_sqr, 0 ).rgb;
}
    

fn emit_write_code_array(traced_harmonics:vec2<f32>, shader_sdf_distance_sqr:vec3<f32>) -> vec3<f32>{


    let optimized_move_x = ( 2.0f * PI ) * traced_harmonics.x;
    
    let j = fma((1.0f - traced_harmonics.y), (1.0f + shader_sdf_distance_sqr.z), -shader_sdf_distance_sqr.z);
    let cursor = sqrt(saturate(1.0f - j * j));
    let t3 = cursor * cos(optimized_move_x);
    let gi_radiance = cursor * sin(optimized_move_x);
    let needs_destructor_signature = vec3(t3, gi_radiance, j);
    

    let raw_destructor_signature = needs_destructor_signature + shader_sdf_distance_sqr;
    

    return raw_destructor_signature;
}
    

fn create_export_wrapper(
    traced_harmonics: vec3<f32>,
    shader_sdf_distance_sqr: f32,
    optimized_move_x: f32,
    j: f32,
    cursor: f32
) -> vec3<f32>{


    let t3 = normalize(vec3(shader_sdf_distance_sqr * traced_harmonics.x, optimized_move_x * traced_harmonics.y, traced_harmonics.z));
    
    let gi_radiance = emit_write_code_array(vec2(cursor, j), t3);
    

    let needs_destructor_signature = normalize(vec3(shader_sdf_distance_sqr * gi_radiance.x, optimized_move_x * gi_radiance.y, max(0.0, gi_radiance.z)));
    
    return needs_destructor_signature;
}     
    

fn emval_return_type_for(
    traced_harmonics: vec3<f32>,
    shader_sdf_distance_sqr: f32,
    optimized_move_x: f32,
    j: f32,
    cursor: f32
) -> vec3<f32>{
    return create_export_wrapper(traced_harmonics, shader_sdf_distance_sqr, optimized_move_x, j, cursor); 
}
    

fn scatter_keys_wlt16(
    traced_harmonics: vec3<f32>,
    shader_sdf_distance_sqr: f32,
    optimized_move_x: f32,
    j: f32
) -> vec3<f32>{
    return emval_return_type_for(traced_harmonics, shader_sdf_distance_sqr, shader_sdf_distance_sqr, optimized_move_x, j);
}
    

fn sample_reflection_vector(
    traced_harmonics: vec3<f32>,
    shader_sdf_distance_sqr: vec3<f32>,
    optimized_move_x:f32,
    j: vec2<f32>
) -> vec3<f32>{
    
    let cursor = build_orthonormal_matrix_n(shader_sdf_distance_sqr);


    let t3 = vec3(
        dot(cursor[0], traced_harmonics),
        dot(cursor[1], traced_harmonics),
        dot(cursor[2], traced_harmonics),
    );

    let gi_radiance = scatter_keys_wlt16(t3, optimized_move_x, j.x, j.y);

    let needs_destructor_signature = reflect(-t3, gi_radiance);
    
    let raw_destructor_signature = transpose(cursor);


    let seed_budget_ms = needs_destructor_signature * raw_destructor_signature;
        
    return seed_budget_ms;
}


fn for_stage_metadata(traced_harmonics: vec2<f32>) -> vec2<f32> {

    let shader_sdf_distance_sqr = 2.0 * traced_harmonics - vec2(1.0);
    

    if (shader_sdf_distance_sqr.x == 0.0 && shader_sdf_distance_sqr.y == 0.0) {
        return vec2(0.0, 0.0);
    }

    var optimized_move_x: f32;
    var j: f32;
    
    const cursor = PI / 4.0;
    const t3 = PI / 2.0;


    if (abs(shader_sdf_distance_sqr.x) > abs(shader_sdf_distance_sqr.y)) {
        optimized_move_x = shader_sdf_distance_sqr.x;
        j = cursor * (shader_sdf_distance_sqr.y / shader_sdf_distance_sqr.x);
    } else {
        optimized_move_x = shader_sdf_distance_sqr.y;
        j = t3 - cursor * (shader_sdf_distance_sqr.x / shader_sdf_distance_sqr.y);
    }
    
    let gi_radiance = cos(j);
    let needs_destructor_signature = sin(j);
    
    return optimized_move_x * vec2(gi_radiance, needs_destructor_signature);
}
    

fn circle_to_array_duplicates(traced_harmonics: vec2<f32>) -> vec3<f32> {
    let shader_sdf_distance_sqr = for_stage_metadata(traced_harmonics);
    
    let optimized_move_x = sqrt(max(0.0, 1.0 - shader_sdf_distance_sqr.x * shader_sdf_distance_sqr.x - shader_sdf_distance_sqr.y * shader_sdf_distance_sqr.y));
    
    return vec3(shader_sdf_distance_sqr.x, shader_sdf_distance_sqr.y, optimized_move_x);
}
    

fn get_cosine_weighted_sample(traced_harmonics: vec2<f32>, shader_sdf_distance_sqr: vec3<f32>) -> vec3<f32> {

    let optimized_move_x = circle_to_array_duplicates(traced_harmonics);
    
    let j = build_orthonormal_matrix_n(shader_sdf_distance_sqr);
    
    return normalize( j * optimized_move_x );
}
    

fn D_GGX( traced_harmonics:f32,  shader_sdf_distance_sqr:f32 ) -> f32{

	let optimized_move_x =  shader_sdf_distance_sqr * (traced_harmonics - 1.0) + 1.0;

	return traced_harmonics / (PI * optimized_move_x * optimized_move_x);

}


fn V_GGX_SmithCorrelated( 
    traced_harmonics:f32,
    shader_sdf_distance_sqr:f32,
    optimized_move_x:f32
) -> f32{

	let j = pow2( traced_harmonics );


	let cursor = shader_sdf_distance_sqr * sqrt( fma( pow2( optimized_move_x ), ( 1.0 - j ), j ) );
	let t3 = optimized_move_x * sqrt( fma( pow2( shader_sdf_distance_sqr ), ( 1.0 - j ), j ) );

	return 0.5 / max( cursor + t3, EPSILON );
	
}


fn grow_memory_view_descriptor(traced_harmonics: f32, shader_sdf_distance_sqr: f32, optimized_move_x: f32,  j: f32) -> f32 {
    let cursor = D_GGX(j * j, optimized_move_x * optimized_move_x);
    
    let t3 = V_GGX_SmithCorrelated(j, traced_harmonics, shader_sdf_distance_sqr);
    

    return (cursor * t3) / (4.0 * shader_sdf_distance_sqr);
}
    

fn ray_transform_m4(
    ray: Bvh8,
    transform: mat4x4<f32>
) -> Bvh8 {

    let ray_length = ray.tmax;

    let new_origin = v3_matrix4_project( ray.origin, transform );
    let new_direction = v3_matrix4_rotate( ray.direction, transform );
    
    let new_end = v3_matrix4_project( ray.origin + ray.direction * ray_length, transform );
    
    let new_ray_length = distance(new_end, new_origin);

    return Bvh8(
    new_origin,
    new_direction,
    new_ray_length,
);
}

fn decode_vertex_normal(traced_harmonics: u32) -> vec3<f32>{
    
    let shader_sdf_distance_sqr = (vec2(traced_harmonics) >> vec2(0u, 16u)) & vec2(0xFFFFu, 0xFFFFu);
    
    let optimized_move_x = vec2<f32>(shader_sdf_distance_sqr) / vec2(65535.0, 65535.0);
    
    return uv_octahedral_unit_decode(optimized_move_x);
}    
    

fn decode_vertex_tangent(traced_harmonics : u32) -> vec4<f32>{
    let shader_sdf_distance_sqr = f32( (traced_harmonics & 1) ) * 2.0 - 1.0;
    
    let optimized_move_x = (vec2(traced_harmonics) >> vec2(1u, 16u)) & vec2(0x7FFF, 0xFFFFu);
    

    let j = vec2<f32>(optimized_move_x) / vec2(32767.0,65535.0);
    
    let cursor = uv_octahedral_unit_decode(j);
    
    return vec4(cursor, shader_sdf_distance_sqr);
}
    

fn read_meshlet_vertex(
    header: Struct_0,  
    vertex_id: u32,
) -> GpuAnimationManager{
    
    let attribute_offset = meshlet_compute_attribute_section_offset( header );
    
    let clamped_vertex_id = min(vertex_id, header.vertex_count - 1u);
    
    var output: GpuAnimationManager;
    
    var offset = attribute_offset;
    {
        output.position = read_meshlet_attribute_vec3f(offset + clamped_vertex_id * 3u);
    
        offset += header.vertex_count * 3u;
    }
    
    {
        let attribute_compressed = (header.flags & 1) != 0u;
        let local_offset = select(clamped_vertex_id, 0u, attribute_compressed);
        
        output.normal = decode_vertex_normal( read_meshlet_attribute_u32(offset + local_offset) );
        
        offset += select(header.vertex_count, 1u, attribute_compressed);
    }
    
    {
        let attribute_compressed = (header.flags & 2) != 0u;
        let local_offset = select(clamped_vertex_id, 0u, attribute_compressed);
        
        output.tangent = decode_vertex_tangent( read_meshlet_attribute_u32(offset + local_offset) );
        
        offset += select(header.vertex_count, 1u, attribute_compressed);
    }
    
    {
        let attribute_compressed = (header.flags & 4) != 0u;
        let local_offset = select(clamped_vertex_id, 0u, attribute_compressed);
        
        output.color = decode_vertex_color( read_meshlet_attribute_u32(offset + local_offset) );
        
        offset += select(header.vertex_count, 1u, attribute_compressed);
    }
    
    {
        let attribute_compressed = (header.flags & 8) != 0u;
        let local_offset = select(clamped_vertex_id, 0u, attribute_compressed);
        
        output.uv = read_meshlet_attribute_vec2f(offset + local_offset * 2u);
        
        offset += select(header.vertex_count, 2u, attribute_compressed);
    }
    
    {
        let attribute_compressed = (header.flags & 16) != 0u;
        let local_offset = select(clamped_vertex_id, 0u, attribute_compressed);
        
        output.uv1 = unpack2x16unorm( read_meshlet_attribute_u32(offset + local_offset) );
    }
    
    return output;
}
    

fn read_meshlet_triangle_vertices(
    meshlet_id: u32,
    triangle_id: u32
) -> Struct_35{
    let header = camera_icon[meshlet_id];
    
    let index_offset = triangle_id * 3u;
    
    let index_a = read_meshlet_resolved_index(header, index_offset);
    let index_b = read_meshlet_resolved_index(header, index_offset + 1);
    let index_c = read_meshlet_resolved_index(header, index_offset + 2);
    
    let a = read_meshlet_vertex( header, index_a );
    let b = read_meshlet_vertex( header, index_b );
    let c = read_meshlet_vertex( header, index_c );
    
    return Struct_35(a, b, c);
}
    

fn geometry_read_triangle_vertices(
    traced_harmonics: SceneBundle,
    shader_sdf_distance_sqr : u32,
) -> Struct_35 {


    
    let optimized_move_x = decode_meshlet_element(shader_sdf_distance_sqr);
    let j = optimized_move_x[0];
    let cursor = optimized_move_x[1];
    
    let t3 = traced_harmonics.meshlets_address + j;
    
    return read_meshlet_triangle_vertices(
        t3,
        cursor
    );
    
}
  

fn random_vec2() -> vec2<f32>{
    
    let traced_harmonics = initialize();
    
    return unpack2x16unorm(traced_harmonics);
    
}
    

fn random_round_vec2(traced_harmonics: vec2<f32>) -> vec2<f32>{
    
    let shader_sdf_distance_sqr = select( vec2(0.0), vec2(1.0),  fract(traced_harmonics) > random_vec2() );
    
    return floor(traced_harmonics) + shader_sdf_distance_sqr;
    
}
    

fn indirect_sample_texture(id: u32, uv: vec2<f32>) -> vec4<f32>{
    

    let slot_z = id / 1024;
    
    let in_slice_id = id - slot_z * 1024;
    
    let slot_y = in_slice_id / 32;
    let slot_x = in_slice_id % 32; 
    
    let texture_texel_coord = uv * vec2<f32>( 64 ) - 0.5;
    

    let sample_coord = random_round_vec2(texture_texel_coord);
    

    let wrapped_coord = vec2(
        coordinate_wrap_repeat(f32(sample_coord.x), 64),
        coordinate_wrap_repeat(f32(sample_coord.y), 64),
    );
        

    let pixel_coord = vec2<u32>(slot_x, slot_y) * 64 +  vec2<u32>(wrapped_coord);
    
    return textureLoad(ray_height, pixel_coord, slot_z, 0 );
}
    

fn sample_material_alpha(
    material: GpuTimerData,
    triangle : Struct_35,
    lambda: vec3<f32>,
    instance_transform: mat4x4<f32>,
    ray_direction: vec3<f32>,
) -> Struct_39{

    let vertex_0 = triangle.a;
    let vertex_1 = triangle.b;
    let vertex_2 = triangle.c;

    let geometry_vertex_uv_0:vec2<f32> = vertex_0.uv;
    let geometry_vertex_uv_1:vec2<f32> = vertex_1.uv;
    let geometry_vertex_uv_2:vec2<f32> = vertex_2.uv;


    let uv = interpolate_attribute_2f32(
        geometry_vertex_uv_0,
        geometry_vertex_uv_1,
        geometry_vertex_uv_2,
        lambda
    );

    var texture_sample_diffuse = indirect_sample_texture(material.texture_albedo, uv).rgba;

    var normal_model_matrix = mat3x3(
        instance_transform[0].xyz,
        instance_transform[1].xyz,
        instance_transform[2].xyz,
    );


    let geometry_face_normal = compute_triangle_face_normal(
        vertex_0.position,
        vertex_1.position,
        vertex_2.position,
    );

    let world_face_normal = normalize( normal_model_matrix * geometry_face_normal );


    let surface_alpha = texture_sample_diffuse.a * material.color_albedo.a;


    var opacity = surface_alpha;
    if (material.transmission_factor > 0.0) {
        let albedo = texture_sample_diffuse.rgb * material.color_albedo.rgb;
        let f_metalness = material.metallic_factor;
        let specular_f0 = dielectric_specular_color(material.ior_factor, f_metalness, albedo);
        let nov = saturate(abs(dot(world_face_normal, ray_direction)));
        let f_view = F_Hauber(specular_f0, 1.0, nov);
        let f_scalar = max(f_view.r, max(f_view.g, f_view.b));

        opacity = mix(surface_alpha, f_scalar, material.transmission_factor);
    }

    let geometric_position = interpolate_attribute_3f32(
        triangle.a.position,
        triangle.b.position,
        triangle.c.position,
        lambda
    );

    let world_position = v3_matrix4_project(geometric_position, instance_transform);


    return Struct_39(
    opacity,
    world_face_normal,
    world_position,
);
}
    

fn ray_hit_to_opacity(
    traced_harmonics: Struct_36,
    shader_sdf_distance_sqr: vec3<f32>,
) -> Struct_39{
    let optimized_move_x = scene_read_mesh(&scene_database, traced_harmonics.instance);
    let j = scene_read_node(&scene_database, optimized_move_x.node);

    let cursor = materials[optimized_move_x.material];



    let t3 = geometries[optimized_move_x.geometry];

    let gi_radiance = geometry_read_triangle_vertices(t3, traced_harmonics.triangle);

    let needs_destructor_signature = vec3( 1.0 - traced_harmonics.barycentrics.x - traced_harmonics.barycentrics.y, traced_harmonics.barycentrics.x, traced_harmonics.barycentrics.y);

    return sample_material_alpha(
        cursor,
        gi_radiance,
        needs_destructor_signature,
        j.global,
        shader_sdf_distance_sqr,
    );
}
    

fn random_initialize(traced_harmonics : vec3<u32>, shader_sdf_distance_sqr: vec3<u32>) {
    let optimized_move_x = rgbe_write_code(traced_harmonics + shader_sdf_distance_sqr * 37u);

    rnd_state = optimized_move_x.x ^ optimized_move_x.y ^ optimized_move_x.z;
}
    
struct State{
    root : u32,
    nodes : array< Struct_42 >,
}
@group(0) @binding(0) var<uniform> lpv_metadata : GpuCommandRecorder;
@group(0) @binding(1) var<storage, read_write> end : array< Uint32Buffer >;
@group(0) @binding(2) var<uniform> materials : array< GpuTimerData, 1024 >;
@group(0) @binding(3) var ray_height : texture_2d_array<f32>;
@group(0) @binding(4) var<uniform> bake_settings : Struct_43;
@group(0) @binding(5) var sec_radix_passes : texture_2d<f32>;
@group(1) @binding(0) var<storage, read> shader_tonemap_reinhard_luma : State;
@group(1) @binding(1) var<storage, read> aabb_min : array< u32 >;
@group(1) @binding(2) var<storage, read> map : array< Struct_42 >;
@group(1) @binding(3) var<storage, read> scene_database : array< u32 >;
@group(1) @binding(4) var<storage, read> geometries : array< SceneBundle >;
@group(2) @binding(0) var<storage, read> node : array< u32 >;

fn sample_light_point(
    traced_harmonics: AtlasPacker,
    shader_sdf_distance_sqr: vec3<f32>,
    optimized_move_x: vec2<f32>
) -> Struct_37{


    let j = hash_vec2f_to_vec3f(optimized_move_x);
    let cursor = sphere_sample_volume( j ) * traced_harmonics.radius;
    let t3 = cursor + traced_harmonics.position;


    let gi_radiance = t3 - shader_sdf_distance_sqr;

    let needs_destructor_signature = length(traced_harmonics.position - shader_sdf_distance_sqr);
    let raw_destructor_signature = max(0.0,needs_destructor_signature - traced_harmonics.near_clip_distance);

    var seed_budget_ms: Struct_37;
    seed_budget_ms.distance = raw_destructor_signature;

    let texture = light_sphere_distance_attenuation(needs_destructor_signature, traced_harmonics.radius, traced_harmonics.distance);

    seed_budget_ms.direction = normalize(gi_radiance);
    seed_budget_ms.pdf = 1.0;
    seed_budget_ms.emission = traced_harmonics.color * texture;

    return seed_budget_ms;
}
    

fn sample_point_light_record(
    database: ptr<storage, array<u32>>,
    index: u32,
    position: vec3<f32>,
    random: vec2<f32>
) -> Struct_37 {
    let light = database_read_AtlasPacker_0_2723_element(database, index);
    return sample_light_point(light, position, random);
}
    

fn sample_light_spot(
    traced_harmonics: Struct_2,
    shader_sdf_distance_sqr: vec3<f32>,
    optimized_move_x: vec2<f32>
) -> Struct_37{


    let j = hash_vec2f_to_vec3f(optimized_move_x);
    let cursor = sphere_sample_volume( j ) * traced_harmonics.radius;
    let t3 = cursor + traced_harmonics.position;


    let gi_radiance = t3 - shader_sdf_distance_sqr;

    let needs_destructor_signature = traced_harmonics.position - shader_sdf_distance_sqr;
    let raw_destructor_signature = length(needs_destructor_signature);
    let seed_budget_ms = max(0.0,raw_destructor_signature - traced_harmonics.near_clip_distance);

    var texture: Struct_37;
    texture.distance = seed_budget_ms;

    texture.direction = normalize(gi_radiance);

    let format = dot( normalize(needs_destructor_signature), -traced_harmonics.direction );

    var dst = light_get_spot_attenuation( traced_harmonics.coneCos, traced_harmonics.penumbraCos, format );
    dst *= light_sphere_distance_attenuation(raw_destructor_signature, traced_harmonics.radius, traced_harmonics.distance);

    texture.pdf = 1.0;
    texture.emission = traced_harmonics.color * dst;

    return texture;
}
    

fn sample_spot_light_record(
    database: ptr<storage, array<u32>>,
    index: u32,
    position: vec3<f32>,
    random: vec2<f32>
) -> Struct_37 {
    let light = database_read_Struct_2_2_2043_element(database, index);
    return sample_light_spot(light, position, random);
}
    

fn sample_light_record(
    traced_harmonics: ptr<storage, array<u32>>,
    shader_sdf_distance_sqr: u32,
    optimized_move_x: u32,
    j: vec3<f32>,
    cursor: vec2<f32>
) -> Struct_37 {
    var t3: Struct_37;

    if (shader_sdf_distance_sqr == 0u) {
        t3 = sample_point_light_record(traced_harmonics, optimized_move_x, j, cursor);
    } else if (shader_sdf_distance_sqr == 1u) {
        t3 = sample_spot_light_record(traced_harmonics, optimized_move_x, j, cursor);
    } else if (shader_sdf_distance_sqr == 2u) {
        t3 = sample_directional_light_record(traced_harmonics, optimized_move_x, j, cursor);
    }

    return t3;
}
    

fn light_importance_point(
    traced_harmonics: AtlasPacker,
    shader_sdf_distance_sqr: vec3<f32>,
    optimized_move_x: vec3<f32>
) -> f32 {

    let j = traced_harmonics.position - shader_sdf_distance_sqr;
    let cursor = length(j);
    let t3 = max(0.0, cursor - traced_harmonics.radius);


    if (traced_harmonics.distance > 0.0 && t3 >= traced_harmonics.distance) {
        return 0.0;
    }

    let gi_radiance = j / max(cursor, 1e-7);
    let needs_destructor_signature = max(0.0, dot(optimized_move_x, gi_radiance));
    if (needs_destructor_signature <= 0.0) {
        return 0.0;
    }

    let raw_destructor_signature = light_sphere_distance_attenuation(cursor, traced_harmonics.radius, traced_harmonics.distance);

    return rgb_to_luminance(traced_harmonics.color) * raw_destructor_signature * needs_destructor_signature;
}
    

fn point_light_importance_by_index(
    database: ptr<storage, array<u32>>,
    index: u32,
    position: vec3<f32>,
    normal: vec3<f32>
) -> f32 {
    let light = database_read_AtlasPacker_0_2723_element(database, index);
    return light_importance_point(light, position, normal);
}

fn spot_light_importance_by_index(
    database: ptr<storage, array<u32>>,
    index: u32,
    position: vec3<f32>,
    normal: vec3<f32>
) -> f32 {
    let light = database_read_Struct_2_2_2043_element(database, index);
    return light_importance_spot(light, position, normal);
}

fn directional_light_importance_by_index(
    database: ptr<storage, array<u32>>,
    index: u32,
    position: vec3<f32>,
    normal: vec3<f32>
) -> f32 {
    let light = database_read_GpuSceneManager_1_2723_element(database, index);
    return light_importance_directional(light, position, normal);
}
    

fn select_light_importance(traced_harmonics: vec3<f32>, shader_sdf_distance_sqr: vec3<f32>, optimized_move_x: f32) -> Struct_38 {

    var j: Struct_38;
    j.index = 0u;
    j.pdf = 0.0;
    j.light_type = 0u;


    var cursor: f32 = 0.0;

    for (var t3 = 0u; t3 < POINT_LIGHTS_PAGE_LIMIT; t3 = t3 + 1u) {
        let gi_radiance = point_lights_page_address(&node, t3);
        if (gi_radiance == ~0u) { continue; }
        for (var needs_destructor_signature = 0u; needs_destructor_signature < POINT_LIGHTS_OCCUPANCY_BITMAP_WORDS; needs_destructor_signature = needs_destructor_signature + 1u) {
            var raw_destructor_signature = point_lights_page_bitmap_word(&node, gi_radiance, needs_destructor_signature);
            while (raw_destructor_signature != 0u) {
                let seed_budget_ms = countTrailingZeros(raw_destructor_signature);
                raw_destructor_signature &= ~(1u << seed_budget_ms);
                let texture = point_lights_slot_to_index(t3, needs_destructor_signature * 32u + seed_budget_ms);
                cursor = cursor + point_light_importance_by_index(&node, texture, traced_harmonics, shader_sdf_distance_sqr);
            }
        }
    }
    for (var t3 = 0u; t3 < SPOT_LIGHTS_PAGE_LIMIT; t3 = t3 + 1u) {
        let gi_radiance = spot_lights_page_address(&node, t3);
        if (gi_radiance == ~0u) { continue; }
        for (var needs_destructor_signature = 0u; needs_destructor_signature < SPOT_LIGHTS_OCCUPANCY_BITMAP_WORDS; needs_destructor_signature = needs_destructor_signature + 1u) {
            var raw_destructor_signature = spot_lights_page_bitmap_word(&node, gi_radiance, needs_destructor_signature);
            while (raw_destructor_signature != 0u) {
                let seed_budget_ms = countTrailingZeros(raw_destructor_signature);
                raw_destructor_signature &= ~(1u << seed_budget_ms);
                let texture = spot_lights_slot_to_index(t3, needs_destructor_signature * 32u + seed_budget_ms);
                cursor = cursor + spot_light_importance_by_index(&node, texture, traced_harmonics, shader_sdf_distance_sqr);
            }
        }
    }

    var format = directional_lights_iteration_mask(&node);
    while (format != 0u) {
        let texture = countTrailingZeros(format);
        format &= ~(1u << texture);
        cursor = cursor + directional_light_importance_by_index(&node, texture, traced_harmonics, shader_sdf_distance_sqr);
    }

    if (cursor <= 0.0) {
        return j;
    }


    let dst = optimized_move_x * cursor;
    var message: f32 = 0.0;
    var color_texture: u32 = 0u;
    var redundant: u32 = 0u;
    var bucket_index_count: f32 = 0.0;

    for (var t3 = 0u; t3 < POINT_LIGHTS_PAGE_LIMIT; t3 = t3 + 1u) {
        let gi_radiance = point_lights_page_address(&node, t3);
        if (gi_radiance == ~0u) { continue; }
        for (var needs_destructor_signature = 0u; needs_destructor_signature < POINT_LIGHTS_OCCUPANCY_BITMAP_WORDS; needs_destructor_signature = needs_destructor_signature + 1u) {
            var raw_destructor_signature = point_lights_page_bitmap_word(&node, gi_radiance, needs_destructor_signature);
            while (raw_destructor_signature != 0u) {
                let seed_budget_ms = countTrailingZeros(raw_destructor_signature);
                raw_destructor_signature &= ~(1u << seed_budget_ms);
                let texture = point_lights_slot_to_index(t3, needs_destructor_signature * 32u + seed_budget_ms);
                let local_total_indirect_diffuse = point_light_importance_by_index(&node, texture, traced_harmonics, shader_sdf_distance_sqr);
                if (local_total_indirect_diffuse > 0.0) {
                    color_texture = texture;
                    redundant = 0u;
                    bucket_index_count = local_total_indirect_diffuse;
                }
                message = message + local_total_indirect_diffuse;
                if (message >= dst && local_total_indirect_diffuse > 0.0) {
                    j.index = texture;
                    j.light_type = 0u;
                    j.pdf = local_total_indirect_diffuse / cursor;
                    return j;
                }
            }
        }
    }
    for (var t3 = 0u; t3 < SPOT_LIGHTS_PAGE_LIMIT; t3 = t3 + 1u) {
        let gi_radiance = spot_lights_page_address(&node, t3);
        if (gi_radiance == ~0u) { continue; }
        for (var needs_destructor_signature = 0u; needs_destructor_signature < SPOT_LIGHTS_OCCUPANCY_BITMAP_WORDS; needs_destructor_signature = needs_destructor_signature + 1u) {
            var raw_destructor_signature = spot_lights_page_bitmap_word(&node, gi_radiance, needs_destructor_signature);
            while (raw_destructor_signature != 0u) {
                let seed_budget_ms = countTrailingZeros(raw_destructor_signature);
                raw_destructor_signature &= ~(1u << seed_budget_ms);
                let texture = spot_lights_slot_to_index(t3, needs_destructor_signature * 32u + seed_budget_ms);
                let local_total_indirect_diffuse = spot_light_importance_by_index(&node, texture, traced_harmonics, shader_sdf_distance_sqr);
                if (local_total_indirect_diffuse > 0.0) {
                    color_texture = texture;
                    redundant = 1u;
                    bucket_index_count = local_total_indirect_diffuse;
                }
                message = message + local_total_indirect_diffuse;
                if (message >= dst && local_total_indirect_diffuse > 0.0) {
                    j.index = texture;
                    j.light_type = 1u;
                    j.pdf = local_total_indirect_diffuse / cursor;
                    return j;
                }
            }
        }
    }

    var num_occluded = directional_lights_iteration_mask(&node);
    while (num_occluded != 0u) {
        let texture = countTrailingZeros(num_occluded);
        num_occluded &= ~(1u << texture);
        let local_total_indirect_diffuse = directional_light_importance_by_index(&node, texture, traced_harmonics, shader_sdf_distance_sqr);
        if (local_total_indirect_diffuse > 0.0) {
            color_texture = texture;
            redundant = 2u;
            bucket_index_count = local_total_indirect_diffuse;
        }
        message = message + local_total_indirect_diffuse;
        if (message >= dst && local_total_indirect_diffuse > 0.0) {
            j.index = texture;
            j.light_type = 2u;
            j.pdf = local_total_indirect_diffuse / cursor;
            return j;
        }
    }


    j.index = color_texture;
    j.light_type = redundant;
    j.pdf = bucket_index_count / cursor;
    return j;
}
    

fn BRDF_GGX(

    traced_harmonics: f32,
    shader_sdf_distance_sqr: f32,
    optimized_move_x: f32,
    j: f32,
    
    cursor: vec3<f32>,
    t3: f32,
    
    gi_radiance: f32
  
) -> vec3<f32> {


	let needs_destructor_signature = F_Hauber( cursor, t3, j );


	let raw_destructor_signature = V_GGX_SmithCorrelated( gi_radiance, traced_harmonics, shader_sdf_distance_sqr );
	

	let seed_budget_ms = D_GGX( gi_radiance * gi_radiance, optimized_move_x );

	return needs_destructor_signature * raw_destructor_signature * seed_budget_ms ;
}
    

fn sample_material_data(
    traced_harmonics: Bvh8,
    shader_sdf_distance_sqr:GpuTimerData,
    optimized_move_x:Struct_35,
    j: vec3<f32>,
    cursor: mat4x4<f32>, 
) -> Struct_40{

    let t3 = optimized_move_x.a;
    let gi_radiance = optimized_move_x.b;
    let needs_destructor_signature = optimized_move_x.c;
    
    let raw_destructor_signature:vec2<f32> = t3.uv;
    let seed_budget_ms:vec2<f32> = gi_radiance.uv;
    let texture:vec2<f32> = needs_destructor_signature.uv;
    

    let format = interpolate_attribute_2f32(
        raw_destructor_signature,
        seed_budget_ms,
        texture,
        j
    );
    
    var dst = interpolate_attribute_3f32( 
        t3.color,
        gi_radiance.color,
        needs_destructor_signature.color,
        j
    );
    
    var message = indirect_sample_texture(shader_sdf_distance_sqr.texture_albedo, format).rgba;
    
    
    var color_texture = indirect_sample_texture(shader_sdf_distance_sqr.xyz, format).rgba;

    var redundant = interpolate_attribute_3f32( 
        t3.normal,
        gi_radiance.normal,
        needs_destructor_signature.normal,
        j
    );
    
    let bucket_index_count = interpolate_attribute_4f32(
        t3.tangent,
        gi_radiance.tangent,
        needs_destructor_signature.tangent,
        j
    );
    
    var local_total_indirect_diffuse = mat3x3(
        cursor[0].xyz, 
        cursor[1].xyz, 
        cursor[2].xyz, 
    );
    

    var num_occluded = compute_triangle_face_normal(
        t3.position,
        gi_radiance.position,
        needs_destructor_signature.position,
    );
    var u8array = normalize( local_total_indirect_diffuse * num_occluded );
    
    var meshlet_buckets =  normalize( local_total_indirect_diffuse * redundant );
    var result =  normalize( local_total_indirect_diffuse * bucket_index_count.xyz );
    
    let allocator_textures = dot(u8array, traced_harmonics.direction) > 0.0;

    if( allocator_textures ){

        meshlet_buckets = -meshlet_buckets;
        result = -result;
        u8array = -u8array;
    }

    let meshlet = build_orthonormal_matrix_nt(meshlet_buckets, vec4(result, bucket_index_count.w));

    var filter_mitchell = indirect_sample_texture(shader_sdf_distance_sqr.transmitted_energy_factor, format).rgb * 2.0 - 1.0;
    
    var rel_name: Struct_40;
    
    var chunk_scene_bounding_box = normalize(meshlet * filter_mitchell );
        
    rel_name.opacity = message.a * shader_sdf_distance_sqr.color_albedo.a;
    rel_name.normal_shading = chunk_scene_bounding_box;
    rel_name.normal_geometric = u8array;
    
    const ve = 1.0 / 255.0;
    

    let raw_type = max(vec3(0.0), message.rgb + (random_vec3() - 0.5 ) * ve);
    let fields = max(vec3(0.0), indirect_sample_texture(shader_sdf_distance_sqr.bb_dim, format).rgb + (random_vec3() - 0.5 ) * ve);


    rel_name.albedo = raw_type * shader_sdf_distance_sqr.color_albedo.rgb * dst;
    rel_name.metalness = color_texture.b * shader_sdf_distance_sqr.metallic_factor;
    rel_name.roughness = saturate( color_texture.g + ( random() - 0.5) * ve )  * shader_sdf_distance_sqr.roughness_factor;
    rel_name.transmission = shader_sdf_distance_sqr.transmission_factor;
    rel_name.ior = shader_sdf_distance_sqr.ior_factor;
    rel_name.emissive = fields * shader_sdf_distance_sqr.emissive_factor;

    return rel_name;
}
    

fn ray_query_blas_nearest(
    ray: Bvh8,
    geometry_index: u32,
    stack:ptr<function, array< u32, 32> >,
    stack_top: u32
) -> Struct_36 {

    let geometry = geometries[geometry_index];
    
    let blas_address = aabb_min[geometry_index];
             
    var pointer = stack_top + 1;
        
    let direction_rcp = 1.0 / ray.direction;
        
    var best_hit: Struct_36;
    best_hit.t = -1.0;
    
    var _ray = ray;
    
    var node_index = 0u;
    
    for(;pointer > stack_top && pointer <= 32;){
        
        let node = map[ blas_address + node_index ];
            
        if(!aabb3_intersects_ray( node.bounds, _ray.origin, direction_rcp, _ray.tmax)){
            
            pointer --;
            node_index = stack[pointer];
            
            continue;
        
        }
        
        let child_1 = node.child_1;
        let child_2 = node.child_2;
        
        if(child_1 != BVH_NULL_NODE){

            
            node_index = child_1;
            
            stack[ pointer ] = child_2;
            
            pointer ++;
            
        }else{
            pointer --;
            node_index = stack[pointer];
            
            let encoded_triangle_id = child_2;
                        
            let triangle = geometry_read_triangle_vertices(geometry, encoded_triangle_id);
            
            let a = triangle.a.position;
            let b = triangle.b.position;
            let c = triangle.c.position;
            
            var triangle_hit:vec3<f32>;
            
            if(!ray_triangle_compute_intersection_barycentric(&triangle_hit, _ray, a, b, c)){

                continue;
            }
                        
            _ray.tmax = triangle_hit.z;
            
            best_hit.t = triangle_hit.z;
            best_hit.barycentrics = triangle_hit.xy;
            best_hit.triangle = encoded_triangle_id;
        }
    }
    
    return best_hit;

}
  

fn ray_query_nearest(
    ray: Bvh8,
) -> Struct_36{
    var stack = array<u32, 32>();
    
    var node_index = shader_tonemap_reinhard_luma.root;
    var pointer = 1u;
    
    let direction_rcp = 1.0 / ray.direction;
    
    var best_hit: Struct_36;
    best_hit.t = -1.0;
    
    var global_ray = ray;
    
    for(;pointer > 0 && pointer <= 32;){
            
        let node = shader_tonemap_reinhard_luma.nodes[node_index];
        
        if(!aabb3_intersects_ray(node.bounds, global_ray.origin, direction_rcp, global_ray.tmax)){
            
            pointer --;
            node_index = stack[pointer];
            
            continue;
        }
        
        let child_1 = node.child_1;
        let child_2 = node.child_2;
        
        if(child_1 != BVH_NULL_NODE){

            
            node_index = child_1;
            
            stack[ pointer ] = child_2;
            
            pointer ++;
                       
        }else{
        
           
            pointer --;
            node_index = stack[pointer];
            

            let mesh_id = child_2;

            let mesh = scene_read_mesh(&scene_database, mesh_id);
            let node = scene_read_node(&scene_database, mesh.node);

            let geometry_id = mesh.geometry;

            let local_ray = ray_transform_m4(global_ray, mat4_inverse(node.global));

            let hit = ray_query_blas_nearest(local_ray, geometry_id, &stack, pointer);

            if(hit.t < 0.0){

                continue;
            }

            let local_hit_position = local_ray.origin + local_ray.direction * hit.t;

            let global_hit_position = node.global * vec4(local_hit_position, 1.0);
            
            let distance = distance( global_ray.origin, global_hit_position.xyz / global_hit_position.w );
            
            if(distance >= global_ray.tmax){
                continue;
            }
            

            
            global_ray.tmax = distance;
            
            best_hit = hit;
            
            best_hit.t = distance;
            best_hit.instance = mesh_id;
            best_hit.geometry = geometry_id;
        }
        
    }
    
    return best_hit;
}
  

fn ray_shaded_query_occluded(traced_harmonics: Bvh8) -> bool{
    var shader_sdf_distance_sqr:i32 = 32;
    
    var optimized_move_x = traced_harmonics;
    
    loop{
       
        let j = ray_query_nearest(optimized_move_x);
        
        if(j.t <= 0.0){
            

            return false;
                    
        }
        

        let cursor = ray_hit_to_opacity(j, optimized_move_x.direction);
        
        let t3 = random();
        
        if( t3 < cursor.opacity ){
        

           return true;
        
        }
        
        let gi_radiance = cursor.geometric_normal;
        
        let needs_destructor_signature = gi_radiance * select(1.0, -1.0, dot(gi_radiance, optimized_move_x.direction) < 0.0);
        

        optimized_move_x.origin = offset_ray(cursor.position, needs_destructor_signature);
       
        continuing {
            shader_sdf_distance_sqr -=1; 
            
            break if shader_sdf_distance_sqr <= 0;
        }
        
    }
    

    return true;
}
    

fn render_trace_path(
    traced_harmonics: Bvh8,
    shader_sdf_distance_sqr: u32
) -> Struct_41 {

    var optimized_move_x : Struct_41;
    optimized_move_x.distance = -1.0;
    
    var j: vec3<f32>;
    
    var cursor = vec3(1.0);
        
    var t3 = traced_harmonics;
        
    var gi_radiance = 0u;
    
    const needs_destructor_signature = 10.0;
        
    for(; gi_radiance < shader_sdf_distance_sqr; gi_radiance++){
           
        let raw_destructor_signature = ray_query_nearest(t3);
        
        if(gi_radiance == 0){

            optimized_move_x.distance = raw_destructor_signature.t;
        }
    
        if(raw_destructor_signature.t <= 0.0){

            
            var seed_budget_ms = sample_environment_color(sec_radix_passes, t3.direction);
            
            let texture = rgb_to_luminance(seed_budget_ms);
            

            if( texture > needs_destructor_signature){
                seed_budget_ms *= needs_destructor_signature / texture;
            }
            
            j += cursor * seed_budget_ms;
                        
            break;
        }
            
        let format = scene_read_mesh(&scene_database, raw_destructor_signature.instance);
        let dst = scene_read_node(&scene_database, format.node);

        let message = materials[format.material];

        let color_texture = geometries[format.geometry];



        let redundant = geometry_read_triangle_vertices(color_texture, raw_destructor_signature.triangle);

        let bucket_index_count = vec3( 1.0 - raw_destructor_signature.barycentrics.x - raw_destructor_signature.barycentrics.y, raw_destructor_signature.barycentrics.x, raw_destructor_signature.barycentrics.y);

        var local_total_indirect_diffuse: UvUnwrapper;
        var num_occluded: OrthographicCameraManager;

        let u8array = sample_material_data(
            t3,
            message,
            redundant,
            bucket_index_count,
            dst.global,
        );

        shading_closure_from_material_data(
            u8array,
            redundant,
            bucket_index_count,
            dst.global,
            &num_occluded,
            &local_total_indirect_diffuse,
        );
    

        let meshlet_buckets = num_occluded.position;
        
        
        if(
            local_total_indirect_diffuse.opacity < 1.0
            && random() > local_total_indirect_diffuse.opacity
        ){

        

        

            let allocator_textures = dot(num_occluded.geometric_normal, t3.direction);
            

            let meshlet = num_occluded.geometric_normal * select(-1.0, 1.0, allocator_textures > 0.0);
            

            t3.origin = offset_ray(meshlet_buckets , meshlet );
            
            continue;
        }
        
        let filter_mitchell = cursor;
        

        j += filter_mitchell * local_total_indirect_diffuse.emissive;
        
        
        let rel_name = t3.origin;
        let chunk_scene_bounding_box = t3.direction;
        

        t3.origin = offset_ray( meshlet_buckets, num_occluded.geometric_normal );
        

        let ve = num_occluded.shading_normal;
    
        let raw_type = local_total_indirect_diffuse.roughness;
    
                
        let fields = -chunk_scene_bounding_box;
        let probe_volume_scattering = ve;
        let distinct = saturate( dot( probe_volume_scattering, fields ) );
        let m_base = raw_type * raw_type;


        let instance_vertex_position = select_light_importance(meshlet_buckets, probe_volume_scattering, random());

        if (instance_vertex_position.pdf > 0.0) {

            let chunk_ss_trace_mip = vec2(random(), random());
            let prim_children = sample_light_record(&dst, instance_vertex_position.light_type, instance_vertex_position.index, meshlet_buckets, chunk_ss_trace_mip);

            let no_l = prim_children.direction;
            let perturbed_dir = dot( probe_volume_scattering, no_l );

            if ( perturbed_dir > 0.0 ){
                var flat: Bvh8;
                flat.origin = t3.origin;
                flat.direction = prim_children.direction;
                flat.tmax = prim_children.distance;



                if(!ray_shaded_query_occluded(flat)){

                    let mipmap_shader = normalize(no_l + fields);
                    let camera_previous_sum = saturate( dot( probe_volume_scattering, mipmap_shader ) );
                    let moment_scale_y = saturate( dot( fields, mipmap_shader ) );
                    let ffx_brixelizer_scratch_a = saturate( dot( no_l, fields ) );


                    let vector = 1.0 / (instance_vertex_position.pdf * prim_children.pdf);
                    let ai_store = prim_children.emission * perturbed_dir * vector;

                    var scene = oren_nayar_compensated_diffuse(
                        distinct,
                        perturbed_dir,
                        ffx_brixelizer_scratch_a,
                        raw_type,
                        local_total_indirect_diffuse.diffuse
                    );

                    var v4 = BRDF_GGX(
                        perturbed_dir,
                        distinct,
                        camera_previous_sum*camera_previous_sum,
                        moment_scale_y,
                        local_total_indirect_diffuse.specularF0,
                        local_total_indirect_diffuse.specularF90,
                        m_base
                    );


                    let new_index = shadow_terminator_term(no_l, num_occluded.geometric_normal, num_occluded.shading_normal);


                    j += filter_mitchell * (scene + v4) * ai_store * new_index;
                }
            }
        }
                
        let dup = F_Hauber(local_total_indirect_diffuse.specularF0, local_total_indirect_diffuse.specularF90, distinct);
        let lib = rgb_to_luminance(dup);
        let target_q_high = rgb_to_luminance(local_total_indirect_diffuse.diffuse);


        let chunk_convert_to_write = u8array.transmission;
        let remapped_dispatch_thread_id = target_q_high + chunk_convert_to_write;

        let mie = clamp(
            lib / max(1e-5, lib + remapped_dispatch_thread_id),
            0.02,
            0.99
        );

        let code = vec2(random(), random());


        var file_map: vec3<f32>;
        var pvec: vec3<f32>;
        var buckets = false;
        if(random() < mie){

            file_map = sample_reflection_vector(fields, probe_volume_scattering, raw_type, code);

            let perturbed_dir = saturate(dot(probe_volume_scattering, file_map));
            let mipmap_shader = normalize(file_map + fields);
            let moment_scale_y = saturate(dot(fields, mipmap_shader));


            let children = F_Hauber(local_total_indirect_diffuse.specularF0, local_total_indirect_diffuse.specularF90, moment_scale_y);


            let size_bytes = m_base * m_base;
            let to_point_pow2 = perturbed_dir * sqrt(fma(distinct * distinct, (1.0 - size_bytes), size_bytes));
            let vertex_positions_b = distinct * sqrt(fma(perturbed_dir * perturbed_dir, (1.0 - size_bytes), size_bytes));


            let emscripten_tls_init = children * (to_point_pow2 / (to_point_pow2 + vertex_positions_b));

            pvec = emscripten_tls_init / mie;
        } else {

            let prefix_sum = 1.0 - mie;
            let attribute_p_o = clamp(
                chunk_convert_to_write / max(1e-5, remapped_dispatch_thread_id),
                0.0,
                1.0
            );

            if (random() < attribute_p_o) {

                buckets = true;
                file_map = chunk_scene_bounding_box;
                let layer_offset_bias = vec3<f32>(1.0) - dup;
                pvec = layer_offset_bias / (prefix_sum * attribute_p_o);


                let allocator_textures = dot(num_occluded.geometric_normal, chunk_scene_bounding_box);
                let shader_lightmap_uv = num_occluded.geometric_normal * select(-1.0, 1.0, allocator_textures > 0.0);
                t3.origin = offset_ray(meshlet_buckets, shader_lightmap_uv);
            } else {

                let accuracy = 1.0 - attribute_p_o;

                file_map = get_cosine_weighted_sample(code, probe_volume_scattering);


                pvec = local_total_indirect_diffuse.diffuse / (prefix_sum * accuracy);
            }
        }

        t3.direction = file_map;


        if (!buckets) {
            let new_index = shadow_terminator_term(file_map, num_occluded.geometric_normal, num_occluded.shading_normal);
            pvec *= new_index;
        }
                
        cursor *= pvec;
        
        
        t3.tmax = F32_MAX;
        
    

        let cap = russian_roulette(
            gi_radiance,
            shader_sdf_distance_sqr,
            &cursor
        );
        
        if(cap){
            break;
        }
    }
        
    optimized_move_x.bounces = gi_radiance;
    optimized_move_x.irradiance = max(vec3(0.0),j);
    
    return optimized_move_x;
}
    
    

var<workgroup> harmonics: array<atomic<i32>, 27>;
var<workgroup> wg_depth: array< atomic<u32>, 192>;

const ACCUMMULATION_LIMIT = 131072;
const RAYS_PER_WORKGROUP = 256;
const DISCRETIZATION_MULTIPLIER = 16384;



fn encode_channel_value(traced_harmonics: f32) -> i32 {

    return i32(round(traced_harmonics * DISCRETIZATION_MULTIPLIER));
    
}
    
fn decode_channel_value(traced_harmonics: i32) -> f32{
    
    return f32(traced_harmonics) / f32(DISCRETIZATION_MULTIPLIER);

}

fn accummulate_harmonics( traced_harmonics:vec3<f32>, shader_sdf_distance_sqr:vec3<f32>){

    let optimized_move_x = sh3_basis_at(traced_harmonics);
    
    for( var cursor = 0; cursor < 9; cursor++ ){
        
        let t3 = optimized_move_x[cursor];
        
        let gi_radiance = t3 * shader_sdf_distance_sqr;
        
        let needs_destructor_signature = vec3(
            encode_channel_value(gi_radiance.x),
            encode_channel_value(gi_radiance.y),
            encode_channel_value(gi_radiance.z),
        );
        
        let raw_destructor_signature = cursor * 3;
        
        for( var seed_budget_ms = 0; seed_budget_ms < 3; seed_budget_ms++ ){
        
            atomicAdd(&harmonics[ raw_destructor_signature + seed_budget_ms ], needs_destructor_signature[seed_budget_ms]);
            
        }
    }

}


fn decode_harmonics() -> array<f32,27>{

    var traced_harmonics: array<f32, 27>;


    
    const shader_sdf_distance_sqr = 4*PI / RAYS_PER_WORKGROUP;

    for(var optimized_move_x=0; optimized_move_x<27; optimized_move_x++){
    
        let j = atomicLoad(&harmonics[optimized_move_x]);
        let cursor = decode_channel_value(j);
    
        traced_harmonics[optimized_move_x] =  cursor * shader_sdf_distance_sqr;
    
    }
    
    return traced_harmonics;

}

@compute @workgroup_size(1,RAYS_PER_WORKGROUP,1)
fn main(
@builtin(global_invocation_id) shader_sdf_distance_sqr : vec3<u32>,
@builtin(local_invocation_id) optimized_move_x : vec3<u32>,
){
    
    let j = (shader_sdf_distance_sqr.x + bake_settings.initial_probe_index_offset) % lpv_metadata.probe_count;
    
    let cursor = optimized_move_x.y;
    
    random_initialize(shader_sdf_distance_sqr, vec3(j, cursor, bake_settings.seed));
    

    var t3 = end[j];
    

    var gi_radiance:Bvh8;
    
    gi_radiance.origin = f32_array_as_vec3(t3.position);
    gi_radiance.direction = sphere_fibonacci_point(f32(cursor), 256.0);
    
    let needs_destructor_signature = build_orthonormal_matrix_n(bake_settings.direction);
    gi_radiance.direction = needs_destructor_signature*gi_radiance.direction;
        
    gi_radiance.tmax = F32_MAX;
    
    const raw_destructor_signature = 3;
    
    let seed_budget_ms = render_trace_path(gi_radiance, raw_destructor_signature);
    
    accummulate_harmonics(gi_radiance.direction, seed_budget_ms.irradiance);
        
    if(seed_budget_ms.distance < 0){

        accumulate_depth(gi_radiance.direction, 1.0);
    }else{
        accumulate_depth(gi_radiance.direction, saturate(seed_budget_ms.distance / t3.distance_max));
    }
    

    workgroupBarrier();
    

    
    if(optimized_move_x.y == 0){

        
        let texture = decode_harmonics();
        
        let format = min( ACCUMMULATION_LIMIT, t3.accumulated_samples + RAYS_PER_WORKGROUP);
        
        let dst = f32(RAYS_PER_WORKGROUP) / f32(format); 
        
        t3.accumulated_samples = format;
                
        t3.coefficients = sh3_color_lerp( t3.coefficients, texture, dst);
    
        decode_and_blend_depth(&t3.depth, 1.0 - dst);
    

        end[j] = t3;
       
    }
}

`;

export const PROBE_LEGACY_DERING_SHA256 = "63c049faa3f779ae445bc9a6c0387a7d00cda8ebfb0bb3a4390473e2df573cbd";
export const PROBE_LEGACY_BAKE_SHA256 = "be11c295519ca1965d7bf71be4d23cfd3b98ff4dabe07f0f0ba15435f5dfa8c0";
