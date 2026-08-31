/**
 * LightDatabase：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import {
  ArrayType,
  CodeChunk,
  WGSL_f32,
  WGSL_mat4x4f,
  WGSL_u32,
  WGSL_vec3f,
  WGSL_vec4f
} from "../core/WebGPUTypes.js";
import { StructType } from "../core/WgslStruct.js";
import { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { DirectionalLight } from "../light/DirectionalLight.js";
import type { Light } from "../light/Light.js";
import type { PointLight } from "../light/PointLight.js";
import type { SpotLight } from "../light/SpotLight.js";
import type { SceneLights } from "../scene/Scene.js";
import {
  GPUDatabase,
  GPUDatabaseDefinition,
  type GPUTypedTable
} from "./GPUDatabase.js";
import { EnvironmentPrefilterPass } from "./EnvironmentPrefilterPass.js";
import {
  GPUTextureContext,
  textureMipLevelCount
} from "./GPUTextureContext.js";
import {
  requireShadeImage,
  uploadShadeImage
} from "./GPUTextureUpload.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import { ShadowContext } from "./ShadowContext.js";
import {
  assertDirectionalLightCapacity,
  MAX_DIRECTIONAL_LIGHTS
} from "./LightCapacity.js";

export { assertDirectionalLightCapacity, MAX_DIRECTIONAL_LIGHTS } from "./LightCapacity.js";
export const LIGHT_FLAG_CASTS_SHADOW = 1;

export type DirectionalLightRecord = {
  direction: ArrayLike<number>;
  color: ArrayLike<number>;
  disk_radius: number;
  flags: number;
  near_clip_distance: number;
  shadow_id: number;
};

export type PointLightRecord = {
  position: ArrayLike<number>;
  color: ArrayLike<number>;
  distance: number;
  radius: number;
  flags: number;
  near_clip_distance: number;
  shadow_id: number;
};

export type SpotLightRecord = PointLightRecord & {
  direction: ArrayLike<number>;
  coneCos: number;
  penumbraCos: number;
};

export type ShadowSpotRecord = {
  atlas: ArrayLike<number>;
  projection: ArrayLike<number>;
};

export const DIRECTIONAL_LIGHT_RECORD_TYPE = StructType.from(
  {
    direction: WGSL_vec3f,
    color: WGSL_vec3f,
    disk_radius: WGSL_f32,
    flags: WGSL_u32,
    near_clip_distance: WGSL_f32,
    shadow_id: WGSL_u32
  },
  "GpuSceneManager"
).pack();

export const POINT_LIGHT_RECORD_TYPE = StructType.from(
  {
    position: WGSL_vec3f,
    color: WGSL_vec3f,
    distance: WGSL_f32,
    radius: WGSL_f32,
    flags: WGSL_u32,
    near_clip_distance: WGSL_f32,
    shadow_id: WGSL_u32
  },
  "AtlasPacker"
).pack();

export const SPOT_LIGHT_RECORD_TYPE = StructType.from({
  position: WGSL_vec3f,
  direction: WGSL_vec3f,
  color: WGSL_vec3f,
  distance: WGSL_f32,
  radius: WGSL_f32,
  coneCos: WGSL_f32,
  penumbraCos: WGSL_f32,
  flags: WGSL_u32,
  near_clip_distance: WGSL_f32,
  shadow_id: WGSL_u32
}).pack();

export const SHADOW_SPOT_RECORD_TYPE = StructType.from(
  {
    atlas: WGSL_vec4f,
    projection: WGSL_mat4x4f
  },
  "WgslJavaScriptCompiler"
);

export const SHADOW_DIRECTIONAL_RECORD_TYPE = ArrayType.from(
  SHADOW_SPOT_RECORD_TYPE,
  3
);

export const LIGHT_INCIDENT_TYPE = StructType.from(
  {
    direction: WGSL_vec3f,
    color: WGSL_vec3f,
    radius: WGSL_f32,
    distance: WGSL_f32
  },
  "GpuPrimitiveTypeTable"
).pack();

export const LIGHT_DATABASE_DEFINITION = GPUDatabaseDefinition.from({
  light_point: POINT_LIGHT_RECORD_TYPE,
  light_directional: DIRECTIONAL_LIGHT_RECORD_TYPE,
  light_spot: SPOT_LIGHT_RECORD_TYPE,
  shadow_point: WGSL_vec4f,
  shadow_spot: SHADOW_SPOT_RECORD_TYPE,
  shadow_directional: SHADOW_DIRECTIONAL_RECORD_TYPE
});

export const POINT_LIGHT_DESCRIPTOR =
  LIGHT_DATABASE_DEFINITION.get("light_point")!;
export const DIRECTIONAL_LIGHT_DESCRIPTOR =
  LIGHT_DATABASE_DEFINITION.get("light_directional")!;
export const SPOT_LIGHT_DESCRIPTOR =
  LIGHT_DATABASE_DEFINITION.get("light_spot")!;
export const SHADOW_POINT_DESCRIPTOR =
  LIGHT_DATABASE_DEFINITION.get("shadow_point")!;
export const SHADOW_SPOT_DESCRIPTOR =
  LIGHT_DATABASE_DEFINITION.get("shadow_spot")!;
export const SHADOW_DIRECTIONAL_DESCRIPTOR =
  LIGHT_DATABASE_DEFINITION.get("shadow_directional")!;

const lightPageAccessChunk = CodeChunk.from(`
fn directional_lights_iteration_mask(database: ptr<storage, array<u32>, read>) -> u32 {
    let page_address = database[${DIRECTIONAL_LIGHT_DESCRIPTOR.page_lookup_address}u];
    if (page_address == ~0u) {
        return 0u;
    }
    return database[page_address + 1u];
}

const POINT_LIGHTS_PAGE_LIMIT: u32 = ${POINT_LIGHT_DESCRIPTOR.page_limit}u;
const POINT_LIGHTS_OCCUPANCY_BITMAP_WORDS: u32 = ${POINT_LIGHT_DESCRIPTOR.occupancy_bitmap_words}u;
const POINT_LIGHTS_ELEMENTS_PER_PAGE: u32 = ${POINT_LIGHT_DESCRIPTOR.elements_per_page}u;

fn point_lights_page_address(database: ptr<storage, array<u32>, read>, page_index: u32) -> u32 {
    return database[page_index + ${POINT_LIGHT_DESCRIPTOR.page_lookup_address}u];
}

fn point_lights_page_bitmap_word(database: ptr<storage, array<u32>, read>, page_address: u32, bitmap_word: u32) -> u32 {
    return database[page_address + 1u + bitmap_word];
}

fn point_lights_slot_to_index(page_index: u32, slot: u32) -> u32 {
    return page_index * ${POINT_LIGHT_DESCRIPTOR.elements_per_page}u + slot;
}

const SPOT_LIGHTS_PAGE_LIMIT: u32 = ${SPOT_LIGHT_DESCRIPTOR.page_limit}u;
const SPOT_LIGHTS_OCCUPANCY_BITMAP_WORDS: u32 = ${SPOT_LIGHT_DESCRIPTOR.occupancy_bitmap_words}u;
const SPOT_LIGHTS_ELEMENTS_PER_PAGE: u32 = ${SPOT_LIGHT_DESCRIPTOR.elements_per_page}u;

fn spot_lights_page_address(database: ptr<storage, array<u32>, read>, page_index: u32) -> u32 {
    return database[page_index + ${SPOT_LIGHT_DESCRIPTOR.page_lookup_address}u];
}

fn spot_lights_page_bitmap_word(database: ptr<storage, array<u32>, read>, page_address: u32, bitmap_word: u32) -> u32 {
    return database[page_address + 1u + bitmap_word];
}

fn spot_lights_slot_to_index(page_index: u32, slot: u32) -> u32 {
    return page_index * ${SPOT_LIGHT_DESCRIPTOR.elements_per_page}u + slot;
}
`);

const lightIncidentChunk = CodeChunk.from(
  `
fn light_pow2(value: f32) -> f32 {
    return value * value;
}

fn light_pow4(value: f32) -> f32 {
    let squared = value * value;
    return squared * squared;
}

fn light_sphere_distance_attenuation(
    distance_to_center: f32,
    radius: f32,
    cutoff_distance: f32
) -> f32 {
    const MIN_RADIUS = 1.0e-2;
    let radius_effective = max(radius, MIN_RADIUS);
    let distance_effective = max(distance_to_center, radius_effective);
    var attenuation = 1.0 / pow(distance_effective, 2.0);
    if (cutoff_distance > 0.0) {
        let surface_distance = max(0.0, distance_to_center - radius);
        attenuation *= light_pow2(saturate(1.0 - light_pow4(surface_distance / cutoff_distance)));
    }
    return attenuation;
}

fn light_get_spot_attenuation(cone_cos: f32, penumbra_cos: f32, angle_cos: f32) -> f32 {
    return smoothstep(cone_cos, penumbra_cos, angle_cos);
}

fn get_directional_light_info(light: ${DIRECTIONAL_LIGHT_RECORD_TYPE.wgsl_ref}) -> ${LIGHT_INCIDENT_TYPE.wgsl_ref} {
    var incident: ${LIGHT_INCIDENT_TYPE.wgsl_ref};
    incident.color = light.color;
    incident.direction = -light.direction;
    incident.radius = light.disk_radius;
    incident.distance = 1.496e11;
    return incident;
}

fn get_point_light_info(
    light: ${POINT_LIGHT_RECORD_TYPE.wgsl_ref},
    position_ws: vec3<f32>,
) -> ${LIGHT_INCIDENT_TYPE.wgsl_ref} {
    let to_light = light.position - position_ws;
    var incident: ${LIGHT_INCIDENT_TYPE.wgsl_ref};
    incident.direction = normalize(to_light);
    let center_distance = length(to_light);
    let attenuation = light_sphere_distance_attenuation(center_distance, light.radius, light.distance);
    incident.color = light.color * attenuation;
    incident.radius = light.radius / center_distance;
    incident.distance = max(0.0, center_distance - light.radius);
    return incident;
}

fn get_spot_light_info(
    light: ${SPOT_LIGHT_RECORD_TYPE.wgsl_ref},
    position_ws: vec3<f32>,
) -> ${LIGHT_INCIDENT_TYPE.wgsl_ref} {
    var incident: ${LIGHT_INCIDENT_TYPE.wgsl_ref};
    let to_light = light.position - position_ws;
    incident.direction = normalize(to_light);
    let center_distance = length(to_light);
    incident.distance = center_distance;
    incident.radius = light.radius / center_distance;
    let angle_cos = dot(incident.direction, -light.direction);
    let spot_attenuation = light_get_spot_attenuation(light.coneCos, light.penumbraCos, angle_cos);
    if (spot_attenuation > 0.0) {
        incident.color = light.color * spot_attenuation;
        incident.color *= light_sphere_distance_attenuation(center_distance, light.radius, light.distance);
    } else {
        incident.color = vec3(0.0);
    }
    return incident;
}

fn get_directional_light_info_by_index(database: ptr<storage, array<u32>>, index: u32) -> ${LIGHT_INCIDENT_TYPE.wgsl_ref} {
    let light = ${DIRECTIONAL_LIGHT_DESCRIPTOR.marshalling_method_read}(database, index);
    return get_directional_light_info(light);
}

fn get_point_light_info_by_index(database: ptr<storage, array<u32>>, index: u32, position_ws: vec3<f32>) -> ${LIGHT_INCIDENT_TYPE.wgsl_ref} {
    let light = ${POINT_LIGHT_DESCRIPTOR.marshalling_method_read}(database, index);
    return get_point_light_info(light, position_ws);
}

fn get_spot_light_info_by_index(database: ptr<storage, array<u32>>, index: u32, position_ws: vec3<f32>) -> ${LIGHT_INCIDENT_TYPE.wgsl_ref} {
    let light = ${SPOT_LIGHT_DESCRIPTOR.marshalling_method_read}(database, index);
    return get_spot_light_info(light, position_ws);
}
`,
  [
    DIRECTIONAL_LIGHT_DESCRIPTOR.chunk_read,
    POINT_LIGHT_DESCRIPTOR.chunk_read,
    SPOT_LIGHT_DESCRIPTOR.chunk_read,
    LIGHT_INCIDENT_TYPE.declaration_chunk
  ]
);

const lightSamplingChunk = CodeChunk.from(
  `
struct SampledLightRecord {
    distance: f32,
    direction: vec3<f32>,
    pdf: f32,
    emission: vec3<f32>,
};

fn light_sample_build_orthonormal_matrix_n(normal: vec3<f32>) -> mat3x3<f32> {
    var tangent: vec3<f32>;
    var bitangent: vec3<f32>;
    if (normal.z < 0.0) {
        let inverse = 1.0 / (1.0 - normal.z);
        let cross_term = normal.x * normal.y * inverse;
        tangent = vec3(
            1.0 - normal.x * normal.x * inverse,
            -cross_term,
            normal.x
        );
        bitangent = vec3(
            cross_term,
            normal.y * normal.y * inverse - 1.0,
            -normal.y
        );
    } else {
        let inverse = 1.0 / (1.0 + normal.z);
        let cross_term = -normal.x * normal.y * inverse;
        tangent = vec3(
            1.0 - normal.x * normal.x * inverse,
            cross_term,
            -normal.x
        );
        bitangent = vec3(
            cross_term,
            1.0 - normal.y * normal.y * inverse,
            -normal.y
        );
    }
    return mat3x3(tangent, bitangent, normal);
}

fn light_sample_cone_direction(
    direction: vec3<f32>,
    aperture: f32,
    random_value: vec2<f32>
) -> vec3<f32> {
    let angle = random_value.x * (3.1415926535897932384626433832795 * 2.0);
    let radius = sqrt(random_value.y);
    let x = radius * cos(angle) * aperture;
    let y = radius * sin(angle) * aperture;
    let basis = light_sample_build_orthonormal_matrix_n(direction);
    return normalize(basis[2] + basis[0] * x + basis[1] * y);
}

fn light_sample_sphere_volume(random_value: vec3<f32>) -> vec3<f32> {
    let angle = (3.1415926535897932384626433832795 * 2.0) * random_value.x;
    let height = random_value.y * 2.0 - 1.0;
    let radius = pow(random_value.z, 1.0 / 3.0);
    let ring = sqrt(max(0.0, 1.0 - height * height));
    return vec3(
        radius * ring * cos(angle),
        radius * ring * sin(angle),
        radius * height
    );
}

fn light_sample_hash_vec2_to_vec3(random_value: vec2<f32>) -> vec3<f32> {
    let packed = vec2<u32>(random_value * 16777215.0);
    let x = packed.x & 0xffffu;
    let y = ((packed.x >> 16u) & 0xffu) | ((packed.y & 0xffu) << 8u);
    let z = (packed.y >> 8u) & 0xffffu;
    return vec3(
        f32(x) / 65535.0,
        f32(y) / 65535.0,
        f32(z) / 65535.0
    );
}

fn sample_directional_light_record(
    database: ptr<storage, array<u32>>,
    index: u32,
    position: vec3<f32>,
    random_value: vec2<f32>
) -> SampledLightRecord {
    let light = ${DIRECTIONAL_LIGHT_DESCRIPTOR.marshalling_method_read}(database, index);
    let sampled_direction = light_sample_cone_direction(
        -light.direction,
        light.disk_radius,
        random_value
    );
    var result: SampledLightRecord;
    result.distance = 3.402823466e+38;
    result.direction = sampled_direction;
    result.pdf = 1.0;
    result.emission = light.color;
    return result;
}

fn sample_point_light_record(
    database: ptr<storage, array<u32>>,
    index: u32,
    position: vec3<f32>,
    random_value: vec2<f32>
) -> SampledLightRecord {
    let light = ${POINT_LIGHT_DESCRIPTOR.marshalling_method_read}(database, index);
    let sample_position = light.position +
        light_sample_sphere_volume(light_sample_hash_vec2_to_vec3(random_value)) * light.radius;
    let sampled_vector = sample_position - position;
    let center_distance = length(light.position - position);
    let ray_distance = max(0.0, center_distance - light.near_clip_distance);
    let attenuation = light_sphere_distance_attenuation(
        center_distance,
        light.radius,
        light.distance
    );
    var result: SampledLightRecord;
    result.distance = ray_distance;
    result.direction = normalize(sampled_vector);
    result.pdf = 1.0;
    result.emission = light.color * attenuation;
    return result;
}

fn sample_spot_light_record(
    database: ptr<storage, array<u32>>,
    index: u32,
    position: vec3<f32>,
    random_value: vec2<f32>
) -> SampledLightRecord {
    let light = ${SPOT_LIGHT_DESCRIPTOR.marshalling_method_read}(database, index);
    let sample_position = light.position +
        light_sample_sphere_volume(light_sample_hash_vec2_to_vec3(random_value)) * light.radius;
    let sampled_vector = sample_position - position;
    let center_vector = light.position - position;
    let center_distance = length(center_vector);
    let ray_distance = max(0.0, center_distance - light.near_clip_distance);
    let angle_cos = dot(normalize(center_vector), -light.direction);
    var attenuation = light_get_spot_attenuation(
        light.coneCos,
        light.penumbraCos,
        angle_cos
    );
    attenuation *= light_sphere_distance_attenuation(
        center_distance,
        light.radius,
        light.distance
    );
    var result: SampledLightRecord;
    result.distance = ray_distance;
    result.direction = normalize(sampled_vector);
    result.pdf = 1.0;
    result.emission = light.color * attenuation;
    return result;
}
`,
  [
    lightIncidentChunk,
    DIRECTIONAL_LIGHT_DESCRIPTOR.chunk_read,
    POINT_LIGHT_DESCRIPTOR.chunk_read,
    SPOT_LIGHT_DESCRIPTOR.chunk_read
  ]
);

const pathTracingLightImportanceChunk = CodeChunk.from(
  `
fn path_light_importance_directional(
    database: ptr<storage, array<u32>>,
    index: u32,
    position: vec3<f32>,
    normal: vec3<f32>
) -> f32 {
    let light = ${DIRECTIONAL_LIGHT_DESCRIPTOR.marshalling_method_read}(database, index);
    let cosine = max(0.0, dot(normal, -light.direction));
    return rgb_to_luminance(light.color) * cosine;
}

fn path_light_importance_point(
    database: ptr<storage, array<u32>>,
    index: u32,
    position: vec3<f32>,
    normal: vec3<f32>
) -> f32 {
    let light = ${POINT_LIGHT_DESCRIPTOR.marshalling_method_read}(database, index);
    let to_light = light.position - position;
    let center_distance = length(to_light);
    let surface_distance = max(0.0, center_distance - light.radius);
    if (light.distance > 0.0 && surface_distance >= light.distance) {
        return 0.0;
    }
    let direction = to_light / max(center_distance, 1e-7);
    let cosine = max(0.0, dot(normal, direction));
    if (cosine <= 0.0) {
        return 0.0;
    }
    let attenuation = light_sphere_distance_attenuation(
        center_distance,
        light.radius,
        light.distance
    );
    return rgb_to_luminance(light.color) * attenuation * cosine;
}

fn path_light_importance_spot(
    database: ptr<storage, array<u32>>,
    index: u32,
    position: vec3<f32>,
    normal: vec3<f32>
) -> f32 {
    let light = ${SPOT_LIGHT_DESCRIPTOR.marshalling_method_read}(database, index);
    let to_light = light.position - position;
    let center_distance = length(to_light);
    let surface_distance = max(0.0, center_distance - light.radius);
    if (light.distance > 0.0 && surface_distance >= light.distance) {
        return 0.0;
    }
    let direction = to_light / max(center_distance, 1e-7);
    let cosine = max(0.0, dot(normal, direction));
    if (cosine <= 0.0) {
        return 0.0;
    }
    let angle_cos = dot(direction, -light.direction);
    let spot = light_get_spot_attenuation(
        light.coneCos,
        light.penumbraCos,
        angle_cos
    );
    if (spot <= 0.0) {
        return 0.0;
    }
    let attenuation = light_sphere_distance_attenuation(
        center_distance,
        light.radius,
        light.distance
    );
    return rgb_to_luminance(light.color) * attenuation * spot * cosine;
}
`,
  [
    DIRECTIONAL_LIGHT_DESCRIPTOR.chunk_read,
    POINT_LIGHT_DESCRIPTOR.chunk_read,
    SPOT_LIGHT_DESCRIPTOR.chunk_read,
    lightIncidentChunk
  ]
);

export const LIGHT_DATABASE_READ_CHUNK = CodeChunk.from("", [
  lightPageAccessChunk,
  lightIncidentChunk
]);
export const LIGHT_DATABASE_READ_WGSL =
  LIGHT_DATABASE_READ_CHUNK.compile().text;
export const LIGHT_DATABASE_SAMPLE_WGSL = CodeChunk.from("", [
  LIGHT_DATABASE_READ_CHUNK,
  lightSamplingChunk
]).compile().text;
export const LIGHT_DATABASE_PATH_TRACING_WGSL = CodeChunk.from("", [
  LIGHT_DATABASE_READ_CHUNK,
  lightSamplingChunk,
  pathTracingLightImportanceChunk
]).compile().text;

function lightFlags(castsShadow: boolean): number {
  return castsShadow ? LIGHT_FLAG_CASTS_SHADOW : 0;
}

function hasShadow(light: Light): boolean {
  const shadowId = light._gpu_shadowmap_id;
  return light.casts_shadow && shadowId !== undefined && shadowId >= 0;
}

function writeLightColor(
  out: Float32Array,
  light: Light
): Float32Array {
  const luminance = light.color.computeLuminance();
  if (luminance < 1e-6) {
    out.fill(0);
    return out;
  }
  const scale = light.intensity / luminance;
  out[0] = light.color.r * scale;
  out[1] = light.color.g * scale;
  out[2] = light.color.b * scale;
  return out;
}

const directionalDirectionScratch = new Float32Array(3);
const directionalColorScratch = new Float32Array(3);
const pointPositionScratch = new Float32Array(3);
const pointColorScratch = new Float32Array(3);
const spotPositionScratch = new Float32Array(3);
const spotDirectionScratch = new Float32Array(3);
const spotColorScratch = new Float32Array(3);

export function packDirectionalLightRecord(
  light: DirectionalLight
): DirectionalLightRecord {
  const direction = light.forward;
  directionalDirectionScratch[0] = direction.x;
  directionalDirectionScratch[1] = direction.y;
  directionalDirectionScratch[2] = direction.z;
  writeLightColor(directionalColorScratch, light);
  const castsShadow = hasShadow(light);
  return {
    direction: directionalDirectionScratch,
    color: directionalColorScratch,
    disk_radius: light.radius,
    flags: lightFlags(castsShadow),
    near_clip_distance: light.near_clip_distance,
    shadow_id: castsShadow ? light._gpu_shadowmap_id : 0
  };
}

export function packPointLightRecord(light: PointLight): PointLightRecord {
  const position = light.transform_global.position;
  pointPositionScratch[0] = position.x;
  pointPositionScratch[1] = position.y;
  pointPositionScratch[2] = position.z;
  writeLightColor(pointColorScratch, light);
  const castsShadow = hasShadow(light);
  return {
    position: pointPositionScratch,
    color: pointColorScratch,
    distance: light.distance,
    radius: light.radius,
    flags: lightFlags(castsShadow),
    near_clip_distance: light.near_clip_distance,
    shadow_id: castsShadow ? light._gpu_shadowmap_id : 0
  };
}

export function packSpotLightRecord(light: SpotLight): SpotLightRecord {
  const position = light.transform_global.position;
  const direction = light.forward;
  spotPositionScratch[0] = position.x;
  spotPositionScratch[1] = position.y;
  spotPositionScratch[2] = position.z;
  spotDirectionScratch[0] = direction.x;
  spotDirectionScratch[1] = direction.y;
  spotDirectionScratch[2] = direction.z;
  writeLightColor(spotColorScratch, light);
  const castsShadow = hasShadow(light);
  return {
    position: spotPositionScratch,
    direction: spotDirectionScratch,
    color: spotColorScratch,
    distance: light.distance,
    radius: light.radius,
    coneCos: Math.cos(light.angle),
    penumbraCos: Math.cos(light.angle * (1 - light.penumbra)),
    flags: lightFlags(castsShadow),
    near_clip_distance: light.near_clip_distance,
    shadow_id: castsShadow ? light._gpu_shadowmap_id : 0
  };
}

export class GPULightCollection {
  readonly source: SceneLights;
  readonly database: GPUDatabase;
  readonly shadow_context: ShadowContext;

  private readonly device: GPUDevice;
  private readonly graphics: GraphicsContext;
  private readonly environmentTexture: GPUTextureContext;
  private readonly diffuseIrradianceTexture: GPUTextureContext;
  private environmentSource: ShadeTexture | undefined;
  private environmentPrefilter: EnvironmentPrefilterPass | null = null;
  private lastSourceVersion = -1;
  private previousPointCount = 0;
  private previousSpotCount = 0;
  private previousDirectionalCount = 0;

  constructor(graphics: GraphicsContext, source: SceneLights) {
    const device = graphics.device;
    if (device === null) {
      throw new Error("GPULightCollection: GraphicsContext has no device");
    }
    this.device = device;
    this.graphics = graphics;
    this.source = source;
    this.database = new GPUDatabase({
      device,
      definition: LIGHT_DATABASE_DEFINITION
    });
    this.shadow_context = new ShadowContext(graphics, source);
    this.environmentTexture = new GPUTextureContext(device, {
      label: "FX-03 specular environment",
      size: [1, 1, 1],
      format: "rgba16float",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.STORAGE_BINDING
    });
    this.diffuseIrradianceTexture = new GPUTextureContext(device, {
      label: "FX-03 diffuse irradiance",
      size: [32, 32, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
    });
  }

  get buffer_data(): GPUBuffer {
    return this.database.buffer;
  }

  get environment(): GPUTextureContext {
    return this.environmentTexture;
  }

  /** Cosine-convolved irradiance integral; consumers apply diffuse BRDF 1/PI. */
  get diffuseIrradiance(): GPUTextureContext {
    return this.diffuseIrradianceTexture;
  }

  get gpu_memory_usage(): number {
    return (
      this.environmentTexture.gpu_memory_usage +
      this.diffuseIrradianceTexture.gpu_memory_usage +
      this.database.gpu_memory_usage
    );
  }

  get pointLights(): GPUTypedTable<PointLightRecord> {
    return this.database.get("light_point") as GPUTypedTable<PointLightRecord>;
  }

  get spotLights(): GPUTypedTable<SpotLightRecord> {
    return this.database.get("light_spot") as GPUTypedTable<SpotLightRecord>;
  }

  get directionalLights(): GPUTypedTable<DirectionalLightRecord> {
    return this.database.get(
      "light_directional"
    ) as GPUTypedTable<DirectionalLightRecord>;
  }

  get shadowPoints(): GPUTypedTable<ArrayLike<number>> {
    return this.database.get(
      "shadow_point"
    ) as GPUTypedTable<ArrayLike<number>>;
  }

  get shadowSpots(): GPUTypedTable<ShadowSpotRecord> {
    return this.database.get(
      "shadow_spot"
    ) as GPUTypedTable<ShadowSpotRecord>;
  }

  get shadowDirectionals(): GPUTypedTable<ShadowSpotRecord[]> {
    return this.database.get(
      "shadow_directional"
    ) as GPUTypedTable<ShadowSpotRecord[]>;
  }

  update(
    command: ShadeGPUCommandContext,
    sceneChanged = false
  ): boolean {
    const environmentChanged = this.updateEnvironment(command);
    const shadowsChanged = this.shadow_context.process_lights();
    if (shadowsChanged) this.source.needsUpdate = true;
    if (!sceneChanged && this.lastSourceVersion === this.source.version) {
      return environmentChanged || shadowsChanged;
    }
    this.build(command);
    return true;
  }

  private updateEnvironment(command: ShadeGPUCommandContext): boolean {
    const source = this.source.environment;
    if (this.environmentSource === source) return false;
    this.environmentSource = source;

    const image = requireShadeImage(source);
    const environment = this.environmentTexture;
    environment.resize(image.width, image.height, 1);
    environment.descriptor.mipLevelCount = textureMipLevelCount(
      image.width,
      image.height
    );
    environment.allocate();

    if (
      typeof ImageBitmap !== "undefined" &&
      image.source instanceof ImageBitmap &&
      (environment.descriptor.usage & GPUTextureUsage.RENDER_ATTACHMENT) === 0
    ) {
      environment.descriptor.usage |= GPUTextureUsage.RENDER_ATTACHMENT;
      environment.allocate(false);
    }
    uploadShadeImage(image, environment.gpu_texture, this.device.queue);

    this.diffuseIrradianceTexture.allocate();
    this.obtainEnvironmentPrefilter().encode(
      command,
      environment,
      this.diffuseIrradianceTexture
    );
    return true;
  }

  private obtainEnvironmentPrefilter(): EnvironmentPrefilterPass {
    if (this.environmentPrefilter === null) {
      this.environmentPrefilter = new EnvironmentPrefilterPass(this.graphics);
    }
    return this.environmentPrefilter;
  }

  build(command: ShadeGPUCommandContext): void {
    const pointTable = this.pointLights;
    const spotTable = this.spotLights;
    const directionalTable = this.directionalLights;
    const lights = this.source.elements;
    let pointCount = 0;
    let spotCount = 0;
    let directionalCount = 0;

    let requestedDirectionalCount = 0;
    for (const light of lights) {
      if ((light as DirectionalLight).isDirectionalLight === true) {
        requestedDirectionalCount++;
      }
    }
    assertDirectionalLightCapacity(requestedDirectionalCount);

    for (const light of lights) {
      if ((light as PointLight).isPointLight === true) {
        pointTable.set(
          pointCount++,
          packPointLightRecord(light as PointLight)
        );
      } else if ((light as DirectionalLight).isDirectionalLight === true) {
        directionalTable.set(
          directionalCount++,
          packDirectionalLightRecord(light as DirectionalLight)
        );
      } else if ((light as SpotLight).isSpotLight === true) {
        spotTable.set(
          spotCount++,
          packSpotLightRecord(light as SpotLight)
        );
      }
    }

    for (let i = pointCount; i < this.previousPointCount; i++) {
      pointTable.remove(i);
    }
    for (let i = spotCount; i < this.previousSpotCount; i++) {
      spotTable.remove(i);
    }
    for (
      let i = directionalCount;
      i < this.previousDirectionalCount;
      i++
    ) {
      directionalTable.remove(i);
    }

    this.previousPointCount = pointCount;
    this.previousSpotCount = spotCount;
    this.previousDirectionalCount = directionalCount;
    this.database.update(command);
    this.lastSourceVersion = this.source.version;
  }

  destroy(): void {
    this.shadow_context.destroy();
    this.database.destroy();
    this.environmentTexture.destroy();
    this.diffuseIrradianceTexture.destroy();
  }

  get environmentEvidence(): {
    specularAllocatedBytes: number;
    diffuseAllocatedBytes: number;
    specularMipLevelCount: number;
  } {
    return {
      specularAllocatedBytes: this.environmentTexture.gpu_memory_usage,
      diffuseAllocatedBytes: this.diffuseIrradianceTexture.gpu_memory_usage,
      specularMipLevelCount: this.environmentTexture.mipLevelCount
    };
  }
}
