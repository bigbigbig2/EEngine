import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import { TextureFilterType } from "../texture/TextureFilterType.js";
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
export const GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE = 256;
export const GPU_MATERIAL_VISIBILITY_TEXTURE_TILES_PER_AXIS = 1;
export const GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY = 64;
export const GPU_MATERIAL_VISIBILITY_TEXTURE_ATLAS_SIZE =
  GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE;
export const GPU_MATERIAL_VISIBILITY_TEXTURE_MIP_COUNT = 9;

export interface GpuMaterialVisibilityBindings {
  readonly abiVersion: number;
  readonly materialCapacity: number;
  readonly textureCapacity: number;
  readonly materialRecords: GPUBuffer;
  readonly textureArray: GPUTextureView;
  /** R4-A compatibility name; alpha and shading now share textureArray. */
  readonly alphaAtlas: GPUTextureView;
}

export interface GpuMaterialVisibilityStage {
  readonly bindings: GpuMaterialVisibilityBindings;
  /** Dense resident slots aligned with the input material dictionary. */
  readonly materialSlots: readonly number[];
}

export interface GpuMaterialVisibilityEvidence {
  readonly schemaVersion: 3;
  readonly abiVersion: number;
  readonly materialCapacity: number;
  readonly textureCapacity: number;
  readonly residentMaterialSlotCount: number;
  readonly retiringMaterialSlotCount: number;
  readonly freeMaterialSlotCount: number;
  readonly residentTextureCount: number;
  readonly textureFallbackCount: number;
  readonly samplerFallbackCount: number;
  readonly allocatedBytes: number;
  readonly residentTextureBytes: number;
  readonly textureSize: number;
  readonly mipLevelCount: number;
  readonly privateSubmitCount: 0;
  readonly takeoverTask: null;
}

interface TextureTile {
  readonly id: number;
  readonly source: ShadeTexture;
}

interface ResidentMaterial {
  readonly slot: number;
  refCount: number;
  retireGeneration: number;
}

interface MaterialRetainOperation {
  readonly material: StandardShadeMaterial;
  readonly entry: ResidentMaterial;
  readonly created: boolean;
  readonly previousRetireGeneration: number;
}

/**
 * Single bounded R4-B Standard PBR material and texture residency owner.
 * Visibility alpha and Material Resolve consume the same stable TextureRef.
 */
export class GpuMaterialVisibilityTable {
  private readonly materialRecords: GPUBuffer;
  private readonly textureArray: GPUTexture;
  private readonly textureArrayView: GPUTextureView;
  private readonly textureDescriptor: GPUTextureDescriptor;
  private readonly textures = new Map<ShadeTexture, TextureTile>();
  private readonly residentMaterials = new Map<StandardShadeMaterial, ResidentMaterial>();
  private readonly freeMaterialSlots: number[] = [];
  private readonly textureFallbackMaterialIds = new Set<number>();
  private readonly samplerFallbackMaterialIds = new Set<number>();
  private resizePipeline: GPURenderPipeline | null = null;
  private destroyed = false;

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
      label: "R4-B Standard PBR MaterialRecord table",
      size: materialBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });
    new Uint8Array(this.materialRecords.getMappedRange()).fill(0);
    this.materialRecords.unmap();
    this.textureDescriptor = {
      label: "R4-B bounded Standard PBR texture array",
      size: [
        GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE,
        GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE,
        GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY
      ],
      format: "rgba8unorm",
      mipLevelCount: GPU_MATERIAL_VISIBILITY_TEXTURE_MIP_COUNT,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST
    };
    this.textureArray = device.createTexture(this.textureDescriptor);
    this.textureArrayView = this.textureArray.createView({ dimension: "2d-array" });
    for (let slot = GPU_MATERIAL_VISIBILITY_CAPACITY - 1; slot >= 0; slot--) {
      this.freeMaterialSlots.push(slot);
    }
  }

  stage(
    materials: readonly StandardShadeMaterial[],
    command: ShadeGPUCommandContext
  ): GpuMaterialVisibilityStage {
    this.preflight(materials);
    const retainOperations = this.retainMaterialSlots(materials);
    const materialSlots = retainOperations.map(({ entry }) => entry.slot);
    const textureRefs = new Map<ShadeTexture, number>();
    const pendingTextures: ShadeTexture[] = [];
    const newTiles: TextureTile[] = [];
    const previousFallbacks: Array<readonly [number, boolean, boolean]> = [];
    let rolledBack = false;
    const rollback = (): void => {
      if (rolledBack) return;
      rolledBack = true;
      for (let index = newTiles.length - 1; index >= 0; index--) {
        const tile = newTiles[index]!;
        if (this.textures.get(tile.source) === tile) this.textures.delete(tile.source);
      }
      for (let index = previousFallbacks.length - 1; index >= 0; index--) {
        const [materialId, textureFallback, samplerFallback] = previousFallbacks[index]!;
        writeSet(this.textureFallbackMaterialIds, materialId, textureFallback);
        writeSet(this.samplerFallbackMaterialIds, materialId, samplerFallback);
      }
      for (let index = retainOperations.length - 1; index >= 0; index--) {
        const operation = retainOperations[index]!;
        operation.entry.refCount--;
        operation.entry.retireGeneration = operation.previousRetireGeneration;
        if (operation.entry.refCount === 0 && operation.created) {
          if (this.residentMaterials.get(operation.material) === operation.entry) {
            this.residentMaterials.delete(operation.material);
          }
          this.freeMaterialSlots.push(operation.entry.slot);
        }
      }
    };
    command.onAborted.addOne(rollback);
    try {
      for (const material of materials) {
        for (const texture of material.textures) {
          const existing = this.textures.get(texture);
          if (existing !== undefined) {
            textureRefs.set(texture, existing.id);
            continue;
          }
          if (canStageTexture(texture)) pendingTextures.push(texture);
        }
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
      if (accepted.length > 0) {
        this.graphics.textures.mipmaps.generateMipmap(
          this.textureArray,
          this.textureDescriptor,
          TextureFilterType.Linear,
          command
        );
      }

      for (let materialIndex = 0; materialIndex < materials.length; materialIndex++) {
        const material = materials[materialIndex]!;
        const materialSlot = materialSlots[materialIndex]!;
        const textureRef = (texture: ShadeTexture | undefined): number =>
          texture === undefined
            ? GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE
            : textureRefs.get(texture) ?? this.textures.get(texture)?.id ??
              GPU_MATERIAL_VISIBILITY_INVALID_TEXTURE;
        const source = materialVisibilitySource(material, {
          baseColor: textureRef(material.texture_albedo),
          normal: textureRef(material.texture_normal),
          orm: textureRef(material.texture_orm),
          emissive: textureRef(material.texture_emissive)
        }, materialSlot);
        previousFallbacks.push([
          materialSlot,
          this.textureFallbackMaterialIds.has(materialSlot),
          this.samplerFallbackMaterialIds.has(materialSlot)
        ]);
        const packed = packGpuMaterialVisibilityRecord(source.packed);
        command.writeBuffer(
          this.materialRecords,
          materialSlot * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE,
          packed,
          0,
          packed.byteLength
        );
        writeSet(this.textureFallbackMaterialIds, materialSlot, source.textureFallback);
        writeSet(this.samplerFallbackMaterialIds, materialSlot, source.samplerFallback);
      }
      return Object.freeze({
        bindings: this.bindings(),
        materialSlots: Object.freeze(materialSlots)
      });
    } catch (error) {
      rollback();
      throw error;
    }
  }

  release(
    materials: readonly StandardShadeMaterial[],
    command: ShadeGPUCommandContext
  ): void {
    const releaseCounts = new Map<StandardShadeMaterial, number>();
    for (const material of materials) {
      releaseCounts.set(material, (releaseCounts.get(material) ?? 0) + 1);
    }
    for (const [material, count] of releaseCounts) {
      const entry = this.residentMaterials.get(material);
      if (entry === undefined || entry.refCount < count) {
        throw new Error(`Material '${material.name}' has no matching resident slot reference`);
      }
    }
    command.onFinished.addOne(() => {
      for (const [material, count] of releaseCounts) {
        const entry = this.residentMaterials.get(material);
        if (entry === undefined) continue;
        entry.refCount -= count;
        if (entry.refCount !== 0) continue;
        this.textureFallbackMaterialIds.delete(entry.slot);
        this.samplerFallbackMaterialIds.delete(entry.slot);
        const generation = ++entry.retireGeneration;
        const retire = (): void => this.retireMaterialSlot(material, entry, generation);
        void command.gpuDone.then(retire, retire);
      }
    });
  }

  bindings(): GpuMaterialVisibilityBindings {
    return Object.freeze({
      abiVersion: GPU_MATERIAL_VISIBILITY_ABI_VERSION,
      materialCapacity: GPU_MATERIAL_VISIBILITY_CAPACITY,
      textureCapacity: GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY,
      materialRecords: this.materialRecords,
      textureArray: this.textureArrayView,
      alphaAtlas: this.textureArrayView
    });
  }

  evidence(): GpuMaterialVisibilityEvidence {
    let residentMaterialSlotCount = 0;
    let retiringMaterialSlotCount = 0;
    for (const entry of this.residentMaterials.values()) {
      if (entry.refCount > 0) residentMaterialSlotCount++;
      else retiringMaterialSlotCount++;
    }
    return Object.freeze({
      schemaVersion: 3,
      abiVersion: GPU_MATERIAL_VISIBILITY_ABI_VERSION,
      materialCapacity: GPU_MATERIAL_VISIBILITY_CAPACITY,
      textureCapacity: GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY,
      residentMaterialSlotCount,
      retiringMaterialSlotCount,
      freeMaterialSlotCount: this.freeMaterialSlots.length,
      residentTextureCount: this.textures.size,
      textureFallbackCount: this.textureFallbackMaterialIds.size,
      samplerFallbackCount: this.samplerFallbackMaterialIds.size,
      allocatedBytes:
        GPU_MATERIAL_VISIBILITY_CAPACITY * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE +
        textureArrayBytes(),
      residentTextureBytes: textureArrayBytes(),
      textureSize: GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE,
      mipLevelCount: GPU_MATERIAL_VISIBILITY_TEXTURE_MIP_COUNT,
      privateSubmitCount: 0,
      takeoverTask: null
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.materialRecords.destroy();
    this.textureArray.destroy();
    this.textures.clear();
    this.residentMaterials.clear();
    this.freeMaterialSlots.length = 0;
    this.textureFallbackMaterialIds.clear();
    this.samplerFallbackMaterialIds.clear();
    this.resizePipeline = null;
  }

  private preflight(materials: readonly StandardShadeMaterial[]): void {
    const newMaterials = new Set<StandardShadeMaterial>();
    for (const material of materials) {
      if (material.base_color_uv_set !== 0 && material.base_color_uv_set !== 1) {
        throw new RangeError(
          `Material '${material.name}' requests TEXCOORD_${material.base_color_uv_set}; ` +
          "MaterialRecord v2 supports only TEXCOORD_0 and TEXCOORD_1"
        );
      }
      if (!this.residentMaterials.has(material)) newMaterials.add(material);
    }
    if (newMaterials.size > this.freeMaterialSlots.length) {
      throw new RangeError(
        `R4-B material residency requires ${newMaterials.size} new slots but only ` +
        `${this.freeMaterialSlots.length} of ${GPU_MATERIAL_VISIBILITY_CAPACITY} are free`
      );
    }
  }

  private retainMaterialSlots(
    materials: readonly StandardShadeMaterial[]
  ): MaterialRetainOperation[] {
    const operations: MaterialRetainOperation[] = [];
    for (const material of materials) {
      let entry = this.residentMaterials.get(material);
      let created = false;
      if (entry === undefined) {
        const slot = this.freeMaterialSlots.pop();
        if (slot === undefined) throw new RangeError("R4-B material resident slot overflow");
        entry = { slot, refCount: 0, retireGeneration: 0 };
        this.residentMaterials.set(material, entry);
        created = true;
      }
      const previousRetireGeneration = entry.retireGeneration;
      if (!created && entry.refCount === 0) {
        entry.retireGeneration++;
      }
      entry.refCount++;
      operations.push({ material, entry, created, previousRetireGeneration });
    }
    return operations;
  }

  private retireMaterialSlot(
    material: StandardShadeMaterial,
    entry: ResidentMaterial,
    generation: number
  ): void {
    if (this.destroyed || entry.refCount !== 0 || entry.retireGeneration !== generation) return;
    if (this.residentMaterials.get(material) !== entry) return;
    this.residentMaterials.delete(material);
    this.freeMaterialSlots.push(entry.slot);
  }

  private encodeResizeCopy(
    command: ShadeGPUCommandContext,
    tile: TextureTile
  ): void {
    const source = this.graphics.textures.obtain(tile.source);
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
      label: "R4-B texture array layer upload",
      colorAttachments: [{
        view: this.textureArray.createView({
          dimension: "2d",
          baseMipLevel: 0,
          mipLevelCount: 1,
          baseArrayLayer: tile.id,
          arrayLayerCount: 1
        }),
        loadOp: "load",
        storeOp: "store"
      }]
    });
    pass.setViewport(
      0,
      0,
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
  label: "R4-B texture array resize group",
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
  label: "R4-B texture array resize",
  layout: {
    label: "R4-B texture array resize layout",
    bindGroupLayouts: [RESIZE_COPY_GROUP_LAYOUT]
  },
  vertex: {
    module: { label: "R4-B texture array resize vertex", code: RESIZE_COPY_VERTEX_WGSL },
    entryPoint: "main",
    buffers: []
  },
  fragment: {
    module: { label: "R4-B texture array resize fragment", code: RESIZE_COPY_FRAGMENT_WGSL },
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

function textureArrayBytes(): number {
  let texels = 0;
  for (let mip = 0; mip < GPU_MATERIAL_VISIBILITY_TEXTURE_MIP_COUNT; mip++) {
    const size = Math.max(1, GPU_MATERIAL_VISIBILITY_TEXTURE_TILE_SIZE >> mip);
    texels += size * size;
  }
  return texels * GPU_MATERIAL_VISIBILITY_TEXTURE_CAPACITY * 4;
}
