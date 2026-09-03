import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.GPUBufferUsage ??= {
  COPY_SRC: 1 << 2,
  COPY_DST: 1 << 3,
  STORAGE: 1 << 7,
  INDIRECT: 1 << 8
};

const { GpuPackedSceneRegistry } = await import(
  "../.test-dist/gpu/GpuPackedSceneRegistry.js"
);
const { StandardShadeMaterial } = await import(
  "../.test-dist/material/StandardShadeMaterial.js"
);
const { Scene } = await import("../.test-dist/scene/Scene.js");

test("R2-D Packed Scene rejects malformed source before allocating or mutating owners", () => {
  const graphics = createGraphics();
  const registry = new GpuPackedSceneRegistry(graphics);
  const source = makeSource();
  source.currentTransforms = new Float32Array(15);

  assert.throws(
    () => registry.stage(new Scene(), makeManifest(source), [Object.freeze({})], new FakeCommand()),
    /currentTransforms length/
  );
  assert.equal(graphics.obtainCount, 0);
  assert.equal(graphics.instantiateCount, 0);
  assert.equal(graphics.buffers.length, 0);
});

test("R3-D Packed Scene abort rolls back its counter sink and release retires it after completion", async () => {
  const graphics = createGraphics();
  const registry = new GpuPackedSceneRegistry(graphics);
  const scene = new Scene();
  const source = makeSource();

  const aborted = new FakeCommand();
  registry.stage(scene, makeManifest(source), [Object.freeze({})], aborted);
  assert.equal(graphics.buffers[0].size, 512);
  aborted.abort();
  assert.equal(registry.evidence().sceneCount, 0);
  assert.deepEqual(graphics.buffers.map((buffer) => buffer.destroyCount), [1]);

  const staged = new FakeCommand();
  registry.stage(scene, makeManifest(source), [Object.freeze({})], staged);
  staged.finish();
  assert.equal(registry.evidence().sceneCount, 1);
  assert.equal(registry.evidence().hierarchyRasterWorkCapacity, 2);
  assert.equal(registry.evidence().flatWorkBytes, 0);

  const release = new FakeCommand();
  const handles = registry.release(scene, release);
  assert.equal(handles.length, 1);
  release.finish();
  assert.equal(registry.evidence().sceneCount, 0);
  assert.deepEqual(graphics.buffers.slice(1).map((buffer) => buffer.destroyCount), [0]);

  graphics.completeGpu();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(graphics.buffers.slice(1).map((buffer) => buffer.destroyCount), [1]);
  assert.equal(graphics.releaseCount, 1);
});

test("Packed Scene upload is one transactional residency command", () => {
  const source = readFileSync(
    new URL("../src/render/Renderer.ts", import.meta.url),
    "utf8"
  );
  const upload = source.slice(
    source.indexOf("async uploadPackedScene"),
    source.indexOf("/** Releases one Packed Scene")
  );
  assert.match(upload, /createSceneResidencyManifest\(source,/s);
  assert.match(upload, /assets\.residentMany\(\s*manifest\.packages,\s*command/s);
  assert.match(upload, /packed_scenes\.stage\(\s*scene,\s*manifest,\s*handles,\s*command/s);
  assert.equal((upload.match(/command\.finish\(\)/g) ?? []).length, 1);
  assert.equal((upload.match(/await command\.submitted/g) ?? []).length, 1);
  assert.match(upload, /catch \(error\) \{\s*command\.abort\(error\)/s);
});

test("R3-D hierarchy capacity counts every instance sharing one Geometry without a flat owner", () => {
  const graphics = createGraphics();
  const registry = new GpuPackedSceneRegistry(graphics);
  const scene = new Scene();
  const shared = makeSource(1_000, 7);
  const command = new FakeCommand();
  registry.stage(scene, makeManifest(shared), [Object.freeze({})], command);
  command.finish();
  assert.equal(registry.evidence().hierarchyVisibleClusterCapacity, 1_000);
  assert.equal(registry.evidence().hierarchyRasterWorkCapacity, 7_000);
  assert.equal(registry.evidence().flatWorkBytes, 0);
});

test("R4-B Packed Scene writes dense resident material slots and patches by dictionary index", () => {
  const graphics = createGraphics();
  const registry = new GpuPackedSceneRegistry(graphics);
  const scene = new Scene();
  const source = makeSource(2, 1);
  source.materials = [new StandardShadeMaterial(), new StandardShadeMaterial()];
  source.materialIndices = new Uint32Array([1, 0]);

  const stage = new FakeCommand();
  registry.stage(scene, makeManifest(source), [Object.freeze({})], stage);
  assert.deepEqual([...graphics.lastInstanceSource.materialHandles], [11, 7]);
  stage.finish();

  registry.queuePatch(scene, {
    frameId: 4,
    materials: {
      indices: new Uint32Array([0, 1]),
      materialIndices: new Uint32Array([0, 1])
    }
  });
  registry.encodePendingPatch(scene, new FakeCommand());
  assert.deepEqual([...graphics.lastPatch.materials.materialHandles], [7, 11]);

  registry.queuePatch(scene, {
    frameId: 5,
    materials: {
      indices: new Uint32Array([0]),
      materialIndices: new Uint32Array([2])
    }
  });
  assert.throws(
    () => registry.encodePendingPatch(scene, new FakeCommand()),
    /outside the material dictionary/
  );
});

function makeSource(count = 1, meshletCount = 2) {
  const currentTransforms = new Float32Array(count * 16);
  const boundsSpheres = new Float32Array(count * 4);
  for (let index = 0; index < count; index++) {
    currentTransforms.set([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ], index * 16);
    boundsSpheres.set([0, 0, 0, 1], index * 4);
  }
  return {
    geometries: [{
      directory: { meshletCount, clusterRoot: 0 },
      clusters: [{
        childBegin: 0,
        childCount: 0,
        depth: 0,
        meshletBegin: 0,
        meshletCount
      }],
      clusterChildren: new Uint32Array(),
      meshlets: Array.from({ length: meshletCount }, () => ({ triangleCount: 1 }))
    }],
    materials: [new StandardShadeMaterial()],
    count,
    geometryIndices: new Uint32Array(count),
    materialIndices: new Uint32Array(count),
    currentTransforms,
    boundsSpheres
  };
}

function makeManifest(source) {
  return Object.freeze({
    schemaVersion: 1,
    source,
    packages: source.geometries,
    materials: source.materials,
    packageContentHashes: [],
    totals: {}
  });
}

function createGraphics() {
  const buffers = [];
  let completionResolve;
  let completion = new Promise((resolve) => {
    completionResolve = resolve;
  });
  const graphics = {
    buffers,
    obtainCount: 0,
    instantiateCount: 0,
    releaseCount: 0,
    materialReleaseCount: 0,
    lastInstanceSource: null,
    lastPatch: null,
    materials: {
      obtain() {
        graphics.obtainCount++;
      }
    },
    texture_residency: {
      stage() {
        return {
          bindings: {
            textureCapacity: 256,
            textureArray: {},
            highResolutionTextureArray: {},
            alphaAtlas: {},
            highResolutionAlphaAtlas: {}
          },
          textureRefs: new Map()
        };
      },
      release(_materials, command) {
        command.onFinished.addOne(() => {});
      }
    },
    material_store: {
      stage(materials) {
        return {
          bindings: {
            abiVersion: 1,
            materialCapacity: 4096,
            materialRecords: {}
          },
          materialSlots: materials.map((_, index) => index === 0 ? 7 : 11)
        };
      },
      release(_materials, command) {
        command.onFinished.addOne(() => graphics.materialReleaseCount++);
      }
    },
    assets: {
      bindings() {
        return {};
      }
    },
    gpu_scene: {
      instantiate(source, command) {
        graphics.instantiateCount++;
        graphics.lastInstanceSource = source;
        const handle = Object.freeze({});
        command.onAborted.addOne(() => {});
        return handle;
      },
      range() {
        return { start: 1, count: 1 };
      },
      release(_handle, command) {
        command.onFinished.addOne(() => graphics.releaseCount++);
      },
      patch(_handle, batch) {
        graphics.lastPatch = batch;
        return {};
      },
      bindings() {
        return {};
      }
    },
    device: {
      limits: {
        maxBufferSize: 1 << 20,
        maxStorageBufferBindingSize: 1 << 20
      },
      queue: {
        onSubmittedWorkDone() {
          return completion;
        }
      },
      createBuffer(descriptor) {
        const buffer = {
          ...descriptor,
          destroyCount: 0,
          destroy() {
            this.destroyCount++;
          }
        };
        buffers.push(buffer);
        return buffer;
      }
    },
    completeGpu() {
      completionResolve();
      completion = Promise.resolve();
    }
  };
  return graphics;
}

class FakeSignal {
  listeners = [];

  addOne(listener) {
    this.listeners.push(listener);
  }

  send(...args) {
    for (const listener of this.listeners.splice(0)) listener(...args);
  }
}

class FakeCommand {
  onFinished = new FakeSignal();
  onAborted = new FakeSignal();

  finish() {
    this.onFinished.send(this);
  }

  abort() {
    this.onAborted.send(this, new Error("aborted"));
  }
}
