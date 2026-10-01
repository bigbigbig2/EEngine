import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { ResourceAccounting, ResourceHandle } from "../../debug/profiling/ResourceAccounting.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { SPARSE_LIGHTING_GUIDE_LAYERS, SPARSE_LIGHTING_PACKET_BYTES,
  SPARSE_LIGHTING_REFERENCE_BYTES, SPARSE_LIGHTING_SETTINGS_BYTES, SPARSE_LIGHTING_POLICY,
  SPARSE_LIGHTING_RADIANCE_LAYERS,
  sparseLightingProfileKey, type SparseLightingProfile } from "../../gpu/GpuSparseLightingAbi.js";
import { surfaceSparseLightingWgsl } from "../../shaders/surface_sparse_lighting.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import type { PreparedFrameGeometryArena } from "../FrameGeometryArena.js";
import type { LightClusterFrame, ShadowVisibilityFrame } from "../pipeline/FrameProducts.js";
import type { TemporalFactProducts } from "../temporal/TemporalFactsPass.js";
import { counterByteOffset } from "../../debug/GpuFrameCounters.js";
import type { GpuSparseShadingAssetHeapBindings } from "../../gpu/GpuAssetStore.js";

const STAGES = ["prepare_surface", "reset_packets", "classify", "finalize_packets", "evaluate_packets", "reconstruct"] as const;
type Stage = typeof STAGES[number];
type Programs = Readonly<Record<Stage, GPUComputePipeline>>;
function stageBindings(profile: SparseLightingProfile): Record<Stage, number[][]> {
  return {
    prepare_surface: [[0, 1, 2], [...(profile.vsm ? [4, 6] : []), ...(profile.ao ? [10] : [])],
      [0, 1, 2, 3, 4, 6, ...(profile.product ? [7, 8, 9, 10, 11] : [])], [0, 1]],
    reset_packets: [[], [], [], [4]],
    classify: [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13],
      [...(profile.direct ? [1] : []), ...(profile.vsm ? [0, 4, 5, 6] : []), ...(profile.ao ? [10] : [])], [], [2, 3, 4]],
    finalize_packets: [[0], [], [], [4, 5]],
    evaluate_packets: [[0, 1, 2, 3], [...(profile.direct ? [0, 1, 2, 3] : []), ...(profile.vsm ? [4, 5, 6] : []),
      ...(profile.environment ? [7, 8, 9, 12] : []), ...(profile.ao ? [10] : [])], [], [6, 10, 11]],
    reconstruct: [[0, 1, 2, 3, 6, 11, 12], [11, ...(profile.environment ? [9, 12] : []), ...(profile.ao ? [10] : [])], [], [7, 8, 9, 12]]
  };
}
function layoutEntry(group: number, binding: number): GPUBindGroupLayoutEntry {
  const key = `${group}:${binding}`, entry = { binding, visibility: GPUShaderStage.COMPUTE };
  if (key === "1:12") return { ...entry, sampler: { type: "filtering" } };
  if (["0:0", "0:1", "0:13", "1:1", "1:6"].includes(key)) return { ...entry, buffer: { type: "uniform" } };
  if (["0:2", "0:3", "0:9", "0:11", "0:12"].includes(key)) return { ...entry,
    texture: { sampleType: key === "0:3" || key === "0:9" ? "unfilterable-float" : "float", viewDimension: "2d-array" } };
  if (["0:4", "0:7", "0:8", "0:10", "2:4"].includes(key)) return { ...entry, texture: { sampleType: "uint" } };
  if (["0:5", "0:6", "1:7", "1:8", "1:9"].includes(key)) return { ...entry, texture: { sampleType: "float" } };
  if (key === "1:5") return { ...entry, texture: { sampleType: "depth" } };
  const outputs: Record<string, GPUTextureFormat> = { "3:0": "rgba32float", "3:1": "rgba32uint",
    "3:6": "rgba16float", "3:7": "rgba16float", "3:8": "rgba16float", "3:9": "rgba8unorm" };
  if (outputs[key]) return { ...entry, storageTexture: { access: "write-only", format: outputs[key]!,
    viewDimension: ["3:0", "3:6", "3:8"].includes(key) ? "2d-array" : "2d" } };
  return { ...entry, buffer: { type: group === 3 && binding < 6 ? "storage" : "read-only-storage" } };
}
type ScreenSet = {
  readonly width: number; readonly height: number; readonly bytes: number;
  readonly guide: readonly [GPUTexture, GPUTexture];
  readonly signature: readonly [GPUTexture, GPUTexture];
  readonly signals: readonly [GPUTexture, GPUTexture];
  readonly handles: readonly ResourceHandle[];
};
export interface SparseLightingProducts { readonly radiance: ResourceId; readonly reactiveMask: ResourceId; }
export interface SparseLightingInputs {
  readonly fields: ResourceId; readonly visibility: ResourceId;
  readonly geometry: ResourceId; readonly attributes: ResourceId;
  readonly frameInstances: ResourceId; readonly meshletWork: ResourceId;
  readonly vertexPayload: ResourceId; readonly productMetadata?: ResourceId; readonly productBanks?: readonly ResourceId[];
  readonly camera: ResourceId; readonly previousCamera: ResourceId; readonly previousIdentity: ResourceId;
  readonly counters: ResourceId;
  readonly facts: TemporalFactProducts; readonly preExposure: ResourceId;
  readonly clusters?: LightClusterFrame; readonly lightRecords?: ResourceId;
  readonly shadow: ShadowVisibilityFrame | null; readonly scalarAo?: ResourceId;
  readonly environment?: Readonly<{ diffuse: ResourceId; specular: ResourceId; dfg: ResourceId }>;
  readonly frame: Readonly<{ arena: PreparedFrameGeometryArena; filtered: boolean; source: GpuSparseShadingAssetHeapBindings;
    index: number; lightRevision: number; environmentRevision: number; sampleCounters: boolean }>;
  readonly width: number; readonly height: number;
}
export type SparseLightingBinder = <T extends object>(name: string, resolve: (owner: SparseLightingPass) => T) => T;

/** Signal history has physical ownership here. TemporalFabric remains the
 * sole authority for frame roles, validity, successful publication and cuts. */
export class SparseLightingPass {
  private readonly programs = new Map<string, Programs>();
  private readonly sampler: GPUSampler;
  private screen: ScreenSet | null = null;
  private readIndex: 0 | 1 = 0;
  private writeIndex: 0 | 1 = 1;
  private readValid = false;
  private prepared = false;
  private gpuDone: Promise<void> | null = null;
  private ownedBytes = 0;
  private destroyed = false;
  private constructor(private readonly device: GPUDevice, private readonly accounting: ResourceAccounting) {
    if (device.limits.maxBindGroups < 4 || device.limits.maxStorageTexturesPerShaderStage < 3 ||
      device.limits.maxStorageBuffersPerShaderStage < 12 || device.limits.maxSampledTexturesPerShaderStage < 12 ||
      device.limits.maxComputeWorkgroupSizeX < 64 || device.limits.maxComputeInvocationsPerWorkgroup < 64 ||
      device.limits.maxComputeWorkgroupStorageSize < 2060) {
      throw new RangeError("Sparse lighting packet profile exceeds negotiated device limits");
    }
    this.sampler = device.createSampler({ label: "Surface signal IBL/DFG sampler",
      minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" });
  }
  static async create(graphics: GraphicsContext): Promise<SparseLightingPass> {
    const owner = new SparseLightingPass(graphics.device, graphics.resource_accounting);
    try {
      for (const direct of [false, true]) for (const vsm of [false, true]) {
        if (vsm && !direct) continue;
        for (const environment of [false, true]) for (const ao of [false, true]) for (const product of [false, true]) {
          if (ao && !environment) continue;
          const profile = { direct, vsm, environment, ao, product };
          const module = owner.device.createShaderModule({ label: `Surface signal packets/${sparseLightingProfileKey(profile)}`,
            code: surfaceSparseLightingWgsl(profile) });
          const bindingSets = stageBindings(profile);
          const pipelines = await Promise.all(STAGES.map(entryPoint => {
            const layouts = bindingSets[entryPoint].map((bindings, group) => owner.device.createBindGroupLayout({
              entries: bindings.map(binding => layoutEntry(group, binding)) }));
            return owner.device.createComputePipelineAsync({ label: `Surface/${entryPoint}/${sparseLightingProfileKey(profile)}`,
              layout: owner.device.createPipelineLayout({ bindGroupLayouts: layouts }), compute: { module, entryPoint } });
          }));
          owner.programs.set(sparseLightingProfileKey(profile), Object.fromEntries(STAGES.map((stage, i) =>
            [stage, pipelines[i]!])) as unknown as Programs);
        }
      }
      return owner;
    } catch (error) { owner.destroy(); throw error; }
  }
  prepareFrame(width: number, height: number, readIndex: 0 | 1, writeIndex: 0 | 1, readValid: boolean): void {
    if (this.destroyed || this.prepared) throw new Error("Sparse lighting frame lifecycle is not available");
    if (readIndex === writeIndex) throw new Error("Sparse lighting history roles alias");
    if (!this.screen || this.screen.width !== width || this.screen.height !== height) {
      const replacement = this.allocateScreen(width, height);
      this.retireScreen(); this.screen = replacement; readValid = false;
    }
    this.readIndex = readIndex; this.writeIndex = writeIndex; this.readValid = readValid; this.prepared = true;
  }
  history(role: "read" | "write", signal: "guide" | "signature" | "signals"): GPUTexture {
    if (!this.prepared || !this.screen) throw new Error("Sparse lighting screen products are not prepared");
    return this.screen[signal][role === "read" ? this.readIndex : this.writeIndex];
  }
  addToGraph(graph: FrameGraph, input: SparseLightingInputs, bind: SparseLightingBinder): SparseLightingProducts {
    const profile: SparseLightingProfile = { direct: input.clusters !== undefined, vsm: input.shadow?.enabled === true,
      environment: input.environment !== undefined, ao: input.scalarAo !== undefined && input.environment !== undefined,
      product: input.productMetadata !== undefined };
    const programs = this.programs.get(sparseLightingProfileKey(profile));
    if (!programs) throw new Error("Surface signal capability family was not compiled");
    const history = (role: "read" | "write", product: "guide" | "signature" | "signals"): ResourceId =>
      graph.import_resource(`Lighting/${role} ${product}`, { kind: "imported", label: `Lighting/${role} ${product}` },
        bind(`${role}-${product}`, owner => owner.history(role, product)));
    const oldGuide = history("read", "guide"), newGuide = history("write", "guide");
    const oldSignature = history("read", "signature"), newSignature = history("write", "signature");
    const oldSignals = history("read", "signals"), newSignals = history("write", "signals");
    const pixels = input.width * input.height;
    let refs = -1, tasks = -1, control = -1, indirect = -1;
    const resources = new Map<string, ResourceId>([
      ["0:1", input.camera], ["0:2", input.fields], ["0:3", newGuide], ["0:4", newSignature],
      ["0:5", input.facts.motion], ["0:6", input.facts.mask], ["0:7", input.facts.identity],
      ["0:8", input.previousIdentity], ["0:9", oldGuide], ["0:10", oldSignature], ["0:11", oldSignals],
      ["0:13", input.previousCamera],
      ["1:11", input.preExposure], ["2:0", input.geometry], ["2:1", input.attributes],
      ["2:2", input.frameInstances], ["2:3", input.meshletWork], ["2:4", input.visibility],
      ["3:0", newGuide], ["3:1", newSignature], ["3:2", refs], ["3:3", tasks], ["3:4", control],
      ["3:5", indirect], ["3:8", newSignals], ["3:10", indirect], ["3:11", tasks], ["3:12", refs]
    ]);
    resources.set("2:6", input.vertexPayload);
    if (profile.product) {
      if (input.productBanks?.length !== 4) throw new Error("Surface lighting requires four actual Product banks");
      resources.set("2:7", input.productMetadata!);
      input.productBanks.forEach((bank, index) => resources.set(`2:${index + 8}`, bank));
    }
    if (input.clusters) {
      if (input.lightRecords === undefined) throw new Error("Lighting clusters require actual light records");
      resources.set("1:0", input.lightRecords); resources.set("1:1", input.clusters.parameters);
      resources.set("1:2", input.clusters.lookup); resources.set("1:3", input.clusters.data);
    }
    if (profile.vsm) {
      const shadow = input.shadow!;
      if (shadow.virtualPageTable === null || shadow.physicalAtlasDepth === null || shadow.lightProjection === null)
        throw new Error("Lighting VSM requires published page/atlas/projection products");
      resources.set("1:4", shadow.virtualPageTable); resources.set("1:5", shadow.physicalAtlasDepth);
      resources.set("1:6", shadow.lightProjection);
    }
    if (input.environment) {
      resources.set("1:7", input.environment.diffuse); resources.set("1:8", input.environment.specular);
      resources.set("1:9", input.environment.dfg);
    }
    if (profile.ao) resources.set("1:10", input.scalarAo!);
    const textureBindings = new Set(["0:2", "0:3", "0:4", "0:5", "0:6", "0:7", "0:8", "0:9", "0:10", "0:11", "0:12",
      "1:5", "1:7", "1:8", "1:9", "2:4", "3:0", "3:1", "3:6", "3:7", "3:8", "3:9"]);
    const arrayBindings = new Set(["0:2", "0:3", "0:9", "0:11", "0:12", "3:0", "3:6", "3:8"]);
    const bindings = stageBindings(profile);
    const settings = (frame: SparseLightingInputs["frame"]): ArrayBuffer => {
      const data = new ArrayBuffer(SPARSE_LIGHTING_SETTINGS_BYTES), u = new Uint32Array(data), f = new Float32Array(data);
      const policy = SPARSE_LIGHTING_POLICY;
      u.set([input.width, input.height, frame.index, Number(this.readValid), frame.arena.layout.header.offset / 4,
        (frame.filtered ? frame.arena.filteredDirectory : frame.arena.sourceDirectory).offset / 4,
        frame.lightRevision, frame.environmentRevision]);
      f.set([policy.spatialNormalCosine, policy.spatialRelativePosition, policy.specularMinimumRoughness,
        policy.specularViewCosine, policy.temporalNormalCosine, policy.temporalRelativePosition, 0, 0], 8);
      u.set([...policy.maxAge, this.device.limits.maxComputeWorkgroupsPerDimension], 16);
      u[20]=Number(frame.sampleCounters);
      u.set([frame.source.geometryWordBase, frame.source.meshletWordBase, frame.source.meshletVertexWordBase,
        frame.source.meshletTriangleWordBase, frame.source.vertexDataWordBase, 0, 0, 0], 24);
      return data;
    };
    const addStage = (stage: Stage) => graph.add(`Surface/${stage}`, input, (data, resolved, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const uniform = bindings[stage]![0]!.includes(0)
        ? command.allocateTransientBufferAndLoad(settings(data.frame), GPUBufferUsage.UNIFORM) : null;
      const pipeline = programs[stage];
      const compute = command.beginComputePass({ label: `Surface/${stage}` }); compute.setPipeline(pipeline);
      for (let group = 0; group < 4; group++) {
        const selected = bindings[stage]![group]!;
        const entries = selected.map(binding => {
          const key = `${group}:${binding}`; let resource: GPUBindingResource;
          if (key === "0:0") resource = { buffer: uniform! };
          else if (key === "1:12") resource = this.sampler;
          else {
            const value = resolved.get(resources.get(key)!);
            resource = textureBindings.has(key)
              ? resolveTextureView(value, arrayBindings.has(key) ? { dimension: "2d-array" } : undefined)
              : { buffer: value as GPUBuffer };
          }
          return { binding, resource };
        });
        compute.setBindGroup(group, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(group), entries }));
      }
      if (stage === "evaluate_packets") compute.dispatchWorkgroupsIndirect(resolved.get(indirect) as GPUBuffer, 0);
      else if (stage === "reset_packets" || stage === "finalize_packets") compute.dispatchWorkgroups(1);
      else compute.dispatchWorkgroups(Math.ceil(data.width / (stage === "classify" ? 16 : 8)),
        Math.ceil(data.height / (stage === "classify" ? 16 : 8)));
      compute.end();
      if (stage === "finalize_packets" && data.frame.sampleCounters) {
        command.gpu_encoder.copyBufferToBuffer(resolved.get(control) as GPUBuffer, 0,
          resolved.get(data.counters) as GPUBuffer, counterByteOffset("lightingPrimaryPackets"), 16);
      }
    });
    const reads = (pass: ReturnType<FrameGraph["add"]>, ids: readonly ResourceId[]): void => { for (const id of new Set(ids)) pass.read(id); };
    const shadowReads = profile.vsm ? [input.shadow!.virtualPageTable!, input.shadow!.physicalAtlasDepth!, input.shadow!.lightProjection!] : [];
    const providerReads = [...(input.clusters ? [input.lightRecords!, input.clusters.parameters, input.clusters.lookup, input.clusters.data] : []),
      ...shadowReads, ...(input.environment ? [input.environment.diffuse, input.environment.specular, input.environment.dfg] : []),
      ...(profile.ao ? [input.scalarAo!] : [])];
    const prepare = addStage("prepare_surface");
    reads(prepare, [input.camera, input.fields, input.geometry, input.attributes, input.frameInstances, input.meshletWork, input.visibility,
      input.vertexPayload, ...(input.productMetadata === undefined ? [] : [input.productMetadata]), ...(input.productBanks ?? []),
      ...shadowReads, ...(profile.ao ? [input.scalarAo!] : [])]);
    const guideWritten = prepare.write(newGuide), signatureWritten = prepare.write(newSignature);
    resources.set("0:3", guideWritten); resources.set("0:4", signatureWritten);
    const reset = addStage("reset_packets");
    control = reset.create("Lighting packet count", { kind: "transient_buffer", size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const controlReset = control;
    resources.set("3:4", controlReset);
    const classify = addStage("classify");
    reads(classify, [input.camera, input.previousCamera, input.fields, guideWritten, signatureWritten, input.facts.motion, input.facts.mask,
      input.facts.identity, input.previousIdentity, oldGuide, oldSignature, oldSignals,
      ...(input.clusters ? [input.clusters.parameters] : []), ...shadowReads,
      ...(profile.vsm ? [input.lightRecords!] : []), ...(profile.ao ? [input.scalarAo!] : [])]);
    refs = classify.create("Lighting target references", { kind: "transient_buffer", size: pixels * SPARSE_LIGHTING_REFERENCE_BYTES,
      usage: GPUBufferUsage.STORAGE });
    tasks = classify.create("Lighting primary packets", { kind: "transient_buffer", size: pixels * SPARSE_LIGHTING_PACKET_BYTES,
      usage: GPUBufferUsage.STORAGE });
    resources.set("3:2", refs); resources.set("3:3", tasks);
    const refsWritten = refs, tasksWritten = tasks, countWritten = classify.write(controlReset);
    const finalize = addStage("finalize_packets"); finalize.read(countWritten);
    finalize.write(input.counters);
    indirect = finalize.create("Lighting packet dispatch", { kind: "transient_buffer", size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT });
    const dispatchWritten = indirect;
    resources.set("3:5", indirect); resources.set("3:10", dispatchWritten); resources.set("3:11", tasksWritten);
    const evaluate = addStage("evaluate_packets");
    reads(evaluate, [input.camera, input.fields, guideWritten, tasksWritten, dispatchWritten, ...providerReads]);
    const primary = evaluate.create("Lighting current primary radiance", { kind: "transient_texture", width: input.width,
      height: input.height, depthOrArrayLayers: SPARSE_LIGHTING_RADIANCE_LAYERS, format: "rgba16float", domain: "internal-full",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    resources.set("3:6", primary); resources.set("0:12", primary); resources.set("3:12", refsWritten);
    const resolve = addStage("reconstruct");
    reads(resolve, [input.camera, input.fields, guideWritten, input.facts.mask, oldSignals, primary, refsWritten, input.preExposure,
      ...(input.environment ? [input.environment.dfg] : []), ...(profile.ao ? [input.scalarAo!] : [])]);
    resolve.write(newSignals);
    const radiance = resolve.create("Surface pre-exposed HDR radiance", { kind: "transient_texture", width: input.width,
      height: input.height, format: "rgba16float", domain: "internal-full",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    const reactiveMask = resolve.create("Surface signal reactive and validity", { kind: "transient_texture", width: input.width,
      height: input.height, format: "rgba8unorm", domain: "internal-full",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    resources.set("3:7", radiance); resources.set("3:9", reactiveMask);
    return { radiance, reactiveMask };
  }
  commit(done: Promise<void>): void {
    if (!this.prepared) throw new Error("Sparse lighting commit without physical histories");
    this.prepared = false; this.gpuDone = done;
  }
  abort(): void { this.prepared = false; }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.retireScreen(); this.programs.clear(); this.prepared = false;
  }
  private allocateScreen(width: number, height: number): ScreenSet {
    const pixels = width * height;
    const bytes = pixels * (SPARSE_LIGHTING_GUIDE_LAYERS * 16 + 16 + SPARSE_LIGHTING_RADIANCE_LAYERS * 8) * 2;
    if (!Number.isSafeInteger(pixels) || width < 1 || height < 1 || pixels >= 0x80000000 ||
      width > this.device.limits.maxTextureDimension2D || height > this.device.limits.maxTextureDimension2D ||
      pixels * SPARSE_LIGHTING_REFERENCE_BYTES > this.device.limits.maxStorageBufferBindingSize ||
      pixels * SPARSE_LIGHTING_REFERENCE_BYTES > this.device.limits.maxBufferSize ||
      bytes + this.ownedBytes > 1024 * 1024 * 1024) {
      throw new RangeError("Sparse lighting physical screen/history budget exceeds negotiated limits");
    }
    const textures: GPUTexture[] = [], handles: ResourceHandle[] = [];
    const pair = (name: string, format: GPUTextureFormat, layers: number, perPixel: number): readonly [GPUTexture, GPUTexture] =>
      [0, 1].map(index => {
        const texture = this.device.createTexture({ label: `Surface/${name}/${index}`, size: [width, height, layers], format,
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
        textures.push(texture); handles.push(this.accounting.created({ owner: "SparseLighting", kind: "texture", category: "history",
          bytes: pixels * perPixel, label: `${name}/${index}` })); return texture;
      }) as unknown as readonly [GPUTexture, GPUTexture];
    try {
      const guide = pair("guide", "rgba32float", SPARSE_LIGHTING_GUIDE_LAYERS, SPARSE_LIGHTING_GUIDE_LAYERS * 16);
      const signature = pair("signal dependency signatures", "rgba32uint", 1, 16);
      const signals = pair("unexposed lobe radiance", "rgba16float", SPARSE_LIGHTING_RADIANCE_LAYERS, SPARSE_LIGHTING_RADIANCE_LAYERS * 8);
      this.ownedBytes += bytes; return { width, height, bytes, guide, signature, signals, handles };
    } catch (error) { textures.forEach(texture => texture.destroy()); handles.forEach(handle => this.accounting.destroyed(handle)); throw error; }
  }
  private retireScreen(): void {
    const old = this.screen; this.screen = null; if (!old) return;
    const release = () => { for (const texture of [...old.guide, ...old.signature, ...old.signals]) texture.destroy();
      old.handles.forEach(handle => this.accounting.destroyed(handle)); this.ownedBytes -= old.bytes; };
    if (this.gpuDone) void this.gpuDone.then(release, release); else release();
  }
}
