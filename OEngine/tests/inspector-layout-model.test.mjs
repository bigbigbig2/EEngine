import test from "node:test";
import assert from "node:assert/strict";

import { InspectorLayoutModel } from "../.test-dist/addons/inspector/InspectorLayoutModel.js";

function storage() {
  const values = new Map();
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); }
  };
}

test("InspectorLayoutModel clamps layout and persists a versioned snapshot", () => {
  const backend = storage();
  const model = new InspectorLayoutModel(backend);
  model.setLayout({ left: -20, top: -4, width: 1, height: 9999 });
  assert.deepEqual(model.layout, { left: 0, top: 0, width: 320, height: 900 });

  const restored = new InspectorLayoutModel(backend);
  assert.deepEqual(restored.layout, model.layout);
});

test("InspectorLayoutModel reset and subscriptions are deterministic", () => {
  const backend = storage();
  const model = new InspectorLayoutModel(backend);
  const updates = [];
  const unsubscribe = model.subscribe((layout) => updates.push(layout));
  model.setLayout({ left: 80, top: 120, width: 640, height: 480 });
  model.reset();
  unsubscribe();
  model.setLayout({ left: 40 });
  assert.deepEqual(updates.map(({ left, top, width, height }) => [left, top, width, height]), [
    [80, 120, 640, 480],
    [12, 96, 520, 420]
  ]);
});
