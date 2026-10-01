import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import type { ShadeTexture } from "../texture/ShadeTexture.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { TextureSurfacePublication } from "./TextureVariation.js";
import type { ResourceAccounting, ResourceHandle } from "../debug/profiling/ResourceAccounting.js";
import { AppearanceProgramRegistry, type AppearanceProgramLease, type AppearanceProgramDescriptor } from "./AppearanceProgramRegistry.js";
import { appearanceResidentKernel, APPEARANCE_ROUTE_STRIDE, type AppearanceResidentKernel,
  type AppearanceSampleResourceProfile } from "../shaders/appearance_resident_kernel.js";
import { decodeGpuTextureRef, GPU_TEXTURE_REF_INVALID } from "./GpuTextureRefAbi.js";
import { encodeSamplerClass, GPU_MATERIAL_VISIBILITY_SAMPLER } from "./GpuMaterialVisibilityAbi.js";
import { AppearanceStaticResidency, appearanceStaticTextureKey, type AppearanceStaticLease } from "./AppearanceStaticResidency.js";
import type { AppearanceAssetPackage } from "../assets/AppearanceAssetPackage.js";
import type { StandardShadeMaterial } from "../material/StandardShadeMaterial.js";
import { standardAppearanceParameters } from "../material/AppearanceRuntimeInputs.js";
import { appearanceCachePlan, appearanceCacheIntegration } from "../shaders/appearance_cache.js";
import { APPEARANCE_FIELD_COUNT } from "./GpuAppearanceCacheAbi.js";
import type { GpuAppearanceCache, PreparedAppearanceCache } from "./GpuAppearanceCache.js";
import { GPU_VISIBILITY_KEY_WGSL, GPU_VISIBILITY_KEY_EMPTY, GPU_VISIBILITY_KEY_INVALID } from "./GpuVisibilityKeyAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL, GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE } from "./GpuMeshletRasterWorkAbi.js";

const APPEARANCE_FRAME_MAX_TASKS = 262144;
const APPEARANCE_FRAME_MAX_PIXELS = 4194304;
const APPEARANCE_FRAME_MAX_INPUT_VECTORS = 96;
const APPEARANCE_FRAME_MAX_OUTPUTS = 64;
const APPEARANCE_DEMAND_WGSL = /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
struct Settings { width: u32, height: u32, task_capacity: u32, max_inputs: u32, max_outputs: u32, reserved0: u32, reserved1: u32, reserved2: u32 }
@group(0) @binding(0) var visibility: texture_2d<u32>;
@group(0) @binding(1) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var<storage, read> material_lookup: array<u32>;
@group(0) @binding(3) var<storage, read> directory: array<u32>;
@group(0) @binding(4) var<storage, read> runtime_inputs: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> tasks: array<vec4u>;
@group(0) @binding(6) var<storage, read_write> task_inputs: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> task_program: array<u32>;
@group(0) @binding(8) var<storage, read_write> pixel_tasks: array<u32>;
@group(0) @binding(9) var<storage, read_write> control: array<atomic<u32>>;
@group(0) @binding(10) var<storage, read_write> indirect: array<u32>;
@group(0) @binding(11) var<storage, read> metadata: array<vec4u>;
@group(0) @binding(12) var<storage, read> input_domains: array<u32>;
@group(0) @binding(13) var<uniform> settings: Settings;
@compute @workgroup_size(8, 8)
fn demand(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= settings.width || id.y >= settings.height { return; }
  let pixel = id.y * settings.width + id.x;
  if pixel >= arrayLength(&pixel_tasks) { return; }
  let key = textureLoad(visibility, vec2i(id.xy), 0).x;
  if key == ${GPU_VISIBILITY_KEY_EMPTY}u || key == ${GPU_VISIBILITY_KEY_INVALID}u { pixel_tasks[pixel] = 0xffffffffu; return; }
  let decoded = oengine_visibility_key_decode(key);
  if decoded.valid == 0u { pixel_tasks[pixel] = 0xffffffffu; return; }
  if decoded.meshlet_work_slot >= meshlet_work.header.written_count { pixel_tasks[pixel] = 0xffffffffu; return; }
  let work = meshlet_work.elements[decoded.meshlet_work_slot];
  if work.material_slot_or_range >= arrayLength(&material_lookup) { pixel_tasks[pixel] = 0xffffffffu; return; }
  let entry = material_lookup[work.material_slot_or_range];
  if entry == 0xffffffffu { pixel_tasks[pixel] = 0xffffffffu; return; }
  let meta = directory[entry * 8u];
  let program = directory[entry * 8u + 1u];
  let slot = atomicAdd(&control[0], 1u);
  if slot >= settings.task_capacity { atomicAdd(&control[1], 1u); pixel_tasks[pixel] = 0xffffffffu; return; }
  let source = entry * 8u;
  let input_base = directory[source + 7u];
  let input_shape = metadata[program * 4u + 3u];
  let input_count = input_shape.x;
  let input_vectors = input_shape.y;
  let task_input_base = slot * settings.max_inputs;
  for (var i = 0u; i < input_vectors; i++) {
    let domain = input_domains[program * settings.max_inputs + i];
    var value = vec4f(0.0);
    if i < input_count { value = runtime_inputs[input_base + i]; }
    if domain == 1u { value = vec4f((f32(id.x) + 0.5) / f32(settings.width), (f32(id.y) + 0.5) / f32(settings.height), 0.0, 0.0); }
    if domain == 2u { value = vec4f(1.0); }
    if domain == 3u { value = vec4f(1.0 / f32(settings.width), 1.0 / f32(settings.height), 0.0, 0.0); }
    task_inputs[task_input_base + i] = value;
  }
  tasks[slot] = vec4u(directory[source + 2u], directory[source + 3u], task_input_base, slot * settings.max_outputs);
  task_program[slot] = program;
  pixel_tasks[pixel] = slot;
}
@compute @workgroup_size(1)
fn finalize() {
  let count = min(atomicLoad(&control[0]), settings.task_capacity);
  indirect[0] = (count + 63u) / 64u; indirect[1] = 1u; indirect[2] = 1u;
  indirect[3] = count;
}
@group(1) @binding(0) var<storage, read> resolve_tasks: array<vec4u>;
@group(1) @binding(1) var<storage, read> resolve_program: array<u32>;
@group(1) @binding(2) var<storage, read> resolve_pixels: array<u32>;
@group(1) @binding(3) var<storage, read> resolve_outputs: array<f32>;
@group(1) @binding(4) var resolve_settings: texture_storage_2d_array<rgba16float, write>;
@group(1) @binding(5) var<uniform> resolve_size: vec4u;
@compute @workgroup_size(8, 8)
fn resolve(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= resolve_size.x || id.y >= resolve_size.y { return; }
  let pixel = id.y * resolve_size.x + id.x;
  let task = resolve_pixels[pixel];
  if task == 0xffffffffu { return; }
  let base = resolve_tasks[task].w;
  for (var field = 0u; field < resolve_size.z; field++) {
    let value = resolve_outputs[base + min(field, resolve_size.w - 1u)];
    textureStore(resolve_settings, vec2i(id.xy), i32(field), vec4f(value, 0.0, 0.0, 1.0));
  }
}
`;

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
}

/** Immutable, actual-sized scene publication. Owns buffers and program leases. */
export class GpuAppearancePublication {
  readonly entries: readonly AppearancePublishedEntry[];
  readonly constants: GPUBuffer;
  readonly routes: GPUBuffer;
  readonly fields: GPUBuffer;
  /** Numeric dynamic inputs, one vec4 per compiled named input. Geometry and
   * surface inputs are supplied by the shared geometry consumer, not this table. */
  readonly runtimeInputs: GPUBuffer;
  readonly cache!: PreparedAppearanceCache;
  /** Eight u32s: material, PSO, constants, routes, resources, field base, field count, reserved. */
  readonly directory: GPUBuffer;
  readonly allocatedBytes: number;
  readonly ready: Promise<void>;
  private readonly leases: readonly AppearanceProgramLease[];
  private readonly staticLeases: AppearanceStaticLease[] = [];
  private readonly buffers: GPUBuffer[] = [];
  private constantValues!: Float32Array<ArrayBuffer>;
  private inputValues!: Float32Array<ArrayBuffer>;
  private fieldWords!: Uint32Array<ArrayBuffer>;
  private fieldDependencies: readonly (readonly number[])[] = [];
  private readonly accountingHandles: ResourceHandle[] = [];
  private readonly frameBuffers: GPUBuffer[] = [];
  private readonly demandLayout: GPUBindGroupLayout;
  private readonly resolveLayout: GPUBindGroupLayout;
  private readonly demandPipeline: Promise<GPUComputePipeline>;
  private readonly demandFinalizePipeline: Promise<GPUComputePipeline>;
  private readonly resolvePipeline: Promise<GPUComputePipeline>;
  private readonly frameTasks: GPUBuffer;
  private readonly frameInputs: GPUBuffer;
  private readonly frameOutputs: GPUBuffer;
  private readonly framePrograms: GPUBuffer;
  private readonly framePixels: GPUBuffer;
  private readonly frameControl: GPUBuffer;
  private readonly frameIndirect: GPUBuffer;
  private readonly frameSettings: GPUBuffer;
  private readonly frameMetadata: GPUBuffer;
  private readonly frameInputDomains: GPUBuffer;
  private readonly materialLookup: GPUBuffer;
  private readonly maxFrameTasks: number;
  private readonly maxFrameInputs = APPEARANCE_FRAME_MAX_INPUT_VECTORS;
  private readonly maxFrameOutputs = APPEARANCE_FRAME_MAX_OUTPUTS;
  private readonly maxFramePixels: number;
  private pipelines: readonly Awaited<AppearanceProgramLease["ready"]>[] | null = null;
  private readonly cancelReadiness: (reason: Error) => void;
  private unwatchRegistry: (() => void) | null = null;
  private readonly destroyedListeners = new Set<() => void>();
  private releasing: ShadeGPUCommandContext | null = null;
  private state: "staging" | "ready" | "resident" | "retiring" | "destroyed" = "staging";

  constructor(private readonly device: GPUDevice, registry: AppearanceProgramRegistry,
    sources: readonly AppearancePublicationSource[], command: ShadeGPUCommandContext,
    mipRanges: ReadonlyMap<ShadeTexture, readonly [number, number]>,
    texturePublications: ReadonlyMap<ShadeTexture, TextureSurfacePublication>,
    private readonly accounting?: ResourceAccounting, staticResidency?: AppearanceStaticResidency,
    private readonly cacheOwner?: GpuAppearanceCache) {
    if (command.device !== device || command.closed) throw new Error("Appearance requires an open command on its GPUDevice");
    const entries: AppearancePublishedEntry[] = [];
    const leaseList: AppearanceProgramLease[] = [];
    const descriptors: AppearanceProgramDescriptor[] = [];
    const leaseIndices = new Map<string, number>();
    const resourceSets = new Map<string, number>();
    const constants: number[] = [];
    const runtimeInputs: number[] = [];
    const fieldDependencies: number[][] = [];
    const fields: number[] = [];
    const routes: ArrayBuffer[] = [];
    const directoryWords = APPEARANCE_DIRECTORY_STRIDE / 4;
    const directory = new Uint32Array(sources.length * directoryWords);
    const assets = new Map<string, AppearanceAssetPackage>();
    const productTargets: { assetId: string; field: string; textures: GPUTexture[]; binding: number }[] = [];
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
          routes.push(packProductRoute(read.asset, layer));
          assets.set(read.asset.runtime.manifest.assetId, read.asset);
          return binding;
        });
        const cachePlan = appearanceCachePlan(source.program, source.program.inputs.length + (source.program.samples.length +
          (source.program.productReads ?? []).filter(read => read.field.constant === undefined).length) * 2, 64);
        const candidate = appearanceResidentKernel(source.program, resources, productResources);
        const kernelKey = candidate.lowered.templateKey + ":resident-linear:" + JSON.stringify([resources, productResources]);
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
          leaseIndices.set(kernelKey, programIndex);
        }
        const constantBase = constants.length;
        const inputBase = runtimeInputs.length / 4;
        for (const input of source.program.inputs) {
          const value = input.domain === "surface" || input.domain === "geometry" ? undefined : source.material.appearance_inputs.get(input.name);
          if (input.domain !== "surface" && input.domain !== "geometry" && value?.length !== input.width) {
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
              if (input.domain !== "geometry" && input.domain !== "surface") numeric.add(-1 - (inputBase + index) * 4 - instruction.channel!);
            }
            pending.push(...instruction.args);
          }
          fieldDependencies.push([...numeric]);
        }
        // Values must come from this instance even when its topology reuses a kernel.
        constants.push(...candidate.lowered.constants);
        entries.push(Object.freeze({ material: source.material, inputBase, materialSlot: source.materialSlot, textureBindingSetId: source.textureBindingSetId,
          constantBase, routeBase, programIndex, resourceSetIndex, kernel, program: source.program, productTextures, fieldBase }));
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
      const maximum = Math.min(Number(device.limits.maxBufferSize), Number(device.limits.maxStorageBufferBindingSize));
      for (const data of [constantData, routeData, directoryData, fieldData, inputData]) if (data.byteLength > maximum) {
        throw new RangeError(`Appearance publication ${data.byteLength} bytes exceed negotiated storage limit ${maximum}`);
      }
      // Publication byte admission precedes every shader/layout/pipeline/buffer creation.
      for (const descriptor of descriptors) registry.preflight(descriptor);
      for (const descriptor of descriptors) leaseList.push(registry.acquire(descriptor));
      const assetLeases = new Map<string, AppearanceStaticLease>();
      for (const [id, asset] of assets) {
        const lease = staticResidency!.acquire(asset, command);
        this.staticLeases.push(lease); assetLeases.set(id, lease);
      }
      for (const target of productTargets) target.textures[target.binding] = assetLeases.get(target.assetId)!.destination(target.field).texture;
      for (const entry of entries) Object.freeze(entry.productTextures);
      this.constants = this.upload(device, command, "constants", constantData);
      this.routes = this.upload(device, command, "routes", routeData);
      this.directory = this.upload(device, command, "directory", directoryData);
      this.fields = this.upload(device, command, "fields", fieldData);
      this.runtimeInputs = this.upload(device, command, "runtime-inputs", inputData);
      const maxMaterialSlot = Math.max(0, ...sources.map(source => source.materialSlot));
      const materialLookupData = new Uint32Array(maxMaterialSlot + 1); materialLookupData.fill(0xffffffff);
      sources.forEach((source, index) => { materialLookupData[source.materialSlot] = index; });
      this.materialLookup = this.upload(device, command, "material-lookup", materialLookupData);
      if (!cacheOwner) throw new Error("Appearance publication requires the shared cache owner");
      const maxInputs = Math.max(0, ...sources.map(source => source.program.inputs.length +
        (source.program.samples.length + (source.program.productReads ?? []).filter(read => read.field.constant === undefined).length) * 2));
      this.cache = cacheOwner.prepare(maxInputs, 4, APPEARANCE_FIELD_COUNT);
      this.constantValues = constantData; this.inputValues = inputData; this.fieldWords = fieldData;
      this.fieldDependencies = fieldDependencies;
      this.allocatedBytes = constantData.byteLength + routeData.byteLength + directoryData.byteLength + fieldData.byteLength + inputData.byteLength;
      this.entries = Object.freeze(entries);
      this.leases = Object.freeze(leaseList);
      const demandModule = device.createShaderModule({ label: "Appearance GPU demand", code: APPEARANCE_DEMAND_WGSL });
      this.demandLayout = device.createBindGroupLayout({ label: "Appearance demand layout", entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint", viewDimension: "2d" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        ...[2, 3, 4].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" as GPUBufferBindingType } })),
        ...[5, 6, 7, 8, 9, 10].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" as GPUBufferBindingType } })),
        { binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 12, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 13, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 32 } }
      ] });
      this.resolveLayout = device.createBindGroupLayout({ label: "Appearance field resolve layout", entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float", viewDimension: "2d-array" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } }
      ] });
      const demandPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.demandLayout] });
      const resolvePipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.demandLayout, this.resolveLayout] });
      this.demandPipeline = device.createComputePipelineAsync({ label: "Appearance/demand", layout: demandPipelineLayout, compute: { module: demandModule, entryPoint: "demand" } });
      const finalizePipeline = device.createComputePipelineAsync({ label: "Appearance/demand-finalize", layout: demandPipelineLayout, compute: { module: demandModule, entryPoint: "finalize" } });
      this.resolvePipeline = device.createComputePipelineAsync({ label: "Appearance/field-resolve", layout: resolvePipelineLayout, compute: { module: demandModule, entryPoint: "resolve" } });
      this.demandFinalizePipeline = finalizePipeline;
      const makeFrame = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
        if (size > Number(device.limits.maxBufferSize) || size > Number(device.limits.maxStorageBufferBindingSize)) throw new RangeError(`Appearance frame buffer '${label}' exceeds negotiated limits`);
        const buffer = device.createBuffer({ label, size: Math.max(4, size), usage }); this.frameBuffers.push(buffer); return buffer;
      };
      const storageLimit = Number(device.limits.maxStorageBufferBindingSize);
      this.maxFrameTasks = Math.min(APPEARANCE_FRAME_MAX_TASKS,
        Math.floor(Math.max(0, storageLimit - 4 * 1024 * 1024) / (this.maxFrameInputs * 16)));
      this.maxFramePixels = Math.min(APPEARANCE_FRAME_MAX_PIXELS, Math.floor(storageLimit / 4));
      if (this.maxFrameTasks < 1024 || this.maxFramePixels < 1024) throw new RangeError("Appearance frame demand budget is below the negotiated storage limit");
      this.frameTasks = makeFrame("Appearance frame tasks", this.maxFrameTasks * 16, GPUBufferUsage.STORAGE);
      this.frameInputs = makeFrame("Appearance frame inputs", this.maxFrameTasks * this.maxFrameInputs * 16, GPUBufferUsage.STORAGE);
      this.frameOutputs = makeFrame("Appearance frame outputs", this.maxFrameTasks * this.maxFrameOutputs * 4, GPUBufferUsage.STORAGE);
      this.framePrograms = makeFrame("Appearance frame program ids", this.maxFrameTasks * 4, GPUBufferUsage.STORAGE);
      this.framePixels = makeFrame("Appearance frame pixel tasks", this.maxFramePixels * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      this.frameControl = makeFrame("Appearance frame control", 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      this.frameIndirect = makeFrame("Appearance frame indirect", 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT);
      this.frameSettings = makeFrame("Appearance frame settings", 32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      this.frameMetadata = makeFrame("Appearance frame metadata", Math.max(16, descriptors.length * 16), GPUBufferUsage.STORAGE);
      this.frameInputDomains = makeFrame("Appearance frame input domains", Math.max(4, descriptors.length * this.maxFrameInputs * 4), GPUBufferUsage.STORAGE);
      const meta = new Uint32Array(Math.max(4, descriptors.length * 4));
      const domains = new Uint32Array(Math.max(1, descriptors.length * this.maxFrameInputs));
      for (const [index, descriptor] of descriptors.entries()) {
        const entry = entries.find(candidate => candidate.programIndex === index)!;
        const inputCount = entry.program.inputs.length;
        meta.set([inputCount, entry.kernel.inputVectorCount, 0, (inputCount & 0xffff) | (entry.kernel.inputVectorCount << 16)], index * 4);
        for (let input = 0; input < inputCount; input++) domains[index * this.maxFrameInputs + input] = entry.program.inputs[input]!.domain === "surface" ? 1 : entry.program.inputs[input]!.domain === "geometry" ? 2 : 0;
        for (let input = inputCount; input < entry.kernel.inputVectorCount; input++) domains[index * this.maxFrameInputs + input] = 3;
      }
      device.queue.writeBuffer(this.frameMetadata, 0, meta);
      device.queue.writeBuffer(this.frameInputDomains, 0, domains);
      let cancel!: (reason: Error) => void;
      const cancellation = new Promise<never>((_resolve, reject) => { cancel = reject; });
      this.cancelReadiness = cancel;
      this.ready = Promise.race([cancellation, Promise.all([...leaseList.map(lease => lease.ready), this.demandPipeline, this.demandFinalizePipeline, this.resolvePipeline]).then(pipelines => {
        if (this.state !== "staging") throw new Error("Appearance publication cancelled before program readiness");
        this.pipelines = Object.freeze(pipelines);
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
      for (const lease of leaseList) lease.release();
      for (const lease of this.staticLeases) lease.release();
      for (const buffer of this.buffers) buffer.destroy();
      if (this.cache) this.cacheOwner?.release(this.cache);
      for (const handle of this.accountingHandles) accounting?.destroyed(handle);
      throw error;
    }
  }

  program(index: number): Awaited<AppearanceProgramLease["ready"]> {
    if (this.state !== "ready" && this.state !== "resident") throw new Error("Appearance publication is not consumable");
    const value = this.pipelines?.[index];
    if (value === undefined) throw new RangeError("Appearance program index is outside this publication");
    return value;
  }

  /** Encode edits into the main frame transaction. Only affected field versions
   * advance; abort leaves CPU authority unchanged so the upload is retried. */
  syncRuntime(command: ShadeGPUCommandContext): void {
    if (command.device !== this.device || command.closed || (this.state !== "ready" && this.state !== "resident")) throw new Error("Appearance edits require an open resident frame");
    const constants = this.constantValues.slice(), inputs = this.inputValues.slice();
    const parameters = new Map<StandardShadeMaterial, ReadonlyMap<string, number>>();
    for (const entry of this.entries) {
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
        if (input.domain === "surface" || input.domain === "geometry") return;
        const value = entry.material.appearance_inputs.get(input.name);
        if (value?.length !== input.width) throw new RangeError(`Appearance input '${input.name}' width changed`);
        inputs.set(value, (entry.inputBase + index) * 4);
      });
    }
    const changed = new Set<number>();
    for (let i = 0; i < constants.length; i++) if (!Object.is(constants[i], this.constantValues[i])) changed.add(i);
    for (let i = 0; i < inputs.length; i++) if (!Object.is(inputs[i], this.inputValues[i])) changed.add(-1 - i);
    if (changed.size === 0) return;
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
    command.onFinished.addOne(() => { this.constantValues = constants; this.inputValues = inputs; this.fieldWords = fields; });
  }

  /** Build visible Appearance demand directly on the GPU and run every finite
   * material program against the compact task stream. The stream is indirect;
   * overflow is counted in the same control buffer and field layers are
   * published only after all program consumers finish. */
  encodeDemand(command: ShadeGPUCommandContext, input: {
    readonly visibility: GPUTextureView;
    readonly meshletWork: GPUBuffer;
    readonly textureBanks: readonly GPUTextureView[];
    readonly width: number;
    readonly height: number;
    readonly fields: GPUTextureView;
    readonly frame: number;
  }): void {
    if (command.device !== this.device || command.closed || (this.state !== "ready" && this.state !== "resident")) {
      throw new Error("Appearance demand requires an open resident frame");
    }
    if (input.width < 1 || input.height < 1 || input.width * input.height > this.maxFramePixels) {
      throw new RangeError("Appearance demand extent exceeds the negotiated frame pixel budget");
    }
    const demand = this.demandPipeline;
    const finalize = this.demandFinalizePipeline;
    const resolve = this.resolvePipeline;
    const makeUniform = (data: Uint32Array): GPUBuffer => command.allocateTransientBufferAndLoad(data.buffer, GPUBufferUsage.UNIFORM);
    command.gpu_encoder.clearBuffer(this.frameControl);
    command.gpu_encoder.clearBuffer(this.framePixels);
    command.writeBuffer(this.frameSettings, 0, new Uint32Array([input.width, input.height, this.maxFrameTasks, this.maxFrameInputs, this.maxFrameOutputs, input.frame, 0, 0]).buffer);
    const demandGroup = this.device.createBindGroup({ layout: this.demandLayout, entries: [
      { binding: 0, resource: input.visibility }, { binding: 1, resource: { buffer: input.meshletWork } },
      { binding: 2, resource: { buffer: this.materialLookup } }, { binding: 3, resource: { buffer: this.directory } },
      { binding: 4, resource: { buffer: this.runtimeInputs } }, { binding: 5, resource: { buffer: this.frameTasks } },
      { binding: 6, resource: { buffer: this.frameInputs } }, { binding: 7, resource: { buffer: this.framePrograms } },
      { binding: 8, resource: { buffer: this.framePixels } }, { binding: 9, resource: { buffer: this.frameControl } },
      { binding: 10, resource: { buffer: this.frameIndirect } }, { binding: 11, resource: { buffer: this.frameMetadata } },
      { binding: 12, resource: { buffer: this.frameInputDomains } }, { binding: 13, resource: { buffer: this.frameSettings } }
    ] });
    const pass = command.gpu_encoder.beginComputePass({ label: "Appearance GPU demand" });
    pass.setPipeline(demand); pass.setBindGroup(0, demandGroup);
    pass.dispatchWorkgroups(Math.ceil(input.width / 8), Math.ceil(input.height / 8));
    pass.setPipeline(finalize); pass.dispatchWorkgroups(1); pass.end();
    const dispatch = makeUniform(new Uint32Array([this.maxFrameTasks, 0, 0, input.frame]));
    for (let programIndex = 0; programIndex < this.leases.length; programIndex++) {
      const lease = this.program(programIndex), entry = this.entries.find(candidate => candidate.programIndex === programIndex);
      if (!entry) continue;
      const layout = lease.layouts[0]!;
      const common: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: this.constants } }, { binding: 1, resource: { buffer: this.routes } },
        { binding: 2, resource: { buffer: this.frameTasks } }, { binding: 3, resource: { buffer: this.frameInputs } },
        { binding: 4, resource: { buffer: this.frameOutputs } }, { binding: 5, resource: { buffer: dispatch } },
        { binding: 11, resource: { buffer: this.framePrograms } }
      ];
      const programGroup = this.device.createBindGroup({ layout, entries: common });
      const textures = entry.kernel.descriptor.groups[1];
      const textureEntries: GPUBindGroupEntry[] = [];
      for (const descriptor of textures ?? []) {
        if (descriptor.texture) textureEntries.push({ binding: descriptor.binding, resource: input.textureBanks[descriptor.binding]! });
        else if (descriptor.sampler) textureEntries.push({ binding: descriptor.binding, resource: this.device.createSampler({ minFilter: "linear", magFilter: "linear", addressModeU: "repeat", addressModeV: "repeat" }) });
      }
      const groups: GPUBindGroup[] = [programGroup];
      if (textureEntries.length) groups.push(this.device.createBindGroup({ layout: lease.layouts[1]!, entries: textureEntries }));
      if (lease.layouts[2]) {
        const productEntries: GPUBindGroupEntry[] = entry.productTextures.map((texture, binding) => ({ binding, resource: texture.createView({ dimension: "2d-array" }) }));
        productEntries.push({ binding: entry.productTextures.length, resource: this.device.createSampler({ minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }) });
        groups.push(this.device.createBindGroup({ layout: lease.layouts[2], entries: productEntries }));
      }
      const programDispatch = makeUniform(new Uint32Array([this.maxFrameTasks, 0, programIndex, input.frame]));
      const programPass = command.gpu_encoder.beginComputePass({ label: `Appearance/evaluate program ${programIndex}` });
      programPass.setPipeline(lease.pipeline); groups.forEach((group, index) => programPass.setBindGroup(index, group));
      programPass.setBindGroup(0, this.device.createBindGroup({ layout, entries: common.map(entryValue => entryValue.binding === 5 ? { binding: 5, resource: { buffer: programDispatch } } : entryValue) }));
      programPass.dispatchWorkgroupsIndirect(this.frameIndirect, 0); programPass.end();
    }
    const resolveSize = makeUniform(new Uint32Array([input.width, input.height, APPEARANCE_FIELD_COUNT, this.maxFrameOutputs]));
    const resolveGroup = this.device.createBindGroup({ layout: this.resolveLayout, entries: [
      { binding: 0, resource: { buffer: this.frameTasks } }, { binding: 1, resource: { buffer: this.framePrograms } },
      { binding: 2, resource: { buffer: this.framePixels } }, { binding: 3, resource: { buffer: this.frameOutputs } },
      { binding: 4, resource: input.fields }, { binding: 5, resource: { buffer: resolveSize } }
    ] });
    const resolvePass = command.gpu_encoder.beginComputePass({ label: "Appearance field publication" });
    resolvePass.setPipeline(resolve); resolvePass.setBindGroup(1, resolveGroup);
    resolvePass.dispatchWorkgroups(Math.ceil(input.width / 8), Math.ceil(input.height / 8)); resolvePass.end();
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
    this.pipelines = null;
    for (const buffer of this.buffers) buffer.destroy();
    for (const buffer of this.frameBuffers) buffer.destroy();
    if (this.cache) this.cacheOwner?.release(this.cache);
    for (const handle of this.accountingHandles) this.accounting?.destroyed(handle);
    for (const lease of this.leases) lease.release();
    for (const lease of this.staticLeases) lease.release();
    for (const callback of this.destroyedListeners) callback();
    this.destroyedListeners.clear();
  }

  private upload(device: GPUDevice, command: ShadeGPUCommandContext, name: string, data: Float32Array | Uint8Array | Uint32Array): GPUBuffer {
    const label = `GpuAppearancePublication/${name}`;
    const buffer = device.createBuffer({ label, size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
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
  return data;
}
