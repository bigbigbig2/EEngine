import { nativeWinnerGeometry } from "../MeshletBucketRaster.js";
import { nativeSurfacePhysicalSunEntries } from "../../shaders/native_surface_lighting.js";
import { FrameGraph, FrameGraphBindingLayout, type CompiledFrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import type { VisibilityFeature, PackedVisibilityOutputs } from "../features/VisibilityFeature.js";
import type { SurfacePresentPass } from "../surface/SurfacePresentPass.js";
import type { SurfaceV4 } from "../surface/SurfaceV4.js";
import type { RenderDebugViewPass } from "../passes/RenderDebugViewPass.js";
import type { RenderDebugViewResources } from "../passes/RenderDebugViewPass.js";
import { RenderDebugView as RenderDebugViewValue } from "../../debug/RenderDebugView.js";
import type { NativeTemporalFactsPass } from "../temporal/NativeTemporalFactsPass.js";
import type { GpuRadiometryPass } from "../temporal/GpuRadiometryPass.js";
import type { BloomPass } from "../passes/BloomPass.js";
import type { LocalLightWorkGenerator } from "../lighting/LocalLightWorkGenerator.js";
import type { VisibilityCounterPass } from "../passes/VisibilityCounterPass.js";
import type { PhysicalSkyPass } from "../passes/PhysicalSkyPass.js";
import type { AerialPerspectivePass } from "../passes/AerialPerspectivePass.js";
import type { XeGtaoPreparationPass } from "../ao/XeGtaoPreparationPass.js";
import type { XeGtaoMainPass } from "../ao/XeGtaoMainPass.js";
import type { XeGtaoDenoisePass } from "../ao/XeGtaoDenoisePass.js";
import type { VsmDepthBoundsPass } from "../vsm/VsmDepthBoundsPass.js";
import type { VsmReceiverDemandPass } from "../vsm/VsmReceiverDemandPass.js";
import type { VsmAllocatePagesPass } from "../vsm/VsmAllocatePagesPass.js";
import type { VsmCasterRecordPass } from "../vsm/VsmCasterRecordPass.js";
import type { VsmAtlasRasterPass } from "../vsm/VsmAtlasRasterPass.js";
import type { VsmInvalidationPass } from "../vsm/VsmInvalidationPass.js";
import type { VsmAllocationFrame } from "../vsm/VsmResidency.js";
import { shadowVisibilityFrame, type ShadowVisibilityFrame } from "../pipeline/FrameProducts.js";
import {
  SHADOW_DEPTH_BIAS,
  SHADOW_DEPTH_SLOPE_SCALE,
  SHADOW_NORMAL_OFFSET_SCALE,
} from "../../gpu/ShadowContract.js";
import type { EmptyFrameBindings, FrameProgramBindings, SceneFrameBindings } from "./FrameProgramBindings.js";
import type { FrameProgram, FrameProduct } from "./FrameProgram.js";
import { counterByteOffset } from "../../debug/GpuFrameCounters.js";

export type FrameProgramOwners = Readonly<{
  visibility: VisibilityFeature;
  visibilityCounters: VisibilityCounterPass;
  temporalFacts: NativeTemporalFactsPass;
  surface: SurfaceV4;
  radiometry: GpuRadiometryPass;
  bloom: BloomPass;
  present: SurfacePresentPass;
  debug: RenderDebugViewPass;
  sky: PhysicalSkyPass | null;
  aerial: AerialPerspectivePass | null;
  localLightWork: LocalLightWorkGenerator;
  xeGtaoPreparation: XeGtaoPreparationPass;
  xeGtaoMain: XeGtaoMainPass;
  xeGtaoDenoise: XeGtaoDenoisePass;
  vsmDepthBounds: VsmDepthBoundsPass;
  vsmReceiverDemand: VsmReceiverDemandPass;
  vsmAllocatePages: VsmAllocatePagesPass;
  vsmCasterRecords: VsmCasterRecordPass;
  vsmAtlasRaster: VsmAtlasRasterPass;
  vsmInvalidation: VsmInvalidationPass;
}>;

type SceneBind = <T extends object>(name: string, resolve: (bindings: SceneFrameBindings) => T) => T;

function assertTextureProduct(
  plan: FrameProgram,
  graph: FrameGraph,
  product: FrameProduct,
  resource: ResourceId,
): void {
  const fact = plan.facts.find((entry) => entry.product === product);
  if (!fact) throw new Error(`Frame Program has no demand for ${product}`);
  const descriptor = graph.getDescriptor(resource);
  if (descriptor?.kind !== "transient_texture") return; // Imported descriptors are checked against frame bindings.
  if (
    fact.extent === null ||
    descriptor.width !== fact.extent[0] ||
    descriptor.height !== fact.extent[1] ||
    descriptor.format !== fact.format ||
    (descriptor.domain !== undefined && descriptor.domain !== fact.domain)
  ) {
    throw new Error(`Frame Program ${product} descriptor does not match its semantic fact`);
  }
}

/** Lower the semantic plan to the one existing FrameGraph execution path. */
export function lowerFrameProgram(
  plan: FrameProgram,
  initial: FrameProgramBindings,
  owners?: FrameProgramOwners,
): CompiledFrameGraph {
  if (plan.request.kind !== initial.kind) throw new Error("Frame Program and frame bindings disagree");
  if (initial.kind === "empty") return compileEmptyGraph(initial);
  if (!owners) throw new Error("Scene Frame Program requires production owners");
  return compileSceneGraph(plan, initial, owners);
}

function compileEmptyGraph(initial: EmptyFrameBindings): CompiledFrameGraph {
  const layout = new FrameGraphBindingLayout<EmptyFrameBindings>();
  const graph = new FrameGraph("Renderer/empty-frame");
  const swapchain = graph.import_resource(
    "swapchain",
    { kind: "imported", label: "swapchain" },
    layout.slot("swapchain", initial, (bindings) => bindings.swapchain),
  );
  const clear = graph.add("Renderer/empty present", {}, (_data, resources, context) => {
    const command = context.encoder as ShadeGPUCommandContext;
    const pass = command.gpu_encoder.beginRenderPass({
      colorAttachments: [
        {
          view: resolveTextureView(resources.get(swapchain)),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0.025, g: 0.035, b: 0.05, a: 1 },
        },
      ],
    });
    pass.end();
  });
  clear.write(swapchain);
  return graph.compile();
}

function compileSceneGraph(
  plan: FrameProgram,
  initial: SceneFrameBindings,
  owners: FrameProgramOwners,
): CompiledFrameGraph {
  if (plan.request.kind !== "scene") throw new Error("Scene graph requires a scene Frame Program");
  for (const stage of ["visibility", "surface", "fsr3", "present"] as const) {
    if (!plan.stages.includes(stage)) throw new Error(`Scene Frame Program is missing ${stage}`);
  }
  if (plan.request.physicalEnvironment && (owners.sky === null || owners.aerial === null)) {
    throw new Error("Physical Environment requires Sky and Aerial producers");
  }
  const layout = new FrameGraphBindingLayout<SceneFrameBindings>();
  const bind = <T extends object>(name: string, resolve: (bindings: SceneFrameBindings) => T): T =>
    layout.slot(name, initial, resolve);
  const graph = new FrameGraph("Renderer/visibility-frame");
  const { result, cameraBuffer, builtHzb } = lowerVisibility(plan, graph, bind, owners);
  if (initial.runtime.nativeMaterials === null) {
    throw new Error("Native material publication is missing");
  }
  assertTextureProduct(plan, graph, "visibility", result.frame.visibilityKey);
  const instances = graph.import_resource(
    "scene-instances",
    { kind: "imported", label: "published instance records" },
    bind("scene-instances", (bindings) => bindings.job.scene.instances)
  );
  let vsmOwnerBinding: NonNullable<SceneFrameBindings["vsm"]> | null = null;
  let vsmFrameBinding: NonNullable<SceneFrameBindings["vsmFrame"]> | null = null;
  let vsmAllocation: VsmAllocationFrame | null = null;
  let vsmAtlasDepth: ResourceId | null = null;
  let vsmSamplingConstants: ResourceId | null = null;
  let vsmDepthRange: ResourceId | null = null;
  let vsmContentVersion: ResourceId | null = null;
  let shadowContract: ShadowVisibilityFrame | null = null;
  if (plan.products.includes("shadow-demand")) {
    if (initial.vsm === null || initial.vsmFrame === null) {
      throw new Error("Frame Program VSM demand requires persistent resources and clipmap constants");
    }
    const vsmOwner = bind("vsm-owner", (bindings) => {
      if (bindings.vsm === null) throw new Error("Frame Program VSM owner publication is missing");
      return bindings.vsm;
    });
    const vsmFrame = bind("vsm-frame", (bindings) => {
      if (bindings.vsmFrame === null) throw new Error("Frame Program VSM clipmap publication is missing");
      return bindings.vsmFrame;
    });
    vsmOwnerBinding = vsmOwner;
    vsmFrameBinding = vsmFrame;
    const contentVersion = owners.vsmInvalidation.addToGraph(graph, {
      resources: vsmOwner,
      state: bind("vsm-generation-state", (bindings) => bindings.vsmGeneration),
      frame: vsmFrame
    });
    const depthRange = owners.vsmDepthBounds.addToGraph(
      graph,
      bind("vsm-depth-range-job", (bindings) => ({
        resources: vsmOwner,
        frame: vsmFrame,
        state: bindings.vsmGeneration,
        instances,
        instanceBegin: bindings.runtime.instanceBegin,
        instanceCount: bindings.runtime.instanceCount
      }))
    );
    vsmDepthRange = depthRange;
    const demand = owners.vsmReceiverDemand.addToGraph(
      graph,
      bind("vsm-receiver-job", (bindings) => ({
        width: result.frame.domain.width,
        height: result.frame.domain.height,
        camera: cameraBuffer,
        depth: result.frame.depth,
        visibilityKey: result.frame.visibilityKey,
        instances,
        meshletWork: result.frame.meshletWork.records,
        depthRange,
        frame: vsmFrame,
        resources: vsmOwner,
        generation: bindings.vsmFrame!.generation,
      })),
    );
    vsmSamplingConstants = demand.samplingConstants;
    if (plan.products.includes("shadow-allocation")) {
      if (contentVersion === null) {
        throw new Error("Enabled VSM requires its content publication");
      }
      vsmAllocation = owners.vsmAllocatePages.addToGraph(
        graph,
        bind("vsm-allocation-job", (bindings) => ({
          demand: demand.demand,
          resources: vsmOwner,
          generation: bindings.vsmFrame!.generation,
          contentVersion,
          frameSerial: bindings.vsmGeneration.frameSerial,
          frame: vsmFrame
        })),
      );
    }
  }
  const materialRecords = graph.import_resource(
    "material-records",
    { kind: "imported", label: "published material records" },
    bind("material-records", (bindings) => bindings.runtime.materialResources.materialRecords),
  );
  const needsDirectLight = plan.stages.includes("local-light-work");
  const geometryMetadata = graph.import_resource(
    "geometry-metadata",
    { kind: "imported", label: "geometry metadata" },
    bind("geometry-metadata", (bindings) => bindings.job.assets.sparseShading.assetMetadataHeap),
  );
  const vertexPayload = graph.import_resource(
    "vertex-payload",
    { kind: "imported", label: "geometry vertex payload" },
    bind("vertex-payload", (bindings) => bindings.job.assets.sparseShading.vertexPayloadHeap),
  );
  const virtualMetadata = plan.request.virtualGeometry
    ? graph.import_resource(
        "virtual-geometry-metadata",
        { kind: "imported", label: "virtual geometry metadata" },
        bind("virtual-geometry-metadata", (bindings) => {
          if (!bindings.runtime.virtualGeometry) throw new Error("Virtual geometry publication changed");
          return bindings.runtime.virtualGeometry.metadata;
        }),
      )
    : undefined;
  const virtualBanks = plan.request.virtualGeometry
    ? Array.from({ length: plan.request.virtualBankCount }, (_, bank) =>
        graph.import_resource(
          `virtual-geometry-bank-${bank}`,
          { kind: "imported", label: `virtual geometry bank ${bank}` },
          bind(`virtual-geometry-bank-${bank}`, (bindings) => {
            const resource = bindings.runtime.virtualGeometry?.banks[bank];
            if (!resource) throw new Error(`Virtual geometry bank ${bank} is not resident`);
            return resource;
          }),
        ),
      )
    : undefined;
  if (vsmAllocation !== null && vsmOwnerBinding !== null && vsmFrameBinding !== null) {
    const geometryRecords = graph.import_resource(
      "vsm-geometry-records",
      { kind: "imported", label: "VSM geometry records" },
      bind("vsm-geometry-records", (bindings) => bindings.job.assets.geometryRecords),
    );
    const meshletRecords = graph.import_resource(
      "vsm-meshlet-records",
      { kind: "imported", label: "VSM meshlet records" },
      bind("vsm-meshlet-records", (bindings) => bindings.job.assets.meshletRecords),
    );
    const meshletVertexIndices = graph.import_resource(
      "vsm-meshlet-vertex-indices",
      { kind: "imported", label: "VSM meshlet vertex indices" },
      bind("vsm-meshlet-vertex-indices", (bindings) => bindings.job.assets.meshletVertexIndices),
    );
    const meshletTriangleIndices = graph.import_resource(
      "vsm-meshlet-triangle-indices",
      { kind: "imported", label: "VSM meshlet triangle indices" },
      bind("vsm-meshlet-triangle-indices", (bindings) => bindings.job.assets.meshletTriangleIndices),
    );
    const vertexStreamData = graph.import_resource(
      "vsm-vertex-stream-data",
      { kind: "imported", label: "VSM vertex stream data" },
      bind("vsm-vertex-stream-data", (bindings) => bindings.job.assets.vertexStreamData),
    );
    const shadowWork = graph.import_resource(
      "shadow-meshlet-work",
      { kind: "imported" },
      bind("shadow-meshlet-work", (bindings) => {
        const shadow = bindings.job.prepared.shadowGeometry;
        if (!shadow) throw new Error("VSM requires Shadow Geometry work publication");
        return shadow.work.queue;
      }),
    );
    const shadowInstances = graph.import_resource(
      "shadow-frame-instances",
      { kind: "imported" },
      bind("shadow-frame-instances", (bindings) => {
        const shadow = bindings.job.prepared.shadowGeometry;
        if (!shadow) throw new Error("VSM requires Shadow Geometry instance publication");
        return shadow.instances.records;
      }),
    );
    const shadow = owners.visibility.addShadowToGraph(
      graph,
      bind("shadow-geometry-job", (bindings) => bindings.job),
      {
        camera: cameraBuffer,
        instances,
        meshletWork: shadowWork,
        frameInstances: shadowInstances,
        productHeap: virtualMetadata,
        productBanks: virtualBanks,
        geometrySources: [
          geometryRecords,
          meshletRecords,
          meshletVertexIndices,
          meshletTriangleIndices,
          vertexStreamData,
          graph.import_resource(
            "shadow-cluster-records",
            { kind: "imported" },
            bind("shadow-cluster-records", (bindings) => bindings.job.assets.clusterRecords),
          ),
          graph.import_resource(
            "shadow-cluster-children",
            { kind: "imported" },
            bind("shadow-cluster-children", (bindings) => bindings.job.assets.clusterChildren),
          ),
        ],
      },
    );
    const caster = owners.vsmCasterRecords.addToGraph(
      graph,
      bind("vsm-caster-job", (bindings) => ({
        allocation: vsmAllocation!,
        meshletWork: shadow.meshletWork,
        instances,
        resources: bindings.vsm!,
        frame: bindings.vsmFrame!,
        depthRange: vsmDepthRange!,
        generation: bindings.vsmFrame!.generation,
        workCapacity: bindings.job.prepared.shadowGeometry!.work.capacity,
      })),
    );
    const atlas = owners.vsmAtlasRaster.addToGraph(
      graph,
      bind("vsm-atlas-job", (bindings) => ({
        caster,
        publication: {
          runtime: bindings.runtime,
          assets: bindings.job.assets,
          vertices: bindings.job.prepared.workSet.frameVertices,
          meshletWork: bindings.job.prepared.shadowGeometry!.work.queue,
        },
        camera: cameraBuffer,
        frameInstances: shadow.frameInstances,
        cameraPosition: [
          bindings.camera.transform.matrix[12]!,
          bindings.camera.transform.matrix[13]!,
          bindings.camera.transform.matrix[14]!
        ],
        viewMatrix: bindings.camera.view_matrix,
        clipFromWorld: bindings.camera.view_projection_matrix,
        frameGeometry: result.frame.frameGeometry,
        depthRange: vsmDepthRange!,
        resources: bindings.vsm!,
        frame: bindings.vsmFrame!,
        generation: bindings.vsmFrame!.generation,
        pageTable: vsmAllocation!.pageTable,
        allocation: vsmAllocation!.allocation,
        metaTable: vsmAllocation!.metaTable,
        contentVersion: vsmAllocation!.contentVersion,
        instances,
        meshlets: meshletRecords,
        meshletVertices: meshletVertexIndices,
        meshletTriangles: meshletTriangleIndices,
        vertexData: vertexStreamData,
        geometries: geometryRecords,
        materials: materialRecords,
        productHeap: virtualMetadata,
        productBanks: virtualBanks,
      })),
    );
    vsmAtlasDepth = atlas.atlasDepth;
    vsmContentVersion = atlas.contentVersion;
    if (vsmOwnerBinding.pageConstants === null) {
      throw new Error("Frame Program VSM sampling constants are unavailable");
    }
    if (vsmSamplingConstants === null) throw new Error("VSM sampling constants have no producer");
    shadowContract = shadowVisibilityFrame({
      profile: vsmOwnerBinding.profile,
      virtualPageTable: atlas.pageTable,
      physicalAtlasDepth: vsmAtlasDepth,
      pageMeta: atlas.metaTable,
      lightProjection: vsmSamplingConstants,
      overflowMask: null,
      generation: vsmFrameBinding.generation,
      fallbackPolicy: "coarse-resident",
      enabled: true,
      clipLevels: vsmOwnerBinding.capabilities.clipLevels,
      pageSize: vsmOwnerBinding.capabilities.pageSize,
      border: vsmOwnerBinding.capabilities.border,
      pcfTapCount: vsmOwnerBinding.capabilities.pcfTapCount,
      normalOffsetScale: SHADOW_NORMAL_OFFSET_SCALE,
      depthBias: SHADOW_DEPTH_BIAS,
      slopeScale: SHADOW_DEPTH_SLOPE_SCALE,
      atlasWidth: vsmOwnerBinding.capabilities.atlasDimension,
      atlasHeight: vsmOwnerBinding.capabilities.atlasDimension,
    });
  }
  const lightRecords = needsDirectLight
    ? graph.import_resource(
        "light-records",
        { kind: "imported", label: "scene light records" },
        bind("light-records", (bindings) => bindings.view.environment.lights.buffer_data),
      )
    : undefined;
  const physicalEnvironmentSun = !plan.request.physicalEnvironment
    ? undefined
    : graph.import_resource(
        "physical-environment-sun",
        { kind: "imported", label: "Physical Environment Sun" },
        bind("physical-environment-sun", (bindings) => bindings.environment!.parameters),
      );
  const atmosphereEnvironment = !plan.request.physicalEnvironment
    ? undefined
    : graph.import_resource(
        "physical-environment-transmittance",
        { kind: "imported", label: "Physical Environment transmittance" },
        bind(
          "physical-environment-transmittance",
          (bindings) => bindings.environment!.luts.views.transmittance,
        ),
      );
  const clusters =
    lightRecords === undefined
      ? undefined
      : owners.localLightWork.addToGraph(
          graph,
          bind("local-light-work-job", (bindings) => ({ frame: bindings.localLightWork! })),
          {
            parameters: bind("local-light-parameters", (bindings) => bindings.localLightWork!.parameters),
            lookup: bind("local-light-lookup", (bindings) => bindings.localLightWork!.lookup),
            data: bind("local-light-data", (bindings) => bindings.localLightWork!.data),
          },
          { visibility: result.frame.visibilityKey, depth: result.frame.depth, database: lightRecords },
        );
  if (clusters !== undefined) {
    const sink = graph.import_resource(
      "local-light-counter-sink",
      { kind: "imported" },
      bind("local-light-counter-sink", (bindings) => bindings.localLightCounters),
    );
    const observed = graph.add(
      "LocalLightWork/sampled header",
      bind("local-light-counter-job", (bindings) => ({ enabled: bindings.job.countersEnabled })),
      (job, resources, context) => {
        if (job.enabled) {
          (context.encoder as ShadeGPUCommandContext).gpu_encoder.copyBufferToBuffer(
            resources.get(clusters.data) as GPUBuffer,
            0,
            resources.get(sink) as GPUBuffer,
            counterByteOffset("localLightAbi"),
            64,
          );
        }
      },
    );
    observed.read(clusters.data);
    observed.write(sink);
    observed.make_side_effect();
  }
  const scalarAo =
    plan.request.aoProfile === "scalar-high"
      ? (() => {
          if (!plan.stages.includes("xe-gtao") || !plan.products.includes("indirect-visibility")) {
            throw new Error("Frame Program omitted the requested XeGTAO producer");
          }
          const prepared = owners.xeGtaoPreparation.addToGraph(graph, {
            width: result.frame.domain.width,
            height: result.frame.domain.height,
            depth: result.frame.depth,
            frame: bind("xe-gtao-frame", (bindings) => ({
              camera: bindings.view.gpu_camera_state,
              // The production scene scale is one metre per world unit. A scene-scale
              // contract can replace this pair without changing the donor math.
              radiusMeters: 1,
              metersPerWorldUnit: 1,
              noiseIndex: 0,
            })),
          });
          const main = owners.xeGtaoMain.addToGraph(graph, { prepared });
          const visibility = owners.xeGtaoDenoise.addToGraph(graph, { prepared, main });
          const descriptor = graph.getDescriptor(visibility.packed);
          if (
            descriptor?.kind !== "transient_buffer" ||
            descriptor.size !== visibility.words * 4 ||
            visibility.width !== result.frame.domain.width ||
            visibility.height !== result.frame.domain.height
          ) {
            throw new Error("XeGTAO final visibility has an invalid packed buffer shape");
          }
          return visibility.scalarTexture;
        })()
      : undefined;
  const bindRadiometry = (
    name: string,
    resolve: (runtime: import("../temporal/GpuRadiometryPass.js").GpuRadiometryPass) => GPUBuffer,
  ): ResourceId =>
    graph.import_resource(
      `radiometry/${name}`,
      { kind: "imported", label: `Radiometry ${name}` },
      bind(`radiometry/${name}`, (bindings) => resolve(bindings.radiometry)),
    );
  const gpuPreviousExposure = owners.radiometry.importPreviousExposure(graph, bindRadiometry);
  const gpuPriorExposure = owners.radiometry.importPriorExposure(graph, bindRadiometry);
  const surfaceEnvironment = plan.request.authoredEnvironment
    ? {
        diffuse: graph.import_resource(
          "Lighting/authored diffuse irradiance",
          { kind: "imported" },
          bind(
            "lighting-authored-diffuse",
            (bindings) => bindings.view.environment.lights.authoredIbl.views.diffuse,
          ),
        ),
        specular: graph.import_resource(
          "Lighting/authored filtered specular",
          { kind: "imported" },
          bind(
            "lighting-authored-specular",
            (bindings) => bindings.view.environment.lights.authoredIbl.views.specular,
          ),
        ),
        dfg: graph.import_resource(
          "Lighting/authored DFG",
          { kind: "imported" },
          bind("lighting-authored-dfg", (bindings) => bindings.view.environment.lights.authoredIbl.views.dfg),
        ),
      }
    : !plan.request.physicalEnvironment
      ? undefined
      : {
          diffuse: graph.import_resource(
            "Lighting/sky diffuse irradiance",
            { kind: "imported" },
            bind("lighting-sky-diffuse", (bindings) => bindings.environment!.ibl.views.diffuse),
          ),
          specular: graph.import_resource(
            "Lighting/sky filtered specular",
            { kind: "imported" },
            bind("lighting-sky-specular", (bindings) => bindings.environment!.ibl.views.specular),
          ),
          dfg: graph.import_resource(
            "Lighting/DFG",
            { kind: "imported" },
            bind("lighting-dfg", (bindings) => bindings.environment!.ibl.views.dfg),
          ),
        };
  if (
    plan.request.hasLit &&
    (lightRecords === undefined || clusters === undefined || surfaceEnvironment === undefined)
  ) {
    throw new Error("Native Surface requires LocalLightWork and IBL providers");
  }
  const previousCamera = graph.import_resource(
    "previous-camera",
    { kind: "imported" },
    bind("previous-camera", (bindings) => bindings.view.gpu_previous_camera_state.buffer),
  );
  const nativeVersions = graph.import_resource(
    "native-material-versions",
    { kind: "imported" },
    bind("native-material-versions", (bindings) => bindings.runtime.nativeMaterials!.publication.versions),
  );
  const nativeFrame = bind("native-surface-frame", (bindings) => ({ bindings }));
  let nativeHdr = -1;
  let reactive = -1;
  const native = graph.add("SurfaceV4/native opaque", nativeFrame, (data, resources, context) => {
    const frame = data.bindings;
    const material = frame.runtime.nativeMaterials!;
    const texture = (id: ResourceId): GPUTexture => {
      const resource = resources.get(id) as GPUTexture & { gpu_texture?: GPUTexture };
      return resource.gpu_texture ?? resource;
    };
    const entries: GPUBindGroupEntry[] = [];
    if (plan.request.kind !== "scene") {
      throw new Error("Native Surface requires a scene");
    }
    if (plan.request.hasLit) {
      entries.push(
        { binding: 0, resource: { buffer: resources.get(lightRecords!) as GPUBuffer } },
        { binding: 1, resource: { buffer: resources.get(clusters!.parameters) as GPUBuffer } },
        { binding: 2, resource: { buffer: resources.get(clusters!.lookup) as GPUBuffer } },
        { binding: 3, resource: { buffer: resources.get(clusters!.data) as GPUBuffer } },
        { binding: 5, resource: resolveTextureView(resources.get(surfaceEnvironment!.diffuse)) },
        { binding: 6, resource: resolveTextureView(resources.get(surfaceEnvironment!.specular)) },
        { binding: 7, resource: resolveTextureView(resources.get(surfaceEnvironment!.dfg)) },
        ...owners.surface.neutralLightingEntries.map((entry) => {
          if (entry.binding === 8 && vsmSamplingConstants !== null) {
            return { binding: 8, resource: { buffer: resources.get(vsmSamplingConstants) as GPUBuffer } };
          }
          if (
            entry.binding === 9 &&
            shadowContract?.virtualPageTable !== null &&
            shadowContract?.virtualPageTable !== undefined
          ) {
            return {
              binding: 9,
              resource: { buffer: resources.get(shadowContract.virtualPageTable) as GPUBuffer },
            };
          }
          if (entry.binding === 10 && vsmAtlasDepth !== null) {
            return { binding: 10, resource: resolveTextureView(resources.get(vsmAtlasDepth)) };
          }
          if (entry.binding === 11 && scalarAo !== undefined) {
            return { binding: 11, resource: resolveTextureView(resources.get(scalarAo)) };
          }
          return entry;
        }),
      );
      if (frame.environment !== null) {
        entries.push(
          ...nativeSurfacePhysicalSunEntries({
            parameters: frame.environment.parameters,
            transmittance: frame.environment.luts.views.transmittance,
            sampler: frame.environment.luts.sampler,
          }),
        );
      }
    }
    owners.surface.prepareFrameNow({
      width: plan.request.internalWidth,
      height: plan.request.internalHeight,
      generation: 1,
      generationSource: frame.job.prepared.workSet.meshletWorkCandidate!.queue,
      frameIndex: frame.frameIndex,
      cameraPosition: [
        frame.camera.transform.matrix[12]!,
        frame.camera.transform.matrix[13]!,
        frame.camera.transform.matrix[14]!,
      ],
      preExposure: resources.get(gpuPreviousExposure) as GPUBuffer,
      viewMatrix: frame.camera.view_matrix,
      output: texture(nativeHdr),
      visibility: texture(result.frame.visibilityKey),
      depth: frame.depth.gpu_texture,
      reactive: texture(reactive),
      geometry: nativeWinnerGeometry(
        frame.job.assets,
        frame.job.prepared.workSet.frameVertices,
        resources.get(result.frame.meshletWork.records) as GPUBuffer,
        resources.get(result.frame.frameInstances) as GPUBuffer,
        frame.runtime,
      ),
      publication: material.publication,
      routes: material.routes,
      lightingEntries: entries,
    });
    owners.surface.encode((context.encoder as ShadeGPUCommandContext).gpu_encoder);
  });
  for (const id of [
    result.frame.visibilityKey,
    result.frame.depth,
    result.frame.meshletWork.records,
    result.frame.frameInstances,
    result.frame.frameGeometry,
    vertexPayload,
    gpuPreviousExposure,
    lightRecords,
    clusters?.parameters,
    clusters?.lookup,
    clusters?.data,
    surfaceEnvironment?.diffuse,
    surfaceEnvironment?.specular,
    surfaceEnvironment?.dfg,
    scalarAo,
    vsmAtlasDepth,
    vsmSamplingConstants,
    shadowContract?.virtualPageTable,
    vsmContentVersion,
    physicalEnvironmentSun,
    atmosphereEnvironment,
    virtualMetadata,
    ...(virtualBanks ?? []),
  ]) {
    if (id !== undefined && id !== null) {
      native.read(id);
    }
  }
  nativeHdr = native.create("SurfaceV4/HDR", {
    kind: "transient_texture",
    width: plan.request.internalWidth,
    height: plan.request.internalHeight,
    format: "rgba16float",
    domain: "internal-full",
    usage:
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.COPY_DST,
  });
  reactive = native.create("SurfaceV4/reactive", {
    kind: "transient_texture",
    width: plan.request.internalWidth,
    height: plan.request.internalHeight,
    format: "rgba8unorm",
    domain: "internal-full",
    usage:
      GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const facts = owners.temporalFacts.addToGraph(
    graph,
    {
      width: result.frame.domain.width,
      height: result.frame.domain.height,
      visibility: result.frame.visibilityKey,
      depth: result.frame.depth,
      opaqueReactive: reactive,
      meshletWork: result.frame.meshletWork.records,
      instances,
      materialVersions: nativeVersions,
      materialSlotCount: initial.runtime.nativeMaterials!.publication.materialSlotCount,
      currentCamera: cameraBuffer,
      previousCamera,
      assetMetadata: geometryMetadata,
      vertexPayload,
      sourceBindings: bind("native-temporal-source", (bindings) => bindings.job.assets.sparseShading),
    },
    (name, resolve) => bind(`native-temporal/${name}`, (bindings) => resolve(bindings.temporalFacts)),
  );
  const skyRadiance = !plan.stages.includes("physical-sky")
    ? undefined
    : graph.import_resource(
        "physical-environment-sky-radiance",
        { kind: "imported", label: "Physical Environment sky radiance" },
        bind("physical-environment-sky-radiance", (bindings) => bindings.environment!.luts.views.scattering),
      );
  const higherOrderScattering = !plan.stages.includes("physical-sky")
    ? undefined
    : graph.import_resource(
        "physical-environment-higher-order-scattering",
        { kind: "imported", label: "Physical Environment higher-order scattering" },
        bind(
          "physical-environment-higher-order-scattering",
          (bindings) => bindings.environment!.luts.views.higherOrderScattering,
        ),
      );
  const environmentRadiance =
    !plan.stages.includes("physical-sky") ||
    atmosphereEnvironment === undefined ||
    skyRadiance === undefined ||
    higherOrderScattering === undefined ||
    owners.sky === null
      ? nativeHdr
      : owners.sky.addToGraph(graph, {
          hdr: nativeHdr,
          depth: result.frame.depth,
          camera: cameraBuffer,
          transmittance: atmosphereEnvironment,
          scattering: skyRadiance,
          higherOrder: higherOrderScattering,
          environment: physicalEnvironmentSun!,
          preExposure: gpuPreviousExposure,
        });
  const aerialRadiance =
    !plan.stages.includes("aerial") ||
    atmosphereEnvironment === undefined ||
    skyRadiance === undefined ||
    higherOrderScattering === undefined ||
    physicalEnvironmentSun === undefined ||
    owners.aerial === null
      ? environmentRadiance
      : owners.aerial.addToGraph(graph, {
          scene: environmentRadiance,
          depth: result.frame.depth,
          camera: cameraBuffer,
          environment: physicalEnvironmentSun,
          transmittance: atmosphereEnvironment,
          scattering: skyRadiance,
          higherOrder: higherOrderScattering,
          preExposure: gpuPreviousExposure,
          width: result.frame.domain.width,
          height: result.frame.domain.height,
        });
  const reconstructedRadiance = initial.fsr3.addToGraph(
    graph,
    {
      color: aerialRadiance,
      depth: result.frame.depth,
      motion: facts.motion,
      reactiveMask: facts.mask,
      validityMask: facts.mask,
      preExposure: gpuPreviousExposure,
      priorExposure: gpuPriorExposure,
      width: result.frame.domain.width,
      height: result.frame.domain.height,
      outputWidth: plan.request.outputWidth,
      outputHeight: plan.request.outputHeight,
      enabled: plan.request.fsr3Enabled,
    },
    (name, resolve) => bind(`fsr3/${name}`, (bindings) => resolve(bindings.fsr3)),
  );
  const radiometry = owners.radiometry.addToGraph(
    graph,
    {
      scene: reconstructedRadiance,
      width: plan.request.outputWidth,
      height: plan.request.outputHeight,
      previousExposure: gpuPreviousExposure,
      priorExposure: gpuPriorExposure,
    },
    bindRadiometry,
  );
  const bloom = owners.bloom.addToGraph(graph, {
    scene: reconstructedRadiance,
    preExposure: gpuPreviousExposure,
    width: plan.request.outputWidth,
    height: plan.request.outputHeight,
    enabled: plan.request.bloomEnabled,
  });
  const swapchain = graph.import_resource(
    "swapchain",
    { kind: "imported", label: "swapchain" },
    bind("swapchain", (bindings) => bindings.swapchain),
  );
  const debugColor =
    plan.request.debugView !== undefined && plan.request.debugView !== RenderDebugViewValue.None
      ? owners.debug.addToGraph(
          graph,
          plan.request.debugView,
          {
            visibilityKey: result.frame.visibilityKey,
            packedVisibility: result.debugResolve,
            depth: result.frame.depth,
            velocity: facts.motion,
            gPbr: null,
            gNormal: null,
            gAlbedo: null,
            gEmissive: null,
            surfaceFlags: null,
            temporalMask: facts.mask,
            indirectDiffuse: null,
            indirectSpecular: null,
            linearHdr: reconstructedRadiance,
            screenSpaceReflectionHitMiss: null,
            screenSpaceReflectionResolve: null,
            screenSpaceReflectionTemporal: null,
            screenSpaceReflectionHistoryConfidence: null,
          } satisfies RenderDebugViewResources,
          plan.request.outputWidth,
          plan.request.outputHeight,
        )
      : null;
  owners.present.addToGraph(
    graph,
    debugColor ?? bloom,
    swapchain,
    radiometry.adaptedExposure,
    gpuPreviousExposure,
    plan.request.outputWidth,
    plan.request.outputHeight,
    debugColor !== null,
  );
  return graph.compile();
}

/** Visibility and HZB own the first semantic edges, including optional late recheck. */
function lowerVisibility(
  plan: FrameProgram,
  graph: FrameGraph,
  bind: SceneBind,
  owners: FrameProgramOwners,
): {
  result: PackedVisibilityOutputs;
  cameraBuffer: ResourceId;
  builtHzb: ResourceId | undefined;
} {
  if (plan.request.kind !== "scene") throw new Error("Visibility requires a scene Frame Program");
  const depth = graph.import_resource(
    "depth",
    { kind: "imported", label: "depth32float" },
    bind("depth", (bindings) => bindings.depth),
  );
  const cameraBuffer = graph.import_resource(
    "camera",
    { kind: "imported", label: "current camera" },
    bind("camera", (bindings) => bindings.view.gpu_camera_state.buffer),
  );
  const counters = graph.import_resource(
    "visibility-counters",
    { kind: "imported", label: "counter sink" },
    bind(
      "counter-sink",
      (bindings) => bindings.job.prepared.bindings?.counters ?? bindings.runtime.counterSink,
    ),
  );
  const work = graph.import_resource(
    "meshlet-work",
    { kind: "imported", label: "GPU MeshletWork" },
    bind("meshlet-work", (bindings) => {
      const queue = bindings.job.prepared.workSet.meshletWorkCandidate;
      if (!queue) throw new Error("Visibility did not prepare MeshletWork");
      return queue.queue;
    }),
  );
  const previousHzb =
    plan.request.previousHzb || plan.request.currentHzbLateRecheck
      ? graph.import_resource(
          "previous-hzb",
          { kind: "imported", label: "previous HZB" },
          bind("previous-hzb", (bindings) => bindings.hzb.getPreviousTexture()),
        )
      : undefined;
  const frameInstances = graph.import_resource(
    "frame-instances",
    { kind: "imported", label: "GPU-selected frame instance transforms" },
    bind("frame-instances", (bindings) => bindings.job.prepared.workSet.frameInstances.records),
  );
  const frameGeometry = graph.import_resource(
    "frame-geometry",
    { kind: "imported", label: "GPU-selected shared frame geometry" },
    bind("frame-geometry", (bindings) => bindings.job.prepared.workSet.frameGeometry.buffer),
  );
  let result = owners.visibility.addToGraph(
    graph,
    bind("visibility-job", (bindings) => bindings.job),
    {
      camera: cameraBuffer,
      counters,
      meshletWorkRecords: work,
      frameInstances,
      frameGeometry,
      previousHzb,
      depth,
    },
  );
  const hzbCurrent = plan.stages.includes("hzb")
    ? graph.import_resource(
        "current-hzb",
        { kind: "imported", label: "current HZB" },
        bind("current-hzb", (bindings) => bindings.hzb.getCurrentTexture()),
      )
    : undefined;
  const hzbBuilder =
    hzbCurrent === undefined
      ? undefined
      : graph.add(
          "Visibility/build HZB",
          bind("hzb-build", (bindings) => ({ hzb: bindings.hzb, depth: bindings.depth })),
          (data, _resources, context) => {
            data.hzb.build((context.encoder as ShadeGPUCommandContext).gpu_encoder, data.depth);
          },
        );
  hzbBuilder?.read(result.frame.depth);
  let builtHzb = hzbBuilder?.write(hzbCurrent!);
  if (plan.request.currentHzbLateRecheck) {
    if (builtHzb === undefined) throw new Error("Late visibility recheck requires current HZB");
    result = owners.visibility.addCurrentHzbLateRecheckToGraph(
      graph,
      bind("late-visibility-job", (bindings) => bindings.job),
      {
        camera: cameraBuffer,
        counters: result.counters,
        currentHzb: builtHzb,
        sourceMeshletWork: result.frame.meshletWork.records,
        visibilityKey: result.frame.visibilityKey,
        depth: result.frame.depth,
        sourceFrame: result.frame,
      },
    );
    const finalHzb = graph.add(
      "Visibility/final HZB",
      bind("hzb-final", (bindings) => ({ hzb: bindings.hzb, depth: bindings.depth })),
      (data, _resources, context) =>
        data.hzb.build((context.encoder as ShadeGPUCommandContext).gpu_encoder, data.depth),
    );
    finalHzb.read(result.frame.depth);
    builtHzb = finalHzb.write(builtHzb);
    finalHzb.make_side_effect();
  }
  owners.visibilityCounters.addToGraph(
    graph,
    result.frame.domain,
    {
      visibility: result.frame.visibilityKey,
      counters: result.counters,
    },
    "visibility-key",
    bind("visibility-counter-sampling", (bindings) => ({ enabled: bindings.job.countersEnabled })),
  );
  return { result, cameraBuffer, builtHzb };
}

/** Step two installs the final HDR/Temporal/Presentation chain after Appearance data consumers are complete. */
