import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRegistry } from "../src/shared/registry.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(await readFile(resolve(root, "cases/registry.json"), "utf8"));

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
