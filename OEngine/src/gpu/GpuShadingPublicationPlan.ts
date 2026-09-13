import {
  preflightGpuShadingBinSizing,
  type GpuShadingBinSizing,
  type GpuShadingBinSizingLimits
} from "./GpuShadingBinAbi.js";
import {
  deriveGpuShadingIdentity,
  GPU_SHADING_DEPENDENCY,
  type GpuShadingGeometryProfile,
  type GpuShadingIdentity,
  type GpuShadingMaterialProfile
} from "./GpuShadingProgramAbi.js";
import {
  createGpuSparseShadingPipelineDescriptor,
  GPU_SHADING_OUTPUT_DEPENDENCY_VALID_MASK,
  type GpuSparseShadingPipelineDescriptor
} from "./GpuSparseShadingPipelineContract.js";
import type { GpuSparseShadingCapabilityRecord } from "./GpuSparseShadingCapability.js";

export const GPU_SHADING_PUBLICATION_SCHEMA_VERSION = 1;

export interface GpuShadingMaterialPublication {
  readonly id: number;
  readonly profile: GpuShadingMaterialProfile;
  readonly generation: number;
  readonly textureGeneration: number;
}

export interface GpuShadingGeometryPublication {
  readonly id: number;
  readonly profile: GpuShadingGeometryProfile;
  readonly generation: number;
}

export interface GpuShadingInstancePublication {
  readonly id: number;
  readonly materialId: number;
  readonly geometryId: number;
  readonly active: boolean;
  readonly transparent: boolean;
  readonly generation: number;
}

export interface GpuResolvedShadingAssociation {
  readonly instance: Readonly<GpuShadingInstancePublication>;
  readonly identity: Readonly<GpuShadingIdentity>;
  readonly instanceBinId: number;
  readonly meshletWorkBinId: number;
  readonly materialGeneration: number;
  readonly textureGeneration: number;
  readonly geometryGeneration: number;
  readonly publicationRevision: number;
  readonly layoutRevision: number;
}

export interface ActiveShadingSummary {
  readonly binRefCounts: Readonly<Uint32Array>;
  readonly activeBinMaskLo: number;
  readonly activeBinMaskHi: number;
  readonly opaqueLitReceiverCount: number;
  readonly opaqueUnlitReceiverCount: number;
  readonly transparentLitReceiverCount: number;
  readonly dependencyMask: number;
  readonly revision: number;
}

export interface GpuShadingPublicationContext {
  readonly width: number;
  readonly height: number;
  readonly outputDependencyMask: number;
  /** Opaque-lit shader specialization; false physically omits shadow bindings/sampling. */
  readonly shadowSamplingEnabled: boolean;
  readonly capability: Readonly<GpuSparseShadingCapabilityRecord>;
  readonly sizingLimits: Readonly<GpuShadingBinSizingLimits>;
}

export interface GpuShadingPublicationSnapshot {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly layoutRevision: number;
  readonly generation: number;
  readonly deviceEpoch: number;
  readonly context: Readonly<GpuShadingPublicationContext>;
  readonly summary: Readonly<ActiveShadingSummary>;
  readonly sizing: Readonly<GpuShadingBinSizing>;
  readonly associations: readonly Readonly<GpuResolvedShadingAssociation>[];
  readonly pipelines: readonly Readonly<GpuSparseShadingPipelineDescriptor>[];
  readonly bindGroups: readonly Readonly<GpuShadingBindGroupPublication>[];
}

export interface GpuShadingBindGroupPublication {
  readonly binId: number;
  readonly group: 0 | 1 | 2 | 3;
  readonly owner: "frame/bin/output" | "scene/geometry" | "material/TextureBindingSet" | "lighting";
  readonly pipelineCacheKey: string;
  readonly layoutRevision: number;
  readonly publicationRevision: number;
}

export interface GpuShadingBulkPublication {
  readonly materials: readonly GpuShadingMaterialPublication[];
  readonly geometries: readonly GpuShadingGeometryPublication[];
  readonly instances: readonly GpuShadingInstancePublication[];
}

interface MutableSummary {
  binRefCounts: Uint32Array;
  dependencyRefCounts: Uint32Array;
  opaqueLitReceiverCount: number;
  opaqueUnlitReceiverCount: number;
  transparentLitReceiverCount: number;
}

interface PublicationState {
  materials: Map<number, Readonly<GpuShadingMaterialPublication>>;
  geometries: Map<number, Readonly<GpuShadingGeometryPublication>>;
  instances: Map<number, Readonly<GpuShadingInstancePublication>>;
  associations: Map<number, Readonly<GpuResolvedShadingAssociation>>;
  materialUsers: Map<number, Set<number>>;
  geometryUsers: Map<number, Set<number>>;
  summary: MutableSummary;
}

interface PreparedPublication {
  readonly snapshot: Readonly<GpuShadingPublicationSnapshot>;
  readonly newPipelines: readonly Readonly<GpuSparseShadingPipelineDescriptor>[];
}

export class GpuShadingPublicationStore {
  private state: PublicationState;
  private contextValue: Readonly<GpuShadingPublicationContext>;
  private snapshotValue: Readonly<GpuShadingPublicationSnapshot> | null;
  private readonly pipelineCache = new Map<string, Readonly<GpuSparseShadingPipelineDescriptor>>();
  private retiredSnapshots: Array<{
    snapshot: Readonly<GpuShadingPublicationSnapshot>;
    retireAfterSubmission: number;
  }> = [];
  private revision = 1;
  private deviceEpoch = 1;
  private lost = false;

  constructor(context: GpuShadingPublicationContext) {
    this.contextValue = freezeContext(context);
    this.state = emptyState();
    const prepared = this.buildPrepared(this.state, this.contextValue, this.revision);
    this.snapshotValue = prepared.snapshot;
  }

  currentSnapshot(): Readonly<GpuShadingPublicationSnapshot> {
    if (this.snapshotValue === null || this.lost) {
      throw new Error("Sparse shading publication snapshot is unavailable after device loss");
    }
    return this.snapshotValue;
  }

  beginTransaction(): GpuShadingPublicationTransaction {
    if (this.lost) {
      throw new Error("Cannot begin sparse shading publication while the device is lost");
    }
    return new GpuShadingPublicationTransaction(
      this,
      cloneState(this.state),
      this.contextValue,
      this.revision
    );
  }

  markDeviceLost(): void {
    this.lost = true;
    this.snapshotValue = null;
    this.pipelineCache.clear();
    this.retiredSnapshots = [];
    this.deviceEpoch = checkedIncrement(this.deviceEpoch, "Sparse shading device epoch");
  }

  rebuildAfterDeviceLoss(
    context: GpuShadingPublicationContext = this.contextValue
  ): Readonly<GpuShadingPublicationSnapshot> {
    if (!this.lost) {
      throw new Error("Sparse shading device-loss rebuild requires a lost device state");
    }
    const frozenContext = freezeContext(context);
    const nextRevision = checkedIncrement(this.revision, "Sparse shading publication revision");
    const prepared = this.buildPrepared(this.state, frozenContext, nextRevision);
    this.contextValue = frozenContext;
    this.revision = nextRevision;
    this.snapshotValue = prepared.snapshot;
    for (const pipeline of prepared.newPipelines) this.pipelineCache.set(pipeline.cacheKey, pipeline);
    this.lost = false;
    return prepared.snapshot;
  }

  completeSubmittedWork(completedSubmission: number): readonly number[] {
    assertNonNegativeSafeInteger(completedSubmission, "Completed submission serial");
    const retired: number[] = [];
    this.retiredSnapshots = this.retiredSnapshots.filter((entry) => {
      if (entry.retireAfterSubmission <= completedSubmission) {
        retired.push(entry.snapshot.revision);
        return false;
      }
      return true;
    });
    return Object.freeze(retired);
  }

  _prepare(
    state: PublicationState,
    context: Readonly<GpuShadingPublicationContext>,
    dirty: boolean,
    baseRevision: number
  ): PreparedPublication {
    this.requireCurrentTransaction(baseRevision);
    if (!dirty) {
      return Object.freeze({ snapshot: this.currentSnapshot(), newPipelines: Object.freeze([]) });
    }
    return this.buildPrepared(
      state,
      context,
      checkedIncrement(this.revision, "Sparse shading publication revision")
    );
  }

  _commit(
    transaction: GpuShadingPublicationTransaction,
    state: PublicationState,
    context: Readonly<GpuShadingPublicationContext>,
    prepared: PreparedPublication,
    dirty: boolean,
    submissionSerial: number,
    baseRevision: number
  ): Readonly<GpuShadingPublicationSnapshot> {
    if (transaction.storeIdentity !== this) throw new Error("Foreign sparse shading transaction");
    this.requireCurrentTransaction(baseRevision);
    if (!dirty) return this.currentSnapshot();
    assertNonNegativeSafeInteger(submissionSerial, "Submission serial");
    const previous = this.currentSnapshot();
    this.state = state;
    this.contextValue = context;
    this.snapshotValue = prepared.snapshot;
    this.revision = prepared.snapshot.revision;
    for (const pipeline of prepared.newPipelines) this.pipelineCache.set(pipeline.cacheKey, pipeline);
    this.retiredSnapshots.push({ snapshot: previous, retireAfterSubmission: submissionSerial });
    return prepared.snapshot;
  }

  private buildPrepared(
    state: PublicationState,
    context: Readonly<GpuShadingPublicationContext>,
    revision: number
  ): PreparedPublication {
    validateContext(context);
    const summary = freezeSummary(state.summary, revision);
    const activeBinIds = activeBins(summary.binRefCounts);
    const sizing = preflightGpuShadingBinSizing(
      context.width,
      context.height,
      activeBinIds,
      revision,
      context.sizingLimits
    );
    const pipelines: Readonly<GpuSparseShadingPipelineDescriptor>[] = [];
    const newPipelines: Readonly<GpuSparseShadingPipelineDescriptor>[] = [];
    for (const binId of activeBinIds) {
      const programId = binId & 0xf;
      const textureBindingSetId = (binId >>> 4) & 0x3;
      const candidate = createGpuSparseShadingPipelineDescriptor({
        programId,
        textureBindingSetId,
        outputDependencyMask: context.outputDependencyMask,
        shadowSamplingEnabled: context.shadowSamplingEnabled,
        capability: context.capability
      });
      const cached = this.pipelineCache.get(candidate.cacheKey);
      const pipeline = cached ?? candidate;
      pipelines.push(pipeline);
      if (cached === undefined) newPipelines.push(pipeline);
    }
    const associations = Object.freeze(
      [...state.associations.values()]
        .sort((left, right) => left.instance.id - right.instance.id)
        .map((association) => Object.freeze({
          ...association,
          publicationRevision: revision,
          layoutRevision: revision
        }))
    );
    const bindGroups = Object.freeze(pipelines.flatMap((pipeline) =>
      pipeline.groups.map((group) => Object.freeze({
        binId: pipeline.binId,
        group: group.group,
        owner: group.owner,
        pipelineCacheKey: pipeline.cacheKey,
        layoutRevision: revision,
        publicationRevision: revision
      } as const))
    ));
    const snapshot = Object.freeze({
      schemaVersion: GPU_SHADING_PUBLICATION_SCHEMA_VERSION as 1,
      revision,
      layoutRevision: revision,
      generation: revision,
      deviceEpoch: this.deviceEpoch,
      context,
      summary,
      sizing,
      associations,
      pipelines: Object.freeze(pipelines),
      bindGroups
    });
    return Object.freeze({ snapshot, newPipelines: Object.freeze(newPipelines) });
  }

  private requireCurrentTransaction(baseRevision: number): void {
    if (this.lost || this.snapshotValue === null) {
      throw new Error("Sparse shading publication transaction was invalidated by device loss");
    }
    if (baseRevision !== this.revision) {
      throw new Error(
        `Sparse shading publication transaction revision ${baseRevision} is stale; current is ${this.revision}`
      );
    }
  }
}

export class GpuShadingPublicationTransaction {
  readonly storeIdentity: GpuShadingPublicationStore;
  private state: PublicationState;
  private context: Readonly<GpuShadingPublicationContext>;
  private dirty = false;
  private closed = false;
  private prepared: PreparedPublication | null = null;
  private readonly baseRevision: number;

  constructor(
    store: GpuShadingPublicationStore,
    state: PublicationState,
    context: Readonly<GpuShadingPublicationContext>,
    baseRevision: number
  ) {
    this.storeIdentity = store;
    this.state = state;
    this.context = context;
    this.baseRevision = baseRevision;
  }

  replaceAll(source: GpuShadingBulkPublication): this {
    this.requireOpen();
    this.state = buildState(source);
    this.dirty = true;
    this.prepared = null;
    return this;
  }

  addMaterial(material: GpuShadingMaterialPublication): this {
    this.requireOpen();
    const frozen = freezeMaterial(material);
    if (this.state.materials.has(frozen.id)) {
      throw new Error(`Sparse shading material ${frozen.id} already exists`);
    }
    this.state.materials.set(frozen.id, frozen);
    this.state.materialUsers.set(frozen.id, new Set());
    return this.changed();
  }

  patchMaterial(material: GpuShadingMaterialPublication): this {
    this.requireOpen();
    const frozen = freezeMaterial(material);
    const previous = requireMapValue(this.state.materials, frozen.id, "material");
    if (sameMaterial(previous, frozen)) return this;
    const userIds = [...requireMapValue(this.state.materialUsers, frozen.id, "material users")];
    const replacements = userIds.map((instanceId) => {
      const instance = requireMapValue(this.state.instances, instanceId, "instance");
      const geometry = requireMapValue(this.state.geometries, instance.geometryId, "geometry");
      return resolveAssociation(instance, frozen, geometry);
    });
    for (let index = 0; index < userIds.length; index++) {
      replaceAssociationContribution(this.state, userIds[index]!, replacements[index]!);
    }
    this.state.materials.set(frozen.id, frozen);
    return this.changed();
  }

  relocateTextureBindingSet(
    materialId: number,
    textureBindingSetId: number,
    textureGeneration: number
  ): this {
    this.requireOpen();
    const current = requireMapValue(this.state.materials, checkedId(materialId, "material id"), "material");
    return this.patchMaterial({
      ...current,
      profile: { ...current.profile, textureBindingSetId },
      textureGeneration
    });
  }

  removeMaterial(materialId: number): this {
    this.requireOpen();
    checkedId(materialId, "material id");
    const users = requireMapValue(this.state.materialUsers, materialId, "material users");
    if (users.size !== 0) throw new Error(`Sparse shading material ${materialId} is still referenced`);
    requireMapValue(this.state.materials, materialId, "material");
    this.state.materials.delete(materialId);
    this.state.materialUsers.delete(materialId);
    return this.changed();
  }

  addGeometry(geometry: GpuShadingGeometryPublication): this {
    this.requireOpen();
    const frozen = freezeGeometry(geometry);
    if (this.state.geometries.has(frozen.id)) {
      throw new Error(`Sparse shading geometry ${frozen.id} already exists`);
    }
    this.state.geometries.set(frozen.id, frozen);
    this.state.geometryUsers.set(frozen.id, new Set());
    return this.changed();
  }

  patchGeometry(geometry: GpuShadingGeometryPublication): this {
    this.requireOpen();
    const frozen = freezeGeometry(geometry);
    const previous = requireMapValue(this.state.geometries, frozen.id, "geometry");
    if (sameGeometry(previous, frozen)) return this;
    const userIds = [...requireMapValue(this.state.geometryUsers, frozen.id, "geometry users")];
    const replacements = userIds.map((instanceId) => {
      const instance = requireMapValue(this.state.instances, instanceId, "instance");
      const material = requireMapValue(this.state.materials, instance.materialId, "material");
      return resolveAssociation(instance, material, frozen);
    });
    for (let index = 0; index < userIds.length; index++) {
      replaceAssociationContribution(this.state, userIds[index]!, replacements[index]!);
    }
    this.state.geometries.set(frozen.id, frozen);
    return this.changed();
  }

  removeGeometry(geometryId: number): this {
    this.requireOpen();
    checkedId(geometryId, "geometry id");
    const users = requireMapValue(this.state.geometryUsers, geometryId, "geometry users");
    if (users.size !== 0) throw new Error(`Sparse shading geometry ${geometryId} is still referenced`);
    requireMapValue(this.state.geometries, geometryId, "geometry");
    this.state.geometries.delete(geometryId);
    this.state.geometryUsers.delete(geometryId);
    return this.changed();
  }

  addInstance(instance: GpuShadingInstancePublication): this {
    this.requireOpen();
    const frozen = freezeInstance(instance);
    if (this.state.instances.has(frozen.id)) {
      throw new Error(`Sparse shading instance ${frozen.id} already exists`);
    }
    const material = requireMapValue(this.state.materials, frozen.materialId, "material");
    const geometry = requireMapValue(this.state.geometries, frozen.geometryId, "geometry");
    const association = resolveAssociation(frozen, material, geometry);
    this.state.instances.set(frozen.id, frozen);
    this.state.associations.set(frozen.id, association);
    requireMapValue(this.state.materialUsers, frozen.materialId, "material users").add(frozen.id);
    requireMapValue(this.state.geometryUsers, frozen.geometryId, "geometry users").add(frozen.id);
    addContribution(this.state.summary, association);
    return this.changed();
  }

  removeInstance(instanceId: number): this {
    this.requireOpen();
    checkedId(instanceId, "instance id");
    const instance = requireMapValue(this.state.instances, instanceId, "instance");
    const association = requireMapValue(this.state.associations, instanceId, "association");
    removeContribution(this.state.summary, association);
    this.state.instances.delete(instanceId);
    this.state.associations.delete(instanceId);
    requireMapValue(this.state.materialUsers, instance.materialId, "material users").delete(instanceId);
    requireMapValue(this.state.geometryUsers, instance.geometryId, "geometry users").delete(instanceId);
    return this.changed();
  }

  patchInstanceVisibility(
    instanceId: number,
    patch: Readonly<{ active?: boolean; transparent?: boolean; generation: number }>
  ): this {
    this.requireOpen();
    const previous = requireMapValue(this.state.instances, checkedId(instanceId, "instance id"), "instance");
    const next = freezeInstance({
      ...previous,
      active: patch.active ?? previous.active,
      transparent: patch.transparent ?? previous.transparent,
      generation: patch.generation
    });
    if (sameInstance(previous, next)) return this;
    const oldAssociation = requireMapValue(this.state.associations, instanceId, "association");
    const nextAssociation = Object.freeze({ ...oldAssociation, instance: next });
    removeContribution(this.state.summary, oldAssociation);
    addContribution(this.state.summary, nextAssociation);
    this.state.instances.set(instanceId, next);
    this.state.associations.set(instanceId, nextAssociation);
    return this.changed();
  }

  patchInstanceAssociation(
    instanceId: number,
    patch: Readonly<{ materialId?: number; geometryId?: number; generation: number }>
  ): this {
    this.requireOpen();
    const previous = requireMapValue(this.state.instances, checkedId(instanceId, "instance id"), "instance");
    const next = freezeInstance({
      ...previous,
      materialId: patch.materialId ?? previous.materialId,
      geometryId: patch.geometryId ?? previous.geometryId,
      generation: patch.generation
    });
    if (sameInstance(previous, next)) return this;
    const material = requireMapValue(this.state.materials, next.materialId, "material");
    const geometry = requireMapValue(this.state.geometries, next.geometryId, "geometry");
    const association = resolveAssociation(next, material, geometry);
    const oldAssociation = requireMapValue(this.state.associations, instanceId, "association");
    removeContribution(this.state.summary, oldAssociation);
    addContribution(this.state.summary, association);
    if (previous.materialId !== next.materialId) {
      requireMapValue(this.state.materialUsers, previous.materialId, "material users").delete(instanceId);
      requireMapValue(this.state.materialUsers, next.materialId, "material users").add(instanceId);
    }
    if (previous.geometryId !== next.geometryId) {
      requireMapValue(this.state.geometryUsers, previous.geometryId, "geometry users").delete(instanceId);
      requireMapValue(this.state.geometryUsers, next.geometryId, "geometry users").add(instanceId);
    }
    this.state.instances.set(instanceId, next);
    this.state.associations.set(instanceId, association);
    return this.changed();
  }

  updateContext(context: GpuShadingPublicationContext): this {
    this.requireOpen();
    const frozen = freezeContext(context);
    if (sameContext(this.context, frozen)) return this;
    this.context = frozen;
    return this.changed();
  }

  prepare(): Readonly<GpuShadingPublicationSnapshot> {
    this.requireOpen();
    if (this.prepared !== null) return this.prepared.snapshot;
    this.prepared = this.storeIdentity._prepare(
      this.state,
      this.context,
      this.dirty,
      this.baseRevision
    );
    return this.prepared.snapshot;
  }

  commit(submissionSerial: number): Readonly<GpuShadingPublicationSnapshot> {
    this.requireOpen();
    const prepared = this.prepared ?? this.storeIdentity._prepare(
      this.state,
      this.context,
      this.dirty,
      this.baseRevision
    );
    const snapshot = this.storeIdentity._commit(
      this,
      this.state,
      this.context,
      prepared,
      this.dirty,
      submissionSerial,
      this.baseRevision
    );
    this.closed = true;
    return snapshot;
  }

  abort(): void {
    this.requireOpen();
    this.closed = true;
    this.prepared = null;
  }

  private changed(): this {
    this.dirty = true;
    this.prepared = null;
    return this;
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("Sparse shading publication transaction is closed");
  }
}

function buildState(source: GpuShadingBulkPublication): PublicationState {
  const state = emptyState();
  for (const materialInput of source.materials) {
    const material = freezeMaterial(materialInput);
    if (state.materials.has(material.id)) throw new Error(`Duplicate sparse shading material ${material.id}`);
    state.materials.set(material.id, material);
    state.materialUsers.set(material.id, new Set());
  }
  for (const geometryInput of source.geometries) {
    const geometry = freezeGeometry(geometryInput);
    if (state.geometries.has(geometry.id)) throw new Error(`Duplicate sparse shading geometry ${geometry.id}`);
    state.geometries.set(geometry.id, geometry);
    state.geometryUsers.set(geometry.id, new Set());
  }
  const resolved: Array<Readonly<GpuResolvedShadingAssociation>> = [];
  const instances: Array<Readonly<GpuShadingInstancePublication>> = [];
  const instanceIds = new Set<number>();
  for (const instanceInput of source.instances) {
    const instance = freezeInstance(instanceInput);
    if (instanceIds.has(instance.id)) {
      throw new Error(`Duplicate sparse shading instance ${instance.id}`);
    }
    instanceIds.add(instance.id);
    const material = requireMapValue(state.materials, instance.materialId, "material");
    const geometry = requireMapValue(state.geometries, instance.geometryId, "geometry");
    instances.push(instance);
    resolved.push(resolveAssociation(instance, material, geometry));
  }
  for (let index = 0; index < instances.length; index++) {
    const instance = instances[index]!;
    const association = resolved[index]!;
    state.instances.set(instance.id, instance);
    state.associations.set(instance.id, association);
    requireMapValue(state.materialUsers, instance.materialId, "material users").add(instance.id);
    requireMapValue(state.geometryUsers, instance.geometryId, "geometry users").add(instance.id);
    addContribution(state.summary, association);
  }
  return state;
}

function emptyState(): PublicationState {
  return {
    materials: new Map(),
    geometries: new Map(),
    instances: new Map(),
    associations: new Map(),
    materialUsers: new Map(),
    geometryUsers: new Map(),
    summary: {
      binRefCounts: new Uint32Array(64),
      dependencyRefCounts: new Uint32Array(9),
      opaqueLitReceiverCount: 0,
      opaqueUnlitReceiverCount: 0,
      transparentLitReceiverCount: 0
    }
  };
}

function cloneState(source: PublicationState): PublicationState {
  return {
    materials: new Map(source.materials),
    geometries: new Map(source.geometries),
    instances: new Map(source.instances),
    associations: new Map(source.associations),
    materialUsers: new Map([...source.materialUsers].map(([key, values]) => [key, new Set(values)])),
    geometryUsers: new Map([...source.geometryUsers].map(([key, values]) => [key, new Set(values)])),
    summary: {
      binRefCounts: source.summary.binRefCounts.slice(),
      dependencyRefCounts: source.summary.dependencyRefCounts.slice(),
      opaqueLitReceiverCount: source.summary.opaqueLitReceiverCount,
      opaqueUnlitReceiverCount: source.summary.opaqueUnlitReceiverCount,
      transparentLitReceiverCount: source.summary.transparentLitReceiverCount
    }
  };
}

function resolveAssociation(
  instance: Readonly<GpuShadingInstancePublication>,
  material: Readonly<GpuShadingMaterialPublication>,
  geometry: Readonly<GpuShadingGeometryPublication>
): Readonly<GpuResolvedShadingAssociation> {
  const identity = deriveGpuShadingIdentity(material.profile, geometry.profile);
  return Object.freeze({
    instance,
    identity,
    instanceBinId: identity.binId,
    meshletWorkBinId: identity.binId,
    materialGeneration: material.generation,
    textureGeneration: material.textureGeneration,
    geometryGeneration: geometry.generation,
    publicationRevision: 0,
    layoutRevision: 0
  });
}

function replaceAssociationContribution(
  state: PublicationState,
  instanceId: number,
  replacement: Readonly<GpuResolvedShadingAssociation>
): void {
  const previous = requireMapValue(state.associations, instanceId, "association");
  removeContribution(state.summary, previous);
  addContribution(state.summary, replacement);
  state.associations.set(instanceId, replacement);
}

function addContribution(
  summary: MutableSummary,
  association: Readonly<GpuResolvedShadingAssociation>
): void {
  if (!association.instance.active) return;
  updateDependencyCounts(summary.dependencyRefCounts, association.identity.dependencyMask, 1);
  const lit = (association.identity.dependencyMask & GPU_SHADING_DEPENDENCY.Lit) !== 0;
  if (association.instance.transparent) {
    if (lit) summary.transparentLitReceiverCount = incrementU32(
      summary.transparentLitReceiverCount,
      "Transparent lit receiver count"
    );
    return;
  }
  const binId = association.identity.binId;
  summary.binRefCounts[binId] = incrementU32(summary.binRefCounts[binId]!, `Bin ${binId} refcount`);
  if (lit) {
    summary.opaqueLitReceiverCount = incrementU32(summary.opaqueLitReceiverCount, "Opaque lit receiver count");
  } else {
    summary.opaqueUnlitReceiverCount = incrementU32(
      summary.opaqueUnlitReceiverCount,
      "Opaque unlit receiver count"
    );
  }
}

function removeContribution(
  summary: MutableSummary,
  association: Readonly<GpuResolvedShadingAssociation>
): void {
  if (!association.instance.active) return;
  updateDependencyCounts(summary.dependencyRefCounts, association.identity.dependencyMask, -1);
  const lit = (association.identity.dependencyMask & GPU_SHADING_DEPENDENCY.Lit) !== 0;
  if (association.instance.transparent) {
    if (lit) summary.transparentLitReceiverCount = decrementU32(
      summary.transparentLitReceiverCount,
      "Transparent lit receiver count"
    );
    return;
  }
  const binId = association.identity.binId;
  summary.binRefCounts[binId] = decrementU32(summary.binRefCounts[binId]!, `Bin ${binId} refcount`);
  if (lit) {
    summary.opaqueLitReceiverCount = decrementU32(summary.opaqueLitReceiverCount, "Opaque lit receiver count");
  } else {
    summary.opaqueUnlitReceiverCount = decrementU32(
      summary.opaqueUnlitReceiverCount,
      "Opaque unlit receiver count"
    );
  }
}

function updateDependencyCounts(counts: Uint32Array, mask: number, delta: 1 | -1): void {
  for (let bit = 0; bit < 9; bit++) {
    if ((mask & (1 << bit)) === 0) continue;
    counts[bit] = delta === 1
      ? incrementU32(counts[bit]!, `Dependency bit ${bit} refcount`)
      : decrementU32(counts[bit]!, `Dependency bit ${bit} refcount`);
  }
}

function freezeSummary(summary: MutableSummary, revision: number): Readonly<ActiveShadingSummary> {
  let activeBinMaskLo = 0;
  let activeBinMaskHi = 0;
  for (let binId = 0; binId < 64; binId++) {
    if (summary.binRefCounts[binId] === 0) continue;
    if (binId < 32) activeBinMaskLo = (activeBinMaskLo | (1 << binId)) >>> 0;
    else activeBinMaskHi = (activeBinMaskHi | (1 << (binId - 32))) >>> 0;
  }
  let dependencyMask = 0;
  for (let bit = 0; bit < 9; bit++) {
    if (summary.dependencyRefCounts[bit] !== 0) dependencyMask |= 1 << bit;
  }
  return Object.freeze({
    binRefCounts: summary.binRefCounts.slice(),
    activeBinMaskLo,
    activeBinMaskHi,
    opaqueLitReceiverCount: summary.opaqueLitReceiverCount,
    opaqueUnlitReceiverCount: summary.opaqueUnlitReceiverCount,
    transparentLitReceiverCount: summary.transparentLitReceiverCount,
    dependencyMask,
    revision
  });
}

function activeBins(refCounts: Readonly<Uint32Array>): readonly number[] {
  const result: number[] = [];
  for (let binId = 0; binId < refCounts.length; binId++) {
    if (refCounts[binId] !== 0) result.push(binId);
  }
  return Object.freeze(result);
}

function freezeMaterial(input: GpuShadingMaterialPublication): Readonly<GpuShadingMaterialPublication> {
  const id = checkedId(input.id, "material id");
  assertGeneration(input.generation, "material generation");
  assertGeneration(input.textureGeneration, "texture generation");
  return Object.freeze({
    id,
    profile: Object.freeze({ ...input.profile }),
    generation: input.generation,
    textureGeneration: input.textureGeneration
  });
}

function freezeGeometry(input: GpuShadingGeometryPublication): Readonly<GpuShadingGeometryPublication> {
  const id = checkedId(input.id, "geometry id");
  assertGeneration(input.generation, "geometry generation");
  return Object.freeze({
    id,
    profile: Object.freeze({ ...input.profile }),
    generation: input.generation
  });
}

function freezeInstance(input: GpuShadingInstancePublication): Readonly<GpuShadingInstancePublication> {
  const id = checkedId(input.id, "instance id");
  const materialId = checkedId(input.materialId, "instance material id");
  const geometryId = checkedId(input.geometryId, "instance geometry id");
  assertGeneration(input.generation, "instance generation");
  if (typeof input.active !== "boolean" || typeof input.transparent !== "boolean") {
    throw new TypeError("Sparse shading instance active/transparent must be boolean");
  }
  return Object.freeze({
    id,
    materialId,
    geometryId,
    active: input.active,
    transparent: input.transparent,
    generation: input.generation
  });
}

function freezeContext(input: GpuShadingPublicationContext): Readonly<GpuShadingPublicationContext> {
  validateContext(input);
  return Object.freeze({
    width: input.width,
    height: input.height,
    outputDependencyMask: input.outputDependencyMask,
    shadowSamplingEnabled: input.shadowSamplingEnabled,
    capability: input.capability,
    sizingLimits: Object.freeze({ ...input.sizingLimits })
  });
}

function validateContext(input: GpuShadingPublicationContext): void {
  checkedId(input.width, "publication width");
  checkedId(input.height, "publication height");
  if (!Number.isInteger(input.outputDependencyMask) || input.outputDependencyMask < 0 ||
      (input.outputDependencyMask & ~GPU_SHADING_OUTPUT_DEPENDENCY_VALID_MASK) !== 0) {
    throw new RangeError("Sparse shading publication output dependency mask has reserved bits");
  }
  if (typeof input.shadowSamplingEnabled !== "boolean") {
    throw new TypeError("Sparse shading publication shadow specialization must be boolean");
  }
  if (input.capability.fingerprint.length === 0 || input.capability.formatProfile.length === 0) {
    throw new RangeError("Sparse shading publication requires a capability/format fingerprint");
  }
}

function sameMaterial(
  left: Readonly<GpuShadingMaterialPublication>,
  right: Readonly<GpuShadingMaterialPublication>
): boolean {
  return left.id === right.id && left.generation === right.generation &&
    left.textureGeneration === right.textureGeneration &&
    left.profile.shadingModel === right.profile.shadingModel &&
    left.profile.hasBaseTexture === right.profile.hasBaseTexture &&
    left.profile.hasOrmTexture === right.profile.hasOrmTexture &&
    left.profile.hasNormalTexture === right.profile.hasNormalTexture &&
    left.profile.hasEmissiveTexture === right.profile.hasEmissiveTexture &&
    left.profile.textureBindingSetId === right.profile.textureBindingSetId;
}

function sameGeometry(
  left: Readonly<GpuShadingGeometryPublication>,
  right: Readonly<GpuShadingGeometryPublication>
): boolean {
  return left.id === right.id && left.generation === right.generation &&
    left.profile.hasAuthoredVertexColor === right.profile.hasAuthoredVertexColor &&
    left.profile.hasUv0 === right.profile.hasUv0 &&
    left.profile.hasNormal === right.profile.hasNormal &&
    left.profile.hasTangent === right.profile.hasTangent;
}

function sameInstance(
  left: Readonly<GpuShadingInstancePublication>,
  right: Readonly<GpuShadingInstancePublication>
): boolean {
  return left.id === right.id && left.materialId === right.materialId &&
    left.geometryId === right.geometryId && left.active === right.active &&
    left.transparent === right.transparent && left.generation === right.generation;
}

function sameContext(
  left: Readonly<GpuShadingPublicationContext>,
  right: Readonly<GpuShadingPublicationContext>
): boolean {
  return left.width === right.width && left.height === right.height &&
    left.outputDependencyMask === right.outputDependencyMask &&
    left.capability.fingerprint === right.capability.fingerprint &&
    left.shadowSamplingEnabled === right.shadowSamplingEnabled &&
    left.sizingLimits.maxTextureDimension2D === right.sizingLimits.maxTextureDimension2D &&
    left.sizingLimits.maxBufferSize === right.sizingLimits.maxBufferSize &&
    left.sizingLimits.maxStorageBufferBindingSize ===
      right.sizingLimits.maxStorageBufferBindingSize &&
    left.sizingLimits.maxComputeWorkgroupsPerDimension ===
      right.sizingLimits.maxComputeWorkgroupsPerDimension;
}

function requireMapValue<K, V>(map: ReadonlyMap<K, V>, key: K, label: string): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Sparse shading ${label} ${String(key)} does not exist`);
  return value;
}

function checkedId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${label} must be a u32`);
  }
  return value;
}

function assertGeneration(value: number, label: string): void {
  checkedId(value, label);
  if (value === 0) throw new RangeError(`${label} must be non-zero`);
}

function incrementU32(value: number, label: string): number {
  if (value >= 0xffffffff) throw new RangeError(`${label} overflow`);
  return value + 1;
}

function decrementU32(value: number, label: string): number {
  if (value <= 0) throw new RangeError(`${label} underflow`);
  return value - 1;
}

function checkedIncrement(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} overflow`);
  }
  return value + 1;
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}
