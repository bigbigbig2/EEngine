/**
 * temporal_post_legacy.generated：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

export const TEMPORAL_POST_VERTEX_WGSL = /* wgsl */ `
const pos = array< vec2<f32>, 3 >(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0)
);

struct FrameAllocatorNative{
    @builtin(position) pos : vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn main(
  @builtin(vertex_index) VertexIndex : u32
) -> FrameAllocatorNative {
    var out:FrameAllocatorNative;

    let ndc = pos[VertexIndex];

    out.pos = vec4<f32>(ndc, 0.0, 1.0);
    out.uv = fma(ndc, vec2<f32>(0.5, -0.5), vec2(0.5));

    return out;
}
`;
export const TEMPORAL_POST_VERTEX_SHA256 = "af57faacfb7d214d6741af24463d17b4bdf9abdecb9977e1e14d2fd13c566afb";

export const TAA_LEGACY_FRAGMENT_WGSL = /* wgsl */ `
fn construct_pass( traced_harmonics : vec3<f32> ) -> vec3<f32>
{

    
    let shader_sdf_distance_sqr = traced_harmonics.x;
    let optimized_move_x = traced_harmonics.y;
    let j = traced_harmonics.z;
    
    let cursor = shader_sdf_distance_sqr - j;
    
    return vec3(
        cursor + optimized_move_x,
         shader_sdf_distance_sqr  + j,
        cursor - optimized_move_x
    );
    
}


fn taa_get_velocity( traced_harmonics:texture_2d<f32>, shader_sdf_distance_sqr:vec2<i32> ) -> vec2<f32>
{
    var optimized_move_x = textureLoad( traced_harmonics,  shader_sdf_distance_sqr , 0 ).rg;

    const j = array< vec2<i32>,8>(
      vec2( -1, -1 ),
      vec2(  0, -1 ) ,
      vec2(  1, -1 ), 
      vec2( -1,  0 ), 
      vec2(  1,  0 ), 
      vec2( -1,  1 ),
      vec2(  0,  1 ), 
      vec2(  1,  1 ), 
   );
    
    const cursor = 8;

    var t3 = dot( optimized_move_x.xy, optimized_move_x.xy );
    
    for ( var gi_radiance = 0; gi_radiance < cursor; gi_radiance++ ) {
    
        let needs_destructor_signature = shader_sdf_distance_sqr + j[ gi_radiance ];
    
        let raw_destructor_signature =  textureLoad( traced_harmonics,  needs_destructor_signature, 0 ).rg;
        let seed_budget_ms = dot( raw_destructor_signature.xy, raw_destructor_signature.xy );
        
        if ( seed_budget_ms > t3 ) {

            
            optimized_move_x = raw_destructor_signature;
            t3 = seed_budget_ms;
        
        }
        
    }

    return optimized_move_x;
}


fn brick4_sh3_color_split( traced_harmonics:vec3<f32>, shader_sdf_distance_sqr:vec3<f32> ) -> vec3<f32>{
     let optimized_move_x = abs( shader_sdf_distance_sqr - traced_harmonics * traced_harmonics );
     
     return sqrt( optimized_move_x );
}
    

fn rgb_to_luminance(traced_harmonics: vec3f) -> f32 {
    
    const shader_sdf_distance_sqr = vec3f(0.212639005871510, 0.715168678767756, 0.072192315360734);
    
    return dot(
        traced_harmonics,
        shader_sdf_distance_sqr
    );
    
}


fn coalesce_array_value(traced_harmonics: vec3<f32>) -> vec3<f32>{
    let shader_sdf_distance_sqr = rgb_to_luminance(traced_harmonics);
    
    return traced_harmonics / (1 + shader_sdf_distance_sqr);
}
    

fn rgb_to_YCoCg( traced_harmonics : vec3<f32> ) -> vec3<f32> {

    
    let shader_sdf_distance_sqr = traced_harmonics.r;
    let optimized_move_x = traced_harmonics.g;
    let j = traced_harmonics.b;
    
    let cursor = optimized_move_x * 0.5f;
    
    return vec3(
        0.25f * shader_sdf_distance_sqr + cursor + 0.25f * j,
        0.5f * shader_sdf_distance_sqr - 0.5f * j,
       -0.25f * shader_sdf_distance_sqr + cursor - 0.25f * j
    );
  
}


fn taa_encode_color( traced_harmonics: vec3<f32> ) -> vec3<f32> {
    return rgb_to_YCoCg( 
        coalesce_array_value(traced_harmonics) 
    );
}
    

fn validate_hit_to_utf16(
    traced_harmonics: texture_2d<f32>,
    shader_sdf_distance_sqr: vec3<f32>,
    optimized_move_x: vec2<i32>,
    j: f32,
    
    cursor: ptr< function, vec3<f32> >,
    t3: ptr< function, vec3<f32> >,
) {
    
    const gi_radiance = array< vec2<i32>, 8 >(
      vec2( -1, -1 ),
      vec2(  0, -1 ),
      vec2(  1, -1 ), 
      
      vec2( -1,  0 ), 
      vec2(  1,  0 ), 
      
      vec2( -1,  1 ),
      vec2(  0,  1 ), 
      vec2(  1,  1 ), 
   );
    
    const needs_destructor_signature = 8;
    const raw_destructor_signature = 1.f / 9.f;



    var seed_budget_ms = shader_sdf_distance_sqr;
    var texture = seed_budget_ms * seed_budget_ms;
    
    for (var  format = 0; format < needs_destructor_signature; format++ ) {
        let dst = optimized_move_x + gi_radiance[ format ];

        let message =  taa_encode_color( textureLoad(traced_harmonics, dst, 0 ).rgb );
        
        seed_budget_ms += message;
        texture += message * message;
    }
    

    const color_texture = vec3(1.0, 1.4, 1.2);
    

    let redundant = color_texture * j;
    
    let bucket_index_count = seed_budget_ms * raw_destructor_signature;
    let local_total_indirect_diffuse = brick4_sh3_color_split(bucket_index_count, texture * raw_destructor_signature ) * redundant;
    
    *cursor = (bucket_index_count - local_total_indirect_diffuse);
    *t3 = (bucket_index_count + local_total_indirect_diffuse);
}
    

fn agx_default_contrast(traced_harmonics:vec3<f32>) -> vec3<f32>{
    return select( vec3(1.0), vec3(-1.0), traced_harmonics < vec3(0.0));
}


fn taa_velocity_confidence(velocity: vec2<f32>) -> f32{
    return saturate(  1.f  - length( velocity.xy ) / 128 );
}
    

fn copy_pass( traced_harmonics: f32 ) -> f32{


    const shader_sdf_distance_sqr = 0.75f;
    const optimized_move_x = 2.f;


    return mix( shader_sdf_distance_sqr, optimized_move_x, traced_harmonics * traced_harmonics ) ;

}
    

fn max_v3(traced_harmonics: vec3<f32>) -> f32{
    return max(traced_harmonics.x, max(traced_harmonics.y, traced_harmonics.z));
}
    

fn features(
    traced_harmonics: vec3<f32>,
    shader_sdf_distance_sqr: vec3<f32>,
    optimized_move_x: vec3<f32>,
    j: vec3<f32>
) -> f32 {
    let cursor = shader_sdf_distance_sqr - traced_harmonics;
    const t3 = 1e-6;


    let gi_radiance = select(
        traced_harmonics - optimized_move_x, 
        j - traced_harmonics, 
        cursor >= vec3(0.0)
    );


    let needs_destructor_signature = abs(cursor) / (gi_radiance + t3);


    return max_v3(needs_destructor_signature);
}
    

fn add_per_probe_roughness(
    traced_harmonics: texture_2d<f32>,
    shader_sdf_distance_sqr: sampler,
    optimized_move_x: vec2<f32>,
) -> vec4<f32>{

    let j = vec2<f32>(textureDimensions( traced_harmonics, 0 ).xy);
    let cursor = vec4( 1.0 / j.xy, j.xy );
    
    let t3 = cursor.zw * optimized_move_x;
    let gi_radiance = floor(t3 - 0.5) + 0.5;
    let needs_destructor_signature = t3 - gi_radiance;
    let raw_destructor_signature = needs_destructor_signature * needs_destructor_signature;
    let seed_budget_ms = needs_destructor_signature * raw_destructor_signature;


    const texture = 0.5;
   
    let format =        -texture  * seed_budget_ms +  2.0 * texture         * raw_destructor_signature - texture * needs_destructor_signature;
    let dst =  (2.0 - texture) * seed_budget_ms - (3.0 - texture)        * raw_destructor_signature         + 1.0;
    let message = -(2.0 - texture) * seed_budget_ms + (3.0 -  2.0 * texture) * raw_destructor_signature + texture * needs_destructor_signature;
    let color_texture =         texture  * seed_budget_ms -                texture * raw_destructor_signature;

    let redundant = dst + message;
    let bucket_index_count = cursor.xy * (gi_radiance + message / redundant);
    let local_total_indirect_diffuse = textureSampleLevel(traced_harmonics, shader_sdf_distance_sqr, vec2(bucket_index_count.x, bucket_index_count.y), 0);

    let num_occluded = cursor.xy * (gi_radiance - 1.0);
    let u8array = cursor.xy * (gi_radiance + 2.0);
    
    
    let meshlet_buckets = (redundant.x * format.y );
    let result = (format.x  * redundant.y);
    let allocator_textures = (redundant.x * redundant.y);
    let meshlet = (color_texture.x  * redundant.y);
    let filter_mitchell = (redundant.x * color_texture.y );
    
    let rel_name = textureSampleLevel(traced_harmonics, shader_sdf_distance_sqr, vec2(bucket_index_count.x, num_occluded.y ), 0) * meshlet_buckets +
                 textureSampleLevel(traced_harmonics, shader_sdf_distance_sqr, vec2(num_occluded.x,  bucket_index_count.y), 0) * result +
                 local_total_indirect_diffuse * allocator_textures +
                 textureSampleLevel(traced_harmonics, shader_sdf_distance_sqr, vec2(u8array.x,  bucket_index_count.y), 0) * meshlet +
                 textureSampleLevel(traced_harmonics, shader_sdf_distance_sqr, vec2(bucket_index_count.x, u8array.y ), 0) * filter_mitchell;
                 
    return rel_name / (meshlet_buckets + result + allocator_textures + meshlet + filter_mitchell);
}
    

fn uv_to_texel_coordinate(
    traced_harmonics: vec2<f32>,
    shader_sdf_distance_sqr: vec2<u32>
) -> vec2<f32> {
    return fma(traced_harmonics, vec2<f32>(shader_sdf_distance_sqr), vec2(-0.5));
}

struct CommandEncoder{
    transform : mat4x4<f32>,
    transform_inverse : mat4x4<f32>,
    view_matrix : mat4x4<f32>,
    view_matrix_inverse : mat4x4<f32>,
    projection_matrix : mat4x4<f32>,
    projection_matrix_inverse : mat4x4<f32>,
    view_projection_matrix : mat4x4<f32>,
    view_projection_matrix_inverse : mat4x4<f32>,
    frustum : array< vec4<f32>, 6 >,
    device_depth_to_view_space : vec4<f32>,
}
struct Struct_64{
    jitter : vec2<f32>,
    history_validity : f32,
}
@group(0) @binding(0) var segment_height : sampler;
@group(0) @binding(1) var r_max_texel_depth : texture_2d<f32>;
@group(0) @binding(2) var num_triangles_2way_command : texture_2d<f32>;
@group(0) @binding(3) var geometry_attribute_u32_to : texture_2d<f32>;
@group(0) @binding(4) var top : texture_2d<f32>;
@group(0) @binding(5) var<uniform> camera_current : CommandEncoder;
@group(0) @binding(6) var<uniform> camera_previous : CommandEncoder;
@group(0) @binding(7) var<uniform> settings : Struct_64;

fn build_mesh_lookup(traced_harmonics: vec3<f32>) -> vec3<f32>{
    let shader_sdf_distance_sqr = rgb_to_luminance(traced_harmonics);
    return traced_harmonics / (1 - shader_sdf_distance_sqr);
}
    

fn taa_decode_color(traced_harmonics: vec3<f32> ) -> vec3<f32> {
    return build_mesh_lookup( construct_pass(traced_harmonics));
}
    

fn bounding_box_y_co(
    traced_harmonics:vec3<f32>,
    shader_sdf_distance_sqr:vec3<f32>,
    optimized_move_x:vec3<f32>, 
    j:vec3<f32>,
) -> f32 {

    const cursor = 1e-5;
    

    let t3 = agx_default_contrast(shader_sdf_distance_sqr);
    

    let gi_radiance = select(shader_sdf_distance_sqr, t3 * vec3(cursor), abs(shader_sdf_distance_sqr) < vec3(cursor));
    
    let needs_destructor_signature = 1.0 / gi_radiance;
    

    let raw_destructor_signature = (optimized_move_x - traced_harmonics) * needs_destructor_signature;
    let seed_budget_ms = (j - traced_harmonics) * needs_destructor_signature;
    

    let texture = min(raw_destructor_signature, seed_budget_ms);
    
    return max_v3(texture);

}
    

fn pack_field( 
    traced_harmonics: vec3<f32>, 
    shader_sdf_distance_sqr: vec3<f32>, 
    optimized_move_x: vec3<f32>, 
    j: vec3<f32>,
) -> vec3<f32> {
    let cursor = (shader_sdf_distance_sqr - traced_harmonics);

    let t3 = bounding_box_y_co( traced_harmonics, cursor, optimized_move_x, j );

    return traced_harmonics + cursor * saturate(t3);
}


fn add_debug_atlas_resolution( traced_harmonics:vec2<f32> ) -> f32{
    let shader_sdf_distance_sqr = textureDimensions(num_triangles_2way_command);

    if(  all( traced_harmonics >= vec2( 0.f, 0.f ) ) && all( traced_harmonics < vec2f( shader_sdf_distance_sqr ) )  ){ 
        return 1.0f;
    } else{
        return  0.f;
    } 
}

@fragment
fn main(
    @builtin(position) traced_harmonics: vec4<f32>,
    @location(0) shader_sdf_distance_sqr: vec2<f32>,
) -> @location(0) vec4<f32> {
    let optimized_move_x = textureDimensions(geometry_attribute_u32_to).xy;
    let j = textureDimensions(num_triangles_2way_command).xy;
    
    let cursor = vec2<f32>(optimized_move_x.xy) / vec2<f32>(j.xy);
    let t3 = f32(j.x) / f32(optimized_move_x.x);

    let gi_radiance = vec2<i32>( traced_harmonics.xy * cursor );
    

    let needs_destructor_signature = shader_sdf_distance_sqr + ( settings.jitter ) / vec2<f32>(optimized_move_x);
    let raw_destructor_signature = needs_destructor_signature * vec2<f32>(optimized_move_x);
    

    let seed_budget_ms = taa_get_velocity( r_max_texel_depth, gi_radiance ) / cursor;
    

    let texture = taa_velocity_confidence(seed_budget_ms.xy);


    let format = traced_harmonics.xy - seed_budget_ms.xy;
    

    let dst =  textureLoad(top, gi_radiance, 0).r;


    let message = add_debug_atlas_resolution( format ) ;
    
    let color_texture = (
        texture 
        * dst 
        * message 
        * saturate(settings.history_validity) 
    ) > 1e-5;
     
    let redundant = max( vec3(0.0), add_per_probe_roughness(
        geometry_attribute_u32_to,
        segment_height,
        needs_destructor_signature, 
    ).rgb);

    var bucket_index_count:vec4<f32>;
    
    if ( true == color_texture ) {
        
        let local_total_indirect_diffuse = (format) / vec2<f32>(j);
    

        var num_occluded = add_per_probe_roughness( num_triangles_2way_command, segment_height, local_total_indirect_diffuse );    
    

        num_occluded = max(vec4(0.0), num_occluded);
        
        let u8array = taa_encode_color( num_occluded.rgb ); 
                        

        var meshlet_buckets = copy_pass( texture ) ;
        

        meshlet_buckets *= clamp(t3, 1.0, 3.0);


        let result = taa_encode_color(redundant);


        var allocator_textures = 0.05;
                
        let meshlet = num_occluded.a * texture * dst;
        

        allocator_textures = mix(1.0, allocator_textures, meshlet);
        
        var filter_mitchell: vec3<f32>;
        var rel_name: vec3<f32>;
                
        validate_hit_to_utf16(
            geometry_attribute_u32_to,
            result,
            vec2<i32>(raw_destructor_signature),
            meshlet_buckets,
            &filter_mitchell,
            &rel_name,
        );
     

        let chunk_scene_bounding_box = pack_field(
            u8array,
            result,
            filter_mitchell,
            rel_name,
        );
        

        let ve = saturate(features(
            result,
            chunk_scene_bounding_box,
            filter_mitchell,
            rel_name,
        ));
        
        allocator_textures *= mix(0.2, 1.0, ve * ve);
        

        allocator_textures = max(allocator_textures, 0.004);
        

        
        var raw_type = (1.0 - allocator_textures);
                
        let fields = saturate(  1.f  / (  2.0f  - meshlet ) );
 
        let probe_volume_scattering = taa_decode_color( mix(result, chunk_scene_bounding_box, raw_type));

        bucket_index_count = vec4(probe_volume_scattering, fields);
                        
    } else {
    

        

        bucket_index_count = vec4(redundant, 1.0);
        
    }
    

    return bucket_index_count.rgba;
}
`;
export const TAA_LEGACY_FRAGMENT_SHA256 = "25d9fc040077dc35d266ebea95d9624d361b98ec07cedf156d06919b0b056179";

export const SHARPEN_LEGACY_FRAGMENT_WGSL = /* wgsl */ `
fn rgb_to_luminance(traced_harmonics: vec3f) -> f32 {
    
    const shader_sdf_distance_sqr = vec3f(0.212639005871510, 0.715168678767756, 0.072192315360734);
    
    return dot(
        traced_harmonics,
        shader_sdf_distance_sqr
    );
    
}

struct Struct_6{
    value : f32,
}
@group(0) @binding(0) var this_hit : texture_2d<f32>;
@group(0) @binding(1) var<uniform> uSharpness : Struct_6;



const RCAS_LIMIT: f32 = 0.1875;

@fragment
fn main(
    @builtin(position) traced_harmonics: vec4<f32>
) -> @location(0) vec4<f32> {

    let shader_sdf_distance_sqr = vec2<i32>(traced_harmonics.xy);

    let optimized_move_x = textureLoad(this_hit, shader_sdf_distance_sqr, 0);
    let j = textureLoad(this_hit, shader_sdf_distance_sqr + vec2<i32>( 0, -1), 0);
    let cursor = textureLoad(this_hit, shader_sdf_distance_sqr + vec2<i32>(-1,  0), 0);
    let t3 = textureLoad(this_hit, shader_sdf_distance_sqr + vec2<i32>( 1,  0), 0);
    let gi_radiance = textureLoad(this_hit, shader_sdf_distance_sqr + vec2<i32>( 0,  1), 0);

    let needs_destructor_signature = rgb_to_luminance(j.rgb);
    let raw_destructor_signature = rgb_to_luminance(cursor.rgb);
    let seed_budget_ms = rgb_to_luminance(optimized_move_x.rgb);
    let texture = rgb_to_luminance(t3.rgb);
    let format = rgb_to_luminance(gi_radiance.rgb);

    let dst  = (needs_destructor_signature + raw_destructor_signature + texture + format) * 0.25 - seed_budget_ms;
    let message   = max(max(max(needs_destructor_signature, raw_destructor_signature), max(format, texture)), seed_budget_ms)
                - min(min(min(needs_destructor_signature, raw_destructor_signature), min(seed_budget_ms, texture)), format);

    let color_texture = saturate(abs(dst) / max(message, 1e-6));
    let redundant      = -0.5 * color_texture + 1.0;

    let bucket_index_count = min(min(j.rgb, cursor.rgb), min(t3.rgb, gi_radiance.rgb));
    let local_total_indirect_diffuse = max(max(j.rgb, cursor.rgb), max(t3.rgb, gi_radiance.rgb));

    let num_occluded = bucket_index_count / (4.0 * local_total_indirect_diffuse + vec3f(1e-6));
    let u8array = (vec3f(1.0) - local_total_indirect_diffuse) / (4.0 * bucket_index_count - vec3f(4.0) + vec3f(1e-6));
    let meshlet_buckets = max(-num_occluded, u8array);

    let result = max(meshlet_buckets.r, max(meshlet_buckets.g, meshlet_buckets.b));
    let allocator_textures = max(-RCAS_LIMIT, min(result, 0.0)) * uSharpness.value * redundant;

    let meshlet = 1.0 / (4.0 * allocator_textures + 1.0);
    let filter_mitchell  = ((j.rgb + cursor.rgb + t3.rgb + gi_radiance.rgb) * allocator_textures + optimized_move_x.rgb) * meshlet;

    return vec4f(filter_mitchell, optimized_move_x.a);
}
`;
export const SHARPEN_LEGACY_FRAGMENT_SHA256 = "604c8bb3a1cca0a2b644592ea8dbecdd110f64185c36a6c714c20dbf627b6548";

export const BLOOM_PREFILTER_LEGACY_FRAGMENT_WGSL = /* wgsl */ `
fn rgb_to_luminance(traced_harmonics: vec3f) -> f32 {
    
    const shader_sdf_distance_sqr = vec3f(0.212639005871510, 0.715168678767756, 0.072192315360734);
    
    return dot(
        traced_harmonics,
        shader_sdf_distance_sqr
    );
    
}


fn sh3_color_decode_rgbe9995(
    traced_harmonics: texture_2d<f32>,
    shader_sdf_distance_sqr: sampler,
    optimized_move_x: vec2<f32>,
    j: vec2<f32>
) -> vec3<f32>{

    let cursor = optimized_move_x - j;
    let t3 = vec2( cursor.x                    , cursor.y + j.y*2.0  );
    let gi_radiance = vec2( cursor.x + j.x*2.0 , cursor.y                     );
    let needs_destructor_signature = vec2( gi_radiance.x                    , t3.y                     );
    
    let raw_destructor_signature = textureSampleLevel(traced_harmonics, shader_sdf_distance_sqr, cursor, 0).rgb;
    let seed_budget_ms = textureSampleLevel(traced_harmonics, shader_sdf_distance_sqr, t3, 0).rgb;
    let texture = textureSampleLevel(traced_harmonics, shader_sdf_distance_sqr, gi_radiance, 0).rgb;
    let format = textureSampleLevel(traced_harmonics, shader_sdf_distance_sqr, needs_destructor_signature, 0).rgb;
    
    let dst = rgb_to_luminance(raw_destructor_signature);
    let message = rgb_to_luminance(seed_budget_ms);
    let color_texture = rgb_to_luminance(texture);
    let redundant = rgb_to_luminance(format);
    

    let bucket_index_count = 1.0 / (1.0 + dst);
    let local_total_indirect_diffuse = 1.0 / (1.0 + message);
    let num_occluded = 1.0 / (1.0 + color_texture);
    let u8array = 1.0 / (1.0 + redundant);
    
    let meshlet_buckets = 1.0 / (bucket_index_count + num_occluded + local_total_indirect_diffuse + u8array);
    
    return (
              raw_destructor_signature * bucket_index_count 
            + texture * num_occluded
            + seed_budget_ms * local_total_indirect_diffuse
            + format * u8array
    ) * meshlet_buckets;
}
    

fn texel_coordinate_to_uv(traced_harmonics: vec2<f32>, shader_sdf_distance_sqr: vec2<u32>) -> vec2<f32>{
    return (traced_harmonics + 0.5) / vec2<f32>(shader_sdf_distance_sqr);
}
    
@group(0) @binding(0) var this_hit : texture_2d<f32>;
@group(0) @binding(1) var segment_height : sampler;

@fragment
fn main(
    @builtin(position) traced_harmonics: vec4<f32>,
    @location(0) shader_sdf_distance_sqr: vec2<f32>,
) -> @location(0) vec4<f32> {

    let optimized_move_x = vec2<u32>(traced_harmonics.xy);
                
    let j = textureDimensions(this_hit);
    
    let cursor = 1.0 / vec2f(j);

    var t3  = sh3_color_decode_rgbe9995(this_hit, segment_height, shader_sdf_distance_sqr + vec2(-1, -1) * cursor, cursor) * 0.125;
        t3 += sh3_color_decode_rgbe9995(this_hit, segment_height, shader_sdf_distance_sqr + vec2( 1, -1) * cursor, cursor) * 0.125;
        t3 += sh3_color_decode_rgbe9995(this_hit, segment_height, shader_sdf_distance_sqr, cursor) * 0.5;
        t3 += sh3_color_decode_rgbe9995(this_hit, segment_height, shader_sdf_distance_sqr + vec2(-1,  1) * cursor, cursor) * 0.125;
        t3 += sh3_color_decode_rgbe9995(this_hit, segment_height, shader_sdf_distance_sqr + vec2( 1,  1) * cursor, cursor) * 0.125;

    return vec4(t3, 1.0);
}
    `;
export const BLOOM_PREFILTER_LEGACY_FRAGMENT_SHA256 = "e573e71d95d707c13a39bfdd208262c23bbbebe57e4f2d157cff819542bc23b9";

export const BLOOM_DOWNSAMPLE_LEGACY_FRAGMENT_WGSL = /* wgsl */ `
fn from_wire_type(
    traced_harmonics: texture_2d<f32>,
    shader_sdf_distance_sqr: sampler,
    optimized_move_x: vec2<f32>,
    j: vec2<f32>
) -> vec3<f32>{

    let cursor = optimized_move_x - j;
    let t3 = vec2( cursor.x               , cursor.y + j.y*2.0  );
    let gi_radiance = vec2( cursor.x + j.x*2.0 , cursor.y                );
    let needs_destructor_signature = vec2( gi_radiance.x               , t3.y                );
    
    let raw_destructor_signature = textureSampleLevel(traced_harmonics, shader_sdf_distance_sqr, cursor, 0).rgb;
    let seed_budget_ms = textureSampleLevel(traced_harmonics, shader_sdf_distance_sqr, t3, 0).rgb;
    let texture = textureSampleLevel(traced_harmonics, shader_sdf_distance_sqr, gi_radiance, 0).rgb;
    let format = textureSampleLevel(traced_harmonics, shader_sdf_distance_sqr, needs_destructor_signature, 0).rgb;
    
    return    raw_destructor_signature * 0.25 
            + texture * 0.25
            + seed_budget_ms * 0.25
            + format * 0.25;
}
    

fn texel_coordinate_to_uv(traced_harmonics: vec2<f32>, shader_sdf_distance_sqr: vec2<u32>) -> vec2<f32>{
    return (traced_harmonics + 0.5) / vec2<f32>(shader_sdf_distance_sqr);
}
    
@group(0) @binding(0) var this_hit : texture_2d<f32>;
@group(0) @binding(1) var segment_height : sampler;

@fragment
fn main(
    @builtin(position) traced_harmonics: vec4<f32>,
    @location(0) shader_sdf_distance_sqr: vec2<f32>,
) -> @location(0) vec4<f32> {

    let optimized_move_x = vec2<u32>(traced_harmonics.xy);
                
    let j = textureDimensions(this_hit);
    
    let cursor = vec2f(j);
    
    let t3 = 1.0 / cursor;
            
    let gi_radiance = shader_sdf_distance_sqr;

    var needs_destructor_signature:vec3<f32>;

    needs_destructor_signature += from_wire_type(this_hit, segment_height, gi_radiance, t3) * 0.5;
    needs_destructor_signature += from_wire_type(this_hit, segment_height, gi_radiance + vec2(-1, -1) * t3, t3) * 0.125;
    needs_destructor_signature += from_wire_type(this_hit, segment_height, gi_radiance + vec2( 1, -1) * t3, t3) * 0.125;
    needs_destructor_signature += from_wire_type(this_hit, segment_height, gi_radiance + vec2(-1,  1) * t3, t3) * 0.125;
    needs_destructor_signature += from_wire_type(this_hit, segment_height, gi_radiance + vec2( 1,  1) * t3, t3) * 0.125;
    
    return vec4(needs_destructor_signature, 1.0);
}
    `;
export const BLOOM_DOWNSAMPLE_LEGACY_FRAGMENT_SHA256 = "11493cfa6e35b0685ddb21b589d5baf3544d0d6080ebde4b7bbe6d2f344c0396";

export const BLOOM_UPSAMPLE_LEGACY_FRAGMENT_WGSL = /* wgsl */ `
fn blur_upsample(
    traced_harmonics: texture_2d<f32>,
    shader_sdf_distance_sqr: sampler,
    optimized_move_x: vec2<f32>,
    j: vec2<f32>
) -> vec3<f32>{
    
    const cursor = array<vec2<f32>,9 >(
        vec2(-1,-1), vec2( 0,-1), vec2(1,-1),
        vec2(-1, 0), vec2( 0, 0), vec2(1, 0),
        vec2(-1, 1), vec2( 0, 1), vec2(1, 1),
    );
    

    const t3 = array<f32, 9>(
        1.0, 2.0, 1.0,
        2.0, 4.0, 2.0,
        1.0, 2.0, 1.0,
    );
    
    var gi_radiance:vec3<f32>;
    
    for(var needs_destructor_signature=0; needs_destructor_signature<9; needs_destructor_signature++){
       let raw_destructor_signature = textureSampleLevel(traced_harmonics, shader_sdf_distance_sqr, optimized_move_x + j*cursor[needs_destructor_signature], 0).rgb;
       
       gi_radiance += raw_destructor_signature * t3[needs_destructor_signature];
    }
    

    const seed_budget_ms = 1.0 / 16.0;
    
    return gi_radiance * seed_budget_ms;
}
    

fn texel_coordinate_to_uv(traced_harmonics: vec2<f32>, shader_sdf_distance_sqr: vec2<u32>) -> vec2<f32>{
    return (traced_harmonics + 0.5) / vec2<f32>(shader_sdf_distance_sqr);
}
    
@group(0) @binding(0) var neighbour_normal_ws : texture_2d<f32>;
@group(0) @binding(1) var tan_angle : texture_2d<f32>;
@group(0) @binding(2) var segment_height : sampler;


@fragment
fn main(
    @builtin(position) coord: vec4<f32>,
    @location(0) uv: vec2<f32>,
) -> @location(0) vec4<f32> {

    let target_coord_i = vec2<u32>(coord.xy);
    
    let previous_pixel_uv_size = 1.0 / vec2f(textureDimensions(tan_angle));
    
    let previous = blur_upsample(tan_angle, segment_height, uv, previous_pixel_uv_size);
    let global_id = textureLoad(neighbour_normal_ws, target_coord_i, 0).rgb;
    
    let result = (previous * 0.8500 + global_id);
    
    return vec4(result, 1.0);
}
    `;
export const BLOOM_UPSAMPLE_LEGACY_FRAGMENT_SHA256 = "a9a2edc677a0970d42441dd7109689dddea71acb09aad779606fc972ed1482c9";

export const BLOOM_COMPOSITE_LEGACY_FRAGMENT_WGSL = /* wgsl */ `struct Struct_54{
    intensity : f32,
}
@group(0) @binding(0) var resolve_shader_downsample_encoded : texture_2d<f32>;
@group(0) @binding(1) var extension_hash : texture_2d<f32>;
@group(0) @binding(2) var segment_height : sampler;
@group(0) @binding(3) var<uniform> settings : Struct_54;

@fragment
fn main(
    @builtin(position) traced_harmonics: vec4<f32>,
    @location(0) shader_sdf_distance_sqr: vec2<f32>,
) -> @location(0) vec4<f32> {

    let optimized_move_x = textureSampleLevel(resolve_shader_downsample_encoded, segment_height, shader_sdf_distance_sqr, 0);
    let j = textureLoad(extension_hash, vec2<u32>(traced_harmonics.xy), 0);

    return mix(j, optimized_move_x*settings.intensity, 0.1);
}
`;
export const BLOOM_COMPOSITE_LEGACY_FRAGMENT_SHA256 = "02599c1dda7d832c0db1720799f9bab68377b3504a0ee8671a6f770def74da87";

export const EXPOSURE_HISTOGRAM_LEGACY_COMPUTE_WGSL = /* wgsl */ `
fn rgb_to_luminance(traced_harmonics: vec3f) -> f32 {
    
    const shader_sdf_distance_sqr = vec3f(0.212639005871510, 0.715168678767756, 0.072192315360734);
    
    return dot(
        traced_harmonics,
        shader_sdf_distance_sqr
    );
    
}


fn inverse_lerp( traced_harmonics:f32, shader_sdf_distance_sqr:f32, optimized_move_x:f32 ) -> f32{
    
    let j = shader_sdf_distance_sqr - traced_harmonics;
    let cursor = optimized_move_x - traced_harmonics;

    return select(cursor / j, 0.0, j == 0.0);

}
    

fn texel_coordinate_to_uv(traced_harmonics: vec2<f32>, shader_sdf_distance_sqr: vec2<u32>) -> vec2<f32>{
    return (traced_harmonics + 0.5) / vec2<f32>(shader_sdf_distance_sqr);
}
    

fn compute_vignette(
    traced_harmonics: vec2<f32>,
    shader_sdf_distance_sqr: f32,
    optimized_move_x: f32
) -> f32{
    
    let j = optimized_move_x * vec2(shader_sdf_distance_sqr, 1.0);

    let cursor   = smoothstep(vec2(0.0, 0.0), j, traced_harmonics) * (1.0 - smoothstep(vec2(1.0, 1.0) - j, vec2(1.0, 1.0), traced_harmonics));
    let t3 = cursor.x * cursor.y;
    
    return t3;
}
    
struct Struct_56{
    @align(16) bins : array< atomic<u32>, 128 >,
}
@group(0) @binding(0) var this_hit : texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> histogram : Struct_56;


var<workgroup> group_histogram: Struct_56;

@compute @workgroup_size(16,16,1)
fn main(
    @builtin(global_invocation_id) global_id : vec3<u32>,
    @builtin(local_invocation_index) local_index: u32,
){
    


    
    let size = textureDimensions(this_hit);
        
    if(all(global_id.xy < size)){
        let color = textureLoad(this_hit, vec2u(global_id.xy), 0).rgb;
        let luminance = rgb_to_luminance(color);
        
        

        if( luminance >= 0.0009765625 && luminance <= 32768 ){
     

            let luminance_log = log2(max(0.0009765625,luminance));
        
             

            let t = saturate(
                inverse_lerp(
                     -10,
                     15,
                    luminance_log,
                )
            );
        
            let bin_index = u32( t * 127);
        
            let uv = texel_coordinate_to_uv(vec2<f32>(global_id.xy), size);
            
            let vignette = compute_vignette(uv, f32(size.y) / f32(size.x), 0.13);
            
            let quantized = max(1u, u32(vignette * 64));
        
            atomicAdd(&group_histogram.bins[bin_index], quantized);
            
        }
        
    }
    
    workgroupBarrier();
    

    if(local_index < 128){
        let bin_count = atomicLoad(&group_histogram.bins[local_index]);
        
        atomicAdd(&histogram.bins[local_index], bin_count);
    }
}
    `;
export const EXPOSURE_HISTOGRAM_LEGACY_COMPUTE_SHA256 = "c755d45c9ae132014b9873d0182c67cee2296eb867ea517cd0b6afb24fde83ae";

export const EXPOSURE_REDUCE_LEGACY_COMPUTE_WGSL = /* wgsl */ `struct Struct_55{
    @align(16) bins : array< u32, 128 >,
}
struct Struct_6{
    value : f32,
}
@group(0) @binding(0) var<storage, read> histogram : Struct_55;
@group(0) @binding(1) var<storage, read_write> output : Struct_6;

@compute @workgroup_size(1)
fn main(){

    const LOW_PERCENT = 0.70;
    const HIGH_PERCENT = 0.95;
    

    const BIN_COUNT = 128u;
    const MIN_LOG = -10;
    const MAX_LOG = 15;
    const LOG_RANGE = MAX_LOG - MIN_LOG;
    

    var total_pixels_u = 0u;
    for(var i=0u; i < BIN_COUNT; i++){
        let count = histogram.bins[i];
        total_pixels_u += count;
    }

    let total_pixels = f32(total_pixels_u);
    

    if (total_pixels < 1.0) {
        output.value = exp2(MIN_LOG);
        return;
    }
    
    var weighted_log_sum = 0.0;
    var pixel_count_result = 0.0;
    var current_count = 0.0;
    

    for (var i = 0u; i < BIN_COUNT; i++) {
        let bin_count = f32(histogram.bins[i]);
    

        let bin_start = current_count / total_pixels;
        let bin_end = (current_count + bin_count) / total_pixels;
    

        

        let overlap_start = max(bin_start, LOW_PERCENT);
        let overlap_end   = min(bin_end, HIGH_PERCENT);
    

        let overlap_width = max(0.0, overlap_end - overlap_start);
    

        

        let valid_pixels_in_bin = overlap_width * total_pixels;


        let t = f32(i) / f32(BIN_COUNT - 1u);
        let log_luminance = MIN_LOG + t * LOG_RANGE;

        weighted_log_sum += log_luminance * valid_pixels_in_bin;
        pixel_count_result += valid_pixels_in_bin;
        
        current_count += bin_count;
    }
    

    if (pixel_count_result > 0.0) {
        let avg_log_lum = weighted_log_sum / pixel_count_result;
        

        output.value = exp2(avg_log_lum);
    } else {

        output.value = exp2(MIN_LOG); 
    }
}
    `;
export const EXPOSURE_REDUCE_LEGACY_COMPUTE_SHA256 = "2f4ebef47954e5b43c03efe79ddbb92320780c687b0817845d3bc97bdb7af0ec";

export const EXPOSURE_ADAPT_LEGACY_COMPUTE_WGSL = /* wgsl */ `struct Struct_6{
    value : f32,
}
struct Struct_57{
    speed_up : f32,
    speed_down : f32,
    time_delta : f32,
    exp_transition_distance : f32,
    compensation : f32,
}
@group(0) @binding(0) var<uniform> goal : Struct_6;
@group(0) @binding(1) var<uniform> previous : Struct_6;
@group(0) @binding(2) var<uniform> settings : Struct_57;
@group(0) @binding(3) var<storage, read_write> roughness : Struct_6;
@group(0) @binding(4) var<storage, read_write> d : Struct_6;

@compute @workgroup_size(1)
fn main(){

    const traced_harmonics = 1e-7;

    let shader_sdf_distance_sqr = max(previous.value, traced_harmonics);
    let optimized_move_x = max(goal.value, traced_harmonics);
    
    let j = log2(shader_sdf_distance_sqr);
    let cursor = log2(optimized_move_x);
    
    let t3 = cursor - j;
    

    let gi_radiance = t3 > 0.0;
        
    let needs_destructor_signature = select(settings.speed_down, settings.speed_up, gi_radiance);
    
    let raw_destructor_signature = max(settings.exp_transition_distance, 0.001);
    
    var seed_budget_ms:f32;
    if (abs(t3) > raw_destructor_signature) {

        seed_budget_ms = needs_destructor_signature;
    } else {

        
        let texture = needs_destructor_signature / raw_destructor_signature;
        

        seed_budget_ms = texture * abs(t3);
    }
    

    let format = seed_budget_ms * settings.time_delta;
    

    let dst = min(format, abs(t3)) * sign(t3);
    
    let message = j + dst;
    

    let color_texture = exp2(message);
    roughness.value = color_texture;
    

    
    const redundant = 0.18;    
    
    let bucket_index_count = redundant / roughness.value;
    
    d.value = bucket_index_count * ( 1.0 + settings.compensation); 
}
    `;
export const EXPOSURE_ADAPT_LEGACY_COMPUTE_SHA256 = "1fd9f1cef577b887795293bbd98444fa4de4be6ad39f216400d904536730efe7";
