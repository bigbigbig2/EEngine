import test from "node:test";
import assert from "node:assert/strict";

import {
  ResourceAccounting,
  estimateTextureBytes
} from "../.test-dist/debug/profiling/ResourceAccounting.js";

test("resource accounting tracks owner bytes and releases them", () => {
  const accounting = new ResourceAccounting();
  const buffer = accounting.created({ kind: "buffer", owner: "scene", bytes: 128 });
  accounting.created({ kind: "texture", owner: "history", bytes: 256 });
  assert.deepEqual(accounting.snapshot().owners, {
    scene: { buffer: 128 },
    history: { texture: 256 }
  });
  accounting.destroyed(buffer);
  assert.equal(accounting.snapshot().totalBytes, 256);
  assert.throws(() => accounting.destroyed(buffer), /already released/);
});

test("texture estimate accounts mip levels and array layers", () => {
  assert.equal(estimateTextureBytes({ format: "rgba8unorm", width: 4, height: 4, depthOrArrayLayers: 2, mipLevelCount: 2 }), 160);
  assert.throws(() => estimateTextureBytes({ format: "unknown-format", width: 1, height: 1 }), /unsupported/);
});
