import { GEOMETRY_VERTEX_DATA_TYPE_CODE } from "../../../../OEngine/src/assets/GeometryAssetPackage.js";
import { GPU_SHADING_SURFACE_FLAGS } from "../../../../OEngine/src/gpu/GpuComputeMaterialAbi.js";
import {
  GPU_GEOMETRY_RECORD_STRIDE,
  GPU_MESHLET_RECORD_STRIDE,
  GPU_POSITION_FORMAT,
  GPU_UV_FORMAT,
  packGpuGeometryRecord,
  packGpuMeshletRecords
} from "../../../../OEngine/src/gpu/GpuGeometryAbi.js";
import {
  GPU_INSTANCE_RECORD_STRIDE,
  packGpuInstanceRecord
} from "../../../../OEngine/src/gpu/GpuInstanceAbi.js";
import {
  GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
  GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE,
  packGpuMeshletProfileLodBucket,
  packGpuMeshletRasterWork,
  packGpuMeshletWorkQueueHeader
} from "../../../../OEngine/src/gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_MATERIAL_VISIBILITY_FLAGS } from "../../../../OEngine/src/gpu/GpuMaterialVisibilityAbi.js";
import {
  GPU_SHADING_BIN_FRAME_FLAG,
  GPU_SHADING_BIN_SETTINGS_DYNAMIC_STRIDE,
  GPU_SHADING_BIN_WGSL,
  packGpuShadingBinSettings,
  preflightGpuShadingBinSizing
} from "../../../../OEngine/src/gpu/GpuShadingBinAbi.js";
import {
  GPU_SHADING_MATERIAL_RECORD_STRIDE,
  GPU_SHADING_TEXTURE_ROUTE_STRIDE,
  packGpuShadingMaterialRecord,
  packGpuShadingTextureRoute
} from "../../../../OEngine/src/gpu/GpuShadingMaterialAbi.js";
import {
  GPU_SHADING_PROGRAM_COUNT,
  shadingProgramUsesTextures
} from "../../../../OEngine/src/gpu/GpuShadingProgramAbi.js";
import {
  evaluateGpuShadingProgramReference,
  gpuShadingProgramSpecialization,
  type Vec3
} from "../../../../OEngine/src/gpu/GpuShadingProgramOracle.js";
import type { GpuSparseShadingCapabilityRecord } from "../../../../OEngine/src/gpu/GpuSparseShadingCapability.js";
import {
  createGpuSparseShadingPipelineDescriptor,
  GPU_SHADING_OUTPUT_DEPENDENCY
} from "../../../../OEngine/src/gpu/GpuSparseShadingPipelineContract.js";
import {
  GPU_SPARSE_SHADING_LIGHT_TYPE,
  packGpuSparseShadingLightDatabase
} from "../../../../OEngine/src/gpu/GpuSparseShadingLightAbi.js";
import { encodeGpuTextureRef, GPU_TEXTURE_REF_INVALID } from "../../../../OEngine/src/gpu/GpuTextureRefAbi.js";
import { encodeVisibilityKey } from "../../../../OEngine/src/gpu/GpuVisibilityKeyAbi.js";
import { ShadingBinPass } from "../../../../OEngine/src/render/passes/ShadingBinPass.js";
import { SparseShadingDiagnosticsPass } from "../../../../OEngine/src/render/passes/SparseShadingDiagnosticsPass.js";
import {
  SparseShadingResolvePass,
  type SparseShadingResolveFrameBinding
} from "../../../../OEngine/src/render/passes/SparseShadingResolvePass.js";
import { GPU_SPARSE_SHADING_DIAGNOSTIC_FLAG } from "../../../../OEngine/src/shaders/sparse_shading_resolve.js";

const WIDTH = 33;
const HEIGHT = 33;
const PIXELS = WIDTH * HEIGHT;
const GENERATION = 11;
const MATERIAL_GENERATION = 13;
const TEXTURE_GENERATION = 17;
const GEOMETRY_GENERATION = 19;
const PUBLICATION_REVISION = 23;
const OUTPUT_MASK = GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite |
  GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite |
  GPU_SHADING_OUTPUT_DEPENDENCY.Velocity;
const ROW_BYTES = 512;
const OUTPUT_BYTES = ROW_BYTES * HEIGHT;
const CONTROL_AND_ARGS_BYTES = 32 + 64 * 12;
const BASE_SAMPLE = [64 / 255, 128 / 255, 191 / 255, 1] as const;
const NORMAL_SAMPLE = [128 / 255, 128 / 255, 1, 1] as const;
const ORM_SAMPLE = [51 / 255, 179 / 255, 230 / 255, 1] as const;
const EMISSIVE_SAMPLE = [128 / 255, 64 / 255, 1, 1] as const;
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const PIXEL_VIEW_PROJECTION = new Float32Array([
  2 / WIDTH, 0, 0, 0,
  0, -2 / HEIGHT, 0, 0,
  0, 0, 1, 0,
  -1, 1, 0, 1
]);

export interface ResolveFixtureEvidence {
  readonly scenarios: readonly Readonly<Record<string, unknown>>[];
  readonly invariants: Readonly<Record<string, unknown>>;
  readonly compilation: Readonly<Record<string, unknown>>;
}

type ScenarioKind = "production" | "diagnostics" | "meshlet" | "geometry" |
  "material" | "texture" | "duplicate" | "unassigned";

interface StaticResources {
  readonly settings: GPUBuffer;
  readonly view: GPUBuffer;
  readonly binTexture: GPUTexture;
  readonly visibilityTexture: GPUTexture;
  readonly depthTexture: GPUTexture;
  readonly outputs: readonly GPUTexture[];
  readonly meshletWork: GPUBuffer;
  readonly instances: GPUBuffer;
  readonly assetMetadata: GPUBuffer;
  readonly vertexPayload: GPUBuffer;
  readonly materials: GPUBuffer;
  readonly routes: GPUBuffer;
  readonly textureBanks: readonly GPUTexture[];
  readonly samplers: readonly GPUSampler[];
  readonly lightDatabase: GPUBuffer;
  readonly clusterHeaders: GPUBuffer;
  readonly clusterIndices: GPUBuffer;
  readonly lightSettings: GPUBuffer;
  readonly environmentSettings: GPUBuffer;
  readonly shadowAtlas: GPUTexture;
  readonly environmentTextures: readonly GPUTexture[];
  readonly shadowSampler: GPUSampler;
  readonly environmentSampler: GPUSampler;
}

export class SparseShadingResolveFixture {
  private readonly buffers = new Set<GPUBuffer>();
  private readonly textures = new Set<GPUTexture>();
  private destroyed = false;

  private constructor(
    private readonly device: GPUDevice,
    private readonly binIds: Uint8Array,
    private readonly descriptors: readonly ReturnType<typeof createGpuSparseShadingPipelineDescriptor>[],
    private readonly binPass: ShadingBinPass,
    private readonly production: SparseShadingResolvePass,
    private readonly diagnostics: SparseShadingResolvePass,
    private readonly diagnosticsFinalizer: SparseShadingDiagnosticsPass,
    private readonly resources: StaticResources,
    private readonly duplicatePipeline: GPUComputePipeline,
    private readonly unassignedPipeline: GPUComputePipeline,
    private readonly controlExtractor: GPUComputePipeline,
    private readonly compilation: Readonly<Record<string, unknown>>
  ) {}

  static async create(
    device: GPUDevice,
    capability: Readonly<GpuSparseShadingCapabilityRecord>
  ): Promise<SparseShadingResolveFixture> {
    const descriptors = Object.freeze(Array.from({ length: GPU_SHADING_PROGRAM_COUNT }, (_, programId) =>
      createGpuSparseShadingPipelineDescriptor({
        programId,
        textureBindingSetId: shadingProgramUsesTextures(programId) ? (programId % 3) + 1 : 0,
        outputDependencyMask: OUTPUT_MASK,
        shadowSamplingEnabled: true,
        capability
      })));
    const activeBins = descriptors.map((descriptor) => descriptor.binId);
    const sizing = preflightGpuShadingBinSizing(WIDTH, HEIGHT, activeBins, PUBLICATION_REVISION, {
      maxTextureDimension2D: device.limits.maxTextureDimension2D,
      maxBufferSize: device.limits.maxBufferSize,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      maxComputeWorkgroupsPerDimension: 5
    });
    const binPass = await ShadingBinPass.create(device, sizing, false);
    try {
      const [production, diagnostics, diagnosticsFinalizer] = await Promise.all([
        SparseShadingResolvePass.create(device, descriptors, PUBLICATION_REVISION, false),
        SparseShadingResolvePass.create(device, descriptors, PUBLICATION_REVISION, true),
        SparseShadingDiagnosticsPass.create(device)
      ]);
      const owner = Object.create(SparseShadingResolveFixture.prototype) as SparseShadingResolveFixture;
      const trackedBuffers = new Set<GPUBuffer>();
      const trackedTextures = new Set<GPUTexture>();
      const resources = createStaticResources(device, descriptors, trackedBuffers, trackedTextures);
      const mutation = await createMutationPipelines(device, sizing.layouts[descriptors[1]!.binId]!.recordBase,
        descriptors[1]!.binId);
      const extractor = await createControlExtractor(device);
      Object.assign(owner, {
        device, binIds: createBinIds(descriptors), descriptors, binPass, production, diagnostics,
        diagnosticsFinalizer, resources,
        duplicatePipeline: mutation.duplicate,
        unassignedPipeline: mutation.unassigned,
        controlExtractor: extractor.pipeline,
        compilation: Object.freeze({ mutation: mutation.messages, extraction: extractor.messages }),
        buffers: trackedBuffers,
        textures: trackedTextures,
        destroyed: false
      });
      uploadInputs(device, resources, owner.binIds);
      return owner;
    } catch (error) {
      binPass.destroy();
      throw error;
    }
  }

  async runAll(): Promise<ResolveFixtureEvidence> {
    this.requireAlive();
    const scenarios: Readonly<Record<string, unknown>>[] = [];
    scenarios.push(await this.runScenario("production"));
    scenarios.push(await this.runScenario("diagnostics"));
    scenarios.push(await this.runScenario("meshlet"));
    scenarios.push(await this.runScenario("geometry"));
    scenarios.push(await this.runScenario("material"));
    scenarios.push(await this.runScenario("texture"));
    scenarios.push(await this.runScenario("duplicate"));
    scenarios.push(await this.runScenario("unassigned"));
    return Object.freeze({
      scenarios: Object.freeze(scenarios),
      compilation: this.compilation,
      invariants: Object.freeze({
        extent: [WIDTH, HEIGHT],
        programCount: GPU_SHADING_PROGRAM_COUNT,
        mixedTextureBindingSets: [0, 1, 2, 3],
        edgeMicrotile: [1, 1],
        maxDispatchDimension: 5,
        rectangularDispatchTail: true,
        outputDependencyMask: OUTPUT_MASK,
        outputFormats: ["rgba16float", "rgba16uint", "rgba8unorm", "rg32uint", "rg16float"],
        productionClaimsResources: 0,
        productionDiagnosticsPasses: 0,
        materialEvaluationPerHit: 1,
        directLightingConsumerPasses: 0,
        submitPerScenario: 1
      })
    });
  }

  resourceCounts(): Readonly<{ buffers: number; textures: number; resolveOwners: number }> {
    return Object.freeze({
      buffers: this.buffers.size,
      textures: this.textures.size,
      resolveOwners: this.destroyed ? 0 : 2
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.binPass.destroy();
    this.production.destroy();
    this.diagnostics.destroy();
    for (const buffer of this.buffers) buffer.destroy();
    for (const texture of this.textures) texture.destroy();
    this.buffers.clear();
    this.textures.clear();
  }

  private async runScenario(kind: ScenarioKind): Promise<Readonly<Record<string, unknown>>> {
    restoreMutableInputs(this.device, this.resources);
    clearOutputTextures(this.device, this.resources.outputs);
    const diagnosticsMode = kind !== "production";
    const claims = diagnosticsMode ? this.trackBuffer(this.device.createBuffer({
      label: `${kind} shading claims`, size: PIXELS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    })) : undefined;
    const diagnosticState = diagnosticsMode ? this.trackBuffer(this.device.createBuffer({
      label: `${kind} shading diagnostics`, size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    })) : undefined;
    if (claims) this.device.queue.writeBuffer(claims, 0, new Uint32Array(PIXELS));
    if (diagnosticState) this.device.queue.writeBuffer(diagnosticState, 0, new Uint32Array(4));
    injectIdentityFault(this.device, this.resources, kind);

    const binBindings = await this.binPass.createFrameBindings({
      shadingBinId: this.resources.binTexture.createView(),
      settings: this.resources.settings,
      settingsDynamicOffset: 0,
      generation: GENERATION,
      layoutRevision: PUBLICATION_REVISION
    });
    const resolve = diagnosticsMode ? this.diagnostics : this.production;
    const resolveBindings = createResolveBindings(this.device, resolve, this.descriptors,
      this.binPass, this.resources, diagnosticState, claims);
    const readback = this.trackBuffer(this.device.createBuffer({
      label: `${kind} readback`, size: OUTPUT_BYTES * 5 + CONTROL_AND_ARGS_BYTES + 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    }));
    const control = this.trackBuffer(this.device.createBuffer({
      label: `${kind} control extraction`, size: CONTROL_AND_ARGS_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    }));
    const controlGroup = this.device.createBindGroup({
      layout: this.controlExtractor.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.binPass.heap } },
        { binding: 1, resource: { buffer: this.binPass.indirectArgs } },
        { binding: 2, resource: { buffer: control } }
      ]
    });

    const encoder = this.device.createCommandEncoder({ label: `${kind} sparse shading closure` });
    encodeDepthClear(encoder, this.resources.depthTexture, "visibility depth");
    encodeDepthClear(encoder, this.resources.shadowAtlas, "shadow atlas");
    this.binPass.encode(encoder as never, binBindings);
    if (kind === "duplicate" || kind === "unassigned") {
      const pipeline = kind === "duplicate" ? this.duplicatePipeline : this.unassignedPipeline;
      const pass = encoder.beginComputePass({ label: `${kind} validation fault` });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.binPass.heap } },
          { binding: 1, resource: { buffer: this.binPass.indirectArgs } }
        ]
      }));
      pass.dispatchWorkgroups(1);
      pass.end();
    }
    resolve.encode(encoder as never, this.binPass.indirectArgs, 0, resolveBindings, PUBLICATION_REVISION);
    if (diagnosticsMode) {
      this.diagnosticsFinalizer.encodeFinalize(encoder as never, {
        shadingBinId: this.resources.binTexture.createView(),
        settings: this.resources.settings,
        settingsDynamicOffset: 0,
        claims: claims!, diagnostics: diagnosticState!, width: WIDTH, height: HEIGHT
      });
    }
    const extract = encoder.beginComputePass({ label: `${kind} control extraction` });
    extract.setPipeline(this.controlExtractor);
    extract.setBindGroup(0, controlGroup);
    extract.dispatchWorkgroups(1);
    extract.end();
    for (let index = 0; index < this.resources.outputs.length; index++) {
      encoder.copyTextureToBuffer(
        { texture: this.resources.outputs[index]! },
        { buffer: readback, offset: index * OUTPUT_BYTES, bytesPerRow: ROW_BYTES, rowsPerImage: HEIGHT },
        [WIDTH, HEIGHT, 1]
      );
    }
    encoder.copyBufferToBuffer(control, 0, readback, OUTPUT_BYTES * 5, CONTROL_AND_ARGS_BYTES);
    if (diagnosticState) encoder.copyBufferToBuffer(diagnosticState, 0, readback,
      OUTPUT_BYTES * 5 + CONTROL_AND_ARGS_BYTES, 16);
    this.device.queue.submit([encoder.finish()]);
    await this.device.queue.onSubmittedWorkDone();
    await readback.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(readback.getMappedRange().slice(0));
    readback.unmap();
    const evidence = validateScenario(kind, bytes, this.binIds);
    this.destroyBuffer(readback);
    this.destroyBuffer(control);
    if (claims) this.destroyBuffer(claims);
    if (diagnosticState) this.destroyBuffer(diagnosticState);
    return evidence;
  }

  private trackBuffer(buffer: GPUBuffer): GPUBuffer { this.buffers.add(buffer); return buffer; }
  private destroyBuffer(buffer: GPUBuffer): void { buffer.destroy(); this.buffers.delete(buffer); }
  private requireAlive(): void { if (this.destroyed) throw new Error("Sparse shading resolve fixture is destroyed"); }
}

function createStaticResources(
  device: GPUDevice,
  descriptors: readonly ReturnType<typeof createGpuSparseShadingPipelineDescriptor>[],
  buffers: Set<GPUBuffer>,
  textures: Set<GPUTexture>
): StaticResources {
  const buffer = (label: string, size: number, usage: GPUBufferUsageFlags) => {
    const value = device.createBuffer({ label, size: Math.max(4, size), usage }); buffers.add(value); return value;
  };
  const texture = (descriptor: GPUTextureDescriptor) => {
    const value = device.createTexture(descriptor); textures.add(value); return value;
  };
  const output = (format: GPUTextureFormat) => texture({
    label: `ADR-0013 resolve ${format}`, size: [WIDTH, HEIGHT], format,
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
  });
  const textureBanks = Array.from({ length: 9 }, (_, index) => texture({
    label: `ADR-0013 texture bank ${index}`, size: [1, 1, 5], format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  }));
  const environmentTextures = Array.from({ length: 3 }, (_, index) => texture({
    label: `ADR-0013 environment ${index}`, size: [1, 1], format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  }));
  const assetBytes = GPU_GEOMETRY_RECORD_STRIDE + GPU_MESHLET_RECORD_STRIDE + 4;
  return {
    settings: buffer("ADR-0013 resolve bin settings", GPU_SHADING_BIN_SETTINGS_DYNAMIC_STRIDE,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
    view: buffer("ADR-0013 resolve view", 256, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
    binTexture: texture({ label: "ADR-0013 resolve bins", size: [WIDTH, HEIGHT], format: "r8uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST }),
    visibilityTexture: texture({ label: "ADR-0013 resolve visibility", size: [WIDTH, HEIGHT], format: "r32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }),
    depthTexture: texture({ label: "ADR-0013 resolve depth", size: [WIDTH, HEIGHT], format: "depth32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT }),
    outputs: [output("rgba16float"), output("rgba16uint"), output("rgba8unorm"), output("rg32uint"), output("rg16float")],
    meshletWork: buffer("ADR-0013 resolve MeshletWork",
      GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE + descriptors.length * GPU_MESHLET_RASTER_WORK_RECORD_STRIDE,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    instances: buffer("ADR-0013 resolve instances", GPU_INSTANCE_RECORD_STRIDE,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    assetMetadata: buffer("ADR-0013 resolve asset metadata", assetBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    vertexPayload: buffer("ADR-0013 resolve vertex payload", 16 + 3 * 68,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    materials: buffer("ADR-0013 resolve materials", descriptors.length * GPU_SHADING_MATERIAL_RECORD_STRIDE,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    routes: buffer("ADR-0013 resolve routes", descriptors.length * 4 * GPU_SHADING_TEXTURE_ROUTE_STRIDE,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    textureBanks, samplers: Array.from({ length: 6 }, () => device.createSampler({
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", minFilter: "nearest", magFilter: "nearest"
    })),
    lightDatabase: buffer("ADR-0013 resolve lights", 128, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    clusterHeaders: buffer("ADR-0013 resolve cluster headers", 144, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    clusterIndices: buffer("ADR-0013 resolve cluster indices", 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    lightSettings: buffer("ADR-0013 resolve light settings", 64, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
    environmentSettings: buffer("ADR-0013 resolve environment settings", 32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
    shadowAtlas: texture({ label: "ADR-0013 resolve shadow atlas", size: [1, 1], format: "depth32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT }),
    environmentTextures,
    shadowSampler: device.createSampler({ compare: "less-equal" }),
    environmentSampler: device.createSampler({ minFilter: "nearest", magFilter: "nearest" })
  };
}

function uploadInputs(device: GPUDevice, resources: StaticResources, binIds: Uint8Array): void {
  const microtilesX = Math.ceil(WIDTH / 8);
  device.queue.writeBuffer(resources.settings, 0, packGpuShadingBinSettings({
    width: WIDTH, height: HEIGHT, microtilesX, generation: GENERATION,
    allowedMaskLo: activeMask(binIds, false), allowedMaskHi: activeMask(binIds, true),
    maxDispatchDimension: 5, layoutRevision: PUBLICATION_REVISION
  }));
  const view = new ArrayBuffer(240); const v = new DataView(view);
  [WIDTH, HEIGHT, GPU_SHADING_PROGRAM_COUNT, 1, MATERIAL_GENERATION, TEXTURE_GENERATION,
    GEOMETRY_GENERATION, PUBLICATION_REVISION, 0, 60, 88, 0, 3, 4, 7, 0]
    .forEach((value, index) => v.setUint32(index * 4, value, true));
  v.setFloat32(64, 2, true); v.setFloat32(72, 1, true); v.setFloat32(76, 1, true);
  [16.5, 16, 100, 1].forEach((value, index) => v.setFloat32(96 + index * 4, value, true));
  new Float32Array(view, 112, 16).set(PIXEL_VIEW_PROJECTION);
  new Float32Array(view, 176, 16).set(PIXEL_VIEW_PROJECTION);
  device.queue.writeBuffer(resources.view, 0, view);
  uploadR8(device, resources.binTexture, binIds);
  const keys = new Uint32Array(PIXELS);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    keys[y * WIDTH + x] = encodeVisibilityKey(programAt(x, y), 0);
  }
  uploadR32(device, resources.visibilityTexture, keys);
  const one = new Uint8Array([255, 255, 255, 255]);
  for (const texture of resources.environmentTextures) device.queue.writeTexture({ texture }, one, {}, [1, 1, 1]);
  const bank = new Uint8Array(256 * 5);
  bank.set([255, 255, 255, 255], 0);
  bank.set([64, 128, 191, 255], 256);
  bank.set([128, 128, 255, 255], 512);
  bank.set([51, 179, 230, 255], 768);
  bank.set([128, 64, 255, 255], 1024);
  for (const texture of resources.textureBanks) {
    device.queue.writeTexture({ texture }, bank, { bytesPerRow: 256, rowsPerImage: 1 }, [1, 1, 5]);
  }
  restoreMutableInputs(device, resources);
  device.queue.writeBuffer(resources.instances, 0, packGpuInstanceRecord({
    geometryRecordIndex: 0, materialHandle: 0, flags: 0, debugId: 1,
    boundsSphere: [40, 40, 0, 60], boundsMin: [0, 0, 0], boundsMax: [80, 80, 0],
    currentObjectToWorld: IDENTITY, previousObjectToWorld: IDENTITY
  }));
  const vertex = new ArrayBuffer(16 + 3 * 68); const words = new Uint32Array(vertex);
  words.set([0, 1, 2]); new Uint8Array(vertex).set([0, 1, 2], 12);
  const positions = [[0, 0, 0], [80, 0, 0], [0, 80, 0]];
  const uvs = [[0, 0], [1, 0], [0, 1]];
  const floats = new Float32Array(vertex);
  for (let i = 0; i < 3; i++) {
    const base = 4 + i * 17;
    floats.set(positions[i]!, base); floats.set(uvs[i]!, base + 3);
    floats.set([0, 0, 1, 0], base + 5); floats.set([1, 0, 0, 1], base + 9);
    floats.set([0.5, 0.8, 1, 1], base + 13);
  }
  device.queue.writeBuffer(resources.vertexPayload, 0, vertex);
  const light = packGpuSparseShadingLightDatabase({
    directional: [{ type: GPU_SPARSE_SHADING_LIGHT_TYPE.Directional, flags: 0,
      shadowRecord: 0, shadowRecordCount: 0, position: [0, 0, 0], range: 1,
      direction: [0, 0, 1], outerConeCos: 0, color: [2, 1, 0.5], intensity: 1,
      radius: 0, innerConeCos: 0 }], local: [], shadowRecords: []
  });
  device.queue.writeBuffer(resources.lightDatabase, 0, light);
  device.queue.writeBuffer(resources.clusterHeaders, 0, new Uint32Array(36));
  device.queue.writeBuffer(resources.clusterIndices, 0, new Uint32Array([0]));
  const lightSettings = new ArrayBuffer(64); const ls = new DataView(lightSettings);
  [3, 3, 1, 0].forEach((value, index) => ls.setUint32(index * 4, value, true));
  ls.setFloat32(16, 1, true); ls.setFloat32(20, 0, true);
  ls.setUint32(32, 0, true); ls.setUint32(36, 1, true); ls.setUint32(40, 0, true);
  device.queue.writeBuffer(resources.lightSettings, 0, lightSettings);
  device.queue.writeBuffer(resources.environmentSettings, 0, new Uint32Array(8));
}

function restoreMutableInputs(device: GPUDevice, resources: StaticResources): void {
  const queue = new Uint8Array(GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE +
    GPU_SHADING_PROGRAM_COUNT * GPU_MESHLET_RASTER_WORK_RECORD_STRIDE);
  queue.set(packGpuMeshletWorkQueueHeader({ attemptedCount: GPU_SHADING_PROGRAM_COUNT,
    writtenCount: GPU_SHADING_PROGRAM_COUNT, consumedCount: 0, capacity: GPU_SHADING_PROGRAM_COUNT,
    overflowCount: 0, generation: GENERATION, invalidCount: 0 }));
  for (let programId = 0; programId < GPU_SHADING_PROGRAM_COUNT; programId++) {
    queue.set(packGpuMeshletRasterWork({ instanceSlot: 0, geometrySlot: 0, meshletSlot: 0,
      materialSlotOrRange: programId, packedRasterFlags: binForProgram(programId) << 8,
      packedProfileLod: packGpuMeshletProfileLodBucket(2, 0, 0, 0) }),
    GPU_MESHLET_WORK_QUEUE_HEADER_STRIDE + programId * GPU_MESHLET_RASTER_WORK_RECORD_STRIDE);
  }
  device.queue.writeBuffer(resources.meshletWork, 0, queue);
  const asset = createAssetMetadata(); device.queue.writeBuffer(resources.assetMetadata, 0, asset);
  const materialBytes = new Uint8Array(GPU_SHADING_PROGRAM_COUNT * GPU_SHADING_MATERIAL_RECORD_STRIDE);
  const routeBytes = new Uint8Array(GPU_SHADING_PROGRAM_COUNT * 4 * GPU_SHADING_TEXTURE_ROUTE_STRIDE);
  for (let programId = 0; programId < GPU_SHADING_PROGRAM_COUNT; programId++) {
    const specialization = gpuShadingProgramSpecialization(programId, OUTPUT_MASK);
    const set = shadingProgramUsesTextures(programId) ? (programId % 3) + 1 : 0;
    const base = specialization.baseTexture === "never" ? GPU_TEXTURE_REF_INVALID : encodeGpuTextureRef(0, 1);
    const normal = specialization.normalTexture === "never" ? GPU_TEXTURE_REF_INVALID : encodeGpuTextureRef(0, 2);
    const orm = specialization.ormTexture === "never" ? GPU_TEXTURE_REF_INVALID : encodeGpuTextureRef(0, 3);
    const emissive = specialization.emissiveTexture === "never" ? GPU_TEXTURE_REF_INVALID : encodeGpuTextureRef(0, 4);
    let flags = GPU_MATERIAL_VISIBILITY_FLAGS.Valid;
    if (programId < 4) flags |= GPU_MATERIAL_VISIBILITY_FLAGS.Unlit;
    if (normal !== GPU_TEXTURE_REF_INVALID) flags |= GPU_MATERIAL_VISIBILITY_FLAGS.HasNormalTexture;
    if (orm !== GPU_TEXTURE_REF_INVALID) flags |= GPU_MATERIAL_VISIBILITY_FLAGS.HasOrmTexture;
    if (emissive !== GPU_TEXTURE_REF_INVALID) flags |= GPU_MATERIAL_VISIBILITY_FLAGS.HasEmissiveTexture;
    materialBytes.set(packGpuShadingMaterialRecord({ programId, textureBindingSetId: set,
      materialGeneration: MATERIAL_GENERATION, textureGeneration: TEXTURE_GENERATION,
      publicationRevision: PUBLICATION_REVISION, flags: 0 }, {
      kernelClass: 0, alphaMode: 0, flags, textureRef: base,
      baseColorFactorAlpha: 1, alphaCutoff: 0.5, textureUvSets: 0,
      samplerClass: 0,
      uvOffset: [0, 0], uvScale: [1, 1], rotationCos: 1, rotationSin: 0,
      baseColorFactor: [0.8, 0.5, 0.25, 1], metallicFactor: 0.4,
      perceptualRoughness: 0.6, normalScale: 1, occlusionStrength: 0.75,
      emissiveFactor: [0.1, 0.2, 0.3, 1], normalTextureRef: normal,
      ormTextureRef: orm, emissiveTextureRef: emissive, textureSamplerClasses: 0,
      normalUvOffset: [0, 0], normalUvScale: [1, 1], normalRotationCos: 1, normalRotationSin: 0,
      ormUvOffset: [0, 0], ormUvScale: [1, 1], ormRotationCos: 1, ormRotationSin: 0,
      emissiveUvOffset: [0, 0], emissiveUvScale: [1, 1], emissiveRotationCos: 1, emissiveRotationSin: 0,
      textureBindingSetId: set
    }), programId * GPU_SHADING_MATERIAL_RECORD_STRIDE);
    [base, normal, orm, emissive].forEach((textureRef, slot) => routeBytes.set(
      packGpuShadingTextureRoute({ textureRef, textureGeneration: TEXTURE_GENERATION,
        publicationRevision: PUBLICATION_REVISION, textureBindingSetId: set }),
      (programId * 4 + slot) * GPU_SHADING_TEXTURE_ROUTE_STRIDE));
  }
  device.queue.writeBuffer(resources.materials, 0, materialBytes);
  device.queue.writeBuffer(resources.routes, 0, routeBytes);
}

function createAssetMetadata(): Uint8Array {
  const result = new Uint8Array(GPU_GEOMETRY_RECORD_STRIDE + GPU_MESHLET_RECORD_STRIDE + 4);
  result.set(packGpuGeometryRecord({ boundsSphere: [40, 40, 0, 60], boundsMin: [0, 0, 0, 0],
    boundsMax: [80, 80, 0, 0], vertexCount: 3, indexBegin: 0, indexCount: 3,
    meshletBegin: 0, meshletCount: 1, clusterBegin: 0, clusterRoot: 0, clusterCount: 0,
    bvhBegin: 0, bvhRoot: 0, bvhCount: 0, materialRangeBegin: 0, materialRangeCount: 1,
    streamDescriptorBegin: 0, streamDescriptorCount: 4, vertexDataByteBegin: 0,
    vertexDataByteLength: 204, positionByteOffset: 0, positionStride: 68,
    positionFormat: GPU_POSITION_FORMAT.Float32x3, flags: 0,
    uv0ByteOffset: 12, uv0Stride: 68, uv0Format: GPU_UV_FORMAT.Float32x2,
    uv1ByteOffset: 0, uv1Stride: 0, uv1Format: 0, uv2ByteOffset: 0, uv2Stride: 0, uv2Format: 0,
    normalDescriptor: 1, tangentDescriptor: 2, colorDescriptor: 3,
    normalByteOffset: 20, normalStride: 68, normalFormat: GEOMETRY_VERTEX_DATA_TYPE_CODE.float32,
    normalNormalized: 0, tangentByteOffset: 36, tangentStride: 68,
    tangentFormat: GEOMETRY_VERTEX_DATA_TYPE_CODE.float32, tangentNormalized: 0,
    colorByteOffset: 52, colorStride: 68, colorFormat: GEOMETRY_VERTEX_DATA_TYPE_CODE.float32,
    colorNormalized: 0 }));
  result.set(packGpuMeshletRecords([{ vertexOffset: 0, vertexCount: 3, triangleByteOffset: 0,
    triangleCount: 1, materialRangeIndex: 0, materialId: 0, flags: 0,
    boundsMin: [0, 0, 0, 0], boundsMax: [80, 80, 0, 0], boundsSphere: [40, 40, 0, 60],
    coneApex: [0, 0, 0, 0], coneAxisCutoff: [0, 0, 1, 1] }]), GPU_GEOMETRY_RECORD_STRIDE);
  new DataView(result.buffer).setUint32(GPU_GEOMETRY_RECORD_STRIDE + GPU_MESHLET_RECORD_STRIDE,
    GEOMETRY_GENERATION, true);
  return result;
}

function createResolveBindings(
  device: GPUDevice,
  owner: SparseShadingResolvePass,
  descriptors: readonly ReturnType<typeof createGpuSparseShadingPipelineDescriptor>[],
  binPass: ShadingBinPass,
  r: StaticResources,
  diagnostics?: GPUBuffer,
  claims?: GPUBuffer
): readonly SparseShadingResolveFrameBinding[] {
  const resource = (name: string): GPUBindingResource => {
    const buffers: Record<string, GPUBuffer> = {
      shading_bin_settings: r.settings, shading_bin_heap: binPass.heap, shading_view: r.view,
      meshlet_work: r.meshletWork, instance_records: r.instances, asset_metadata_heap: r.assetMetadata,
      vertex_payload_heap: r.vertexPayload, material_records: r.materials,
      texture_descriptor_routing_heap: r.routes, light_database: r.lightDatabase,
      light_cluster_headers: r.clusterHeaders, light_cluster_indices: r.clusterIndices,
      light_settings: r.lightSettings, environment_settings: r.environmentSettings
    };
    if (buffers[name]) return { buffer: buffers[name]! };
    if (name === "shading_bin_id") return r.binTexture.createView();
    if (name === "visibility_key") return r.visibilityTexture.createView();
    if (name === "visibility_depth") return r.depthTexture.createView({ aspect: "depth-only" });
    if (name === "output_hdr") return r.outputs[0]!.createView();
    if (name === "output_normal") return r.outputs[1]!.createView();
    if (name === "output_albedo_ao") return r.outputs[2]!.createView();
    if (name === "output_material") return r.outputs[3]!.createView();
    if (name === "output_velocity") return r.outputs[4]!.createView();
    if (name.startsWith("material_texture_")) return r.textureBanks[Number(name.slice(-1))]!.createView({ dimension: "2d-array" });
    if (name.startsWith("material_sampler_")) return r.samplers[Number(name.slice(-1))]!;
    if (name === "shadow_atlas") return r.shadowAtlas.createView({ aspect: "depth-only" });
    if (name.startsWith("environment_texture_")) return r.environmentTextures[Number(name.slice(-1))]!.createView();
    if (name === "shadow_sampler") return r.shadowSampler;
    if (name === "environment_sampler") return r.environmentSampler;
    throw new Error(`Missing validation resource ${name}`);
  };
  return descriptors.map((descriptor) => {
    const record = owner.pipelineForBin(descriptor.binId);
    const groups = descriptor.groups.map((group, groupIndex) => {
      const entries: GPUBindGroupEntry[] = group.bindings.map((binding) => ({
        binding: binding.binding, resource: resource(binding.name)
      }));
      if (owner.diagnostics && groupIndex === 0) {
        entries.push({ binding: 11, resource: { buffer: diagnostics! } },
          { binding: 12, resource: { buffer: claims! } });
      }
      return device.createBindGroup({ layout: record.bindGroupLayouts[groupIndex]!, entries });
    });
    return Object.freeze({ binId: descriptor.binId, groups: Object.freeze(groups) });
  });
}

async function createMutationPipelines(device: GPUDevice, recordBase: number, binId: number) {
  const module = device.createShaderModule({ label: "ADR-0013 resolve diagnostic mutations", code: `
${GPU_SHADING_BIN_WGSL}
@group(0) @binding(0) var<storage,read_write> heap:OEngineShadingBinHeap;
@group(0) @binding(1) var<storage,read_write> args:array<u32>;
@compute @workgroup_size(1) fn duplicate(){heap.records[${recordBase + 1}u]=heap.records[${recordBase}u];atomicStore(&heap.counters[${binId}u].attempted_count,2u);atomicStore(&heap.counters[${binId}u].written_count,2u);args[${binId * 3}u]=2u;args[${binId * 3 + 1}u]=1u;args[${binId * 3 + 2}u]=1u;}
@compute @workgroup_size(1) fn unassigned(){if atomicLoad(&heap.control.frame_flags)==0xffffffffu{return;}args[${binId * 3}u]=0u;args[${binId * 3 + 1}u]=1u;args[${binId * 3 + 2}u]=1u;}` });
  const info = await module.getCompilationInfo(); assertNoCompilationErrors(info, "mutation");
  return {
    duplicate: await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "duplicate" } }),
    unassigned: await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "unassigned" } }),
    messages: compilationMessages(info)
  };
}

async function createControlExtractor(device: GPUDevice) {
  const module = device.createShaderModule({ label: "ADR-0013 resolve control extraction", code: `
@group(0) @binding(0) var<storage,read> heap:array<u32>;
@group(0) @binding(1) var<storage,read> args:array<u32>;
@group(0) @binding(2) var<storage,read_write> output:array<u32>;
@compute @workgroup_size(256) fn extract(@builtin(local_invocation_id) id:vec3u){if id.x<8u{output[id.x]=heap[id.x];}if id.x<192u{output[8u+id.x]=args[id.x];}}` });
  const info = await module.getCompilationInfo(); assertNoCompilationErrors(info, "control extraction");
  return { pipeline: await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "extract" } }),
    messages: compilationMessages(info) };
}

function injectIdentityFault(device: GPUDevice, r: StaticResources, kind: ScenarioKind): void {
  if (kind === "meshlet") device.queue.writeBuffer(r.meshletWork, 20, new Uint32Array([GENERATION + 1]));
  if (kind === "geometry") device.queue.writeBuffer(r.assetMetadata,
    GPU_GEOMETRY_RECORD_STRIDE + GPU_MESHLET_RECORD_STRIDE, new Uint32Array([GEOMETRY_GENERATION + 1]));
  if (kind === "material") device.queue.writeBuffer(r.materials,
    4 * GPU_SHADING_MATERIAL_RECORD_STRIDE + 8, new Uint32Array([MATERIAL_GENERATION + 1]));
  if (kind === "texture") device.queue.writeBuffer(r.routes,
    (2 * 4) * GPU_SHADING_TEXTURE_ROUTE_STRIDE + 4, new Uint32Array([TEXTURE_GENERATION + 1]));
}

function validateScenario(kind: ScenarioKind, bytes: Uint8Array, binIds: Uint8Array): Readonly<Record<string, unknown>> {
  const control = new Uint32Array(bytes.buffer, bytes.byteOffset + OUTPUT_BYTES * 5, 8);
  const allArgs = new Uint32Array(bytes.buffer, bytes.byteOffset + OUTPUT_BYTES * 5 + 32, 192);
  const diagnostic = new Uint32Array(bytes.buffer,
    bytes.byteOffset + OUTPUT_BYTES * 5 + CONTROL_AND_ARGS_BYTES, 4);
  const program0Args = Array.from(allArgs.slice(0, 3));
  const mutationBin = binForProgram(1);
  const mutationArgs = Array.from(allArgs.slice(mutationBin * 3, mutationBin * 3 + 3));
  const hdr = decodeHalfTexture(bytes.subarray(0, OUTPUT_BYTES), 4);
  let maxHdrError = 0, maxAlbedoError = 0, maxNormalError = 0, maxMaterialError = 0, maxVelocityError = 0;
  let nonzero = 0;
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const pixel = y * WIDTH + x; const row = y * ROW_BYTES;
    if (hdr[pixel * 4 + 3]! !== 0) nonzero++;
    if (kind === "production" || kind === "diagnostics") {
      const programId = programAt(x, y);
      const viewDirection = normalize([16.5 - (x + 0.5), 16 - (y + 0.5), 100]);
      const expected = evaluateGpuShadingProgramReference({ programId, outputDependencyMask: OUTPUT_MASK,
        material: { baseColorFactor: [0.8, 0.5, 0.25], metallicFactor: 0.4,
          roughnessFactor: 0.6, normalScale: 1, occlusionStrength: 0.75,
          emissiveFactor: [0.1, 0.2, 0.3], vertexColor: [0.5, 0.8, 1],
          baseSample: BASE_SAMPLE, ormSample: ORM_SAMPLE, normalSample: NORMAL_SAMPLE,
          emissiveSample: EMISSIVE_SAMPLE, shadingNormal: [0, 0, 1], geometricNormal: [0, 0, 1],
          tangent: [1, 0, 0, 1] }, viewDirection,
        directLights: [{ direction: [0, 0, 1], radiance: [2, 1, 0.5], visibility: 1 }],
        preExposure: 2, gradientValid: true });
      for (let c = 0; c < 3; c++) maxHdrError = Math.max(maxHdrError,
        Math.abs(hdr[pixel * 4 + c]! - expected.radiance[c]!));
      maxHdrError = Math.max(maxHdrError, Math.abs(hdr[pixel * 4 + 3]! - 1));
      const normalOffset = OUTPUT_BYTES + row + x * 8;
      const normalView = new DataView(bytes.buffer, bytes.byteOffset + normalOffset, 8);
      const expectedNormal = [...encodeOct(expected.shadingNormal), ...encodeOct(expected.geometricNormal)];
      for (let c = 0; c < 4; c++) maxNormalError = Math.max(maxNormalError,
        Math.abs(normalView.getUint16(c * 2, true) - expectedNormal[c]!));
      const albedoOffset = OUTPUT_BYTES * 2 + row + x * 4;
      const expectedAlbedo = (programId < 4 ? [0, 0, 0, 1]
        : [...expected.albedo, expected.ambientOcclusion]).map((value) => Math.round(value * 255));
      for (let c = 0; c < 4; c++) maxAlbedoError = Math.max(maxAlbedoError,
        Math.abs(bytes[albedoOffset + c]! - expectedAlbedo[c]!));
      const materialOffset = OUTPUT_BYTES * 3 + row + x * 8;
      const mv = new DataView(bytes.buffer, bytes.byteOffset + materialOffset, 8);
      let flags = GPU_SHADING_SURFACE_FLAGS.Valid | GPU_SHADING_SURFACE_FLAGS.MotionValid;
      const specialization = gpuShadingProgramSpecialization(programId, OUTPUT_MASK);
      if (programId < 4) flags |= GPU_SHADING_SURFACE_FLAGS.Unlit;
      if (specialization.normalTexture !== "never") flags |= GPU_SHADING_SURFACE_FLAGS.NormalTexture;
      if (specialization.ormTexture !== "never") flags |= GPU_SHADING_SURFACE_FLAGS.OrmTexture;
      if (specialization.emissiveTexture !== "never") flags |= GPU_SHADING_SURFACE_FLAGS.EmissiveTexture;
      const packed = Math.round(expected.metallic * 255) |
        (Math.round(expected.roughness * 255) << 8) | (flags << 16);
      maxMaterialError = Math.max(maxMaterialError, mv.getUint32(0, true) === (packed >>> 0) ? 0 : 1,
        mv.getUint32(4, true) === encodeRgbe9995(programId < 4 ? expected.albedo : expected.emissive) ? 0 : 1);
      const velocityOffset = OUTPUT_BYTES * 4 + row + x * 4;
      const vv = new DataView(bytes.buffer, bytes.byteOffset + velocityOffset, 4);
      maxVelocityError = Math.max(maxVelocityError, Math.abs(halfToFloat(vv.getUint16(0, true))),
        Math.abs(halfToFloat(vv.getUint16(2, true))));
    }
  }
  if (kind === "production" || kind === "diagnostics") {
    assertAtMost(maxHdrError, 0.025, `${kind} HDR`); assertAtMost(maxNormalError, 1, `${kind} normal`);
    assertAtMost(maxAlbedoError, 1, `${kind} albedo/AO`); assertAtMost(maxMaterialError, 0, `${kind} material`);
    assertAtMost(maxVelocityError, 0, `${kind} velocity`);
  }
  const counts = Array.from({ length: GPU_SHADING_PROGRAM_COUNT }, (_, program) =>
    Array.from(binIds).filter((_, pixel) => programAt(pixel % WIDTH, Math.floor(pixel / WIDTH)) === program).length);
  const before = (program: number) => counts.slice(0, program).reduce((sum, value) => sum + value, 0);
  const expectedShaded = kind === "meshlet" || kind === "geometry" ? 0
    : kind === "material" ? before(4)
      : kind === "texture" ? before(2)
        : kind === "unassigned" ? PIXELS - counts[1]!
          : PIXELS;
  const expectedDuplicate = kind === "duplicate" ? counts[1]! : 0;
  const expectedUnassigned = PIXELS - expectedShaded;
  const expectedDiagnosticFlags = kind === "duplicate" ? GPU_SPARSE_SHADING_DIAGNOSTIC_FLAG.Duplicate
    : kind === "unassigned" ? GPU_SPARSE_SHADING_DIAGNOSTIC_FLAG.Unassigned
      : ["meshlet", "geometry", "material", "texture"].includes(kind)
        ? GPU_SPARSE_SHADING_DIAGNOSTIC_FLAG.IdentityMismatch | GPU_SPARSE_SHADING_DIAGNOSTIC_FLAG.Unassigned : 0;
  if (kind === "production") {
    assertEqual(control[0]!, 0, "production frame flags"); assertEqual(nonzero, PIXELS, "production outputs");
  } else {
    assertEqual(diagnostic[0]!, expectedDiagnosticFlags, `${kind} diagnostic flags`);
    assertEqual(diagnostic[1]!, expectedShaded, `${kind} shaded`);
    assertEqual(diagnostic[2]!, expectedDuplicate, `${kind} duplicate`);
    assertEqual(diagnostic[3]!, expectedUnassigned, `${kind} unassigned`);
    assertEqual(nonzero, expectedShaded, `${kind} output ownership`);
    const identity = ["meshlet", "geometry", "material", "texture"].includes(kind);
    assertEqual((control[0]! & GPU_SHADING_BIN_FRAME_FLAG.IdentityMismatch) !== 0, identity,
      `${kind} frame identity flag`);
    if (identity && control[1] === 0) throw new Error(`${kind} did not report identity errors`);
  }
  assertArray(program0Args, [5, 2, 1], `${kind} program 0 rectangular indirect args`);
  assertArray(mutationArgs, kind === "duplicate" ? [2, 1, 1]
    : kind === "unassigned" ? [0, 1, 1] : [1, 1, 1], `${kind} mutation-bin indirect args`);
  const activeBins = new Set(Array.from({ length: GPU_SHADING_PROGRAM_COUNT }, (_, program) => binForProgram(program)));
  let inactiveDispatchXNonZero = 0;
  for (let bin = 0; bin < 64; bin++) if (!activeBins.has(bin)) {
    const args = Array.from(allArgs.slice(bin * 3, bin * 3 + 3));
    if (args[0] !== 0) inactiveDispatchXNonZero++;
    assertArray(args, [0, 1, 1], `${kind} inactive bin ${bin} args`);
  }
  return Object.freeze({ name: kind, passed: true, frameFlags: control[0], errorCount: control[1],
    shaded: kind === "production" ? PIXELS : diagnostic[1], duplicate: kind === "production" ? null : diagnostic[2],
    unassigned: kind === "production" ? null : diagnostic[3],
    finalOutputEligible: control[0] === 0 && (kind === "production" || diagnostic[0] === 0),
    indirectArgs: { program0: program0Args, program1: mutationArgs,
      inactiveBinCount: 64 - activeBins.size, inactiveDispatchXNonZero },
    outputFnv1a32: fnv1a32(bytes.subarray(0, OUTPUT_BYTES * 5)),
    maxErrors: { hdr: maxHdrError, normal: maxNormalError, albedoAo: maxAlbedoError,
      material: maxMaterialError, velocity: maxVelocityError } });
}

function createBinIds(descriptors: readonly ReturnType<typeof createGpuSparseShadingPipelineDescriptor>[]): Uint8Array {
  const result = new Uint8Array(PIXELS);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) result[y * WIDTH + x] = descriptors[programAt(x, y)]!.binId;
  return result;
}
function programAt(x: number, y: number): number {
  const tile = Math.floor(x / 8) + Math.floor(y / 8) * 5;
  return tile < 10 ? 0 : tile - 9;
}
function binForProgram(programId: number): number { return ((shadingProgramUsesTextures(programId) ? (programId % 3) + 1 : 0) << 4) | programId; }
function activeMask(ids: Uint8Array, hi: boolean): number { let mask = 0; for (const id of new Set(ids)) if ((id >= 32) === hi) mask = (mask | (1 << (id & 31))) >>> 0; return mask; }
function clearOutputTextures(device: GPUDevice, outputs: readonly GPUTexture[]): void {
  const zero = new Uint8Array(OUTPUT_BYTES);
  for (const texture of outputs) device.queue.writeTexture({ texture }, zero,
    { bytesPerRow: ROW_BYTES, rowsPerImage: HEIGHT }, [WIDTH, HEIGHT, 1]);
}
function uploadR8(device: GPUDevice, texture: GPUTexture, values: Uint8Array): void { const data = new Uint8Array(ROW_BYTES * HEIGHT); for (let y=0;y<HEIGHT;y++) data.set(values.subarray(y*WIDTH,(y+1)*WIDTH),y*ROW_BYTES); device.queue.writeTexture({texture},data,{bytesPerRow:ROW_BYTES,rowsPerImage:HEIGHT},[WIDTH,HEIGHT,1]); }
function uploadR32(device: GPUDevice, texture: GPUTexture, values: Uint32Array): void { const data = new Uint8Array(ROW_BYTES * HEIGHT); for(let y=0;y<HEIGHT;y++) new Uint32Array(data.buffer,y*ROW_BYTES,WIDTH).set(values.subarray(y*WIDTH,(y+1)*WIDTH)); device.queue.writeTexture({texture},data,{bytesPerRow:ROW_BYTES,rowsPerImage:HEIGHT},[WIDTH,HEIGHT,1]); }
function encodeDepthClear(encoder: GPUCommandEncoder, texture: GPUTexture, label: string): void {
  const pass = encoder.beginRenderPass({ label: `ADR-0013 ${label} clear`, colorAttachments: [],
    depthStencilAttachment: { view: texture.createView(), depthClearValue: 1,
      depthLoadOp: "clear", depthStoreOp: "store" } });
  pass.end();
}
function decodeHalfTexture(bytes: Uint8Array, components: number): Float32Array { const result=new Float32Array(PIXELS*components); const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength); for(let y=0;y<HEIGHT;y++)for(let x=0;x<WIDTH;x++)for(let c=0;c<components;c++)result[(y*WIDTH+x)*components+c]=halfToFloat(view.getUint16(y*ROW_BYTES+(x*components+c)*2,true)); return result; }
function halfToFloat(value:number):number { const sign=(value&0x8000)?-1:1,exponent=(value>>10)&31,fraction=value&1023; if(exponent===0)return sign*Math.pow(2,-14)*(fraction/1024); if(exponent===31)return fraction?NaN:sign*Infinity; return sign*Math.pow(2,exponent-15)*(1+fraction/1024); }
function encodeOct(n:Vec3):readonly[number,number] { const unit=normalize(n),d=Math.abs(unit[0])+Math.abs(unit[1])+Math.abs(unit[2]); let x=unit[0]/d,y=unit[1]/d; if(unit[2]<0){const ox=x;x=(1-Math.abs(y))*Math.sign(ox||1);y=(1-Math.abs(ox))*Math.sign(y||1);} return [Math.trunc((.5+x*.5)*65535),Math.trunc((.5+y*.5)*65535)]; }
function encodeRgbe9995(rgb: Vec3): number {
  const maxRange = bitsToF32(0x477f8000), minRange = bitsToF32(0x37800000);
  const clamped = rgb.map((value) => Math.fround(Math.min(maxRange, Math.max(0, value)))) as unknown as Vec3;
  const maximum = Math.max(minRange, clamped[0], clamped[1], clamped[2]);
  const exponentBits = (f32ToBits(maximum) + 0x07804000) & 0x7f800000;
  const exponent = bitsToF32(exponentBits);
  const mantissas = clamped.map((value) => f32ToBits(Math.fround(value + exponent)));
  return (((exponentBits << 4) + 0x10000000) |
    (mantissas[2]! << 18) | (mantissas[1]! << 9) | (mantissas[0]! & 0x1ff)) >>> 0;
}
function f32ToBits(value:number):number { const bytes=new ArrayBuffer(4),view=new DataView(bytes);view.setFloat32(0,value,true);return view.getUint32(0,true); }
function bitsToF32(value:number):number { const bytes=new ArrayBuffer(4),view=new DataView(bytes);view.setUint32(0,value>>>0,true);return view.getFloat32(0,true); }
function normalize(v:Vec3):Vec3 { const length=Math.hypot(...v); return [v[0]/length,v[1]/length,v[2]/length]; }
function fnv1a32(bytes:ArrayLike<number>):string { let hash=0x811c9dc5; for(let i=0;i<bytes.length;i++){hash^=bytes[i]!;hash=Math.imul(hash,0x01000193)>>>0;} return hash.toString(16).padStart(8,"0"); }
function assertEqual(actual:unknown,expected:unknown,label:string):void { if(actual!==expected)throw new Error(`${label}: expected ${expected}, actual ${actual}`); }
function assertArray(actual:readonly number[],expected:readonly number[],label:string):void { if(actual.length!==expected.length||actual.some((value,index)=>value!==expected[index]))throw new Error(`${label}: expected ${expected}, actual ${actual}`); }
function assertAtMost(actual:number,limit:number,label:string):void { if(!Number.isFinite(actual)||actual>limit)throw new Error(`${label}: ${actual} exceeds ${limit}`); }
function compilationMessages(info:GPUCompilationInfo):readonly Readonly<Record<string,unknown>>[]{return info.messages.map(message=>Object.freeze({type:message.type,message:message.message,lineNum:message.lineNum,linePos:message.linePos}));}
function assertNoCompilationErrors(info:GPUCompilationInfo,label:string):void { const errors=info.messages.filter(message=>message.type==="error"); if(errors.length)throw new Error(`${label} shader: ${errors.map(error=>error.message).join("; ")}`); }
