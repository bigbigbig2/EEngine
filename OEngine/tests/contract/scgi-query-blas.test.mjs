import "../webgpu-test-globals.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { ScgiQueryBlas } from "../../.test-dist/render/gi/ScgiQueryBlas.js";

globalThis.GPUBufferUsage = { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8 };

test("static BLAS reuse requires a submitted exact cut and retires with its last holder", async () => {
  const buffers = [];
  const device = {
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
    }
  };
  const plan = { primitiveCapacity: 8, hierarchy: { bytes: 512 } };
  const descriptor = {};
  const lease = {
    cut: { descriptor, clusters: new Uint32Array([1, 3, 5]) },
    segments: [{ metadata: { size: 160 } }]
  };
  const acquire = (value = lease) => ScgiQueryBlas.acquire(device, plan, value, 0, 0, 0, 3);
  const first = acquire();
  const aborted = acquire();
  assert.notEqual(first.entry, aborted.entry, "preparing candidates cannot reuse unfinished nodes");
  let observer;
  first.entry.observeBuild({
    observeSubmission(value) {
      observer = value;
    }
  });
  observer.submitted(Promise.resolve());
  const shared = acquire();
  assert.equal(shared.build, false);
  assert.equal(shared.entry, first.entry);
  const different = acquire({ ...lease, cut: { descriptor, clusters: new Uint32Array([1, 3, 6]) } });
  assert.notEqual(different.entry, first.entry, "full cut identity, not primitive count alone");
  aborted.entry.release();
  different.entry.release();
  first.entry.release();
  assert.equal(shared.entry.buffer.destroyed, false, "last consumer still owns immutable BLAS");
  shared.entry.release();
  assert.ok(buffers.every((buffer) => buffer.destroyed));
  const retry = acquire();
  assert.equal(retry.build, true, "retired entries do not remain as an idle cache");
  retry.entry.release();
});

test("failed shared BLAS submission is quarantined from later candidates", async () => {
  const device = { createBuffer: (descriptor) => ({ ...descriptor, destroy() {} }) };
  const plan = { primitiveCapacity: 1, hierarchy: { bytes: 256 } };
  const lease = {
    cut: { descriptor: {}, clusters: new Uint32Array([0]) },
    segments: [{ metadata: { size: 160 } }]
  };
  const acquire = () => ScgiQueryBlas.acquire(device, plan, lease, 0, 0, 0, 1);
  const first = acquire();
  let observer;
  first.entry.observeBuild({
    observeSubmission(value) {
      observer = value;
    }
  });
  observer.submitted(Promise.reject(new Error("controlled fence failure")));
  await Promise.resolve();
  const next = acquire();
  assert.notEqual(next.entry, first.entry);
  assert.equal(next.build, true);
  next.entry.release();
  first.entry.release();
});
