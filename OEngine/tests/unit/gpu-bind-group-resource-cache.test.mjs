import assert from "node:assert/strict";
import test from "node:test";

import {
  GpuBindGroupResourceCache
} from "../.test-dist/gpu/GpuBindGroupResourceCache.js";

test("bind-group resource tuples canonicalize buffer bindings and resource identity", () => {
  const cache = new GpuBindGroupResourceCache();
  const buffer = { label: "buffer" };
  const view = { label: "view" };
  let serial = 0;
  const create = () => ({ serial: ++serial });

  const first = cache.obtain([{ buffer, offset: 16, size: 32 }, view], create);
  const sameTuple = cache.obtain([{ buffer, offset: 16, size: 32 }, view], create);
  const changedRange = cache.obtain([{ buffer, offset: 32, size: 32 }, view], create);
  const changedView = cache.obtain(
    [{ buffer, offset: 16, size: 32 }, { label: "replacement view" }],
    create
  );

  assert.equal(sameTuple, first);
  assert.notEqual(changedRange, first);
  assert.notEqual(changedView, first);
  assert.deepEqual(cache.evidence(), { requestCount: 4, creationCount: 3 });
});

test("failed creation does not poison a tuple and clear drops retained groups", () => {
  const cache = new GpuBindGroupResourceCache();
  const resource = { label: "resource" };
  assert.throws(
    () => cache.obtain([resource], () => { throw new Error("creation failed"); }),
    /creation failed/u
  );
  const recovered = cache.obtain([resource], () => ({ generation: 1 }));
  assert.equal(recovered.generation, 1);
  assert.deepEqual(cache.evidence(), { requestCount: 2, creationCount: 1 });

  cache.clear();
  const recreated = cache.obtain([resource], () => ({ generation: 2 }));
  assert.notEqual(recreated, recovered);
  assert.deepEqual(cache.evidence(), { requestCount: 3, creationCount: 2 });
  assert.throws(() => cache.obtain([], () => ({})), /at least one resource/u);
});
