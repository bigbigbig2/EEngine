import assert from "node:assert/strict";
import test from "node:test";
import "../webgpu-test-globals.mjs";
import { ComputePipelineCache, RenderPipelineCache } from "../../.test-dist/gpu/GPUDescriptorCaches.js";
import { PipelineCompilationQueue } from "../../.test-dist/gpu/PipelineCompilationQueue.js";
import { PreparedComputePipeline, PreparedRenderPipeline } from "../../.test-dist/gpu/PreparedPipeline.js";

const descriptor = (entryPoint = "main") => ({
  label: entryPoint,
  layout: { bindGroupLayouts: [] },
  compute: { module: { code: "compute" }, entryPoint },
});
function fixture() {
  const jobs = [];
  let lose;
  const device = {
    lost: new Promise((resolve) => {
      lose = resolve;
    }),
    createComputePipeline() {
      throw new Error("Synchronous compile");
    },
    createComputePipelineAsync(d) {
      return enqueue(d);
    },
    createRenderPipelineAsync(d) {
      return enqueue(d);
    },
  };
  function enqueue(d) {
    return new Promise((resolve, reject) => jobs.push({ d, resolve, reject }));
  }
  const layouts = { obtainPipelineLayout: (d) => d },
    shaders = { obtain: (d) => d };
  return {
    device,
    jobs,
    lose,
    cache: new ComputePipelineCache(device, layouts, shaders),
    render: new RenderPipelineCache(device, layouts, shaders),
  };
}
test("compute exact preparation deduplicates, propagates failures and revokes old epochs", async () => {
  const f = fixture(),
    d = descriptor();
  const old = f.cache.prepare(d);
  assert.equal(f.cache.prepare(descriptor()), old);
  assert.equal(f.jobs.length, 1);
  assert.throws(() => f.cache.requirePrepared(d), /completed scene preparation/);
  f.cache.clear();
  const next = f.cache.prepare(d);
  f.jobs[0].resolve({});
  await assert.rejects(old, /revoked/);
  assert.equal(f.cache.prepare(d), next);
  f.jobs[1].reject(new Error("compiler failure"));
  await assert.rejects(next, /compiler failure/);
  const retry = f.cache.prepare(d),
    pipeline = {};
  f.jobs[2].resolve(pipeline);
  await retry;
  assert.equal(f.cache.requirePrepared(d), pipeline);
  assert.throws(() => f.cache.requirePrepared(descriptor("other")), /other/);
});
test("render, compute and material jobs share at most sixteen device credits", async () => {
  const f = fixture(),
    queue = PipelineCompilationQueue.forDevice(f.device);
  const promises = Array.from({ length: 20 }, (_, i) => f.cache.prepare(descriptor(`stage${i}`)));
  promises.push(
    f.render.prepare({
      layout: { bindGroupLayouts: [] },
      vertex: { module: { code: "vs" }, entryPoint: "main" },
    }),
  );
  promises.push(queue.run(() => f.device.createComputePipelineAsync({ label: "material" })));
  assert.equal(f.jobs.length, 16);
  assert.equal(queue.evidence().active, 16);
  assert.equal(queue.evidence().queued, 6);
  for (let i = 0; i < 22; i++) {
    f.jobs[i].resolve({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(queue.evidence().active <= 16);
  }
  await Promise.all(promises);
  assert.equal(queue.evidence().completed, 22);
});
test("device loss rejects waiting work and late completed pipelines cannot republish", async () => {
  const f = fixture();
  const promises = Array.from({ length: 18 }, (_, i) => f.cache.prepare(descriptor(`lost${i}`)));
  const all = Promise.allSettled(promises);
  f.lose({ reason: "destroyed", message: "test" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.jobs.length, 16);
  const results = await all;
  assert.ok(results.every((result) => result.status === "rejected"));
  f.jobs.forEach((job) => job.resolve({}));
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => f.cache.requirePrepared(descriptor("lost0")), /completed scene preparation/);
});

test("owner preparation keeps the exact descriptor, retries failure and rejects a lost device", async () => {
  const f = fixture();
  const computeDescriptor = {
    label: "owner compute",
    layout: {},
    compute: { module: {}, entryPoint: "main" },
  };
  const renderDescriptor = { label: "owner render", layout: {}, vertex: { module: {}, entryPoint: "main" } };
  const preparedOwners = [];
  for (const [owner, d] of [
    [new PreparedComputePipeline(f.device, computeDescriptor), computeDescriptor],
    [new PreparedRenderPipeline(f.device, renderDescriptor), renderDescriptor],
  ]) {
    assert.throws(() => owner.requirePrepared(), /completed owner preparation/);
    let index = f.jobs.length;
    const failed = owner.prepare();
    assert.equal(owner.prepare(), failed);
    assert.equal(f.jobs[index].d, d);
    f.jobs[index].reject(new Error("owner compile failure"));
    await assert.rejects(failed, /owner compile failure/);
    index = f.jobs.length;
    const ready = owner.prepare();
    const pipeline = {};
    f.jobs[index].resolve(pipeline);
    await ready;
    assert.equal(owner.requirePrepared(), pipeline);
    await owner.prepare();
    assert.equal(f.jobs.length, index + 1);
    preparedOwners.push(owner);
  }
  const owner = new PreparedComputePipeline(f.device, computeDescriptor);
  f.lose({ reason: "destroyed", message: "owner test" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => owner.prepare(), /device lost/);
  assert.throws(() => owner.requirePrepared(), /device lost/);
  for (const prepared of preparedOwners) {
    assert.throws(() => prepared.prepare(), /device lost/);
    assert.throws(() => prepared.requirePrepared(), /device lost/);
  }
});
