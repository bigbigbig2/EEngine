import test from "node:test";
import assert from "node:assert/strict";
import "../webgpu-test-globals.mjs";
import { NativeTemporalFactsPass } from "../../.test-dist/render/temporal/NativeTemporalFactsPass.js";

globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };

function fixture() {
  const textures = [];
  const gpu = {
    lost: new Promise(() => {}),
    limits: {
      maxTextureDimension2D: 8192,
      maxStorageTexturesPerShaderStage: 4,
      maxStorageBuffersPerShaderStage: 8,
      maxSampledTexturesPerShaderStage: 16,
      maxUniformBuffersPerShaderStage: 12
    },
    createBindGroupLayout: (descriptor) => descriptor,
    createPipelineLayout: (descriptor) => descriptor,
    createComputePipeline: (descriptor) => descriptor,
    createShaderModule: (descriptor) => descriptor,
    createBuffer: () => ({ destroy() {} }),
    createBindGroup: (descriptor) => descriptor,
    createTexture(descriptor) {
      const texture = {
        descriptor,
        destroyed: false,
        createView: () => ({ texture }),
        destroy() {
          this.destroyed = true;
        }
      };
      textures.push(texture);
      return texture;
    }
  };
  const owner = new NativeTemporalFactsPass(gpu);
  return { gpu, textures, owner };
}

test("native Temporal resize abort preserves committed history and commit retires it at the frame fence", async () => {
  const { owner, textures } = fixture();
  owner.prepareFrame(2, 2, 0, 1, false);
  assert.equal(owner.allocatedBytes, 32 + 2 * 2 * 32);
  const original = owner.history("write");
  let finish;
  const fence = new Promise((resolve) => {
    finish = resolve;
  });
  owner.commit(fence);
  owner.prepareFrame(3, 3, 1, 0, true);
  assert.equal(owner.allocatedBytes, 32 + (4 + 9) * 32);
  owner.abort();
  assert.equal(textures[2].destroyed, true);
  assert.equal(textures[3].destroyed, true);
  owner.prepareFrame(2, 2, 1, 0, true);
  assert.equal(owner.history("read"), original);
  owner.abort();
  owner.prepareFrame(3, 3, 1, 0, true);
  owner.commit(Promise.resolve());
  assert.equal(original.destroyed, false);
  assert.equal(owner.allocatedBytes, 32 + (4 + 9) * 32);
  finish();
  await fence;
  await Promise.resolve();
  assert.equal(original.destroyed, true);
  assert.equal(owner.allocatedBytes, 32 + 9 * 32);
  owner.destroy();
});

test("native Temporal graph declares real native versions and opaque reactive reads and f32 motion", () => {
  const { owner } = fixture();
  owner.prepareFrame(3, 5, 0, 1, false);
  const reads = [];
  const products = [];
  let next = 100;
  const graph = {
    import_resource: () => next++,
    add() {
      return {
        read(id) {
          reads.push(id);
        },
        create(name, descriptor) {
          products.push({ name, descriptor });
          return next++;
        },
        write: (id) => id
      };
    }
  };
  const inputs = {
    width: 3,
    height: 5,
    materialSlotCount: 2,
    visibility: 1,
    depth: 2,
    opaqueReactive: 3,
    meshletWork: 4,
    instances: 5,
    materialVersions: 9,
    currentCamera: 10,
    previousCamera: 11,
    assetMetadata: 12,
    vertexPayload: 13,
    sourceBindings: { meshletWordBase: 0, vertexDataWordBase: 0 }
  };
  const result = owner.addToGraph(graph, inputs, (_name, resolve) => resolve(owner));
  assert.ok(reads.includes(inputs.materialVersions));
  assert.ok(reads.includes(inputs.opaqueReactive));
  assert.equal(products[0].descriptor.format, "rg32float");
  assert.equal(products[1].descriptor.format, "rgba8unorm");
  assert.notEqual(result.identity, result.mask);
  owner.abort();
  owner.destroy();
});

test("native Temporal rejects invalid roles and extents before allocating identity", () => {
  const { owner, textures } = fixture();
  assert.throws(() => owner.prepareFrame(1, 1, 0, 0, false), /alias/);
  assert.throws(() => owner.prepareFrame(9000, 1, 0, 1, false), /limits/);
  assert.equal(textures.length, 0);
  owner.destroy();
});

test("native Temporal reset survives abort and applies to retry, then commit clears it", () => {
  const { owner } = fixture();
  owner.prepareFrame(1, 1, 0, 1, false);
  owner.commit(Promise.resolve());
  owner.invalidate();
  owner.prepareFrame(1, 1, 1, 0, true);
  owner.abort();
  const encode = () => {
    owner.prepareFrame(1, 1, 1, 0, true);
    let callback;
    let next = 100;
    const graph = {
      import_resource: () => next++,
      add(_name, _data, run) {
        callback = run;
        return { read() {}, create: () => next++, write: (id) => id };
      }
    };
    const input = {
      width: 1,
      height: 1,
      materialSlotCount: 1,
      sourceBindings: { meshletWordBase: 0, vertexDataWordBase: 0 }
    };
    owner.addToGraph(graph, input, (_name, resolve) => resolve(owner));
    let previousValid;
    callback(
      input,
      { get: () => ({}) },
      {
        encoder: {
          writeBuffer(_buffer, _offset, data) {
            previousValid = new Uint32Array(data)[2];
          },
          beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} })
        }
      }
    );
    owner.commit(Promise.resolve());
    return previousValid;
  };
  assert.equal(encode(), 0);
  assert.equal(encode(), 1);
  owner.destroy();
});
