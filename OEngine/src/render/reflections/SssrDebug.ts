import { PreparedRenderPipeline } from "../../gpu/PreparedPipeline.js";
import { FULLSCREEN_TRIANGLE_VERTEX_WGSL } from "../../shaders/fullscreen_triangle.js";
import { RenderDebugView } from "../../debug/RenderDebugView.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { SssrRuntime } from "./SssrRuntime.js";
import { GpuBindGroupCache } from "../../gpu/GpuBindGroupResourceCache.js";

export function isSssrDebug(view: string | undefined): boolean {
  return (
    view === RenderDebugView.ScreenSpaceReflectionHitMiss ||
    view === RenderDebugView.ScreenSpaceReflectionResolve ||
    view === RenderDebugView.ScreenSpaceReflectionTemporal ||
    view === RenderDebugView.ScreenSpaceReflectionHistoryConfidence
  );
}

/** Debug owns only PSOs. Inputs remain with the effect until the frame fence. */
export class SssrDebug {
  async preparePipelines(mode: 0 | 1 | 2): Promise<void> {
    await this.pipelines[mode]!.prepare();
  }

  private readonly pipelines: readonly PreparedRenderPipeline[];
  private readonly groups = new GpuBindGroupCache(8);
  private readonly views = new WeakMap<GPUTexture, GPUTextureView>();

  releaseBindings(): void {
    this.groups.clear();
  }
  constructor(device: GPUDevice) {
    this.pipelines = ["inactive", "signal", "diagnostic"].map((mode) => {
      const declarations =
        mode === "signal"
          ? "@group(0) @binding(0) var signal: texture_2d<f32>;"
          : mode === "diagnostic"
            ? "@group(0) @binding(0) var signal: texture_2d<f32>;\n@group(0) @binding(1) var<storage, read> values: array<f32>;"
            : "";
      const expression =
        mode === "signal"
          ? "textureLoad(signal, coordinate, 0).rgb"
          : "vec3f(values[u32(coordinate.y) * extent.x + u32(coordinate.x)])";
      const code = `${FULLSCREEN_TRIANGLE_VERTEX_WGSL.replace("fn main(", "fn vs_main(")}
${declarations}
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  ${
    mode === "inactive"
      ? "return vec4f(0.0, 0.0, 0.0, 1.0);"
      : `let extent = textureDimensions(signal);
  let coordinate = vec2i(min(vec2u(uv * vec2f(extent)), extent - vec2u(1u)));
  return vec4f(${expression}, 1.0);`
  }
}`;
      const module = device.createShaderModule({ code, label: `SSSR/debug ${mode}` });
      return new PreparedRenderPipeline(device, {
        label: `SSSR/debug ${mode}`,
        layout: "auto",
        vertex: { module, entryPoint: "vs_main" },
        fragment: { module, entryPoint: "fs_main", targets: [{ format: "rgba16float" }] },
        primitive: { topology: "triangle-list" }
      });
    });
  }

  encode(
    command: ShadeGPUCommandContext,
    output: unknown,
    view: string,
    lobe: 0 | 1,
    runtime: SssrRuntime | null,
    diagnostic?: GPUBuffer
  ): void {
    const signal =
      runtime === null
        ? null
        : view === RenderDebugView.ScreenSpaceReflectionResolve
          ? lobe === 0
            ? runtime.frame.basePrefilter
            : runtime.frame.coatPrefilter
          : lobe === 0
            ? runtime.frame.base
            : runtime.frame.coat;
    const index = runtime === null ? 0 : diagnostic ? 2 : 1;
    const pipeline = this.pipelines[index]!;
    const pass = command.gpu_encoder.beginRenderPass({
      label: "SSSR/debug selected lobe",
      colorAttachments: [{ view: resolveTextureView(output), loadOp: "clear", storeOp: "store" }]
    });
    pass.setPipeline(pipeline.requirePrepared());
    if (signal) {
      let signalView = this.views.get(signal);
      if (!signalView) {
        signalView = signal.createView();
        this.views.set(signal, signalView);
      }
      pass.setBindGroup(
        0,
        this.groups.create(command.device, {
          layout: pipeline.requirePrepared().getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: signalView },
            ...(diagnostic ? [{ binding: 1, resource: { buffer: diagnostic } }] : [])
          ]
        })
      );
    }
    pass.draw(3);
    pass.end();
  }
}
