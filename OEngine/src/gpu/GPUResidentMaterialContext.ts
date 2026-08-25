/**
 * GPUResidentMaterialContext：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import { HashMap } from "../core/HashMap.js";
import { Color } from "../core/Color.js";
import type { Scene } from "../scene/Scene.js";
import { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import type { ShadeMaterial } from "../material/ShadeMaterial.js";
import { ShadeTexture } from "../texture/ShadeTexture.js";
import { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { GPUTextureManager } from "./GPUTextureManager.js";
import { GPUTextureContext } from "./GPUTextureContext.js";
import type { CachedRenderPipelineDescriptor } from "./GPUDescriptorCaches.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import {
  DEFAULT_MATERIAL_NORMAL_TEXTURE,
  DEFAULT_MATERIAL_WHITE_TEXTURE
} from "./GPUDefaultMaterialTextures.js";

export const RESIDENT_MATERIAL_RECORD_BYTES = 64;
export const RESIDENT_TEXTURE_TILE_SIZE = 64;
export const RESIDENT_TEXTURE_ATLAS_SIZE = 2048;
export const RESIDENT_TEXTURE_TILES_PER_AXIS = 32;
export const RESIDENT_TEXTURE_TILES_PER_LAYER = 1024;

export const RESIDENT_MATERIAL_WORD_OFFSETS = Object.freeze({
  texture_albedo: 0,
  texture_orm: 1,
  texture_normal: 2,
  texture_emissive: 3,
  color_albedo: 4,
  roughness_factor: 8,
  metallic_factor: 9,
  transmission_factor: 10,
  ior_factor: 11,
  emissive_factor: 12
});

export type ResidentMaterialPackedSource = {
  texture_albedo: number;
  texture_orm: number;
  texture_normal: number;
  texture_emissive: number;
  color_albedo: Color;
  roughness_factor: number;
  metallic_factor: number;
  transmission_factor: number;
  ior_factor: number;
  emissive_factor: Color;
};

export type ResidentMaterialRecord = {
  id: number;
  source: StandardShadeMaterial;
  texture_albedo: ResidentTextureRecord;
  texture_orm: ResidentTextureRecord;
  texture_normal: ResidentTextureRecord;
  texture_emissive: ResidentTextureRecord;
};

export type ResidentTextureRecord = {
  id: number;
  source: ShadeTexture;
};

export type ResidentTextureTile = {
  layer: number;
  slot_x: number;
  slot_y: number;
  origin_x: number;
  origin_y: number;
};

export interface ResidentMaterialRegistryLike {
  readonly version: number;
  readonly contexts: Map<ShadeMaterial, unknown>;
}

const RESIZE_COPY_VERTEX_WGSL = /* wgsl */ `
const pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0)
);

struct FrameAllocatorNative {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn main(@builtin(vertex_index) vertex_index: u32) -> FrameAllocatorNative {
    var out: FrameAllocatorNative;
    let ndc = pos[vertex_index];
    out.pos = vec4<f32>(ndc, 0.0, 1.0);
    out.uv = fma(ndc, vec2<f32>(0.5, -0.5), vec2<f32>(0.5));
    return out;
}
`;

const RESIZE_COPY_FRAGMENT_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> source_clip: vec4<u32>;

@fragment
fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let source_size = textureDimensions(source);
    _ = source_size;
    let source_position = vec2<f32>(source_clip.xy) + uv * vec2<f32>(source_clip.zw);
    return textureLoad(source, vec2<u32>(source_position), 0);
}
`;

export function residentTextureTile(id: number): ResidentTextureTile {
  const layer = Math.floor(id / RESIDENT_TEXTURE_TILES_PER_LAYER);
  const inLayer = id % RESIDENT_TEXTURE_TILES_PER_LAYER;
  const slot_y = Math.floor(inLayer / RESIDENT_TEXTURE_TILES_PER_AXIS);
  const slot_x = inLayer % RESIDENT_TEXTURE_TILES_PER_AXIS;
  return {
    layer,
    slot_x,
    slot_y,
    origin_x: slot_x * RESIDENT_TEXTURE_TILE_SIZE,
    origin_y: slot_y * RESIDENT_TEXTURE_TILE_SIZE
  };
}

export function packResidentMaterial(
  source: ResidentMaterialPackedSource,
  target: ArrayBuffer = new ArrayBuffer(RESIDENT_MATERIAL_RECORD_BYTES),
  byteOffset = 0
): ArrayBuffer {
  if (byteOffset < 0 || byteOffset + RESIDENT_MATERIAL_RECORD_BYTES > target.byteLength) {
    throw new RangeError("resident material target is too small");
  }
  const words = new Uint32Array(target, byteOffset, RESIDENT_MATERIAL_RECORD_BYTES >>> 2);
  const floats = new Float32Array(target, byteOffset, RESIDENT_MATERIAL_RECORD_BYTES >>> 2);
  words[0] = source.texture_albedo >>> 0;
  words[1] = source.texture_orm >>> 0;
  words[2] = source.texture_normal >>> 0;
  words[3] = source.texture_emissive >>> 0;
  floats[4] = source.color_albedo.r;
  floats[5] = source.color_albedo.g;
  floats[6] = source.color_albedo.b;
  floats[7] = source.color_albedo.a;
  floats[8] = source.roughness_factor;
  floats[9] = source.metallic_factor;
  floats[10] = source.transmission_factor;
  floats[11] = source.ior_factor;
  floats[12] = source.emissive_factor.r;
  floats[13] = source.emissive_factor.g;
  floats[14] = source.emissive_factor.b;
  return target;
}

export class GPUResidentMaterialContext {
  private readonly materials = new HashMap<StandardShadeMaterial, ResidentMaterialRecord>();
  private readonly textures = new HashMap<ShadeTexture, ResidentTextureRecord>();
  private nextTextureId = 0;
  private residentVersion = 0;
  private uploadedResidentVersion = 0;
  private registryVersion = 0;
  private materialBuffer: GPUBuffer;
  private readonly textureAtlas: GPUTextureContext;
  private resizePipeline: GPURenderPipeline | null = null;
  private readonly graphics: GraphicsContext;
  private readonly registry: ResidentMaterialRegistryLike;
  private readonly textureManager: GPUTextureManager;

  readonly material_limit: number;

  constructor(
    private readonly device: GPUDevice,
    graphics: GraphicsContext
  ) {
    this.graphics = graphics;
    this.registry = graphics.materials;
    this.textureManager = graphics.textures;
    this.material_limit = Math.floor(
      device.limits.maxUniformBufferBindingSize / RESIDENT_MATERIAL_RECORD_BYTES
    );
    this.materialBuffer = this.createMaterialBuffer(false);
    this.textureAtlas = new GPUTextureContext(device);
    const descriptor = this.textureAtlas.descriptor;
    descriptor.label = "interpolate_attribute_vec3f";
    descriptor.format = "rgba8unorm";
    descriptor.dimension = "2d";
    descriptor.size = [
      RESIDENT_TEXTURE_ATLAS_SIZE,
      RESIDENT_TEXTURE_ATLAS_SIZE,
      1
    ];
    descriptor.mipLevelCount = 1;
    descriptor.usage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_DST;
  }

  get buffer_materials(): GPUBuffer {
    return this.materialBuffer;
  }

  get buffer_textures(): GPUTextureContext {
    return this.textureAtlas;
  }

  get textureView(): GPUTextureView {
    return this.textureAtlas.obtainView({ dimension: "2d-array" });
  }

  get texture_layer_count(): number {
    return this.textureAtlas.depth;
  }

  obtain_material(source: StandardShadeMaterial): ResidentMaterialRecord {
    return this.materials.getOrCompute(source, (material) => {
      const record: ResidentMaterialRecord = {
        id: material.id,
        source: material,
        texture_albedo: this.obtain_texture(
          material.texture_albedo ?? DEFAULT_MATERIAL_WHITE_TEXTURE
        ),
        texture_orm: this.obtain_texture(
          material.texture_orm ?? DEFAULT_MATERIAL_WHITE_TEXTURE
        ),
        texture_normal: this.obtain_texture(
          material.texture_normal ?? DEFAULT_MATERIAL_NORMAL_TEXTURE
        ),
        texture_emissive: this.obtain_texture(
          material.texture_emissive ?? DEFAULT_MATERIAL_WHITE_TEXTURE
        )
      };
      this.residentVersion++;
      return record;
    });
  }

  obtain_texture(source: ShadeTexture): ResidentTextureRecord {
    return this.textures.getOrCompute(source, (texture) => ({
      id: this.nextTextureId++,
      source: texture
    }));
  }

  ensure_scene_materials(scene: Scene): void {
    const instances = scene.instances.instances;
    for (let i = 0; i < instances.length; i++) {
      const material = instances[i]!.material;
      if (material === null) continue;
      if (!(material instanceof StandardShadeMaterial)) {
        throw new Error("GPUResidentMaterialContext only supports StandardShadeMaterial");
      }
      this.obtain_material(material);
    }
  }

  update(): void {
    this.syncRegistry();
    if (this.residentVersion === this.uploadedResidentVersion) return;
    this.uploadedResidentVersion = this.residentVersion;
    this.build_textures();
    this.build_materials();
  }

  build_materials(): void {
    const records = Array.from(this.materials.values());
    this.materialBuffer.destroy();
    this.materialBuffer = this.createMaterialBuffer(true);
    const mapped = this.materialBuffer.getMappedRange();
    if (records.length > this.material_limit) {
      console.warn(
        `Number of materials (=${records.length}) exceeds limit (=${this.material_limit}), some materials will not be pushed to the GPU`
      );
    }
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      const offset = record.id * RESIDENT_MATERIAL_RECORD_BYTES;
      if (offset >= mapped.byteLength) continue;
      packResidentMaterial(
        {
          texture_albedo: record.texture_albedo.id,
          texture_orm: record.texture_orm.id,
          texture_normal: record.texture_normal.id,
          texture_emissive: record.texture_emissive.id,
          color_albedo: record.source.diffuse_color,
          roughness_factor: record.source.roughness_factor,
          metallic_factor: record.source.metallic_factor,
          transmission_factor: record.source.transmission_factor,
          ior_factor: record.source.ior_factor,
          emissive_factor: record.source.emissive_factor
        },
        mapped,
        offset
      );
    }
    this.materialBuffer.unmap();
  }

  build_textures(): void {
    const records = Array.from(this.textures.values());
    const layerCount = Math.ceil(
      records.length / RESIDENT_TEXTURE_TILES_PER_LAYER
    );
    this.textureAtlas.resize(
      RESIDENT_TEXTURE_ATLAS_SIZE,
      RESIDENT_TEXTURE_ATLAS_SIZE,
      layerCount
    );

    const textureManager = this.textureManager;
    for (let index = 0; index < records.length; index++) {
      textureManager.obtain(records[index]!.source);
    }
    textureManager.mipmaps.flush();

    const command = ShadeGPUCommandContext.create(
      this.graphics,
      "GPUResidentMaterialContext/texture-write"
    );
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      const sourceTexture = record.source;
      const source = textureManager.obtain(sourceTexture);
      const tile = residentTextureTile(record.id);
      const square = source.width === source.height;
      const powerOfTwo = isPowerOfTwo(source.width) && isPowerOfTwo(source.height);
      const mipX = Math.log2(source.width / RESIDENT_TEXTURE_TILE_SIZE);
      const mipY = Math.log2(source.height / RESIDENT_TEXTURE_TILE_SIZE);
      const colorSpace = (
        sourceTexture.image as { color_space?: number } | undefined
      )?.color_space ?? 2;
      if (
        square &&
        powerOfTwo &&
        mipX >= 0 &&
        source.gpu_texture.mipLevelCount >= mipX &&
        colorSpace !== 1
      ) {
        command.copyTextureToTexture(
          { texture: source.gpu_texture, mipLevel: mipX },
          {
            texture: this.textureAtlas.gpu_texture,
            mipLevel: 0,
            origin: [tile.origin_x, tile.origin_y, tile.layer]
          },
          [RESIDENT_TEXTURE_TILE_SIZE, RESIDENT_TEXTURE_TILE_SIZE, 1]
        );
        continue;
      }
      const sourceMip = Math.max(0, Math.floor(Math.min(mipX, mipY)));
      this.encodeResizeCopy(command, source, sourceMip, tile);
    }
    command.finish();
  }

  destroy(): void {
    this.materialBuffer.destroy();
    this.textureAtlas.destroy();
  }

  private syncRegistry(): void {
    const registry = this.registry;
    if (registry === undefined || this.registryVersion === registry.version) return;
    const materials = Array.from(registry.contexts.keys());
    for (let i = 0; i < materials.length; i++) {
      const material = materials[i]!;
      if (material instanceof StandardShadeMaterial) {
        this.obtain_material(material);
      }
    }
    this.registryVersion = registry.version;
  }

  private createMaterialBuffer(mappedAtCreation: boolean): GPUBuffer {
    return this.device.createBuffer({
      label: "GPUResidentMaterialContext/materials",
      usage: GPUBufferUsage.UNIFORM,
      size: RESIDENT_MATERIAL_RECORD_BYTES * this.material_limit,
      mappedAtCreation
    });
  }

  private encodeResizeCopy(
    command: ShadeGPUCommandContext,
    source: GPUTextureContext,
    sourceMip: number,
    tile: ResidentTextureTile
  ): void {
    const pipeline = this.obtainResizePipeline();
    const sourceWidth = Math.max(1, source.width >> sourceMip);
    const sourceHeight = Math.max(1, source.height >> sourceMip);
    const clip = new Uint32Array([0, 0, sourceWidth, sourceHeight]);
    const clipBuffer = command.allocateTransientBufferAndLoad(
      clip.buffer,
      GPUBufferUsage.UNIFORM
    );
    const sourceView = source.obtainView({ baseMipLevel: sourceMip });
    const bindGroup = this.graphics.bind_groups.obtain({
      layout: RESIZE_COPY_GROUP_LAYOUT,
      entries: [sourceView, { buffer: clipBuffer }]
    });
    const pass = command.beginRenderPass({
      label: "",
      colorAttachments: [
        {
          view: this.textureAtlas.obtainView({
            dimension: "2d",
            baseArrayLayer: tile.layer
          }),
          loadOp: "load",
          storeOp: "store"
        }
      ]
    });
    pass.setViewport(
      tile.origin_x,
      tile.origin_y,
      RESIDENT_TEXTURE_TILE_SIZE,
      RESIDENT_TEXTURE_TILE_SIZE,
      0,
      0
    );
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  private obtainResizePipeline(): GPURenderPipeline {
    if (this.resizePipeline !== null) return this.resizePipeline;
    this.resizePipeline = this.graphics.render_pipelines.obtain(
      RESIZE_COPY_PIPELINE
    );
    return this.resizePipeline;
  }
}

const RESIZE_COPY_GROUP_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "unfilterable-float" }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" }
    }
  ]
};

const RESIZE_COPY_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "",
  layout: {
    label: "",
    bindGroupLayouts: [RESIZE_COPY_GROUP_LAYOUT]
  },
  vertex: {
    module: { label: "", code: RESIZE_COPY_VERTEX_WGSL },
    entryPoint: "main",
    buffers: []
  },
  fragment: {
    module: { label: "", code: RESIZE_COPY_FRAGMENT_WGSL },
    entryPoint: "main",
    targets: [{ format: "rgba8unorm" }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  multisample: {}
};

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}
