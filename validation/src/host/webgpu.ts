import type { ValidationController } from "./protocol.ts";

const GPU_LIMIT_NAMES = Object.freeze([
  "maxTextureDimension1D",
  "maxTextureDimension2D",
  "maxTextureDimension3D",
  "maxTextureArrayLayers",
  "maxBindGroups",
  "maxBindGroupsPlusVertexBuffers",
  "maxBindingsPerBindGroup",
  "maxDynamicUniformBuffersPerPipelineLayout",
  "maxDynamicStorageBuffersPerPipelineLayout",
  "maxSampledTexturesPerShaderStage",
  "maxSamplersPerShaderStage",
  "maxStorageBuffersPerShaderStage",
  "maxStorageTexturesPerShaderStage",
  "maxUniformBuffersPerShaderStage",
  "maxUniformBufferBindingSize",
  "maxStorageBufferBindingSize",
  "minUniformBufferOffsetAlignment",
  "minStorageBufferOffsetAlignment",
  "maxVertexBuffers",
  "maxBufferSize",
  "maxVertexAttributes",
  "maxVertexBufferArrayStride",
  "maxInterStageShaderVariables",
  "maxColorAttachments",
  "maxColorAttachmentBytesPerSample",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupSizeX",
  "maxComputeWorkgroupSizeY",
  "maxComputeWorkgroupSizeZ",
  "maxComputeWorkgroupsPerDimension",
  "maxImmediateSize",
  "subgroupMinSize",
  "subgroupMaxSize"
] as const);

export interface ScopedGpuResult<T> {
  readonly value: T;
  readonly errors: readonly Readonly<{ filter: GPUErrorFilter; message: string }>[];
}

export function snapshotGpuLimits(limits: GPUSupportedLimits): Readonly<Record<string, number>> {
  const source = limits as unknown as Readonly<Record<string, unknown>>;
  const snapshot: Record<string, number> = {};
  for (const name of GPU_LIMIT_NAMES) {
    const value = Number(source[name]);
    if (Number.isFinite(value)) snapshot[name] = value;
  }
  return Object.freeze(snapshot);
}

export function snapshotGpuFeatures(features: GPUSupportedFeatures): readonly string[] {
  return Object.freeze([...features].map(String).sort());
}

export function snapshotAdapterInfo(info: GPUAdapterInfo): Readonly<Record<string, string>> {
  return Object.freeze({
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description
  });
}

export async function probeWebGpu2026Surface(gpu: GPU, device: GPUDevice): Promise<Readonly<Record<string, unknown>>> {
  const usage = GPUTextureUsage as unknown as Readonly<Record<string, unknown>>;
  const probes = await withGpuErrorScopes(device, "WebGPU 2026 structural probe", () => {
    const attachment = device.createTexture({
      label: "Validation structural probe attachment",
      size: [1, 1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
    try {
      const encoder = device.createCommandEncoder({ label: "Validation structural probe encoder" });
      const render = encoder.beginRenderPass({
        label: "Validation structural probe render pass",
        colorAttachments: [{
          view: attachment.createView(),
          loadOp: "clear",
          storeOp: "discard",
          clearValue: [0, 0, 0, 0]
        }]
      });
      const renderSetImmediates = "setImmediates" in render && typeof render.setImmediates === "function";
      render.end();
      const compute = encoder.beginComputePass({ label: "Validation structural probe compute pass" });
      const computeSetImmediates = "setImmediates" in compute && typeof compute.setImmediates === "function";
      compute.end();
      const bundle = device.createRenderBundleEncoder({ colorFormats: ["rgba8unorm"] });
      const bundleSetImmediates = "setImmediates" in bundle && typeof bundle.setImmediates === "function";
      bundle.finish();
      encoder.finish();
      return { renderSetImmediates, computeSetImmediates, bundleSetImmediates };
    } finally {
      attachment.destroy();
    }
  });
  return Object.freeze({
    wgslLanguageFeatures: Object.freeze([...gpu.wgslLanguageFeatures].map(String).sort()),
    immediateData: Object.freeze({
      languageFeature: gpu.wgslLanguageFeatures.has("immediate_address_space"),
      maxImmediateSize: Number((device.limits as unknown as Record<string, unknown>).maxImmediateSize ?? 0),
      ...probes.value
    }),
    transientAttachment: Object.freeze({
      constantPresent: typeof usage.TRANSIENT_ATTACHMENT === "number",
      usageValue: typeof usage.TRANSIENT_ATTACHMENT === "number" ? usage.TRANSIENT_ATTACHMENT : null
    })
  });
}

export async function withGpuErrorScopes<T>(
  device: GPUDevice,
  label: string,
  operation: () => T | Promise<T>
): Promise<Readonly<ScopedGpuResult<T>>> {
  device.pushErrorScope("internal");
  device.pushErrorScope("out-of-memory");
  device.pushErrorScope("validation");
  let value: T | undefined;
  let operationError: unknown;
  try {
    value = await operation();
  } catch (error) {
    operationError = error;
  }
  const validation = await device.popErrorScope();
  const oom = await device.popErrorScope();
  const internal = await device.popErrorScope();
  const errors = Object.freeze([
    ...(validation ? [{ filter: "validation" as const, message: validation.message }] : []),
    ...(oom ? [{ filter: "out-of-memory" as const, message: oom.message }] : []),
    ...(internal ? [{ filter: "internal" as const, message: internal.message }] : [])
  ]);
  if (operationError !== undefined) throw operationError;
  if (errors.length > 0) {
    throw new Error(`${label} failed GPU error scope: ${errors.map(({ filter, message }) => `${filter}: ${message}`).join(" | ")}`);
  }
  return Object.freeze({ value: value as T, errors });
}

export function attachGpuErrorCollection(
  device: GPUDevice,
  controller: ValidationController,
  isIntentionalLoss: () => boolean
): Readonly<{ lost: Promise<GPUDeviceLostInfo>; remove(): void }> {
  const onUncaptured = (event: GPUUncapturedErrorEvent): void => {
    const source = event.error instanceof GPUValidationError
      ? "gpu-validation"
      : event.error instanceof GPUOutOfMemoryError
        ? "gpu-oom"
        : "gpu-internal";
    controller.addError({ source, message: event.error.message });
  };
  device.addEventListener("uncapturederror", onUncaptured);
  const lost = device.lost.then((info) => {
    if (!isIntentionalLoss()) controller.addError({ source: "device-loss", message: `${info.reason}: ${info.message}` });
    return info;
  });
  return Object.freeze({
    lost,
    remove() {
      device.removeEventListener("uncapturederror", onUncaptured);
    }
  });
}
