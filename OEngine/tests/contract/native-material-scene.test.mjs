import assert from "node:assert/strict";
import test from "node:test";
import { AppearanceProgramRegistry } from "../../.test-dist/gpu/AppearanceProgramRegistry.js";
import { StandardShadeMaterial } from "../../.test-dist/material/StandardShadeMaterial.js";
import { ShadeTransparencyMode } from "../../.test-dist/material/enums.js";
import {
  AppearanceGraphBuilder,
  snapshotAppearanceTexture,
} from "../../.test-dist/material/AppearanceGraph.js";
import { lowerStandardAppearanceGraph } from "../../.test-dist/material/StandardAppearanceGraph.js";
import { compileAppearanceGraph } from "../../.test-dist/material/AppearanceGraphCompiler.js";
import { ShadeTexture } from "../../.test-dist/texture/ShadeTexture.js";
import { encodeGpuTextureRef } from "../../.test-dist/gpu/GpuTextureRefAbi.js";
import { ChangeSignal, Signal } from "../../.test-dist/core/Signal.js";

globalThis.GPUShaderStage = { COMPUTE: 4, FRAGMENT: 2, VERTEX: 1 };
globalThis.GPUBufferUsage = { STORAGE: 128, UNIFORM: 64, COPY_DST: 8, COPY_SRC: 4 };
const { GpuNativeMaterialScene } = await import("../../.test-dist/gpu/GpuNativeMaterialScene.js");
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("Surface has no alpha evaluator while coverage-only edits remain atomic and versioned", async () => {
  const f = fixture();
  const material = new StandardShadeMaterial();
  material.transparency_mode = ShadeTransparencyMode.AlphaTested;
  material.appearance_inputs.set("opacity", [0.8]);
  const graph = new AppearanceGraphBuilder();
  graph.output("baseColor", graph.constant([0.2, 0.3, 0.4]));
  graph.output("alpha", graph.input("opacity", 1, "dynamic", { low: 0, high: 1 }));
  const set = { id: 0, generation: 1, textureBanks: [] };
  const upload = f.command();
  const scene = new GpuNativeMaterialScene(
    f.graphics,
    [
      {
        materialSlot: 0,
        material,
        graph: compileAppearanceGraph(graph.build()),
        textureBindingSetId: 0,
        textureRefs: new Map(),
      },
    ],
    () => [set],
    new Map(),
    new Map(),
    upload,
    false,
    false,
  );
  await scene.ready;
  upload.onBeforeFinish.send1(upload);
  upload.onFinished.send1(upload);
  const active = scene.active;
  assert.equal(scene.hasLit, true);
  const bound = scene.bindings[0];
  assert.equal(bound.program.outputs.alpha, undefined);
  assert.equal(
    bound.program.inputs.some((input) => input.name === "opacity"),
    false,
  );
  assert.deepEqual(Object.keys(bound.coverage.program.outputs), ["alpha"]);
  material.appearance_inputs.set("opacity", [0.2]);
  scene.canPrepareFrame();
  await tick();
  assert.equal(scene.canPrepareFrame(), true);
  const changed = scene.candidate;
  assert.equal(changed.bindings[0], bound);
  assert.equal(changed.publication.entries[0].signature, active.publication.entries[0].signature);
  assert.notEqual(changed.publication.entries[0].valueRevision, active.publication.entries[0].valueRevision);
  const at = bound.coverage.program.constants.length + 2;
  assert.equal(new Float32Array(changed.publication.rasterConstants.bytes)[at], Math.fround(0.2));
  assert.equal(new Float32Array(active.publication.rasterConstants.bytes)[at], Math.fround(0.8));
  const aborted = f.command();
  scene.prepareFrame(aborted);
  aborted.onAborted.send1(aborted);
  assert.equal(scene.active, active);
  const retried = f.command();
  scene.prepareFrame(retried);
  retried.onFinished.send1(retried);
  assert.equal(scene.active, changed);
  scene.destroy();
  await tick();
  f.registry.destroy();
});
function fixture() {
  const buffers = [];
  const device = {
    lost: new Promise(() => {}),
    limits: {
      maxComputeWorkgroupSizeX: 256,
      maxComputeInvocationsPerWorkgroup: 256,
      maxBindGroups: 4,
      maxBindingsPerBindGroup: 1000,
      maxBufferSize: 1e8,
      maxStorageBufferBindingSize: 1e8,
      maxUniformBufferBindingSize: 65536,
      maxStorageBuffersPerShaderStage: 16,
      maxUniformBuffersPerShaderStage: 12,
      maxSampledTexturesPerShaderStage: 16,
      maxSamplersPerShaderStage: 16,
      maxStorageTexturesPerShaderStage: 4,
    },
    pushErrorScope() {},
    popErrorScope: async () => null,
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: (value) => value,
    createPipelineLayout: (value) => value,
    createComputePipelineAsync: async () => ({}),
    createBuffer({ size }) {
      const buffer = {
        size,
        bytes: new ArrayBuffer(size),
        destroyed: false,
        getMappedRange() {
          return this.bytes;
        },
        unmap() {},
        destroy() {
          this.destroyed = true;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
  };
  const registry = new AppearanceProgramRegistry(device);
  const samplers = new Map();
  const graphics = {
    texture_residency: { onPublicationChanged: new Signal() },
    device,
    appearance_programs: registry,
    samplers: {
      obtain(descriptor) {
        const key = JSON.stringify(descriptor);
        if (!samplers.has(key)) samplers.set(key, { descriptor });
        return samplers.get(key);
      },
    },
    render_pipelines: { prepare: async () => ({}) },
  };
  const command = () => ({
    device,
    closed: false,
    gpuDone: Promise.resolve(),
    onBeforeFinish: new ChangeSignal(),
    onFinished: new ChangeSignal(),
    onAborted: new ChangeSignal(),
  });
  return { device, registry, graphics, buffers, command };
}

test("stable native Scene keeps code/bindings; numeric edits remain atomic across abort and retry", async () => {
  const f = fixture();
  const material = new StandardShadeMaterial();
  const graph = compileAppearanceGraph(lowerStandardAppearanceGraph(material, []));
  const upload = f.command();
  const set = { id: 0, generation: 1, textureBanks: [] };
  const scene = new GpuNativeMaterialScene(
    f.graphics,
    [{ materialSlot: 3, material, graph, textureBindingSetId: 0, textureRefs: new Map() }],
    () => [set],
    new Map(),
    new Map(),
    upload,
    false,
    false,
  );
  await scene.ready;
  upload.onBeforeFinish.send1(upload);
  upload.onFinished.send1(upload);
  const active = scene.active;
  const bindings = scene.bindings[0];
  const initialAllocations = f.buffers.length;
  let snapshotCount = 0;
  const snapshot = scene.snapshot.bind(scene);
  scene.snapshot = (...args) => {
    snapshotCount++;
    return snapshot(...args);
  };
  for (let i = 0; i < 8; i++) {
    assert.equal(scene.canPrepareFrame(), true);
    assert.equal(scene.bindings[0], bindings);
    assert.equal(scene.active, active);
  }
  assert.equal(f.buffers.length, initialAllocations);
  assert.equal(snapshotCount, 0, "stable admission must not walk materials or residency");
  material.diffuse_color.r = 0.25; // Direct field edit remains supported.
  scene.canPrepareFrame();
  await tick();
  assert.equal(scene.canPrepareFrame(), true);
  const candidate = scene.candidate;
  assert.ok(candidate);
  assert.equal(snapshotCount, 1, "one direct edit builds one candidate; readiness polling is O(1)");
  assert.equal(candidate.bindings[0], bindings);
  assert.notDeepEqual(candidate.values[0], active.values[0]);
  assert.equal(scene.active, active);
  const abort = f.command();
  scene.prepareFrame(abort);
  abort.onAborted.send1(abort);
  assert.equal(scene.active, active);
  assert.equal(scene.canPrepareFrame(), true);
  assert.equal(scene.candidate, candidate);
  const retry = f.command();
  scene.prepareFrame(retry);
  retry.onFinished.send1(retry);
  assert.equal(scene.active, candidate);
  await tick();
  assert.ok(active.publication.constants.destroyed);
  assert.equal(scene.canPrepareFrame(), true);
  assert.equal(scene.candidate, null);
  material.is_unlit = true;
  scene.canPrepareFrame();
  await tick();
  assert.equal(scene.canPrepareFrame(), true);
  assert.notEqual(scene.candidate.bindings[0], bindings);
  assert.deepEqual(Object.keys(scene.candidate.bindings[0].program.outputs), ["baseColor"]);
  assert.ok(scene.candidate.routes.every((route) => route.unlit));
  assert.equal(scene.hasLit, false, "lighting follows the candidate native code");
  const unlitAbort = f.command();
  scene.prepareFrame(unlitAbort);
  unlitAbort.onAborted.send1(unlitAbort);
  assert.equal(scene.active.hasLit, true, "abort preserves committed lighting demand");
  assert.equal(scene.hasLit, false, "retry still sees the pending candidate");
  const unlit = f.command();
  scene.prepareFrame(unlit);
  unlit.onFinished.send1(unlit);
  await tick();
  assert.equal(scene.active.hasLit, false);
  set.generation++;
  f.graphics.texture_residency.onPublicationChanged.emit();
  scene.canPrepareFrame();
  await tick();
  assert.equal(scene.canPrepareFrame(), true);
  assert.notEqual(scene.candidate.bindings[0], bindings);
  const resources = f.command();
  scene.prepareFrame(resources);
  resources.onFinished.send1(resources);
  await tick();
  assert.equal(scene.canPrepareFrame(), true);
  assert.equal(scene.candidate, null);
  material.diffuse_color.r = NaN;
  assert.throws(() => scene.canPrepareFrame(), /finite|range/i);
  scene.destroy();
  assert.equal(scene.materialBindings.length, 0);
  assert.ok(f.buffers.every((buffer) => buffer.destroyed));
  f.registry.destroy();
});

test("binding reuse observes route values, physical bank identity, generation and live mip publication", () => {
  const f = fixture();
  const texture = new ShadeTexture();
  const g = new AppearanceGraphBuilder();
  const uv = g.input("uv0", 2, "surface", undefined, "uv0");
  g.output(
    "baseColor",
    g.swizzle(g.texture(snapshotAppearanceTexture(texture, "linear-rgb"), uv), [0, 1, 2]),
  );
  g.output("alpha", g.swizzle(g.texture(snapshotAppearanceTexture(texture, "linear-rgb"), uv), [3]));
  const graph = compileAppearanceGraph(g.build());
  const refs = new Map([[texture, encodeGpuTextureRef(0, 1)]]);
  const publication = { slot: 2, generation: 1, revision: 1, currentRevision: 1, currentMinimumMip: 0 };
  const set = { id: 0, generation: 1, textureBanks: [{}], bankDescriptors: [{ segment: 1 }] };
  // Exercise the actual Scene binding owner without GPU publication: compare
  // independently changed inputs and generated route constants/resources.
  const scene = Object.assign(Object.create(GpuNativeMaterialScene.prototype), {
    graphics: f.graphics,
    products: null,
    materialBindings: [],
    mipRanges: new Map([[texture, [0, 4]]]),
    texturePublications: new Map([[texture, publication]]),
  });
  const source = { graph, textureRefs: refs, material: new StandardShadeMaterial() };
  const obtain = () => scene.obtainMaterialBindings(0, source, set);
  const first = obtain();
  assert.equal(obtain(), first);
  refs.set(texture, encodeGpuTextureRef(0, 2));
  const routed = obtain();
  assert.notEqual(routed, first);
  assert.notDeepEqual(routed.program.constants, first.program.constants);
  assert.equal(routed.program.key, first.program.key);
  set.textureBanks[0] = {};
  const bank = obtain();
  assert.equal(bank.entries[0].resource, set.textureBanks[0]);
  assert.notEqual(bank, routed);
  set.generation++;
  const generation = obtain();
  assert.notEqual(generation, bank);
  assert.notEqual(generation.program.resourceRevision, bank.program.resourceRevision);
  publication.currentRevision++;
  const revision = obtain();
  assert.notEqual(revision.program.resourceRevision, generation.program.resourceRevision);
  publication.currentMinimumMip = 2;
  assert.notEqual(obtain(), revision);
  scene.mipRanges.set(texture, [1, 4]);
  const mip = obtain();
  assert.equal(obtain(), mip);
  Object.defineProperty(texture, "texture_product", {
    value: { metadata: { storageWidth: 64, storageHeight: 64, planes: [{ mips: Array(7).fill({}) }] } },
  });
  const mipAsset = obtain();
  assert.notDeepEqual(mipAsset.program.constants, mip.program.constants);
  assert.equal(obtain(), mipAsset);
  f.registry.destroy();
});
