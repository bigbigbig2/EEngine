import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import { APPEARANCE_DEPENDENCY } from "../material/AppearanceGraphCompiler.js";
import { standardAppearanceParameters } from "../material/AppearanceRuntimeInputs.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { ShadeTransparencyMode } from "../material/enums.js";
import {
  lowerNativeMaterial,
  nativeMaterialDynamicInputs,
  nativeMaterialParameters
} from "../shaders/native_material.js";
import { nativeSurfacePublicationDescriptors } from "../shaders/native_surface.js";
import { nativeVisibilityShader } from "../shaders/native_visibility.js";
import { nativeVisibilityPipelineDescriptor } from "../render/surface/NativeVisibilityPass.js";
import type { NativeSurfaceRoute } from "../render/surface/SurfaceV4.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import {
  GpuNativeMaterialPublication,
  type NativeMaterialPublicationSource
} from "./GpuNativeMaterialPublication.js";
import { createNativeMaterialBindings, type NativeMaterialBindings } from "./NativeMaterialBindings.js";
import { NativeMaterialProducts } from "./NativeMaterialProducts.js";
import type { TextureBindingSet } from "./TextureResidency.js";
import type { TextureSurfacePublication } from "./TextureVariation.js";

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
  readonly identity: readonly unknown[];
  readonly routes: readonly NativeSurfaceRoute[];
  ready: boolean;
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
  private nextRevision = 1;

  constructor(
    private readonly graphics: GraphicsContext,
    private readonly materialSources: readonly NativeSceneMaterialSource[],
    private readonly bindingSets: () => readonly TextureBindingSet[],
    private readonly mipRanges: ReadonlyMap<ShadeTexture, readonly [number, number]>,
    private readonly texturePublications: ReadonlyMap<ShadeTexture, TextureSurfacePublication>,
    command: ShadeGPUCommandContext,
    private readonly productGeometry: boolean,
    private readonly physicalSun: boolean
  ) {
    if (command.closed || command.device !== graphics.device) {
      throw new Error("Native scene publication requires its open upload transaction");
    }
    const graphs = materialSources.map((source) => source.graph);
    this.products = graphs.some((graph) =>
      graph.productReads?.some((read) => read.field.constant === undefined)
    )
      ? new NativeMaterialProducts(
          graphics.device,
          graphs,
          command,
          undefined,
          undefined,
          graphics.resource_accounting
        )
      : null;
    try {
      const initial = this.snapshot();
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
    return this.materialSources.some(
      (source) =>
        source.material.transparency_mode === ShadeTransparencyMode.AlphaTested &&
        source.graph.instructions.some(
          (instruction) => (instruction.dependency & APPEARANCE_DEPENDENCY.View) !== 0
        )
    );
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
    const next = this.snapshot(this.candidate ?? this.active!);
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
        }
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
            () => this.retiring.delete(previous)
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
    return (
      changed &&
      this.materialSources.some(
        (source) => source.material.transparency_mode === ShadeTransparencyMode.AlphaTested
      )
    );
  }

  private snapshot(previous?: Snapshot): Snapshot {
    const bindings: NativeMaterialBindings[] = [];
    const identities: unknown[] = [];
    const sources: NativeMaterialPublicationSource[] = [];
    const values: Float32Array<ArrayBuffer>[] = [];
    const physicalSets: GPUBindGroupEntry[][] = [];
    for (const source of this.materialSources) {
      const set = this.bindingSets().find((set) => set.id === source.textureBindingSetId);
      if (set === undefined) {
        throw new Error("Native material texture set is not resident");
      }
      const bound = createNativeMaterialBindings({
        graph: source.graph,
        program: lowerNativeMaterial(source.graph),
        bindingSet: set,
        textureRoutingRefs: source.textureRefs,
        textureMipRanges: this.mipRanges,
        texturePublications: this.texturePublications,
        ...(this.products ? { packedProducts: this.products } : {}),
        obtainSampler: (descriptor) => this.graphics.samplers.obtain(descriptor)
      });
      const program = Object.freeze({
        ...bound.program,
        instanceInputs: true,
        key: `${bound.program.key}/instance-inputs`
      });
      const parameters: Record<string, readonly number[]> = {};
      const standard = standardAppearanceParameters(source.material);
      for (const name of Object.keys(program.parameterSlots)) {
        const authored = source.material.appearance_inputs.get(name);
        const value = standard.get(name);
        if (authored !== undefined) {
          parameters[name] = Array.from(authored);
        } else if (value !== undefined) {
          parameters[name] = [value];
        }
      }
      const dynamic: Record<string, readonly number[]> = {};
      for (const input of program.inputs) {
        if (input.domain === "dynamic" || input.domain === "nonlocal") {
          const value = source.material.appearance_inputs.get(input.name);
          if (value === undefined) {
            throw new RangeError(`Native material input '${input.name}' has no authored value`);
          }
          dynamic[input.name] = Array.from(value);
        }
      }
      const inputs = nativeMaterialDynamicInputs(program, dynamic);
      const constants = nativeMaterialParameters(program, parameters);
      const data = new Float32Array(constants.length + 2 + inputs.length);
      data.set(constants);
      data[constants.length] = Math.max(0, Math.min(1, source.material.alpha_cutoff));
      data[constants.length + 1] =
        Number(source.material.transparency_mode === ShadeTransparencyMode.AlphaTested) |
        (Number(source.material.texture_emissive !== undefined) << 1);
      data.set(inputs, constants.length + 2);
      if (!data.every(Number.isFinite)) {
        throw new RangeError("Native instance publication requires finite material data");
      }
      values.push(data);
      bindings.push({ ...bound, program });
      // Resource equality is exact object/offset/size equality, never a hash.
      let bindingSet = physicalSets.findIndex(
        (entries) =>
          entries.length === bound.entries.length &&
          entries.every(
            (entry, index) =>
              entry.binding === bound.entries[index]!.binding &&
              entry.resource === bound.entries[index]!.resource
          )
      );
      if (bindingSet < 0) {
        bindingSet = physicalSets.length;
        physicalSets.push([...bound.entries]);
      }
      identities.push(
        program.key,
        source.material.is_unlit,
        ...bound.entries.flatMap((entry) => [entry.binding, entry.resource])
      );
      const oldIndex =
        previous?.sources.findIndex((entry) => entry.materialSlot === source.materialSlot) ?? -1;
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
        bindingSet,
        program,
        parameters,
        inputs,
        valueRevision,
        raster: {
          alphaCutoff: data[constants.length]!,
          alphaMask: source.material.transparency_mode === ShadeTransparencyMode.AlphaTested,
          hasEmissiveTexture: source.material.texture_emissive !== undefined
        },
        // Multi-bin shape is filled below, after exact complete sets are known.
        descriptor: undefined as never
      });
    }
    if (
      previous !== undefined &&
      previous.identity.length === identities.length &&
      previous.identity.every((value, index) => value === identities[index]) &&
      values.every(
        (data, index) =>
          previous.values[index]!.length === data.length &&
          previous.values[index]!.every((value, word) => Object.is(value, data[word]))
      )
    ) {
      return previous;
    }
    const binKeys = new Set(
      sources.map(
        (source) =>
          `${source.program.key}/${source.bindingSet}/${this.materialSources[sources.indexOf(source)]!.material.is_unlit}`
      )
    );
    const complete = sources.map((source, index) => ({
      ...source,
      ...nativeSurfacePublicationDescriptors(
        source.program,
        bindings[index]!.layoutEntries,
        {
          compact: binKeys.size > 1,
          productGeometry: this.productGeometry,
          unlit: this.materialSources[index]!.material.is_unlit,
          reactive: true,
          physicalSun: this.physicalSun && !this.materialSources[index]!.material.is_unlit
        },
        this.graphics.device.limits
      )
    }));
    const publication = new GpuNativeMaterialPublication(
      this.graphics.device,
      this.graphics.appearance_programs,
      complete,
      this.graphics.resource_accounting
    );
    const routes = publication.bins.map((bin, index) => {
      const sourceIndex = publication.entries.findIndex((entry) => entry.executionBin === index);
      return {
        ...bin,
        materialEntries: bindings[sourceIndex]!.entries,
        frameInputs: new Float32Array(Math.max(1, complete[sourceIndex]!.program.inputCount) * 4),
        unlit: this.materialSources[sourceIndex]!.material.is_unlit
      };
    });
    return {
      revision: this.nextRevision++,
      publication,
      sources: complete,
      bindings,
      values,
      identity: identities,
      routes,
      ready: false
    };
  }

  private async prepareRasterPrograms(snapshot: Snapshot): Promise<void> {
    const programs = new Map<string, number>();
    snapshot.sources.forEach((source, index) => programs.set(source.program.key, index));
    const jobs: Promise<GPURenderPipeline>[] = [];
    for (const index of programs.values()) {
      const source = snapshot.sources[index]!;
      for (const vsmAtlas of [false, true]) {
        const shader = nativeVisibilityShader(source.program, snapshot.bindings[index]!.layoutEntries, {
          partitioned: true,
          productGeometry: this.productGeometry,
          shadow: vsmAtlas,
          vsmAtlas
        });
        for (const cullMode of ["back", "none"] as const) {
          for (const late of !vsmAtlas && this.productGeometry ? [false, true] : [false]) {
            jobs.push(
              this.graphics.render_pipelines.prepare(
                nativeVisibilityPipelineDescriptor(shader, vsmAtlas, cullMode, late)
              )
            );
          }
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
        () => this.destroy()
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
      0
    );
    return {
      allocatedBytes: residentBytes + stagingBytes + retiringBytes,
      residentBytes,
      stagingBytes,
      retiringBytes
    };
  }

  onDestroyed(callback: () => void): void {
    this.listeners.add(callback);
  }

  destroy(): void {
    this.stopped = true;
    this.active?.publication.destroy();
    this.candidate?.publication.destroy();
    this.retiring.forEach((snapshot) => snapshot.publication.destroy());
    this.products?.destroy();
    this.active = null;
    this.candidate = null;
    this.prepared = null;
    this.retiring.clear();
    this.listeners.forEach((callback) => callback());
    this.listeners.clear();
  }
}
