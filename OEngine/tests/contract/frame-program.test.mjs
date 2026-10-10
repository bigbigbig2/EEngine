import assert from "node:assert/strict";
import test from "node:test";
import { buildFrameProgram, FrameProgramCache } from "../../.test-dist/render/program/FrameProgram.js";
import { lowerFrameProgram } from "../../.test-dist/render/program/FrameProgramLowering.js";
import { assertFrameProgramBindings } from "../../.test-dist/render/program/FrameProgramBindings.js";
import { HzbHistoryState } from "../../.test-dist/render/HzbHistory.js";
import {
  FrameGraph,
  FrameGraphBindingLayout,
  FrameGraphContext,
} from "../../.test-dist/framegraph/FrameGraph.js";
import { BloomPass } from "../../.test-dist/render/passes/BloomPass.js";

const scene = {
  kind: "scene",
  intent: "present",
  viewFamily: "main",
  outputWidth: 1280,
  outputHeight: 720,
  outputFormat: "bgra8unorm",
  capabilityProfile: "device-1",
  internalWidth: 640,
  internalHeight: 360,
  virtualGeometry: true,
  virtualBankCount: 2,
  previousHzb: true,
  currentHzbLateRecheck: false,
  activeSets: [0],
  hasLit: true,
  physicalEnvironment: true,
};

test("Bloom upsamples each mip at its high input extent", () => {
  const previousUsage = globalThis.GPUTextureUsage;
  const previousStage = globalThis.GPUShaderStage;
  globalThis.GPUTextureUsage = { STORAGE_BINDING: 1, TEXTURE_BINDING: 2 };
  globalThis.GPUShaderStage = { COMPUTE: 4 };
  try {
    const device = {
      createSampler: () => ({}),
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createComputePipeline: () => ({}),
    };
    const graph = new FrameGraph("Bloom extents");
    const sceneColor = graph.create_resource("test/scene", {
      kind: "transient_texture",
      width: 640,
      height: 360,
      format: "rgba16float",
      domain: "output-full",
      usage: 3,
    });
    const preExposure = graph.import_resource("test/pre-exposure", { kind: "imported" }, {});
    new BloomPass(device).addToGraph(graph, { scene: sceneColor, preExposure, width: 640, height: 360 });
    for (let level = 0; level < 4; level++) {
      const node = Array.from({ length: graph.resourceNodeCount }, (_, id) => graph.getResourceNode(id)).find(
        (node) => node.name === `Bloom/up${level}`,
      );
      assert.ok(node);
      const descriptor = graph.getDescriptor(node.id);
      assert.equal(descriptor.width, 640 >> (level + 1));
      assert.equal(descriptor.height, 360 >> (level + 1));
    }
  } finally {
    globalThis.GPUTextureUsage = previousUsage;
    globalThis.GPUShaderStage = previousStage;
  }
});

test("Frame Program closes the current scene product demand with a structural key", () => {
  const first = buildFrameProgram(scene);
  const sameShape = buildFrameProgram({ ...scene, activeSets: [0] });
  assert.equal(first.key, sameShape.key);
  assert.equal(Object.hasOwn(first.request, "activeExceptionLanes"), false);
  for (const product of [
    "visibility",
    "depth",
    "hzb",
    "meshlet-work",
    "local-light-work",
    "surface-radiance",
    "temporal-motion",
    "sky-radiance",
    "aerial-radiance",
    "reconstructed-color",
    "swapchain",
  ])
    assert.ok(first.products.includes(product), product);
  assert.equal(first.directLighting, true);
  assert.deepEqual(first.facts.find((fact) => fact.product === "local-light-work").consumers, ["surface"]);
  assert.deepEqual(first.facts.find((fact) => fact.product === "hzb").consumers, ["visibility"]);
  assert.notEqual(first.key, buildFrameProgram({ ...scene, internalWidth: 800 }).key);
  const noEnvironment = buildFrameProgram({ ...scene, physicalEnvironment: false });
  assert.ok(!noEnvironment.products.includes("sky-radiance"));
  assert.ok(!noEnvironment.products.includes("aerial-radiance"));
  const unlit = buildFrameProgram({ ...scene, hasLit: false });
  assert.ok(!unlit.products.includes("local-light-work"));
  assert.deepEqual(first.facts.find((fact) => fact.product === "temporal-motion").consumers, [
    "temporal-facts",
    "fsr3",
  ]);
  assert.ok(!first.products.includes("shading-work"));
  assert.deepEqual(first.facts.find((fact) => fact.product === "visibility").extent, [640, 360]);
  assert.equal(first.facts.find((fact) => fact.product === "temporal-motion").format, "rg32float");
});

test("local-light occupancy depends on raw winner/depth and cannot force Geometry HZB", () => {
  const program = buildFrameProgram({ ...scene, previousHzb: false, currentHzbLateRecheck: false });
  assert.equal(program.buildHzb, false);
  assert.ok(!program.products.includes("hzb"));
  assert.ok(program.products.includes("local-light-work"));
  assert.ok(program.bindingRoles.includes("local-light-work"));
});

test("lit scalar AO closes a same-frame producer while off and unlit omit it", () => {
  const high = buildFrameProgram({ ...scene, aoProfile: "scalar-high" });
  const off = buildFrameProgram({ ...scene, aoProfile: "off" });
  assert.ok(high.stages.includes("xe-gtao"));
  assert.ok(high.products.includes("indirect-visibility"));
  assert.deepEqual(high.facts.find((fact) => fact.product === "indirect-visibility").consumers, ["surface"]);
  assert.ok(high.stages.indexOf("xe-gtao") < high.stages.indexOf("surface"));
  assert.ok(!off.stages.includes("xe-gtao"));
  assert.ok(!off.products.includes("indirect-visibility"));
  assert.notEqual(high.key, off.key);
  assert.throws(
    () => buildFrameProgram({ ...scene, hasLit: false, aoProfile: "scalar-high" }),
    /lit Surface consumer/u,
  );
  const unlit = buildFrameProgram({ ...scene, hasLit: false, aoProfile: "off" });
  assert.ok(!unlit.stages.includes("xe-gtao"));
});

test("directional shadows demand independent Geometry only for an enabled lit consumer", () => {
  for (const shadowProfile of ["vsm-directional-high", "vsm-directional-bounded"]) {
    const plan = buildFrameProgram({ ...scene, shadowProfile });
    assert.ok(plan.stages.includes("vsm"));
    assert.deepEqual(plan.facts.find((fact) => fact.product === "shadow-geometry-work").consumers, ["vsm"]);
    assert.ok(plan.products.includes("shadow-allocation"));
  }
  for (const shadowProfile of ["off", "shadow-disabled"]) {
    const plan = buildFrameProgram({ ...scene, shadowProfile });
    assert.ok(!plan.stages.includes("vsm"));
    for (const product of [
      "shadow-geometry-work",
      "shadow-visibility",
      "shadow-demand",
      "shadow-allocation",
    ]) {
      assert.ok(!plan.products.includes(product), product);
    }
  }
  assert.throws(
    () => buildFrameProgram({ ...scene, hasLit: false, shadowProfile: "vsm-directional-high" }),
    /lit Surface consumer/,
  );
  const unlit = buildFrameProgram({ ...scene, hasLit: false, shadowProfile: "off" });
  assert.ok(!unlit.products.includes("shadow-geometry-work"));
});

test("Program cache reuses the finite set shape and evicts by LRU", () => {
  const cache = new FrameProgramCache(2);
  const first = cache.getOrCreate(scene);
  assert.equal(cache.getOrCreate({ ...scene, activeSets: [0] }), first);
  const second = cache.getOrCreate({ ...scene, outputWidth: 1920 });
  assert.notEqual(second, first);
  cache.getOrCreate(scene); // first becomes most recently used
  cache.getOrCreate({ ...scene, internalWidth: 800 });
  assert.equal(cache.getOrCreate(scene), first);
  assert.notEqual(cache.getOrCreate({ ...scene, outputWidth: 1920 }), second);
  cache.clear();
  assert.notEqual(cache.getOrCreate(scene), first);
});

test("Frame Program lowering wires owner resource contracts through Present", () => {
  globalThis.GPUTextureUsage ??= { RENDER_ATTACHMENT: 1, STORAGE_BINDING: 2, TEXTURE_BINDING: 4 };
  const request = {
    ...scene,
    virtualGeometry: false,
    virtualBankCount: 0,
    previousHzb: false,
    activeSets: [0],
    hasLit: false,
    physicalEnvironment: false,
    capabilityProfile: "7",
  };
  const plan = buildFrameProgram(request);
  const resource = {};
  let surfaceInstances, temporalInstances, producedFrameInstances;
  const runtime = {
    virtualGeometry: null,
    activeShadingSummary: {
      binRefCounts: Array(64).fill(0),
      standardSetRefCounts: new Uint32Array([1]),
      coatedSetRefCounts: new Uint32Array([0]),
    },
    nativeMaterials: { hasLit: false, publication: { versions: resource, materialSlotCount: 16 } },
    materialResources: {
      materialRecords: resource,
      textureRouteRecords: resource,
      surfaceResidencyVersions: resource,
      localVariation: resource,
      bindingSets: [
        {
          id: 0,
          textureBankMask: 0xffff,
          textureBanks: Array(16).fill(resource),
          bankDescriptors: Array.from({ length: 16 }, (_, bindingSlot) => ({ bindingSlot })),
        },
      ],
    },
    counterSink: resource,
  };
  runtime.activeShadingSummary.binRefCounts[0] = 1;
  const job = {
    runtime,
    width: 640,
    height: 360,
    assets: {
      sparseShading: {
        assetMetadataHeap: resource,
        vertexPayloadHeap: resource,
      },
    },
    scene: { instances: resource },
    prepared: {
      workSet: {
        meshletWorkCandidate: { queue: resource },
        frameInstances: { records: resource },
        frameVertices: { attributes: resource },
        frameGeometry: {
          buffer: resource,
          layout: {
            header: { offset: 0 },
            sourceDirectory: { offset: 256 },
            filteredDirectory: { offset: 512 },
          },
        },
      },
      currentHzbLateRecheck: null,
    },
  };
  const hzb = {
    getCurrentTexture() {
      throw new Error("feature-off HZB was accessed");
    },
  };
  const fsr3 = {
    assertPreparedFrame() {},
    addToGraph(graph, input, bind) {
      const history = graph.import_resource(
        "test/FSR3 history",
        { kind: "imported" },
        bind("history", (runtime) => runtime.history),
      );
      const pass = graph.add("test/FSR3", {}, () => {});
      pass.read(input.color);
      pass.read(input.depth);
      pass.read(input.motion);
      pass.read(input.reactiveMask);
      pass.read(input.validityMask);
      pass.read(history);
      pass.read(input.preExposure);
      pass.read(input.priorExposure);
      return pass.create("test/reconstructed", {
        kind: "transient_texture",
        width: 1280,
        height: 720,
        format: "rgba16float",
        domain: "output-full",
        usage: 7,
      });
    },
    history: resource,
  };
  const camera = {};
  const temporalFacts = {
    assertPreparedFrame() {},
    addToGraph(graph, input) {
      temporalInstances = input.instances;
      const pass = graph.add("test/Temporal Facts", {}, () => {});
      for (const value of [
        input.visibility,
        input.depth,
        input.opaqueReactive,
        input.materialVersions,
        input.meshletWork,
        input.instances,
        input.currentCamera,
        input.previousCamera,
      ])
        pass.read(value);
      return {
        motion: pass.create("test/temporal-motion", {
          kind: "transient_texture",
          width: 640,
          height: 360,
          format: "rg32float",
          domain: "internal-full",
          usage: 7,
        }),
        mask: pass.create("test/temporal-mask", {
          kind: "transient_texture",
          width: 640,
          height: 360,
          format: "rgba8unorm",
          domain: "internal-full",
          usage: 7,
        }),
        identity: pass.create("test/temporal-identity", {
          kind: "transient_texture",
          width: 640,
          height: 360,
          format: "rgba32uint",
          domain: "internal-full",
          usage: 7,
        }),
      };
    },
  };
  const bindings = {
    kind: "scene",
    deviceEpoch: 7,
    job,
    runtime,
    camera,
    hzb,
    depth: { width: 640, height: 360, format: "depth32float" },
    view: {
      camera: { camera },
      hierarchical_z_buffer: hzb,
      width: 640,
      height: 360,
      gpu_camera_state: { buffer: resource },
      gpu_previous_camera_state: { buffer: resource },
      frame_index: 1,
    },
    swapchain: resource,
    preExposure: { multiplier: 1 },
    localLightWork: null,
    localLightCounters: resource,
    fsr3,
    temporalFacts,
    vsm: null,
    vsmFrame: null,
    vsmGeneration: { deviceEpoch: 7, generation: 1 },
    radiometry: { readBuffer: () => resource, writeBuffer: () => resource },
    environment: null,
  };
  const owners = {
    visibility: {
      addToGraph(graph, _job, input) {
        const pass = graph.add("test/Visibility", {}, () => {});
        pass.read(input.meshletWorkRecords);
        const depth = pass.write(input.depth);
        const meshletWork = pass.write(input.meshletWorkRecords);
        producedFrameInstances = pass.write(input.frameInstances);
        const frameGeometry = pass.write(input.frameGeometry);
        const visibilityKey = pass.create("test/VisibilityKey", {
          kind: "transient_texture",
          width: 640,
          height: 360,
          format: "r32uint",
          domain: "internal-full",
          usage: 7,
        });
        return {
          counters: pass.write(input.counters),
          frame: {
            visibilityKey,
            depth,
            frameInstances: producedFrameInstances,
            frameGeometry,
            meshletWork: { records: meshletWork },
            domain: { width: 640, height: 360 },
          },
        };
      },
      addCurrentHzbLateRecheckToGraph(graph, _job, input) {
        const pass = graph.add("test/Late HZB recheck", {}, () => {});
        pass.read(input.currentHzb);
        pass.read(input.sourceMeshletWork);
        const records = pass.write(input.sourceMeshletWork);
        const visibilityKey = pass.write(input.visibilityKey);
        const depth = pass.write(input.depth);
        return {
          counters: input.counters,
          frame: {
            ...input.sourceFrame,
            visibilityKey,
            depth,
            meshletWork: { records },
            domain: input.sourceFrame.domain,
          },
        };
      },
    },
    visibilityCounters: { addToGraph() {} },
    surface: { neutralLightingEntries: [], prepareFrameNow() {}, encode() {} },
    radiometry: {
      importPreviousExposure(_graph, bind) {
        return bind("previous-exposure", (runtime) => runtime.readBuffer());
      },
      importPriorExposure(_graph, bind) {
        return bind("prior-exposure", (runtime) => runtime.writeBuffer());
      },
      addToGraph(graph, input, bind) {
        const pass = graph.add("test/Radiometry", {}, () => {});
        pass.read(input.scene);
        pass.read(input.previousExposure);
        const adaptedExposure = pass.write(input.priorExposure);
        return { previousExposure: input.previousExposure, adaptedExposure };
      },
    },
    bloom: {
      addToGraph(graph, input) {
        const pass = graph.add("test/Bloom", {}, () => {});
        pass.read(input.scene);
        pass.read(input.preExposure);
        return pass.create("test/bloom", {
          kind: "transient_texture",
          width: 1280,
          height: 720,
          format: "rgba16float",
          domain: "output-full",
          usage: 7,
        });
      },
    },
    present: {
      addToGraph(graph, color, swapchain, exposure, preExposure) {
        const pass = graph.add("test/Present", {}, () => {});
        pass.read(color);
        pass.read(exposure);
        pass.read(preExposure);
        pass.write(swapchain);
        pass.make_side_effect();
        return swapchain;
      },
    },
    temporalFacts,
    sky: null,
    aerial: null,
    localLightWork: null,
  };
  assertFrameProgramBindings(plan, bindings);
  runtime.activeShadingSummary.binRefCounts[4] = 1;
  assertFrameProgramBindings(plan, bindings); // Retired Scene code class cannot override native demand.
  runtime.nativeMaterials.hasLit = true;
  assert.throws(() => assertFrameProgramBindings(plan, bindings), /lighting shape/);
  runtime.nativeMaterials.hasLit = false;
  assert.throws(() => assertFrameProgramBindings(plan, { ...bindings, deviceEpoch: 8 }), /device epoch/);
  assert.throws(
    () => assertFrameProgramBindings(plan, { ...bindings, depth: { ...bindings.depth, width: 800 } }),
    /depth descriptor/,
  );
  assert.throws(
    () =>
      assertFrameProgramBindings(plan, { ...bindings, view: { ...bindings.view, camera: { camera: {} } } }),
    /View publication/,
  );
  const texturedRuntime = {
    ...runtime,
    activeShadingSummary: {
      binRefCounts: Array(64).fill(0),
      standardSetRefCounts: new Uint32Array([1]),
      coatedSetRefCounts: new Uint32Array([0]),
    },
  };
  texturedRuntime.activeShadingSummary.binRefCounts[2] = 1;
  const texturedPlan = buildFrameProgram(request);
  const texturedBindings = {
    ...bindings,
    runtime: texturedRuntime,
    job: { ...job, runtime: texturedRuntime },
  };
  assertFrameProgramBindings(texturedPlan, texturedBindings);
  const missingBankRuntime = {
    ...texturedRuntime,
    materialResources: {
      ...texturedRuntime.materialResources,
      bindingSets: [
        { id: 0, textureBankMask: 0xffff, textureBanks: [null], bankDescriptors: [{ bindingSlot: 0 }] },
      ],
    },
  };
  assert.throws(
    () =>
      assertFrameProgramBindings(texturedPlan, {
        ...texturedBindings,
        runtime: missingBankRuntime,
        job: { ...texturedBindings.job, runtime: missingBankRuntime },
      }),
    /texture bank 0:0 publication/,
  );
  const currentHzb = { width: 320, height: 180, format: "rg16float" };
  const previousHzb = { width: 320, height: 180, format: "rg16float" };
  const validHzb = {
    width: 320,
    height: 180,
    getCurrentTexture: () => currentHzb,
    getPreviousTexture: () => previousHzb,
  };
  const historyPlan = buildFrameProgram({ ...request, previousHzb: true });
  const historyBindings = {
    ...bindings,
    hzb: validHzb,
    view: { ...bindings.view, hierarchical_z_buffer: validHzb },
  };
  assertFrameProgramBindings(historyPlan, historyBindings);
  const aliasedHzb = { ...validHzb, getPreviousTexture: () => currentHzb };
  assert.throws(
    () =>
      assertFrameProgramBindings(historyPlan, {
        ...historyBindings,
        hzb: aliasedHzb,
        view: { ...historyBindings.view, hierarchical_z_buffer: aliasedHzb },
      }),
    /aliases current/,
  );
  const compiled = lowerFrameProgram(plan, bindings, owners);
  const dump = compiled.dump();
  assert.deepEqual(
    dump.executablePassOrder.map((id) => dump.passes[id].name),
    [
      "test/Visibility",
      "SurfaceV4/native opaque",
      "test/Temporal Facts",
      "test/FSR3",
      "test/Radiometry",
      "test/Bloom",
      "test/Present",
    ],
  );
  const pass = (name) => dump.passes.find((entry) => entry.name === name);
  assert.ok(pass("SurfaceV4/native opaque").reads.includes(producedFrameInstances));
  assert.notEqual(producedFrameInstances, temporalInstances);
  for (const [producer, consumer] of [
    ["test/Visibility", "SurfaceV4/native opaque"],
    ["SurfaceV4/native opaque", "test/Temporal Facts"],
    ["test/Temporal Facts", "test/FSR3"],
    ["test/FSR3", "test/Radiometry"],
    ["test/Bloom", "test/Present"],
  ]) {
    assert.ok(pass(consumer).dependencies.includes(pass(producer).id), `${producer} -> ${consumer}`);
  }
  assert.ok(
    !dump.resources.some(
      (entry) =>
        entry.name.includes("HZB") ||
        entry.name.startsWith("physical-environment") ||
        entry.name.startsWith("Lighting/"),
    ),
  );
  assert.equal(dump.resources.find((entry) => entry.name === "test/FSR3 history").binding, "fsr3/history");
  const lut = { transmittance: {}, scattering: {}, higherOrderScattering: {}, irradiance: {} };
  const environment = {
    parameters: { size: 64 },
    luts: { views: lut },
    ibl: { views: { diffuse: {}, specular: {}, dfg: {} } },
  };
  const environmentPlan = buildFrameProgram({ ...request, physicalEnvironment: true });
  const environmentOwners = {
    ...owners,
    sky: {
      addToGraph(graph, input) {
        const pass = graph.add("test/Sky", {}, () => {});
        pass.read(input.hdr);
        pass.read(input.depth);
        pass.read(input.transmittance);
        pass.read(input.scattering);
        pass.read(input.higherOrder);
        pass.read(input.environment);
        return pass.write(input.hdr);
      },
    },
    aerial: {
      addToGraph(graph, input) {
        const pass = graph.add("test/Aerial", {}, () => {});
        pass.read(input.scene);
        pass.read(input.depth);
        pass.read(input.transmittance);
        pass.read(input.scattering);
        pass.read(input.higherOrder);
        pass.read(input.environment);
        return pass.create("test/aerial", {
          kind: "transient_texture",
          width: 640,
          height: 360,
          format: "rgba16float",
          domain: "internal-full",
          usage: 7,
        });
      },
    },
  };
  const environmentBindings = { ...bindings, environment };
  assertFrameProgramBindings(environmentPlan, environmentBindings);
  const withEnvironment = lowerFrameProgram(environmentPlan, environmentBindings, environmentOwners).dump();
  assert.deepEqual(
    withEnvironment.executablePassOrder.map((id) => withEnvironment.passes[id].name),
    [
      "test/Visibility",
      "SurfaceV4/native opaque",
      "test/Temporal Facts",
      "test/Sky",
      "test/Aerial",
      "test/FSR3",
      "test/Radiometry",
      "test/Bloom",
      "test/Present",
    ],
  );
  assert.equal(
    withEnvironment.resources.find((entry) => entry.name === "physical-environment-transmittance").binding,
    "physical-environment-transmittance",
  );
  const latePlan = buildFrameProgram({ ...request, currentHzbLateRecheck: true });
  const lateJob = {
    ...job,
    prepared: { ...job.prepared, currentHzbLateRecheck: { queue: resource, drawIndirect: resource } },
  };
  const lateBindings = { ...historyBindings, job: lateJob };
  assertFrameProgramBindings(latePlan, lateBindings);
  const lateDump = lowerFrameProgram(latePlan, lateBindings, owners).dump();
  const lateNames = lateDump.executablePassOrder.map((id) => lateDump.passes[id].name);
  assert.ok(lateNames.indexOf("Visibility/build HZB") > lateNames.indexOf("test/Visibility"));
  assert.ok(lateNames.indexOf("test/Late HZB recheck") > lateNames.indexOf("Visibility/build HZB"));
  assert.ok(lateNames.indexOf("SurfaceV4/native opaque") > lateNames.indexOf("test/Late HZB recheck"));
  assert.ok(
    lateDump.passes
      .find((entry) => entry.name === "SurfaceV4/native opaque")
      .dependencies.includes(lateDump.passes.find((entry) => entry.name === "test/Late HZB recheck").id),
  );
  const empty = lowerFrameProgram(
    buildFrameProgram({
      kind: "empty",
      intent: "present",
      viewFamily: "main",
      outputWidth: 1280,
      outputHeight: 720,
      outputFormat: "bgra8unorm",
      capabilityProfile: "7",
    }),
    { kind: "empty", deviceEpoch: 7, swapchain: resource },
  ).dump();
  assert.deepEqual(
    empty.executablePassOrder.map((id) => empty.passes[id].name),
    ["Renderer/empty present"],
  );
});

test("compiled graph resolves the environment role from each frame binding", () => {
  const initial = { environment: { lut: { generation: 1 } } };
  const layout = new FrameGraphBindingLayout();
  const graph = new FrameGraph("environment-generation-binding");
  const lut = graph.import_resource(
    "environment-lut",
    { kind: "imported", label: "LUT" },
    layout.slot("environment-lut", initial, (bindings) => bindings.environment.lut),
  );
  const seen = [];
  const consumer = graph.add("consume-current-lut", {}, (_data, resources) => {
    seen.push(resources.get(lut).generation);
  });
  consumer.read(lut);
  consumer.make_side_effect();
  const compiled = graph.compile();
  compiled.execute(new FrameGraphContext(), initial);
  compiled.execute(new FrameGraphContext(), { environment: { lut: { generation: 2 } } });
  assert.deepEqual(seen, [1, 2]);
});

test("HZB history publishes only a built submitted frame and invalidates on abort or cut", () => {
  const history = new HzbHistoryState();
  const revision = { width: 320, height: 180, camera: 1, renderScale: 1, feature: 1, format: 2 };
  history.beginFrame(0, revision);
  history.markBuilt();
  assert.equal(history.commit(0), true);
  assert.equal(history.valid, true);
  const submitted = history.committedTextureIndex;
  history.beginFrame(1, revision);
  history.markBuilt();
  history.invalidate("explicit"); // FrameCoordinator abort leaves the old index unpublished.
  assert.equal(history.valid, false);
  assert.equal(history.committedTextureIndex, submitted);
  history.beginFrame(2, revision);
  history.markBuilt();
  history.commit(2);
  assert.equal(history.valid, true);
  history.beginFrame(3, { ...revision, camera: 2 });
  assert.equal(history.valid, false);
  assert.equal(history.lastInvalidationReason, "camera-cut");
  const recovered = new HzbHistoryState();
  assert.equal(recovered.valid, false);
});
