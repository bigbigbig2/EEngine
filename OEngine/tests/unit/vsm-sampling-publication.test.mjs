import assert from "node:assert/strict";
import test from "node:test";

globalThis.GPUShaderStage = { COMPUTE: 4 };
globalThis.GPUBufferUsage = { STORAGE: 128, COPY_SRC: 4 };
const { VsmSamplingPublicationPass, vsmSamplingDescriptorCount } = await import(
  "../../.test-dist/render/vsm/VsmSamplingPublicationPass.js"
);

function fixture() {
  let lose;
  const device = {
    limits: {
      maxStorageBufferBindingSize: 1 << 27,
      maxBufferSize: 1 << 28,
      maxComputeWorkgroupsPerDimension: 65535,
    },
    lost: new Promise((resolve) => {
      lose = resolve;
    }),
    createBindGroupLayout: (value) => value,
    createPipelineLayout: (value) => value,
    createShaderModule: (value) => value,
    createComputePipeline: (value) => value,
    createBindGroup: (value) => value,
  };
  const reads = [],
    outputs = [],
    callbacks = [];
  const graph = {
    add(name, data, encode) {
      callbacks.push({ name, data, encode });
      return {
        read(id) {
          reads.push(id);
        },
        create(name, descriptor) {
          outputs.push({ name, descriptor });
          return 4;
        },
      };
    },
  };
  return { device, graph, reads, outputs, callbacks, lose };
}

test("sampling publication covers fine/coarse planes and depends on post-commit content", () => {
  const f = fixture(),
    owner = new VsmSamplingPublicationPass(f.device);
  assert.equal(vsmSamplingDescriptorCount(128, 6), 98688);
  assert.equal(vsmSamplingDescriptorCount(17, 2), 2 * (17 * 17 + 4));
  assert.equal(
    owner.addToGraph(f.graph, { pages: 128, levels: 6, constants: 1, pageTable: 2, contentVersion: 3 }),
    4,
  );
  assert.deepEqual(f.reads, [1, 2, 3]);
  assert.equal(f.outputs[0].descriptor.size, 1579008);
  assert.equal(f.outputs[0].descriptor.kind, "transient_buffer");
  const resources = {
    get(id) {
      return { size: id === 1 ? 256 : 1579008 };
    },
  };
  const dispatches = [];
  f.callbacks[0].encode(f.callbacks[0].data, resources, {
    encoder: {
      beginComputePass() {
        return {
          setPipeline() {},
          setBindGroup() {},
          dispatchWorkgroups(n) {
            dispatches.push(n);
          },
          end() {},
        };
      },
    },
  });
  assert.deepEqual(dispatches, [1542]);
  owner.destroy();
  assert.throws(() => f.callbacks[0].encode({}, resources, {}), /destroyed before encoding/);
});

test("sampling capacity and device loss reject before creating graph products", async () => {
  const f = fixture(),
    owner = new VsmSamplingPublicationPass(f.device);
  const input = { pages: 128, levels: 6, constants: 1, pageTable: 2, contentVersion: 3 };
  assert.throws(() => vsmSamplingDescriptorCount(0, 6), RangeError);
  assert.throws(() => vsmSamplingDescriptorCount(128, 7), RangeError);
  f.device.limits.maxStorageBufferBindingSize = 256;
  assert.throws(() => owner.addToGraph(f.graph, input), /capacity/);
  assert.equal(f.outputs.length, 0);
  f.lose({ reason: "unknown" });
  await Promise.resolve();
  assert.throws(() => owner.addToGraph(f.graph, input), /destroyed/);
  owner.destroy();
});
