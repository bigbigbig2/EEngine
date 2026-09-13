import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  GPU_SHADING_BIN_CLASSIFIER_WORKGROUP_HEIGHT,
  GPU_SHADING_BIN_CLASSIFIER_WORKGROUP_WIDTH,
  GPU_SHADING_BIN_COUNT,
  GPU_SHADING_BIN_INDIRECT_BYTES,
  GPU_SHADING_BIN_LAYOUTS_OFFSET,
  GPU_SHADING_BIN_MUTABLE_BYTES,
  GPU_SHADING_BIN_SETTINGS_STRIDE,
  type GpuShadingBinSizing,
  packGpuShadingBinLayout
} from "../../gpu/GpuShadingBinAbi.js";
import { GpuBindGroupResourceCache } from "../../gpu/GpuBindGroupResourceCache.js";
import {
  SHADING_BIN_CLASSIFIER_DIAGNOSTICS_WGSL,
  SHADING_BIN_CLASSIFIER_WGSL
} from "../../shaders/shading_bin_classify.js";

export const SHADING_BIN_HEAP_LABEL = "ADR-0013 ShadingBin heap";
export const SHADING_BIN_INDIRECT_LABEL = "ADR-0013 ShadingBin indirect args";
export const SHADING_BIN_CLASSIFIER_LABEL = "ADR-0013 ShadingBin classifier";
export const SHADING_BIN_FINALIZER_LABEL = "ADR-0013 ShadingBin finalizer";

export const SHADING_BIN_CLASSIFIER_BINDING_CONTRACT = Object.freeze([
  Object.freeze({ binding: 0, resource: "r8uint-texture" }),
  Object.freeze({ binding: 1, resource: "read-write-storage-buffer" }),
  Object.freeze({ binding: 2, resource: "dynamic-uniform-buffer", minBindingSize: 32 })
] as const);

export const SHADING_BIN_FINALIZER_BINDING_CONTRACT = Object.freeze([
  Object.freeze({ binding: 1, resource: "read-write-storage-buffer" }),
  Object.freeze({ binding: 2, resource: "dynamic-uniform-buffer", minBindingSize: 32 }),
  Object.freeze({ binding: 3, resource: "read-write-storage-buffer" })
] as const);

export interface ShadingBinResourceDescriptorOracle {
  readonly heap: Readonly<{
    label: typeof SHADING_BIN_HEAP_LABEL;
    size: number;
    usage: readonly ["storage", "copy-dst"];
  }>;
  readonly indirectArgs: Readonly<{
    label: typeof SHADING_BIN_INDIRECT_LABEL;
    size: typeof GPU_SHADING_BIN_INDIRECT_BYTES;
    usage: readonly ["storage", "indirect", "copy-dst"];
  }>;
}

export interface ShadingBinFrameBindings {
  readonly classifier: GPUBindGroup;
  readonly finalizer: GPUBindGroup;
  readonly settingsDynamicOffset: number;
  readonly generation: number;
  readonly layoutRevision: number;
}

export interface CreateShadingBinFrameBindingsInput {
  readonly shadingBinId: GPUTextureView;
  readonly settings: GPUBuffer;
  readonly settingsDynamicOffset: number;
  readonly generation: number;
  readonly layoutRevision: number;
  /** Required only for the physically separate diagnostics pipeline variant. */
  readonly diagnosticFaults?: GPUBuffer;
}

export function shadingBinResourceDescriptorOracle(
  sizing: Pick<GpuShadingBinSizing, "heapBytes" | "indirectBytes">
): Readonly<ShadingBinResourceDescriptorOracle> {
  if (!Number.isSafeInteger(sizing.heapBytes) || sizing.heapBytes < GPU_SHADING_BIN_MUTABLE_BYTES) {
    throw new RangeError("ShadingBin heap descriptor size is invalid");
  }
  if (sizing.indirectBytes !== GPU_SHADING_BIN_INDIRECT_BYTES) {
    throw new RangeError("ShadingBin indirect descriptor must be exactly 768 bytes");
  }
  return Object.freeze({
    heap: Object.freeze({
      label: SHADING_BIN_HEAP_LABEL,
      size: sizing.heapBytes,
      usage: Object.freeze(["storage", "copy-dst"] as const)
    }),
    indirectArgs: Object.freeze({
      label: SHADING_BIN_INDIRECT_LABEL,
      size: GPU_SHADING_BIN_INDIRECT_BYTES,
      usage: Object.freeze(["storage", "indirect", "copy-dst"] as const)
    })
  });
}

/**
 * Revision-owned GPU producer for ADR-0013 Step 4. FrameGraph composition owns
 * scheduling; resource-tuple caches keep stable execution free of bind-group
 * creation without making the producer depend on a Renderer service locator.
 */
export class ShadingBinPass {
  readonly heap: GPUBuffer;
  readonly indirectArgs: GPUBuffer;
  readonly diagnostics: boolean;
  readonly sizing: Readonly<GpuShadingBinSizing>;
  private readonly classifierLayout: GPUBindGroupLayout;
  private readonly finalizerLayout: GPUBindGroupLayout;
  private readonly classifierPipeline: GPUComputePipeline;
  private readonly finalizerPipeline: GPUComputePipeline;
  private readonly classifierGroups = new GpuBindGroupResourceCache();
  private readonly finalizerGroups = new GpuBindGroupResourceCache();
  private destroyed = false;

  private constructor(input: {
    device: GPUDevice;
    sizing: Readonly<GpuShadingBinSizing>;
    diagnostics: boolean;
    heap: GPUBuffer;
    indirectArgs: GPUBuffer;
    classifierLayout: GPUBindGroupLayout;
    finalizerLayout: GPUBindGroupLayout;
    classifierPipeline: GPUComputePipeline;
    finalizerPipeline: GPUComputePipeline;
  }) {
    this.device = input.device;
    this.sizing = input.sizing;
    this.diagnostics = input.diagnostics;
    this.heap = input.heap;
    this.indirectArgs = input.indirectArgs;
    this.classifierLayout = input.classifierLayout;
    this.finalizerLayout = input.finalizerLayout;
    this.classifierPipeline = input.classifierPipeline;
    this.finalizerPipeline = input.finalizerPipeline;
  }

  private readonly device: GPUDevice;

  static async create(
    device: GPUDevice,
    sizing: Readonly<GpuShadingBinSizing>,
    diagnostics = false
  ): Promise<ShadingBinPass> {
    const descriptors = shadingBinResourceDescriptorOracle(sizing);
    const resources = await createCheckedBuffers(device, descriptors);
    try {
      const packedLayouts = new Uint8Array(GPU_SHADING_BIN_COUNT * 16);
      for (let binId = 0; binId < GPU_SHADING_BIN_COUNT; binId++) {
        packedLayouts.set(packGpuShadingBinLayout(sizing.layouts[binId]!), binId * 16);
      }
      device.queue.writeBuffer(resources.heap, GPU_SHADING_BIN_LAYOUTS_OFFSET, packedLayouts);

      const module = await createCheckedShaderModule(
        device,
        diagnostics
          ? "ADR-0013 ShadingBin classifier/finalizer diagnostics"
          : "ADR-0013 ShadingBin classifier/finalizer production",
        diagnostics ? SHADING_BIN_CLASSIFIER_DIAGNOSTICS_WGSL : SHADING_BIN_CLASSIFIER_WGSL
      );
      const layouts = await checkedValidationScope(device, "ShadingBin layout creation", () => {
        const classifierLayout = device.createBindGroupLayout(
          classifierBindGroupLayoutDescriptor(diagnostics)
        );
        const finalizerLayout = device.createBindGroupLayout(
          finalizerBindGroupLayoutDescriptor(diagnostics)
        );
        return { classifierLayout, finalizerLayout };
      });
      const pipelines = await checkedValidationScope(device, "ShadingBin pipeline creation", () => {
        const classifierPipelineLayout = device.createPipelineLayout({
          label: "ADR-0013 ShadingBin classifier pipeline layout",
          bindGroupLayouts: [layouts.classifierLayout]
        });
        const finalizerPipelineLayout = device.createPipelineLayout({
          label: "ADR-0013 ShadingBin finalizer pipeline layout",
          bindGroupLayouts: [layouts.finalizerLayout]
        });
        return {
          classifierPipeline: device.createComputePipeline({
            label: SHADING_BIN_CLASSIFIER_LABEL,
            layout: classifierPipelineLayout,
            compute: { module, entryPoint: "classify_shading_bins" }
          }),
          finalizerPipeline: device.createComputePipeline({
            label: SHADING_BIN_FINALIZER_LABEL,
            layout: finalizerPipelineLayout,
            compute: { module, entryPoint: "finalize_shading_bins" }
          })
        };
      });
      return new ShadingBinPass({
        device,
        sizing,
        diagnostics,
        ...resources,
        ...layouts,
        ...pipelines
      });
    } catch (error) {
      resources.heap.destroy();
      resources.indirectArgs.destroy();
      throw error;
    }
  }

  async createFrameBindings(
    input: CreateShadingBinFrameBindingsInput
  ): Promise<Readonly<ShadingBinFrameBindings>> {
    return checkedValidationScope(this.device, "ShadingBin bind group creation", () =>
      this.createFrameBindingsForExecution(input)
    );
  }

  /**
   * Synchronous execution-time path for FrameGraph transient attachments.
   * The caller must have registered the device uncaptured-error/loss collector
   * before execution because an asynchronous error-scope pop cannot occur in a
   * synchronous FrameGraph pass callback.
   */
  createFrameBindingsForExecution(
    input: CreateShadingBinFrameBindingsInput
  ): Readonly<ShadingBinFrameBindings> {
    this.requireAlive();
    if (!Number.isSafeInteger(input.settingsDynamicOffset) || input.settingsDynamicOffset < 0 ||
        input.settingsDynamicOffset % this.device.limits.minUniformBufferOffsetAlignment !== 0) {
      throw new RangeError("ShadingBin settings dynamic offset violates minUniformBufferOffsetAlignment");
    }
    if (input.generation === 0 || input.layoutRevision !== this.sizing.layouts[0]!.revision) {
      throw new RangeError("ShadingBin frame binding generation/layout revision is invalid");
    }
    if (this.diagnostics !== (input.diagnosticFaults !== undefined)) {
      throw new Error("ShadingBin diagnostic fault binding must match the pipeline variant");
    }
    const diagnosticResource = input.diagnosticFaults === undefined
      ? []
      : [{ buffer: input.diagnosticFaults, size: 16 } satisfies GPUBufferBinding];
    const classifierResources: readonly GPUBindingResource[] = [
      input.shadingBinId,
      { buffer: this.heap },
      { buffer: input.settings, size: GPU_SHADING_BIN_SETTINGS_STRIDE },
      ...diagnosticResource
    ];
    const finalizerResources: readonly GPUBindingResource[] = [
      { buffer: this.heap },
      { buffer: input.settings, size: GPU_SHADING_BIN_SETTINGS_STRIDE },
      { buffer: this.indirectArgs },
      ...diagnosticResource
    ];
    const groups = {
      classifier: this.classifierGroups.obtain(classifierResources, () =>
        this.device.createBindGroup({
          label: "ADR-0013 ShadingBin classifier group0",
          layout: this.classifierLayout,
          entries: classifierResources.map((resource, index) => ({
            binding: index === 3 ? 4 : index,
            resource
          }))
        })),
      finalizer: this.finalizerGroups.obtain(finalizerResources, () =>
        this.device.createBindGroup({
          label: "ADR-0013 ShadingBin finalizer group0",
          layout: this.finalizerLayout,
          entries: finalizerResources.map((resource, index) => ({
            binding: index === 3 ? 4 : index + 1,
            resource
          }))
        }))
    };
    return Object.freeze({
      ...groups,
      settingsDynamicOffset: input.settingsDynamicOffset,
      generation: input.generation,
      layoutRevision: input.layoutRevision
    });
  }

  encode(
    command: ShadeGPUCommandContext,
    bindings: Readonly<ShadingBinFrameBindings>
  ): void {
    this.encodeClassify(command, bindings);
    this.encodeFinalize(command, bindings);
  }

  /** Records clear + classifier only so FrameGraph can expose the finalizer edge. */
  encodeClassify(
    command: ShadeGPUCommandContext,
    bindings: Readonly<ShadingBinFrameBindings>
  ): void {
    this.requireAlive();
    this.validateBindings(bindings);
    command.clearBuffer(this.heap, 0, GPU_SHADING_BIN_MUTABLE_BYTES);
    command.clearBuffer(this.indirectArgs, 0, GPU_SHADING_BIN_INDIRECT_BYTES);

    const classifier = command.beginComputePass({ label: SHADING_BIN_CLASSIFIER_LABEL });
    classifier.setPipeline(this.classifierPipeline);
    classifier.setBindGroup(0, bindings.classifier, [bindings.settingsDynamicOffset]);
    classifier.dispatchWorkgroups(
      Math.ceil(this.sizing.width / 64),
      Math.ceil(this.sizing.height / 64),
      1
    );
    classifier.end();
  }

  /** Records finalization separately; consumers must depend on this graph node. */
  encodeFinalize(
    command: ShadeGPUCommandContext,
    bindings: Readonly<ShadingBinFrameBindings>
  ): void {
    this.requireAlive();
    this.validateBindings(bindings);
    const finalizer = command.beginComputePass({ label: SHADING_BIN_FINALIZER_LABEL });
    finalizer.setPipeline(this.finalizerPipeline);
    finalizer.setBindGroup(0, bindings.finalizer, [bindings.settingsDynamicOffset]);
    finalizer.dispatchWorkgroups(1, 1, 1);
    finalizer.end();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.heap.destroy();
    this.indirectArgs.destroy();
    this.classifierGroups.clear();
    this.finalizerGroups.clear();
  }

  bindingCacheEvidence(): Readonly<{
    readonly requests: number;
    readonly creations: number;
  }> {
    const classifier = this.classifierGroups.evidence();
    const finalizer = this.finalizerGroups.evidence();
    return Object.freeze({
      requests: classifier.requestCount + finalizer.requestCount,
      creations: classifier.creationCount + finalizer.creationCount
    });
  }

  private requireAlive(): void {
    if (this.destroyed) throw new Error("ShadingBin pass resources are destroyed");
  }

  private validateBindings(bindings: Readonly<ShadingBinFrameBindings>): void {
    if (bindings.layoutRevision !== this.sizing.layouts[0]!.revision || bindings.generation === 0) {
      throw new Error("ShadingBin encode bindings do not match the immutable layout snapshot");
    }
  }
}

export function classifierBindGroupLayoutDescriptor(
  diagnostics: boolean
): GPUBindGroupLayoutDescriptor {
  return {
    label: diagnostics
      ? "ADR-0013 ShadingBin classifier diagnostics group0 layout"
      : "ADR-0013 ShadingBin classifier group0 layout",
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: GPU_SHADING_BIN_SETTINGS_STRIDE }
      },
      ...(diagnostics ? [{
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" as const, minBindingSize: 16 }
      }] : [])
    ]
  };
}

export function finalizerBindGroupLayoutDescriptor(
  diagnostics: boolean
): GPUBindGroupLayoutDescriptor {
  return {
    label: diagnostics
      ? "ADR-0013 ShadingBin finalizer diagnostics group0 layout"
      : "ADR-0013 ShadingBin finalizer group0 layout",
    entries: [
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: GPU_SHADING_BIN_SETTINGS_STRIDE }
      },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ...(diagnostics ? [{
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" as const, minBindingSize: 16 }
      }] : [])
    ]
  };
}

async function createCheckedShaderModule(
  device: GPUDevice,
  label: string,
  code: string
): Promise<GPUShaderModule> {
  device.pushErrorScope("validation");
  const module = device.createShaderModule({ label, code });
  const [compilationInfo, validationError] = await Promise.all([
    module.getCompilationInfo(),
    device.popErrorScope()
  ]);
  const errors = compilationInfo.messages.filter((message) => message.type === "error");
  if (validationError !== null || errors.length !== 0) {
    const details = errors.map((message) =>
      `${message.lineNum}:${message.linePos} ${message.message}`).join("\n");
    throw new Error(
      `${label} failed compilation/validation` +
      (validationError === null ? "" : `: ${validationError.message}`) +
      (details === "" ? "" : `\n${details}`)
    );
  }
  return module;
}

async function createCheckedBuffers(
  device: GPUDevice,
  descriptors: Readonly<ShadingBinResourceDescriptorOracle>
): Promise<Readonly<{ heap: GPUBuffer; indirectArgs: GPUBuffer }>> {
  let heap: GPUBuffer | null = null;
  let indirectArgs: GPUBuffer | null = null;
  device.pushErrorScope("validation");
  try {
    heap = device.createBuffer({
      label: descriptors.heap.label,
      size: descriptors.heap.size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    indirectArgs = device.createBuffer({
      label: descriptors.indirectArgs.label,
      size: descriptors.indirectArgs.size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST
    });
  } catch (error) {
    await device.popErrorScope();
    heap?.destroy();
    indirectArgs?.destroy();
    throw error;
  }
  const validationError = await device.popErrorScope();
  if (validationError !== null) {
    heap.destroy();
    indirectArgs.destroy();
    throw new Error(`ShadingBin resource creation failed validation: ${validationError.message}`);
  }
  return Object.freeze({ heap, indirectArgs });
}

async function checkedValidationScope<T>(
  device: GPUDevice,
  label: string,
  create: () => T
): Promise<T> {
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
    throw new Error(`${label} failed validation: ${validationError.message}`);
  }
  return value;
}

export const SHADING_BIN_CLASSIFIER_DISPATCH_COVERAGE = Object.freeze({
  workgroupWidth: GPU_SHADING_BIN_CLASSIFIER_WORKGROUP_WIDTH,
  workgroupHeight: GPU_SHADING_BIN_CLASSIFIER_WORKGROUP_HEIGHT,
  pixelsPerWorkgroupX: 64,
  pixelsPerWorkgroupY: 64
});
