/**
 * LightProbeAtlas：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type {
  FrameGraph,
  FrameGraphCommandEncoder,
  PassBuilder,
  PassResources
} from "../framegraph/FrameGraph.js";
import type { ResourceId } from "../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { STATIC_GRAPHICS_ENGINE_ASSETS } from "../render/STATIC_GRAPHICS_ENGINE_ASSETS.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { GPUSceneContext } from "./GPUSceneContext.js";
import {
  createNativeTexture,
  createNativeTextureView
} from "./GPUTextureDescriptors.js";
import { LINEAR_CLAMP_SAMPLER_DESCRIPTOR } from "./GPUSamplerCache.js";
import { LightProbeAtlasBorderUpdatePass } from "./LightProbeAtlasBorderUpdatePass.js";
import { LightProbeDepthUpdatePass } from "./LightProbeDepthUpdatePass.js";
import {
  LightProbeGBufferPass,
  type LightProbeGBufferOutputs
} from "./LightProbeGBufferPass.js";
import { LightProbeIndirectPass } from "./LightProbeIndirectPass.js";
import { LightProbeRadianceAccumulatePass } from "./LightProbeRadianceAccumulatePass.js";
import { LightProbeShCommitPass } from "./LightProbeShCommitPass.js";
import { LightProbeShProjectPass } from "./LightProbeShProjectPass.js";
import { LightProbeShReducePass } from "./LightProbeShReducePass.js";
import { probeShProjectBufferBytes } from "../shaders/probe_sh_project.js";

export const LIGHT_PROBE_ATLAS_PROBE_RESOLUTION = 64;
export const LIGHT_PROBE_ATLAS_PADDED_RESOLUTION = 66;
export const LIGHT_PROBE_ATLAS_RADIANCE_FORMAT = "r32uint" as const;
export const LIGHT_PROBE_ATLAS_DEPTH_FORMAT = "rg16float" as const;

export type LightProbeAtlasUpdateLayout = {
  requested_probe_tiles: number;
  requested_update_count: number;
  actual_update_count: number;
  probes_per_row: number;
  output_width: number;
  output_height: number;
};

export type LightProbeAtlasGraphUpdateOptions = {
  graph: FrameGraph;
  scene: GPUSceneContext;
  graphics: GraphicsContext;
  command: ShadeGPUCommandContext;
  update_ray_count?: number;
};

type LightProbeAtlasPasses = {
  gbuffer: LightProbeGBufferPass;
  indirect: LightProbeIndirectPass;
  radiance: LightProbeRadianceAccumulatePass;
  depth: LightProbeDepthUpdatePass;
  border: LightProbeAtlasBorderUpdatePass;
  shProject: LightProbeShProjectPass;
  shReduce: LightProbeShReducePass;
  shCommit: LightProbeShCommitPass;
};

export function computeLightProbeAtlasUpdateLayout(
  probeCount: number,
  updateRayCount: number,
  probeResolution: number,
  maximumTextureDimension: number
): LightProbeAtlasUpdateLayout {
  const requestedProbeTiles = Math.ceil(
    updateRayCount / (probeResolution * probeResolution)
  );
  const requestedUpdateCount = Math.min(probeCount, requestedProbeTiles);
  const probesPerRow = Math.floor(
    maximumTextureDimension / probeResolution
  );
  const actualUpdateCount = Math.min(
    requestedUpdateCount,
    probesPerRow * probesPerRow
  );
  return {
    requested_probe_tiles: requestedProbeTiles,
    requested_update_count: requestedUpdateCount,
    actual_update_count: actualUpdateCount,
    probes_per_row: probesPerRow,
    output_width: probesPerRow * probeResolution,
    output_height:
      Math.max(1, Math.ceil(actualUpdateCount / probesPerRow)) *
      probeResolution
  };
}

function importResource(
  graph: FrameGraph,
  name: string,
  resource: unknown
): ResourceId {
  return graph.import_resource(
    name,
    { kind: "imported", label: name },
    resource
  );
}

function createProbeTexture(
  builder: PassBuilder,
  label: string,
  layout: LightProbeAtlasUpdateLayout,
  format: GPUTextureFormat
): ResourceId {
  return builder.create(label, {
    kind: "transient_texture",
    label,
    width: layout.output_width,
    height: layout.output_height,
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
  });
}

function readAll(
  builder: PassBuilder,
  resources: Record<string, ResourceId>
): void {
  for (const resource of Object.values(resources)) builder.read(resource);
}

function readKeys<T extends Record<string, ResourceId>>(
  builder: PassBuilder,
  resources: T,
  keys: readonly (keyof T)[]
): void {
  for (const key of keys) builder.read(resources[key]!);
}

function resolveGBuffer(
  resources: PassResources,
  ids: {
    albedo: ResourceId;
    emissive: ResourceId;
    normals: ResourceId;
    pbr: ResourceId;
    position: ResourceId;
  },
  width: number,
  height: number
): LightProbeGBufferOutputs {
  return {
    albedo: asTexture(resources.get(ids.albedo)),
    emissive: asTexture(resources.get(ids.emissive)),
    normals: asTexture(resources.get(ids.normals)),
    pbr: asTexture(resources.get(ids.pbr)),
    position: asTexture(resources.get(ids.position)),
    width,
    height
  };
}

function asShadeCommand(
  value: FrameGraphCommandEncoder | GPUCommandEncoder | null
): ShadeGPUCommandContext {
  if (
    !value ||
    typeof value !== "object" ||
    !("isGPUCommandContext" in value) ||
    value.isGPUCommandContext !== true
  ) {
    throw new Error("LightProbeAtlas.graph_update: expected ShadeGPUCommandContext");
  }
  return value as ShadeGPUCommandContext;
}

function asBuffer(value: unknown): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error("LightProbeAtlas.graph_update: expected GPUBuffer");
}

function asTexture(value: unknown): GPUTexture {
  if (!value || typeof value !== "object") {
    throw new Error("LightProbeAtlas.graph_update: expected GPUTexture");
  }
  if ("isGPUTextureContext" in value && value.isGPUTextureContext === true) {
    return (value as unknown as { gpu_texture: GPUTexture }).gpu_texture;
  }
  return value as GPUTexture;
}

function asTextureView(value: unknown): GPUTextureView {
  if (!value || typeof value !== "object") {
    throw new Error("LightProbeAtlas.graph_update: expected GPU texture resource");
  }
  if ("isGPUTextureContext" in value && value.isGPUTextureContext === true) {
    return (value as unknown as { createView(): GPUTextureView }).createView();
  }
  if ("createView" in value && typeof value.createView === "function") {
    return createNativeTextureView(value as GPUTexture);
  }
  return value as GPUTextureView;
}

export class LightProbeAtlasTexture {
  private textureValue: GPUTexture | null = null;

  constructor(
    private readonly device: GPUDevice,
    readonly label: string,
    readonly format: GPUTextureFormat,
    readonly usage: GPUTextureUsageFlags,
    private widthValue: number,
    private heightValue: number
  ) {}

  get width(): number {
    return this.widthValue;
  }

  get height(): number {
    return this.heightValue;
  }

  get texture(): GPUTexture {
    if (!this.textureValue) {
      this.textureValue = this.allocate();
    }
    return this.textureValue;
  }

  createView(descriptor?: GPUTextureViewDescriptor): GPUTextureView {
    return createNativeTextureView(this.texture, descriptor);
  }

  resize(width: number, height: number): void {
    if (width === this.widthValue && height === this.heightValue) return;
    this.widthValue = width;
    this.heightValue = height;
    if (this.textureValue) {
      this.textureValue.destroy();
      this.textureValue = this.allocate();
    }
  }

  get gpu_memory_usage(): number {
    return this.widthValue * this.heightValue * 32;
  }

  destroy(): void {
    this.textureValue?.destroy();
    this.textureValue = null;
  }

  private allocate(): GPUTexture {
    return createNativeTexture(this.device, {
      label: this.label,
      size: [this.widthValue, this.heightValue, 1],
      dimension: "2d",
      format: this.format,
      mipLevelCount: 1,
      sampleCount: 1,
      usage: this.usage
    });
  }
}

export class LightProbeAtlas {
  readonly probe_resolution = LIGHT_PROBE_ATLAS_PROBE_RESOLUTION;
  readonly texture_radiance: LightProbeAtlasTexture;
  readonly texture_depth: LightProbeAtlasTexture;

  private readonly maximumDimension: number;
  private probeIndexOffset = 0;
  private randomState = 1337;
  private passes: LightProbeAtlasPasses | null = null;

  private readonly device: GPUDevice;

  constructor(private readonly graphics: GraphicsContext) {
    const device = graphics.device;
    this.device = device;
    this.maximumDimension = device.limits.maxTextureDimension2D;
    const initialHeight = this.padded_probe_resolution;
    this.texture_radiance = new LightProbeAtlasTexture(
      device,
      "Light Probe Atlas / radiance",
      LIGHT_PROBE_ATLAS_RADIANCE_FORMAT,
      GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.STORAGE_BINDING,
      this.maximumDimension,
      initialHeight
    );
    this.texture_depth = new LightProbeAtlasTexture(
      device,
      "Light Probe Atlas / depth",
      LIGHT_PROBE_ATLAS_DEPTH_FORMAT,
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      this.maximumDimension,
      initialHeight
    );
  }

  get padded_probe_resolution(): number {
    return this.probe_resolution + 2;
  }

  get resolution(): readonly [number, number] {
    const padded = this.padded_probe_resolution;
    return [
      Math.floor(this.texture_radiance.width / padded),
      Math.floor(this.texture_radiance.height / padded)
    ];
  }

  ensure_capacity(probeCount: number): void {
    const width = this.texture_radiance.width;
    const padded = this.padded_probe_resolution;
    const patchesPerRow = Math.floor(width / padded);
    const currentCapacity =
      patchesPerRow * Math.floor(this.texture_radiance.height / padded);
    if (currentCapacity >= probeCount) return;

    let height = Math.ceil(probeCount / patchesPerRow) * padded;
    if (height > this.maximumDimension) {
      console.warn(`Can't increase atlas size beyond ${this.maximumDimension}`);
      height = this.maximumDimension;
    }
    this.texture_radiance.resize(width, height);
    this.texture_depth.resize(width, height);
  }

  upload_external(_input: Record<string, never>): never {
    throw new Error("Not implemented");
  }

  graph_update({
    graph,
    scene,
    graphics,
    command,
    update_ray_count = 4096
  }: LightProbeAtlasGraphUpdateOptions): ResourceId {
    const probeCount = scene.light_probe_volume.source.probe_count;
    this.ensure_capacity(probeCount);

    const graphicsDevice = graphics.device;
    if (graphicsDevice === null) {
      throw new Error(
        "LightProbeAtlas.graph_update: GraphicsContext has no device"
      );
    }

    const layout = computeLightProbeAtlasUpdateLayout(
      probeCount,
      update_ray_count,
      this.probe_resolution,
      graphicsDevice.limits.maxTextureDimension2D
    );

    const materials = graphics.materials_resident;
    materials.ensure_scene_materials(scene.scene);
    materials.update(command);
    const randomSeed = Math.round(this.random() * 0xffffffff) >>> 0;
    const splitSum = graphics.textures.obtain(
      STATIC_GRAPHICS_ENGINE_ASSETS.split_sum
    );
    const splitSumSampler = graphics.samplers.obtain(
      LINEAR_CLAMP_SAMPLER_DESCRIPTOR
    );

    const sceneDatabase = scene.scene_database_buffer;
    if (sceneDatabase === null) {
      throw new Error(
        "LightProbeAtlas.graph_update: scene_database_buffer is unavailable; build the GPU scene first"
      );
    }
    const geometryMetadata = scene.meshlets.meshMetaBuffer;
    if (geometryMetadata === null) {
      throw new Error(
        "LightProbeAtlas.graph_update: geometry metadata is unavailable; update the meshlet table first"
      );
    }

    const probeVolume = scene.light_probe_volume;
    const passes = this.obtainPasses();
    const offset = this.probeIndexOffset;
    const imports = {
      materials: importResource(graph, "LPV/materials", materials.buffer_materials),
      materialTextures: importResource(graph, "LPV/material textures", materials.textureView),
      environment: importResource(graph, "LPV/environment", scene.lights.environment.obtainView()),
      sceneDatabase: importResource(graph, "LPV/scene database", sceneDatabase),
      tlas: importResource(graph, "LPV/TLAS", scene.tlas.buffer),
      blasAddresses: importResource(graph, "LPV/BLAS addresses", scene.meshlets.blas.buffer_metadata),
      blasNodes: importResource(graph, "LPV/BLAS nodes", scene.meshlets.blas.buffer_data),
      geometries: importResource(graph, "LPV/geometries", geometryMetadata),
      meshletHeaders: importResource(graph, "LPV/meshlet headers", scene.meshlets.headerBuffer),
      meshletData: importResource(graph, "LPV/meshlet data", scene.meshlets.dataBuffer),
      probes: importResource(graph, "LPV/probes", probeVolume.buffer_probes),
      lights: importResource(graph, "LPV/lights", scene.lights.buffer_data),
      splitSum: importResource(graph, "LPV/split sum", splitSum.obtainView()),
      atlasRadiance: importResource(graph, "LPV/radiance atlas", this.texture_radiance.texture),
      atlasDepth: importResource(graph, "LPV/depth atlas", this.texture_depth.texture),
      meshBvh: importResource(graph, "LPV/tetra BVH", probeVolume.buffer_mesh_bvh),
      metadata: importResource(graph, "LPV/metadata", probeVolume.buffer_metadata),
      tetrahedra: importResource(graph, "LPV/tetrahedra", probeVolume.buffer_mesh)
    };

    const gbuffer = {
      albedo: -1,
      emissive: -1,
      normals: -1,
      pbr: -1,
      position: -1
    };
    const gbufferBuilder = graph.add(
      "LPV/vM probe GBuffer",
      imports,
      (data, resources, context) => {
        passes.gbuffer.encode(
          asShadeCommand(context.encoder),
          {
            probe_index_offset: offset,
            probe_update_count: layout.actual_update_count,
            probe_count: probeCount,
            probe_resolution: this.probe_resolution,
            output_resolution_width: layout.probes_per_row,
            random_seed: randomSeed
          },
          {
            materials: asBuffer(resources.get(data.materials)),
            materialTextures: asTextureView(resources.get(data.materialTextures)),
            environment: asTextureView(resources.get(data.environment)),
            sceneDatabase: asBuffer(resources.get(data.sceneDatabase)),
            tlas: asBuffer(resources.get(data.tlas)),
            blasAddresses: asBuffer(resources.get(data.blasAddresses)),
            blasNodes: asBuffer(resources.get(data.blasNodes)),
            geometries: asBuffer(resources.get(data.geometries)),
            meshletHeaders: asBuffer(resources.get(data.meshletHeaders)),
            meshletData: asBuffer(resources.get(data.meshletData)),
            probes: asBuffer(resources.get(data.probes))
          },
          resolveGBuffer(resources, gbuffer, layout.output_width, layout.output_height)
        );
      }
    );
    gbuffer.albedo = createProbeTexture(gbufferBuilder, "LPV/vM albedo", layout, "rgba8unorm");
    gbuffer.emissive = createProbeTexture(gbufferBuilder, "LPV/vM emissive", layout, "r32uint");
    gbuffer.normals = createProbeTexture(gbufferBuilder, "LPV/vM normals", layout, "rg8unorm");
    gbuffer.pbr = createProbeTexture(gbufferBuilder, "LPV/vM pbr", layout, "rgba8unorm");
    gbuffer.position = createProbeTexture(gbufferBuilder, "LPV/vM position", layout, "rgba16float");
    readKeys(gbufferBuilder, imports, [
      "materials", "materialTextures", "environment", "sceneDatabase",
      "tlas", "blasAddresses", "blasNodes", "geometries",
      "meshletHeaders", "meshletData", "probes"
    ]);

    let indirect = -1;
    const indirectBuilder = graph.add(
      "LPV/aM indirect",
      { ...imports, ...gbuffer },
      (data, resources, context) => {
        passes.indirect.encode(
          asShadeCommand(context.encoder),
          {
            probe_resolution: this.probe_resolution,
            output_resolution_width: layout.probes_per_row,
            probe_index_offset: offset,
            probe_update_count: layout.actual_update_count,
            probe_count: probeCount
          },
          resolveGBuffer(resources, data, layout.output_width, layout.output_height),
          {
            splitSumSampler,
            splitSum: asTextureView(resources.get(data.splitSum)),
            atlasRadiance: asTextureView(resources.get(data.atlasRadiance)),
            atlasDepth: asTextureView(resources.get(data.atlasDepth)),
            meshBvh: asBuffer(resources.get(data.meshBvh)),
            metadata: asBuffer(resources.get(data.metadata)),
            tetrahedra: asBuffer(resources.get(data.tetrahedra)),
            probes: asBuffer(resources.get(data.probes))
          },
          asTexture(resources.get(indirect))
        );
      }
    );
    indirect = createProbeTexture(indirectBuilder, "LPV/aM indirect", layout, "r32uint");
    readKeys(indirectBuilder, imports, [
      "splitSum", "atlasRadiance", "atlasDepth", "meshBvh", "metadata",
      "tetrahedra", "probes"
    ]);
    readAll(indirectBuilder, gbuffer);

    const radianceBuilder = graph.add(
      "LPV/eM radiance accumulate",
      { ...imports, ...gbuffer, indirect },
      (data, resources, context) => {
        passes.radiance.encode(
          asShadeCommand(context.encoder),
          {
            probe_index_offset: offset,
            probe_update_count: layout.actual_update_count,
            probe_resolution: this.probe_resolution,
            atlas_resolution: this.resolution,
            probe_count: probeCount,
            random_seed: randomSeed
          },
          resolveGBuffer(resources, data, layout.output_width, layout.output_height),
          {
            probes: asBuffer(resources.get(data.probes)),
            lights: asBuffer(resources.get(data.lights)),
            indirect: asTexture(resources.get(data.indirect)),
            sceneDatabase: asBuffer(resources.get(data.sceneDatabase)),
            tlas: asBuffer(resources.get(data.tlas)),
            blasAddresses: asBuffer(resources.get(data.blasAddresses)),
            blasNodes: asBuffer(resources.get(data.blasNodes)),
            geometries: asBuffer(resources.get(data.geometries)),
            meshletHeaders: asBuffer(resources.get(data.meshletHeaders)),
            meshletData: asBuffer(resources.get(data.meshletData)),
            atlasRadiance: asTexture(resources.get(data.atlasRadiance))
          }
        );
      }
    );
    readAll(radianceBuilder, gbuffer);
    radianceBuilder.read(indirect);
    for (const key of [
      "probes", "lights", "sceneDatabase", "tlas", "blasAddresses",
      "blasNodes", "geometries", "meshletHeaders", "meshletData"
    ] as const) radianceBuilder.read(imports[key]);
    radianceBuilder.write(imports.atlasRadiance);

    if (layout.actual_update_count > 0) {
      const atlasSettings = {
        probe_resolution: this.probe_resolution,
        probe_update_count: layout.actual_update_count,
        probe_index_offset: offset,
        probe_count: probeCount,
        atlas_patches_per_row: this.resolution[0]
      };
      const depthBuilder = graph.add(
        "LPV/dM fM depth moments",
        { ...imports, ...gbuffer },
        (data, resources, context) => {
          passes.depth.encode(
            asShadeCommand(context.encoder),
            atlasSettings,
            resolveGBuffer(resources, data, layout.output_width, layout.output_height),
            {
              probes: asBuffer(resources.get(data.probes)),
              depthAtlas: asTexture(resources.get(data.atlasDepth))
            }
          );
        }
      );
      readAll(depthBuilder, gbuffer);
      depthBuilder.read(imports.probes);
      depthBuilder.write(imports.atlasDepth);

      const borderBuilder = graph.add(
        "LPV/bF BF zF atlas borders",
        imports,
        (data, resources, context) => {
          passes.border.encode(asShadeCommand(context.encoder), atlasSettings, {
            depthAtlas: asTexture(resources.get(data.atlasDepth)),
            radianceAtlas: asTexture(resources.get(data.atlasRadiance))
          });
        }
      );
      borderBuilder.write(imports.atlasDepth);
      borderBuilder.write(imports.atlasRadiance);

      const shSettings = {
        probe_index_offset: offset,
        probe_update_count: layout.actual_update_count,
        probe_resolution: this.probe_resolution,
        probe_count: probeCount,
        probes_per_row: layout.probes_per_row
      };
      const projectData = {
        atlasRadiance: imports.atlasRadiance,
        coefficients: -1
      };
      const projectBuilder = graph.add(
        "LPV/qF SH project",
        projectData,
        (data, resources, context) => {
          passes.shProject.encode(
            asShadeCommand(context.encoder),
            shSettings,
            asTexture(resources.get(data.atlasRadiance)),
            asBuffer(resources.get(data.coefficients)),
            layout.output_width,
            layout.output_height
          );
        }
      );
      projectData.coefficients = projectBuilder.create("LPV/qF SH coefficients", {
        kind: "transient_buffer",
        label: "sh",
        size: probeShProjectBufferBytes(
          layout.actual_update_count,
          this.probe_resolution
        ),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      });
      projectBuilder.read(imports.atlasRadiance);

      const reduceInput = projectData.coefficients;
      const reduceBuilder = graph.add(
        "LPV/KF SH reduce",
        { coefficients: reduceInput },
        (data, resources, context) => {
          passes.shReduce.encode(
            asShadeCommand(context.encoder),
            shSettings,
            asBuffer(resources.get(data.coefficients)),
            layout.output_width,
            layout.output_height
          );
        }
      );
      const sh = reduceBuilder.write(reduceInput);

      const commitBuilder = graph.add(
        "LPV/jF SH commit",
        { coefficients: sh, probes: imports.probes },
        (data, resources, context) => {
          passes.shCommit.encode(
            asShadeCommand(context.encoder),
            {
              probe_index_offset: offset,
              probe_update_count: layout.actual_update_count,
              probe_resolution: this.probe_resolution,
              probe_count: probeCount
            },
            asBuffer(resources.get(data.coefficients)),
            asBuffer(resources.get(data.probes))
          );
        }
      );
      commitBuilder.read(sh);
      commitBuilder.write(imports.probes);
    }

    if (probeCount > 0) {
      this.probeIndexOffset =
        (this.probeIndexOffset + layout.requested_update_count) % probeCount;
    }
    return imports.atlasRadiance;
  }

  get gpu_memory_usage(): number {
    return (
      this.texture_radiance.gpu_memory_usage +
      this.texture_depth.gpu_memory_usage
    );
  }

  destroy(): void {
    this.texture_depth.destroy();
    this.texture_radiance.destroy();
  }

  private random(): number {
    this.randomState += 1831565813;
    let value = this.randomState;
    value = Math.imul(value ^ (value >>> 15), 1 | value);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  private obtainPasses(): LightProbeAtlasPasses {
    if (this.passes !== null) return this.passes;
    this.passes = {
      gbuffer: new LightProbeGBufferPass(this.graphics),
      indirect: new LightProbeIndirectPass(this.graphics),
      radiance: new LightProbeRadianceAccumulatePass(this.graphics),
      depth: new LightProbeDepthUpdatePass(this.graphics),
      border: new LightProbeAtlasBorderUpdatePass(this.graphics),
      shProject: new LightProbeShProjectPass(this.graphics),
      shReduce: new LightProbeShReducePass(this.graphics),
      shCommit: new LightProbeShCommitPass(this.graphics)
    };
    return this.passes;
  }
}
