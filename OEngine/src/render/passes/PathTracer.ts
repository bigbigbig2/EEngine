/**
 * PathTracer：实现渲染管线中的独立渲染阶段。
 */

import { PerspectiveCamera } from "../../camera/PerspectiveCamera.js";
import { BitSet } from "../../core/BitSet.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type {
  CachedComputePipelineDescriptor,
  CachedRenderPipelineDescriptor
} from "../../gpu/GPUDescriptorCaches.js";
import { GPUTextureContext, textureMipLevelCount } from "../../gpu/GPUTextureContext.js";
import type { GPUViewContext } from "../ViewContext.js";
import {
  PATH_TRACER_HISTORY_FORMAT,
  PATH_TRACER_OUTPUT_FORMAT,
  PATH_TRACER_POST_WGSL,
  PATH_TRACER_SETTINGS_TYPE,
  PATH_TRACER_WGSL
} from "../../shaders/path_tracer.js";

const PATH_TRACER_RAY_QUERY_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "PathTracer/zE/ray-query-layout",
  entries: Array.from({ length: 7 }, (_, binding) => ({
    binding,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type: "read-only-storage" as const }
  }))
};

const PATH_TRACER_MATERIAL_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "PathTracer/zE/material-layout",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform" }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" }
    }
  ]
};

const PATH_TRACER_LIGHT_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "PathTracer/zE/light-layout",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "read-only-storage" }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType: "unfilterable-float", viewDimension: "2d" }
    }
  ]
};

const PATH_TRACER_ACCUMULATION_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "PathTracer/zE/accumulation-layout",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform" }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform" }
    },
    {
      binding: 2,
      visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType: "unfilterable-float", viewDimension: "2d" }
    },
    {
      binding: 3,
      visibility: GPUShaderStage.COMPUTE,
      storageTexture: {
        access: "write-only",
        format: PATH_TRACER_HISTORY_FORMAT,
        viewDimension: "2d"
      }
    }
  ]
};

const PATH_TRACER_MODULE: GPUShaderModuleDescriptor = {
  label: "PathTracer/zE/path-integrator",
  code: PATH_TRACER_WGSL
};

const PATH_TRACER_PIPELINE: CachedComputePipelineDescriptor = {
  label: "PathTracer/zE/path-integrator",
  layout: {
    label: "PathTracer/zE/pipeline-layout",
    bindGroupLayouts: [
      PATH_TRACER_RAY_QUERY_LAYOUT,
      PATH_TRACER_MATERIAL_LAYOUT,
      PATH_TRACER_LIGHT_LAYOUT,
      PATH_TRACER_ACCUMULATION_LAYOUT
    ]
  },
  compute: { module: PATH_TRACER_MODULE, entryPoint: "main" }
};

const PATH_TRACER_POST_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "PathTracer/zE/post-layout",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "unfilterable-float", viewDimension: "2d" }
    }
  ]
};

const PATH_TRACER_POST_MODULE: GPUShaderModuleDescriptor = {
  label: "PathTracer/zE/post",
  code: PATH_TRACER_POST_WGSL
};

const PATH_TRACER_COPY_PIPELINE = postPipeline(
  "PathTracer/zE/color_lerp",
  "fs_copy"
);
const PATH_TRACER_MIP_PIPELINE = postPipeline(
  "PathTracer/zE/simple_read",
  "fs_nonzero_mip"
);
const PATH_TRACER_FLOOD_PIPELINE = postPipeline(
  "PathTracer/zE/is_gpu_memory_usage",
  "fs_flood_fill"
);

export type PathTracerRenderOptions = {
  view: GPUViewContext;
  graph: FrameGraph;
};

type AccumulationPassData = {
  history: ResourceId;
  output: ResourceId;
};

type SingleTexturePassData = {
  input: ResourceId;
  output: ResourceId;
};

type MipmapPassData = {
  target: ResourceId;
};

export class PathTracer {
  render_tile_size = 256;
  min_accumulation_alpha = 0.01;
  clear_history = false;

  private readonly history: [GPUTextureContext, GPUTextureContext];
  private tileAccumulationCounts = new Uint32Array(0);
  private tileSpiralOrder = new Uint32Array(0);
  private readonly visitedTiles = new BitSet();
  private roundTileCounter = 0;
  private sampleCounter = 0;
  private zeroBytes: Uint8Array<ArrayBuffer> | null = null;
  private readonly previousCamera = new PerspectiveCamera();
  private readonly device: GPUDevice;

  constructor(private readonly graphics: GraphicsContext) {
    this.device = graphics.device;
    this.history = [0, 1].map((index) => new GPUTextureContext(this.device, {
      label: `accumulating-path-tracer-history-${index}`,
      size: [1, 1, 1],
      format: PATH_TRACER_HISTORY_FORMAT,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST
    })) as [GPUTextureContext, GPUTextureContext];
  }

  render({ view, graph }: PathTracerRenderOptions): ResourceId {
    if (!this.previousCamera.equals(view.camera.camera)) {
      this.clear_history = true;
      this.previousCamera.copy(view.camera.camera);
    }

    const width = view.resolution[0]!;
    const height = view.resolution[1]!;
    const tileSize = this.render_tile_size;
    const tileCountX = Math.ceil(width / tileSize);
    const tileCount = tileCountX * Math.ceil(height / tileSize);
    this.ensureHistory(width, height, tileCount);
    if (this.clear_history) {
      this.clear_history = false;
      this.clearHistory(width, height);
    }
    if (this.roundTileCounter >= tileCount) {
      this.roundTileCounter = 0;
      this.visitedTiles.reset();
    }

    const sampleCounter = this.sampleCounter;
    const tileIndex = this.tileSpiralOrder[sampleCounter % tileCount]!;
    const tileOffsetX = (tileIndex % tileCountX) * tileSize;
    const tileOffsetY = Math.floor(tileIndex / tileCountX) * tileSize;
    const tileSampleCount = this.tileAccumulationCounts[tileIndex]! + 1;
    const alpha = Math.max(
      1 / tileSampleCount,
      this.min_accumulation_alpha
    );
    this.tileAccumulationCounts[tileIndex] = tileSampleCount;

    const historyIndex = sampleCounter & 1;
    const historyInput = this.history[historyIndex]!;
    const historyOutput = this.history[1 ^ historyIndex]!;
    const dispatchSize = Math.ceil(tileSize / 8);
    const accumulationData: AccumulationPassData = {
      history: -1,
      output: -1
    };
    const accumulationBuilder = graph.add(
      "get_color_attachments",
      accumulationData,
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        const resident = this.graphics.materials_resident;
        const scene = view.scene;
        resident.ensure_scene_materials(scene.scene);
        resident.update();

        const geometry = scene.geometries;
        const sceneDatabase = requireBuffer(
          scene.scene_database_buffer,
          "PathTracer: scene database is unavailable"
        );
        const geometryMetadata = requireBuffer(
          geometry.meshMetaBuffer,
          "PathTracer: geometry metadata is unavailable"
        );
        const input = requireTextureContext(resources.get(data.history));
        const output = requireTextureContext(resources.get(data.output));
        command.copyTextureToTexture(
          { texture: input.gpu_texture, mipLevel: 0, origin: [0, 0, 0] },
          { texture: output.gpu_texture, mipLevel: 0, origin: [0, 0, 0] },
          [output.width, output.height, 1]
        );
        const settings = command.allocateTransientValueBuffer(
          PATH_TRACER_SETTINGS_TYPE,
          {
            tile_offset: [tileOffsetX, tileOffsetY],
            tile_size: tileSize,
            random_seed: sampleCounter,
            alpha
          }
        );
        const pass = command.constructComputePass({
          label: "get_color_attachments",
          pipeline: PATH_TRACER_PIPELINE,
          bindings: [
            [
              { buffer: sceneDatabase },
              { buffer: scene.tlas.buffer },
              { buffer: geometry.blas.buffer_metadata },
              { buffer: geometry.blas.buffer_data },
              { buffer: geometryMetadata },
              { buffer: geometry.meshlets.buffer_metadata },
              { buffer: geometry.meshlets.buffer_data }
            ],
            [
              { buffer: resident.buffer_materials },
              resident.textureView
            ],
            [
              { buffer: scene.lights.buffer_data },
              scene.lights.environment.obtainView()
            ],
            [
              { buffer: settings },
              { buffer: view.camera.gpu_buffer },
              input.obtainView(),
              output.obtainView()
            ]
          ]
        });
        pass.dispatchWorkgroups(dispatchSize, dispatchSize, 1);
        pass.end();
      }
    );

    const importedHistory = graph.import_resource(
      "accumulating path tracer history",
      { kind: "imported", label: historyInput.label },
      historyInput
    );
    const importedOutput = graph.import_resource(
      "accumulating path tracer output",
      { kind: "imported", label: historyOutput.label },
      historyOutput
    );
    accumulationData.history = accumulationBuilder.read(importedHistory);
    accumulationData.output = accumulationBuilder.write(importedOutput);
    this.visitedTiles.set(tileIndex, true);
    this.sampleCounter++;
    this.roundTileCounter++;

    const f16MipTexture = this.addHistoryConversion(
      graph,
      accumulationData.output,
      width,
      height
    );
    return this.addMipAndFloodFill(graph, f16MipTexture, width, height);
  }

  private ensureZeroBytes(byteLength: number): Uint8Array<ArrayBuffer> {
    if (this.zeroBytes === null || this.zeroBytes.byteLength < byteLength) {
      this.zeroBytes = new Uint8Array(byteLength);
    }
    return this.zeroBytes;
  }

  private clearHistory(width: number, height: number): void {
    const bytes = this.ensureZeroBytes(width * height * 16);
    for (const history of this.history) {
      this.device.queue.writeTexture(
        { texture: history.gpu_texture },
        bytes,
        { bytesPerRow: width * 16, rowsPerImage: height },
        [width, height, 1]
      );
    }
    this.sampleCounter = 0;
    this.tileAccumulationCounts.fill(0);
    this.visitedTiles.reset();
    this.roundTileCounter = 0;
  }

  private buildSpiralOrder(width: number, height: number): void {
    const tileCountX = Math.ceil(width / this.render_tile_size);
    const tileCountY = Math.ceil(height / this.render_tile_size);
    const tileCount = tileCountX * tileCountY;
    let order = this.tileSpiralOrder;
    if (
      width === this.history[0].width &&
      height === this.history[0].height &&
      order.length === tileCount
    ) {
      return;
    }
    if (order.length !== tileCount) {
      this.tileSpiralOrder = new Uint32Array(tileCount);
      order = this.tileSpiralOrder;
    }

    let x = Math.floor(tileCountX / 2);
    let y = Math.floor(tileCountY / 2);
    const directions = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1]
    ] as const;
    let direction = 0;
    let legLength = 1;
    let legProgress = 0;
    let legsAtLength = 0;
    let written = 0;
    while (written < tileCount) {
      if (x >= 0 && x < tileCountX && y >= 0 && y < tileCountY) {
        order[written++] = y * tileCountX + x;
      }
      x += directions[direction]![0];
      y += directions[direction]![1];
      legProgress++;
      if (legProgress === legLength) {
        legProgress = 0;
        direction = (direction + 1) % 4;
        legsAtLength++;
        if (legsAtLength === 2) {
          legLength++;
          legsAtLength = 0;
        }
      }
    }
  }

  private ensureHistory(width: number, height: number, tileCount: number): void {
    const first = this.history[0];
    let changed = first.width !== width || first.height !== height;
    if (changed) {
      for (const history of this.history) history.resize(width, height);
    }
    if (this.tileAccumulationCounts.length !== tileCount) {
      this.tileAccumulationCounts = new Uint32Array(tileCount);
      changed = true;
    }
    this.buildSpiralOrder(width, height);
    if (changed) this.clearHistory(width, height);
  }

  private addHistoryConversion(
    graph: FrameGraph,
    input: ResourceId,
    width: number,
    height: number
  ): ResourceId {
    const data: SingleTexturePassData = { input: -1, output: -1 };
    const builder = graph.add(
      "color_lerp",
      data,
      (passData, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        const source = requireTextureContext(resources.get(passData.input));
        const target = requireTextureContext(resources.get(passData.output));
        drawFullscreen(
          command,
          PATH_TRACER_COPY_PIPELINE,
          source.obtainView(),
          target.obtainView({ baseMipLevel: 0, mipLevelCount: 1 }),
          "color_lerp"
        );
      }
    );
    data.input = builder.read(input);
    data.output = builder.create("f16", {
      kind: "transient_texture",
      label: "f16",
      width,
      height,
      format: PATH_TRACER_OUTPUT_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      mipLevelCount: textureMipLevelCount(width, height)
    });
    return data.output;
  }

  private addMipAndFloodFill(
    graph: FrameGraph,
    input: ResourceId,
    width: number,
    height: number
  ): ResourceId {
    const mipData: MipmapPassData = { target: -1 };
    const mipBuilder = graph.add(
      "simple_read",
      mipData,
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        const target = requireTextureContext(resources.get(data.target));
        let sourceView = target.obtainView({ baseMipLevel: 0, mipLevelCount: 1 });
        for (let level = 1; level < target.mipLevelCount; level++) {
          const targetView = target.obtainView({
            baseMipLevel: level,
            mipLevelCount: 1
          });
          drawFullscreen(
            command,
            PATH_TRACER_MIP_PIPELINE,
            sourceView,
            targetView,
            "simple_read"
          );
          sourceView = targetView;
        }
      }
    );
    mipData.target = mipBuilder.read(input);
    const mipVersion = mipBuilder.write(input);

    const floodData: SingleTexturePassData = { input: -1, output: -1 };
    const floodBuilder = graph.add(
      "is_gpu_memory_usage",
      floodData,
      (data, resources, context) => {
        const command = requireShadeCommandContext(context.encoder);
        const source = requireTextureContext(resources.get(data.input));
        const target = requireTextureContext(resources.get(data.output));
        drawFullscreen(
          command,
          PATH_TRACER_FLOOD_PIPELINE,
          source.obtainView(),
          target.obtainView(),
          "is_gpu_memory_usage"
        );
      }
    );
    floodData.input = floodBuilder.read(mipVersion);
    floodData.output = floodBuilder.create("flood-fill output", {
      kind: "transient_texture",
      label: "flood-fill output",
      width,
      height,
      format: PATH_TRACER_OUTPUT_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    return floodData.output;
  }
}

function postPipeline(
  label: string,
  fragmentEntryPoint: string
): CachedRenderPipelineDescriptor {
  return {
    label,
    layout: {
      label: `${label}/pipeline-layout`,
      bindGroupLayouts: [PATH_TRACER_POST_LAYOUT]
    },
    vertex: { module: PATH_TRACER_POST_MODULE, entryPoint: "vs_main" },
    fragment: {
      module: PATH_TRACER_POST_MODULE,
      entryPoint: fragmentEntryPoint,
      targets: [{ format: PATH_TRACER_OUTPUT_FORMAT }]
    },
    primitive: { topology: "triangle-list", cullMode: "none" }
  };
}

function drawFullscreen(
  command: ShadeGPUCommandContext,
  pipeline: CachedRenderPipelineDescriptor,
  input: GPUTextureView,
  output: GPUTextureView,
  label: string
): void {
  const pass = command.constructRenderPass({
    label,
    pipeline,
    bindings: [[input]],
    colorAttachments: [
      {
        view: output,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store"
      }
    ]
  });
  pass.draw(3, 1, 0, 0);
  pass.end();
}

function requireShadeCommandContext(value: unknown): ShadeGPUCommandContext {
  if (
    value &&
    typeof value === "object" &&
    "isGPUCommandContext" in value &&
    (value as { isGPUCommandContext?: unknown }).isGPUCommandContext === true &&
    "constructComputePass" in value &&
    "constructRenderPass" in value
  ) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("PathTracer: cached pipeline path requires ShadeGPUCommandContext");
}

function requireTextureContext(value: unknown): GPUTextureContext {
  if (
    value instanceof GPUTextureContext ||
    (
      value &&
      typeof value === "object" &&
      "isGPUTextureContext" in value &&
      (value as { isGPUTextureContext?: unknown }).isGPUTextureContext === true
    )
  ) {
    return value as GPUTextureContext;
  }
  throw new Error("PathTracer: FrameGraph resource is not a GPUTextureContext");
}

function requireBuffer(value: GPUBuffer | null, message: string): GPUBuffer {
  if (value === null) throw new Error(message);
  return value;
}
