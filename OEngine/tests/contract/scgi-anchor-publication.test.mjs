import assert from "node:assert/strict";
import test from "node:test";
import { ChangeSignal } from "../../.test-dist/core/Signal.js";
globalThis.GPUShaderStage = { COMPUTE: 4, FRAGMENT: 2, VERTEX: 1 };
const { FrameInstanceTransforms } = await import("../../.test-dist/render/FrameInstanceTransforms.js");
const { ScgiAnchors } = await import("../../.test-dist/render/gi/ScgiAnchors.js");

function fixture() {
  const device = {},
    plan = {},
    encoder = {};
  const command = { device, closed: false, gpu_encoder: encoder, onBeforeFinish: new ChangeSignal() };
  const captured = {
    instances: {},
    identities: {},
    mutationSerial: 3,
    contentRevision: 2,
    highWaterCount: 4
  };
  let current = captured;
  let materialCurrent = true;
  const frame = { records: {}, capacity: 4 },
    work = {};
  const frameOwner = Object.assign(Object.create(FrameInstanceTransforms.prototype), {
    states: new Map([[frame, { source: captured.instances, work, encoded: encoder }]])
  });
  const product = { bindingEpoch: "1/1", metadata: {}, banks: [{}, {}, {}, {}] };
  const input = {
    scene: { queryBindings: () => current },
    frameOwner,
    frameInstances: frame,
    work,
    materials: { publication: { data: {} }, isCurrent: () => materialCurrent },
    product
  };
  const encoded = [];
  const anchors = Object.assign(Object.create(ScgiAnchors.prototype), {
    device,
    plan,
    encodeAnchors: (_tx, buffers) => encoded.push(buffers)
  });
  const tx = { state: "encoded", command, workset: { plan } };
  return {
    command,
    captured,
    input,
    encoded,
    anchors,
    tx,
    scene(next) {
      current = next;
    },
    material(next) {
      materialCurrent = next;
    },
    check() {
      command.onBeforeFinish.send1Checked(command);
    }
  };
}

test("scene anchor binds lineage/material/frame records from the actual owners", () => {
  const f = fixture();
  f.anchors.encodeSceneAnchors(f.tx, f.input, {});
  const input = f.encoded[0];
  assert.equal(input.instances, f.input.frameInstances.records);
  assert.equal(input.identities, f.captured.identities);
  assert.equal(input.materials, f.input.materials.publication.data);
  assert.deepEqual(input.product, [f.input.product.metadata, ...f.input.product.banks]);
  f.check();
});

test("retained buffers cannot certify late scene edits or replaced lineage", () => {
  for (const change of [
    { mutationSerial: 4 },
    { contentRevision: 3 },
    { identities: {} },
    { instances: {} },
    { highWaterCount: 5 }
  ]) {
    const f = fixture();
    f.anchors.encodeSceneAnchors(f.tx, f.input, {});
    f.scene({ ...f.captured, ...change });
    assert.throws(() => f.check(), /publication changed/);
  }
});

test("material and Product replacement reject before submit without creating another owner", () => {
  for (const change of [
    (f) => f.material(false),
    (f) => {
      f.input.product.bindingEpoch = "1/2";
    },
    (f) => {
      f.input.product.metadata = {};
    },
    (f) => {
      f.input.product.banks[2] = {};
    }
  ]) {
    const f = fixture();
    f.anchors.encodeSceneAnchors(f.tx, f.input, {});
    change(f);
    assert.throws(() => f.check(), /publication changed/);
  }
  const f = fixture();
  f.material(false);
  assert.throws(() => f.anchors.encodeSceneAnchors(f.tx, f.input, {}), /publication changed/);
  assert.equal(f.encoded.length, 0);
});

test("shared frame records require matching source/work and encoding in this command", () => {
  for (const change of [
    (f) => {
      f.input.work = {};
    },
    (f) => {
      f.command.gpu_encoder = {};
    },
    (f) => {
      f.input.frameInstances = { records: {} };
    }
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => f.anchors.encodeSceneAnchors(f.tx, f.input, {}), /Frame instance/);
    assert.equal(f.encoded.length, 0);
  }
});
