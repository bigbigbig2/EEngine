/**
 * LightProbeRecord：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

export const LIGHT_PROBE_RECORD_WGSL = /* wgsl */ `
struct LightProbeData {
  position: array<f32, 3>,
  distance_max: f32,
  accumulated_samples: u32,
  coefficients: array<f32, 12>,
};

struct LightProbeVolumeMetadata {
  probe_count: u32,
  probe_resolution: u32,
};
`;
