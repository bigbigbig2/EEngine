import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Phase 1 Renderer negotiates visibility capabilities before creating GPU owners", () => {
  const source = readFileSync(new URL("../../src/render/pipeline/RendererCore.ts", import.meta.url), "utf8");
  const request = source.indexOf("adapter.requestDevice(");
  const graphics = source.indexOf("new GraphicsContext(");
  assert.ok(request >= 0 && graphics > request);
  assert.match(source, /"indirect-first-instance"/u);
  assert.match(source, /"texture-formats-tier1"/u);
  assert.match(source, /VIRTUAL_GEOMETRY_PRODUCT_REQUIRED_STORAGE_BUFFERS_PER_SHADER_STAGE/u);
  assert.match(source, /options\.device && !options\.adapter/u);
  assert.doesNotMatch(source, /subgroup-size-control/u);
});
