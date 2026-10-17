import assert from "node:assert/strict";
import test from "node:test";
import { GeometryQueryInstanceSnapshot } from "../../.test-dist/gpu/GeometryQueryInstanceSnapshot.js";
import { ResourceAccounting } from "../../.test-dist/debug/profiling/ResourceAccounting.js";
import { ChangeSignal } from "../../.test-dist/core/Signal.js";

globalThis.GPUBufferUsage = { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4 };

function fixture() {
  const buffers = [];
  let binding = { highWaterCount: 3, contentRevision: 2, mutationSerial: 0,
    instances: { size: 3 * 176 }, identities: { size: 3 * 16 } };
  const device = {
    limits: { maxBufferSize: 4096, maxStorageBufferBindingSize: 4096 },
    lost: new Promise(() => {}),
    createBuffer(descriptor) {
      const buffer = { ...descriptor, destroyed: false,
        destroy() { this.destroyed = true; } };
      buffers.push(buffer);
      return buffer;
    },
  };
  const scene = { queryBindings: () => binding };
  const command = () => ({ device, closed: false, copies: [], observers: [],
    onBeforeFinish: new ChangeSignal(), onFinished: new ChangeSignal(),
    copyBufferToBuffer(...args) { this.copies.push(args); },
    observeSubmission(observer) { this.observers.push(observer); },
  });
  return { device, scene, buffers, command,
    mutate() { binding = { ...binding, contentRevision: binding.contentRevision + 1 }; },
  };
}

test("query shards share exactly one immutable scene/lineage copy", () => {
  const f = fixture();
  const snapshot = new GeometryQueryInstanceSnapshot(f.device, f.scene, new ResourceAccounting());
  const command = f.command();
  snapshot.encode(command);
  snapshot.encode(command);
  assert.equal(command.copies.length, 2);
  assert.equal(command.copies[0][4], 3 * 176);
  assert.equal(command.copies[1][4], 3 * 16);
  assert.throws(() => snapshot.encode(f.command()), /unsubmitted producer/);
  command.closed = true;
  command.observers[0].submitted(Promise.resolve());
  command.onFinished.send1(command);
  f.mutate();
  const consumer = f.command();
  snapshot.encode(consumer);
  assert.equal(consumer.copies.length, 0, "later mutations do not overwrite the captured scene");
  assert.throws(() => snapshot.assertCurrent(consumer), /GpuScene changed/);
  snapshot.destroy();
  assert.ok(f.buffers.every((buffer) => buffer.destroyed));
});

test("query pre-submit guard rejects edits encoded after the snapshot copy", () => {
  const f = fixture();
  const snapshot = new GeometryQueryInstanceSnapshot(f.device, f.scene);
  const command = f.command();
  snapshot.encode(command);
  snapshot.assertCurrent(command);
  f.mutate();
  assert.throws(() => command.onBeforeFinish.send1Checked(command), /GpuScene changed/);
  command.observers[0].aborted(new Error("stale scene"));
  assert.equal(snapshot.valid, false);
});

test("query preparation detects scene changes; abort and failed submission have distinct ownership", async () => {
  const f = fixture();
  const stale = new GeometryQueryInstanceSnapshot(f.device, f.scene);
  f.mutate();
  const command = f.command();
  assert.throws(() => stale.encode(command), /GpuScene changed/);
  assert.equal(command.copies.length, 0);
  stale.destroy();
  const aborted = new GeometryQueryInstanceSnapshot(f.device, f.scene);
  const abortCommand = f.command();
  aborted.encode(abortCommand);
  abortCommand.observers[0].aborted(new Error("cancel"));
  assert.equal(aborted.valid, false);
  assert.equal(aborted.sourceSnapshot.destroyed, true);
  const failed = new GeometryQueryInstanceSnapshot(f.device, f.scene);
  const submitted = f.command();
  failed.encode(submitted);
  submitted.closed = true;
  submitted.observers[0].submitted(Promise.reject(new Error("fence failure")));
  await Promise.resolve();
  assert.equal(failed.valid, false);
  assert.equal(failed.sourceSnapshot.destroyed, false, "failed fence quarantines allocation");
  failed.destroy();
});

test("candidate query copy is tied to its mutation command and detects an aborted ABA", () => {
  const f = fixture();
  const command = f.command();
  const snapshot = new GeometryQueryInstanceSnapshot(f.device, f.scene, undefined, command);
  assert.throws(() => snapshot.encode(f.command()), /mutation command/);
  assert.equal(command.copies.length, 0);
  snapshot.encode(command);
  assert.equal(command.copies.length, 2);
  command.observers[0].aborted(new Error("cancel candidate"));
  assert.equal(snapshot.valid, false);

  let serial = 4;
  const stable = f.scene.queryBindings();
  f.scene.queryBindings = () => ({ ...stable, mutationSerial: serial });
  const stale = new GeometryQueryInstanceSnapshot(f.device, f.scene);
  // The mutation was aborted, so content revision and buffer identity are the
  // same. Its admission serial still prevents this prepared copy from an ABA.
  serial++;
  assert.throws(() => stale.encode(f.command()), /GpuScene changed/);
  stale.destroy();
});
