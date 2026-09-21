import assert from "node:assert/strict";
import test from "node:test";

const { webCookCatalogSceneBounds, webCookCatalogSceneFraming } = await import("../.test-dist/assets/web-cook/WebCookSceneBounds.js");

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function translate(x, y, z) {
  return Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}
function primitive(nodeIndex, instanceNodeIndices, min, max) {
  return { nodeIndex, instanceNodeIndices, boundsMin: min, boundsMax: max };
}

test("catalog bounds union every instance of a shared primitive", async () => {
  // A shared mesh placed twice must contribute both placements. Using only the
  // first instance would clip the second placement out of the framed box.
  const catalog = {
    primitives: [primitive(0, [0, 1], [0, 0, 0], [1, 1, 1])],
    instances: [
      { nodeIndex: 0, worldMatrix: translate(0, 0, 0) },
      { nodeIndex: 1, worldMatrix: translate(10, 0, 0) }
    ]
  };
  const bounds = webCookCatalogSceneBounds(catalog);
  assert.deepEqual([...bounds.min], [0, 0, 0]);
  assert.deepEqual([...bounds.max], [11, 1, 1]);
  assert.equal(bounds.unknownBoundPrimitives, 0);
  assert.deepEqual([...bounds.center], [5.5, 0.5, 0.5]);
});

test("catalog bounds apply the instance world transform", async () => {
  const catalog = {
    primitives: [primitive(0, [0], [0, 0, 0], [1, 2, 3])],
    instances: [{ nodeIndex: 0, worldMatrix: translate(0, 100, 0) }]
  };
  const bounds = webCookCatalogSceneBounds(catalog);
  assert.deepEqual([...bounds.min], [0, 100, 0]);
  assert.deepEqual([...bounds.max], [1, 102, 3]);
});

test("catalog bounds count primitives they cannot bound instead of claiming coverage", async () => {
  const catalog = {
    primitives: [
      primitive(0, [0], [0, 0, 0], [1, 1, 1]),
      primitive(1, [1], [Number.NaN, 0, 0], [1, 1, 1]),
      primitive(2, [2], [2, 2, 2], [1, 1, 1])
    ],
    instances: [
      { nodeIndex: 0, worldMatrix: IDENTITY },
      { nodeIndex: 1, worldMatrix: IDENTITY },
      { nodeIndex: 2, worldMatrix: IDENTITY }
    ]
  };
  const bounds = webCookCatalogSceneBounds(catalog);
  assert.equal(bounds.unknownBoundPrimitives, 2, "NaN bounds and an inverted box are both unbounded");
  assert.deepEqual([...bounds.min], [0, 0, 0]);
  assert.deepEqual([...bounds.max], [1, 1, 1]);
});

test("catalog bounds refuse a catalog with nothing bounded", async () => {
  const catalog = {
    primitives: [primitive(0, [0], [1, 1, 1], [0, 0, 0])],
    instances: [{ nodeIndex: 0, worldMatrix: IDENTITY }]
  };
  assert.throws(() => webCookCatalogSceneBounds(catalog), /no bounded primitive/u);
});

test("catalog framing normalizes height and aligns the base", async () => {
  const catalog = {
    primitives: [primitive(0, [0], [0, 0, 0], [2, 4, 2])],
    instances: [{ nodeIndex: 0, worldMatrix: IDENTITY }]
  };
  const framing = webCookCatalogSceneFraming(catalog, { fitHeight: 8, fitBase: [0, -1, 0] });
  assert.equal(framing.scale, 2, "scale is fitHeight / catalog height");
  // The mapper's transform is fitted(p) = scale * p + offset, so the fitted box
  // is the scale/offset image of the catalog box.
  assert.deepEqual([...framing.min], [framing.scale * 0 + framing.offset[0], framing.scale * 0 + framing.offset[1], framing.scale * 0 + framing.offset[2]]);
  assert.deepEqual([...framing.max], [framing.scale * 2 + framing.offset[0], framing.scale * 4 + framing.offset[1], framing.scale * 2 + framing.offset[2]]);
  assert.ok(Math.abs((framing.max[1] - framing.min[1]) - 8) < 1e-9, "fitted world height equals fitHeight");
  assert.ok(Math.abs(framing.min[1] - (-1)) < 1e-9, "fitted base sits on fitBase");
});

test("catalog framing is independent of which cut supplied the instances", async () => {
  // This is the reason the fit is resolved from the catalog and passed as an
  // explicit scale: resolving the same fitHeight against a smaller subset gives
  // a different scale, so the geometry would resize when a richer revision
  // replaced the bootstrap subset. The instances spread in Y because fitHeight
  // normalizes world height.
  const instances = [0, 1, 2].map(index => ({ nodeIndex: index, worldMatrix: translate(0, index * 5, 0) }));
  const full = { primitives: [primitive(0, [0, 1, 2], [0, 0, 0], [1, 1, 1])], instances };
  const subset = { primitives: [primitive(0, [0], [0, 0, 0], [1, 1, 1])], instances: [instances[0]] };
  const fullFraming = webCookCatalogSceneFraming(full, { fitHeight: 1, fitBase: [0, 0, 0] });
  const subsetFraming = webCookCatalogSceneFraming(subset, { fitHeight: 1, fitBase: [0, 0, 0] });
  assert.equal(subsetFraming.scale, 1, "a single placement stands 1 unit tall, so its own height is already 1");
  assert.equal(fullFraming.scale, 1 / 11, "the full spread stands 11 units tall");
  assert.ok(subsetFraming.scale !== fullFraming.scale, "a subset resolves a different scale, which is what this case guards against");
});

test("catalog framing identity when no fit is requested", async () => {
  const catalog = {
    primitives: [primitive(0, [0], [1, 2, 3], [4, 6, 8])],
    instances: [{ nodeIndex: 0, worldMatrix: IDENTITY }]
  };
  const framing = webCookCatalogSceneFraming(catalog);
  assert.equal(framing.scale, 1);
  assert.deepEqual([...framing.offset], [0, 0, 0]);
  assert.deepEqual([...framing.min], [1, 2, 3]);
  assert.deepEqual([...framing.max], [4, 6, 8]);
});

test("catalog framing rejects an unusable fitHeight", async () => {
  const catalog = {
    primitives: [primitive(0, [0], [0, 0, 0], [1, 1, 1])],
    instances: [{ nodeIndex: 0, worldMatrix: IDENTITY }]
  };
  assert.throws(() => webCookCatalogSceneFraming(catalog, { fitHeight: 0 }), /fitHeight/u);
  assert.throws(() => webCookCatalogSceneFraming(catalog, { fitHeight: Number.NaN }), /fitHeight/u);
  assert.throws(() => webCookCatalogSceneFraming(catalog, { fitHeight: 1, fitBase: [0, Number.NaN, 0] }), /fitBase/u);
});
