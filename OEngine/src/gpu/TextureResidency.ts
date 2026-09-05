import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import { TextureFilterType } from "../texture/TextureFilterType.js";
import type { CachedRenderPipelineDescriptor } from "./GPUDescriptorCaches.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import { GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_BIT } from "./GpuMaterialVisibilityAbi.js";
import {
  estimateTextureBytes,
  type ResourceHandle as AccountingResourceHandle
} from "../debug/profiling/ResourceAccounting.js";

export const TEXTURE_RESIDENCY_BASE_SIZE = 256;
export const TEXTURE_RESIDENCY_BASE_CAPACITY = 64;
export const TEXTURE_RESIDENCY_BASE_MIP_COUNT = 9;
export const TEXTURE_RESIDENCY_MAX_SIZE = 4096;

export interface TextureResidencyBindings {
  readonly textureCapacity: number;
  readonly textureArray: GPUTextureView;
  readonly highResolutionTextureArray: GPUTextureView;
  readonly alphaAtlas: GPUTextureView;
  readonly highResolutionAlphaAtlas: GPUTextureView;
}

export interface TextureResidencyStage {
  readonly bindings: TextureResidencyBindings;
  readonly textureRefs: ReadonlyMap<ShadeTexture, number>;
}

export interface TextureResidencyEvidence {
  readonly schemaVersion: 1;
  readonly textureCapacity: number;
  readonly residentTextureCount: number;
  readonly retiringTextureCount: number;
  readonly freeTextureLayerCount: number;
  readonly allocatedBytes: number;
  readonly residentTextureBytes: number;
  readonly textureSize: number;
  readonly mipLevelCount: number;
  readonly highResolutionTextureSize: number;
  readonly highResolutionTextureCapacity: number;
  readonly highResolutionMipLevelCount: number;
  readonly highResolutionArrayAllocated: boolean;
  readonly residentHighResolutionTextureCount: number;
  readonly retiringHighResolutionTextureCount: number;
  readonly freeHighResolutionTextureLayerCount: number;
  readonly privateSubmitCount: 0;
}

interface ResidentTexture {
  readonly layer: number;
  readonly highResolution: boolean;
  readonly source: ShadeTexture;
  refCount: number;
  retireGeneration: number;
}

interface ResidentMaterialTextures {
  refCount: number;
  retireGeneration: number;
  textures: ResidentTexture[];
}

interface TextureRetainOperation {
  readonly entry: ResidentTexture;
  readonly created: boolean;
  readonly previousRetireGeneration: number;
}

interface MaterialRetainOperation {
  readonly material: StandardShadeMaterial;
  readonly entry: ResidentMaterialTextures;
  readonly created: boolean;
  readonly previousRetireGeneration: number;
}

interface TextureTransition {
  readonly material: ResidentMaterialTextures;
  readonly previous: readonly ResidentTexture[];
  readonly added: readonly TextureRetainOperation[];
  readonly removed: readonly ResidentTexture[];
}

/**
 * Texture-only residency owner. It publishes stable TextureRef values but never
 * allocates material slots or writes MaterialRecord data.
 */
export class TextureResidency {
  private readonly baseDescriptor: GPUTextureDescriptor;
  private readonly baseTexture: GPUTexture;
  private readonly baseAccountingHandle: AccountingResourceHandle | undefined;
  private readonly baseView: GPUTextureView;
  private highDescriptor: GPUTextureDescriptor;
  private highTexture: GPUTexture | null = null;
  private highAccountingHandle: AccountingResourceHandle | null = null;
  private highView: GPUTextureView | null = null;
  private highSize = TEXTURE_RESIDENCY_MAX_SIZE;
  private highCapacity = 0;
  private highMipCount = 13;
  private readonly textures = new Map<ShadeTexture, ResidentTexture>();
  private readonly materials = new Map<StandardShadeMaterial, ResidentMaterialTextures>();
  private readonly freeBaseLayers: number[] = [];
  private readonly freeHighLayers: number[] = [];
  private resizePipeline: GPURenderPipeline | null = null;
  private destroyed = false;

  constructor(private readonly graphics: GraphicsContext) {
    this.baseDescriptor = {
      label: "TextureResidency/base-bank",
      size: [TEXTURE_RESIDENCY_BASE_SIZE, TEXTURE_RESIDENCY_BASE_SIZE, TEXTURE_RESIDENCY_BASE_CAPACITY],
      format: "rgba8unorm",
      mipLevelCount: TEXTURE_RESIDENCY_BASE_MIP_COUNT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
    };
    this.baseTexture = graphics.device.createTexture(this.baseDescriptor);
    this.baseAccountingHandle = graphics.resource_accounting?.created({
      kind: "texture",
      category: "resident",
      owner: "TextureResidency/base-bank",
      bytes: estimateTextureBytes({
        format: "rgba8unorm",
        width: TEXTURE_RESIDENCY_BASE_SIZE,
        height: TEXTURE_RESIDENCY_BASE_SIZE,
        depthOrArrayLayers: TEXTURE_RESIDENCY_BASE_CAPACITY,
        mipLevelCount: TEXTURE_RESIDENCY_BASE_MIP_COUNT
      }),
      label: this.baseDescriptor.label
    });
    this.baseView = this.baseTexture.createView({ dimension: "2d-array" });
    this.highDescriptor = {
      label: "TextureResidency/high-resolution-bank",
      size: [TEXTURE_RESIDENCY_MAX_SIZE, TEXTURE_RESIDENCY_MAX_SIZE, 1],
      format: "rgba8unorm",
      mipLevelCount: 13,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
    };
    for (let layer = TEXTURE_RESIDENCY_BASE_CAPACITY - 1; layer >= 1; layer--) {
      this.freeBaseLayers.push(layer);
    }
  }

  stage(
    materials: readonly StandardShadeMaterial[],
    command: ShadeGPUCommandContext
  ): TextureResidencyStage {
    this.preflight(materials);
    const materialOperations = this.retainMaterials(materials);
    const transitions: TextureTransition[] = [];
    const newTextures: ResidentTexture[] = [];
    let rolledBack = false;
    const rollback = (): void => {
      if (rolledBack) return;
      rolledBack = true;
      for (let index = transitions.length - 1; index >= 0; index--) {
        const transition = transitions[index]!;
        transition.material.textures = [...transition.previous];
        for (let add = transition.added.length - 1; add >= 0; add--) {
          this.rollbackTextureRetain(transition.added[add]!);
        }
      }
      for (let index = materialOperations.length - 1; index >= 0; index--) {
        const operation = materialOperations[index]!;
        operation.entry.refCount--;
        operation.entry.retireGeneration = operation.previousRetireGeneration;
        if (operation.created && operation.entry.refCount === 0 &&
            this.materials.get(operation.material) === operation.entry) {
          this.materials.delete(operation.material);
        }
      }
    };
    command.onAborted.addOne(rollback);
    try {
      const transitioned = new Set<ResidentMaterialTextures>();
      for (let index = 0; index < materials.length; index++) {
        const resident = materialOperations[index]!.entry;
        if (transitioned.has(resident)) continue;
        transitioned.add(resident);
        const transition = this.transition(resident, materials[index]!);
        transitions.push(transition);
        for (const operation of transition.added) {
          if (operation.created) newTextures.push(operation.entry);
        }
      }
      this.graphics.textures.mipmaps.flush(command);
      for (const texture of newTextures) this.encodeResizeCopy(command, texture);
      if (newTextures.some(({ highResolution }) => !highResolution)) {
        this.graphics.textures.mipmaps.generateMipmap(
          this.baseTexture, this.baseDescriptor, TextureFilterType.Linear, command
        );
      }
      if (newTextures.some(({ highResolution }) => highResolution)) {
        this.graphics.textures.mipmaps.generateMipmap(
          this.requireHighTexture(), this.highDescriptor, TextureFilterType.Linear, command
        );
      }
      command.onFinished.addOne(() => {
        for (const transition of transitions) {
          this.releaseTextureRefs(transition.removed, command.gpuDone);
        }
      });
      return Object.freeze({
        bindings: this.bindings(),
        textureRefs: this.textureRefs()
      });
    } catch (error) {
      rollback();
      throw error;
    }
  }

  release(materials: readonly StandardShadeMaterial[], command: ShadeGPUCommandContext): void {
    const counts = countMaterials(materials);
    for (const [material, count] of counts) {
      const entry = this.materials.get(material);
      if (entry === undefined || entry.refCount < count) {
        throw new Error(`TextureResidency has no matching material reference for '${material.name}'`);
      }
    }
    command.onFinished.addOne(() => {
      for (const [material, count] of counts) {
        const entry = this.materials.get(material);
        if (entry === undefined) continue;
        entry.refCount -= count;
        if (entry.refCount !== 0) continue;
        const generation = ++entry.retireGeneration;
        const textures = entry.textures;
        entry.textures = [];
        this.releaseTextureRefs(textures, command.gpuDone);
        const retire = (): void => {
          if (this.destroyed || entry.refCount !== 0 || entry.retireGeneration !== generation) return;
          if (this.materials.get(material) === entry) this.materials.delete(material);
        };
        void command.gpuDone.then(retire, retire);
      }
    });
  }

  bindings(): TextureResidencyBindings {
    return Object.freeze({
      textureCapacity: TEXTURE_RESIDENCY_BASE_CAPACITY,
      textureArray: this.baseView,
      highResolutionTextureArray: this.highView ?? this.baseView,
      alphaAtlas: this.baseView,
      highResolutionAlphaAtlas: this.highView ?? this.baseView
    });
  }

  evidence(): TextureResidencyEvidence {
    let residentTextureCount = 0;
    let retiringTextureCount = 0;
    let residentHighResolutionTextureCount = 0;
    let retiringHighResolutionTextureCount = 0;
    for (const entry of this.textures.values()) {
      if (entry.refCount > 0) {
        residentTextureCount++;
        if (entry.highResolution) residentHighResolutionTextureCount++;
      } else {
        retiringTextureCount++;
        if (entry.highResolution) retiringHighResolutionTextureCount++;
      }
    }
    const highBytes = this.highTexture === null
      ? 0
      : arrayBytes(this.highSize, this.highCapacity, this.highMipCount);
    return Object.freeze({
      schemaVersion: 1,
      textureCapacity: TEXTURE_RESIDENCY_BASE_CAPACITY,
      residentTextureCount,
      retiringTextureCount,
      freeTextureLayerCount: this.freeBaseLayers.length,
      allocatedBytes: arrayBytes(
        TEXTURE_RESIDENCY_BASE_SIZE,
        TEXTURE_RESIDENCY_BASE_CAPACITY,
        TEXTURE_RESIDENCY_BASE_MIP_COUNT
      ) + highBytes,
      residentTextureBytes: arrayBytes(
        TEXTURE_RESIDENCY_BASE_SIZE,
        TEXTURE_RESIDENCY_BASE_CAPACITY,
        TEXTURE_RESIDENCY_BASE_MIP_COUNT
      ) + highBytes,
      textureSize: TEXTURE_RESIDENCY_BASE_SIZE,
      mipLevelCount: TEXTURE_RESIDENCY_BASE_MIP_COUNT,
      highResolutionTextureSize: this.highSize,
      highResolutionTextureCapacity: this.highCapacity,
      highResolutionMipLevelCount: this.highMipCount,
      highResolutionArrayAllocated: this.highTexture !== null,
      residentHighResolutionTextureCount,
      retiringHighResolutionTextureCount,
      freeHighResolutionTextureLayerCount: this.freeHighLayers.length,
      privateSubmitCount: 0
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.baseTexture.destroy();
    if (this.baseAccountingHandle !== undefined) {
      this.graphics.resource_accounting?.destroyed(this.baseAccountingHandle);
    }
    this.highTexture?.destroy();
    if (this.highAccountingHandle !== null) {
      this.graphics.resource_accounting?.destroyed(this.highAccountingHandle);
      this.highAccountingHandle = null;
    }
    this.textures.clear();
    this.materials.clear();
    this.freeBaseLayers.length = 0;
    this.freeHighLayers.length = 0;
    this.resizePipeline = null;
  }

  private preflight(materials: readonly StandardShadeMaterial[]): void {
    const base = new Set<ShadeTexture>();
    const high = new Set<ShadeTexture>();
    for (const material of materials) {
      for (const texture of material.textures) {
        if (!canStageTexture(texture) || this.textures.has(texture)) continue;
        (requiresHighBank(texture) ? high : base).add(texture);
      }
    }
    if (base.size > this.freeBaseLayers.length) {
      throw new RangeError(
        `TextureResidency requires ${base.size} new base layers but only ` +
        `${this.freeBaseLayers.length} of ${TEXTURE_RESIDENCY_BASE_CAPACITY - 1} are free`
      );
    }
    if (high.size > 0) this.ensureHighBank(high);
    if (high.size > this.freeHighLayers.length) {
      throw new RangeError(
        `TextureResidency requires ${high.size} new high-resolution layers but only ` +
        `${this.freeHighLayers.length} of ${this.highCapacity - 1} are free`
      );
    }
  }

  private retainMaterials(materials: readonly StandardShadeMaterial[]): MaterialRetainOperation[] {
    const result: MaterialRetainOperation[] = [];
    for (const material of materials) {
      let entry = this.materials.get(material);
      let created = false;
      if (entry === undefined) {
        entry = { refCount: 0, retireGeneration: 0, textures: [] };
        this.materials.set(material, entry);
        created = true;
      }
      const previousRetireGeneration = entry.retireGeneration;
      if (!created && entry.refCount === 0) entry.retireGeneration++;
      entry.refCount++;
      result.push({ material, entry, created, previousRetireGeneration });
    }
    return result;
  }

  private transition(
    resident: ResidentMaterialTextures,
    material: StandardShadeMaterial
  ): TextureTransition {
    const desired = [...new Set(material.textures)];
    const previous = resident.textures;
    const previousSet = new Set(previous.map(({ source }) => source));
    const desiredSet = new Set(desired);
    const next: ResidentTexture[] = [];
    const added: TextureRetainOperation[] = [];
    for (const texture of desired) {
      const current = this.textures.get(texture);
      if (current !== undefined && previousSet.has(texture)) {
        next.push(current);
        continue;
      }
      const operation = this.retainTexture(texture);
      if (operation !== null) {
        next.push(operation.entry);
        added.push(operation);
      }
    }
    const removed = previous.filter(({ source }) => !desiredSet.has(source));
    resident.textures = next;
    return { material: resident, previous, added, removed };
  }

  private retainTexture(texture: ShadeTexture): TextureRetainOperation | null {
    if (!canStageTexture(texture)) return null;
    let entry = this.textures.get(texture);
    let created = false;
    if (entry === undefined) {
      try {
        this.graphics.textures.obtain(texture);
      } catch {
        return null;
      }
      const highResolution = requiresHighBank(texture);
      const layer = (highResolution ? this.freeHighLayers : this.freeBaseLayers).pop();
      if (layer === undefined) throw new RangeError("TextureResidency layer overflow");
      entry = { layer, highResolution, source: texture, refCount: 0, retireGeneration: 0 };
      this.textures.set(texture, entry);
      created = true;
    }
    const previousRetireGeneration = entry.retireGeneration;
    if (!created && entry.refCount === 0) entry.retireGeneration++;
    entry.refCount++;
    return { entry, created, previousRetireGeneration };
  }

  private rollbackTextureRetain(operation: TextureRetainOperation): void {
    const entry = operation.entry;
    entry.refCount--;
    entry.retireGeneration = operation.previousRetireGeneration;
    if (!operation.created || entry.refCount !== 0) return;
    if (this.textures.get(entry.source) === entry) this.textures.delete(entry.source);
    (entry.highResolution ? this.freeHighLayers : this.freeBaseLayers).push(entry.layer);
  }

  private releaseTextureRefs(textures: readonly ResidentTexture[], gpuDone: Promise<void>): void {
    for (const entry of textures) {
      entry.refCount--;
      if (entry.refCount < 0) throw new Error("TextureResidency refcount underflow");
      if (entry.refCount !== 0) continue;
      const generation = ++entry.retireGeneration;
      const retire = (): void => {
        if (this.destroyed || entry.refCount !== 0 || entry.retireGeneration !== generation) return;
        if (this.textures.get(entry.source) !== entry) return;
        this.textures.delete(entry.source);
        (entry.highResolution ? this.freeHighLayers : this.freeBaseLayers).push(entry.layer);
      };
      void gpuDone.then(retire, retire);
    }
  }

  private textureRefs(): ReadonlyMap<ShadeTexture, number> {
    const refs = new Map<ShadeTexture, number>();
    for (const entry of this.textures.values()) {
      if (entry.refCount <= 0) continue;
      refs.set(entry.source, entry.highResolution
        ? (entry.layer | GPU_MATERIAL_VISIBILITY_HIGH_RESOLUTION_BIT) >>> 0
        : entry.layer);
    }
    return refs;
  }

  private ensureHighBank(textures: ReadonlySet<ShadeTexture>): void {
    const requiredSize = highBankSize(textures);
    if (this.highTexture !== null) {
      if (requiredSize > this.highSize) {
        throw new RangeError(
          `TextureResidency bank is ${this.highSize}px but this transaction requires ${requiredSize}px`
        );
      }
      return;
    }
    // Exact transaction sizing replaces the old unconditional 16 × 4096² owner.
    const requiredCapacity = nextPowerOfTwo(textures.size + 1);
    const limits = this.graphics.device.limits;
    const budgetCapacity = Math.max(
      1,
      Math.floor(16 * (TEXTURE_RESIDENCY_MAX_SIZE / requiredSize) ** 2)
    );
    const capacity = Math.min(budgetCapacity, Number(limits.maxTextureArrayLayers));
    if (requiredSize > Number(limits.maxTextureDimension2D) || requiredCapacity > capacity) {
      throw new RangeError(
        `TextureResidency requires ${requiredSize}px × ${requiredCapacity} layers but ` +
        `the device/budget permits ${capacity}`
      );
    }
    this.highSize = requiredSize;
    this.highCapacity = requiredCapacity;
    this.highMipCount = Math.floor(Math.log2(requiredSize)) + 1;
    this.highDescriptor = {
      ...this.highDescriptor,
      size: [requiredSize, requiredSize, requiredCapacity],
      mipLevelCount: this.highMipCount
    };
    for (let layer = requiredCapacity - 1; layer >= 1; layer--) this.freeHighLayers.push(layer);
    this.highTexture = this.graphics.device.createTexture(this.highDescriptor);
    this.highAccountingHandle = this.graphics.resource_accounting?.created({
      kind: "texture",
      category: "resident",
      owner: "TextureResidency/high-resolution-bank",
      bytes: estimateTextureBytes({
        format: "rgba8unorm",
        width: requiredSize,
        height: requiredSize,
        depthOrArrayLayers: requiredCapacity,
        mipLevelCount: this.highMipCount
      }),
      label: this.highDescriptor.label
    });
    this.highView = this.highTexture.createView({ dimension: "2d-array" });
  }

  private encodeResizeCopy(command: ShadeGPUCommandContext, entry: ResidentTexture): void {
    const source = this.graphics.textures.obtain(entry.source);
    const targetSize = entry.highResolution ? this.highSize : TEXTURE_RESIDENCY_BASE_SIZE;
    const target = entry.highResolution ? this.requireHighTexture() : this.baseTexture;
    const sourceMip = Math.max(0, Math.floor(Math.min(
      Math.log2(source.width / targetSize), Math.log2(source.height / targetSize)
    )));
    const sourceWidth = Math.max(1, source.width >> sourceMip);
    const sourceHeight = Math.max(1, source.height >> sourceMip);
    const clip = new Uint32Array([0, 0, sourceWidth, sourceHeight]);
    const clipBuffer = command.allocateTransientBufferAndLoad(clip.buffer, GPUBufferUsage.UNIFORM);
    const bindGroup = this.graphics.bind_groups.obtain({
      layout: RESIZE_COPY_GROUP_LAYOUT,
      entries: [source.obtainView({ baseMipLevel: sourceMip, mipLevelCount: 1 }), { buffer: clipBuffer }]
    });
    const pass = command.beginRenderPass({
      label: "TextureResidency/upload-layer",
      colorAttachments: [{
        view: target.createView({
          dimension: "2d", baseMipLevel: 0, mipLevelCount: 1,
          baseArrayLayer: entry.layer, arrayLayerCount: 1
        }),
        loadOp: "load",
        storeOp: "store"
      }]
    });
    pass.setViewport(0, 0, targetSize, targetSize, 0, 1);
    pass.setPipeline(this.resizePipeline ??= this.graphics.render_pipelines.obtain(RESIZE_COPY_PIPELINE));
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  private requireHighTexture(): GPUTexture {
    if (this.highTexture === null) throw new Error("TextureResidency high bank was not preflighted");
    return this.highTexture;
  }
}

const RESIZE_COPY_VERTEX_WGSL = /* wgsl */ `
const positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
struct Output { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn main(@builtin(vertex_index) vertex_index: u32) -> Output {
  let ndc = positions[vertex_index];
  return Output(vec4f(ndc, 0.0, 1.0), fma(ndc, vec2f(0.5, -0.5), vec2f(0.5)));
}`;

const RESIZE_COPY_FRAGMENT_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> source_clip: vec4u;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = max(source_clip.zw, vec2u(1u));
  let pixel = min(vec2u(uv * vec2f(size)), size - vec2u(1u));
  return textureLoad(source, vec2i(source_clip.xy + pixel), 0);
}`;

const RESIZE_COPY_GROUP_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "TextureResidency/upload-layout",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
  ]
};

const RESIZE_COPY_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "TextureResidency/upload",
  layout: { label: "TextureResidency/upload-pipeline-layout", bindGroupLayouts: [RESIZE_COPY_GROUP_LAYOUT] },
  vertex: { module: { label: "TextureResidency/upload-vs", code: RESIZE_COPY_VERTEX_WGSL }, entryPoint: "main", buffers: [] },
  fragment: {
    module: { label: "TextureResidency/upload-fs", code: RESIZE_COPY_FRAGMENT_WGSL },
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

function requiresHighBank(texture: ShadeTexture): boolean {
  const image = texture.image;
  return image !== undefined && Math.max(image.width, image.height) > TEXTURE_RESIDENCY_BASE_SIZE;
}

function highBankSize(textures: ReadonlySet<ShadeTexture>): number {
  let required = TEXTURE_RESIDENCY_BASE_SIZE + 1;
  for (const texture of textures) {
    const image = texture.image;
    if (image !== undefined) required = Math.max(required, image.width, image.height);
  }
  return Math.min(TEXTURE_RESIDENCY_MAX_SIZE, nextPowerOfTwo(required));
}

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, value)));
}

function arrayBytes(size: number, capacity: number, mipCount: number): number {
  let texels = 0;
  for (let mip = 0; mip < mipCount; mip++) {
    const extent = Math.max(1, size >> mip);
    texels += extent * extent;
  }
  return texels * capacity * 4;
}

function countMaterials(materials: readonly StandardShadeMaterial[]): Map<StandardShadeMaterial, number> {
  const counts = new Map<StandardShadeMaterial, number>();
  for (const material of materials) counts.set(material, (counts.get(material) ?? 0) + 1);
  return counts;
}
