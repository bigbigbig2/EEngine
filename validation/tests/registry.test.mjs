import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRegistry } from "../src/shared/registry.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedPath = resolve(root, "registry.generated.json");
const registry = JSON.parse(await readFile(generatedPath, "utf8"));

test("committed validation registry is valid", () => {
  assert.deepEqual(validateRegistry(registry), []);
});

test("registry rejects duplicate identity and runtime backend switches", () => {
  const broken = structuredClone(registry);
  broken.cases.push({ ...broken.cases[0], route: "/case?backend=legacy" });
  const errors = validateRegistry(broken);
  assert.ok(errors.some((error) => error.includes("duplicate case id")));
  assert.ok(errors.some((error) => error.includes("runtime backend switch")));
});

test("registry rejects unowned artifacts, unbounded timeout and fuzzy allowlists", () => {
  const broken = structuredClone(registry);
  broken.cases[0].timeoutMs = 999999;
  broken.cases[0].artifacts = ["mystery"];
  broken.cases[0].errorAllowlist = [{ pattern: ".*" }];
  const errors = validateRegistry(broken);
  assert.ok(errors.some((error) => error.includes("timeout out of bounds")));
  assert.ok(errors.some((error) => error.includes("invalid artifact owners")));
  assert.ok(errors.some((error) => error.includes("exact text")));
});

test("registry gives only L4 PERF a bounded long-run timeout", () => {
  const allowed = structuredClone(registry);
  const formal = allowed.cases.find((item) => item.id === "web-authored-large-perf");
  assert.ok(formal);
  formal.timeoutMs = 1_800_000;
  assert.ok(!validateRegistry(allowed).some((error) => error.includes("timeout out of bounds")));

  const tooLong = structuredClone(allowed);
  tooLong.cases.find((item) => item.id === "web-authored-large-perf").timeoutMs = 1_800_001;
  assert.ok(validateRegistry(tooLong).some((error) => error.includes("timeout out of bounds")));
});

test("registry separates promotion cases from claim-optional diagnostics", () => {
  const diagnostic = structuredClone(registry);
  const observer = diagnostic.cases.find((item) => item.id === "virtual-product-observer");
  observer.covers = [];
  assert.ok(!validateRegistry(diagnostic).some((error) => error.includes("invalid covers")));

  const promotion = structuredClone(registry);
  const protocol = promotion.cases.find((item) => item.id === "protocol-self-test");
  protocol.covers = [];
  assert.ok(validateRegistry(promotion).some((error) => error.includes("promotion case must cover")));
});
