import "../webgpu-test-globals.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { cookImageTexture } from "../../.test-dist/assets/codec/ImageTextureCook.js";
import { ImageTexturePages } from "../../.test-dist/assets/ImageTexturePages.js";
import { VirtualTextureResidency } from "../../.test-dist/gpu/VirtualTextureResidency.js";
import { ResourceAccounting } from "../../.test-dist/debug/profiling/ResourceAccounting.js";
globalThis.GPUBufferUsage ??= { COPY_SRC: 1, COPY_DST: 2, STORAGE: 4, MAP_READ: 8, INDIRECT: 16 };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function source(width = 1045, height = 133) {
  const inputs = [];
  for (let w = width, h = height; ; w = Math.max(1, Math.floor(w / 2)), h = Math.max(1, Math.floor(h / 2))) {
    inputs.push({width: w, height: h, rgba: new Uint8Array(w * h * 4)});
    if (w === 1 && h === 1) break;
  }
  const {directory} = await cookImageTexture({ semantic: "scalar-r", quality: "high", mode: "virtual",
    mips: "provided", inputs, toolHash: "a".repeat(64), cellSize: 128,
    addressU: "repeat", addressV: "repeat"
  }, { encodeAvif: async () => new Uint8Array([1]), put: async (hash) => hash + ".avif" });
  const pages = new ImageTexturePages(directory);
  const reads = [], leases = [];
  return {
    directory: pages.directory, pages, reads, leases,
    async readPage(plan, signal) {
      signal?.throwIfAborted();
      reads.push(plan);
      const result = plan.owners.map((id) => {
        const lease = { item: directory.items[id], closed: false, close() { this.closed = true; } };
        leases.push(lease);
        return lease;
      });
      return result;
    }
  };
}
function fixture(cold) {
  const loss = deferred();
  const transcoder = {
    recordTailLevel() { return "recorded"; },
    recordPage() { return "recorded"; }
  };
  const textures = [];
  const graphics = {
    resource_accounting: new ResourceAccounting(),
    device: {
      features: new Set(["texture-compression-bc"]),
      limits: {
        maxTextureDimension2D: 8192,
        maxTextureArrayLayers: 256,
        maxStorageBuffersPerShaderStage: 16,
        maxSampledTexturesPerShaderStage: 19,
        maxSamplersPerShaderStage: 16,
        maxBufferSize: 256 * 1024 ** 2,
        maxStorageBufferBindingSize: 128 * 1024 ** 2,
      },
      lost: loss.promise,
      createTexture(descriptor) {
        const texture = {
          ...descriptor,
          width: descriptor.size[0],
          height: descriptor.size[1],
          depthOrArrayLayers: descriptor.size[2],
          destroyed: false,
          createView() {
            return { texture };
          },
          destroy() {
            this.destroyed = true;
          },
        };
        if (descriptor.format === "rg32uint") {
          texture.words = new Uint32Array(descriptor.size[0] * descriptor.size[1] * 2);
        }
        textures.push(texture);
        return texture;
      },
      createBuffer(descriptor) {
        return {
          ...descriptor,
          bytes: new ArrayBuffer(descriptor.size),
          destroyed: false,
          getMappedRange() {
            return this.bytes;
          },
          unmap() {},
          mapAsync: () => new Promise(() => {}),
          destroy() {
            this.destroyed = true;
          },
        };
      },
      createBindGroupLayout: (value) => value,
      createBindGroup: (value) => value,
      createPipelineLayout: (value) => value,
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createComputePipelineAsync: async () => ({}),
      queue: {
        writeTexture({ texture }, values) {
          texture.words?.set(values);
        },
        onSubmittedWorkDone: async () => {},
      },
    },
  };
  const command = () => {
    const finished = [],
      aborted = [],
      before = [],
      operations = [],
      done = deferred();
    const copies = [];
    return {
      device: graphics.device,
      closed: false,
      gpuDone: done.promise,
      copies,
      onBeforeFinish: { addOne: (fn) => before.push(fn) },
      onFinished: { addOne: (fn) => finished.push(fn) },
      onAborted: { addOne: (fn) => aborted.push(fn) },
      copyBufferToTexture(from, to, extent) {
        copies.push({ from, to, extent });
        operations.push(() => {
          if (to.texture.words) {
            const [width, height] = extent;
            const [x, y] = to.origin;
            for (let row = 0; row < height; row++) {
              const source = new Uint32Array(from.buffer.bytes, row * from.bytesPerRow, width * 2);
              to.texture.words.set(source, ((y + row) * 1024 + x) * 2);
            }
          }
        });
      },
      copyBufferToBuffer() {},
      clearBuffer() {},
      gpu_encoder: {
        beginComputePass: () => ({
          setPipeline() {},
          setBindGroup() {},
          dispatchWorkgroups() {},
          dispatchWorkgroupsIndirect() {},
          end() {},
        }),
      },
      finish() {
        before.forEach((fn) => fn());
        operations.forEach((fn) => fn());
        this.closed = true;
        finished.forEach((fn) => fn());
      },
      abort() {
        this.closed = true;
        aborted.forEach((fn) => fn());
      },
      complete() {
        done.resolve();
      },
    };
  };
  return {
    graphics,
    command,
    textures,
    source: cold,
    transcoder,
    batch: async (record) => record(command()),
  };
}

// Structural scheduler checks only. Real image assembly/BC sampling stays in the
// new image GPU oracles, run as a complete matrix in E5.
test("new image VT keeps query demand fair under primary pressure", async () => {
  const cold = await source(2048, 2048);
  const f = fixture(cold);
  const vt = new VirtualTextureResidency(f.graphics, f.transcoder, {scalarBytes: 2654208});
  try {
    const command = f.command();
    vt.stage(cold, command);
    await vt.bootstrap(cold, command, f.batch);
    command.finish(); command.complete();
    const pages = vt.snapshot.filter((page) => page && !page.pinned);
    const primary = pages.slice(0, 256), query = pages.slice(256);
    const observe = (wanted, frame, low = false) => vt.observe({frame, view: 0, snapshot: vt.snapshot,
      wanted: wanted.map((page) => page.id), used: []}, low);
    observe(primary, 1); observe(query, 1, true);
    assert.ok([...vt.admitted].filter((page) => query.includes(page)).length >= Math.floor(255 / 8));
    observe(primary, 2);
    assert.ok(query.every((page) => vt.desired.has(page)));
    const granted = new Set([...vt.admitted].filter((page) => query.includes(page)));
    for (let epoch = 1; epoch <= 8; epoch++) {
      observe(query, epoch * 8, true);
      for (const page of vt.admitted) if (query.includes(page)) granted.add(page);
    }
    assert.equal(granted.size, query.length);
    observe([], 80, true);
    assert.ok(primary.every((page) => vt.desired.has(page)));
  } finally { vt.destroy(); await tick(); }
});

test("new image VT hidden tail abort waits for its producer and retires ready leases", async () => {
  const cold = await source();
  const f = fixture(cold);
  const vt = new VirtualTextureResidency(f.graphics, f.transcoder);
  const entered = deferred(), finish = deferred();
  try {
    const command = f.command();
    vt.stage(cold, command);
    const pending = vt.bootstrap(cold, command, async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    command.abort();
    await tick();
    assert.equal(vt.sourceCount, 1, "a running hidden producer keeps its destination alive");
    finish.resolve();
    await assert.rejects(pending, /abort|cancel/i);
    await tick(); await tick();
    assert.equal(vt.sourceCount, 0);
    assert.ok(cold.leases.every((lease) => lease.closed));
  } finally { finish.resolve(); vt.destroy(); await tick(); }
});

test("new image VT NPOT parent closure and failed encoder return free slots", async () => {
  const cold = await source();
  const f = fixture(cold);
  const vt = new VirtualTextureResidency(f.graphics, f.transcoder);
  try {
    const boot = f.command();
    const route = vt.stage(cold, boot).get(0);
    await vt.bootstrap(cold, boot, f.batch);
    boot.finish(); boot.complete(); await tick();
    const page = vt.snapshot[route.mips[2].base + 2];
    assert.deepEqual(page.parents, [route.mips[3].base, route.mips[3].base + 1, route.mips[4].base, route.mips[5].base]);
    vt.observe({frame: 1, view: 0, snapshot: vt.snapshot, wanted: [page.id], used: []});
    await tick();
    const command = f.command();
    vt.prepareFrame(command, 2, "");
    const pool = [...vt.pools.values()][0];
    const before = pool.free.length;
    f.transcoder.recordPage = () => { throw new Error("controlled image encoding failure"); };
    assert.throws(() => vt.encodeUploads(command), /controlled image/);
    command.abort();
    assert.equal(pool.free.length, before);
    assert.equal(vt.mappingGeneration(), 1);
  } finally { vt.destroy(); await tick(); }
});
