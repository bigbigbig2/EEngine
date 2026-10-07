import assert from "node:assert/strict";
import test from "node:test";
import { NativeMaterialProducts } from "../../.test-dist/gpu/NativeMaterialProducts.js";

globalThis.GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2 };
function fixture() {
  const signals = () => ({
    listeners: [],
    addOne(fn) {
      this.listeners.push(fn);
    }
  });
  const textures = [],
    copies = [];
  const device = {
    lost: new Promise(() => {}),
    limits: { maxTextureDimension2D: 4096, maxTextureArrayLayers: 256, maxBufferSize: 1 << 27 },
    createTexture(descriptor) {
      const texture = {
        descriptor,
        destroyed: false,
        createView: () => ({}),
        destroy() {
          this.destroyed = true;
        }
      };
      textures.push(texture);
      return texture;
    }
  };
  const command = {
    device,
    closed: false,
    onAborted: signals(),
    onFinished: signals(),
    onBeforeFinish: signals(),
    allocateTextureUploadBuffer: (bytes) => ({ bytes }),
    copyBufferToTexture(source, target, size) {
      copies.push({ source, target, size });
    },
    abort() {
      this.closed = true;
      this.onAborted.listeners.forEach((fn) => fn());
    }
  };
  const field = {
    contentKey: "half-field",
    width: 1,
    format: "r16float",
    mips: [
      { width: 2, height: 1, payload: new Uint8Array([0, 60, 0, 56]) },
      { width: 1, height: 1, payload: new Uint8Array([0, 58]) }
    ]
  };
  const graph = { productReads: [{ field }] };
  return { device, command, textures, copies, field, graph };
}

test("native packed Products preserve half bits, mip boundaries and deduplicate exact fields", () => {
  const f = fixture();
  const owner = new NativeMaterialProducts(f.device, [f.graph, f.graph], f.command);
  assert.deepEqual(owner.field(f.field).offsets, [0, 4]);
  assert.equal(f.textures.length, 1);
  assert.deepEqual(
    [...new Uint8Array(f.copies[0].source.buffer.bytes).subarray(0, 10)],
    [0, 60, 0, 56, 0, 0, 0, 0, 0, 58]
  );
  assert.equal(owner.physicalBytes, 256);
  f.command.abort();
  assert.equal(owner.allocatedBytes, 0);
  assert.throws(() => owner.field(f.field), /no longer consumable/);
});

test("native Product capacity and malformed mip preflight precede GPU allocation", () => {
  const f = fixture();
  assert.throws(() => new NativeMaterialProducts(f.device, [f.graph], f.command, 2), /capacity/);
  assert.equal(f.textures.length, 0);
  const bad = { ...f.field, mips: [{ width: 4, height: 1, payload: new Uint8Array(2) }] };
  assert.throws(
    () => new NativeMaterialProducts(f.device, [{ productReads: [{ field: bad }] }], f.command),
    /exact original mip/
  );
  assert.equal(f.textures.length, 0);
});

test("native Product retirement blocks consumers and waits even when completion rejects", async () => {
  const f = fixture();
  const owner = new NativeMaterialProducts(f.device, [f.graph], f.command);
  f.command.onBeforeFinish.listeners.forEach((fn) => fn());
  f.command.onFinished.listeners.forEach((fn) => fn());
  let reject;
  const completion = new Promise((_, fail) => {
    reject = fail;
  });
  const retired = owner.retire(completion);
  assert.throws(() => owner.field(f.field), /no longer consumable/);
  assert.equal(f.textures[0].destroyed, false);
  reject(new Error("lost completion"));
  await assert.rejects(retired, /lost completion/);
  assert.equal(f.textures[0].destroyed, true);
  assert.equal(owner.allocatedBytes, 0);
});
