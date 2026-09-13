import assert from "node:assert/strict";
import test from "node:test";

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
  SparseShadingDiagnosticsPass
} from "../.test-dist/render/passes/SparseShadingDiagnosticsPass.js";

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
  const transaction = store.beginTransaction();
  transaction.replaceAll({
    materials: [{
      id: 0,
      profile: {
        shadingModel: unlit ? "unlit" : "standard-pbr",
        hasBaseTexture: textured,
        hasOrmTexture: false,
        hasNormalTexture: false,
        hasEmissiveTexture: false,
        textureBindingSetId: textured ? 2 : 0
      },
      generation: 3,
      textureGeneration: 4
    }],
    geometries: [{
      id: 0,
      profile: {
        hasAuthoredVertexColor: false,
        hasUv0: textured,
        hasNormal: !unlit,
        hasTangent: false
      },
      generation: 5
    }],
    instances: [{
      id: 0,
      materialId: 0,
      geometryId: 0,
      active: true,
      transparent: options.transparent ?? false,
      generation: 6
    }]
  });
  return { store, snapshot: transaction.commit(1) };
}

test("static feature matrix prunes no-opaque, unlit, textureless and optional outputs", () => {
  const empty = snapshot("empty", 0).snapshot;
  const emptyPlan = createSparseShadingCandidatePlan(empty, OFF);
  assert.equal(emptyPlan.hasOpaque, false);
  assert.deepEqual(emptyPlan.passes, []);
  assert.deepEqual(emptyPlan.resources, []);
  assert.equal(emptyPlan.memory.totalBytes, 0);

  const unlit = snapshot("unlit", 0).snapshot;
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
  const { snapshot: value } = snapshot("textured", mask, { width: 641, height: 359 });
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
      shadowSamplingEnabled: true
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
    assert.ok(frame.captureReadback !== null);
    assert.equal(frame.captureScratch.length, 1);
    const hdr = dump.resources.find((resource) => resource.name === "sparse-shading/hdr");
    assert.equal(JSON.parse(hdr.description).usage & GPUTextureUsage.COPY_SRC, GPUTextureUsage.COPY_SRC);
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
    const { snapshot: value } = snapshot("unlit", 0);
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

test("candidate source owns neither submit nor synchronous readback nor a product switch", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const relative of [
    "../src/render/pipeline/SparseShadingCandidatePipeline.ts",
    "../src/render/pipeline/SparseShadingCandidateExecutor.ts",
    "../src/render/pipeline/SparseShadingCandidateRuntime.ts",
    "../src/render/passes/SparseShadingDiagnosticsPass.ts"
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), "utf8");
    assert.doesNotMatch(source, /queue\.submit|device\.queue\.submit|mapAsync|readBuffer/u);
    assert.doesNotMatch(source, /process\.env|location\.search|URLSearchParams|legacy backend|runtime switch/iu);
  }
});
