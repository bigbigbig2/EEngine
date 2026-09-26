/**
 * CPU/WGSL constant ABI from SDK 1.1.4 ffx_fsr3upscaler_private.h.
 * The native struct is 148 bytes; WGSL uniform binding rounds its size to 160.
 * Offsets are intentionally centralized for every translated FSR3 stage.
 */
export const FSR3_UPSCALER_CONSTANTS_BYTES = 160;

export const FSR3_UPSCALER_CONSTANTS_WGSL = /* wgsl */ `
struct Fsr3Constants {
  render_size: vec2i,
  previous_render_size: vec2i,
  upscale_size: vec2i,
  previous_upscale_size: vec2i,
  max_render_size: vec2i,
  max_upscale_size: vec2i,
  device_to_view_depth: vec4f,
  jitter_offset: vec2f,
  previous_jitter_offset: vec2f,
  motion_vector_scale: vec2f,
  downscale_factor: vec2f,
  motion_vector_jitter_cancellation: vec2f,
  tan_half_fov: f32,
  jitter_phase_count: f32,
  delta_time: f32,
  delta_pre_exposure: f32,
  view_space_to_meters_factor: f32,
  frame_index: f32,
  velocity_factor: f32,
  reactiveness_scale: f32,
  shading_change_scale: f32,
  accumulation_added_per_frame: f32,
  min_disocclusion_accumulation: f32,
};
`;

export interface Fsr3UpscalerConstants {
  readonly renderSize: readonly [number, number];
  readonly previousFrameRenderSize: readonly [number, number];
  readonly upscaleSize: readonly [number, number];
  readonly previousFrameUpscaleSize: readonly [number, number];
  readonly maxRenderSize: readonly [number, number];
  readonly maxUpscaleSize: readonly [number, number];
  readonly deviceToViewDepth: readonly [number, number, number, number];
  readonly jitterOffset: readonly [number, number];
  readonly previousFrameJitterOffset: readonly [number, number];
  readonly motionVectorScale: readonly [number, number];
  readonly downscaleFactor: readonly [number, number];
  readonly motionVectorJitterCancellation: readonly [number, number];
  readonly tanHalfFOV: number;
  readonly jitterPhaseCount: number;
  readonly deltaTime: number;
  readonly deltaPreExposure: number;
  readonly viewSpaceToMetersFactor: number;
  readonly frameIndex: number;
  readonly velocityFactor: number;
  readonly reactivenessScale: number;
  readonly shadingChangeScale: number;
  readonly accumulationAddedPerFrame: number;
  readonly minDisocclusionAccumulation: number;
}

export function packFsr3UpscalerConstants(values: Fsr3UpscalerConstants): ArrayBuffer {
  const buffer = new ArrayBuffer(FSR3_UPSCALER_CONSTANTS_BYTES);
  const view = new DataView(buffer);
  const i32 = (offset: number, pair: readonly [number, number]) => {
    view.setInt32(offset, pair[0], true);
    view.setInt32(offset + 4, pair[1], true);
  };
  const f32 = (offset: number, value: number) => view.setFloat32(offset, value, true);
  const f32pair = (offset: number, pair: readonly [number, number]) => {
    f32(offset, pair[0]);
    f32(offset + 4, pair[1]);
  };
  i32(0, values.renderSize);
  i32(8, values.previousFrameRenderSize);
  i32(16, values.upscaleSize);
  i32(24, values.previousFrameUpscaleSize);
  i32(32, values.maxRenderSize);
  i32(40, values.maxUpscaleSize);
  values.deviceToViewDepth.forEach((value, index) => f32(48 + index * 4, value));
  f32pair(64, values.jitterOffset);
  f32pair(72, values.previousFrameJitterOffset);
  f32pair(80, values.motionVectorScale);
  f32pair(88, values.downscaleFactor);
  f32pair(96, values.motionVectorJitterCancellation);
  f32(104, values.tanHalfFOV);
  f32(108, values.jitterPhaseCount);
  f32(112, values.deltaTime);
  f32(116, values.deltaPreExposure);
  f32(120, values.viewSpaceToMetersFactor);
  f32(124, values.frameIndex);
  f32(128, values.velocityFactor);
  f32(132, values.reactivenessScale);
  f32(136, values.shadingChangeScale);
  f32(140, values.accumulationAddedPerFrame);
  f32(144, values.minDisocclusionAccumulation);
  return buffer;
}
