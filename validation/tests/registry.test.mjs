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
  // Registry order can begin with an L4 perf case. Exceed the largest legal
  // timeout instead of assuming the first case has the shorter contract limit.
  broken.cases[0].timeoutMs = 1_800_001;
  broken.cases[0].artifacts = ["mystery"];
  broken.cases[0].errorAllowlist = [{ pattern: ".*" }];
  const errors = validateRegistry(broken);
  assert.ok(errors.some((error) => error.includes("timeout out of bounds")));
  assert.ok(errors.some((error) => error.includes("invalid artifact owners")));
  assert.ok(errors.some((error) => error.includes("exact text")));
});

test("registry gives only L4 PERF a bounded long-run timeout", () => {
  const allowed = structuredClone(registry);
  const formal = allowed.cases.find((item) => item.id === "web-authored-large-cook-k0");
  assert.ok(formal);
  formal.kind = "perf";
  formal.level = "L4";
  formal.profile = "formal-1080p";
  formal.timeoutMs = 1_800_000;
  assert.ok(!validateRegistry(allowed).some((error) => error.includes("timeout out of bounds")));

  const tooLong = structuredClone(allowed);
  tooLong.cases.find((item) => item.id === "web-authored-large-cook-k0").timeoutMs = 1_800_001;
  assert.ok(validateRegistry(tooLong).some((error) => error.includes("timeout out of bounds")));
});
