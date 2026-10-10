import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import { APPEARANCE_DEPENDENCY } from "../material/AppearanceGraphCompiler.js";
import { standardAppearanceParameters } from "../material/AppearanceRuntimeInputs.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { observeNativeMaterial } from "../material/NativeMaterialMutation.js";
import { ShadeTransparencyMode } from "../material/enums.js";
import {
  lowerNativeMaterial,
  nativeMaterialDynamicInputs,
  nativeMaterialParameters,
} from "../shaders/native_material.js";
import {
  nativeSurfaceMaterialGraph,
  nativeSurfaceBindingGroups,
  nativeSurfacePublicationDescriptors,
} from "../shaders/native_surface.js";
import { nativeVisibilityShader } from "../shaders/native_visibility.js";
import { nativeVisibilityPipelineDescriptor } from "../render/surface/NativeVisibilityPass.js";
import type { NativeSurfaceRoute } from "../render/surface/SurfaceV4.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import {
  GpuNativeMaterialPublication,
  type NativeMaterialPublicationSource,
} from "./GpuNativeMaterialPublication.js";
import {
  createNativeMaterialBindings,
  createNativeCoverageBindings,
  nativeMaterialCoverageProgram,
  type NativeMaterialBindings,
} from "./NativeMaterialBindings.js";
import { NativeMaterialProducts } from "./NativeMaterialProducts.js";
import type { TextureBindingSet } from "./TextureResidency.js";
import type { TextureSurfacePublication } from "./TextureSurfacePublication.js";
import {
  nativeMaterialRequiredBanks,
  planNativeMaterialPhysicalBanks,
  type NativeMaterialPhysicalBankProfile,
} from "./NativeMaterialPhysicalBanks.js";

export interface NativeSceneMaterialSource {
  readonly materialSlot: number;
  readonly material: StandardShadeMaterial;
  readonly textureBindingSetId: number;
  readonly graph: CompiledAppearanceGraph;
  readonly textureRefs: ReadonlyMap<ShadeTexture, number>;
}

interface Snapshot {
  readonly revision: number;
  readonly publication: GpuNativeMaterialPublication;
  readonly sources: readonly NativeMaterialPublicationSource[];
  readonly bindings: readonly NativeMaterialBindings[];
  readonly values: readonly Float32Array<ArrayBuffer>[];
  readonly unlit: readonly boolean[];
  readonly routes: readonly NativeSurfaceRoute[];
  readonly viewDependentCoverage: boolean;
  readonly hasMask: boolean;
  readonly hasLit: boolean;
  ready: boolean;
}

interface MaterialBindingSnapshot {
  readonly identity: readonly unknown[];
  readonly bindings: NativeMaterialBindings;
}

/** Scene publication of native programs, instance data and exact resource sets.
 * No Surface intermediate, scheduler, submit or old publication is involved.
 * CPU edits build an immutable candidate. Only a successful frame transaction
 * advances the active pointer; abort keeps the candidate available for retry.
 * Pipeline readiness is polled before the synchronous production frame begins.
 */
export class GpuNativeMaterialScene {
  readonly ready: Promise<void>;
  readonly products: NativeMaterialProducts | null;
  private active: Snapshot | null = null;
  private candidate: Snapshot | null = null;
  private prepared: Snapshot | null = null;
  private error: unknown;
  private stopped = false;
  private resident = false;
  private lastCompletion: Promise<void> = Promise.resolve();
  private readonly retiring = new Set<Snapshot>();
  private readonly listeners = new Set<() => void>();
  // One immutable code/resource binding per authored material source. Numeric
  // frame inputs remain live and are checked separately by snapshot().
  private readonly materialBindings: (MaterialBindingSnapshot | undefined)[] = [];
  private nextRevision = 1;
  private dirty = true;
  private readonly detachMutations: (() => void)[] = [];

  constructor(
    private readonly graphics: GraphicsContext,
    private readonly materialSources: readonly NativeSceneMaterialSource[],
    private readonly bindingSets: () => readonly TextureBindingSet[],
    private readonly mipRanges: ReadonlyMap<ShadeTexture, readonly [number, number]>,
    private readonly texturePublications: ReadonlyMap<ShadeTexture, TextureSurfacePublication>,
    command: ShadeGPUCommandContext,
    private readonly productGeometry: boolean,
    private readonly physicalSun: boolean,
  ) {
    if (command.closed || command.device !== graphics.device) {
      throw new Error("Native scene publication requires its open upload transaction");
    }
    const graphs = materialSources.map((source) => source.graph);
    this.products = graphs.some((graph) =>
      graph.productReads?.some((read) => read.field.constant === undefined),
    )
      ? new NativeMaterialProducts(
          graphics.device,
          graphs,
          command,
          undefined,
          undefined,
          graphics.resource_accounting,
        )
      : null;
    try {
      const changed = () => {
        this.dirty = true;
      };
      for (const source of materialSources)
        this.detachMutations.push(observeNativeMaterial(source.material, changed));
      const residency = graphics.texture_residency;
      if (residency?.onPublicationChanged)
        this.detachMutations.push(residency.onPublicationChanged.subscribe(changed));
      const initial = this.snapshot();
      this.dirty = false;
      this.candidate = initial;
      this.ready = Promise.all([initial.publication.ready, this.prepareRasterPrograms(initial)]).then(() => {
        if (this.stopped) {
          throw new Error("Native scene publication stopped during pipeline preparation");
        }
        initial.ready = true;
      });
      void this.ready.catch(() => undefined);
      command.onBeforeFinish.addOne(() => {
        if (!initial.ready || this.stopped) {
          throw new Error("Native scene programs must be ready before upload submission");
        }
      });
      command.onFinished.addOne(() => {
        initial.publication.commit();
        this.active = initial;
        this.candidate = null;
        this.resident = true;
        this.lastCompletion = command.gpuDone;
      });
      command.onAborted.addOne(() => this.destroy());
    } catch (error) {
      this.detachMutations.forEach((detach) => detach());
      this.products?.destroy();
      throw error;
    }
    void graphics.device.lost.then(() => this.destroy());
  }

  get publication(): GpuNativeMaterialPublication {
    const snapshot = this.prepared ?? this.candidate ?? this.active;
    if (snapshot === null || this.stopped) {
      throw new Error("Native scene has no available publication");
    }
    return snapshot.publication;
  }

  get revision(): number {
    return (this.prepared ?? this.candidate ?? this.active)?.revision ?? 0;
  }

  get bindings(): readonly NativeMaterialBindings[] {
    const snapshot = this.prepared ?? this.candidate ?? this.active;
    if (snapshot === null || this.stopped) {
      throw new Error("Native scene has no material binding snapshot");
    }
    return snapshot.bindings;
  }

  get viewDependentCoverage(): boolean {
    return (this.prepared ?? this.candidate ?? this.active)?.viewDependentCoverage ?? false;
  }

  /** Lighting demand follows the same candidate/commit owner as native code. */
  get hasLit(): boolean {
    return (this.prepared ?? this.candidate ?? this.active)?.hasLit ?? false;
  }

  get routes(): readonly NativeSurfaceRoute[] {
    const snapshot = this.prepared ?? this.candidate ?? this.active;
    if (snapshot === null || this.stopped) {
      throw new Error("Native scene has no routes");
    }
    return snapshot.routes;
  }

  /** No GPU work/control readback. A not-yet-ready candidate defers the entire tick. */
  canPrepareFrame(): boolean {
    if (this.error !== undefined) {
      throw this.error;
    }
    if (!this.resident || this.stopped || this.prepared !== null) {
      throw new Error("Native scene is unavailable or already prepared");
    }
    if (!this.dirty) return (this.candidate ?? this.active!).ready;
    const next = this.snapshot(this.candidate ?? this.active!);
    this.dirty = false;
    if (next !== this.candidate && next !== this.active) {
      this.candidate?.publication.abort();
      this.candidate = next;
      void Promise.all([next.publication.ready, this.prepareRasterPrograms(next)]).then(
        () => {
          next.ready = true;
        },
        (error: unknown) => {
          if (this.candidate === next && !this.stopped) {
            this.error = error;
          }
        },
      );
    }
    return (this.candidate ?? this.active!).ready;
  }

  /** Returns alpha invalidation conservatively; the VSM owner owns its history. */
  prepareFrame(command: ShadeGPUCommandContext): boolean {
    const selected = this.candidate ?? this.active;
    if (selected === null || !selected.ready || this.prepared !== null || command.closed) {
      throw new Error("Native scene frame requires a completely ready publication");
    }
    this.prepared = selected;
    const changed = selected !== this.active;
    command.onFinished.addOne(() => {
      if (selected !== this.active) {
        selected.publication.commit();
        const previous = this.active;
        if (previous !== null) {
          this.retiring.add(previous);
          void previous.publication.retire(this.lastCompletion).then(
            () => this.retiring.delete(previous),
            () => this.retiring.delete(previous),
          );
        }
        this.active = selected;
        if (this.candidate === selected) {
          this.candidate = null;
        }
      }
      this.prepared = null;
      this.lastCompletion = command.gpuDone;
    });
    command.onAborted.addOne(() => {
      this.prepared = null;
    });
    return changed && selected.hasMask;
  }

  private snapshot(previous?: Snapshot): Snapshot {
    const bindings: NativeMaterialBindings[] = [];
    const unlit: boolean[] = [];
    const sources: Omit<NativeMaterialPublicationSource, "bindingSet" | "descriptor">[] = [];
    const values: Float32Array<ArrayBuffer>[] = [];
    const bindingSets = this.bindingSets();
    const resolved = this.materialSources.map((source) => {
      const set = bindingSets.find((set) => set.id === source.textureBindingSetId);
      if (!set) throw new Error("Native material texture set is not resident");
      const graph = nativeSurfaceMaterialGraph(source.graph, source.material.is_unlit);
      const groups = nativeSurfaceBindingGroups([], {
        compact: true,
        productGeometry: this.productGeometry,
        reactive: true,
        unlit: source.material.is_unlit,
        physicalSun: this.physicalSun && !source.material.is_unlit,
      });
      const providers = groups.reduce((sum, group) => sum + group.filter((entry) => entry.texture).length, 0);
      const productTextures = graph.productReads?.some((read) => read.field.constant === undefined) ? 1 : 0;
      return {
        set,
        graph,
        limit: Math.min(
          16,
          this.graphics.device.limits.maxSampledTexturesPerShaderStage - providers - productTextures,
        ),
      };
    });
    const profiles = planNativeMaterialPhysicalBanks(
      resolved.map((entry, index) => ({
        banks: nativeMaterialRequiredBanks(
          entry.graph,
          entry.set,
          this.materialSources[index]!.textureRefs,
          this.texturePublications,
        ),
        limit: entry.limit,
      })),
    );
    const coverageProfiles = planNativeMaterialPhysicalBanks(
      resolved.map((entry, index) => {
        const source = this.materialSources[index]!;
        const graph =
          source.material.transparency_mode === ShadeTransparencyMode.AlphaTested
            ? nativeMaterialCoverageProgram(source.graph)
            : undefined;
        return {
          banks: graph
            ? nativeMaterialRequiredBanks(graph, entry.set, source.textureRefs, this.texturePublications)
            : [],
          limit: Math.min(
            16,
            this.graphics.device.limits.maxSampledTexturesPerShaderStage -
              (graph?.productReads?.some((read) => read.field.constant === undefined) ? 1 : 0),
          ),
        };
      }),
    );
    for (let sourceIndex = 0; sourceIndex < this.materialSources.length; sourceIndex++) {
      const source = this.materialSources[sourceIndex]!;
      const set = bindingSets.find((set) => set.id === source.textureBindingSetId);
      if (set === undefined) {
        throw new Error("Native material texture set is not resident");
      }
      const bound = this.obtainMaterialBindings(
        sourceIndex,
        source,
        set,
        profiles[sourceIndex],
        coverageProfiles[sourceIndex],
      );
      const program = bound.program;
      const standard = standardAppearanceParameters(source.material);
      const parametersFor = (target: typeof program): Record<string, readonly number[]> => {
        const parameters: Record<string, readonly number[]> = {};
        for (const name of Object.keys(target.parameterSlots)) {
          const authored = source.material.appearance_inputs.get(name);
          const value = standard.get(name);
          if (authored !== undefined) parameters[name] = Array.from(authored);
          else if (value !== undefined) parameters[name] = [value];
        }
        return parameters;
      };
      const inputsFor = (target: typeof program): Float32Array<ArrayBuffer> => {
        const dynamic: Record<string, readonly number[]> = {};
        for (const input of target.inputs) {
          if (input.domain === "dynamic" || input.domain === "nonlocal") {
            const value = source.material.appearance_inputs.get(input.name);
            if (value === undefined)
              throw new RangeError(`Native material input '${input.name}' has no authored value`);
            dynamic[input.name] = Array.from(value);
          }
        }
        return nativeMaterialDynamicInputs(target, dynamic);
      };
      const parameters = parametersFor(program);
      const inputs = inputsFor(program);
      const constants = nativeMaterialParameters(program, parameters);
      const coverageParameters = bound.coverage ? parametersFor(bound.coverage.program) : undefined;
      const coverageInputs = bound.coverage ? inputsFor(bound.coverage.program) : undefined;
      const coverageConstants = bound.coverage
        ? nativeMaterialParameters(bound.coverage.program, coverageParameters)
        : new Float32Array(0);
      const mainLength = constants.length + 2 + inputs.length;
      const data = new Float32Array(mainLength + coverageConstants.length + (coverageInputs?.length ?? 0));
      data.set(constants);
      data[constants.length] = Math.max(0, Math.min(1, source.material.alpha_cutoff));
      data[constants.length + 1] =
        Number(source.material.transparency_mode === ShadeTransparencyMode.AlphaTested) |
        (Number(source.material.texture_emissive !== undefined) << 1);
      data.set(inputs, constants.length + 2);
      data.set(coverageConstants, mainLength);
      if (coverageInputs) data.set(coverageInputs, mainLength + coverageConstants.length);
      if (!data.every(Number.isFinite)) {
        throw new RangeError("Native instance publication requires finite material data");
      }
      values.push(data);
      bindings.push(bound);
      unlit.push(source.material.is_unlit);
      const oldIndex =
        previous?.sources[sourceIndex]?.materialSlot === source.materialSlot
          ? sourceIndex
          : (previous?.sources.findIndex((entry) => entry.materialSlot === source.materialSlot) ?? -1);
      const old = oldIndex < 0 ? undefined : previous!.sources[oldIndex];
      const unchanged =
        old !== undefined &&
        previous!.values[oldIndex]!.length === data.length &&
        previous!.values[oldIndex]!.every((value, index) => Object.is(value, data[index]));
      const valueRevision = unchanged ? old!.valueRevision! : (old?.valueRevision ?? 0) + 1;
      if (valueRevision > 0xffffffff) {
        throw new RangeError("Native material revision exhausted; republish the scene");
      }
      sources.push({
        materialSlot: source.materialSlot,
        program,
        parameters,
        inputs,
        valueRevision,
        ...(bound.coverage
          ? {
              coverage: {
                program: bound.coverage.program,
                layoutEntries: bound.coverage.layoutEntries,
                materialEntries: bound.coverage.entries,
                parameters: coverageParameters,
                inputs: coverageInputs,
              },
            }
          : {}),
        raster: {
          alphaCutoff: data[constants.length]!,
          alphaMask: source.material.transparency_mode === ShadeTransparencyMode.AlphaTested,
          hasEmissiveTexture: source.material.texture_emissive !== undefined,
        },
      });
    }
    if (
      previous !== undefined &&
      previous.bindings.length === bindings.length &&
      // obtainMaterialBindings preserves identity only after exact resource and
      // route checks. Stable frames need neither physical-set deduplication nor
      // native code/key reconstruction; every numeric input was validated above.
      bindings.every((bound, index) => bound === previous.bindings[index]) &&
      unlit.every((value, index) => value === previous.unlit[index]) &&
      values.every(
        (data, index) =>
          previous.values[index]!.length === data.length &&
          previous.values[index]!.every((value, word) => Object.is(value, data[word])),
      )
    ) {
      return previous;
    }
    const physicalSets: (readonly GPUBindGroupEntry[])[] = [];
    const routedSources = sources.map((source, index) => {
      const bound = bindings[index]!;
      // Resource equality is exact object/offset/size equality, never a hash.
      let bindingSet = physicalSets.findIndex(
        (entries) =>
          entries.length === bound.entries.length &&
          entries.every(
            (entry, word) =>
              entry.binding === bound.entries[word]!.binding &&
              entry.resource === bound.entries[word]!.resource,
          ),
      );
      if (bindingSet < 0) {
        bindingSet = physicalSets.length;
        physicalSets.push(bound.entries);
      }
      return { ...source, bindingSet };
    });
    const binKeys = new Set(
      routedSources.map(
        (source, index) =>
          `${source.program.key}/${source.bindingSet}/${this.materialSources[index]!.material.is_unlit}`,
      ),
    );
    const complete = routedSources.map((source, index) => ({
      ...source,
      ...nativeSurfacePublicationDescriptors(
        source.program,
        bindings[index]!.layoutEntries,
        {
          compact: binKeys.size > 1,
          productGeometry: this.productGeometry,
          unlit: this.materialSources[index]!.material.is_unlit,
          reactive: true,
          physicalSun: this.physicalSun && !this.materialSources[index]!.material.is_unlit,
        },
        this.graphics.device.limits,
      ),
    }));
    const publication = new GpuNativeMaterialPublication(
      this.graphics.device,
      this.graphics.appearance_programs,
      complete,
      this.graphics.resource_accounting,
    );
    const routes = publication.bins.map((bin, index) => {
      const sourceIndex = publication.entries.findIndex((entry) => entry.executionBin === index);
      return {
        ...bin,
        materialEntries: bindings[sourceIndex]!.entries,
        frameInputs: new Float32Array(Math.max(1, complete[sourceIndex]!.program.inputCount) * 4),
        unlit: this.materialSources[sourceIndex]!.material.is_unlit,
      };
    });
    return {
      revision: this.nextRevision++,
      publication,
      sources: complete,
      bindings,
      values,
      unlit,
      routes,
      hasLit: routes.some((route) => !route.unlit),
      hasMask: this.materialSources.some(
        (source) => source.material.transparency_mode === ShadeTransparencyMode.AlphaTested,
      ),
      viewDependentCoverage: this.materialSources.some(
        (source) =>
          source.material.transparency_mode === ShadeTransparencyMode.AlphaTested &&
          source.graph.instructions.some(
            (instruction) => (instruction.dependency & APPEARANCE_DEPENDENCY.View) !== 0,
          ),
      ),
      ready: false,
    };
  }

  private obtainMaterialBindings(
    index: number,
    source: NativeSceneMaterialSource,
    set: TextureBindingSet,
    physicalProfile?: NativeMaterialPhysicalBankProfile,
    coverageProfile?: NativeMaterialPhysicalBankProfile,
  ): NativeMaterialBindings {
    // Compiled graph/Product contents are immutable until Scene resync. The
    // mutable residency inputs below are compared by exact values and physical
    // object identity, never a hash or a frame number. No GPU resource is owned
    // by this CPU memo; replacement/loss still belongs to the existing owners.
    const mask = source.material.transparency_mode === ShadeTransparencyMode.AlphaTested;
    const identity: unknown[] = [
      source.graph,
      mask,
      source.material.is_unlit,
      set.id,
      set.generation,
      this.products,
      ...set.textureBanks,
      ...(physicalProfile?.banks.flatMap((bank) => [bank.segment, bank.view]) ?? []),
      "coverage-profile",
      ...(coverageProfile?.banks.flatMap((bank) => [bank.segment, bank.view]) ?? []),
    ];
    for (const sample of source.graph.samples) {
      const texture = sample.binding.texture;
      const mipRange = this.mipRanges.get(texture);
      const publication = this.texturePublications.get(texture);
      identity.push(
        source.textureRefs.get(texture),
        mipRange?.[0],
        mipRange?.[1],
        publication?.slot,
        publication?.generation,
        publication?.currentRevision ?? publication?.revision,
        publication?.currentMinimumMip,
        texture.texture_product?.metadata.storageWidth,
        texture.texture_product?.metadata.storageHeight,
      );
    }
    const previous = this.materialBindings[index];
    if (
      previous !== undefined &&
      previous.identity.length === identity.length &&
      previous.identity.every((value, word) => Object.is(value, identity[word]))
    ) {
      return previous.bindings;
    }
    const bindingSource = {
      graph: source.graph,
      program: lowerNativeMaterial(source.graph),
      bindingSet: set,
      textureRoutingRefs: source.textureRefs,
      textureMipRanges: this.mipRanges,
      texturePublications: this.texturePublications,
      ...(this.products ? { packedProducts: this.products } : {}),
      obtainSampler: (descriptor: GPUSamplerDescriptor) => this.graphics.samplers.obtain(descriptor),
    };
    const shadingGraph = nativeSurfaceMaterialGraph(source.graph, source.material.is_unlit);
    const bound = createNativeMaterialBindings({
      ...bindingSource,
      graph: shadingGraph,
      program: lowerNativeMaterial(shadingGraph),
      physicalProfile,
    });
    const coverage = mask
      ? createNativeCoverageBindings({ ...bindingSource, physicalProfile: coverageProfile })
      : undefined;
    const bindings = Object.freeze({
      ...bound,
      ...(coverage
        ? {
            coverage: Object.freeze({
              ...coverage,
              program: Object.freeze({
                ...coverage.program,
                instanceInputs: true,
                key: `${coverage.program.key}/instance-inputs`,
              }),
            }),
          }
        : {}),
      program: Object.freeze({
        ...bound.program,
        instanceInputs: true,
        key: `${bound.program.key}/instance-inputs`,
      }),
    });
    this.materialBindings[index] = { identity, bindings };
    return bindings;
  }

  private async prepareRasterPrograms(snapshot: Snapshot): Promise<void> {
    const jobs: Promise<GPURenderPipeline>[] = [];
    for (const rasterClass of snapshot.publication.rasterClasses) {
      for (const vsmAtlas of [false, true]) {
        const shader = nativeVisibilityShader(rasterClass.program, rasterClass.layoutEntries, {
          partitioned: true,
          productGeometry: this.productGeometry,
          shadow: vsmAtlas,
          vsmAtlas,
        });
        for (const cullMode of ["back", "none"] as const) {
          jobs.push(
            this.graphics.render_pipelines.prepare(
              nativeVisibilityPipelineDescriptor(shader, vsmAtlas, cullMode),
            ),
          );
        }
      }
    }
    await Promise.all(jobs);
  }

  release(command: ShadeGPUCommandContext): void {
    if (command.closed || command.device !== this.graphics.device) {
      throw new Error("Native scene retirement requires its open transaction");
    }
    command.onFinished.addOne(() => {
      this.stopped = true;
      void command.gpuDone.then(
        () => this.destroy(),
        () => this.destroy(),
      );
    });
  }

  evidence(): Readonly<{
    allocatedBytes: number;
    residentBytes: number;
    retiringBytes: number;
    stagingBytes: number;
  }> {
    const residentBytes =
      (this.active?.publication.allocatedBytes ?? 0) + (this.products?.physicalBytes ?? 0);
    const stagingBytes = this.candidate?.publication.allocatedBytes ?? 0;
    const retiringBytes = [...this.retiring].reduce(
      (bytes, snapshot) => bytes + snapshot.publication.allocatedBytes,
      0,
    );
    return {
      allocatedBytes: residentBytes + stagingBytes + retiringBytes,
      residentBytes,
      stagingBytes,
      retiringBytes,
    };
  }

  onDestroyed(callback: () => void): void {
    this.listeners.add(callback);
  }

  destroy(): void {
    this.detachMutations.forEach((detach) => detach());
    this.detachMutations.length = 0;
    this.stopped = true;
    this.active?.publication.destroy();
    this.candidate?.publication.destroy();
    this.retiring.forEach((snapshot) => snapshot.publication.destroy());
    this.products?.destroy();
    this.active = null;
    this.candidate = null;
    this.prepared = null;
    this.retiring.clear();
    this.materialBindings.length = 0;
    this.listeners.forEach((callback) => callback());
    this.listeners.clear();
  }
}
