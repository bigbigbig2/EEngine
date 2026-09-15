import assert from "node:assert/strict";
import test from "node:test";

import "./webgpu-test-globals.mjs";

import { FrameGraph, FrameGraphContext } from "../.test-dist/framegraph/FrameGraph.js";
import {
  captureGpuSparseShadingCapabilityRecord,
  createGpuSparseShadingCapabilityPlan,
  GPU_SPARSE_SHADING_REQUIRED_FEATURES,
  GPU_SPARSE_SHADING_REQUIRED_LIMITS
} from "../.test-dist/gpu/GpuSparseShadingCapability.js";
import { GpuShadingPublicationStore } from "../.test-dist/gpu/GpuShadingPublicationPlan.js";
import { GPU_SHADING_OUTPUT_DEPENDENCY } from "../.test-dist/gpu/GpuSparseShadingPipelineContract.js";
import {
  addSparseShadingCandidateToGraph,
  createSparseShadingCandidatePlan
} from "../.test-dist/render/pipeline/SparseShadingCandidatePipeline.js";
import {
  createSparseShadingCandidateExecutor
} from "../.test-dist/render/pipeline/SparseShadingCandidateExecutor.js";
import { SparseShadingCandidateRuntime } from "../.test-dist/render/pipeline/SparseShadingCandidateRuntime.js";
import {
  SparseShadingGpuRevisionOwner
} from "../.test-dist/render/pipeline/SparseShadingGpuRevision.js";
import {
  SparseShadingDiagnosticsPass
} from "../.test-dist/render/passes/SparseShadingDiagnosticsPass.js";
import { SurfaceFeature } from "../.test-dist/render/features/SurfaceFeature.js";

const limits = Object.freeze({
  maxTextureDimension2D: 32768,
  maxBufferSize: 8 * 1024 * 1024 * 1024,
  maxStorageBufferBindingSize: 8 * 1024 * 1024 * 1024,
  maxComputeWorkgroupsPerDimension: 65535
});
const adapterLimits = {
  ...GPU_SPARSE_SHADING_REQUIRED_LIMITS
};
const capabilityPlan = createGpuSparseShadingCapabilityPlan({
  features: GPU_SPARSE_SHADING_REQUIRED_FEATURES,
  limits: adapterLimits,
  info: { subgroupMinSize: 4, subgroupMaxSize: 128 }
});
const capability = captureGpuSparseShadingCapabilityRecord(capabilityPlan, {
  features: GPU_SPARSE_SHADING_REQUIRED_FEATURES,
  limits: adapterLimits,
  textureFormatFeatures: ["texture-formats-tier1"],
  formatProfile: "desktop-tier1-v1"
});
const OFF = Object.freeze({
  screenSpaceDiffuseMode: "off",
  ssr: false,
  temporal: false,
  shadows: false,
  post: true,
  diagnostics: false
});

function fakeGpuRevisionFactory(destroyed) {
  return async (_device, publication, diagnostics) => {
    if (publication.pipelines.length === 0) {
      return Object.freeze({
        snapshot: publication,
        bins: null,
        resolve: null,
        settings: null,
        status: null,
        heapBytes: 0,
        indirectBytes: 0,
        settingsBytes: 0,
        statusBytes: 0
      });
    }
    const sparse = publication.executionMode === "sparse-microtile";
    const bins = sparse ? {
      diagnostics,
      sizing: publication.sizing,
      destroy() { destroyed.push(`bins:${publication.revision}`); }
    } : null;
    const resolve = {
      diagnostics,
      publicationRevision: publication.revision,
      executionMode: publication.executionMode,
      destroy() { destroyed.push(`resolve:${publication.revision}`); }
    };
    const settings = sparse ? {
      size: 256,
      destroy() { destroyed.push(`settings:${publication.revision}`); }
    } : null;
    const status = sparse ? null : {
      size: 32,
      destroy() { destroyed.push(`status:${publication.revision}`); }
    };
    return Object.freeze({
      snapshot: publication,
      bins,
      resolve,
      settings,
      status,
      heapBytes: publication.sizing.heapBytes,
      indirectBytes: sparse ? publication.sizing.indirectBytes : 0,
      settingsBytes: settings?.size ?? 0,
      statusBytes: status?.size ?? 0
    });
  };
}

function context(outputDependencyMask, width = 320, height = 180, shadowSamplingEnabled = false) {
  return { width, height, outputDependencyMask, shadowSamplingEnabled, capability, sizingLimits: limits };
}

function snapshot(kind, outputDependencyMask, options = {}) {
  const store = new GpuShadingPublicationStore(context(
    outputDependencyMask,
    options.width ?? 320,
    options.height ?? 180,
    options.shadowSamplingEnabled ?? false
  ));
  if (kind === "empty") return { store, snapshot: store.currentSnapshot() };
  const textured = kind === "textured";
  const unlit = kind === "unlit";
  const pipelineCount = options.pipelineCount ?? 1;
  const transaction = store.beginTransaction();
  transaction.replaceAll({
    materials: Array.from({ length: pipelineCount }, (_, id) => ({
      id,
      profile: {
        shadingModel: unlit ? "unlit" : "standard-pbr",
        hasBaseTexture: textured || (pipelineCount > 1 && id > 0),
        hasOrmTexture: false,
        hasNormalTexture: false,
        hasEmissiveTexture: false,
        hasOcclusionTexture: false,
        requiredUvSetsMask: textured || (pipelineCount > 1 && id > 0) ? 1 : 0,
        textureBindingSetId: textured
          ? (pipelineCount > 1 && id > 0 ? 3 : 2)
          : (pipelineCount > 1 && id > 0 ? 2 : 0)
      },
      generation: 3 + id,
      textureGeneration: 4 + id
    })),
    geometries: [{
      id: 0,
      profile: {
        hasAuthoredVertexColor: false,
        hasUv0: textured || pipelineCount > 1,
        hasUv1: false,
        hasUv2: false,
        hasNormal: !unlit,
        hasTangent: false
      },
      generation: 5
    }],
    instances: Array.from({ length: pipelineCount }, (_, id) => ({
      id,
      materialId: id,
      geometryId: 0,
      active: true,
      transparent: options.transparent ?? false,
      generation: 6 + id
    }))
  });
  return { store, snapshot: transaction.commit(1) };
}

function productionSurfaceFixture(publication) {
  const graph = new FrameGraph("ADR-0013 production SurfaceFeature matrix");
  const imported = (name) => graph.import_resource(
    name,
    { kind: "imported" },
    { name }
  );
  const revision = publication.pipelines.length === 0
    ? Object.freeze({
        snapshot: publication,
        bins: null,
        resolve: null,
        settings: null,
        status: null,
        heapBytes: 0,
        indirectBytes: 0,
        settingsBytes: 0,
        statusBytes: 0
      })
    : publication.executionMode === "sparse-microtile"
      ? Object.freeze({
        snapshot: publication,
        bins: {
          heap: { name: "bin-heap" },
          indirectArgs: { name: "bin-indirect" },
          createFrameBindingsForExecution() { throw new Error("compile-only fixture"); },
          encodeClassify() { throw new Error("compile-only fixture"); },
          encodeFinalize() { throw new Error("compile-only fixture"); }
        },
        resolve: {
          createFrameBindingsForExecution() { throw new Error("compile-only fixture"); },
          encode() { throw new Error("compile-only fixture"); }
        },
        settings: { name: "bin-settings" },
        status: null,
        heapBytes: publication.sizing.heapBytes,
        indirectBytes: publication.sizing.indirectBytes,
        settingsBytes: 256,
        statusBytes: 0
      })
      : Object.freeze({
        snapshot: publication,
        bins: null,
        resolve: {
          createFrameBindingsForExecution() { throw new Error("compile-only fixture"); },
          encode() { throw new Error("compile-only fixture"); }
        },
        settings: null,
        status: { size: 32, name: "direct-status" },
        heapBytes: 0,
        indirectBytes: 0,
        settingsBytes: 0,
        statusBytes: 32
      });
  const visibility = {
    visibilityKey: imported("production-visibility-key"),
    shadingBinId: publication.executionMode === "sparse-microtile"
      ? imported("production-shading-bin-id")
      : null,
    depth: imported("production-depth"),
    meshletWork: { records: imported("production-meshlet-work") },
    domain: {
      domain: "internal-full",
      width: publication.context.width,
      height: publication.context.height,
      scale: 1
    }
  };
  return {
    graph,
    revision,
    job: {
      frameIndex: 0,
      materialCount: 1,
      materialGeneration: 3,
      textureGeneration: 4,
      materialPublicationRevision: 1,
      assetHeaps: {},
      preExposure: 1,
      upscaleRatio: [1, 1],
      cameraPosition: [0, 0, 0],
      currentViewProjection: new Float32Array(16),
      previousViewProjection: new Float32Array(16)
    },
    inputs: {
      revision,
      visibility,
      instanceRecords: imported("production-instances"),
      assetMetadataHeap: imported("production-asset-metadata"),
      vertexPayloadHeap: imported("production-vertex-payload"),
      materialRecords: imported("production-materials"),
      textureDescriptorRoutingHeap: imported("production-texture-routing"),
      textureBindingSets: [],
      lightDatabase: null,
      clusters: null,
      shadowAtlas: null
    }
  };
}

test("production SurfaceFeature prunes no-opaque and exact compact output resources", (t) => {
  const previousBufferUsage = globalThis.GPUBufferUsage;
  const previousTextureUsage = globalThis.GPUTextureUsage;
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  globalThis.GPUTextureUsage = {
    RENDER_ATTACHMENT: 1,
    STORAGE_BINDING: 2,
    TEXTURE_BINDING: 4,
    COPY_SRC: 8
  };
  t.after(() => {
    globalThis.GPUBufferUsage = previousBufferUsage;
    globalThis.GPUTextureUsage = previousTextureUsage;
  });
  let destroyed = 0;
  let created = 0;
  let samplerRequests = 0;
  const surface = new SurfaceFeature({
    device: {
      createBuffer(descriptor) {
        created++;
        return { ...descriptor, destroy() { destroyed++; } };
      }
    },
    samplers: { obtain(descriptor) { samplerRequests++; return { descriptor }; } }
  });
  const coldEmpty = productionSurfaceFixture(snapshot("empty", 0).snapshot);
  surface.beginFrame(coldEmpty.revision);
  assert.equal(surface.addToGraph(coldEmpty.graph, coldEmpty.job, coldEmpty.inputs), null);
  assert.equal(created, 0, "no opaque consumer must not allocate a view buffer");
  assert.equal(samplerRequests, 0, "no opaque consumer must not request samplers");

  const cases = [
    {
      name: "color-only",
      mask: 0,
      resources: [],
      absent: ["surface-normal", "surface-material", "surface-albedo-ao", "velocity"],
      bytes: 8
    },
    {
      name: "shading+velocity",
      mask: GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite |
        GPU_SHADING_OUTPUT_DEPENDENCY.Velocity,
      resources: ["surface-normal", "surface-material", "velocity"],
      absent: ["surface-albedo-ao"],
      bytes: 28
    },
    {
      name: "diffuse-only",
      mask: GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite,
      resources: ["surface-material", "surface-albedo-ao"],
      absent: ["surface-normal", "velocity"],
      bytes: 20
    }
  ];
  for (const entry of cases) {
    const publication = snapshot("unlit", entry.mask).snapshot;
    const fixture = productionSurfaceFixture(publication);
    surface.beginFrame(fixture.revision);
    const frame = surface.addToGraph(fixture.graph, fixture.job, fixture.inputs);
    assert.ok(frame, entry.name);
    const sink = fixture.graph.add(`sink/${entry.name}`, {}, () => {});
    sink.read(frame.direct.hdr);
    sink.make_side_effect();
    const dump = fixture.graph.compile().dump();
    const resourceNames = dump.resources.map((resource) => resource.name);
    const passNames = dump.passes.filter((pass) => !pass.culled).map((pass) => pass.name);
    const resolvePass = dump.passes.find(
      (pass) => pass.name === "SparseShading/active-bin production indirect resolve"
    );
    if (publication.executionMode === "sparse-microtile") {
      assert.ok(passNames.includes("SparseShading/clear + classify production Visibility MRT"));
      assert.ok(passNames.includes("SparseShading/finalize production indirect arguments"));
    } else {
      assert.ok(passNames.includes("SparseShading/clear DirectSingleBin status"));
      assert.equal(passNames.some((name) => /classify|finalize/iu.test(name)), false);
    }
    assert.ok(passNames.includes("SparseShading/initialize production HDR"));
    assert.ok(passNames.includes("SparseShading/active-bin production indirect resolve"));
    assert.ok(resolvePass);
    assert.equal(passNames.some((name) => /clear.*surface/iu.test(name)), false);
    for (const suffix of entry.resources) {
      const resource = dump.resources.find((candidate) => candidate.name.endsWith(suffix));
      assert.ok(resource, `${entry.name}: ${suffix}`);
      assert.equal(resource.firstUsePass, resolvePass.id, `${entry.name}: ${suffix} producer`);
    }
    for (const suffix of entry.absent) {
      assert.equal(
        resourceNames.some((name) => name.endsWith(suffix)),
        false,
        `${entry.name}: ${suffix}`
      );
    }
    assert.equal(surface.surfaceBytesPerPixel, entry.bytes);
    assert.equal(frame.shading !== null, (entry.mask & GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite) !== 0);
    assert.equal(frame.diffuse !== null, (entry.mask & GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite) !== 0);
    assert.equal(frame.velocity !== null, (entry.mask & GPU_SHADING_OUTPUT_DEPENDENCY.Velocity) !== 0);
  }

  const emptyFixture = productionSurfaceFixture(snapshot("empty", 0).snapshot);
  surface.beginFrame(emptyFixture.revision);
  assert.equal(surface.addToGraph(
    emptyFixture.graph,
    emptyFixture.job,
    emptyFixture.inputs
  ), null);
  const emptyDump = emptyFixture.graph.compile().dump();
  assert.equal(emptyDump.passes.length, 0);
  assert.equal(emptyDump.resources.some((resource) =>
    resource.name.startsWith("SparseShading/")), false);
  assert.equal(surface.surfaceBytesPerPixel, 0);

  surface.destroy();
  assert.equal(created, 1, "active frames reuse the view allocation");
  assert.equal(samplerRequests, 0, "textureless shadow-off frames must not request samplers");
  assert.equal(destroyed, 1);
});

test("static feature matrix prunes no-opaque, unlit, textureless and optional outputs", () => {
  const empty = snapshot("empty", 0).snapshot;
  const emptyPlan = createSparseShadingCandidatePlan(empty, OFF);
  assert.equal(emptyPlan.hasOpaque, false);
  assert.deepEqual(emptyPlan.passes, []);
  assert.deepEqual(emptyPlan.resources, []);
  assert.equal(emptyPlan.memory.totalBytes, 0);

  const unlit = snapshot("unlit", 0, { pipelineCount: 2 }).snapshot;
  const unlitPlan = createSparseShadingCandidatePlan(unlit, {
    ...OFF,
    screenSpaceDiffuseMode: "ssgi",
    ssr: true,
    shadows: true
  });
  assert.deepEqual(unlitPlan.passes, [
    "visibility", "bin-clear-classify", "bin-finalize", "output-clear", "bin-resolve", "post"
  ]);
  assert.ok(!unlitPlan.resources.includes("light-clusters"));
  assert.ok(!unlitPlan.resources.includes("shadow-atlas"));
  assert.ok(!unlitPlan.resources.includes("shading-normal"));
  assert.deepEqual(unlitPlan.histories, []);

  const { store: litStore, snapshot: lit } = snapshot("pbr", 0);
  const shadowMutation = litStore.beginTransaction();
  shadowMutation.updateContext(context(0, 320, 180, true));
  const litWithShadows = shadowMutation.commit(2);
  const litPlan = createSparseShadingCandidatePlan(litWithShadows, { ...OFF, shadows: true });
  assert.ok(litPlan.passes.includes("light-cluster"));
  assert.ok(litPlan.passes.includes("shadow"));
  assert.ok(!litPlan.resources.includes("velocity"));
  assert.equal(lit.pipelines[0].groups[2].bindings.length, 1);

  const transparent = snapshot("pbr", 0, { transparent: true }).snapshot;
  const transparentPlan = createSparseShadingCandidatePlan(transparent, {
    ...OFF,
    shadows: true
  });
  assert.equal(transparentPlan.hasOpaque, false);
  assert.equal(transparentPlan.hasAnyLitConsumer, true);
  assert.deepEqual(transparentPlan.passes, ["light-cluster", "shadow"]);
  assert.deepEqual(transparentPlan.resources, ["light-clusters", "shadow-atlas"]);
  assert.equal(transparentPlan.memory.totalBytes, 0);
});

test("SSGI, temporal and diagnostics add only demanded resources, histories and counters", () => {
  const mask = GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite |
    GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite |
    GPU_SHADING_OUTPUT_DEPENDENCY.Velocity;
  const { snapshot: value } = snapshot("textured", mask, { width: 641, height: 359, pipelineCount: 2 });
  const plan = createSparseShadingCandidatePlan(value, {
    ...OFF,
    screenSpaceDiffuseMode: "ssgi",
    temporal: true,
    diagnostics: true
  });
  assert.deepEqual(plan.passes, [
    "visibility",
    "light-cluster",
    "bin-clear-classify",
    "bin-finalize",
    "output-clear",
    "bin-resolve",
    "ssgi",
    "temporal",
    "post",
    "diagnostics-finalize",
    "diagnostics-copy"
  ]);
  for (const resource of [
    "shading-normal", "albedo-ao", "material-parameters", "velocity",
    "shading-claims", "shading-diagnostics"
  ]) assert.ok(plan.resources.includes(resource));
  assert.deepEqual(plan.histories, ["ssgi-history", "temporal-color-history"]);
  assert.ok(plan.counters.includes("shading-duplicate"));
  assert.ok(plan.counters.includes("shading-unassigned"));
  assert.equal(plan.memory.shadingBinIdBytes, 641 * 359);
  assert.equal(plan.memory.indirectBytes, 768);
  assert.equal(plan.memory.diagnosticsBytes, 641 * 359 * 4 + 32);
  assert.equal(plan.memory.visibilityKeyBytes, 641 * 359 * 4);
  assert.equal(plan.memory.depthBytes, 641 * 359 * 4);
  assert.equal(plan.memory.settingsBytes, 256);
});

test("snapshot refuses feature toggles that did not atomically republish the output ABI", () => {
  const { snapshot: value } = snapshot("pbr", 0);
  assert.throws(() => createSparseShadingCandidatePlan(value, {
    ...OFF,
    temporal: true
  }), /output mask/u);
  assert.throws(() => createSparseShadingCandidatePlan(value, {
    ...OFF,
    shadows: true
  }), /shadow specialization/u);
});

test("no-opaque topology creates no opaque resources while transparent lighting stays live", () => {
  const graph = new FrameGraph("ADR-0013 transparent-only candidate");
  const imported = (name) => graph.import_resource(name, { kind: "imported" }, { name });
  const external = {
    meshletWork: imported("meshlet-work"),
    sceneGeometry: [],
    materials: [],
    lighting: [imported("light-database")],
    shadows: [imported("shadow-input")]
  };
  const stages = [];
  const { snapshot: value } = snapshot("pbr", 0, { transparent: true });
  const frame = addSparseShadingCandidateToGraph(
    graph,
    value,
    { ...OFF, shadows: true },
    external,
    (stage) => stages.push(stage)
  );
  const compiled = graph.compile();
  const executable = compiled.dump().passes.filter((pass) => !pass.culled);
  assert.deepEqual(executable.map((pass) => pass.name), [
    "SparseShading/light cluster producer",
    "SparseShading/shadow producer"
  ]);
  compiled.execute(new FrameGraphContext({ encoder: {} }), undefined);
  assert.deepEqual(stages, ["light-cluster", "shadow"]);
  assert.equal(frame.finalOutput, null);
  assert.equal(frame.shadingBinId, null);
  assert.equal(frame.shadingBins, null);
});

test("FrameGraph recipe exposes explicit producer edges and executes on one shared context", () => {
  const previousTextureUsage = globalThis.GPUTextureUsage;
  const previousBufferUsage = globalThis.GPUBufferUsage;
  globalThis.GPUTextureUsage = {
    RENDER_ATTACHMENT: 1,
    TEXTURE_BINDING: 2,
    STORAGE_BINDING: 4,
    COPY_SRC: 8
  };
  globalThis.GPUBufferUsage = {
    STORAGE: 1,
    COPY_DST: 2,
    COPY_SRC: 4,
    INDIRECT: 8,
    UNIFORM: 16,
    MAP_READ: 32
  };
  try {
    const mask = GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite |
      GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite;
    const { snapshot: value } = snapshot("textured", mask, {
      shadowSamplingEnabled: true,
      pipelineCount: 2
    });
    const features = {
      ...OFF,
      screenSpaceDiffuseMode: "ssgi",
      shadows: true,
      diagnostics: true
    };
    const graph = new FrameGraph("ADR-0013 candidate");
    const imported = (name) => graph.import_resource(name, { kind: "imported" }, { name });
    const heap = { name: "heap" };
    const indirectArgs = { name: "indirect" };
    const settings = { name: "settings" };
    const external = {
      meshletWork: imported("meshlet-work"),
      sceneGeometry: [imported("instances"), imported("geometry-heaps")],
      materials: [imported("materials"), imported("texture-set")],
      lighting: [imported("light-database"), imported("cluster-input")],
      shadows: [imported("shadow-input")],
      presentation: imported("presentation"),
      captureReadback: imported("capture-readback"),
      captureScratch: [imported("capture-control")],
      binResources: { heap, indirectArgs, settings },
      histories: {
        ssgi: {
          input: imported("ssgi-history-input"),
          output: imported("ssgi-history-output")
        }
      }
    };
    const stages = [];
    const stageFrames = new Map();
    const contexts = new Set();
    const commands = new Set();
    const bindingFactoryResources = [];
    const executor = createSparseShadingCandidateExecutor({
      bins: {
        heap,
        indirectArgs,
        encodeClassify(command) {
          stages.push("bin-clear-classify");
          commands.add(command);
        },
        encodeFinalize(command) {
          stages.push("bin-finalize");
          commands.add(command);
        }
      },
      directStatus: null,
      createBinBindings(frame, resources) {
        bindingFactoryResources.push(resources.get(frame.shadingBinId));
        return {
          classifier: {},
          finalizer: {},
          settingsDynamicOffset: 0,
          generation: value.generation,
          layoutRevision: value.layoutRevision
        };
      },
      resolve: {
        publicationRevision: value.revision,
        activeBinIds: value.pipelines.map((pipeline) => pipeline.binId),
        executionMode: value.executionMode,
        encode(command) {
          stages.push("bin-resolve");
          commands.add(command);
        }
      },
      createResolveBindings(frame, resources) {
        bindingFactoryResources.push(resources.get(frame.hdr));
        return value.pipelines.map((pipeline) => ({ binId: pipeline.binId, groups: [] }));
      },
      settingsDynamicOffset: 0,
      diagnostics: {
        encodeFinalize(command) {
          stages.push("diagnostics-finalize");
          commands.add(command);
        },
        encodeCopy(command) {
          stages.push("diagnostics-copy");
          commands.add(command);
        }
      },
      executeExternalStage(stage, stageFrame, _resources, ctx) {
        stages.push(stage);
        stageFrames.set(stage, stageFrame);
        contexts.add(ctx);
      }
    });
    const frame = addSparseShadingCandidateToGraph(
      graph,
      value,
      features,
      external,
      executor
    );
    const compiled = graph.compile();
    const dump = compiled.dump();
    const executable = dump.passes.filter((pass) => !pass.culled);
    for (const name of [
      "sparse-shading/heap",
      "sparse-shading/indirect",
      "sparse-shading/settings"
    ]) {
      assert.equal(dump.resources.find((resource) => resource.name === name)?.imported, true);
    }
    assert.deepEqual(executable.map((pass) => pass.name), [
      "SparseShading/visibility MRT",
      "SparseShading/light cluster producer",
      "SparseShading/shadow producer",
      "SparseShading/clear + classify",
      "SparseShading/finalize indirect",
      "SparseShading/clear sparse outputs",
      "SparseShading/active-bin indirect resolve",
      "SparseShading/downstream/ssgi",
      "SparseShading/downstream/post",
      "SparseShading/diagnostics finalize",
      "SparseShading/diagnostics async copy boundary",
      "SparseShading/validation capture boundary"
    ]);
    const resolve = executable.find((pass) => pass.name.endsWith("indirect resolve"));
    const classify = executable.find((pass) => pass.name.includes("classify"));
    const finalizer = executable.find((pass) => pass.name.includes("finalize indirect"));
    const outputClear = executable.find((pass) => pass.name.includes("clear sparse outputs"));
    const lighting = executable.find((pass) => pass.name.includes("light cluster"));
    const shadow = executable.find((pass) => pass.name.includes("shadow producer"));
    assert.ok(finalizer.dependencies.includes(classify.id));
    assert.ok(outputClear.dependencies.includes(finalizer.id));
    assert.ok(resolve.dependencies.includes(outputClear.id));
    assert.ok(resolve.dependencies.includes(lighting.id));
    assert.ok(resolve.dependencies.includes(shadow.id));
    assert.ok(lighting.writes.some((resource) => resolve.reads.includes(resource)));
    assert.ok(shadow.writes.some((resource) => resolve.reads.includes(resource)));
    assert.equal(resolve.encoderWork.dispatches, value.pipelines.length);
    const contextValue = new FrameGraphContext({
      encoder: {
        gpu_encoder: {},
        isGPUCommandContext: true,
        clearBuffer() {}
      }
    });
    compiled.execute(contextValue, undefined);
    assert.equal(contexts.size, 1);
    assert.equal([...contexts][0], contextValue);
    assert.deepEqual([...commands], [contextValue.encoder]);
    assert.equal(bindingFactoryResources.length, 2);
    assert.ok(bindingFactoryResources.every((resource) => resource !== null && resource !== undefined));
    assert.deepEqual(stages, [
      ...frame.plan.passes.filter((stage) => stage !== "temporal" && stage !== "gtao" && stage !== "ssr"),
      "capture"
    ]);
    assert.ok(stageFrames.get("ssgi").historyInput !== null);
    assert.ok(stageFrames.get("ssgi").historyOutput !== null);
    assert.ok(frame.finalOutput !== null);
    assert.deepEqual(frame.shadingBins, {
      abiVersion: 1,
      heap: frame.heap,
      indirectArgs: frame.indirectArgs,
      generation: value.generation,
      activeBinMaskLo: value.summary.activeBinMaskLo,
      activeBinMaskHi: value.summary.activeBinMaskHi,
      microtileWidth: 8,
      microtileHeight: 8,
      domain: {
        domain: "internal-full",
        width: value.context.width,
        height: value.context.height,
        scale: 1
      }
    });
    assert.ok(frame.captureReadback !== null);
    assert.equal(frame.captureScratch.length, 1);
    const hdr = dump.resources.find((resource) => resource.name === "sparse-shading/hdr");
    assert.equal(JSON.parse(hdr.description).usage & GPUTextureUsage.COPY_SRC, GPUTextureUsage.COPY_SRC);
    const visibilityKey = dump.resources.find((resource) => resource.name === "sparse-shading/visibility-key");
    const shadingBinId = dump.resources.find((resource) => resource.name === "sparse-shading/bin-id");
    assert.equal(JSON.parse(visibilityKey.description).usage & GPUTextureUsage.COPY_SRC, GPUTextureUsage.COPY_SRC);
    assert.equal(JSON.parse(shadingBinId.description).usage & GPUTextureUsage.COPY_SRC, GPUTextureUsage.COPY_SRC);
    const post = executable.find((pass) => pass.name.endsWith("/post"));
    assert.equal(post.encoderWork.renderPasses, 1);
    assert.equal(post.encoderWork.computePasses, 0);
    const capture = executable.find((pass) => pass.name.endsWith("capture boundary"));
    assert.equal(capture.encoderWork.computePasses, 1);
    assert.equal(capture.encoderWork.dispatches, 1);
    assert.ok(capture.reads.includes(frame.visibilityKey));
    assert.ok(capture.reads.includes(frame.shadingBinId));
    assert.ok(capture.reads.includes(frame.hdr));
    assert.ok(frame.diagnosticsReadback !== null);
  } finally {
    globalThis.GPUTextureUsage = previousTextureUsage;
    globalThis.GPUBufferUsage = previousBufferUsage;
  }
});

test("candidate expands production downstream owners as real multi-pass subgraphs", () => {
  const previousTextureUsage = globalThis.GPUTextureUsage;
  const previousBufferUsage = globalThis.GPUBufferUsage;
  globalThis.GPUTextureUsage = {
    RENDER_ATTACHMENT: 1,
    TEXTURE_BINDING: 2,
    STORAGE_BINDING: 4,
    COPY_SRC: 8
  };
  globalThis.GPUBufferUsage = {
    STORAGE: 1,
    COPY_DST: 2,
    COPY_SRC: 4,
    INDIRECT: 8,
    UNIFORM: 16,
    MAP_READ: 32
  };
  try {
    const mask = GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite |
      GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite;
    const { snapshot: value } = snapshot("textured", mask, { pipelineCount: 2 });
    const graph = new FrameGraph("ADR-0013 expanded downstream");
    const imported = (name) => graph.import_resource(name, { kind: "imported" }, { name });
    const presentation = imported("presentation");
    const expanded = [];
    const frame = addSparseShadingCandidateToGraph(
      graph,
      value,
      { ...OFF, screenSpaceDiffuseMode: "ssgi", post: true },
      {
        meshletWork: imported("meshlet-work"),
        sceneGeometry: [],
        materials: [],
        lighting: [imported("lights")],
        shadows: [],
        presentation,
        binResources: { heap: {}, indirectArgs: {}, settings: {} },
        composeDownstream(stage, ownerGraph, stageFrame) {
          expanded.push(stage);
          if (stage === "ssgi") {
            const trace = ownerGraph.add("Production SSGI trace", {}, () => {});
            trace.read(stageFrame.hdr);
            const traced = trace.write(stageFrame.hdr);
            const resolve = ownerGraph.add("Production SSGI resolve", {}, () => {});
            resolve.read(traced);
            return { hdr: resolve.write(traced) };
          }
          const post = ownerGraph.add("Production post", {}, () => {});
          post.read(stageFrame.hdr);
          return { hdr: stageFrame.hdr, finalOutput: post.write(presentation) };
        }
      },
      () => {}
    );
    const dump = graph.compile().dump();
    const executable = dump.passes.filter((pass) => !pass.culled);
    assert.deepEqual(expanded, ["ssgi", "post"]);
    assert.equal(executable.some((pass) => pass.name === "SparseShading/downstream/ssgi"), false);
    assert.ok(executable.some((pass) => pass.name === "Production SSGI trace"));
    assert.ok(executable.some((pass) => pass.name === "Production SSGI resolve"));
    assert.ok(executable.some((pass) => pass.name === "Production post"));
    assert.ok(frame.hdr !== null);
    assert.ok(frame.finalOutput !== null);
    assert.notEqual(frame.finalOutput, frame.hdr);
  } finally {
    globalThis.GPUTextureUsage = previousTextureUsage;
    globalThis.GPUBufferUsage = previousBufferUsage;
  }
});

test("HDR capture usage is absent when the validation capture boundary is absent", () => {
  const previousTextureUsage = globalThis.GPUTextureUsage;
  const previousBufferUsage = globalThis.GPUBufferUsage;
  globalThis.GPUTextureUsage = {
    RENDER_ATTACHMENT: 1,
    TEXTURE_BINDING: 2,
    STORAGE_BINDING: 4,
    COPY_SRC: 8
  };
  globalThis.GPUBufferUsage = {
    STORAGE: 1,
    COPY_DST: 2,
    COPY_SRC: 4,
    INDIRECT: 8,
    UNIFORM: 16,
    MAP_READ: 32
  };
  try {
    const { snapshot: value } = snapshot("unlit", 0, { pipelineCount: 2 });
    const graph = new FrameGraph("ADR-0013 production usage closure");
    const imported = (name) => graph.import_resource(name, { kind: "imported" }, { name });
    const frame = addSparseShadingCandidateToGraph(graph, value, OFF, {
      meshletWork: imported("meshlet-work"),
      sceneGeometry: [],
      materials: [],
      lighting: [],
      shadows: [],
      presentation: imported("presentation"),
      binResources: { heap: {}, indirectArgs: {}, settings: {} }
    }, () => {});
    const dump = graph.compile().dump();
    const hdr = dump.resources.find((resource) => resource.name === "sparse-shading/hdr");
    assert.equal(JSON.parse(hdr.description).usage & GPUTextureUsage.COPY_SRC, 0);
    const visibilityKey = dump.resources.find((resource) => resource.name === "sparse-shading/visibility-key");
    const shadingBinId = dump.resources.find((resource) => resource.name === "sparse-shading/bin-id");
    assert.equal(JSON.parse(visibilityKey.description).usage & GPUTextureUsage.COPY_SRC, 0);
    assert.equal(JSON.parse(shadingBinId.description).usage & GPUTextureUsage.COPY_SRC, 0);
    assert.equal(frame.captureReadback, null);
  } finally {
    globalThis.GPUTextureUsage = previousTextureUsage;
    globalThis.GPUBufferUsage = previousBufferUsage;
  }
});

test("candidate lifecycle caches immutable plans and advances history only after submit", () => {
  const mask = GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite |
    GPU_SHADING_OUTPUT_DEPENDENCY.Velocity;
  const { store } = snapshot("pbr", mask);
  const runtime = new SparseShadingCandidateRuntime(store);
  const features = { ...OFF, temporal: true };
  const first = runtime.beginFrame(features);
  assert.throws(() => runtime.beginFrame(features), /one pending history-writing frame/u);
  const beforeAbort = runtime.evidence().historyGeneration;
  runtime.abortEncodedFrame(first.frameId);
  assert.equal(runtime.evidence().historyGeneration, beforeAbort);
  assert.throws(() => runtime.abortEncodedFrame(first.frameId), /not pending/u);
  const second = runtime.beginFrame(features);
  assert.equal(first.plan, second.plan);
  runtime.commitSubmittedFrame(2, second.frameId);
  assert.equal(runtime.evidence().historyGeneration, beforeAbort + 1);
  runtime.invalidateCameraHistory();
  assert.equal(runtime.evidence().historyGeneration, beforeAbort + 2);

  const abandonedMutation = runtime.beginMutation();
  abandonedMutation.updateContext(context(mask, 480, 270));
  assert.equal(runtime.prepareMutation(abandonedMutation, features).width, 480);
  runtime.abortMutation(abandonedMutation);

  const mutation = runtime.beginMutation();
  mutation.updateContext(context(mask, 640, 360));
  const prepared = runtime.prepareMutation(mutation, features);
  assert.equal(prepared.width, 640);
  const committed = runtime.commitMutation(mutation, 3, features);
  assert.equal(committed.publicationRevision, first.snapshot.revision + 1);
  assert.deepEqual(runtime.completeSubmittedWork(2), [1]);
  assert.deepEqual(runtime.completeSubmittedWork(3), [first.snapshot.revision]);

  runtime.beginFrame(features);
  runtime.markDeviceLost();
  assert.throws(() => runtime.beginFrame(features), /device loss/u);
  const rebuilt = runtime.rebuildAfterDeviceLoss(context(mask, 640, 360), features);
  assert.equal(rebuilt.publicationRevision, committed.publicationRevision + 1);
  const evidence = runtime.evidence();
  assert.equal(evidence.deviceEpoch, 2);
  assert.equal(evidence.abortedFrames, 2);
  assert.equal(evidence.pendingFrames, 0);
  assert.equal(evidence.submittedFrames, 1);
  assert.ok(evidence.planCacheHits >= 1);
  assert.ok(evidence.planCacheMisses >= 3);
  runtime.destroy();
  assert.throws(() => runtime.beginFrame(features), /destroyed/u);
});

test("diagnostics owner compiles separately and records finalize plus copy without submit", async () => {
  const previousShaderStage = globalThis.GPUShaderStage;
  globalThis.GPUShaderStage = { COMPUTE: 4 };
  try {
    const calls = [];
    const device = {
      limits: { minUniformBufferOffsetAlignment: 256 },
      pushErrorScope(kind) { calls.push(["push", kind]); },
      async popErrorScope() { return null; },
      createShaderModule(descriptor) {
        calls.push(["module", descriptor]);
        return { async getCompilationInfo() { return { messages: [] }; } };
      },
      createBindGroupLayout(descriptor) { return { descriptor }; },
      createPipelineLayout(descriptor) { return { descriptor }; },
      createComputePipeline(descriptor) { return { descriptor }; },
      createBindGroup(descriptor) {
        calls.push(["group", descriptor]);
        return { descriptor };
      }
    };
    const owner = await SparseShadingDiagnosticsPass.create(device);
    const encoded = [];
    const command = {
      beginComputePass(descriptor) {
        const pass = [];
        encoded.push(["pass", descriptor.label, pass]);
        return {
          setPipeline(value) { pass.push(["pipeline", value.descriptor.label]); },
          setBindGroup(index, _value, offsets) { pass.push(["group", index, offsets]); },
          dispatchWorkgroups(x, y, z) { pass.push(["dispatch", x, y, z]); },
          end() { pass.push(["end"]); }
        };
      },
      copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
        encoded.push(["copy", source, sourceOffset, destination, destinationOffset, size]);
      }
    };
    const buffers = { settings: {}, claims: {}, diagnostics: {}, readback: {} };
    owner.encodeFinalize(command, {
      shadingBinId: {},
      settings: buffers.settings,
      settingsDynamicOffset: 256,
      claims: buffers.claims,
      diagnostics: buffers.diagnostics,
      width: 65,
      height: 17
    });
    owner.encodeCopy(command, buffers.diagnostics, buffers.readback);
    assert.deepEqual(encoded[0][2].find(([name]) => name === "dispatch"), [
      "dispatch", 9, 3, 1
    ]);
    assert.deepEqual(encoded[1], [
      "copy", buffers.diagnostics, 0, buffers.readback, 0, 16
    ]);
    assert.equal(calls.some(([name]) => name === "submit"), false);
    assert.throws(() => owner.encodeFinalize(command, {
      shadingBinId: {},
      settings: buffers.settings,
      settingsDynamicOffset: 4,
      claims: buffers.claims,
      diagnostics: buffers.diagnostics,
      width: 65,
      height: 17
    }), /misaligned/u);
  } finally {
    globalThis.GPUShaderStage = previousShaderStage;
  }
});

test("sparse-shading GPU revisions publish atomically and retire only after submitted work", async () => {
  const { store, snapshot: initialSnapshot } = snapshot("unlit", 0, { pipelineCount: 2 });
  const destroyed = [];
  const owner = new SparseShadingGpuRevisionOwner(
    null,
    false,
    fakeGpuRevisionFactory(destroyed)
  );

  const initialPrepared = await owner.prepare(initialSnapshot);
  owner.publish(initialPrepared, initialSnapshot, 0);
  assert.deepEqual(owner.evidence(), {
    activeRevision: initialSnapshot.revision,
    activeDeviceEpoch: initialSnapshot.deviceEpoch,
    activeHeapBytes: initialSnapshot.sizing.heapBytes,
    activeIndirectBytes: initialSnapshot.sizing.indirectBytes,
    activeSettingsBytes: 256,
    activeStatusBytes: 0,
    activeProducerBindGroupRequests: 0,
    activeProducerBindGroupCreations: 0,
    activeResolveBindGroupRequests: 0,
    activeResolveBindGroupCreations: 0,
    retiringRevisions: [],
    retiringBytes: 0,
    pendingPreparations: 0,
    createCount: 1,
    publishCount: 1,
    abortCount: 0,
    retireCount: 0,
    deviceLossCount: 0,
    destroyed: false
  });

  const resize = store.beginTransaction();
  resize.updateContext(context(0, 640, 360));
  const resizedSnapshot = resize.prepare();
  const resizedPrepared = await owner.prepare(resizedSnapshot);
  assert.equal(owner.active(initialSnapshot).snapshot, initialSnapshot);
  assert.deepEqual(destroyed, []);
  const committedResize = resize.commit(7);
  owner.publish(resizedPrepared, committedResize, 7);
  assert.deepEqual(owner.evidence().retiringRevisions, [initialSnapshot.revision]);
  assert.equal(owner.evidence().retiringBytes,
    initialSnapshot.sizing.heapBytes + initialSnapshot.sizing.indirectBytes + 256);
  assert.deepEqual(owner.completeSubmittedWork(6), []);
  assert.deepEqual(destroyed, []);
  assert.deepEqual(owner.completeSubmittedWork(7), [initialSnapshot.revision]);
  assert.deepEqual(destroyed, [
    `resolve:${initialSnapshot.revision}`,
    `bins:${initialSnapshot.revision}`,
    `settings:${initialSnapshot.revision}`
  ]);

  const rejected = store.beginTransaction();
  rejected.updateContext(context(0, 800, 450));
  const rejectedPrepared = await owner.prepare(rejected.prepare());
  owner.abort(rejectedPrepared);
  rejected.abort();
  assert.equal(owner.evidence().abortCount, 1);
  assert.equal(owner.evidence().activeRevision, resizedSnapshot.revision);
  assert.deepEqual(destroyed.slice(-3), [
    `resolve:${resizedSnapshot.revision + 1}`,
    `bins:${resizedSnapshot.revision + 1}`,
    `settings:${resizedSnapshot.revision + 1}`
  ]);

  store.markDeviceLost();
  owner.markDeviceLost();
  assert.equal(owner.evidence().activeRevision, null);
  assert.equal(owner.evidence().deviceLossCount, 1);
  assert.deepEqual(destroyed.slice(-3), [
    `resolve:${resizedSnapshot.revision}`,
    `bins:${resizedSnapshot.revision}`,
    `settings:${resizedSnapshot.revision}`
  ]);
  owner.destroy();
});

test("candidate source owns neither submit nor synchronous readback nor a product switch", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const relative of [
    "../src/render/pipeline/SparseShadingCandidatePipeline.ts",
    "../src/render/pipeline/SparseShadingCandidateExecutor.ts",
    "../src/render/pipeline/SparseShadingCandidateRuntime.ts",
    "../src/render/pipeline/SparseShadingGpuRevision.ts",
    "../src/render/passes/SparseShadingDiagnosticsPass.ts"
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), "utf8");
    assert.doesNotMatch(source, /queue\.submit|device\.queue\.submit|mapAsync|readBuffer/u);
    assert.doesNotMatch(source, /process\.env|location\.search|URLSearchParams|legacy backend|runtime switch/iu);
  }
});
