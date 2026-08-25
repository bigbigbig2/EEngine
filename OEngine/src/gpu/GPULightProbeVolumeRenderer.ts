/**
 * GPULightProbeVolumeRenderer：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import { LineBuilder } from "../core/LineBuilder.js";
import { WGSL_u32, WGSL_vec3f } from "../core/WebGPUTypes.js";
import { StructType } from "../core/WgslStruct.js";
import { GPUPerformanceTimer } from "../framegraph/GPUPerformanceTimer.js";
import { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import {
  PROBE_LEGACY_BAKE_WGSL,
  PROBE_LEGACY_DERING_WGSL
} from "../shaders/probe_legacy.generated.js";
import { PROBE_PLACEMENT_WGSL } from "../shaders/probe_placement.js";
import type { CachedComputePipelineDescriptor } from "./GPUDescriptorCaches.js";
import type { GPUSceneContext } from "./GPUSceneContext.js";
import { GPUTextureContext } from "./GPUTextureContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";

type ProbePlacementGrid = {
  boundsMin: Float32Array;
  boundsMax: Float32Array;
  resolution: [number, number, number];
  cellCount: number;
};

type ProbePlacementReadback = {
  count: number;
  data: Float32Array;
  grid: ProbePlacementGrid;
};

const RAYS_PER_PROBE = 256;
const UINT32_MAX = 0xffffffff;
const PROBE_PLACEMENT_SETTINGS_BYTES = 48;

const PROBE_DERING_SETTINGS_TYPE = StructType.from({
  start: WGSL_u32
});

const PROBE_BAKE_SETTINGS_TYPE = StructType.from({
  direction: WGSL_vec3f,
  seed: WGSL_u32,
  initial_probe_index_offset: WGSL_u32
});

export const PROBE_LEGACY_DERING_PIPELINE: CachedComputePipelineDescriptor = {
  label: "",
  layout: {
    label: "",
    bindGroupLayouts: [
      {
        label: "",
        entries: [
          uniformEntry(0),
          storageEntry(1)
        ]
      },
      {
        label: "",
        entries: [uniformEntry(0)]
      }
    ]
  },
  compute: {
    module: { label: "", code: PROBE_LEGACY_DERING_WGSL },
    entryPoint: "main"
  }
};

export const PROBE_LEGACY_BAKE_PIPELINE: CachedComputePipelineDescriptor = {
  label: "",
  layout: {
    label: "",
    bindGroupLayouts: [
      {
        label: "",
        entries: [
          uniformEntry(0),
          storageEntry(1),
          uniformEntry(2),
          textureEntry(3, "2d-array"),
          uniformEntry(4),
          textureEntry(5, "2d")
        ]
      },
      {
        label: "",
        entries: Array.from({ length: 5 }, (_, binding) =>
          readOnlyStorageEntry(binding)
        )
      },
      {
        label: "",
        entries: [readOnlyStorageEntry(0)]
      }
    ]
  },
  compute: {
    module: { label: "", code: PROBE_LEGACY_BAKE_WGSL },
    entryPoint: "main"
  }
};

export class GPULightProbeVolumeRenderer {
  private readonly placementPipeline: CachedComputePipelineDescriptor;
  private readonly device: GPUDevice;
  private readonly residentMaterials;
  private readonly timer: GPUPerformanceTimer;
  private environmentValue: GPUTextureContext;
  private materialLimitValue = 0;
  private readonly random = createSeededRandom(7);
  private rayBudget = 32768;
  private initialProbeIndexOffset = 0;
  private accumulatedProbeFraction = 0;
  private bakeCount = 0;

  constructor(
    private readonly graphics: GraphicsContext,
    private readonly sceneContext: GPUSceneContext
  ) {
    this.device = graphics.device;
    this.residentMaterials = graphics.materials_resident;
    this.timer = new GPUPerformanceTimer(this.device, "Probe Render");
    this.environmentValue = new GPUTextureContext(this.device);
    this.environmentValue.descriptor.format = "rgba16float";
    this.placementPipeline = {
      label: "ProbePlacement/aB",
      layout: {
        label: "ProbePlacement/aB-layout",
        bindGroupLayouts: [
          probePlacementOutputLayout(),
          probePlacementSceneLayout()
        ]
      },
      compute: {
        module: { label: "ProbePlacement/module", code: PROBE_PLACEMENT_WGSL },
        entryPoint: "main"
      }
    };
  }

  static fast(graphics: GraphicsContext, scene: GPUSceneContext): void {
    const renderer = new GPULightProbeVolumeRenderer(graphics, scene);
    renderer.bake();
    renderer.destroy();
  }

  get environment(): GPUTextureContext {
    return this.environmentValue;
  }

  set environment(value: GPUTextureContext) {
    this.environmentValue = value;
  }

  get material_limit(): number {
    return this.materialLimitValue;
  }

  get performance_rays_per_second(): number {
    return 1 / ((1e-9 * this.timer.stats.average) / this.currentRayCount);
  }

  async generate_locations(resolution = 2): Promise<GPUSceneContext> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });

    this.graphics.update();
    this.sceneContext.update(this.graphics);
    const grid = this.createGrid(resolution);
    const result = await this.dispatchAndReadback(resolution, grid);

    console.warn(
      `Probe count = ${result.count}, ${(
        (100 * result.count) /
        result.grid.cellCount
      ).toFixed(2)}%`,
      { count: result.count, data: result.data }
    );

    const source = this.sceneContext.light_probe_volume.source;
    source.positions = result.data.slice(0, 3 * result.count);
    source.build_mesh();
    return this.sceneContext;
  }

  dering(
    commandContext?: ShadeGPUCommandContext,
    firstProbe = 0,
    probesToUpdate = -1
  ): void {
    const ownsCommand = commandContext === undefined;
    const command = commandContext ?? ShadeGPUCommandContext.create(
      this.graphics,
      "LPV/dering"
    );
    const probes = this.sceneContext.light_probe_volume;
    const probeCount = probesToUpdate >= 0
      ? probesToUpdate
      : probes.source.probe_count;
    const settings = command.allocateTransientValueBuffer(
      PROBE_DERING_SETTINGS_TYPE,
      { start: firstProbe },
      GPUBufferUsage.UNIFORM
    );
    const pass = command.constructComputePass({
      pipeline: PROBE_LEGACY_DERING_PIPELINE,
      bindings: [
        [
          { buffer: probes.buffer_metadata },
          { buffer: probes.buffer_probes }
        ],
        [{ buffer: settings }]
      ]
    });
    pass.dispatchWorkgroups(probeCount);
    pass.end();
    if (ownsCommand) command.finish();
  }

  bake(): void {
    this.graphics.update();
    const scene = this.sceneContext;
    scene.update(this.graphics);
    const geometries = scene.meshlets;
    const probes = scene.light_probe_volume;
    const probeCount = probes.source.probe_count;
    if (probeCount === 0) return;

    probes.update();
    const resident = this.residentMaterials;
    resident.ensure_scene_materials(scene.scene);
    resident.update();

    const command = ShadeGPUCommandContext.create(this.graphics, "LPV/bake");
    const probesToUpdate = this.probesPerBatch;
    if (probesToUpdate <= 0) return;

    const direction = new Float32Array(3);
    randomUnitDirection(this.random, direction);
    const settings = command.allocateTransientValueBuffer(
      PROBE_BAKE_SETTINGS_TYPE,
      {
        direction,
        initial_probe_index_offset: this.initialProbeIndexOffset,
        seed: randomInteger(this.random, 0, UINT32_MAX)
      },
      GPUBufferUsage.UNIFORM
    );

    const blas = geometries.blas;
    this.dispatchLegacyBake(command, probesToUpdate, [
      [
        { buffer: probes.buffer_metadata },
        { buffer: probes.buffer_probes },
        { buffer: resident.buffer_materials },
        resident.textureView,
        { buffer: settings },
        this.environmentValue.obtainView()
      ],
      [
        { buffer: scene.tlas.buffer },
        { buffer: blas.buffer_metadata },
        { buffer: blas.buffer_data },
        { buffer: scene.scene_database_buffer! },
        { buffer: geometries.meshMetaBuffer! }
      ],
      [{ buffer: scene.lights.buffer_data }]
    ]);
    command.finish();

    this.accumulatedProbeFraction += probesToUpdate / probeCount;
    this.initialProbeIndexOffset = (
      this.initialProbeIndexOffset + probesToUpdate
    ) % probeCount;
    this.bakeCount++;
  }

  autoSetRaysPerProbe(targetBudgetMs: number): void {
    if (targetBudgetMs > 1000) {
      throw new Error(
        `Budget(=${targetBudgetMs}) too high, must be less than 1000`
      );
    }
    if (this.timer.event_count < 64) return;
    const averageMs = 1e-6 * this.timer.stats.average;
    if (averageMs <= 0) return;
    const lastMs = 1e-6 * this.timer.stats.last;
    if (averageMs > targetBudgetMs) {
      if (lastMs > targetBudgetMs) {
        this.rayBudget = Math.max(1, Math.floor(0.9 * this.rayBudget));
      }
    } else if (targetBudgetMs / averageMs > 1.1 && lastMs < targetBudgetMs) {
      const increase = Math.max(
        RAYS_PER_PROBE,
        Math.floor(0.05 * this.rayBudget)
      );
      this.rayBudget += increase;
    }
  }

  getStatText(): string {
    const builder = new LineBuilder();
    const raysPerProbe = this.accumulatedProbeFraction * RAYS_PER_PROBE;
    builder.add(`Rays per probe: ${formatInteger(Math.floor(raysPerProbe))}`);
    builder.add(
      `Average rays/s: ${formatInteger(Math.round(this.performance_rays_per_second))}`
    );
    return builder.build();
  }

  destroy(): void {
  }

  private get probesPerBatch(): number {
    const probeCount = this.sceneContext.light_probe_volume.source.probe_count;
    return clamp(Math.ceil(this.rayBudget / RAYS_PER_PROBE), 0, probeCount);
  }

  private get currentRayCount(): number {
    return this.probesPerBatch * RAYS_PER_PROBE;
  }

  private dispatchLegacyBake(
    command: ShadeGPUCommandContext,
    groupCountX: number,
    bindings: GPUBindingResource[][]
  ): void {
    try {
      const pass = command.constructComputePass({
        pipeline: PROBE_LEGACY_BAKE_PIPELINE,
        bindings
      });
      pass.dispatchWorkgroups(groupCountX, 1, 1);
      pass.end();
    } catch (cause) {
      const error = new Error("ComputeShader '' failed to dispatch' ");
      (error as Error & { cause?: unknown }).cause = cause;
      throw error;
    }
  }

  private createGrid(resolution: number): ProbePlacementGrid {
    const bounds = this.sceneContext.scene.instances.bounding_box;
    const longestSpan = Math.max(bounds.width, bounds.height, bounds.depth);
    bounds.grow(0.05 * Math.max(longestSpan, 1e-5));

    const nominalCellSize = longestSpan / resolution;
    const width = Math.max(2, Math.round(bounds.width / nominalCellSize));
    const height = Math.max(2, Math.round(bounds.height / nominalCellSize));
    const depth = Math.max(2, Math.round(bounds.depth / nominalCellSize));
    const cellX = bounds.width / width;
    const cellY = bounds.height / height;
    const cellZ = bounds.depth / depth;

    bounds.x0 -= 0.5 * cellX;
    bounds.y0 -= 0.5 * cellY;
    bounds.z0 -= 0.5 * cellZ;
    bounds.x1 += 0.5 * cellX;
    bounds.y1 += 0.5 * cellY;
    bounds.z1 += 0.5 * cellZ;

    return {
      boundsMin: new Float32Array([bounds.x0, bounds.y0, bounds.z0]),
      boundsMax: new Float32Array([bounds.x1, bounds.y1, bounds.z1]),
      resolution: [width, height, depth],
      cellCount: width * height * depth
    };
  }

  private async dispatchAndReadback(
    requestedResolution: number,
    grid: ProbePlacementGrid
  ): Promise<ProbePlacementReadback> {
    const sceneDatabase = this.sceneContext.scene_database_buffer;
    const geometryMetadata = this.sceneContext.meshlets.meshMetaBuffer;
    if (!sceneDatabase || !geometryMetadata) {
      throw new Error("Probe placement: GPU Scene buffers are not built");
    }

    const outputByteSize =
      requestedResolution *
      requestedResolution *
      requestedResolution *
      Float32Array.BYTES_PER_ELEMENT *
      3;
    const output = this.device.createBuffer({
      label: "generate probe positions/out",
      size: outputByteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    const readback = this.device.createBuffer({
      label: "generate probe positions/readback",
      size: outputByteSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    const settings = this.createSettingsBuffer(grid);

    try {
      const command = ShadeGPUCommandContext.create(
        this.graphics,
        "generate probe positions"
      );
      const pass = command.constructComputePass({
        label: "gpu_vertex_count_required",
        pipeline: this.placementPipeline,
        bindings: [
          [{ buffer: settings }, { buffer: output }],
          [
            { buffer: sceneDatabase },
            { buffer: this.sceneContext.tlas.buffer },
            { buffer: this.sceneContext.meshlets.blas.buffer_metadata },
            { buffer: this.sceneContext.meshlets.blas.buffer_data },
            { buffer: geometryMetadata },
            { buffer: this.sceneContext.meshlets.headerBuffer },
            { buffer: this.sceneContext.meshlets.dataBuffer }
          ]
        ]
      });
      pass.dispatchWorkgroups(
        Math.ceil(grid.resolution[0] / 16),
        Math.ceil(grid.resolution[1] / 16),
        grid.resolution[2]
      );
      pass.end();
      command.copyBufferToBuffer(output, 0, readback, 0, outputByteSize);
      command.finish();

      await readback.mapAsync(GPUMapMode.READ);
      const bytes = readback.getMappedRange(0, outputByteSize).slice(0);
      readback.unmap();
      const count = new Uint32Array(bytes, 0, 1)[0] ?? 0;
      const availableFloatCount = Math.max(
        0,
        Math.floor((bytes.byteLength - Uint32Array.BYTES_PER_ELEMENT) / 4)
      );
      const data = new Float32Array(
        bytes,
        Uint32Array.BYTES_PER_ELEMENT,
        availableFloatCount
      ).slice();
      return { count, data, grid };
    } finally {
      settings.destroy();
      output.destroy();
      readback.destroy();
    }
  }

  private createSettingsBuffer(grid: ProbePlacementGrid): GPUBuffer {
    const bytes = new ArrayBuffer(PROBE_PLACEMENT_SETTINGS_BYTES);
    const f32 = new Float32Array(bytes);
    const u32 = new Uint32Array(bytes);
    f32[0] = grid.boundsMin[0]!;
    f32[1] = grid.boundsMin[1]!;
    f32[2] = grid.boundsMin[2]!;
    f32[4] = grid.boundsMax[0]!;
    f32[5] = grid.boundsMax[1]!;
    f32[6] = grid.boundsMax[2]!;
    u32[8] = grid.resolution[0] >>> 0;
    u32[9] = grid.resolution[1] >>> 0;
    u32[10] = grid.resolution[2] >>> 0;

    const buffer = this.device.createBuffer({
      label: "ProbePlacement/settings",
      size: PROBE_PLACEMENT_SETTINGS_BYTES,
      usage: GPUBufferUsage.UNIFORM,
      mappedAtCreation: true
    });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(bytes));
    buffer.unmap();
    return buffer;
  }
}

function createSeededRandom(seed = 0): () => number {
  let current = seed;
  return () => {
    current += 1831565813;
    let value = current;
    value = Math.imul(value ^ (value >>> 15), 1 | value);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInteger(
  random: () => number,
  minimum: number,
  maximum: number
): number {
  return Math.round(random() * (maximum - minimum)) + minimum;
}

function randomUnitDirection(
  random: () => number,
  out: Float32Array
): void {
  const azimuth = 2 * Math.PI * random();
  const z = 2 * random() - 1;
  const polar = Math.acos(z);
  const radius = Math.sin(polar);
  out[0] = radius * Math.cos(azimuth);
  out[1] = radius * Math.sin(azimuth);
  out[2] = z;
}

function formatInteger(value: number, separator = ","): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function uniformEntry(binding: number): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type: "uniform" }
  };
}

function storageEntry(binding: number): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type: "storage" }
  };
}

function readOnlyStorageEntry(binding: number): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type: "read-only-storage" }
  };
}

function textureEntry(
  binding: number,
  viewDimension: GPUTextureViewDimension
): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.COMPUTE,
    texture: {
      sampleType: "unfilterable-float",
      viewDimension,
      multisampled: false
    }
  };
}

function probePlacementOutputLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "ProbePlacement/group0-layout",
    entries: [uniformEntry(0), storageEntry(1)]
  };
}

function probePlacementSceneLayout(): GPUBindGroupLayoutDescriptor {
  return {
    label: "ProbePlacement/Zy-layout",
    entries: Array.from({ length: 7 }, (_, binding) =>
      readOnlyStorageEntry(binding)
    )
  };
}
