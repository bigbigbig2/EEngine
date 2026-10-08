import assert from "node:assert/strict";
import test from "node:test";
globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUBufferUsage ??= {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512
};
globalThis.GPUTextureUsage ??= {
  COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16
};
const { Renderer } = await import("../../.test-dist/render/pipeline/RendererCore.js");
const { ShadeGPUCommandContext } = await import("../../.test-dist/framegraph/ShadeGPUCommandContext.js");

function fixture(owned, multi = true) {
  const events = [];
  const renderer = new Renderer();
  const scene = {};
  let published = true;
  let resolve, reject;
  const fence = new Promise((yes, no) => { resolve = yes; reject = no; });
  let released = false;
  let streamingReleased = false;
  const destroyProduct = () => {
    if (!released) { released = true; events.push("product/source"); }
  };
  const state = {
    releaseWithScene: owned,
    streamingRuntime: { destroy: () => {
      if (!streamingReleased) { streamingReleased = true; events.push("streaming"); }
    } },
    residency: { destroy: destroyProduct },
    ...(multi ? { multiRuntime: { destroy: destroyProduct } } : {})
  };
  renderer._virtualProductScenes.set(scene, state);
  renderer._graphics = {
    render_world: {
      runtime: () => published ? {} : null,
      release: () => { published = false; events.push("withdraw"); return []; }
    },
    assets: { releaseMany() {} },
    destroy() {}
  };
  renderer._visibilityFeature = { release() {}, destroy() {} };
  renderer._views = { releaseScene() {}, destroy() {} };
  renderer._environments = { release() {}, destroy() {} };
  renderer.device = { queue: { onSubmittedWorkDone: async () => { events.push("retry fence"); } } };
  const create = ShadeGPUCommandContext.create;
  ShadeGPUCommandContext.create = () => ({
    finish() { events.push("submit"); },
    gpuDone: fence,
    abort() {}
  });
  return { renderer, scene, events, resolve, reject, restore: () => { ShadeGPUCommandContext.create = create; } };
}

for (const multi of [false, true]) {
  test(`owned ${multi ? "multi" : "single"} Product releases after Scene GPU fence, once`, async () => {
    const f = fixture(true, multi);
    try {
      const release = f.renderer.releaseScene(f.scene);
      assert.deepEqual(f.events, ["withdraw", "submit", "streaming"]);
      assert.equal(f.renderer._virtualProductScenes.size, 1);
      f.resolve();
      await release;
      assert.deepEqual(f.events, ["withdraw", "submit", "streaming", "product/source"]);
      assert.equal(f.renderer._virtualProductScenes.size, 0);
      await f.renderer.releaseScene(f.scene);
      f.renderer.destroy();
      f.renderer.destroy();
      assert.equal(f.events.filter((event) => event === "product/source").length, 1);
    } finally { f.restore(); }
  });
}

test("borrowed publication release leaves admission ownership to caller", async () => {
  const f = fixture(false);
  try {
    const release = f.renderer.releaseVirtualGeometryScene(f.scene);
    f.resolve();
    await release;
    f.renderer.destroy();
    assert.deepEqual(f.events, ["withdraw", "submit"]);
  } finally { f.restore(); }
});

test("rejected live fence retains owned Product registration for teardown", async () => {
  const f = fixture(true);
  try {
    const release = f.renderer.releaseScene(f.scene);
    f.reject(new Error("live fence rejected"));
    await assert.rejects(release, /live fence rejected/);
    assert.equal(f.renderer._virtualProductScenes.size, 1);
    assert.ok(!f.events.includes("product/source"));
    f.renderer.destroy();
    assert.equal(f.events.filter((event) => event === "product/source").length, 1);
  } finally { f.restore(); }
});

test("withdrawn Scene retries a failed fence without a second submission", async () => {
  const f = fixture(true);
  try {
    const release = f.renderer.releaseScene(f.scene);
    f.reject(new Error("live fence rejected"));
    await assert.rejects(release, /live fence rejected/);
    await f.renderer.releaseScene(f.scene);
    assert.deepEqual(f.events, ["withdraw", "submit", "streaming", "retry fence", "product/source"]);
    assert.equal(f.renderer._virtualProductScenes.size, 0);
    f.renderer.destroy();
  } finally { f.restore(); }
});

test("late unload fence cannot release a newly published Scene Product", async () => {
  const f = fixture(true);
  try {
    const release = f.renderer.releaseScene(f.scene);
    const replacement = {
      releaseWithScene: true,
      streamingRuntime: null,
      residency: { destroy: () => f.events.push("replacement/source") }
    };
    f.renderer._virtualProductScenes.set(f.scene, replacement);
    f.resolve();
    await release;
    assert.ok(f.events.includes("product/source"));
    assert.ok(!f.events.includes("replacement/source"));
    assert.equal(f.renderer._virtualProductScenes.get(f.scene), replacement);
    f.renderer.destroy();
    assert.ok(f.events.includes("replacement/source"));
  } finally { f.restore(); }
});
