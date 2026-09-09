import assert from "node:assert/strict";
import test from "node:test";

installWebGpuConstants();

const [
  { FrameProfiler },
  { FrameCoordinator },
  { ResourceAccounting },
  { GPUSceneContext },
  { GpuPackedSceneRegistry },
  { TextureResidency },
  {
    decodeGpuTextureRef,
    encodeGpuTextureRef,
    GPU_TEXTURE_REF_INVALID,
    GPU_TEXTURE_BANK_MAX_CAPACITIES
  },
  { StandardShadeMaterial },
  { ShadeTransparencyMode },
  { ShadeTexture, ShadeImage }
] = await Promise.all([
  import("../.test-dist/debug/FrameProfiler.js"),
  import("../.test-dist/render/FrameCoordinator.js"),
  import("../.test-dist/debug/profiling/ResourceAccounting.js"),
  import("../.test-dist/gpu/GPUSceneContext.js"),
  import("../.test-dist/gpu/GpuPackedSceneRegistry.js"),
  import("../.test-dist/gpu/TextureResidency.js"),
  import("../.test-dist/gpu/GpuTextureRefAbi.js"),
  import("../.test-dist/material/StandardShadeMaterial.js"),
  import("../.test-dist/material/enums.js"),
  import("../.test-dist/texture/ShadeTexture.js")
]);

const { resolveFrameSceneOwners } = await import(
  "../.test-dist/render/pipeline/SceneFrameBindings.js"
);

test("FrameCoordinator owns one close path for each render tick", () => {
  const commands = [];
  const coordinator = new FrameCoordinator({}, (_graphics, label) => {
    const command = new FakeCommand(label);
    commands.push(command);
    return command;
  });
  const frame = coordinator.beginFrame(4, "main");
  assert.throws(() => coordinator.beginFrame(5, "main"), /is still active/);

  const evidence = coordinator.submitFrame(frame);
  assert.deepEqual(evidence, {
    frameIndex: 4,
    submitLabel: "main",
    closed: true,
    submitted: true
  });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].submitted, true);

  const aborted = coordinator.beginFrame(5, "main");
  coordinator.abortFrame(aborted, new Error("injected frame failure"));
  assert.equal(commands.length, 2);
  assert.equal(commands[1].submitted, false);
  assert.equal(commands[1].closed, true);
});

test("GPU Scene defers its legacy material owner until a legacy consumer requests it", () => {
  const legacyRegistry = { metadata_table: {} };
  let requests = 0;
  const sceneContext = Object.create(GPUSceneContext.prototype);
  Object.defineProperty(sceneContext, "obtainSharedMaterials", {
    value: () => {
      requests++;
      return legacyRegistry;
    }
  });

  assert.equal(requests, 0);
  assert.equal(sceneContext.materials, legacyRegistry);
  assert.equal(requests, 1);
  assert.equal(sceneContext.material_metadata, legacyRegistry.metadata_table);
  assert.equal(requests, 2);
});

test("Packed frame resolves shared environment without obtaining legacy geometry", () => {
  const scene = {};
  const environment = {};
  const runtime = {};
  let environmentObtains = 0;
  let legacyObtains = 0;
  const owners = resolveFrameSceneOwners(
    scene,
    { runtime: (candidate) => candidate === scene ? runtime : null },
    {
      obtain(candidate) {
        assert.equal(candidate, scene);
        environmentObtains++;
        return environment;
      }
    },
    {
      obtain() {
        legacyObtains++;
        return {};
      }
    }
  );

  assert.equal(owners.environment, environment);
  assert.deepEqual(owners.geometry, { kind: "packed", runtime });
  assert.equal(environmentObtains, 1);
  assert.equal(legacyObtains, 0);
});

test("Legacy frame publishes exactly one legacy geometry source", () => {
  const scene = {};
  const environment = {};
  const legacy = {};
  let legacyObtains = 0;
  const owners = resolveFrameSceneOwners(
    scene,
    { runtime: () => null },
    { obtain: () => environment },
    {
      obtain(candidate) {
        assert.equal(candidate, scene);
        legacyObtains++;
        return legacy;
      }
    }
  );

  assert.equal(owners.environment, environment);
  assert.deepEqual(owners.geometry, { kind: "legacy", context: legacy });
  assert.equal(legacyObtains, 1);
});

test("Packed registry publishes stage and release only when their command commits", async () => {
  const fixture = createPackedRegistryFixture();
  const command = new FakeCommand("packed-stage");
  const handle = fixture.registry.stage(
    fixture.scene,
    fixture.manifest,
    fixture.assetHandles,
    command
  );

  assert.equal(fixture.registry.runtime(fixture.scene), null);
  assert.equal(fixture.registry.evidence().sceneCount, 0);
  command.finish();

  const runtime = fixture.registry.runtime(fixture.scene);
  assert.equal(runtime?.handle, handle);
  assert.equal(fixture.registry.evidence().sceneCount, 1);
  assert.equal(fixture.registry.evidence().instanceCount, 1);
  assert.equal(fixture.calls.legacyMaterialObtains, 0);
  assert.deepEqual(fixture.calls.stages, ["texture", "material", "instance"]);

  const stable = new FakeCommand("packed-stable-frame");
  assert.equal(fixture.registry.encodePendingPatch(fixture.scene, stable), null);
  stable.finish();
  assert.equal(fixture.registry.evidence().sceneCount, 1);
  assert.equal(fixture.registry.evidence().privateSubmitCount, 0);

  const release = new FakeCommand("packed-release");
  assert.deepEqual(fixture.registry.release(fixture.scene, release), fixture.assetHandles);
  assert.equal(fixture.registry.runtime(fixture.scene), runtime);
  release.finish();
  await settlePromises();

  assert.equal(fixture.registry.runtime(fixture.scene), null);
  assert.equal(fixture.registry.evidence().sceneCount, 0);
  assert.deepEqual(fixture.calls.releases, ["material", "texture", "instance"]);
  assert.equal(runtime.counterSink.destroyed, true);
});

test("Packed registry abort leaves no published scene and release abort preserves ownership", () => {
  const fixture = createPackedRegistryFixture();
  const abortedStage = new FakeCommand("packed-stage-abort");
  fixture.registry.stage(
    fixture.scene,
    fixture.manifest,
    fixture.assetHandles,
    abortedStage
  );
  abortedStage.abort(new Error("injected stage failure"));

  assert.equal(fixture.registry.runtime(fixture.scene), null);
  assert.equal(fixture.registry.evidence().sceneCount, 0);
  assert.equal(fixture.buffers.every((buffer) => buffer.destroyed), true);

  const committedStage = new FakeCommand("packed-stage-commit");
  fixture.registry.stage(
    fixture.scene,
    fixture.manifest,
    fixture.assetHandles,
    committedStage
  );
  committedStage.finish();

  const abortedRelease = new FakeCommand("packed-release-abort");
  fixture.registry.release(fixture.scene, abortedRelease);
  abortedRelease.abort(new Error("injected release failure"));
  assert.notEqual(fixture.registry.runtime(fixture.scene), null);

  const retry = new FakeCommand("packed-release-retry");
  fixture.registry.release(fixture.scene, retry);
  retry.finish();
  assert.equal(fixture.registry.runtime(fixture.scene), null);
});

test("Packed material patch commits classification and restores the queued patch on abort", () => {
  const fixture = createPackedRegistryFixture();
  const transparent = new StandardShadeMaterial();
  transparent.name = "packed-transparent-material";
  transparent.transparency_mode = ShadeTransparencyMode.Transparent;
  fixture.manifest.source.materials.push(transparent);

  const stage = new FakeCommand("packed-material-patch-stage");
  fixture.registry.stage(
    fixture.scene,
    fixture.manifest,
    fixture.assetHandles,
    stage
  );
  stage.finish();
  assert.equal(fixture.registry.transparentInstanceCount(fixture.scene), 0);

  fixture.registry.queuePatch(fixture.scene, {
    frameId: 11,
    materials: {
      indices: new Uint32Array([0]),
      materialIndices: new Uint32Array([1])
    }
  });
  const aborted = new FakeCommand("packed-material-patch-abort");
  const abortedResult = fixture.registry.encodePendingPatch(fixture.scene, aborted);
  assert.equal(abortedResult?.patchedMaterials, 1);
  assert.deepEqual([...fixture.calls.patches[0].materials.materialHandles], [8]);
  assert.equal(fixture.registry.transparentInstanceCount(fixture.scene), 1);
  aborted.abort(new Error("injected material patch failure"));
  assert.equal(fixture.registry.transparentInstanceCount(fixture.scene), 0);

  const retry = new FakeCommand("packed-material-patch-retry");
  const committedResult = fixture.registry.encodePendingPatch(fixture.scene, retry);
  assert.equal(committedResult?.patchedMaterials, 1);
  retry.finish();
  assert.equal(fixture.registry.transparentInstanceCount(fixture.scene), 1);
  assert.equal(fixture.calls.patches.length, 2);
});

test("Texture residency rolls back failed commands and reuses a released base layer", async () => {
  const fixture = createTextureResidencyFixture();
  const residency = new TextureResidency(fixture.graphics, 4096);
  const firstTexture = createTexture(128, "first");
  const firstMaterial = createTexturedMaterial(firstTexture, "first-material");
  const aborted = new FakeCommand("texture-stage-abort");
  residency.stage([firstMaterial], aborted);
  aborted.abort(new Error("injected texture failure"));

  assert.equal(residency.evidence().residentTextureCount, 0);
  assert.equal(residency.evidence().banks[0].freeLayerCount, 63);

  const committed = new FakeCommand("texture-stage-commit");
  const firstStage = residency.stage([firstMaterial], committed);
  committed.finish();
  const firstRef = firstStage.textureRefs.get(firstTexture);
  assert.equal(residency.evidence().residentTextureCount, 1);

  const release = new FakeCommand("texture-release");
  residency.release([firstMaterial], release);
  release.finish();
  await settlePromises();
  assert.equal(residency.evidence().residentTextureCount, 0);
  assert.equal(residency.evidence().banks[0].freeLayerCount, 63);

  const secondTexture = createTexture(128, "second");
  const secondMaterial = createTexturedMaterial(secondTexture, "second-material");
  const reused = new FakeCommand("texture-stage-reuse");
  const secondStage = residency.stage([secondMaterial], reused);
  reused.finish();
  assert.equal(secondStage.textureRefs.get(secondTexture), firstRef);

  residency.destroy();
});

test("Texture residency enforces its declared base capacity without partial mutation", () => {
  const fixture = createTextureResidencyFixture();
  const residency = new TextureResidency(fixture.graphics, 4096);
  const materials = Array.from({ length: 63 }, (_, index) =>
    createTexturedMaterial(createTexture(64, `base-${index}`), `base-material-${index}`)
  );
  const full = new FakeCommand("texture-capacity-fill");
  residency.stage(materials, full);
  full.finish();

  const before = residency.evidence();
  assert.equal(before.residentTextureCount, 63);
  assert.equal(before.banks[0].freeLayerCount, 0);

  const overflow = new FakeCommand("texture-capacity-overflow");
  assert.throws(
    () => residency.stage([
      createTexturedMaterial(createTexture(64, "overflow"), "overflow-material")
    ], overflow),
    /requires 128 layers but policy\/device permits 64/
  );
  assert.deepEqual(residency.evidence(), before);
  residency.destroy();
});

test("Texture residency accepts 512 -> 2048 and the reverse independent of release order", async () => {
  const smallThenLarge = await runReleasedHighTextureSequence([512, 2048]);
  const largeThenSmall = await runReleasedHighTextureSequence([2048, 512]);

  assert.deepEqual(smallThenLarge, {
    firstSize: 512,
    secondSize: 2048,
    secondAccepted: true,
    secondBankClass: 3
  });
  assert.deepEqual(largeThenSmall, {
    firstSize: 2048,
    secondSize: 512,
    secondAccepted: true,
    secondBankClass: 1
  });
});

test("TextureRef CPU ABI explicitly rejects invalid version, bank, and layer values", () => {
  assert.deepEqual(decodeGpuTextureRef(encodeGpuTextureRef(4, 1)), {
    version: 1,
    bankClass: 4,
    layer: 1
  });
  assert.equal(decodeGpuTextureRef(GPU_TEXTURE_REF_INVALID), null);
  assert.equal(decodeGpuTextureRef(0x00000001), null);
  assert.equal(decodeGpuTextureRef(0x1f000001), null);
  assert.equal(decodeGpuTextureRef(0x10000000), null);
});

test("Texture residency fills and rejects overflow in every bounded bank without mutation", () => {
  for (const [bankClass, size] of [512, 1024, 2048, 4096].entries()) {
    const actualBankClass = bankClass + 1;
    const fixture = createTextureResidencyFixture();
    const residency = new TextureResidency(fixture.graphics, 4096);
    const usable = GPU_TEXTURE_BANK_MAX_CAPACITIES[actualBankClass] - 1;
    const materials = Array.from({ length: usable }, (_, index) =>
      createTexturedMaterial(createTexture(size, `bank-${size}-${index}`), `bank-material-${size}-${index}`)
    );
    const fill = new FakeCommand(`texture-${size}-fill`);
    residency.stage(materials, fill);
    fill.finish();
    const before = residency.evidence();
    assert.equal(before.banks[actualBankClass].residentTextureCount, usable);
    assert.equal(before.banks[actualBankClass].freeLayerCount, 0);

    assert.throws(
      () => residency.stage([
        createTexturedMaterial(createTexture(size, `bank-${size}-overflow`), `bank-material-${size}-overflow`)
      ], new FakeCommand(`texture-${size}-overflow`)),
      /requires .* layers but policy\/device permits/
    );
    assert.deepEqual(residency.evidence(), before);
    residency.destroy();
  }
});

test("Texture residency keeps bank choice legal for multiple small textures followed by a large texture", () => {
  const fixture = createTextureResidencyFixture();
  const residency = new TextureResidency(fixture.graphics, 4096);
  const small = Array.from({ length: 5 }, (_, index) =>
    createTexturedMaterial(createTexture(512, `small-${index}`), `small-material-${index}`)
  );
  const first = new FakeCommand("texture-multiple-small");
  residency.stage(small, first);
  first.finish();
  const largeTexture = createTexture(4096, "large-after-small");
  const large = new FakeCommand("texture-large-after-small");
  const staged = residency.stage([createTexturedMaterial(largeTexture, "large-material")], large);
  large.finish();
  assert.equal(decodeGpuTextureRef(staged.textureRefs.get(largeTexture))?.bankClass, 4);
  assert.equal(residency.evidence().banks[1].residentTextureCount, 5);
  assert.equal(residency.evidence().banks[4].residentTextureCount, 1);
  residency.destroy();
});

test("Texture residency preserves success while a 2048 bank grows one layer at a time", async () => {
  const fixture = createTextureResidencyFixture();
  const residency = new TextureResidency(fixture.graphics, 4096);
  const materials = [];
  for (let index = 0; index < 31; index++) {
    const material = createTexturedMaterial(createTexture(2048, `incremental-2048-${index}`), `incremental-material-${index}`);
    materials.push(material);
    const command = new FakeCommand(`texture-incremental-2048-${index}`);
    residency.stage([material], command);
    command.finish();
    await settlePromises();
  }
  const evidence = residency.evidence();
  assert.equal(evidence.banks[3].residentTextureCount, 31);
  assert.equal(evidence.banks[3].allocatedCapacity, 32);
  assert.ok(evidence.allocatedPeakBytes < 2 * 1024 * 1024 * 1024);
  const release = new FakeCommand("texture-incremental-release");
  residency.release(materials, release);
  release.finish();
  await settlePromises();
  residency.destroy();
});

test("Texture residency accepts every permutation of the same legal texture set", () => {
  const sizes = [256, 512, 1024, 2048, 4096];
  for (const [permutationIndex, permutation] of permutations(sizes).entries()) {
    const fixture = createTextureResidencyFixture();
    const residency = new TextureResidency(fixture.graphics, 4096);
    const textures = permutation.map((size, index) => createTexture(size, `permutation-${permutationIndex}-${index}`));
    const command = new FakeCommand(`texture-permutation-${permutationIndex}`);
    const staged = residency.stage(
      textures.map((texture, index) => createTexturedMaterial(texture, `permutation-material-${index}`)),
      command
    );
    command.finish();
    assert.deepEqual(
      textures.map((texture) => decodeGpuTextureRef(staged.textureRefs.get(texture))?.bankClass),
      permutation.map((size) => sizes.indexOf(size))
    );
    assert.equal(residency.evidence().residentTextureCount, sizes.length);
    residency.destroy();
  }
});

test("Texture residency deduplicates shared textures and releases the final reference once", async () => {
  const fixture = createTextureResidencyFixture();
  const residency = new TextureResidency(fixture.graphics, 4096);
  const shared = createTexture(1024, "shared");
  const materials = [
    createTexturedMaterial(shared, "shared-a"),
    createTexturedMaterial(shared, "shared-b")
  ];
  const stage = new FakeCommand("texture-shared-stage");
  const staged = residency.stage(materials, stage);
  stage.finish();
  assert.equal(staged.textureRefs.size, 1);
  assert.equal(residency.evidence().residentTextureCount, 1);
  const release = new FakeCommand("texture-shared-release");
  residency.release(materials, release);
  release.finish();
  await settlePromises();
  assert.equal(residency.evidence().residentTextureCount, 0);
  assert.equal(residency.evidence().banks[2].freeLayerCount, 1);
  residency.destroy();
});

test("Texture residency abort restores a grown bank and destroys its provisional allocation", () => {
  const fixture = createTextureResidencyFixture();
  const residency = new TextureResidency(fixture.graphics, 4096);
  const command = new FakeCommand("texture-grow-abort");
  residency.stage([createTexturedMaterial(createTexture(512, "abort-grow"), "abort-grow-material")], command);
  const provisional = fixture.textures.at(-1);
  command.abort(new Error("injected growth abort"));
  const evidence = residency.evidence();
  assert.equal(evidence.residentTextureCount, 0);
  assert.equal(evidence.banks[1].allocatedCapacity, 0);
  assert.equal(evidence.abortedBankGrowCount, 1);
  assert.equal(provisional.destroyed, true);
  residency.destroy();
});

test("Texture residency rolls back earlier bank growth when a later allocation fails", () => {
  const fixture = createTextureResidencyFixture({
    failTexture: (descriptor) => descriptor.label.includes("bank-2-")
  });
  const residency = new TextureResidency(fixture.graphics, 4096);
  const before = residency.evidence();
  assert.throws(() => residency.stage([
    createTexturedMaterial(createTexture(512, "fault-512"), "fault-material-512"),
    createTexturedMaterial(createTexture(1024, "fault-1024"), "fault-material-1024")
  ], new FakeCommand("texture-growth-fault")), /injected texture allocation failure/);
  const after = residency.evidence();
  assert.equal(after.residentTextureCount, before.residentTextureCount);
  assert.deepEqual(after.banks.map(({ allocatedCapacity }) => allocatedCapacity),
    before.banks.map(({ allocatedCapacity }) => allocatedCapacity));
  assert.equal(after.abortedBankGrowCount, 1);
  residency.destroy();
});

test("Texture residency quality and device resolution caps preserve logical texture count", () => {
  const fixture = createTextureResidencyFixture({ maxTextureDimension2D: 1024 });
  const residency = new TextureResidency(fixture.graphics, 1024);
  const before = residency.evidence();
  assert.equal(before.textureCapacity, 141);
  assert.deepEqual(before.banks.map(({ physicalSize }) => physicalSize), [256, 512, 1024, 1024, 1024]);
  const texture = createTexture(4096, "quality-capped-large");
  const command = new FakeCommand("texture-quality-cap");
  const staged = residency.stage([createTexturedMaterial(texture, "quality-capped-material")], command);
  command.finish();
  assert.equal(decodeGpuTextureRef(staged.textureRefs.get(texture))?.bankClass, 4);
  assert.equal(residency.evidence().banks[4].physicalSize, 1024);
  residency.destroy();
});

test("Frame evidence detects extra submit, stable-graph rebuild, IO, and feature-off resources", () => {
  const profiler = new FrameProfiler({ enabled: true, now: () => 0 });
  profiler.beginFrame(7);
  profiler.recordSubmit("main");
  profiler.recordSubmit("injected-private-submit");
  profiler.recordGraphBuild();
  profiler.recordGraphCompile();
  profiler.recordGraphExecute();
  profiler.recordGraphCacheMiss();
  profiler.recordUpload("injected-upload", 64);
  profiler.recordReadback("injected-readback", 32);
  const profile = profiler.endFrame();
  assert.notEqual(profile, undefined);

  const accounting = new ResourceAccounting();
  accounting.created({
    kind: "texture",
    category: "history",
    owner: "disabled-feature",
    bytes: 256
  });
  const issues = stableFrameContractIssues(profile, accounting.snapshot(), {
    legacyMaterialContextCount: 1
  });

  assert.deepEqual(issues, [
    "expected exactly one main submit",
    "stable frame rebuilt or missed the graph cache",
    "unexpected stable-frame upload",
    "unexpected stable-frame readback",
    "disabled feature retained resources",
    "forbidden legacy material owner was created"
  ]);
});

function createPackedRegistryFixture() {
  const accounting = new ResourceAccounting();
  const buffers = [];
  const calls = {
    legacyMaterialObtains: 0,
    stages: [],
    releases: [],
    patches: []
  };
  const dummyBuffer = {};
  const dummyView = {};
  const material = new StandardShadeMaterial();
  material.name = "packed-material";
  const geometry = {
    clusters: [],
    meshlets: [{ triangleCount: 12 }]
  };
  const source = {
    geometries: [geometry],
    materials: [material],
    count: 1,
    geometryIndices: new Uint32Array([0]),
    materialIndices: new Uint32Array([0]),
    currentTransforms: identityMatrices(1),
    boundsSpheres: new Float32Array([0, 0, 0, 1])
  };
  const instanceHandle = {};
  const graphics = {
    device: {
      createBuffer(descriptor) {
        const buffer = {
          descriptor,
          destroyed: false,
          destroy() {
            this.destroyed = true;
          }
        };
        buffers.push(buffer);
        return buffer;
      },
      queue: { onSubmittedWorkDone: () => Promise.resolve() }
    },
    resource_accounting: accounting,
    materials: {
      obtain() {
        calls.legacyMaterialObtains++;
        return {};
      }
    },
    texture_residency: {
      stage(_materials, command) {
        calls.stages.push("texture");
        command.onAborted.addOne(() => calls.stages.push("texture-abort"));
        return {
          bindings: {
            textureCapacity: 64,
            textureBanks: [dummyView, dummyView, dummyView, dummyView, dummyView]
          },
          textureRefs: new Map()
        };
      },
      release(_materials, command) {
        calls.releases.push("texture");
        command.onAborted.addOne(() => calls.releases.push("texture-release-abort"));
      }
    },
    material_store: {
      stage(materials, _textureRefs, command) {
        calls.stages.push("material");
        command.onAborted.addOne(() => calls.stages.push("material-abort"));
        return {
          bindings: { abiVersion: 1, materialCapacity: 4096, materialRecords: dummyBuffer },
          materialSlots: materials.map((_material, index) => 7 + index)
        };
      },
      release(_materials, command) {
        calls.releases.push("material");
        command.onAborted.addOne(() => calls.releases.push("material-release-abort"));
      }
    },
    gpu_scene: {
      instantiate(_source, command) {
        calls.stages.push("instance");
        command.onAborted.addOne(() => calls.stages.push("instance-abort"));
        return instanceHandle;
      },
      range() {
        return { start: 3, count: 1 };
      },
      release(_handle, command) {
        calls.releases.push("instance");
        command.onAborted.addOne(() => calls.releases.push("instance-release-abort"));
      },
      patch(_handle, batch) {
        calls.patches.push(batch);
        return {
          patchedTransforms: batch.transforms?.indices.length ?? 0,
          patchedMaterials: batch.materials?.indices.length ?? 0
        };
      },
      bindings() {
        return {};
      }
    },
    assets: { bindings: () => ({}) }
  };
  return {
    registry: new GpuPackedSceneRegistry(graphics),
    scene: {},
    manifest: { source, packages: source.geometries, materials: source.materials },
    assetHandles: [{}],
    buffers,
    calls
  };
}

function createTextureResidencyFixture(options = {}) {
  const accounting = new ResourceAccounting();
  const textures = [];
  const graphics = {
    device: {
      limits: {
        maxTextureArrayLayers: 2048,
        maxTextureDimension2D: options.maxTextureDimension2D ?? 8192
      },
      createTexture(descriptor) {
        if (options.failTexture?.(descriptor)) throw new Error("injected texture allocation failure");
        const texture = {
          descriptor,
          destroyed: false,
          createView(options = {}) {
            return { texture, options };
          },
          destroy() {
            texture.destroyed = true;
          }
        };
        textures.push(texture);
        return texture;
      }
    },
    resource_accounting: accounting,
    textures: {
      obtain(source) {
        return {
          width: source.image.width,
          height: source.image.height,
          obtainView: () => ({ source })
        };
      },
      mipmaps: {
        flush() {},
        generateMipmap() {}
      }
    },
    bind_groups: { obtain: () => ({}) },
    render_pipelines: { obtain: () => ({}) }
  };
  return { graphics, accounting, textures };
}

async function runReleasedHighTextureSequence([firstSize, secondSize]) {
  const fixture = createTextureResidencyFixture();
  const residency = new TextureResidency(fixture.graphics, 4096);
  const firstTexture = createTexture(firstSize, `high-${firstSize}`);
  const firstMaterial = createTexturedMaterial(firstTexture, `material-${firstSize}`);
  const first = new FakeCommand("high-first");
  residency.stage([firstMaterial], first);
  first.finish();
  const release = new FakeCommand("high-release");
  residency.release([firstMaterial], release);
  release.finish();
  await settlePromises();

  const secondTexture = createTexture(secondSize, `high-${secondSize}`);
  const secondMaterial = createTexturedMaterial(secondTexture, `material-${secondSize}`);
  const second = new FakeCommand("high-second");
  let secondAccepted = true;
  let secondRef;
  try {
    secondRef = residency.stage([secondMaterial], second).textureRefs.get(secondTexture);
    second.finish();
  } catch (error) {
    secondAccepted = false;
    second.abort(error);
  }
  const secondBankClass = secondAccepted ? decodeGpuTextureRef(secondRef)?.bankClass : undefined;
  residency.destroy();
  return { firstSize, secondSize, secondAccepted, secondBankClass };
}

function createTexture(size, label) {
  const image = new ShadeImage();
  image.width = size;
  image.height = size;
  image.depth = 1;
  const texture = ShadeTexture.from(image);
  texture.label = label;
  return texture;
}

function createTexturedMaterial(texture, name) {
  const material = new StandardShadeMaterial();
  material.name = name;
  material.texture_albedo = texture;
  return material;
}

function permutations(values) {
  if (values.length <= 1) return [values];
  const result = [];
  for (let index = 0; index < values.length; index++) {
    const head = values[index];
    const rest = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const tail of permutations(rest)) result.push([head, ...tail]);
  }
  return result;
}

function identityMatrices(count) {
  const matrices = new Float32Array(count * 16);
  for (let index = 0; index < count; index++) {
    const offset = index * 16;
    matrices[offset] = 1;
    matrices[offset + 5] = 1;
    matrices[offset + 10] = 1;
    matrices[offset + 15] = 1;
  }
  return matrices;
}

function stableFrameContractIssues(profile, resources, owners) {
  const issues = [];
  if (profile.submits.count !== 1 || profile.submits.labels.main !== 1) {
    issues.push("expected exactly one main submit");
  }
  if (
    profile.graph.builds !== 0 ||
    profile.graph.compiles !== 0 ||
    profile.graph.cacheMisses !== 0 ||
    profile.graph.cacheHits !== 1
  ) {
    issues.push("stable frame rebuilt or missed the graph cache");
  }
  if (profile.uploads.bytes !== 0) issues.push("unexpected stable-frame upload");
  if (profile.readbacks.bytes !== 0) issues.push("unexpected stable-frame readback");
  if (resources.owners["disabled-feature"] !== undefined) {
    issues.push("disabled feature retained resources");
  }
  if (owners.legacyMaterialContextCount !== 0) {
    issues.push("forbidden legacy material owner was created");
  }
  return issues;
}

class OneShotSignal {
  listeners = [];

  addOne(listener) {
    this.listeners.push(listener);
  }

  dispatch(...args) {
    const listeners = this.listeners.splice(0);
    for (const listener of listeners) listener(...args);
  }
}

class FakeCommand {
  onFinished = new OneShotSignal();
  onAborted = new OneShotSignal();
  gpuDone = Promise.resolve();
  closed = false;
  submitted = false;

  constructor(label) {
    this.label = label;
  }

  finish() {
    if (this.closed) throw new Error("command is already closed");
    this.closed = true;
    this.submitted = true;
    this.onFinished.dispatch(this);
  }

  abort(cause) {
    if (this.closed) return;
    this.closed = true;
    this.onAborted.dispatch(this, cause);
  }

  allocateTransientBufferAndLoad() {
    return {};
  }

  beginRenderPass() {
    return {
      setViewport() {},
      setPipeline() {},
      setBindGroup() {},
      draw() {},
      end() {}
    };
  }

  copyTextureToTexture() {}
}

async function settlePromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function installWebGpuConstants() {
  globalThis.GPUBufferUsage ??= Object.freeze({
    MAP_READ: 1,
    MAP_WRITE: 2,
    COPY_SRC: 4,
    COPY_DST: 8,
    INDEX: 16,
    VERTEX: 32,
    UNIFORM: 64,
    STORAGE: 128,
    INDIRECT: 256,
    QUERY_RESOLVE: 512
  });
  globalThis.GPUTextureUsage ??= Object.freeze({
    COPY_SRC: 1,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    STORAGE_BINDING: 8,
    RENDER_ATTACHMENT: 16
  });
  globalThis.GPUShaderStage ??= Object.freeze({
    VERTEX: 1,
    FRAGMENT: 2,
    COMPUTE: 4
  });
}
