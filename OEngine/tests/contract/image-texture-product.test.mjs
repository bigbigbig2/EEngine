import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { cookImageTexture } from "../../.test-dist/assets/codec/ImageTextureCook.js";
import {
  validateImageTextureDirectory,
  readImageTextureDirectory,
  writeImageTextureDirectory
} from "../../.test-dist/assets/ImageTextureProduct.js";
import { validateImageAvif } from "../../.test-dist/assets/codec/ImageTextureAvif.js";
import { sparkPrecisionSource } from "../../.test-dist/gpu/ImageTextureTranscoder.js";
import { AssetWorkerPool } from "../../.test-dist/assets/codec/AssetWorkerPool.js";

const hash = "a".repeat(64);
const base = {
  schemaVersion: 4,
  sourceRevision: hash,
  recipe: hash,
  width: 4,
  height: 4,
  mipCount: 3,
  quality: "high",
  planes: [
    {
      semantic: "normal-xy",
      mode: "resident",
      mips: "runtime",
      target: "bc5-rg",
      addressU: "repeat",
      addressV: "clamp-to-edge",
      alphaScales: [],
      constants: [null, null, 0, 255]
    }
  ],
  items: [
    {
      id: 0,
      plane: 0,
      mip: 0,
      x: 0,
      y: 0,
      width: 4,
      height: 4,
      kind: "image",
      codec: "avif",
      bytes: 100,
      decodedBytes: 64,
      sha256: hash,
      uri: "test.avif",
      offset: null,
      objectBytes: "100"
    }
  ]
};
test("schema4 roundtrip; rejects old product, holes, overlap, u64 wrap, and wrong semantic target", () => {
  assert.deepEqual(readImageTextureDirectory(writeImageTextureDirectory(base)), base);
  for (const mutate of [
    (d) => (d.schemaVersion = 3),
    (d) => (d.planes[0].target = "bc7-rgb"),
    (d) => (d.planes[0].constants[2] = 1),
    (d) => (d.items[0].offset = "18446744073709551616"),
    (d) => (d.items[0].width = 2),
    (d) => (d.items[0].decodedBytes = 1),
    (d) => d.items.push({ ...d.items[0], id: 1 })
  ]) {
    const d = structuredClone(base);
    mutate(d);
    assert.throws(() => validateImageTextureDirectory(d));
  }
});
test("canonical normal reads original XYZ simultaneously, scalar extracts actual channel, moment rejects generated mip", async () => {
  const seen = [];
  const sink = {
    encodeAvif: async (input) => {
      seen.push(input.rgba.slice());
      return new Uint8Array([1]);
    },
    put: async () => "image.avif"
  };
  const normal = await cookImageTexture(
    {
      semantic: "normal-xy",
      quality: "high",
      mode: "resident",
      mips: "runtime",
      toolHash: hash,
      inputs: [{ width: 1, height: 1, rgba: new Uint8Array([180, 160, 240, 255]) }]
    },
    sink
  );
  const [x, y, z] = [180, 160, 240].map((v) => (v * 2) / 255 - 1),
    len = Math.hypot(x, y, z);
  assert.deepEqual(
    [...seen[0]],
    [Math.round(((x / len) * 0.5 + 0.5) * 255), Math.round(((y / len) * 0.5 + 0.5) * 255), 0, 255]
  );
  assert.equal(normal.directory.planes[0].target, "bc5-rg");
  await cookImageTexture(
    {
      semantic: "scalar-r",
      quality: "extreme",
      mode: "resident",
      mips: "runtime",
      toolHash: hash,
      scalarChannel: 2,
      inputs: [{ width: 1, height: 1, rgba: new Uint8Array([2, 17, 231, 20]) }]
    },
    sink
  );
  assert.deepEqual([...seen[1]], [231, 231, 231, 255]);
  await assert.rejects(
    cookImageTexture(
      {
        semantic: "moment-xyz",
        quality: "high",
        mode: "resident",
        mips: "runtime",
        toolHash: hash,
        inputs: [{ width: 1, height: 1, rgba: new Uint8Array([1, 2, 3, 255]) }]
      },
      sink
    )
  );
});
test("provided canonical owner domains split without overlap; exact coverage byte extraction", async () => {
  const payloads = [];
  const inputs = [];
  for (let w = 256; w >= 1; w /= 2) {
    const rgba = new Uint8Array(w * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set([1, 2, 3, (i / 4) % 256], i);
    inputs.push({ width: w, height: 1, rgba });
  }
  const result = await cookImageTexture(
    {
      semantic: "data-rgb",
      quality: "high",
      mode: "virtual",
      mips: "provided",
      cellSize: 128,
      toolHash: hash,
      inputs,
      exactCoverage: inputs
    },
    {
      encodeAvif: async () => new Uint8Array([1]),
      put: async (h, b, k) => {
        payloads.push({ bytes: b, kind: k });
        return h;
      }
    }
  );
  validateImageTextureDirectory(result.directory);
  assert.equal(result.directory.items.filter((i) => i.mip === 0 && i.plane === 0).length, 2);
  assert.deepEqual(
    [...payloads.find((p) => p.kind === "exact").bytes],
    Array.from({ length: 128 }, (_, i) => i)
  );
});
test("native generated AVIF metadata is admitted; malformed size, CICP and transform rejected", async () => {
  const path = new URL("../../../.local/extreme-web-asset/e1-fixtures/normal-xy-high/", import.meta.url);
  const d = JSON.parse(await readFile(new URL("directory.json", path), "utf8"));
  const item = d.items[0];
  const bytes = new Uint8Array(await readFile(new URL(item.uri, path)));
  validateImageAvif(bytes, item, "normal-xy");
  // Larger legal pictures can select a different AV1 level without changing 444/depth/profile.
  const largerLevel = bytes.slice();
  for (let offset = 0; offset < largerLevel.length - 8; offset++) {
    if (String.fromCharCode(...largerLevel.subarray(offset, offset + 4)) === "av1C") {
      largerLevel[offset + 5] = (largerLevel[offset + 5] & 0xe0) | 8;
    }
  }
  validateImageAvif(largerLevel, item, "normal-xy");
  const wrong = bytes.slice();
  wrong[0] = 255;
  assert.throws(() => validateImageAvif(wrong, item, "normal-xy"));
  assert.throws(() => validateImageAvif(bytes, { ...item, width: item.width + 1 }, "normal-xy"));
  assert.throws(() => validateImageAvif(bytes, item, "color-rgb"));
});
test("faithful f32 transformation preserves operations; late retired pool receipt discarded", async () => {
  assert.equal(
    sparkPrecisionSource("enable f16;\nlet a: vec2h = vec2h(0.5h);", "f32"),
    "let a: vec2f = vec2f(0.5);"
  );
  let worker,
    closed = 0;
  const pool = new AssetWorkerPool({
    maxWorkers: 1,
    maxInFlightEstimatedBytes: 1024,
    createWorker: () => (worker = { postMessage() {}, terminate() {} }),
    discardResult: () => closed++
  });
  const signal = new AbortController();
  const job = pool.submit({
    request: {},
    transfer: [],
    estimatedPeakBytes: 1,
    priority: 0,
    signal: signal.signal
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  signal.abort();
  await assert.rejects(job);
  worker.onmessage({ data: { late: true } });
  assert.equal(closed, 1);
  assert.equal(pool.evidence().inFlightEstimatedBytes, 0);
  pool.dispose();
});
test("provided XY and XYZ/moment inputs are never renormalized by the cooker", async () => {
  const seen = [];
  const sink = {
    encodeAvif: async (input) => {
      seen.push([...input.rgba]);
      return new Uint8Array([1]);
    },
    put: async () => "image.avif"
  };
  for (const semantic of ["normal-xy", "moment-xyz"]) {
    await cookImageTexture(
      {
        semantic,
        quality: "high",
        mode: "resident",
        mips: "provided",
        toolHash: hash,
        inputs: [{ width: 1, height: 1, rgba: new Uint8Array([140, 145, 160, 255]) }]
      },
      sink
    );
  }
  assert.deepEqual(seen, [
    [140, 145, 0, 255],
    [140, 145, 160, 255]
  ]);
});
