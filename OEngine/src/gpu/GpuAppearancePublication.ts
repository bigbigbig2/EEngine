import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import { selectAppearanceProductProgram } from "../material/AppearanceGraphCompiler.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { TextureSurfacePublication } from "./TextureVariation.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import {
  AppearanceProgramRegistry,
  type AppearanceProgramLease,
  type AppearanceProgramDescriptor
} from "./AppearanceProgramRegistry.js";
import {
  APPEARANCE_ROUTE_STRIDE,
  type AppearanceResidentKernel,
  type AppearanceSampleResourceProfile
} from "../shaders/appearance_resident_kernel.js";
import { decodeGpuTextureRef, GPU_TEXTURE_REF_INVALID } from "./GpuTextureRefAbi.js";
import { encodeSamplerClass, GPU_MATERIAL_VISIBILITY_SAMPLER } from "./GpuMaterialVisibilityAbi.js";
import {
  AppearanceStaticResidency,
  appearanceStaticTextureKey,
  type AppearanceStaticLease
} from "./AppearanceStaticResidency.js";
import type { AppearanceAssetPackage } from "../assets/AppearanceAssetPackage.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { standardAppearanceParameters } from "../material/AppearanceRuntimeInputs.js";
import { packAppearanceDagPublication } from "./GpuAppearanceDagAbi.js";
import { planExactAppearanceLanes, type AppearanceWorkPlan } from "../material/ExactAppearanceDag.js";
import { SURFACE_WORK_RETAINED_FIELDS } from "./GpuSurfaceWorkAbi.js";
import { appearancePublicationExactDescriptor } from "../shaders/appearance_publication_exact.js";
import { surfaceWorkAppearanceWgsl } from "../shaders/surface_work.js";
import { TEXTURE_BINDING_SET_MAX_RESIDENT_SETS } from "./TextureBindingSetPolicy.js";
import { APPEARANCE_FIELD_NAMES, APPEARANCE_FIELD_WIDTHS } from "./GpuAppearanceFieldAbi.js";
import { appearanceGeometryInputKind } from "../shaders/appearance_demand_inputs.js";
import { appearanceCoverageKernel, COVERAGE_DIRECTORY_STRIDE } from "../shaders/appearance_coverage.js";
import { ShadeTransparencyMode } from "../material/enums.js";
import { GpuBindGroupResourceCache } from "./GpuBindGroupResourceCache.js";
import {
  appearanceExecutionProfiles,
  type AppearanceExecutionProfiles
} from "../material/AppearanceExecutionProfile.js";

import { lowerAppearanceWgsl, type AppearanceWgslProgram } from "../shaders/appearance_program.js";
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
  readonly lowered: AppearanceWgslProgram;
  readonly program: CompiledAppearanceGraph;
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
  /** Numeric dynamic inputs, one vec4 per compiled named input. Geometry and
   * surface inputs are supplied by the shared geometry consumer, not this table. */
  readonly runtimeInputs: GPUBuffer;
  /** Packed metadata consumed by the Surface miss evaluator. */
  readonly surfaceMetadata: GPUBuffer;
  readonly surfaceMetadataOffsets: Readonly<{
    readonly materialLookup: number;
    readonly runtimeInputs: number;
    readonly constants: number;
    readonly routes: number;
    readonly constantFields: number;
    readonly radiometry: number;
    readonly exactFieldOffsets: number;
    readonly materialLookupCount: number;
  }>;
  readonly surfaceProgramCount: number;
  readonly surfaceTemplateCount: number;
  readonly surfaceCoherenceSetMask: number;
  readonly surfaceExecutionProfiles: readonly AppearanceExecutionProfiles[];
  /** Material-slot indexed fragment constants/routes/input directory. */
  readonly coverageDirectory: GPUBuffer;
  readonly allocatedBytes: number;
  readonly ready: Promise<void>;
  readonly exactDagCode: GPUBuffer;
  readonly exactDagProducts: readonly GPUBuffer[];
  readonly exactDagProductBankWords: number;
  readonly exactDagLiveWords: number;
  readonly exactDagLanes: number;
  readonly exactDagScratchBytes: number;
  readonly surfaceDomainCount: number;
  readonly surfaceHasLit: boolean;
  readonly surfaceWorkScratchWords: number;
  readonly surfaceWorkProfiles: readonly boolean[];
  readonly exactDagVaryingFields: number;
  readonly exactDagFieldOffsetValues: readonly number[];
  private readonly staticLeases: AppearanceStaticLease[] = [];
  private readonly buffers: GPUBuffer[] = [];
  private readonly surfaceLeases: AppearanceProgramLease[] = [];
  private readonly samplers: readonly GPUSampler[];
  private readonly productSampler: GPUSampler;
  private surfacePipelines: readonly Awaited<AppearanceProgramLease["ready"]>[] | null = null;
  private readonly surfaceSettings: GPUBuffer[] = [];
  private readonly surfaceBindings = new Map<GPUBindGroupLayout, GpuBindGroupResourceCache>();
  private readonly surfaceEmptyBindings = new Map<GPUBindGroupLayout, GPUBindGroup>();
  private readonly surfaceProductViews = new WeakMap<GPUTexture, GPUTextureView>();
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
  private uniformRevision = 1;
  private readonly uniformFlags: Uint32Array<ArrayBuffer>;
  private uniformFlagBase = 0;
  private uniformDependencies: readonly (readonly number[])[] = [];
  private hasFrameUniform = false;
  readonly workPlans!: readonly AppearanceWorkPlan[];
  private uniformResourceSetMask = 0;
  readonly uniformQueryStatsBase!: number;
  get requiresUniformResources(): boolean {
    return this.uniformResourceSetMask !== 0;
  }
  private publicationSetMask = 0;
  private uniformResources: { publication: TextureSurfacePublication; revision: number }[][] = [];
  private committedUniformRevision = 0;

  constructor(
    private readonly device: GPUDevice,
    registry: AppearanceProgramRegistry,
    sources: readonly AppearancePublicationSource[],
    command: ShadeGPUCommandContext,
    mipRanges: ReadonlyMap<ShadeTexture, readonly [number, number]>,
    texturePublications: ReadonlyMap<ShadeTexture, TextureSurfacePublication>,
    private readonly accounting?: ResourceAccounting,
    staticResidency?: AppearanceStaticResidency,
    maximumConcurrentSamples = 4096
  ) {
    if (!Number.isSafeInteger(maximumConcurrentSamples) || maximumConcurrentSamples < 1) {
      throw new RangeError("Appearance concurrent sample capacity must be a positive integer");
    }
    if (command.device !== device || command.closed)
      throw new Error("Appearance requires an open command on its GPUDevice");
    this.uniformFlags = new Uint32Array(sources.length).fill(3);
    this.samplers = Object.freeze(
      Array.from({ length: 6 }, (_unused, index) =>
        device.createSampler({
          minFilter: index < 3 ? "linear" : "nearest",
          magFilter: index < 3 ? "linear" : "nearest",
          mipmapFilter: index < 3 ? "linear" : "nearest",
          addressModeU: (["clamp-to-edge", "mirror-repeat", "repeat"] as const)[index % 3]!,
          addressModeV: (["clamp-to-edge", "mirror-repeat", "repeat"] as const)[index % 3]!
        })
      )
    );
    this.productSampler = device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge"
    });
    const entries: AppearancePublishedEntry[] = [];
    const descriptors: AppearanceProgramDescriptor[] = [];
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
    const productRouteTargets: { assetId: string; field: string; route: number }[] = [];
    try {
      for (const [index, source] of sources.entries()) {
        if (
          !Number.isInteger(source.materialSlot) ||
          source.materialSlot < 0 ||
          source.materialSlot > 0xffffffff
        ) {
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
          resources.push({
            bank: decoded?.bankClass ?? 0,
            sampler: sampler + (address === 0 ? 0 : address === 2 ? 1 : 2)
          });
          routes.push(route);
        }
        const lowered = lowerAppearanceWgsl(source.program);
        const kernelKey = lowered.templateKey;
        let programIndex = leaseIndices.get(kernelKey);
        if (programIndex === undefined) {
          programIndex = leaseIndices.size;
          leaseIndices.set(kernelKey, programIndex);
        }
        const resourceSetIndex = source.textureBindingSetId;
        const constantBase = constants.length;
        const inputBase = runtimeInputs.length / 4;
        for (const input of source.program.inputs) {
          const gpuInput = appearanceGeometryInputKind(input, source.program) !== 0;
          const value = gpuInput ? undefined : source.material.appearance_inputs.get(input.name);
          if (!gpuInput && value?.length !== input.width) {
            throw new RangeError(`Appearance input '${input.name}' requires ${input.width} live components`);
          }
          runtimeInputs.push(...Array.from({ length: 4 }, (_, channel) => value?.[channel] ?? 0));
        }
        const fieldBase = fields.length / (APPEARANCE_FIELD_RECORD_STRIDE / 4);
        for (const [name, outputs] of Object.entries(lowered.outputSlots)) {
          const version = source.fieldVersions === undefined ? 1 : source.fieldVersions.get(name)?.version;
          if (version === undefined || !Number.isInteger(version) || version < 1 || version > 0xffffffff)
            throw new RangeError("Appearance output field requires a nonzero u32 version");
          const dependency = source.program.outputs[name]!.reduce(
            (mask, ref) => mask | source.program.instructions[ref]!.dependency,
            0
          );
          fields.push(version, outputs[0]!, outputs.length, dependency);
          const live = new Set<number>(),
            pending = [...source.program.outputs[name]!];
          const numeric = new Set<number>();
          while (pending.length) {
            const ref = pending.pop()!;
            if (live.has(ref)) continue;
            live.add(ref);
            const instruction = source.program.instructions[ref]!;
            if (instruction.kind === "parameter") {
              for (const slot of lowered.parameterSlots[instruction.parameter!] ?? [])
                numeric.add(constantBase + slot.slot);
            }
            if (instruction.kind === "input") {
              const index = source.program.inputs.findIndex((input) => input.name === instruction.input);
              const input = source.program.inputs[index]!;
              if (appearanceGeometryInputKind(input, source.program) === 0)
                numeric.add(-1 - (inputBase + index) * 4 - instruction.channel!);
            }
            pending.push(...instruction.args);
          }
          fieldDependencies.push([...numeric]);
        }
        // Values must come from this instance even when its topology reuses a kernel.
        constants.push(...lowered.constants);
        const alpha = source.program.outputs.alpha;
        if (alpha?.length !== 1) throw new Error("Published Appearance requires a scalar coverage root");
        const coverageProgram = selectAppearanceProductProgram(source.program, { alpha });
        const coverageRouteBase = routes.length;
        const coverageResources: AppearanceSampleResourceProfile[] = [];
        for (const sample of coverageProgram.samples) {
          const ref = source.textureRefs.get(sample.binding.texture) ?? GPU_TEXTURE_REF_INVALID;
          const route = packRoute(
            sample.binding,
            ref,
            mipRanges.get(sample.binding.texture),
            texturePublications.get(sample.binding.texture)
          );
          const samplerClass = new DataView(route).getUint32(4, true);
          const address = samplerClass & GPU_MATERIAL_VISIBILITY_SAMPLER.AddressMask;
          coverageResources.push({
            bank: decodeGpuTextureRef(ref)?.bankClass ?? 0,
            sampler:
              ((samplerClass & GPU_MATERIAL_VISIBILITY_SAMPLER.LinearBit) !== 0 ? 0 : 3) +
              (address === 0 ? 0 : address === 2 ? 1 : 2)
          });
          routes.push(route);
        }
        const coverageProductBindings = new Map<string, number>(),
          coverageProductTextures: GPUTexture[] = [];
        const coverageProducts = (coverageProgram.productReads ?? []).map((read) => {
          if (read.field.constant !== undefined) return null;
          if (!staticResidency) throw new Error("Coverage products require static residency");
          const key = appearanceStaticTextureKey(read.asset, read.field)!;
          let binding = coverageProductBindings.get(key);
          if (binding === undefined) {
            binding = coverageProductBindings.size;
            coverageProductBindings.set(key, binding);
            productTargets.push({
              assetId: read.asset.runtime.manifest.assetId,
              field: read.field.name,
              textures: coverageProductTextures,
              binding
            });
          }
          const layer = read.asset.fields
            .filter((field) => appearanceStaticTextureKey(read.asset, field) === key)
            .findIndex((field) => field.name === read.field.name);
          routes.push(packProductRoute(read.asset, layer));
          assets.set(read.asset.runtime.manifest.assetId, read.asset);
          return binding;
        });
        const coverageKernel = appearanceCoverageKernel(coverageProgram, coverageResources, coverageProducts);
        const coverageConstantBase = constants.length,
          coverageInputBase = runtimeInputs.length / 4;
        constants.push(...coverageKernel.lowered.constants);
        const cutoffSlot = constants.length;
        if (!Number.isFinite(Math.fround(source.material.alpha_cutoff)))
          throw new RangeError("Coverage cutoff must be finite f32");
        constants.push(Math.max(0, Math.min(1, source.material.alpha_cutoff)));
        for (const input of coverageProgram.inputs) {
          const inputIndex = source.program.inputs.findIndex((candidate) => candidate.name === input.name);
          runtimeInputs.push(
            ...runtimeInputs.slice((inputBase + inputIndex) * 4, (inputBase + inputIndex + 1) * 4)
          );
        }
        const coverageKey =
          coverageKernel.descriptor.source +
          JSON.stringify([source.textureBindingSetId, [...coverageProductBindings.keys()]]);
        let rasterProgram = 0;
        if (source.material.transparency_mode === ShadeTransparencyMode.AlphaTested) {
          const existingProgram = coveragePrograms.get(coverageKey);
          rasterProgram = existingProgram ?? coveragePrograms.size + 1;
          if (existingProgram === undefined) coveragePrograms.set(coverageKey, rasterProgram);
        }
        const coverage: AppearancePublishedCoverage = Object.freeze({
          material: source.material,
          materialSlot: source.materialSlot,
          textureBindingSetId: source.textureBindingSetId,
          constantBase: coverageConstantBase,
          routeBase: coverageRouteBase,
          inputBase: coverageInputBase,
          program: coverageProgram,
          kernel: coverageKernel,
          productTextures: coverageProductTextures,
          productViews: [],
          rasterProgram,
          cutoffSlot,
          viewDependent: coverageProgram.inputs.some((input) =>
            [8, 9, 13, 14].includes(appearanceGeometryInputKind(input, coverageProgram))
          )
        });
        entries.push(
          Object.freeze({
            material: source.material,
            inputBase,
            materialSlot: source.materialSlot,
            textureBindingSetId: source.textureBindingSetId,
            constantBase,
            routeBase,
            programIndex,
            resourceSetIndex,
            lowered,
            program: source.program,
            fieldBase,
            coverage
          })
        );
        directory.set(
          [
            source.materialSlot,
            programIndex,
            constantBase,
            routeBase,
            resourceSetIndex,
            fieldBase,
            Object.keys(lowered.outputSlots).length,
            inputBase
          ],
          index * directoryWords
        );
      }
      const constantData = new Float32Array(Math.max(constants.length, 1));
      constantData.set(constants);
      const routeData = new Uint8Array(Math.max(routes.length, 1) * APPEARANCE_ROUTE_STRIDE);
      routes.forEach((route, index) => routeData.set(new Uint8Array(route), index * APPEARANCE_ROUTE_STRIDE));
      const directoryData = sources.length === 0 ? new Uint32Array(directoryWords) : directory;
      const fieldData = new Uint32Array(Math.max(fields.length, APPEARANCE_FIELD_RECORD_STRIDE / 4));
      fieldData.set(fields);
      const inputData = new Float32Array(Math.max(runtimeInputs.length, 4));
      inputData.set(runtimeInputs);
      const maxMaterialSlot = Math.max(0, ...sources.map((source) => source.materialSlot));
      const materialLookupData = new Uint32Array(maxMaterialSlot + 1);
      materialLookupData.fill(0xffffffff);
      if (this.surfaceCacheGeneration >= 0xffffffff) {
        throw new RangeError("Surface publication identity exhausted; recreate device");
      }
      sources.forEach((source, index) => {
        materialLookupData[source.materialSlot] = index;
      });
      this.surfaceExecutionProfiles = Object.freeze(
        sources.map((source) =>
          appearanceExecutionProfiles(source.program, (witness) => registry.internFieldPublication(witness))
        )
      );
      const runtimeInputsOffset = materialLookupData.length;
      const constantsOffset = runtimeInputsOffset + inputData.length;
      const routesOffset = constantsOffset + constantData.length;
      const paletteOffset = routesOffset + routeData.byteLength / 4;
      const radiometryOffset = paletteOffset + Math.max(1, sources.length) * 64;
      const surfaceMetadataOffsets = {
        materialLookup: 0,
        runtimeInputs: runtimeInputsOffset,
        constants: constantsOffset,
        routes: routesOffset,
        constantFields: paletteOffset,
        radiometry: radiometryOffset,
        exactFieldOffsets: radiometryOffset + 5,
        materialLookupCount: materialLookupData.length
      } as const;
      // GPU publication substage fills one submitted-epoch constant palette per
      // material. The immutable descriptor/input ranges precede this write domain.
      let surfaceMetadataData = new Uint32Array(radiometryOffset + 5 + 16);
      surfaceMetadataData.set(materialLookupData, surfaceMetadataOffsets.materialLookup);
      surfaceMetadataData.set(
        new Uint32Array(inputData.buffer, inputData.byteOffset, inputData.length),
        surfaceMetadataOffsets.runtimeInputs
      );
      surfaceMetadataData.set(new Uint32Array(constantData.buffer), surfaceMetadataOffsets.constants);
      surfaceMetadataData.set(new Uint32Array(routeData.buffer), surfaceMetadataOffsets.routes);
      const maximum = Math.min(
        Number(device.limits.maxBufferSize),
        Number(device.limits.maxStorageBufferBindingSize)
      );
      for (const data of [
        constantData,
        routeData,
        directoryData,
        fieldData,
        inputData,
        materialLookupData,
        surfaceMetadataData
      ])
        if (data.byteLength > maximum) {
          throw new RangeError(
            `Appearance publication ${data.byteLength} bytes exceed negotiated storage limit ${maximum}`
          );
        }
      // Publication byte admission precedes every shader/layout/pipeline/buffer creation.
      const exactData = packAppearanceDagPublication(
        entries.map((entry, index) => ({
          program: entry.program,
          lowered: entry.lowered,
          constantBase: entry.constantBase,
          routeBase: entry.routeBase,
          inputBase: entry.inputBase,
          textureBindingSetId: entry.textureBindingSetId,
          domainHandle: this.surfaceExecutionProfiles[index]!.token
        })),
        maximum,
        maximum,
        surfaceMetadataData.length
      );
      this.uniformFlagBase = exactData.uniformFlagBase;
      this.uniformDependencies = exactData.uniformDependencies;
      this.hasFrameUniform = exactData.hasFrameUniform;
      this.workPlans = exactData.workPlans;
      this.uniformResourceSetMask = exactData.uniformResourceSetMask;
      this.publicationSetMask = entries.reduce((mask, entry) => mask | (1 << entry.textureBindingSetId), 0);
      this.uniformResources = exactData.workPlans.map((plan, index) =>
        Array.from(plan.uniformTextureQueries).flatMap((query) => {
          const publication = texturePublications.get(
            entries[index]!.program.samples[query]!.binding.texture
          );
          return publication === undefined
            ? []
            : [{ publication, revision: publication.currentRevision ?? publication.revision }];
        })
      );
      this.uniformQueryStatsBase = surfaceMetadataData.length + exactData.uniformWords;
      const uniformMetadata = new Uint32Array(
        this.uniformQueryStatsBase + (this.uniformResourceSetMask !== 0 ? entries.length * 2 : 0)
      );
      uniformMetadata.set(surfaceMetadataData);
      surfaceMetadataData = uniformMetadata;
      if (surfaceMetadataData.byteLength > maximum) {
        throw new RangeError("Complete Appearance uniform products exceed negotiated metadata binding");
      }
      let fixedWords = 0;
      for (let entry = 0; entry < entries.length; entry++) {
        if ((exactData.code[entry * 16 + 13]! & 0x80000000) !== 0) {
          fixedWords = Math.max(fixedWords, exactData.code[exactData.code[entry * 16]! - 1]! * 9);
        }
      }
      this.surfaceWorkScratchWords = Math.max(exactData.liveWords, fixedWords);
      const exactPlan = planExactAppearanceLanes(
        this.surfaceWorkScratchWords,
        Math.min(maximum, 16 * 1024 * 1024),
        maximumConcurrentSamples
      );
      for (const entry of entries) {
        if (
          !Number.isInteger(entry.textureBindingSetId) ||
          entry.textureBindingSetId < 0 ||
          entry.textureBindingSetId >= TEXTURE_BINDING_SET_MAX_RESIDENT_SETS
        ) {
          throw new RangeError("Appearance references an unnegotiated texture binding set");
        }
      }
      const workDescriptors = [
        appearancePublicationExactDescriptor(this.uniformResourceSetMask !== 0),
        surfaceWorkDescriptor(false, true),
        surfaceWorkDescriptor(false, false),
        surfaceWorkDescriptor(true, true),
        surfaceWorkDescriptor(true, false)
      ];
      for (const descriptor of workDescriptors) {
        registry.preflight(descriptor);
      }
      this.exactDagCode = this.upload(device, command, "exact-dag-code", exactData.code);
      this.exactDagProducts = Object.freeze(
        exactData.products.map((data, bank) =>
          this.upload(device, command, "exact-dag-products-" + bank, data)
        )
      );
      this.exactDagProductBankWords = exactData.productBankWords;
      this.exactDagLiveWords = exactData.liveWords;
      this.exactDagLanes = exactPlan.lanes;
      this.exactDagScratchBytes = exactPlan.bytes;
      this.surfaceDomainCount = exactData.domainCount;
      this.surfaceTemplateCount = exactData.templateCount;
      this.surfaceCoherenceSetMask = exactData.coherenceSetMask;
      this.surfaceHasLit = entries.some((_entry, index) => exactData.code[index * 16 + 15] !== 0);
      const workProfiles = Array<boolean>(8).fill(false);
      for (let entry = 0; entry < entries.length; entry++) {
        const profile =
          exactData.code[entry * 16 + 8]! * 2 + Number((exactData.code[entry * 16 + 13]! & 0x80000000) === 0);
        workProfiles[profile] = true;
      }
      this.surfaceWorkProfiles = Object.freeze(workProfiles);
      let varying = 0;
      for (let entry = 0; entry < entries.length; entry++) {
        varying |= exactData.code[entry * 16 + 12]! & ~exactData.code[entry * 16 + 13]!;
      }
      varying &= SURFACE_WORK_RETAINED_FIELDS;
      this.exactDagVaryingFields = varying;
      let channels = 0;
      const fieldOffsets = APPEARANCE_FIELD_WIDTHS.map((width, field) => {
        if ((varying & (1 << field)) === 0) {
          return 0xffffffff;
        }
        const offset = channels;
        channels += width;
        return offset;
      });
      this.exactDagFieldOffsetValues = Object.freeze(fieldOffsets);
      surfaceMetadataData.set([...fieldOffsets, channels], surfaceMetadataOffsets.exactFieldOffsets);
      for (const descriptor of workDescriptors) {
        this.surfaceLeases.push(registry.acquire(descriptor));
      }
      const assetLeases = new Map<string, AppearanceStaticLease>();
      for (const [id, asset] of assets) {
        const lease = staticResidency!.acquire(asset, command);
        this.staticLeases.push(lease);
        assetLeases.set(id, lease);
      }
      for (const target of productTargets)
        target.textures[target.binding] = assetLeases.get(target.assetId)!.destination(target.field).texture;
      for (const target of productRouteTargets) {
        const summary = assetLeases.get(target.assetId)!.variation(target.field);
        if (!summary) continue;
        const view = new DataView(
          routeData.buffer,
          target.route * APPEARANCE_ROUTE_STRIDE,
          APPEARANCE_ROUTE_STRIDE
        );
        view.setUint32(4, summary.slot, true);
        view.setUint32(8, summary.generation, true);
        view.setUint32(12, summary.revision, true);
      }
      surfaceMetadataData.set(new Uint32Array(routeData.buffer), surfaceMetadataOffsets.routes);
      for (const entry of entries) {
        Object.freeze(entry.coverage.productTextures);
        (entry.coverage.productViews as GPUTextureView[]).push(
          ...entry.coverage.productTextures.map((texture) => texture.createView({ dimension: "2d-array" }))
        );
        Object.freeze(entry.coverage.productViews);
      }
      this.constants = this.upload(device, command, "constants", constantData);
      this.routes = this.upload(device, command, "routes", routeData);
      this.runtimeInputs = this.upload(device, command, "runtime-inputs", inputData);
      this.surfaceMetadata = this.upload(device, command, "surface-metadata", surfaceMetadataData);
      this.surfaceMetadataOffsets = Object.freeze(surfaceMetadataOffsets);
      const coverageDirectoryData = new Uint32Array(((maxMaterialSlot + 1) * COVERAGE_DIRECTORY_STRIDE) / 4);
      if (coverageDirectoryData.byteLength > maximum)
        throw new RangeError("Coverage directory exceeds negotiated storage limit");
      entries.forEach((entry) =>
        coverageDirectoryData.set(
          [
            entry.coverage.constantBase,
            entry.coverage.routeBase,
            entry.coverage.inputBase,
            entry.coverage.rasterProgram
          ],
          entry.materialSlot * 4
        )
      );
      this.coverageDirectory = this.upload(device, command, "coverage-directory", coverageDirectoryData);
      this.constantValues = constantData;
      this.inputValues = inputData;
      this.fieldWords = fieldData;
      this.fieldDependencies = fieldDependencies;
      this.entries = Object.freeze(entries);
      this.surfaceProgramCount = 2;
      for (let family = 0; family < 1; family++) {
        const label = `GpuAppearancePublication/Surface texture-set settings ${family}`;
        const settings = device.createBuffer({
          label,
          size: 48,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this.buffers.push(settings);
        this.surfaceSettings.push(settings);
        if (accounting !== undefined) {
          this.accountingHandles.push(
            accounting.created({
              kind: "buffer",
              category: "resident",
              owner: "GpuAppearancePublication",
              label,
              bytes: 48
            })
          );
        }
      }
      this.allocatedBytes = this.buffers.reduce((bytes, buffer) => bytes + buffer.size, 0);
      let cancel!: (reason: Error) => void;
      const cancellation = new Promise<never>((_resolve, reject) => {
        cancel = reject;
      });
      this.cancelReadiness = cancel;
      this.ready = Promise.race([
        cancellation,
        Promise.all([Promise.all(this.surfaceLeases.map((lease) => lease.ready))]).then(
          ([surfacePipelines]) => {
            if (this.state !== "staging")
              throw new Error("Appearance publication cancelled before program readiness");
            this.surfacePipelines = Object.freeze(surfacePipelines);
            this.state = "ready";
          }
        )
      ]);
      void this.ready.catch(() => undefined);
      command.onBeforeFinish.addOne(() => {
        if (this.state !== "ready")
          throw new Error("Appearance programs must be ready before scene submission");
      });
      command.onFinished.addOne(() => {
        if (this.state === "ready") this.state = "resident";
      });
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
    if (
      command.device !== this.device ||
      command.closed ||
      (this.state !== "ready" && this.state !== "resident")
    )
      throw new Error("Appearance edits require an open resident frame");
    const constants = this.constantValues.slice(),
      inputs = this.inputValues.slice();
    const parameters = new Map<StandardShadeMaterial, ReadonlyMap<string, number>>();
    for (const entry of [...this.entries, ...this.entries.map((entry) => entry.coverage)]) {
      if ("cutoffSlot" in entry) {
        if (!Number.isFinite(Math.fround(entry.material.alpha_cutoff)))
          throw new RangeError("Coverage cutoff must be finite f32");
        constants[entry.cutoffSlot] = Math.max(0, Math.min(1, entry.material.alpha_cutoff));
      }
      let values = parameters.get(entry.material);
      if (!values) {
        values = standardAppearanceParameters(entry.material);
        parameters.set(entry.material, values);
      }
      for (const [name, slots] of Object.entries(
        ("lowered" in entry ? entry.lowered : entry.kernel.lowered).parameterSlots
      )) {
        const authored = entry.material.appearance_inputs.get(name);
        for (const slot of slots) {
          const value =
            authored?.[slot.channel] ?? values.get(name) ?? constants[entry.constantBase + slot.slot]!;
          if (!Number.isFinite(Math.fround(value)))
            throw new RangeError(`Appearance parameter '${name}' is not finite f32`);
          constants[entry.constantBase + slot.slot] = value;
        }
      }
      entry.program.inputs.forEach((input, index) => {
        if (appearanceGeometryInputKind(input, entry.program) !== 0) return;
        const value = entry.material.appearance_inputs.get(input.name);
        if (value?.length !== input.width)
          throw new RangeError(`Appearance input '${input.name}' width changed`);
        inputs.set(value, (entry.inputBase + index) * 4);
      });
    }
    const changed = new Set<number>();
    for (let i = 0; i < constants.length; i++)
      if (!Object.is(constants[i], this.constantValues[i])) changed.add(i);
    for (let i = 0; i < inputs.length; i++)
      if (!Object.is(inputs[i], this.inputValues[i])) changed.add(-1 - i);
    const coverageChanged = this.entries.some(({ coverage }) => {
      if (coverage.material.transparency_mode !== ShadeTransparencyMode.AlphaTested) return false;
      if (changed.has(coverage.cutoffSlot)) return true;
      for (let slot = 0; slot < coverage.kernel.lowered.constants.length; slot++)
        if (changed.has(coverage.constantBase + slot)) return true;
      for (let slot = 0; slot < coverage.program.inputs.length * 4; slot++)
        if (changed.has(-1 - coverage.inputBase * 4 - slot)) return true;
      return false;
    });
    if (changed.size === 0) return false;
    let uniformsChanged = false;
    for (let entry = 0; entry < this.uniformDependencies.length; entry++) {
      if (this.uniformDependencies[entry]!.some((ref) => changed.has(ref))) {
        this.uniformFlags[entry]! |= 2;
        uniformsChanged = true;
      }
    }
    if (uniformsChanged) {
      if (this.uniformRevision >= 0xffffffff) {
        throw new RangeError("Appearance uniform version exhausted; republish the scene");
      }
      this.uniformRevision++;
    }
    const fields = this.fieldWords.slice();
    this.fieldDependencies.forEach((dependencies, field) => {
      if (!dependencies.some((ref) => changed.has(ref))) return;
      const word = field * 4;
      if (fields[word] === 0xffffffff)
        throw new RangeError("Appearance field version exhausted; republish the scene");
      fields[word] = fields[word]! + 1;
    });
    for (const [buffer, data] of [
      [this.constants, constants],
      [this.runtimeInputs, inputs]
    ] as const) {
      command.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
    }
    command.writeBuffer(
      this.surfaceMetadata,
      this.surfaceMetadataOffsets.runtimeInputs * 4,
      inputs.buffer,
      inputs.byteOffset,
      inputs.byteLength
    );
    command.writeBuffer(
      this.surfaceMetadata,
      this.surfaceMetadataOffsets.constants * 4,
      constants.buffer,
      constants.byteOffset,
      constants.byteLength
    );
    command.onFinished.addOne(() => {
      this.constantValues = constants;
      this.inputValues = inputs;
      this.fieldWords = fields;
    });
    return coverageChanged;
  }

  get viewDependentCoverage(): boolean {
    return this.entries.some(
      (entry) =>
        entry.coverage.viewDependent && entry.material.transparency_mode === ShadeTransparencyMode.AlphaTested
    );
  }

  /** One exact generic execution scope per negotiated residency set. */
  workPipeline(product: boolean, common = false): Awaited<AppearanceProgramLease["ready"]> {
    const ready = this.surfacePipelines?.[1 + (product ? 2 : 0) + (common ? 0 : 1)];
    if (ready === undefined || (this.state !== "ready" && this.state !== "resident")) {
      throw new Error("Surface Geometry/Appearance family is not ready");
    }
    return ready;
  }

  encodeWorkPublication(
    command: ShadeGPUCommandContext,
    scratch: GPUBuffer,
    frame: number,
    camera: GPUBuffer,
    textureBanks?: readonly (readonly GPUTextureView[])[],
    diagnostics = false
  ): void {
    const ready = this.surfacePipelines?.[0];
    if (
      ready === undefined ||
      command.closed ||
      command.device !== this.device ||
      (this.state !== "ready" && this.state !== "resident")
    ) {
      throw new Error("Surface constant publication requires ready same-device programs");
    }
    this.refreshUniformResources();
    if (!this.hasFrameUniform && this.committedUniformRevision === this.uniformRevision) {
      return;
    }
    const revision = this.uniformRevision;
    const resources = this.uniformResourceSetMask !== 0;
    const sets = resources ? [0, 1, 2, 3].filter((set) => (this.publicationSetMask & (1 << set)) !== 0) : [0];
    if (resources && sets.some((set) => textureBanks?.[set]?.length !== 9)) {
      throw new Error("Resource uniform update requires complete resident bank sets");
    }
    command.writeBuffer(
      this.surfaceMetadata,
      this.uniformFlagBase * 4,
      this.uniformFlags.buffer,
      0,
      this.uniformFlags.byteLength
    );
    for (const set of sets) {
      const settings = this.surfaceSettings[0]!;
      const offsets = this.surfaceMetadataOffsets;
      command.writeBuffer(
        settings,
        0,
        new Uint32Array([
          this.entries.length,
          offsets.constantFields,
          offsets.constants,
          offsets.runtimeInputs,
          this.exactDagLanes,
          this.exactDagLiveWords,
          frame,
          diagnostics && resources ? this.uniformQueryStatsBase : 0,
          offsets.routes,
          this.exactDagProductBankWords,
          set,
          0
        ]).buffer,
        0,
        48
      );
      const group = this.obtainSurfaceBindGroup(ready.layouts[0]!, [
        { binding: 0, resource: { buffer: this.exactDagCode } },
        { binding: 1, resource: { buffer: this.surfaceMetadata } },
        { binding: 2, resource: { buffer: scratch } },
        { binding: 3, resource: { buffer: settings } },
        { binding: 4, resource: { buffer: camera } },
        ...(resources
          ? this.exactDagProducts.map((buffer, index) => ({ binding: index + 5, resource: { buffer } }))
          : [])
      ]);
      const pass = command.beginComputePass({ label: "Surface/publication constants" });
      pass.setPipeline(ready.pipeline);
      pass.setBindGroup(0, group);
      if (resources) {
        const banks = textureBanks?.[set];
        pass.setBindGroup(1, this.obtainSurfaceBindGroup(ready.layouts[1]!, this.workTextureEntries(banks!)));
      }
      pass.dispatchWorkgroups(Math.ceil(Math.min(this.exactDagLanes, this.entries.length) / 64));
      pass.end();
    }
    command.onFinished.addOne(() => {
      this.committedUniformRevision = revision;
      if (this.uniformRevision === revision) {
        this.uniformFlags.fill(0);
      }
    });
  }

  private refreshUniformResources(): void {
    let changed = false;
    for (let entry = 0; entry < this.uniformResources.length; entry++) {
      for (const resource of this.uniformResources[entry]!) {
        const revision = resource.publication.currentRevision ?? resource.publication.revision;
        if (resource.revision !== revision) {
          resource.revision = revision;
          this.uniformFlags[entry]! |= 2;
          changed = true;
        }
      }
    }
    if (changed) {
      if (this.uniformRevision >= 0xffffffff) {
        throw new RangeError("Appearance uniform resource version exhausted; republish the scene");
      }
      this.uniformRevision++;
    }
  }

  workTextureEntries(banks: readonly GPUTextureView[]): GPUBindGroupEntry[] {
    const entries: GPUBindGroupEntry[] = [];
    for (let bank = 0; bank < 9; bank++) {
      if (banks[bank] === undefined) {
        throw new Error("Surface resident bank is missing");
      }
      entries.push({ binding: bank, resource: banks[bank]! });
    }
    for (let sampler = 0; sampler < 6; sampler++) {
      entries.push({ binding: sampler + 9, resource: this.samplers[sampler]! });
    }
    return entries;
  }

  private obtainSurfaceBindGroup(
    layout: GPUBindGroupLayout,
    entries: readonly GPUBindGroupEntry[]
  ): GPUBindGroup {
    if (entries.length === 0) {
      let group = this.surfaceEmptyBindings.get(layout);
      if (group === undefined) {
        group = this.device.createBindGroup({ layout, entries });
        this.surfaceEmptyBindings.set(layout, group);
      }
      return group;
    }
    let cache = this.surfaceBindings.get(layout);
    if (cache === undefined) {
      cache = new GpuBindGroupResourceCache();
      this.surfaceBindings.set(layout, cache);
    }
    return cache.obtain(
      entries.map((entry) => entry.resource),
      () => this.device.createBindGroup({ layout, entries })
    );
  }

  evidence(): Readonly<{
    allocatedBytes: number;
    residentBytes: number;
    retiringBytes: number;
    stagingBytes: number;
  }> {
    const bytes = this.state === "destroyed" ? 0 : this.allocatedBytes;
    return Object.freeze({
      allocatedBytes: bytes,
      residentBytes: this.state === "resident" ? bytes : 0,
      retiringBytes: this.state === "retiring" ? bytes : 0,
      stagingBytes: this.state === "staging" || this.state === "ready" ? bytes : 0
    });
  }

  onDestroyed(callback: () => void): void {
    if (this.state === "destroyed") callback();
    else this.destroyedListeners.add(callback);
  }

  /** Abort preserves the old publication; committed release retires after GPU completion. */
  release(command: ShadeGPUCommandContext): void {
    if (
      this.state !== "resident" ||
      this.releasing !== null ||
      command.closed ||
      command.device !== this.device
    ) {
      throw new Error("Appearance release requires one open resident transaction on its GPUDevice");
    }
    this.releasing = command;
    command.onAborted.addOne(() => {
      this.releasing = null;
    });
    command.onFinished.addOne(() => {
      this.state = "retiring";
      void command.gpuDone.then(
        () => this.destroy(),
        () => this.destroy()
      );
    });
  }

  destroy(): void {
    if (this.state === "destroyed") return;
    this.state = "destroyed";
    this.unwatchRegistry?.();
    this.unwatchRegistry = null;
    this.cancelReadiness(new Error("Appearance publication cancelled or destroyed"));
    this.surfacePipelines = null;
    this.surfaceBindings.clear();
    this.surfaceEmptyBindings.clear();
    for (const buffer of this.buffers) buffer.destroy();
    for (const handle of this.accountingHandles) this.accounting?.destroyed(handle);
    for (const lease of this.surfaceLeases) lease.release();
    for (const lease of this.staticLeases) lease.release();
    for (const callback of this.destroyedListeners) callback();
    this.destroyedListeners.clear();
  }

  private upload(
    device: GPUDevice,
    command: ShadeGPUCommandContext,
    name: string,
    data: Float32Array | Uint8Array | Uint32Array
  ): GPUBuffer {
    const label = `GpuAppearancePublication/${name}`;
    const buffer = device.createBuffer({
      label,
      size: data.byteLength,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        (name === "surface-metadata" || name === "exact-dag-code" ? GPUBufferUsage.COPY_SRC : 0)
    });
    this.buffers.push(buffer);
    if (this.accounting !== undefined)
      this.accountingHandles.push(
        this.accounting.created({
          kind: "buffer",
          category: "resident",
          owner: "GpuAppearancePublication",
          label,
          bytes: data.byteLength
        })
      );
    command.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    return buffer;
  }
}

function packProductRoute(asset: AppearanceAssetPackage, layer: number): ArrayBuffer {
  const data = new ArrayBuffer(APPEARANCE_ROUTE_STRIDE),
    view = new DataView(data);
  view.setUint32(0, layer, true);
  const mapping = [
    ...asset.domainMin,
    ...asset.domainMax.map((max, axis) => 1 / (max - asset.domainMin[axis]!))
  ];
  if (!mapping.every((value) => Number.isFinite(Math.fround(value))))
    throw new RangeError("Appearance product coordinate mapping exceeds f32 publication range");
  mapping.forEach((value, index) => view.setFloat32(16 + index * 4, value, true));
  return data;
}

function packRoute(
  binding: CompiledAppearanceGraph["samples"][number]["binding"],
  ref: number,
  mipRange: readonly [number, number] | undefined,
  publication: TextureSurfacePublication | undefined
): ArrayBuffer {
  // Sampling author state is the compilation snapshot, not a later mutable texture.
  const samplerSnapshot = {
    wrapS: binding.sampler[4],
    wrapT: binding.sampler[5],
    minFilter: binding.sampler[1],
    magFilter: binding.sampler[2],
    runtime_asset_package_v2: binding.texture.runtime_asset_package_v2
  } as ShadeTexture;
  const sampler = encodeSamplerClass(samplerSnapshot, mipRange);
  const data = new ArrayBuffer(APPEARANCE_ROUTE_STRIDE);
  const view = new DataView(data);
  [ref, sampler.value, publication?.slot ?? 0, publication?.revision ?? 0].forEach((value, index) =>
    view.setUint32(index * 4, value, true)
  );
  const values = [
    ...binding.offset,
    ...binding.scale,
    Math.cos(binding.rotation),
    Math.sin(binding.rotation),
    0,
    0,
    ...binding.fallback
  ];
  values.forEach((value, index) => view.setFloat32(16 + index * 4, value, true));
  // Rotation's unused lanes carry exact local-summary identity, not f32 values.
  view.setUint32(40, publication?.generation ?? 0, true);
  // All selectable package formats must provide this numeric bound. Float/HDR
  // packages remain unproved; author-declared ranges are not a certificate.
  const asset = binding.texture.runtime_asset_package_v2;
  const normalized =
    asset === undefined ||
    asset.variants.every(
      (variant) => variant.format.endsWith("unorm") || variant.format.endsWith("unorm-srgb")
    );
  view.setUint32(44, normalized ? 1 : 0, true);
  return data;
}

function surfaceWorkDescriptor(product: boolean, common: boolean): AppearanceProgramDescriptor {
  const textureEntries: GPUBindGroupLayoutEntry[] = [];
  for (let binding = 0; binding < 9; binding++) {
    textureEntries.push({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType: "float", viewDimension: "2d-array" }
    });
  }
  for (let sampler = 0; sampler < 6; sampler++) {
    textureEntries.push({
      binding: 9 + sampler,
      visibility: GPUShaderStage.COMPUTE,
      sampler: { type: "filtering" }
    });
  }
  const sources: GPUBindGroupLayoutEntry[] = [];
  for (let binding = 0; binding < (product ? 9 : 4); binding++) {
    sources.push({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } });
  }
  sources.push(
    { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 128 } }
  );
  const data: GPUBindGroupLayoutEntry[] = [];
  for (let binding = 0; binding < 7; binding++) {
    data.push({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: binding === 2 || binding === 3 || binding === 6 ? "storage" : "read-only-storage" }
    });
  }
  return {
    source: surfaceWorkAppearanceWgsl(product, common),
    entryPoint: "appearance",
    workgroupSize: 64,
    groups: [sources, data, textureEntries]
  };
}
