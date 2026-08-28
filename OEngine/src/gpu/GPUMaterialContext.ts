/**
 * GPUMaterialContext：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { ShadeMaterial } from "../material/ShadeMaterial.js";
import { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { ShadeTexture } from "../texture/ShadeTexture.js";
import { TextureFilterType } from "../texture/TextureFilterType.js";
import {
  LIGHTING_CH_VERTEX_WGSL
} from "../shaders/lighting_ch_oracle.js";
import {
  MATERIAL_DEPTH_FRAGMENT_WGSL
} from "../shaders/material_depth_oracle.js";
import {
  MATERIAL_EXPAND_FRAGMENT_WGSL,
  MATERIAL_EXPAND_VERTEX_WGSL
} from "../shaders/material_expand_oracle.js";
import {
  MATERIAL_META_STRIDE_BYTES,
  MaterialMetadataTable,
  packMaterialMeta,
  packMaterialMetaFromSource
} from "./MaterialMetadataTable.js";
import {
  BindGroupCache,
  RenderPipelineCache,
  type CachedRenderPipelineDescriptor
} from "./GPUDescriptorCaches.js";
import { GPUTextureContext } from "./GPUTextureContext.js";
import { GPUTextureManager } from "./GPUTextureManager.js";
import { DEFAULT_MATERIAL_SAMPLER_DESCRIPTOR } from "./GPUSamplerCache.js";
import {
  DEFAULT_MATERIAL_BLACK_TEXTURE,
  DEFAULT_MATERIAL_NORMAL_TEXTURE,
  DEFAULT_MATERIAL_WHITE_TEXTURE
} from "./GPUDefaultMaterialTextures.js";

export type GPUMaterialTextureBinding = {
  texture: GPUTextureContext;
  sampler: GPUSampler;
};

export type GPUMaterialBindingData = {
  material_info: { buffer: GPUBuffer };
  texture_diffuse: GPUTextureView;
  texture_diffuse_sampler: GPUSampler;
  texture_normal: GPUTextureView;
  texture_normal_sampler: GPUSampler;
  texture_orm: GPUTextureView;
  texture_orm_sampler: GPUSampler;
  texture_emissive: GPUTextureView;
  texture_emissive_sampler: GPUSampler;
};

type DefaultMaterialResources = {
  texture: GPUTextureContext;
  texture_pixel_white: GPUTextureContext;
  texture_pixel_black: GPUTextureContext;
  texture_pixel_normal: GPUTextureContext;
  texture_orm: GPUTextureContext;
  sampler: GPUSampler;
};

export class GPUMaterialContext {
  readonly uniform_buffer: GPUBuffer;
  readonly textures = new Map<ShadeTexture, GPUTextureContext>();
  pipeline: GPURenderPipeline | null = null;
  binding_data: GPUMaterialBindingData | null = null;

  constructor(
    private readonly device: GPUDevice,
    readonly source: StandardShadeMaterial,
    private readonly textureManager: GPUTextureManager,
    private readonly defaults: DefaultMaterialResources,
    private readonly bindGroups: BindGroupCache
  ) {
    this.uniform_buffer = device.createBuffer({
      label: "",
      usage: GPUBufferUsage.UNIFORM,
      size: MATERIAL_META_STRIDE_BYTES,
      mappedAtCreation: true
    });
    const packed = packMaterialMeta(packMaterialMetaFromSource(source));
    new Uint8Array(this.uniform_buffer.getMappedRange()).set(
      new Uint8Array(packed)
    );
    this.uniform_buffer.unmap();
    for (const texture of source.textures) {
      try {
        this.textures.set(texture, textureManager.obtain(texture));
      } catch {
        // Invalid/unresident material textures use the typed fallback below.
      }
    }
  }

  get is_built(): boolean {
    return this.pipeline !== null;
  }

  build(pipeline: GPURenderPipeline): void {
    this.pipeline = pipeline;
    this.obtainMaterialExpandBindGroup();
  }

  obtainBindingData(): GPUMaterialBindingData {
    if (this.binding_data !== null) return this.binding_data;
    const albedo = this.obtainTextureBinding(
      this.source.texture_albedo,
      this.defaults.texture_pixel_white
    );
    const normal = this.obtainTextureBinding(
      this.source.texture_normal,
      this.defaults.texture_pixel_normal
    );
    const orm = this.obtainTextureBinding(
      this.source.texture_orm,
      this.defaults.texture_orm
    );
    const emissive = this.obtainTextureBinding(
      this.source.texture_emissive,
      this.defaults.texture_pixel_white
    );
    this.binding_data = {
      material_info: { buffer: this.uniform_buffer },
      texture_diffuse: albedo.texture.obtainView(),
      texture_diffuse_sampler: albedo.sampler,
      texture_normal: normal.texture.obtainView(),
      texture_normal_sampler: normal.sampler,
      texture_orm: orm.texture.obtainView(),
      texture_orm_sampler: orm.sampler,
      texture_emissive: emissive.texture.obtainView(),
      texture_emissive_sampler: emissive.sampler
    };
    return this.binding_data;
  }

  obtainMaterialExpandBindGroup(_pipeline?: GPURenderPipeline): GPUBindGroup {
    const data = this.obtainBindingData();
    return this.bindGroups.obtain({
      layout: MATERIAL_EXPAND_GROUP0,
      entries: [
        { buffer: this.uniform_buffer },
        data.texture_diffuse,
        data.texture_diffuse_sampler,
        data.texture_normal,
        data.texture_normal_sampler,
        data.texture_orm,
        data.texture_orm_sampler,
        data.texture_emissive,
        data.texture_emissive_sampler
      ]
    });
  }

  destroy(): void {
    this.uniform_buffer.destroy();
    this.binding_data = null;
    this.textures.clear();
  }

  private obtainTextureBinding(
    source: ShadeTexture | undefined,
    fallback: GPUTextureContext
  ): GPUMaterialTextureBinding {
    if (source === undefined) {
      return { texture: fallback, sampler: this.defaults.sampler };
    }
    let texture = this.textures.get(source);
    if (texture === undefined) {
      try {
        texture = this.textureManager.obtain(source);
        this.textures.set(source, texture);
      } catch {
        return { texture: fallback, sampler: this.defaults.sampler };
      }
    }
    return {
      texture,
      sampler: this.device.createSampler(materialSamplerDescriptor(source))
    };
  }
}

export const MATERIAL_DEPTH_MESH_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    {
      binding: 0,
      visibility: 2,
      texture: { sampleType: "uint" }
    }
  ]
};

export const MATERIAL_DEPTH_SCENE_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    {
      binding: 0,
      visibility: 2,
      buffer: { type: "read-only-storage" }
    }
  ]
};

const MATERIAL_DEPTH_PIPELINE_DESCRIPTOR: CachedRenderPipelineDescriptor = {
  label: "",
  layout: {
    label: "",
    bindGroupLayouts: [
      MATERIAL_DEPTH_MESH_LAYOUT,
      MATERIAL_DEPTH_SCENE_LAYOUT
    ]
  },
  vertex: {
    module: { label: "", code: LIGHTING_CH_VERTEX_WGSL },
    buffers: []
  },
  fragment: {
    module: { label: "", code: MATERIAL_DEPTH_FRAGMENT_WGSL },
    targets: []
  },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: true,
    depthCompare: "always",
    stencilReadMask: 0,
    stencilWriteMask: 0
  },
  primitive: {
    topology: "triangle-list",
    cullMode: "none"
  },
  multisample: {}
};

export const MATERIAL_EXPAND_GROUP0: GPUBindGroupLayoutDescriptor = {
  label: "Material",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" }
    },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } }
  ]
};

export const MATERIAL_EXPAND_GROUP1: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
  ]
};

export const MATERIAL_EXPAND_GROUP2: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [0, 1, 2, 3].map((binding) => ({
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    buffer: { type: "read-only-storage" as GPUBufferBindingType }
  }))
};

const MATERIAL_EXPAND_PIPELINE_DESCRIPTOR: CachedRenderPipelineDescriptor = {
  label: "",
  layout: {
    label: "",
    bindGroupLayouts: [
      MATERIAL_EXPAND_GROUP0,
      MATERIAL_EXPAND_GROUP1,
      MATERIAL_EXPAND_GROUP2
    ]
  },
  vertex: {
    module: { label: "", code: MATERIAL_EXPAND_VERTEX_WGSL },
    buffers: []
  },
  fragment: {
    module: { label: "", code: MATERIAL_EXPAND_FRAGMENT_WGSL },
    targets: [
      { format: "rg8unorm" },
      { format: "rgba16uint" },
      { format: "rgba8unorm" },
      { format: "r32uint" }
    ]
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: false,
    depthCompare: "equal"
  },
  multisample: {}
};

export class GPUMaterialRegistry {
  readonly contexts = new Map<ShadeMaterial, GPUMaterialContext>();
  readonly metadata_table: MaterialMetadataTable;
  readonly material_depth_pipeline: GPURenderPipeline;
  private readonly defaults: DefaultMaterialResources;
  private materialExpandPipeline: GPURenderPipeline | null = null;
  private versionValue = 0;

  constructor(
    private readonly device: GPUDevice,
    private readonly textures: GPUTextureManager,
    private readonly renderPipelines: RenderPipelineCache,
    private readonly bindGroups: BindGroupCache
  ) {
    this.metadata_table = new MaterialMetadataTable(
      device,
      4096
    );
    this.material_depth_pipeline = this.renderPipelines.obtain(
      MATERIAL_DEPTH_PIPELINE_DESCRIPTOR
    );
    const texture = textures.contextFromDescriptor({
      label: "",
      size: [1, 1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING
    });
    const texturePixelWhite = textures.obtain(DEFAULT_MATERIAL_WHITE_TEXTURE);
    this.defaults = Object.freeze({
      texture,
      texture_pixel_white: texturePixelWhite,
      texture_pixel_black: textures.obtain(DEFAULT_MATERIAL_BLACK_TEXTURE),
      texture_pixel_normal: textures.obtain(DEFAULT_MATERIAL_NORMAL_TEXTURE),
      texture_orm: textures.obtain(DEFAULT_MATERIAL_WHITE_TEXTURE),
      sampler: device.createSampler(DEFAULT_MATERIAL_SAMPLER_DESCRIPTOR)
    });
  }

  get version(): number {
    return this.versionValue;
  }

  obtain(source: ShadeMaterial): GPUMaterialContext {
    let context = this.contexts.get(source);
    if (context !== undefined) return context;
    if (!(source instanceof StandardShadeMaterial)) {
      throw new Error("GPUMaterialRegistry only supports StandardShadeMaterial");
    }
    context = new GPUMaterialContext(
      this.device,
      source,
      this.textures,
      this.defaults,
      this.bindGroups
    );
    context.build(this.obtainMaterialExpandPipeline());
    this.contexts.set(source, context);
    this.metadata_table.obtain(source);
    this.versionValue++;
    return context;
  }

  update(command: ShadeGPUCommandContext): void {
    this.metadata_table.update(command, "GPUMaterialRegistry");
  }

  obtainMaterialDepthMeshBindGroup(meshView: GPUTextureView): GPUBindGroup {
    return this.bindGroups.obtain({
      layout: MATERIAL_DEPTH_MESH_LAYOUT,
      entries: [meshView]
    });
  }

  obtainMaterialDepthSceneBindGroup(sceneDatabase: GPUBuffer): GPUBindGroup {
    return this.bindGroups.obtain({
      layout: MATERIAL_DEPTH_SCENE_LAYOUT,
      entries: [{ buffer: sceneDatabase }]
    });
  }

  destroy(): void {
    for (const context of this.contexts.values()) context.destroy();
    this.contexts.clear();
    this.metadata_table.destroy();
    this.materialExpandPipeline = null;
  }

  private obtainMaterialExpandPipeline(): GPURenderPipeline {
    this.materialExpandPipeline ??= this.renderPipelines.obtain(
      MATERIAL_EXPAND_PIPELINE_DESCRIPTOR
    );
    return this.materialExpandPipeline;
  }
}

export function materialSamplerDescriptor(
  texture: ShadeTexture
): GPUSamplerDescriptor {
  const mipmapFilter = textureFilter(texture.mipmapFilter);
  const magFilter = textureFilter(texture.magFilter);
  const minFilter = textureFilter(texture.magFilter);
  const fullyLinear =
    mipmapFilter === "linear" &&
    magFilter === "linear" &&
    minFilter === "linear";
  return {
    addressModeU: textureWrap(texture.wrapS),
    addressModeV: textureWrap(texture.wrapT),
    magFilter,
    minFilter,
    mipmapFilter,
    maxAnisotropy: fullyLinear ? 16 : 1
  };
}

function textureFilter(value: number): GPUFilterMode {
  if (value === TextureFilterType.Linear) return "linear";
  if (value === TextureFilterType.Nearest) return "nearest";
  throw new Error(`Unsupported filtering type '${value}'`);
}

function textureWrap(value: number): GPUAddressMode {
  if (value === 1) return "repeat";
  if (value === 0) return "clamp-to-edge";
  if (value === 2) return "mirror-repeat";
  throw new Error(`Unsupported wrapping type '${value}'`);
}
