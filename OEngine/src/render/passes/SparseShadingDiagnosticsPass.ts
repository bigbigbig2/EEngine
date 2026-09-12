import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  GPU_SPARSE_SHADING_DIAGNOSTIC_WORDS,
  SPARSE_SHADING_DIAGNOSTICS_FINALIZER_WGSL
} from "../../shaders/sparse_shading_resolve.js";

const DIAGNOSTIC_BYTES = GPU_SPARSE_SHADING_DIAGNOSTIC_WORDS * 4;

export interface SparseShadingDiagnosticsFinalizeInput {
  readonly shadingBinId: GPUTextureView;
  readonly settings: GPUBuffer;
  readonly settingsDynamicOffset: number;
  readonly claims: GPUBuffer;
  readonly diagnostics: GPUBuffer;
  readonly width: number;
  readonly height: number;
}

/** Diagnostics-only owner. Production topology never creates this pipeline. */
export class SparseShadingDiagnosticsPass {
  private constructor(
    private readonly device: GPUDevice,
    private readonly layout: GPUBindGroupLayout,
    private readonly pipeline: GPUComputePipeline
  ) {}

  static async create(device: GPUDevice): Promise<SparseShadingDiagnosticsPass> {
    const module = await createCheckedShaderModule(device);
    const { layout, pipeline } = await checkedValidationScope(device, () => {
      const layout = device.createBindGroupLayout({
        label: "ADR-0013 sparse shading diagnostics layout",
        entries: [
          { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
          {
            binding: 5,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 }
          },
          { binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 12, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
        ]
      });
      const pipelineLayout = device.createPipelineLayout({
        label: "ADR-0013 sparse shading diagnostics pipeline layout",
        bindGroupLayouts: [layout]
      });
      return {
        layout,
        pipeline: device.createComputePipeline({
          label: "ADR-0013 sparse shading diagnostics finalizer",
          layout: pipelineLayout,
          compute: { module, entryPoint: "finalize_sparse_shading_diagnostics" }
        })
      };
    });
    return new SparseShadingDiagnosticsPass(device, layout, pipeline);
  }

  encodeFinalize(
    command: ShadeGPUCommandContext,
    input: Readonly<SparseShadingDiagnosticsFinalizeInput>
  ): void {
    if (!Number.isSafeInteger(input.width) || input.width <= 0 ||
        !Number.isSafeInteger(input.height) || input.height <= 0) {
      throw new RangeError("Sparse shading diagnostics extent is invalid");
    }
    const alignment = this.device.limits.minUniformBufferOffsetAlignment;
    if (!Number.isSafeInteger(input.settingsDynamicOffset) || input.settingsDynamicOffset < 0 ||
        input.settingsDynamicOffset % alignment !== 0) {
      throw new RangeError("Sparse shading diagnostics settings offset is misaligned");
    }
    const group = this.device.createBindGroup({
      label: "ADR-0013 sparse shading diagnostics frame group",
      layout: this.layout,
      entries: [
        { binding: 2, resource: input.shadingBinId },
        { binding: 5, resource: { buffer: input.settings, size: 16 } },
        { binding: 11, resource: { buffer: input.diagnostics, size: DIAGNOSTIC_BYTES } },
        { binding: 12, resource: { buffer: input.claims } }
      ]
    });
    const pass = command.beginComputePass({
      label: "ADR-0013 sparse shading diagnostics finalizer"
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group, [input.settingsDynamicOffset]);
    pass.dispatchWorkgroups(Math.ceil(input.width / 8), Math.ceil(input.height / 8), 1);
    pass.end();
  }

  encodeCopy(
    command: ShadeGPUCommandContext,
    diagnostics: GPUBuffer,
    readback: GPUBuffer
  ): void {
    command.copyBufferToBuffer(diagnostics, 0, readback, 0, DIAGNOSTIC_BYTES);
  }
}

async function createCheckedShaderModule(device: GPUDevice): Promise<GPUShaderModule> {
  device.pushErrorScope("validation");
  const module = device.createShaderModule({
    label: "ADR-0013 sparse shading diagnostics finalizer",
    code: SPARSE_SHADING_DIAGNOSTICS_FINALIZER_WGSL
  });
  const [info, validationError] = await Promise.all([
    module.getCompilationInfo(),
    device.popErrorScope()
  ]);
  const errors = info.messages.filter((message) => message.type === "error");
  if (validationError !== null || errors.length > 0) {
    const details = errors.map((message) =>
      `${message.lineNum}:${message.linePos} ${message.message}`).join("\n");
    throw new Error("Sparse shading diagnostics shader failed validation" +
      (validationError === null ? "" : `: ${validationError.message}`) +
      (details === "" ? "" : `\n${details}`));
  }
  return module;
}

async function checkedValidationScope<T>(device: GPUDevice, create: () => T): Promise<T> {
  device.pushErrorScope("validation");
  let value: T;
  try {
    value = create();
  } catch (error) {
    await device.popErrorScope();
    throw error;
  }
  const validationError = await device.popErrorScope();
  if (validationError !== null) {
    throw new Error(`Sparse shading diagnostics pipeline failed validation: ${validationError.message}`);
  }
  return value;
}
