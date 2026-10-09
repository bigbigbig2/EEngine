import test from "node:test";
import assert from "node:assert/strict";
import "../webgpu-test-globals.mjs";
import { LocalLightWorkGenerator } from "../../.test-dist/render/lighting/LocalLightWorkGenerator.js";
import { localLightId, localLightDepthSlice } from "../../.test-dist/gpu/GpuLocalLightWorkAbi.js";
import {
  FrameGraph,
  FrameGraphBindingLayout,
  FrameGraphContext
} from "../../.test-dist/framegraph/FrameGraph.js";

globalThis.GPUBufferUsage ??= { COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 };

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const signal = () => {
  const callbacks = [];
  return {
    addOne(callback) {
      callbacks.push(callback);
    },
    emit() {
      for (const callback of callbacks.splice(0)) callback();
    }
  };
};
const fakeDevice = () => {
  const loss = deferred();
  const buffers = [];
  const device = {
    lost: loss.promise,
    limits: {
      maxStorageBufferBindingSize: 128 * 1024 * 1024,
      maxBufferSize: 256 * 1024 * 1024,
      maxComputeWorkgroupsPerDimension: 65535,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupSizeX: 256,
      maxComputeWorkgroupStorageSize: 16384,
      maxStorageBuffersPerShaderStage: 16
    },
    queue: { writeBuffer() {} },
    createBuffer(descriptor) {
      const buffer = {
        ...descriptor,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        }
      };
      buffers.push(buffer);
      return buffer;
    },
    createShaderModule() {
      return {};
    },
    createBindGroupLayout() {
      return {};
    },
    createPipelineLayout() {
      return {};
    },
    createBindGroup() {
      return {};
    },
    async createComputePipelineAsync() {
      return {
        getBindGroupLayout() {
          return {};
        }
      };
    }
  };
  return { device, buffers, loss };
};
const commandFor = (device) => {
  const fence = deferred();
  const command = {
    device,
    closed: false,
    gpuDone: fence.promise,
    onFinished: signal(),
    onAborted: signal(),
    gpu_encoder: {
      clearBuffer() {},
      beginComputePass() {
        return {
          setPipeline() {},
          setBindGroup() {},
          dispatchWorkgroups() {},
          dispatchWorkgroupsIndirect() {},
          end() {}
        };
      }
    },
    finish() {
      this.closed = true;
      this.onFinished.emit();
    },
    abort() {
      this.closed = true;
      this.onAborted.emit();
    }
  };
  return { command, fence };
};
const requestFor = (ids = new Uint32Array()) => ({
  publication: { buffer: { size: 65536 }, revision: 7, ids, currentRevision: () => 7 },
  view: {
    width: 1920,
    height: 1080,
    near: 0.1,
    far: 2000,
    depthConversion: [0, 0.1],
    projection: [1, 1, 0, 0],
    view: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  },
  visibility: {},
  depth: {},
  deviceEpoch: 3,
  frameIndex: 10,
  mode: ids.length ? 2 : 0
});

test("compiled LightWork recipe late-binds every frame, buffer and command without rebuilding", () => {
  const first = {
    frame: { parameters: {}, lookup: {}, data: {}, request: { view: { width: 32, height: 32 } } },
    visibility: { view: {} },
    depth: { view: {} },
    database: {},
    command: {}
  };
  const second = {
    frame: { parameters: {}, lookup: {}, data: {}, request: { view: { width: 32, height: 32 } } },
    visibility: { view: {} },
    depth: { view: {} },
    database: {},
    command: {}
  };
  const graph = new FrameGraph("local-light cached recipe");
  const layout = new FrameGraphBindingLayout();
  const bind = (name, resolve) => layout.slot(name, first, resolve);
  const imported = (name, resolve) => graph.import_resource(name, { kind: "imported" }, bind(name, resolve));
  const observed = [];
  const owner = Object.create(LocalLightWorkGenerator.prototype);
  owner.encode = (command, frame, inputs) => observed.push({ command, frame, inputs });
  const product = owner.addToGraph(
    graph,
    bind("job", (b) => ({ frame: b.frame })),
    {
      parameters: bind("parameters", (b) => b.frame.parameters),
      lookup: bind("lookup", (b) => b.frame.lookup),
      data: bind("data", (b) => b.frame.data)
    },
    {
      visibility: imported("winner", (b) => b.visibility),
      depth: imported("depth", (b) => b.depth),
      database: imported("database", (b) => b.database)
    }
  );
  const consumer = graph.add("native consumer", {}, (_job, resources) => {
    observed.at(-1).data = resources.get(product.data);
  });
  consumer.read(product.data);
  consumer.make_side_effect();
  const compiled = graph.compile();
  for (const bindings of [first, second]) {
    compiled.execute(new FrameGraphContext({ encoder: bindings.command }), bindings);
  }
  assert.equal(observed.length, 2);
  for (const [index, bindings] of [first, second].entries()) {
    assert.equal(observed[index].command, bindings.command);
    assert.equal(observed[index].frame, bindings.frame);
    assert.equal(observed[index].data, bindings.frame.data);
    assert.equal(observed[index].inputs.visibility, bindings.visibility);
    assert.equal(observed[index].inputs.depth, bindings.depth);
  }
});

test("typed IDs reject identity truncation and log-depth end slices are unbounded", () => {
  assert.equal(localLightId(0xffffff, 1), 0x1ffffff);
  for (const [slot, type] of [
    [0x1000000, 0],
    [-1, 0],
    [0, 2],
    [1.5, 1]
  ])
    assert.throws(() => localLightId(slot, type));
  assert.equal(localLightDepthSlice(0, 0.1, 2000), 0);
  assert.equal(localLightDepthSlice(1e30, 0.1, 2000), 23);
});

test("consumer runtime array has one physical word even with zero logical lights", async () => {
  const { device } = fakeDevice();
  const owner = new LocalLightWorkGenerator(device, 3);
  await owner.ready;
  const frame = owner.prepare(requestFor());
  assert.equal(frame.data.size, 132);
  owner.destroy();
  assert.equal(owner.allocatedBytes, 0);
});

test("maximum admitted profile and three retained allocations remain below 6/18MiB", async () => {
  const { device } = fakeDevice();
  const owner = new LocalLightWorkGenerator(device, 3);
  await owner.ready;
  const ids = new Uint32Array(16380);
  for (let slot = 0; slot < ids.length; slot++) ids[slot] = localLightId(slot, 0);
  const frames = [
    owner.prepare(requestFor(ids)),
    owner.prepare(requestFor(ids)),
    owner.prepare(requestFor(ids))
  ];
  for (const frame of frames) assert.ok(frame.reservedBytes <= 6 * 1024 * 1024);
  assert.ok(owner.allocatedBytes <= 18 * 1024 * 1024);
  assert.throws(() => owner.prepare(requestFor(ids)), /in-flight capacity/);
  owner.destroy();
});

test("snapshot, stale revision, abort/retry and reused-slot ABA do not advance an old frame", async () => {
  const { device } = fakeDevice();
  const owner = new LocalLightWorkGenerator(device, 3);
  await owner.ready;
  const request = requestFor(new Uint32Array([localLightId(0, 0)]));
  const first = owner.prepare(request);
  request.publication.ids[0] = 99;
  request.view.view[0] = 2;
  assert.equal(first.request.publication.ids[0], 0);
  assert.equal(first.request.view.view[0], 1);
  owner.abort(first);
  const second = owner.prepare(requestFor(new Uint32Array([0])));
  const { command } = commandFor(device);
  assert.throws(() => owner.encode(command, first), /stale/);
  owner.encode(command, second);
  command.abort();
  const third = owner.prepare(requestFor(new Uint32Array([0])));
  owner.abort(second);
  const retry = commandFor(device);
  owner.encode(retry.command, third);
  retry.command.abort();
  assert.equal(owner.inFlightBytes, 0);
  const staleRequest = requestFor();
  staleRequest.publication.currentRevision = () => 8;
  assert.throws(() => owner.prepare(staleRequest), /stale/);
  owner.destroy();
});

test("epoch and scan limits reject before pipeline/resource construction", async () => {
  const { device } = fakeDevice();
  assert.throws(() => new LocalLightWorkGenerator(device, 0x100000000), /epoch/);
  device.limits.maxComputeInvocationsPerWorkgroup = 128;
  assert.throws(() => new LocalLightWorkGenerator(device, 3), /portable scan/);
});

test("three distinct slots retain admission until abort or their submitted fence", async () => {
  const { device } = fakeDevice();
  const owner = new LocalLightWorkGenerator(device, 3);
  await owner.ready;
  const frames = [owner.prepare(requestFor()), owner.prepare(requestFor()), owner.prepare(requestFor())];
  const a = commandFor(device),
    b = commandFor(device),
    c = commandFor(device);
  owner.encode(a.command, frames[0]);
  owner.encode(b.command, frames[1]);
  owner.encode(c.command, frames[2]);
  assert.throws(() => owner.prepare(requestFor()), /in-flight capacity/);
  a.command.abort();
  const replacement = owner.prepare(requestFor());
  assert.equal(replacement.data, frames[0].data);
  owner.abort(replacement);
  b.command.abort();
  c.command.abort();
  owner.destroy();
  assert.equal(owner.allocatedBytes, 0);
});

test("retirement retains submitted allocations until their exact fence, not replacement completion", async () => {
  const { device, buffers } = fakeDevice();
  const owner = new LocalLightWorkGenerator(device, 3);
  await owner.ready;
  const first = owner.prepare(requestFor());
  const a = commandFor(device);
  owner.encode(a.command, first);
  a.command.finish();
  const replacement = owner.prepare({
    ...requestFor(),
    view: { ...requestFor().view, width: 1280, height: 720 }
  });
  const b = commandFor(device);
  owner.encode(b.command, replacement);
  b.command.finish();
  owner.destroy();
  assert.ok(owner.allocatedBytes > 0);
  assert.equal(first.data.destroyed, false);
  b.fence.resolve();
  await Promise.resolve();
  assert.equal(replacement.data.destroyed, true);
  assert.equal(first.data.destroyed, false);
  a.fence.resolve();
  await Promise.resolve();
  assert.equal(owner.allocatedBytes, 0);
  assert.ok(buffers.every((buffer) => buffer.destroyed));
});

test("device loss cancels prepared work and rejects the old epoch", async () => {
  const { device, loss } = fakeDevice();
  const owner = new LocalLightWorkGenerator(device, 3);
  await owner.ready;
  const frame = owner.prepare(requestFor());
  loss.resolve({ reason: "destroyed" });
  await Promise.resolve();
  assert.equal(owner.allocatedBytes, 0);
  assert.throws(() => owner.encode(commandFor(device).command, frame), /stale/);
});
