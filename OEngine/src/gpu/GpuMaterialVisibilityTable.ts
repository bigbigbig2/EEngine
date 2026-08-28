import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import type { CachedRenderPipelineDescriptor } from "./GPUDescriptorCaches.js";
import type { GPUTextureContext } from "./GPUTextureContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import {
  GPU_MATERIAL_VISIBILITY_ABI_VERSION,
  GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE,
  GPU_MATERIAL_VISIBILITY_RECORD_STRIDE,
  materialVisibilitySource,
  packGpuMaterialVisibilityRecord
} from "./GpuMaterialVisibilityAbi.js";

export const GPU_MATERIAL_VISIBILITY_CAPACITY = 4096;
export const GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE = 64;
export const GPU_MATERIAL_VISIBILITY_TEXTURE_TILES_PER_AXIS = 16;
export const GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY =
  GPU_MATERIAL_VISIBILITY_TEXTURE_TILES_PER_AXIS ** 2;
export const GPU_MATERIAL_VISIBILITY_TEXTURE_ATLAS_SIZE =
  GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE *
  GPU_MATERIAL_VISIBILITY_TEXTURE_TILES_PER_AXIS;

export interface GpuMaterialVisibilityBindings {
  readonly abiVersion: number;
  readonly materialCapacity: number;
  readonly textureCapacity: number;
  readonly materialRecords: GPUBuffer;
  readonly alphaAtlas: GPUTextureView;
}

export interface GpuMaterialVisibilityEvidence {
  readonly schemaVersion: 1;
  readonly abiVersion: number;
  readonly materialCapacity: number;
  readonly textureCapacity: number;
  readonly stagedMaterialCount: number;
  readonly residentTextureCount: number;
  readonly textureFallbackCount: number;
  readonly samplerFallbackCount: number;
  readonly allocatedBytes: number;
  readonly privateSubmitCount: 0;
  readonly takeoverTask: "R4-B-02";
}

interface TextureTile {
  readonly id: number;
  readonly source: ShadeTexture;
}

/**
 * Bounded R4-A owner for alpha classification only. R4-B-02 must replace this
 * table with the complete Material/Texture owner or preserve this mapping.
 */
export class GpuMaterialVisibilityTable {
  private readonly materialRecords: GPUBuffer;
  private readonly alphaAtlas: GPUTexture;
  private readonly alphaAtlasView: GPUTextureView;
  private readonly textures = new Map<ShadeTexture, TextureTile>();
  private readonly stagedMaterialIds = new Set<number>();
  private readonly textureFallbackMaterialIds = new Set<number>();
  private readonly samplerFallbackMaterialIds = new Set<number>();
  private resizePipeline: GPURenderPipeline | null = null;

  constructor(private readonly graphics: GraphicsContext) {
    const device = graphics.device;
    const materialBytes =
      GPU_MATERIAL_VISIBILITY_CAPACITY * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE;
    if (
      materialBytes > Number(device.limits.maxBufferSize) ||
      materialBytes > Number(device.limits.maxStorageBufferBindingSize)
    ) {
      throw new RangeError(
        `R4 Material Visibility table requires ${materialBytes} bytes but the device limit is smaller`
      );
    }
    this.materialRecords = device.createBuffer({
      label: "R4-A MaterialVisibilityRecord table",
      size: materialBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Uint8Array(this.materialRecords.getMappedRange()).fill(0);
    this.materialRecords.unmap();
    this.alphaAtlas = device.createTexture({
      label: "R4-A bounded base-color alpha atlas",
      size: [
        GPU_MATERIAL_VISIBILITY_TEXTURE_ATLAS_SIZE,
        GPU_MATERIAL_VISIBILITY_TEXTURE_ATLAS_SIZE,
        1
      ],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_DST
    });
    this.alphaAtlasView = this.alphaAtlas.createView();
  }

  stage(
    materials: readonly StandardShadeMaterial[],
    command: ShadeGPUCommandContext
  ): GpuMaterialVisibilityBindings {
    this.preflight(materials);
    const textureRefs = new Map<ShadeTexture, number>();
    const pendingTextures: ShadeTexture[] = [];
    const newTiles: TextureTile[] = [];
    const newlyStagedMaterialIds: number[] = [];
    const previousFallbacks: Array<readonly [number, boolean, boolean]> = [];
    command.onAborted.addOne(() => {
      for (let index = newTiles.length - 1; index >= 0; index--) {
        const tile = newTiles[index]!;
        if (this.textures.get(tile.source) === tile) this.textures.delete(tile.source);
      }
      for (const materialId of newlyStagedMaterialIds) {
        this.stagedMaterialIds.delete(materialId);
      }
      for (const [materialId, textureFallback, samplerFallback] of previousFallbacks) {
        writeSet(this.textureFallbackMaterialIds, materialId, textureFallback);
        writeSet(this.samplerFallbackMaterialIds, materialId, samplerFallback);
      }
    });
    for (const material of materials) {
      const texture = material.texture_albedo;
      if (texture === undefined) continue;
      const existing = this.textures.get(texture);
      if (existing !== undefined) {
        textureRefs.set(texture, existing.id);
        continue;
      }
      if (canStageTexture(texture)) pendingTextures.push(texture);
    }
    const uniquePending = [...new Set(pendingTextures)];
    const available = GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY - this.textures.size;
    const accepted = uniquePending.slice(0, Math.max(0, available));
    for (const texture of accepted) {
      try {
        this.graphics.textures.obtain(texture);
      } catch {
        continue;
      }
      const tile = Object.freeze({ id: this.textures.size, source: texture });
      this.textures.set(texture, tile);
      newTiles.push(tile);
      textureRefs.set(texture, tile.id);
    }
    this.graphics.textures.mipmaps.flush(command);
    for (const texture of accepted) {
      const tile = this.textures.get(texture);
      if (tile === undefined) continue;
      this.encodeResizeCopy(command, tile);
    }

    for (const material of materials) {
      const textureRef = material.texture_albedo === undefined
        ? GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE
        : textureRefs.get(material.texture_albedo) ??
          this.textures.get(material.texture_albedo)?.id ??
          GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE;
      const source = materialVisibilitySource(material, textureRef);
      previousFallbacks.push([
        material.id,
        this.textureFallbackMaterialIds.has(material.id),
        this.samplerFallbackMaterialIds.has(material.id)
      ]);
      const packed = packGpuMaterialVisibilityRecord(source.packed);
      command.writeBuffer(
        this.materialRecords,
        material.id * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE,
        packed,
        0,
        packed.byteLength
      );
      if (!this.stagedMaterialIds.has(material.id)) {
        newlyStagedMaterialIds.push(material.id);
        this.stagedMaterialIds.add(material.id);
      }
      writeSet(this.textureFallbackMaterialIds, material.id, source.textureFallback);
      writeSet(this.samplerFallbackMaterialIds, material.id, source.samplerFallback);
    }
    return this.bindings();
  }

  bindings(): GpuMaterialVisibilityBindings {
    return Object.freeze({
      abiVersion: GPU_MATERIAL_VISIBILITY_ABI_VERSION,
      materialCapacity: GPU_MATERIAL_VISIBILITY_CAPACITY,
      textureCapacity: GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY,
      materialRecords: this.materialRecords,
      alphaAtlas: this.alphaAtlasView
    });
  }

  evidence(): GpuMaterialVisibilityEvidence {
    return Object.freeze({
      schemaVersion: 1,
      abiVersion: GPU_MATERIAL_VISIBILITY_ABI_VERSION,
      materialCapacity: GPU_MATERIAL_VISIBILITY_CAPACITY,
      textureCapacity: GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY,
      stagedMaterialCount: this.stagedMaterialIds.size,
      residentTextureCount: this.textures.size,
      textureFallbackCount: this.textureFallbackMaterialIds.size,
      samplerFallbackCount: this.samplerFallbackMaterialIds.size,
      allocatedBytes:
        GPU_MATERIAL_VISIBILITY_CAPACITY * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE +
        GPU_MATERIAL_VISIBILITY_TEXTURE_ATLAS_SIZE ** 2 * 4,
      privateSubmitCount: 0,
      takeoverTask: "R4-B-02"
    });
  }

  destroy(): void {
    this.materialRecords.destroy();
    this.alphaAtlas.destroy();
    this.textures.clear();
    this.stagedMaterialIds.clear();
    this.textureFallbackMaterialIds.clear();
    this.samplerFallbackMaterialIds.clear();
    this.resizePipeline = null;
  }

  private preflight(materials: readonly StandardShadeMaterial[]): void {
    for (const material of materials) {
      if (material.id >= GPU_MATERIAL_VISIBILITY_CAPACITY) {
        throw new RangeError(
          `Material id ${material.id} exceeds R4-A visibility capacity ${GPU_MATERIAL_VISIBILITY_CAPACITY}`
        );
      }
    }
  }

  private encodeResizeCopy(
    command: ShadeGPUCommandContext,
    tile: TextureTile
  ): void {
    const source = this.graphics.textures.obtain(tile.source);
    const tileX = tile.id % GPU_MATERIAL_VISIBILITY_TEXTURE_TILES_PER_AXIS;
    const tileY = Math.floor(tile.id / GPU_MATERIAL_VISIBILITY_TEXTURE_TILES_PER_AXIS);
    const sourceMip = Math.max(0, Math.floor(Math.min(
      Math.log2(source.width / GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE),
      Math.log2(source.height / GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE)
    )));
    const sourceWidth = Math.max(1, source.width >> sourceMip);
    const sourceHeight = Math.max(1, source.height >> sourceMip);
    const clip = new Uint32Array([0, 0, sourceWidth, sourceHeight]);
    const clipBuffer = command.allocateTransientBufferAndLoad(
      clip.buffer,
      GPUBufferUsage.UNIFORM
    );
    const bindGroup = this.graphics.bind_groups.obtain({
      layout: RESIZE_COPY_GROUP_LAYOUT,
      entries: [
        source.obtainView({ baseMipLevel: sourceMip, mipLevelCount: 1 }),
        { buffer: clipBuffer }
      ]
    });
    const pass = command.beginRenderPass({
      label: "R4-A alpha atlas tile upload",
      colorAttachments: [{
        view: this.alphaAtlasView,
        loadOp: "load",
        storeOp: "store"
      }]
    });
    pass.setViewport(
      tileX * GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE,
      tileY * GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE,
      GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE,
      GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE,
      0,
      1
    );
    pass.setPipeline(this.obtainResizePipeline());
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  private obtainResizePipeline(): GPURenderPipeline {
    this.resizePipeline ??= this.graphics.render_pipelines.obtain(
      RESIZE_COPY_PIPELINE
    );
    return this.resizePipeline;
  }
}

const RESIZE_COPY_VERTEX_WGSL = /* wgsl */ `
const positions = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f(3.0, -1.0),
  vec2f(-1.0, 3.0)
);

struct Output {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn main(@builtin(vertex_index) vertex_index: u32) -> Output {
  let ndc = positions[vertex_index];
  return Output(vec4f(ndc, 0.0, 1.0), fma(ndc, vec2f(0.5, -0.5), vec2f(0.5)));
}
`;

const RESIZE_COPY_FRAGMENT_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> source_clip: vec4u;

@fragment
fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = max(source_clip.zw, vec2u(1u));
  let pixel = min(vec2u(uv * vec2f(size)), size - vec2u(1u));
  return textureLoad(source, vec2i(source_clip.xy + pixel), 0);
}
`;

const RESIZE_COPY_GROUP_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "R4-A alpha atlas resize group",
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
  label: "R4-A alpha atlas resize",
  layout: {
    label: "R4-A alpha atlas resize layout",
    bindGroupLayouts: [RESIZE_COPY_GROUP_LAYOUT]
  },
  vertex: {
    module: { label: "R4-A alpha atlas resize vertex", code: RESIZE_COPY_VERTEX_WGSL },
    entryPoint: "main",
    buffers: []
  },
  fragment: {
    module: { label: "R4-A alpha atlas resize fragment", code: RESIZE_COPY_FRAGMENT_WGSL },
    entryPoint: "main",
    targets: [{ format: "rgba8unorm" }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" },
  multisample: {}
};

function canStageTexture(texture: ShadeTexture): boolean {
  const image = texture.image;
  return image !== undefined && image.width > 0 && image.height > 0 && image.depth <= 1;
}

function writeSet(set: Set<number>, value: number, present: boolean): void {
  if (present) set.add(value);
  else set.delete(value);
}
