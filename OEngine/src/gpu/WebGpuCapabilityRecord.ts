export interface WebGpuApiProbes {
  readonly immediateData: boolean;
  readonly transientAttachments: boolean;
}

export interface WebGpuSpecializationRecord {
  readonly textureCompression: "bc" | "astc" | "etc2" | "rgba8";
  readonly subgroups: boolean;
  readonly primitiveIndex: boolean;
  readonly shaderF16: boolean;
  readonly immediateData: boolean;
  readonly transientAttachments: boolean;
}

export interface WebGpuCapabilityRecord {
  readonly schemaVersion: 1;
  readonly featureLevel: "core";
  readonly adapterFeatures: readonly string[];
  readonly deviceFeatures: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly wgslLanguageFeatures: readonly string[];
  readonly apiProbes: WebGpuApiProbes;
  readonly specialization: WebGpuSpecializationRecord;
  readonly fingerprint: string;
}

export function captureWebGpuCapabilityRecord(
  gpu: GPU,
  device: GPUDevice,
  adapter?: GPUAdapter
): WebGpuCapabilityRecord {
  const adapterFeatures = Object.freeze([...(adapter?.features ?? device.features)].map(String).sort());
  const deviceFeatures = Object.freeze([...device.features].map(String).sort());
  const wgslLanguageFeatures = Object.freeze([...gpu.wgslLanguageFeatures].map(String).sort());
  const limits = Object.freeze({
    maxBindGroups: Number(device.limits.maxBindGroups),
    maxBindingsPerBindGroup: Number(device.limits.maxBindingsPerBindGroup),
    maxSampledTexturesPerShaderStage: Number(device.limits.maxSampledTexturesPerShaderStage),
    maxSamplersPerShaderStage: Number(device.limits.maxSamplersPerShaderStage),
    maxStorageBuffersPerShaderStage: Number(device.limits.maxStorageBuffersPerShaderStage),
    maxStorageBufferBindingSize: Number(device.limits.maxStorageBufferBindingSize),
    maxBufferSize: Number(device.limits.maxBufferSize),
    maxTextureArrayLayers: Number(device.limits.maxTextureArrayLayers),
    maxTextureDimension2D: Number(device.limits.maxTextureDimension2D),
    maxColorAttachmentBytesPerSample: Number(device.limits.maxColorAttachmentBytesPerSample),
    maxImmediateSize: Number(device.limits.maxImmediateSize ?? 0)
  });
  const apiProbes = Object.freeze({
    immediateData:
      limits.maxImmediateSize > 0 &&
      wgslLanguageFeatures.includes("immediate_address_space") &&
      typeof GPURenderPassEncoder !== "undefined" &&
      "setImmediates" in GPURenderPassEncoder.prototype,
    transientAttachments:
      typeof GPUTextureUsage !== "undefined" &&
      "TRANSIENT_ATTACHMENT" in GPUTextureUsage
  });
  const has = (feature: string): boolean => deviceFeatures.includes(feature);
  const textureCompression = has("texture-compression-bc") ? "bc"
    : has("texture-compression-astc") ? "astc"
    : has("texture-compression-etc2") ? "etc2"
    : "rgba8";
  const specialization = Object.freeze({
    textureCompression,
    subgroups: has("subgroups"),
    primitiveIndex: has("primitive-index"),
    shaderF16: has("shader-f16"),
    immediateData: apiProbes.immediateData,
    transientAttachments: apiProbes.transientAttachments
  });
  const fingerprint = JSON.stringify({
    featureLevel: "core",
    deviceFeatures,
    limits,
    wgslLanguageFeatures,
    apiProbes,
    specialization
  });
  return Object.freeze({
    schemaVersion: 1,
    featureLevel: "core",
    adapterFeatures,
    deviceFeatures,
    limits,
    wgslLanguageFeatures,
    apiProbes,
    specialization,
    fingerprint
  });
}
