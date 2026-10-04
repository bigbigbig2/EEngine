import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import { selectAppearanceProductProgram } from "../material/AppearanceGraphCompiler.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { TextureSurfacePublication } from "./TextureVariation.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import { AppearanceProgramRegistry, type AppearanceProgramLease, type AppearanceProgramDescriptor } from "./AppearanceProgramRegistry.js";
import { appearanceResidentKernel, APPEARANCE_ROUTE_STRIDE, type AppearanceResidentKernel,
  APPEARANCE_WORKGROUP_SIZE, type AppearanceSampleResourceProfile, type AppearanceKernelIntegration } from "../shaders/appearance_resident_kernel.js";
import { decodeGpuTextureRef, GPU_TEXTURE_REF_INVALID } from "./GpuTextureRefAbi.js";
import { encodeSamplerClass, GPU_MATERIAL_VISIBILITY_SAMPLER } from "./GpuMaterialVisibilityAbi.js";
import { AppearanceStaticResidency, appearanceStaticTextureKey, type AppearanceStaticLease } from "./AppearanceStaticResidency.js";
import type { AppearanceAssetPackage } from "../assets/AppearanceAssetPackage.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { standardAppearanceParameters } from "../material/AppearanceRuntimeInputs.js";
import { appearanceSurfaceDemandIntegration } from "../shaders/appearance_surface_demand.js";
import type { SurfaceDemandLayout } from "./GpuSurfaceDemandAbi.js";
import { APPEARANCE_FIELD_NAMES } from "./GpuAppearanceFieldAbi.js";
import { appearanceInputLayout, appearanceGeometryInputKind } from "../shaders/appearance_demand_inputs.js";
import { appearanceCoverageKernel, COVERAGE_DIRECTORY_STRIDE } from "../shaders/appearance_coverage.js";
import { ShadeTransparencyMode } from "../material/enums.js";
import { lowerAppearanceFieldBounds, type AppearanceFieldBoundProgram } from "../shaders/appearance_field_bounds.js";
import { packSurfaceAppearanceBounds } from "./GpuSurfaceAppearanceBoundsAbi.js";
import { publishSurfaceFieldIdentities, SURFACE_FIELD_IDENTITY_WORDS } from "./GpuSurfaceFieldIdentityAbi.js";

export const APPEARANCE_DIRECTORY_STRIDE = 32;
/** u32 version, scalar output base, width, dependency mask. */
export const APPEARANCE_FIELD_RECORD_STRIDE = 16;

export interface AppearancePublicationSource {
  readonly material: StandardShadeMaterial;
  readonly materialSlot: number;
  readonly textureBindingSetId: number;
  readonly program: CompiledAppearanceGraph;
  readonly fieldVersions?: ReadonlyMap<string, { readonly version: number }>;
  readonly textureRefs: ReadonlyMap<ShadeTexture, number>;
}

export interface AppearancePublishedEntry {
  readonly material: StandardShadeMaterial;
  readonly inputBase: number;
  readonly materialSlot: number;
  readonly textureBindingSetId: number;
  readonly constantBase: number;
  readonly routeBase: number;
  readonly programIndex: number;
  /** Tasks may share a dispatch only when both PSO and physical resource set agree. */
  readonly resourceSetIndex: number;
  readonly kernel: AppearanceResidentKernel;
  readonly program: CompiledAppearanceGraph;
  readonly productTextures: readonly GPUTexture[];
  readonly fieldBase: number;
  readonly coverage: AppearancePublishedCoverage;
}

export interface AppearancePublishedCoverage {
  readonly material: StandardShadeMaterial;
  readonly materialSlot: number;
  readonly textureBindingSetId: number;
  readonly constantBase: number;
  readonly routeBase: number;
  readonly inputBase: number;
  readonly program: CompiledAppearanceGraph;
  readonly kernel: AppearanceResidentKernel;
  readonly productTextures: readonly GPUTexture[];
  readonly productViews: readonly GPUTextureView[];
  /** Zero is the shared opaque raster program. Alpha programs begin at one. */
  readonly rasterProgram: number;
  readonly cutoffSlot: number;
  readonly viewDependent: boolean;
}

/** Immutable, actual-sized scene publication. Owns buffers and program leases. */
let nextSurfacePublication = 1;

export class GpuAppearancePublication {
  readonly surfaceCacheGeneration = nextSurfacePublication++;
  readonly entries: readonly AppearancePublishedEntry[];
  readonly constants: GPUBuffer;
  readonly routes: GPUBuffer;
  readonly fields: GPUBuffer;
  /** Numeric dynamic inputs, one vec4 per compiled named input. Geometry and
   * surface inputs are supplied by the shared geometry consumer, not this table. */
  readonly runtimeInputs: GPUBuffer;
  /** Packed metadata consumed by the Surface miss evaluator. */
  readonly surfaceMetadata: GPUBuffer;
  readonly surfaceMetadataOffsets: Readonly<{
    readonly materialLookup: number;
    readonly identity: number;
    readonly directory: number;
    readonly runtimeInputs: number;
    readonly bounds: number;
    readonly constants: number;
    readonly routes: number;
    readonly constantFields: number;
    readonly fieldIdentities: number;
    readonly fieldTextureDependencies: number;
    readonly materialLookupCount: number;
    readonly directoryCount: number;
  }>;
  /** Material-slot lookup and stable publication identity consumed by SurfaceWork. */
  readonly materialLookup: GPUBuffer;
  readonly surfaceIdentity: GPUBuffer;
  readonly surfaceProgramCount: number;
  readonly surfaceBoundPrograms: readonly AppearanceFieldBoundProgram[];
  readonly surfaceMaxInputVectors: number;
  readonly surfaceMaxOutputs: number;
  /** Eight u32s: material, PSO, constants, routes, resources, field base, field count, reserved. */
  readonly directory: GPUBuffer;
  /** Material-slot indexed fragment constants/routes/input directory. */
  readonly coverageDirectory: GPUBuffer;
  readonly allocatedBytes: number;
  readonly ready: Promise<void>;
  private readonly staticLeases: AppearanceStaticLease[] = [];
  private readonly buffers: GPUBuffer[] = [];
  private readonly surfaceLeases: AppearanceProgramLease[] = [];
  private readonly samplers: readonly GPUSampler[];
  private readonly productSampler: GPUSampler;
  private surfacePipelines: readonly Awaited<AppearanceProgramLease["ready"]>[] | null = null;
  private constantValues!: Float32Array<ArrayBuffer>;
  private inputValues!: Float32Array<ArrayBuffer>;
  private fieldWords!: Uint32Array<ArrayBuffer>;
  private fieldDependencies: readonly (readonly number[])[] = [];
  private readonly accountingHandles: ResourceHandle[] = [];
  private readonly cancelReadiness: (reason: Error) => void;
  private unwatchRegistry: (() => void) | null = null;
  private readonly destroyedListeners = new Set<() => void>();
  private releasing: ShadeGPUCommandContext | null = null;
  private state: "staging" | "ready" | "resident" | "retiring" | "destroyed" = "staging";

  constructor(private readonly device: GPUDevice, registry: AppearanceProgramRegistry,
    sources: readonly AppearancePublicationSource[], command: ShadeGPUCommandContext,
    mipRanges: ReadonlyMap<ShadeTexture, readonly [number, number]>,
    texturePublications: ReadonlyMap<ShadeTexture, TextureSurfacePublication>,
    private readonly accounting?: ResourceAccounting, staticResidency?: AppearanceStaticResidency) {
    if (command.device !== device || command.closed) throw new Error("Appearance requires an open command on its GPUDevice");
    this.samplers=Object.freeze(Array.from({length:6},(_unused,index)=>device.createSampler({
      minFilter:index<3?"linear":"nearest",magFilter:index<3?"linear":"nearest",mipmapFilter:index<3?"linear":"nearest",
      addressModeU:(["clamp-to-edge","mirror-repeat","repeat"] as const)[index%3]!,
      addressModeV:(["clamp-to-edge","mirror-repeat","repeat"] as const)[index%3]!
    })));
    this.productSampler=device.createSampler({minFilter:"linear",magFilter:"linear",addressModeU:"clamp-to-edge",addressModeV:"clamp-to-edge"});
    const entries: AppearancePublishedEntry[] = [];
    const descriptors: AppearanceProgramDescriptor[] = [];
    const surfaceDescriptors: AppearanceProgramDescriptor[] = [];
    const surfaceKernels: AppearanceResidentKernel[] = [];
    const boundPrograms: AppearanceFieldBoundProgram[] = [];
    const boundGraphs: CompiledAppearanceGraph[] = [];
    const leaseIndices = new Map<string, number>();
    const resourceSets = new Map<string, number>();
    const coveragePrograms = new Map<string, number>();
    const constants: number[] = [];
    const runtimeInputs: number[] = [];
    const fieldDependencies: number[][] = [];
    const fields: number[] = [];
    const routes: ArrayBuffer[] = [];
    const directoryWords = APPEARANCE_DIRECTORY_STRIDE / 4;
    const directory = new Uint32Array(sources.length * directoryWords);
    const assets = new Map<string, AppearanceAssetPackage>();
    const productTargets: { assetId: string; field: string; textures: GPUTexture[]; binding: number }[] = [];
    const productRouteTargets:{assetId:string;field:string;route:number}[]=[];
    try {
      for (const [index, source] of sources.entries()) {
        if (!Number.isInteger(source.materialSlot) || source.materialSlot < 0 || source.materialSlot > 0xffffffff) {
          throw new RangeError("Appearance material slot is not u32");
        }
        const resources: AppearanceSampleResourceProfile[] = [];
        const routeBase = routes.length;
        for (const sample of source.program.samples) {
          const ref = source.textureRefs.get(sample.binding.texture) ?? GPU_TEXTURE_REF_INVALID;
          const decoded = decodeGpuTextureRef(ref);
          // Invalid references preserve the published role's semantic fallback;
          // bank 0 exists in every TextureResidency binding set.
          const publication = texturePublications.get(sample.binding.texture);
          const route = packRoute(sample.binding, ref, mipRanges.get(sample.binding.texture), publication);
          const samplerClass = new DataView(route).getUint32(4, true);
          const address = samplerClass & GPU_MATERIAL_VISIBILITY_SAMPLER.AddressMask;
          const sampler = (samplerClass & GPU_MATERIAL_VISIBILITY_SAMPLER.LinearBit) !== 0 ? 0 : 3;
          resources.push({ bank: decoded?.bankClass ?? 0, sampler: sampler + (address === 0 ? 0 : address === 2 ? 1 : 2) });
          routes.push(route);
        }
        // A named parameter's numeric values never enter the compiled source.
        const productBindings = new Map<string, number>(), productTextures: GPUTexture[] = [];
        const productResources = (source.program.productReads ?? []).map(read => {
          if (read.field.constant !== undefined) return null;
          if (staticResidency === undefined) throw new Error("Appearance products require the long-lived static residency owner");
          const key = appearanceStaticTextureKey(read.asset, read.field)!;
          let binding = productBindings.get(key);
          if (binding === undefined) {
            binding = productBindings.size; productBindings.set(key, binding);
            productTargets.push({ assetId: read.asset.runtime.manifest.assetId, field: read.field.name, textures: productTextures, binding });
          }
          const layer = read.asset.fields.filter(field => appearanceStaticTextureKey(read.asset, field) === key).findIndex(field => field.name === read.field.name);
          productRouteTargets.push({assetId:read.asset.runtime.manifest.assetId,field:read.field.name,route:routes.length});
          routes.push(packProductRoute(read.asset, layer));
          assets.set(read.asset.runtime.manifest.assetId, read.asset);
          return binding;
        });
        const candidate = appearanceResidentKernel(source.program, resources, productResources);
        const kernelKey = candidate.descriptor.source + ":resident-linear:" + JSON.stringify([
          resources, productResources, source.textureBindingSetId, [...productBindings.keys()], candidate.lowered.outputSlots,
          source.program.inputs.map(input => [input.name, input.domain]),
          source.program.instructions.filter(instruction => instruction.kind === "input").map(instruction => instruction.coordinateDomains)
        ]);
        // Metadata (output names and parameter provenance) belongs to each
        // material program even when its WGSL topology shares the same PSO.
        const kernel = candidate;
        const resourceKey = JSON.stringify([source.textureBindingSetId, [...productBindings.keys()]]);
        let resourceSetIndex = resourceSets.get(resourceKey);
        if (resourceSetIndex === undefined) { resourceSetIndex = resourceSets.size; resourceSets.set(resourceKey, resourceSetIndex); }
        let programIndex = leaseIndices.get(kernelKey);
        if (programIndex === undefined) {
          programIndex = descriptors.length;
          descriptors.push(kernel.descriptor);
          const surfaceKernel = appearanceResidentKernel(source.program, resources, productResources,
            appearanceSurfaceDemandIntegration(source.program, kernel.lowered));
          surfaceKernels.push(surfaceKernel);
          boundPrograms.push(Object.freeze({
            ...lowerAppearanceFieldBounds(source.program, kernel.lowered, `ab_field_${programIndex}`),
            inputSemantics: Object.freeze(source.program.inputs.map(input => appearanceGeometryInputKind(input, source.program)))
          }));
          boundGraphs.push(source.program);
          surfaceDescriptors.push(surfaceKernel.descriptor);
          leaseIndices.set(kernelKey, programIndex);
        }
        const constantBase = constants.length;
        const inputBase = runtimeInputs.length / 4;
        for (const input of source.program.inputs) {
          const gpuInput=appearanceGeometryInputKind(input,source.program)!==0;
          const value = gpuInput ? undefined : source.material.appearance_inputs.get(input.name);
          if (!gpuInput && value?.length !== input.width) {
            throw new RangeError(`Appearance input '${input.name}' requires ${input.width} live components`);
          }
          runtimeInputs.push(...Array.from({ length: 4 }, (_, channel) => value?.[channel] ?? 0));
        }
        const fieldBase = fields.length / (APPEARANCE_FIELD_RECORD_STRIDE / 4);
        for (const [name, outputs] of Object.entries(kernel.lowered.outputSlots)) {
          const version = source.fieldVersions === undefined ? 1 : source.fieldVersions.get(name)?.version;
          if (version === undefined || !Number.isInteger(version) || version < 1 || version > 0xffffffff) throw new RangeError("Appearance output field requires a nonzero u32 version");
          const dependency = source.program.outputs[name]!.reduce((mask, ref) => mask | source.program.instructions[ref]!.dependency, 0);
          fields.push(version, outputs[0]!, outputs.length, dependency);
          const live = new Set<number>(), pending = [...source.program.outputs[name]!];
          const numeric = new Set<number>();
          while (pending.length) {
            const ref = pending.pop()!;
            if (live.has(ref)) continue;
            live.add(ref); const instruction = source.program.instructions[ref]!;
            if (instruction.kind === "parameter") {
              for (const slot of kernel.lowered.parameterSlots[instruction.parameter!] ?? []) numeric.add(constantBase + slot.slot);
            }
            if (instruction.kind === "input") {
              const index = source.program.inputs.findIndex(input => input.name === instruction.input);
              const input = source.program.inputs[index]!;
              if (appearanceGeometryInputKind(input,source.program)===0) numeric.add(-1 - (inputBase + index) * 4 - instruction.channel!);
            }
            pending.push(...instruction.args);
          }
          fieldDependencies.push([...numeric]);
        }
        // Values must come from this instance even when its topology reuses a kernel.
        constants.push(...candidate.lowered.constants);
        const alpha = source.program.outputs.alpha;
        if (alpha?.length !== 1) throw new Error("Published Appearance requires a scalar coverage root");
        const coverageProgram = selectAppearanceProductProgram(source.program, { alpha });
        const coverageRouteBase = routes.length;
        const coverageResources: AppearanceSampleResourceProfile[] = [];
        for (const sample of coverageProgram.samples) {
          const ref = source.textureRefs.get(sample.binding.texture) ?? GPU_TEXTURE_REF_INVALID;
          const route = packRoute(sample.binding, ref, mipRanges.get(sample.binding.texture), texturePublications.get(sample.binding.texture));
          const samplerClass = new DataView(route).getUint32(4, true);
          const address = samplerClass & GPU_MATERIAL_VISIBILITY_SAMPLER.AddressMask;
          coverageResources.push({ bank: decodeGpuTextureRef(ref)?.bankClass ?? 0,
            sampler: ((samplerClass & GPU_MATERIAL_VISIBILITY_SAMPLER.LinearBit) !== 0 ? 0 : 3) + (address === 0 ? 0 : address === 2 ? 1 : 2) });
          routes.push(route);
        }
        const coverageProductBindings = new Map<string, number>(), coverageProductTextures: GPUTexture[] = [];
        const coverageProducts = (coverageProgram.productReads ?? []).map(read => {
          if (read.field.constant !== undefined) return null;
          if (!staticResidency) throw new Error("Coverage products require static residency");
          const key = appearanceStaticTextureKey(read.asset, read.field)!;
          let binding = coverageProductBindings.get(key);
          if (binding === undefined) {
            binding = coverageProductBindings.size; coverageProductBindings.set(key, binding);
            productTargets.push({ assetId: read.asset.runtime.manifest.assetId, field: read.field.name, textures: coverageProductTextures, binding });
          }
          const layer = read.asset.fields.filter(field => appearanceStaticTextureKey(read.asset, field) === key).findIndex(field => field.name === read.field.name);
          routes.push(packProductRoute(read.asset, layer)); assets.set(read.asset.runtime.manifest.assetId, read.asset);
          return binding;
        });
        const coverageKernel = appearanceCoverageKernel(coverageProgram, coverageResources, coverageProducts);
        const coverageConstantBase = constants.length, coverageInputBase = runtimeInputs.length / 4;
        constants.push(...coverageKernel.lowered.constants);
        const cutoffSlot = constants.length;
        if (!Number.isFinite(Math.fround(source.material.alpha_cutoff))) throw new RangeError("Coverage cutoff must be finite f32");
        constants.push(Math.max(0,Math.min(1,source.material.alpha_cutoff)));
        for (const input of coverageProgram.inputs) {
          const inputIndex = source.program.inputs.findIndex(candidate => candidate.name === input.name);
          runtimeInputs.push(...runtimeInputs.slice((inputBase + inputIndex) * 4, (inputBase + inputIndex + 1) * 4));
        }
        const coverageKey = coverageKernel.descriptor.source + JSON.stringify([source.textureBindingSetId, [...coverageProductBindings.keys()]]);
        let rasterProgram = 0;
        if (source.material.transparency_mode === ShadeTransparencyMode.AlphaTested) {
          const existingProgram = coveragePrograms.get(coverageKey);
          rasterProgram = existingProgram ?? coveragePrograms.size + 1;
          if (existingProgram === undefined) coveragePrograms.set(coverageKey, rasterProgram);
        }
        const coverage: AppearancePublishedCoverage = Object.freeze({ material: source.material, materialSlot: source.materialSlot,
          textureBindingSetId: source.textureBindingSetId, constantBase: coverageConstantBase, routeBase: coverageRouteBase,
          inputBase: coverageInputBase, program: coverageProgram, kernel: coverageKernel, productTextures: coverageProductTextures, productViews: [], rasterProgram,
          cutoffSlot, viewDependent: coverageProgram.inputs.some(input => [8,9,13,14].includes(appearanceGeometryInputKind(input,coverageProgram))) });
        entries.push(Object.freeze({ material: source.material, inputBase, materialSlot: source.materialSlot, textureBindingSetId: source.textureBindingSetId,
          constantBase, routeBase, programIndex, resourceSetIndex, kernel, program: source.program, productTextures, fieldBase, coverage }));
        directory.set([source.materialSlot, programIndex, constantBase, routeBase, resourceSetIndex, fieldBase,
          Object.keys(kernel.lowered.outputSlots).length, inputBase], index * directoryWords);
      }
      const constantData = new Float32Array(Math.max(constants.length, 1));
      constantData.set(constants);
      const routeData = new Uint8Array(Math.max(routes.length, 1) * APPEARANCE_ROUTE_STRIDE);
      routes.forEach((route, index) => routeData.set(new Uint8Array(route), index * APPEARANCE_ROUTE_STRIDE));
      const directoryData = sources.length === 0 ? new Uint32Array(directoryWords) : directory;
      const fieldData = new Uint32Array(Math.max(fields.length, APPEARANCE_FIELD_RECORD_STRIDE / 4)); fieldData.set(fields);
      const inputData = new Float32Array(Math.max(runtimeInputs.length, 4)); inputData.set(runtimeInputs);
      const maxMaterialSlot = Math.max(0, ...sources.map(source => source.materialSlot));
      const materialLookupData = new Uint32Array(maxMaterialSlot + 1); materialLookupData.fill(0xffffffff);
      const identityData = new Uint32Array(Math.max(20, sources.length * 20));
      if(this.surfaceCacheGeneration>=0xffffffff)throw new RangeError("Surface publication identity exhausted; recreate device");
      sources.forEach((source,index)=>{
        materialLookupData[source.materialSlot]=index;
        const names=Object.keys(source.program.outputs),at=index*20;
        identityData.set([directoryData[index*directoryWords+1]!,directoryData[index*directoryWords+5]!,names.length,this.surfaceCacheGeneration],at);
        APPEARANCE_FIELD_NAMES.forEach((name,field)=>{const ordinal=names.indexOf(name);identityData[at+4+field]=ordinal<0?0xffffffff:ordinal;});
      });
      const boundData = packSurfaceAppearanceBounds(boundGraphs);
      const fieldIdentityData = new Uint32Array(Math.max(1,sources.length)*15*SURFACE_FIELD_IDENTITY_WORDS);
      const fieldTextureDependencies: number[] = [];
      sources.forEach((source,index) => {
        const entry=entries[index]!;
        const publication=publishSurfaceFieldIdentities(registry,source.program,entry.fieldBase,binding => {
          const texture=texturePublications.get(binding.texture);
          const samplerSnapshot={wrapS:binding.sampler[4],wrapT:binding.sampler[5],minFilter:binding.sampler[1],magFilter:binding.sampler[2],
            runtime_asset_package_v2:binding.texture.runtime_asset_package_v2} as ShadeTexture;
          return [source.textureRefs.get(binding.texture)??GPU_TEXTURE_REF_INVALID,texture?.slot??0,texture?.generation??0,
            encodeSamplerClass(samplerSnapshot,mipRanges.get(binding.texture)).value];
        },name => source.material.appearance_inputs.get(name));
        const identities=publication.identities;
        for(let field=0;field<15;field++) { identities[field*SURFACE_FIELD_IDENTITY_WORDS+4]!+=fieldTextureDependencies.length; }
        fieldIdentityData.set(identities,index*15*SURFACE_FIELD_IDENTITY_WORDS);
        fieldTextureDependencies.push(...publication.textureSlots);
      });
      const fieldTextureData=Uint32Array.from(fieldTextureDependencies);
      const surfaceMetadataOffsets = {
        materialLookup: 0,
        identity: materialLookupData.length,
        directory: materialLookupData.length + identityData.length,
        runtimeInputs: materialLookupData.length + identityData.length + directoryData.length,
        bounds: materialLookupData.length + identityData.length + directoryData.length + inputData.length,
        constants: materialLookupData.length + identityData.length + directoryData.length + inputData.length + boundData.length,
        routes: materialLookupData.length + identityData.length + directoryData.length + inputData.length + boundData.length + constantData.length,
        constantFields: materialLookupData.length + identityData.length + directoryData.length + inputData.length + boundData.length + constantData.length + routeData.byteLength/4,
        fieldIdentities: materialLookupData.length + identityData.length + directoryData.length + inputData.length + boundData.length + constantData.length + routeData.byteLength/4 + Math.max(1,sources.length)*64,
        fieldTextureDependencies: materialLookupData.length + identityData.length + directoryData.length + inputData.length + boundData.length + constantData.length + routeData.byteLength/4 + Math.max(1,sources.length)*64 + fieldIdentityData.length,
        materialLookupCount: materialLookupData.length,
        directoryCount: directoryData.length / directoryWords
      } as const;
      // GPU publication substage fills one submitted-epoch constant palette per
      // material. The immutable descriptor/input ranges precede this write domain.
      const surfaceMetadataData = new Uint32Array(surfaceMetadataOffsets.fieldTextureDependencies+fieldTextureData.length);
      surfaceMetadataData.set(materialLookupData, surfaceMetadataOffsets.materialLookup);
      surfaceMetadataData.set(identityData, surfaceMetadataOffsets.identity);
      surfaceMetadataData.set(directoryData, surfaceMetadataOffsets.directory);
      surfaceMetadataData.set(new Uint32Array(inputData.buffer, inputData.byteOffset, inputData.length), surfaceMetadataOffsets.runtimeInputs);
      surfaceMetadataData.set(boundData, surfaceMetadataOffsets.bounds);
      surfaceMetadataData.set(new Uint32Array(constantData.buffer),surfaceMetadataOffsets.constants);
      surfaceMetadataData.set(new Uint32Array(routeData.buffer),surfaceMetadataOffsets.routes);
      surfaceMetadataData.set(fieldIdentityData,surfaceMetadataOffsets.fieldIdentities);
      surfaceMetadataData.set(fieldTextureData,surfaceMetadataOffsets.fieldTextureDependencies);
      const maximum = Math.min(Number(device.limits.maxBufferSize), Number(device.limits.maxStorageBufferBindingSize));
      for (const data of [constantData, routeData, directoryData, fieldData, inputData, materialLookupData, identityData, surfaceMetadataData]) if (data.byteLength > maximum) {
        throw new RangeError(`Appearance publication ${data.byteLength} bytes exceed negotiated storage limit ${maximum}`);
      }
      // Publication byte admission precedes every shader/layout/pipeline/buffer creation.
      for (const descriptor of surfaceDescriptors) registry.preflight(descriptor);
      for (const descriptor of surfaceDescriptors) this.surfaceLeases.push(registry.acquire(descriptor));
      const assetLeases = new Map<string, AppearanceStaticLease>();
      for (const [id, asset] of assets) {
        const lease = staticResidency!.acquire(asset, command);
        this.staticLeases.push(lease); assetLeases.set(id, lease);
      }
      for (const target of productTargets) target.textures[target.binding] = assetLeases.get(target.assetId)!.destination(target.field).texture;
      for(const target of productRouteTargets){
        const summary=assetLeases.get(target.assetId)!.variation(target.field);if(!summary)continue;
        const view=new DataView(routeData.buffer,target.route*APPEARANCE_ROUTE_STRIDE,APPEARANCE_ROUTE_STRIDE);
        view.setUint32(4,summary.slot,true);view.setUint32(8,summary.generation,true);view.setUint32(12,summary.revision,true);
      }
      surfaceMetadataData.set(new Uint32Array(routeData.buffer),surfaceMetadataOffsets.routes);
      for (const entry of entries) {
        Object.freeze(entry.productTextures); Object.freeze(entry.coverage.productTextures);
        (entry.coverage.productViews as GPUTextureView[]).push(...entry.coverage.productTextures.map(texture => texture.createView({ dimension: "2d-array" })));
        Object.freeze(entry.coverage.productViews);
      }
      this.constants = this.upload(device, command, "constants", constantData);
      this.routes = this.upload(device, command, "routes", routeData);
      this.directory = this.upload(device, command, "directory", directoryData);
      this.fields = this.upload(device, command, "fields", fieldData);
      this.runtimeInputs = this.upload(device, command, "runtime-inputs", inputData);
      this.surfaceMetadata = this.upload(device, command, "surface-metadata", surfaceMetadataData);
      this.surfaceMetadataOffsets = Object.freeze(surfaceMetadataOffsets);
      this.materialLookup = this.upload(device, command, "surface-material-lookup", materialLookupData);
      this.surfaceIdentity = this.upload(device, command, "surface-publication-identity", identityData);
      const coverageDirectoryData = new Uint32Array((maxMaterialSlot + 1) * COVERAGE_DIRECTORY_STRIDE / 4);
      if (coverageDirectoryData.byteLength > maximum) throw new RangeError("Coverage directory exceeds negotiated storage limit");
      entries.forEach(entry => coverageDirectoryData.set([entry.coverage.constantBase, entry.coverage.routeBase, entry.coverage.inputBase, entry.coverage.rasterProgram], entry.materialSlot * 4));
      this.coverageDirectory = this.upload(device, command, "coverage-directory", coverageDirectoryData);
      this.constantValues = constantData; this.inputValues = inputData; this.fieldWords = fieldData;
      this.fieldDependencies = fieldDependencies;
       this.entries = Object.freeze(entries);
       this.surfaceProgramCount = surfaceDescriptors.length;
       this.surfaceBoundPrograms = Object.freeze(boundPrograms);
       this.surfaceMaxInputVectors = Math.max(1, ...surfaceKernels.map(kernel => kernel.inputVectorCount));
       this.surfaceMaxOutputs = Math.max(1, ...surfaceKernels.map(kernel => kernel.lowered.outputCount));
       this.allocatedBytes = this.buffers.reduce((bytes, buffer) => bytes + buffer.size, 0);
      let cancel!: (reason: Error) => void;
      const cancellation = new Promise<never>((_resolve, reject) => { cancel = reject; });
      this.cancelReadiness = cancel;
       this.ready = Promise.race([cancellation, Promise.all([
         Promise.all(this.surfaceLeases.map(lease => lease.ready))
       ]).then(([surfacePipelines]) => {
         if (this.state !== "staging") throw new Error("Appearance publication cancelled before program readiness");
         this.surfacePipelines = Object.freeze(surfacePipelines);
         this.state = "ready";
      })]);
      void this.ready.catch(() => undefined);
      command.onBeforeFinish.addOne(() => {
        if (this.state !== "ready") throw new Error("Appearance programs must be ready before scene submission");
      });
      command.onFinished.addOne(() => { if (this.state === "ready") this.state = "resident"; });
      command.onAborted.addOne(() => this.destroy());
      this.unwatchRegistry = registry.onStopped(() => this.destroy());
    } catch (error) {
      for (const lease of this.surfaceLeases) lease.release();
      for (const lease of this.staticLeases) lease.release();
      for (const buffer of this.buffers) buffer.destroy();
      for (const handle of this.accountingHandles) accounting?.destroyed(handle);
      throw error;
    }
  }

  /** Encode edits into the main frame transaction. Only affected field versions
   * advance; abort leaves CPU authority unchanged so the upload is retried. */
  syncRuntime(command: ShadeGPUCommandContext): boolean {
    if (command.device !== this.device || command.closed || (this.state !== "ready" && this.state !== "resident")) throw new Error("Appearance edits require an open resident frame");
    const constants = this.constantValues.slice(), inputs = this.inputValues.slice();
    const parameters = new Map<StandardShadeMaterial, ReadonlyMap<string, number>>();
    for (const entry of [...this.entries, ...this.entries.map(entry => entry.coverage)]) {
      if ("cutoffSlot" in entry) {
        if (!Number.isFinite(Math.fround(entry.material.alpha_cutoff))) throw new RangeError("Coverage cutoff must be finite f32");
        constants[entry.cutoffSlot] = Math.max(0,Math.min(1,entry.material.alpha_cutoff));
      }
      let values = parameters.get(entry.material);
      if (!values) { values = standardAppearanceParameters(entry.material); parameters.set(entry.material, values); }
      for (const [name, slots] of Object.entries(entry.kernel.lowered.parameterSlots)) {
        const authored = entry.material.appearance_inputs.get(name);
        for (const slot of slots) {
          const value = authored?.[slot.channel] ?? values.get(name) ?? constants[entry.constantBase + slot.slot]!;
          if (!Number.isFinite(Math.fround(value))) throw new RangeError(`Appearance parameter '${name}' is not finite f32`);
          constants[entry.constantBase + slot.slot] = value;
        }
      }
      entry.program.inputs.forEach((input, index) => {
        if (appearanceGeometryInputKind(input,entry.program)!==0) return;
        const value = entry.material.appearance_inputs.get(input.name);
        if (value?.length !== input.width) throw new RangeError(`Appearance input '${input.name}' width changed`);
        inputs.set(value, (entry.inputBase + index) * 4);
      });
    }
    const changed = new Set<number>();
    for (let i = 0; i < constants.length; i++) if (!Object.is(constants[i], this.constantValues[i])) changed.add(i);
    for (let i = 0; i < inputs.length; i++) if (!Object.is(inputs[i], this.inputValues[i])) changed.add(-1 - i);
    const coverageChanged = this.entries.some(({coverage}) => {
      if (coverage.material.transparency_mode !== ShadeTransparencyMode.AlphaTested) return false;
      if (changed.has(coverage.cutoffSlot)) return true;
      for (let slot = 0; slot < coverage.kernel.lowered.constants.length; slot++) if (changed.has(coverage.constantBase + slot)) return true;
      for (let slot = 0; slot < coverage.program.inputs.length * 4; slot++) if (changed.has(-1 - coverage.inputBase * 4 - slot)) return true;
      return false;
    });
    if (changed.size === 0) return false;
    const fields = this.fieldWords.slice();
    this.fieldDependencies.forEach((dependencies, field) => {
      if (!dependencies.some(ref => changed.has(ref))) return;
      const word = field * 4;
      if (fields[word] === 0xffffffff) throw new RangeError("Appearance field version exhausted; republish the scene");
      fields[word] = fields[word]! + 1;
    });
    for (const [buffer, data] of [[this.constants, constants], [this.runtimeInputs, inputs], [this.fields, fields]] as const) {
      command.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
    }
    command.writeBuffer(this.surfaceMetadata, this.surfaceMetadataOffsets.runtimeInputs*4, inputs.buffer, inputs.byteOffset, inputs.byteLength);
    command.writeBuffer(this.surfaceMetadata, this.surfaceMetadataOffsets.constants*4, constants.buffer, constants.byteOffset, constants.byteLength);
    command.onFinished.addOne(() => { this.constantValues = constants; this.inputValues = inputs; this.fieldWords = fields; });
    return coverageChanged;
  }

  get viewDependentCoverage(): boolean {
    return this.entries.some(entry => entry.coverage.viewDependent && entry.material.transparency_mode === ShadeTransparencyMode.AlphaTested);
  }

  /** Actual unique missing fields, grouped by the compiler's PSO/resources. */
  encodeSurfaceFields(command: ShadeGPUCommandContext, input: {
    readonly geometry: GPUBuffer;
    readonly demand: GPUBuffer;
    readonly indirect: GPUBuffer;
    readonly values: GPUBuffer;
    readonly layout: SurfaceDemandLayout;
    readonly textureBanks: readonly (readonly GPUTextureView[])[];
  }): void {
    if (command.device !== this.device || command.closed || (this.state !== "ready" && this.state !== "resident")) {
      throw new Error("Surface Appearance requires an open resident frame");
    }
    const pipelines = this.surfacePipelines;
    if (!pipelines) throw new Error("Surface field kernels are not ready");
    const offsets=input.layout.offsets;
    for (let programIndex=0;programIndex<pipelines.length;programIndex++) {
      const entry=this.entries.find(candidate=>candidate.programIndex===programIndex);
      if (!entry) continue;
      const settings=command.allocateTransientBuffer(GPUBufferUsage.UNIFORM,32);
      command.writeBuffer(settings,0,new Uint32Array([
        programIndex,offsets.programs!/4,offsets.ordered_material_queue!/4,offsets.material_masks!/4,
        offsets.field_destinations!/4,this.surfaceMetadataOffsets.directory,this.surfaceMetadataOffsets.runtimeInputs,offsets.material_entries!/4
      ]).buffer,0,32);
      const ready=pipelines[programIndex]!;
      const group0=this.device.createBindGroup({layout:ready.layouts[0]!,entries:[
        {binding:0,resource:{buffer:this.constants}},
        {binding:1,resource:{buffer:this.routes}},
        {binding:2,resource:{buffer:input.geometry}},
        {binding:3,resource:{buffer:input.demand}},
        {binding:4,resource:{buffer:this.surfaceMetadata}},
        {binding:5,resource:{buffer:input.values}},
        {binding:6,resource:{buffer:settings}}
      ]});
      const groups: GPUBindGroup[] = [group0];
      const textureLayout = ready.layouts[1];
      const textureDescriptors = entry.kernel.descriptor.groups[1] ?? [];
      if (textureLayout) {
        const textureEntries: GPUBindGroupEntry[] = [];
        const banks = input.textureBanks[entry.textureBindingSetId] ?? [];
        for (const descriptor of textureDescriptors) {
          if (descriptor.texture) {
            const view = banks[descriptor.binding];
            if (!view) throw new Error(`Surface texture bank ${entry.textureBindingSetId}:${descriptor.binding} is missing`);
            textureEntries.push({ binding: descriptor.binding, resource: view });
          } else if (descriptor.sampler) {
            const samplerIndex = descriptor.binding - 9;
            textureEntries.push({ binding: descriptor.binding, resource: this.samplers[samplerIndex]! });
          }
        }
        groups.push(this.device.createBindGroup({ layout: textureLayout, entries: textureEntries }));
      }
      const productLayout = ready.layouts[2];
      if (productLayout) {
        const productEntries: GPUBindGroupEntry[] = entry.productTextures.map((texture, binding) => ({
          binding, resource: texture.createView({ dimension: "2d-array" })
        }));
        if (entry.productTextures.length > 0) productEntries.push({ binding: entry.productTextures.length,
          resource: this.productSampler });
        groups.push(this.device.createBindGroup({ layout: productLayout, entries: productEntries }));
      }
      const pass = command.beginComputePass({ label: `Surface/material publication kernel ${programIndex}` });
      pass.setPipeline(ready.pipeline); groups.forEach((group, index) => pass.setBindGroup(index, group));
      pass.dispatchWorkgroupsIndirect(input.indirect, offsets.programs! + programIndex * 32);
      pass.end();
    }
  }

  evidence(): Readonly<{ allocatedBytes: number; residentBytes: number; retiringBytes: number; stagingBytes: number }> {
    const bytes = this.state === "destroyed" ? 0 : this.allocatedBytes;
    return Object.freeze({ allocatedBytes: bytes,
      residentBytes: this.state === "resident" ? bytes : 0,
      retiringBytes: this.state === "retiring" ? bytes : 0,
      stagingBytes: this.state === "staging" || this.state === "ready" ? bytes : 0 });
  }

  onDestroyed(callback: () => void): void {
    if (this.state === "destroyed") callback(); else this.destroyedListeners.add(callback);
  }

  /** Abort preserves the old publication; committed release retires after GPU completion. */
  release(command: ShadeGPUCommandContext): void {
    if (this.state !== "resident" || this.releasing !== null || command.closed || command.device !== this.device) {
      throw new Error("Appearance release requires one open resident transaction on its GPUDevice");
    }
    this.releasing = command;
    command.onAborted.addOne(() => { this.releasing = null; });
    command.onFinished.addOne(() => {
      this.state = "retiring";
      void command.gpuDone.then(() => this.destroy(), () => this.destroy());
    });
  }

  destroy(): void {
    if (this.state === "destroyed") return;
    this.state = "destroyed";
    this.unwatchRegistry?.();
    this.unwatchRegistry = null;
    this.cancelReadiness(new Error("Appearance publication cancelled or destroyed"));
    this.surfacePipelines = null;
    for (const buffer of this.buffers) buffer.destroy();
    for (const handle of this.accountingHandles) this.accounting?.destroyed(handle);
    for (const lease of this.surfaceLeases) lease.release();
    for (const lease of this.staticLeases) lease.release();
    for (const callback of this.destroyedListeners) callback();
    this.destroyedListeners.clear();
  }

  private upload(device: GPUDevice, command: ShadeGPUCommandContext, name: string, data: Float32Array | Uint8Array | Uint32Array): GPUBuffer {
    const label = `GpuAppearancePublication/${name}`;
    const buffer = device.createBuffer({ label, size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | (name === "surface-metadata" ? GPUBufferUsage.COPY_SRC : 0) });
    this.buffers.push(buffer);
    if (this.accounting !== undefined) this.accountingHandles.push(this.accounting.created({
      kind: "buffer", category: "resident", owner: "GpuAppearancePublication", label, bytes: data.byteLength }));
    command.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    return buffer;
  }
}

function packProductRoute(asset: AppearanceAssetPackage, layer: number): ArrayBuffer {
  const data = new ArrayBuffer(APPEARANCE_ROUTE_STRIDE), view = new DataView(data);
  view.setUint32(0, layer, true);
  const mapping = [...asset.domainMin, ...asset.domainMax.map((max, axis) => 1 / (max - asset.domainMin[axis]!))];
  if (!mapping.every(value => Number.isFinite(Math.fround(value)))) throw new RangeError("Appearance product coordinate mapping exceeds f32 publication range");
  mapping
    .forEach((value, index) => view.setFloat32(16 + index * 4, value, true));
  return data;
}

function packRoute(binding: CompiledAppearanceGraph["samples"][number]["binding"], ref: number,
  mipRange: readonly [number, number] | undefined, publication: TextureSurfacePublication | undefined): ArrayBuffer {
  // Sampling author state is the compilation snapshot, not a later mutable texture.
  const samplerSnapshot = { wrapS: binding.sampler[4], wrapT: binding.sampler[5],
    minFilter: binding.sampler[1], magFilter: binding.sampler[2],
    runtime_asset_package_v2: binding.texture.runtime_asset_package_v2 } as ShadeTexture;
  const sampler = encodeSamplerClass(samplerSnapshot, mipRange);
  const data = new ArrayBuffer(APPEARANCE_ROUTE_STRIDE);
  const view = new DataView(data);
  [ref, sampler.value, publication?.slot ?? 0, publication?.revision ?? 0]
    .forEach((value, index) => view.setUint32(index * 4, value, true));
  const values = [...binding.offset, ...binding.scale, Math.cos(binding.rotation), Math.sin(binding.rotation), 0, 0,
    ...binding.fallback];
  values.forEach((value, index) => view.setFloat32(16 + index * 4, value, true));
  // Rotation's unused lanes carry exact local-summary identity, not f32 values.
  view.setUint32(40, publication?.generation ?? 0, true);
  return data;
}
