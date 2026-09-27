import { FrameGraph, FrameGraphBindingLayout, type CompiledFrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";
import type { VisibilityFeature, PackedVisibilityOutputs } from "../features/VisibilityFeature.js";
import type { SurfaceMaterialPass } from "../surface/SurfaceMaterialPass.js";
import type { SurfacePresentPass } from "../surface/SurfacePresentPass.js";
import type { LightClusterPass } from "../passes/LightClusterPass.js";
import type { PhysicalSkyPass } from "../passes/PhysicalSkyPass.js";
import type { AerialPerspectivePass } from "../passes/AerialPerspectivePass.js";
import type { XeGtaoPreparationPass } from "../ao/XeGtaoPreparationPass.js";
import type { XeGtaoMainPass } from "../ao/XeGtaoMainPass.js";
import type { XeGtaoDenoisePass } from "../ao/XeGtaoDenoisePass.js";
import type { EmptyFrameBindings, FrameProgramBindings, SceneFrameBindings } from "./FrameProgramBindings.js";
import type { FrameProgram, FrameProduct } from "./FrameProgram.js";

export type FrameProgramOwners = Readonly<{
  visibility: VisibilityFeature;
  surface: SurfaceMaterialPass;
  present: SurfacePresentPass;
  sky: PhysicalSkyPass | null;
  aerial: AerialPerspectivePass | null;
  lightCluster: () => LightClusterPass;
  xeGtaoPreparation: XeGtaoPreparationPass;
  xeGtaoMain: XeGtaoMainPass;
  xeGtaoDenoise: XeGtaoDenoisePass;
}>;

type SceneBind = <T extends object>(name: string, resolve: (bindings: SceneFrameBindings) => T) => T;

function assertTextureProduct(plan: FrameProgram, graph: FrameGraph,
  product: FrameProduct, resource: ResourceId): void {
  const fact = plan.facts.find(entry => entry.product === product);
  if (!fact) throw new Error(`Frame Program has no demand for ${product}`);
  const descriptor = graph.getDescriptor(resource);
  if (descriptor?.kind !== "transient_texture") return; // Imported descriptors are checked against frame bindings.
  if (fact.extent === null || descriptor.width !== fact.extent[0] ||
      descriptor.height !== fact.extent[1] || descriptor.format !== fact.format ||
      (descriptor.domain !== undefined && descriptor.domain !== fact.domain)) {
    throw new Error(`Frame Program ${product} descriptor does not match its semantic fact`);
  }
}

/** Lower the semantic plan to the one existing FrameGraph execution path. */
export function lowerFrameProgram(
  plan: FrameProgram, initial: FrameProgramBindings, owners?: FrameProgramOwners
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
    "swapchain", { kind: "imported", label: "swapchain" },
    layout.slot("swapchain", initial, bindings => bindings.swapchain)
  );
  const clear = graph.add("Renderer/empty present", {}, (_data, resources, context) => {
    const command = context.encoder as ShadeGPUCommandContext;
    const pass = command.gpu_encoder.beginRenderPass({ colorAttachments: [{
      view: resolveTextureView(resources.get(swapchain)),
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: 0.025, g: 0.035, b: 0.05, a: 1 }
    }] });
    pass.end();
  });
  clear.write(swapchain);
  return graph.compile();
}

function compileSceneGraph(plan: FrameProgram, initial: SceneFrameBindings, owners: FrameProgramOwners): CompiledFrameGraph {
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
  assertTextureProduct(plan, graph, "visibility", result.frame.visibilityKey);
  const materialRecords = graph.import_resource(
    "material-records", { kind: "imported", label: "published material records" },
    bind("material-records", bindings => bindings.runtime.materialResources.materialRecords)
  );
  const instances = graph.import_resource(
    "scene-instances", { kind: "imported", label: "published instance records" },
    bind("scene-instances", bindings => bindings.job.scene.instances)
  );
  const activeSets = plan.request.activeSets;
  const needsDirectLight = plan.stages.includes("light-cluster");
  const geometryMetadata = graph.import_resource(
    "geometry-metadata", { kind: "imported", label: "geometry metadata" },
    bind("geometry-metadata", bindings => bindings.job.assets.sparseShading.assetMetadataHeap)
  );
  const vertexPayload = graph.import_resource(
    "vertex-payload", { kind: "imported", label: "geometry vertex payload" },
    bind("vertex-payload", bindings => bindings.job.assets.sparseShading.vertexPayloadHeap)
  );
  const textureRoutes = graph.import_resource(
    "texture-routes", { kind: "imported", label: "published texture routes" },
    bind("texture-routes", bindings => bindings.runtime.materialResources.textureRouteRecords)
  );
  const textureBanks: number[][] = Array.from({ length: 4 }, () => []);
  for (const setId of activeSets) {
    const bindingSet = initial.runtime.materialResources.bindingSets.find(set => set.id === setId);
    if (!bindingSet) throw new Error(`Surface texture binding set ${setId} is not resident`);
    for (let bank = 0; bank < bindingSet.textureBanks.length; bank++) {
      textureBanks[setId]![bank] = graph.import_resource(
        `texture-set-${setId}-bank-${bank}`,
        { kind: "imported", label: `texture set ${setId} bank ${bank}` },
        bind(`texture-set-${setId}-bank-${bank}`, bindings => {
          const active = bindings.runtime.materialResources.bindingSets.find(set => set.id === setId);
          if (!active) {
            throw new Error(`Surface texture bank ${setId}:${bank} is not resident`);
          }
          return active.textureBanks[bank]!;
        })
      );
    }
  }
  const virtualMetadata = plan.request.virtualGeometry
    ? graph.import_resource(
        "virtual-geometry-metadata", { kind: "imported", label: "virtual geometry metadata" },
        bind("virtual-geometry-metadata", bindings => {
          if (!bindings.runtime.virtualGeometry) throw new Error("Virtual geometry publication changed");
          return bindings.runtime.virtualGeometry.metadata;
        })
      ) : undefined;
  const virtualBanks = plan.request.virtualGeometry
    ? Array.from({ length: plan.request.virtualBankCount }, (_, bank) => graph.import_resource(
        `virtual-geometry-bank-${bank}`,
        { kind: "imported", label: `virtual geometry bank ${bank}` },
        bind(`virtual-geometry-bank-${bank}`, bindings => {
          const resource = bindings.runtime.virtualGeometry?.banks[bank];
          if (!resource) throw new Error(`Virtual geometry bank ${bank} is not resident`);
          return resource;
        })
      )) : undefined;
  const lightRecords = needsDirectLight ? graph.import_resource(
    "light-records", { kind: "imported", label: "scene light records" },
    bind("light-records", bindings => bindings.view.environment.lights.buffer_data)
  ) : undefined;
  const physicalEnvironmentSun = !plan.request.physicalEnvironment ? undefined : graph.import_resource(
    "physical-environment-sun", { kind: "imported", label: "Physical Environment Sun" },
    bind("physical-environment-sun", bindings => bindings.environment!.parameters)
  );
  const clusters = lightRecords === undefined ? undefined :
    owners.lightCluster().addToGraph(
      graph,
      bind("surface-light-cluster", bindings => ({
        camera: bindings.camera,
        lights: bindings.view.environment.lights,
        width: result.frame.domain.width,
        height: result.frame.domain.height
      })),
      { camera: cameraBuffer, lightDatabase: lightRecords, hzb: builtHzb! }
    );
  const scalarAo = plan.request.aoProfile === "scalar-high" ? (() => {
    if (!plan.stages.includes("xe-gtao") || !plan.products.includes("indirect-visibility")) {
      throw new Error("Frame Program omitted the requested XeGTAO producer");
    }
    const prepared = owners.xeGtaoPreparation.addToGraph(graph, {
      width: result.frame.domain.width, height: result.frame.domain.height,
      depth: result.frame.depth,
      frame: bind("xe-gtao-frame", bindings => ({
        camera: bindings.view.gpu_camera_state,
        // The production scene scale is one metre per world unit. A scene-scale
        // contract can replace this pair without changing the donor math.
        radiusMeters: 1, metersPerWorldUnit: 1, noiseIndex: 0
      }))
    });
    const main = owners.xeGtaoMain.addToGraph(graph, { prepared });
    const visibility = owners.xeGtaoDenoise.addToGraph(graph, { prepared, main });
    const descriptor = graph.getDescriptor(visibility.packed);
    if (descriptor?.kind !== "transient_buffer" ||
        descriptor.size !== visibility.words * 4 ||
        visibility.width !== result.frame.domain.width ||
        visibility.height !== result.frame.domain.height) {
      throw new Error("XeGTAO final visibility has an invalid packed buffer shape");
    }
    return visibility.packed;
  })() : undefined;
  const surface = owners.surface.addToGraph(graph, {
    width: result.frame.domain.width,
    height: result.frame.domain.height,
    frame: bind("surface-frame", bindings => ({
      runtime: bindings.runtime,
      assets: bindings.job.assets,
      view: bindings.view,
      frameIndex: bindings.view.frame_index,
      outputWidth: plan.request.outputWidth,
      outputHeight: plan.request.outputHeight,
      preExposure: bindings.preExposure
    })),
    activeSets,
    hasLit: plan.request.hasLit,
    indirectVisibility: scalarAo,
    virtualGeometry: plan.request.virtualGeometry,
    visibilityKey: result.frame.visibilityKey,
    meshletWork: result.frame.meshletWork.records,
    materialRecords,
    depth: result.frame.depth,
    instances,
    geometryMetadata,
    vertexPayload,
    virtualMetadata,
    virtualBanks,
    textureRoutes,
    textureBanks,
    lightRecords,
    lightLookup: clusters?.lookup,
    lightData: clusters?.data,
    lightParams: clusters?.parameters,
    physicalEnvironmentSun,
    physicalEnvironmentTransmittance: !plan.request.physicalEnvironment ? undefined : graph.import_resource(
      "physical-environment-sun-transmittance", { kind: "imported", label: "Physical Environment sun transmittance" },
      bind("physical-environment-sun-transmittance", bindings => bindings.environment!.luts.views.transmittance)
    ),
    physicalSkyIrradiance: !plan.request.physicalEnvironment ? undefined : graph.import_resource(
      "physical-environment-sky-irradiance", { kind: "imported", label: "Physical Environment sky irradiance" },
      bind("physical-environment-sky-irradiance", bindings => bindings.environment!.luts.views.irradiance)
    ),
    physicalSkySpecular: !plan.request.physicalEnvironment ? undefined : graph.import_resource(
      "physical-environment-sky-specular", { kind: "imported", label: "Physical sky filtered specular" },
      bind("physical-environment-sky-specular", bindings => bindings.environment!.ibl.views.specular)
    ),
    physicalSkyDfg: !plan.request.physicalEnvironment ? undefined : graph.import_resource(
      "physical-environment-sky-dfg", { kind: "imported", label: "Physical sky DFG" },
      bind("physical-environment-sky-dfg", bindings => bindings.environment!.ibl.views.dfg)
    )
  });
  assertTextureProduct(plan, graph, "surface-radiance", surface.radiance);
  assertTextureProduct(plan, graph, "surface-motion", surface.motion);
  lowerPresentation(plan, initial, owners, graph, bind, cameraBuffer, result, surface, physicalEnvironmentSun);
  return graph.compile();
}

/** Visibility and HZB own the first semantic edges, including optional late recheck. */
function lowerVisibility(plan: FrameProgram, graph: FrameGraph, bind: SceneBind, owners: FrameProgramOwners): {
  result: PackedVisibilityOutputs; cameraBuffer: ResourceId; builtHzb: ResourceId | undefined;
} {
  if (plan.request.kind !== "scene") throw new Error("Visibility requires a scene Frame Program");
  const depth = graph.import_resource(
    "depth", { kind: "imported", label: "depth32float" },
    bind("depth", bindings => bindings.depth)
  );
  const cameraBuffer = graph.import_resource(
    "camera", { kind: "imported", label: "current camera" },
    bind("camera", bindings => bindings.view.gpu_camera_state.buffer)
  );
  const counters = graph.import_resource(
    "visibility-counters", { kind: "imported", label: "counter sink" },
    bind("counter-sink", bindings => bindings.runtime.counterSink)
  );
  const work = graph.import_resource(
    "meshlet-work", { kind: "imported", label: "GPU MeshletWork" },
    bind("meshlet-work", bindings => {
      const queue = bindings.job.prepared.workSet.meshletWorkCandidate;
      if (!queue) throw new Error("Visibility did not prepare MeshletWork");
      return queue.queue;
    })
  );
  const previousHzb = plan.request.previousHzb
    ? graph.import_resource(
        "previous-hzb", { kind: "imported", label: "previous HZB" },
        bind("previous-hzb", bindings => bindings.hzb.getPreviousTexture())
      )
    : undefined;
  let result = owners.visibility.addToGraph(
    graph, bind("visibility-job", bindings => bindings.job),
    { camera: cameraBuffer, counters, meshletWorkRecords: work, previousHzb, depth }
  );
  const hzbCurrent = plan.stages.includes("hzb") ? graph.import_resource(
    "current-hzb", { kind: "imported", label: "current HZB" },
    bind("current-hzb", bindings => bindings.hzb.getCurrentTexture())
  ) : undefined;
  const hzbBuilder = hzbCurrent === undefined ? undefined : graph.add(
    "Visibility/build HZB",
    bind("hzb-build", bindings => ({ hzb: bindings.hzb, depth: bindings.depth })),
    (data, _resources, context) => {
      data.hzb.build((context.encoder as ShadeGPUCommandContext).gpu_encoder, data.depth);
    }
  );
  hzbBuilder?.read(result.frame.depth);
  const builtHzb = hzbBuilder?.write(hzbCurrent!);
  if (plan.request.currentHzbLateRecheck) {
    if (builtHzb === undefined) throw new Error("Late visibility recheck requires current HZB");
    const filteredWork = graph.import_resource(
      "late-recheck-work", { kind: "imported", label: "filtered MeshletWork" },
      bind("late-work", bindings => bindings.job.prepared.currentHzbLateRecheck!.queue)
    );
    const filteredIndirect = graph.import_resource(
      "late-recheck-indirect", { kind: "imported", label: "filtered indirect draw" },
      bind("late-indirect", bindings => bindings.job.prepared.currentHzbLateRecheck!.drawIndirect)
    );
    result = owners.visibility.addCurrentHzbLateRecheckToGraph(
      graph, bind("late-visibility-job", bindings => bindings.job),
      {
        camera: cameraBuffer,
        counters: result.counters,
        currentHzb: builtHzb,
        sourceMeshletWork: result.frame.meshletWork.records,
        filteredMeshletWork: filteredWork,
        filteredDrawIndirect: filteredIndirect,
        visibilityKey: result.frame.visibilityKey,
        shadingBinId: result.frame.shadingBinId,
        depth: result.frame.depth,
        sourceFrame: result.frame
      }
    );
  }
  return { result, cameraBuffer, builtHzb };
}

/** Environment transport, FSR3 reconstruction, and Present consume the Surface products. */
function lowerPresentation(
  plan: FrameProgram, initial: SceneFrameBindings, owners: FrameProgramOwners,
  graph: FrameGraph, bind: SceneBind, cameraBuffer: ResourceId,
  result: PackedVisibilityOutputs, surface: ReturnType<SurfaceMaterialPass["addToGraph"]>,
  physicalEnvironmentSun: ResourceId | undefined
): void {
  if (plan.request.kind !== "scene") throw new Error("Presentation requires a scene Frame Program");
  const atmosphereEnvironment = !plan.stages.includes("physical-sky") ? undefined : graph.import_resource(
    "physical-environment-transmittance", { kind: "imported", label: "Physical Environment transmittance" },
    bind("physical-environment-transmittance", bindings => bindings.environment!.luts.views.transmittance)
  );
  const skyRadiance = !plan.stages.includes("physical-sky") ? undefined : graph.import_resource(
    "physical-environment-sky-radiance", { kind: "imported", label: "Physical Environment sky radiance" },
    bind("physical-environment-sky-radiance", bindings => bindings.environment!.luts.views.scattering)
  );
  const higherOrderScattering = !plan.stages.includes("physical-sky") ? undefined : graph.import_resource(
    "physical-environment-higher-order-scattering", { kind: "imported", label: "Physical Environment higher-order scattering" },
    bind("physical-environment-higher-order-scattering", bindings => bindings.environment!.luts.views.higherOrderScattering)
  );
  const environmentRadiance = !plan.stages.includes("physical-sky") || atmosphereEnvironment === undefined || skyRadiance === undefined || higherOrderScattering === undefined || owners.sky === null
    ? surface.radiance
    : owners.sky.addToGraph(graph, {
        hdr: surface.radiance, depth: result.frame.depth, camera: cameraBuffer,
        transmittance: atmosphereEnvironment, scattering: skyRadiance,
        higherOrder: higherOrderScattering, environment: physicalEnvironmentSun!
      });
  if (plan.request.physicalEnvironment) assertTextureProduct(plan, graph, "sky-radiance", environmentRadiance);
  const aerialRadiance = !plan.stages.includes("aerial") || atmosphereEnvironment === undefined || skyRadiance === undefined || higherOrderScattering === undefined || physicalEnvironmentSun === undefined || owners.aerial === null
    ? environmentRadiance
    : owners.aerial.addToGraph(graph, { scene: environmentRadiance, depth: result.frame.depth,
        camera: cameraBuffer, environment: physicalEnvironmentSun,
        transmittance: atmosphereEnvironment, scattering: skyRadiance,
        higherOrder: higherOrderScattering, width: result.frame.domain.width, height: result.frame.domain.height });
  if (plan.request.physicalEnvironment) assertTextureProduct(plan, graph, "aerial-radiance", aerialRadiance);
  const reconstructedRadiance = initial.fsr3.addToGraph(graph, {
    color: aerialRadiance, depth: result.frame.depth, motion: surface.motion,
    width: result.frame.domain.width, height: result.frame.domain.height,
    outputWidth: plan.request.outputWidth, outputHeight: plan.request.outputHeight
  }, (name, resolve) => bind(`fsr3/${name}`, bindings => resolve(bindings.fsr3)));
  assertTextureProduct(plan, graph, "reconstructed-color", reconstructedRadiance);
  const swapchain = graph.import_resource(
    "swapchain", { kind: "imported", label: "swapchain" },
    bind("swapchain", bindings => bindings.swapchain)
  );
  owners.present.addToGraph(
    graph, reconstructedRadiance, swapchain,
    plan.request.outputWidth, plan.request.outputHeight
  );
}
