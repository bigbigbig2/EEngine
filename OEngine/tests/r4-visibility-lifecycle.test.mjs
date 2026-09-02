import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUTextureUsage ??= {
  COPY_SRC: 1 << 0,
  TEXTURE_BINDING: 1 << 2,
  RENDER_ATTACHMENT: 1 << 4
};

const {
  PackedVisibilityPass,
  validatePackedVisibilityPreparation
} = await import("../.test-dist/render/passes/PackedVisibilityPass.js");
const { ShadeGPUCommandContext } = await import(
  "../.test-dist/framegraph/ShadeGPUCommandContext.js"
);
const { GPUViewKey, ViewManager } = await import(
  "../.test-dist/render/ViewManager.js"
);
const {
  GPU_CLASSIFIED_RASTER_HEADER_BYTES,
  GPU_RASTER_WORK_SCHEMA,
  GPU_WORK_QUEUE_HEADER_SCHEMA
} = await import("../.test-dist/gpu/GpuWorkGenerationAbi.js");

test("R4-A-05 prepare rejects capacity before generator allocation or encoding", () => {
  const adapterCapacity = 5;
  const byteLimit = GPU_CLASSIFIED_RASTER_HEADER_BYTES +
    adapterCapacity * 2 * GPU_RASTER_WORK_SCHEMA.stride;
  const generator = createGenerator();
  const exact = createExactFilter();
  const pass = new PackedVisibilityPass({
    device: {
      limits: {
        maxBufferSize: byteLimit,
        maxStorageBufferBindingSize: byteLimit
      }
    }
  }, generator, exact);
  const command = createRetirementCommand();
  const job = createJob(adapterCapacity + 1);

  assert.throws(
    () => pass.prepareHierarchy(job, {}, {}, command),
    /exceeds effective capacity 5/
  );
  assert.equal(generator.prepareCalls.length, 0);
  assert.equal(generator.encodeCalls, 0);
  assert.equal(command.retired.length, 0);
  assert.equal(pass.lastPreparation, null);

  job.runtime.hierarchyRasterWorkCapacity = adapterCapacity;
  const prepared = pass.prepareHierarchy(job, {}, {}, command);
  assert.equal(generator.prepareCalls.length, 1);
  assert.equal(prepared.prepared, generator.prepared[0]);
  assert.equal(prepared.exact, exact.prepared[0]);
  assert.deepEqual(pass.lastPreparation, {
    requiredCapacity: adapterCapacity,
    requiredByteLength: byteLimit,
    keyCapacity: 0x7fffffff,
    adapterCapacity,
    effectiveCapacity: adapterCapacity,
    effectiveByteLimit: byteLimit
  });
});

test("R4-A-05 replacement and release retire prepared work through the command fence", () => {
  const generator = createGenerator();
  const exact = createExactFilter();
  const pass = new PackedVisibilityPass({
    device: {
      limits: {
        maxBufferSize: 1 << 20,
        maxStorageBufferBindingSize: 1 << 20
      }
    }
  }, generator, exact);
  const command = createRetirementCommand();
  const job = createJob(8);
  const counters = {};

  const camera = {};
  const first = pass.prepareHierarchy(job, counters, camera, command);
  assert.equal(pass.prepareHierarchy(job, counters, camera, command), first);
  assert.equal(generator.prepareCalls.length, 1, "stable epochs reuse prepared work");

  job.assets.epoch++;
  const second = pass.prepareHierarchy(job, counters, camera, command);
  assert.notEqual(second, first);
  assert.equal(generator.prepareCalls.length, 2);
  assert.equal(command.retired.length, 1);
  assert.deepEqual(generator.released, []);
  command.retired[0].destroy();
  assert.deepEqual(generator.released, [first.prepared]);
  assert.deepEqual(exact.released, [first.exact]);

  pass.release(job.runtime, command);
  assert.equal(command.retired.length, 2);
  command.retired[1].destroy();
  assert.deepEqual(generator.released, [first.prepared, second.prepared]);
  assert.deepEqual(exact.released, [first.exact, second.exact]);

  const third = pass.prepareHierarchy(job, counters, camera, command);
  assert.notEqual(third, second, "released runtime rebuilds instead of reusing stale work");
  pass.destroy();
  assert.equal(generator.destroyCount, 1);
});

test("exact-filter preparation failure immediately releases the unpublished hierarchy state", () => {
  const generator = createGenerator();
  const exact = createExactFilter();
  exact.prepare = () => { throw new Error("exact filter allocation failed"); };
  const pass = new PackedVisibilityPass({
    device: {
      limits: {
        maxBufferSize: 1 << 20,
        maxStorageBufferBindingSize: 1 << 20
      }
    }
  }, generator, exact);

  assert.throws(
    () => pass.prepareHierarchy(createJob(8), {}, {}, createRetirementCommand()),
    /exact filter allocation failed/
  );
  assert.deepEqual(generator.released, [generator.prepared[0]]);
  assert.equal(exact.released.length, 0);
  pass.destroy();
});

test("R4-A-05 aborted retirement still waits for prior submitted GPU work", async () => {
  let finishGpuWork;
  const gpuWork = new Promise((resolve) => {
    finishGpuWork = resolve;
  });
  const graphics = {
    device: {
      queue: { onSubmittedWorkDone: () => gpuWork },
      createCommandEncoder: () => ({})
    },
    profiler: { attachGpuTimingContext() {} },
    buffer_allocator_main: { release() {} },
    buffer_allocator_staging: { release() {} }
  };
  const command = ShadeGPUCommandContext.create(graphics, "R4-A-05 abort fence");
  const resource = {
    destroyCount: 0,
    destroy() { this.destroyCount++; }
  };
  command.destroyAfterGpuDone(resource);
  command.abort(new Error("intentional replacement abort"));
  assert.equal(resource.destroyCount, 0);
  finishGpuWork();
  await gpuWork;
  await Promise.resolve();
  assert.equal(resource.destroyCount, 1);
});

test("R4-A-05 view removal recreates a distinct context and fences old history", () => {
  const contexts = [];
  const manager = new ViewManager(
    {},
    { obtain: () => ({}) },
    { obtain: () => ({}) },
    () => {
      const context = { id: contexts.length, destroy() {} };
      contexts.push(context);
      return context;
    }
  );
  const key = new GPUViewKey({}, {});
  const command = createRetirementCommand();
  const first = manager.obtain(key, command);
  assert.equal(manager.remove(key, command), true);
  assert.equal(manager.exists(key), false);
  const second = manager.obtain(key, command);
  assert.notEqual(second, first);
  assert.equal(contexts.length, 2);
  assert.deepEqual(command.retired, [first]);
});

test("R4-A-05 feature-off source keeps counter reducer and debug resolve behind guards", () => {
  const rendererSource = readFileSync(
    new URL("../src/render/Renderer.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    rendererSource,
    /if \(sampleGpuCounters\) \{[\s\S]*?r0_gpu_frame_counters[\s\S]*?\}/
  );
  assert.match(
    rendererSource,
    /if \(gpuCounterRes !== null\) \{[\s\S]*?new VisibilityCounterPass\(\)[\s\S]*?addToGraph/
  );
  assert.match(
    rendererSource,
    /if \(graphTopology\.debug\) \{[\s\S]*?new RenderDebugViewPass[\s\S]*?addToGraph/
  );
  assert.doesNotMatch(
    rendererSource,
    /initializeRenderPasses[\s\S]{0,4000}new VisibilityCounterPass/
  );
});

test("R4-A-05 preparation evidence accepts the exact adapter boundary", () => {
  const capacity = 17;
  const limit = GPU_CLASSIFIED_RASTER_HEADER_BYTES +
    capacity * 2 * GPU_RASTER_WORK_SCHEMA.stride;
  assert.equal(
    validatePackedVisibilityPreparation(capacity, {
      maxBufferSize: limit,
      maxStorageBufferBindingSize: limit
    }).requiredByteLength,
    limit
  );
});

function createJob(rasterWorkCapacity) {
  return {
    runtime: {
      hierarchyRasterWorkCapacity: rasterWorkCapacity,
      hierarchyTraversalCapacity: 8,
      hierarchyVisibleClusterCapacity: 8,
      hierarchyMaxDepth: 0,
      instanceBegin: 0,
      instanceCount: 1
    },
    assets: { epoch: 1 },
    scene: { epoch: 1 },
    countersEnabled: false,
    hierarchyView: {},
    sseThreshold: 4,
    coneEnabled: false,
    previousHzb: null,
    width: 1,
    height: 1
  };
}

function createGenerator() {
  return {
    prepared: [],
    prepareCalls: [],
    encodeCalls: 0,
    released: [],
    destroyCount: 0,
    prepare(scene, config) {
      this.prepareCalls.push({ scene, config });
      const prepared = {
        id: this.prepared.length,
        generated: { rasterWork: {}, rasterWorkCapacity: scene.rasterWorkCapacity }
      };
      this.prepared.push(prepared);
      return prepared;
    },
    encode() {
      this.encodeCalls++;
      throw new Error("encode is not used by this lifecycle test");
    },
    release(prepared) {
      this.released.push(prepared);
    },
    destroy() {
      this.destroyCount++;
    }
  };
}

function createExactFilter() {
  return {
    prepared: [],
    released: [],
    destroyCount: 0,
    prepare(inputs) {
      const prepared = {
        inputs,
        output: {
          rasterWork: {},
          classCapacity: inputs.candidateCapacity,
          totalCapacity: inputs.candidateCapacity * 2,
          drawIndirect: {},
          opaqueDrawOffset: 0,
          maskDrawOffset: 16
        }
      };
      this.prepared.push(prepared);
      return prepared;
    },
    encode() {
      throw new Error("encode is not used by this lifecycle test");
    },
    release(prepared) {
      this.released.push(prepared);
    },
    destroy() {
      this.destroyCount++;
    }
  };
}

function createRetirementCommand() {
  return {
    retired: [],
    destroyAfterGpuDone(resource) {
      this.retired.push(resource);
    }
  };
}
