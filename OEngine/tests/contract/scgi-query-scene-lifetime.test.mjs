import assert from "node:assert/strict";
import test from "node:test";

globalThis.GPUShaderStage = { COMPUTE: 4, VERTEX: 1, FRAGMENT: 2 };
const { ScgiQueryScene } = await import("../../.test-dist/render/gi/ScgiQueryScene.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const released = [];
  const failed = [];
  const lease = (name) => ({
    valid: true,
    release() { released.push(name); },
    async releaseAfter(fence) {
      try { await fence; }
      catch (error) { failed.push([name, error]); throw error; }
    },
  });
  const device = {};
  const owner = Object.assign(Object.create(ScgiQueryScene.prototype), {
    device, state: "submitted", retiring: false, consumers: new Map(),
    poisonSettlement: null, nativeLease: lease("material"),
    geometryLeases: [lease("geometry")],
    sourceInstances: { valid: true, destroy() { released.push("instances"); } },
    materials: { destroy() { released.push("directory"); } },
    shards: [], builders: [], buffers: [], handles: [], coverage: null,
  });
  const command = () => ({ device, closed: false, observers: [],
    observeSubmission(observer) { this.observers.push(observer); },
  });
  return { owner, command, released, failed };
}

test("scene retirement waits for encoded consumers beyond the caller's earlier fence", async () => {
  const f = fixture();
  const command = f.command();
  f.owner.observeUse(command);
  f.owner.observeUse(command);
  assert.equal(command.observers.length, 1);
  let retired = false;
  const retirement = f.owner.releaseAfter(Promise.resolve()).then(() => { retired = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(retired, false);
  assert.deepEqual(f.released, []);
  assert.throws(() => f.owner.observeUse(f.command()), /requires its submitted scene/);
  const fence = deferred();
  command.closed = true;
  command.observers[0].submitted(fence.promise);
  await Promise.resolve();
  assert.equal(retired, false);
  fence.resolve();
  await retirement;
  assert.equal(retired, true);
  assert.deepEqual(new Set(f.released), new Set(["instances", "directory", "material", "geometry"]));
});

test("abort settles an unused consumer; failed submission quarantines every source owner", async () => {
  const abort = fixture();
  const abandoned = abort.command();
  abort.owner.observeUse(abandoned);
  const retirement = abort.owner.releaseAfter(Promise.resolve());
  abandoned.observers[0].aborted(new Error("cancel before submit"));
  await retirement;
  assert.equal(abort.owner.state, "destroyed");

  for (const asynchronous of [false, true]) {
    const f = fixture();
    const command = f.command();
    f.owner.observeUse(command);
    const error = new Error("consumer submission failure");
    const retirement = f.owner.releaseAfter(Promise.resolve());
    if (asynchronous) {
      command.observers[0].submitted(Promise.reject(error));
    } else {
      command.observers[0].failed(error);
    }
    await assert.rejects(retirement, (cause) => cause === error);
    assert.equal(f.owner.state, "poisoned");
    assert.equal(f.owner.valid, false);
    assert.deepEqual(f.released, []);
    assert.deepEqual(f.failed, [["material", error], ["geometry", error]]);
    assert.throws(() => f.owner.destroy(), /failed submission/);
  }
});

test("a scene's unsubmitted build can only be consumed in the same command", () => {
  const f = fixture();
  const build = f.command();
  f.owner.state = "encoded";
  f.owner.buildCommand = build;
  assert.throws(() => f.owner.observeUse(f.command()), /scene build command/);
  f.owner.observeUse(build);
  assert.equal(build.observers.length, 1);
});
