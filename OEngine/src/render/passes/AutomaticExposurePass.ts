/**
 * AutomaticExposurePass：实现渲染管线中的独立渲染阶段。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { CachedComputePipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import {
  EXPOSURE_ADAPT_WGSL,
  EXPOSURE_HISTOGRAM_BUFFER_SIZE,
  EXPOSURE_HISTOGRAM_WGSL,
  EXPOSURE_REDUCE_WGSL,
  EXPOSURE_VALUE_BUFFER_SIZE
} from "../../shaders/automatic_exposure.js";
import { resolveTextureView } from "./MaterialExpandPass.js";

export class AutomaticExposurePass {
  adaptation_speed_up = 3;
  adaptation_speed_down = 1.2;
  exp_transition_distance = 1.5;
  exposure_compensation = 1;

  private readonly histogramPipeline: CachedComputePipelineDescriptor;
  private readonly reducePipeline: CachedComputePipelineDescriptor;
  private readonly adaptPipeline: CachedComputePipelineDescriptor;
  private readonly adaptedBuffers: [GPUBuffer, GPUBuffer];
  private frameIndex = 0;

  constructor(private readonly device: GPUDevice) {
    this.histogramPipeline = createComputePipelineDescriptor(
      "Renderer/Automatic exposure histogram eC",
      EXPOSURE_HISTOGRAM_WGSL,
      createHistogramGroupLayout()
    );
    this.reducePipeline = createComputePipelineDescriptor(
      "Renderer/Automatic exposure percentile _C",
      EXPOSURE_REDUCE_WGSL,
      createReduceGroupLayout()
    );
    this.adaptPipeline = createComputePipelineDescriptor(
      "Renderer/Automatic exposure adaptation ZE",
      EXPOSURE_ADAPT_WGSL,
      createAdaptGroupLayout()
    );
    this.adaptedBuffers = [
      createInitialExposureBuffer(device),
      createInitialExposureBuffer(device)
    ];
  }

  update(
    graph: FrameGraph,
    inputColor: ResourceId,
    timeDeltaSeconds = 0.01666,
    frameBindings?: {
      readonly previous: ResourceId;
      readonly adapted: ResourceId;
      readonly job: { readonly timeDeltaSeconds: number };
    }
  ): ResourceId {
    if (frameBindings === undefined) this.frameIndex++;

    let histogram = -1;
    const histogramBuilder = graph.add("Automatic exposure histogram eC", {}, (_data, resources, context) => {
      const command = requireShadeCommandContext(context.encoder);
      this.dispatchHistogram(
        command,
        resolveTextureView(resources.get(inputColor)),
        resolveBuffer(resources.get(histogram), "histogram"),
        graph.getDescriptor(inputColor)
      );
    });
    histogram = histogramBuilder.create("Automatic exposure histogram", {
      kind: "transient_buffer",
      size: EXPOSURE_HISTOGRAM_BUFFER_SIZE,
      usage: GPUBufferUsage.STORAGE,
      ensure_cleared: [0, EXPOSURE_HISTOGRAM_BUFFER_SIZE]
    });
    histogramBuilder.read(inputColor);

    let goal = -1;
    const reduceBuilder = graph.add("Automatic exposure percentile _C", {}, (_data, resources, context) => {
      const command = requireShadeCommandContext(context.encoder);
      this.dispatchReduce(
        command,
        resolveBuffer(resources.get(histogram), "histogram"),
        resolveBuffer(resources.get(goal), "target luminance")
      );
    });
    goal = reduceBuilder.create("Automatic exposure target luminance", {
      kind: "transient_buffer",
      size: EXPOSURE_VALUE_BUFFER_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM
    });
    reduceBuilder.read(histogram);

    const previous = frameBindings?.previous ?? graph.import_resource(
        "Automatic exposure previous",
        { kind: "imported", label: "automatic exposure previous" },
        this.historyBuffer(this.frameIndex, false)
      );
    const adaptedImported = frameBindings?.adapted ?? graph.import_resource(
        "Automatic exposure adapted",
        { kind: "imported", label: "automatic exposure adapted" },
        this.historyBuffer(this.frameIndex, true)
      );

    let multiplier = -1;
    let adapted = adaptedImported;
    const adaptBuilder = graph.add(
      "Automatic exposure adaptation ZE",
      frameBindings?.job ?? { timeDeltaSeconds },
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        this.dispatchAdapt(
          command,
          data.timeDeltaSeconds,
          resolveBuffer(resources.get(goal), "goal"),
          resolveBuffer(resources.get(previous), "previous"),
          resolveBuffer(resources.get(adapted), "adapted"),
          resolveBuffer(resources.get(multiplier), "multiplier")
        );
      }
    );
    adaptBuilder.read(goal);
    adaptBuilder.read(previous);
    adapted = adaptBuilder.write(adaptedImported);
    multiplier = adaptBuilder.create("Automatic exposure multiplier", {
      kind: "transient_buffer",
      size: EXPOSURE_VALUE_BUFFER_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM
    });
    return multiplier;
  }

  historyBuffer(frameIndex: number, output: boolean): GPUBuffer {
    return this.adaptedBuffers[(frameIndex + (output ? 1 : 0)) % 2]!;
  }

  unadapted(graph: FrameGraph): ResourceId {
    let output = -1;
    const builder = graph.add(
      "Automatic exposure unadapted",
      { value: 1 + this.exposure_compensation },
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        const value = new Float32Array([data.value]);
        command.writeBuffer(
          resolveBuffer(resources.get(output), "unadapted multiplier"),
          0,
          value.buffer,
          value.byteOffset,
          value.byteLength
        );
      }
    );
    output = builder.create("Automatic exposure unadapted multiplier", {
      kind: "transient_buffer",
      size: EXPOSURE_VALUE_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    return output;
  }

  private dispatchHistogram(
    command: ShadeGPUCommandContext,
    input: GPUTextureView,
    histogram: GPUBuffer,
    descriptor: ReturnType<FrameGraph["getDescriptor"]>
  ): void {
    let width = 1;
    let height = 1;
    if (descriptor?.kind === "transient_texture") {
      width = descriptor.width;
      height = descriptor.height;
    }
    const pass = command.constructComputePass({
      label: "Automatic exposure histogram eC",
      pipeline: this.histogramPipeline,
      bindings: [[input, { buffer: histogram }]]
    });
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16), 1);
    pass.end();
  }

  private dispatchReduce(command: ShadeGPUCommandContext, histogram: GPUBuffer, output: GPUBuffer): void {
    const pass = command.constructComputePass({
      label: "Automatic exposure percentile _C",
      pipeline: this.reducePipeline,
      bindings: [[{ buffer: histogram }, { buffer: output }]]
    });
    pass.dispatchWorkgroups(1, 1, 1);
    pass.end();
  }

  private dispatchAdapt(
    command: ShadeGPUCommandContext,
    timeDeltaSeconds: number,
    goal: GPUBuffer,
    previous: GPUBuffer,
    adapted: GPUBuffer,
    multiplier: GPUBuffer
  ): void {
    const settingsBuffer = command.allocateTransientBufferAndLoad(
      new Float32Array([
        this.adaptation_speed_up,
        this.adaptation_speed_down,
        timeDeltaSeconds,
        this.exp_transition_distance,
        this.exposure_compensation
      ]).buffer,
      GPUBufferUsage.UNIFORM
    );
    const pass = command.constructComputePass({
      label: "Automatic exposure adaptation ZE",
      pipeline: this.adaptPipeline,
      bindings: [[
        { buffer: goal },
        { buffer: previous },
        { buffer: settingsBuffer },
        { buffer: adapted },
        { buffer: multiplier }
      ]]
    });
    pass.dispatchWorkgroups(1, 1, 1);
    pass.end();
  }

  destroy(): void {
    this.adaptedBuffers[0].destroy();
    this.adaptedBuffers[1].destroy();
  }
}

function createComputePipelineDescriptor(
  label: string,
  code: string,
  group0: GPUBindGroupLayoutDescriptor
): CachedComputePipelineDescriptor {
  return {
    label,
    layout: {
      label: `${label} layout`,
      bindGroupLayouts: [group0]
    },
    compute: {
      module: { label, code },
      entryPoint: "main"
    }
  };
}

function createHistogramGroupLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "Renderer/Automatic exposure eC group0",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "unfilterable-float", viewDimension: "2d" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" }
      }
    ]
  };
}

function createReduceGroupLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "Renderer/Automatic exposure _C group0",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" }
      }
    ]
  };
}

function createAdaptGroupLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "Renderer/Automatic exposure ZE group0",
    entries: [
      ...[0, 1, 2].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" as const }
      })),
      ...[3, 4].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" as const }
      }))
    ]
  };
}

function createInitialExposureBuffer(device: GPUDevice): GPUBuffer {
  const buffer = device.createBuffer({
    label: "",
    size: EXPOSURE_VALUE_BUFFER_SIZE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM,
    mappedAtCreation: true
  });
  new Float32Array(buffer.getMappedRange()).set([1]);
  buffer.unmap();
  return buffer;
}

function resolveBuffer(resource: unknown, label: string): GPUBuffer {
  if (resource && typeof resource === "object") {
    if ("size" in resource && "usage" in resource) return resource as GPUBuffer;
    if ("buffer" in resource) {
      const buffer = (resource as { buffer?: unknown }).buffer;
      if (buffer && typeof buffer === "object" && "size" in buffer) return buffer as GPUBuffer;
    }
  }
  throw new Error(`AutomaticExposurePass: ${label} is not a GPUBuffer`);
}

function requireShadeCommandContext(value: unknown): ShadeGPUCommandContext {
  if (
    value &&
    typeof value === "object" &&
    "isGPUCommandContext" in value &&
    (value as { isGPUCommandContext?: unknown }).isGPUCommandContext === true &&
    "constructComputePass" in value
  ) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error(
    "AutomaticExposurePass: cached eC/_C/ZE require ShadeGPUCommandContext"
  );
}
