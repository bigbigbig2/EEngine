import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const docsRoot = path.join(repoRoot, "docs");

function files(directory, suffix) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(absolute, suffix);
    return entry.isFile() && entry.name.endsWith(suffix) ? [absolute] : [];
  });
}

test("documentation tree uses the contract-driven layers", () => {
  const directories = readdirSync(docsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(directories, ["adr", "contracts", "domains", "porting", "sources", "specs"]);
  for (const retired of ["CONTEXT-MAP.md", "docs/ARCHITECTURE.md", "docs/PIPELINE.md", "docs/STATUS.md", "docs/implementation", "docs/others"]) {
    assert.equal(existsSync(path.join(repoRoot, retired)), false, retired);
  }
});

test("machine project manifests and generated registry are healthy", () => {
  const output = execFileSync(process.execPath, ["tools/vibe.mjs", "doctor"], { cwd: repoRoot, encoding: "utf8" });
  const result = JSON.parse(output);
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.counts.domains >= 6);
  assert.ok(result.counts.claims >= 10);
  assert.equal(result.counts.cases, 20);
  assert.equal(existsSync(path.join(repoRoot, "validation/registry.generated.json")), true);
});

test("changed routing has one primary owner", () => {
  const output = execFileSync(process.execPath, ["tools/vibe.mjs", "verify", "--changed"], { cwd: repoRoot, encoding: "utf8" });
  const result = JSON.parse(output);
  assert.equal(result.ok, true);
  assert.deepEqual(result.routingAmbiguities, []);
  assert.deepEqual(result.uncovered, []);
});

test("each domain has a human page and machine route", () => {
  const domainFiles = files(path.join(repoRoot, "project/domains"), ".yaml");
  for (const file of domainFiles) {
    const id = path.basename(file, ".yaml");
    assert.equal(existsSync(path.join(docsRoot, "domains", `${id}.md`)), true, id);
    const source = readFileSync(file, "utf8");
    assert.match(source, /^paths:\s*$/m, id);
  }
});

test("ADRs, specs, and porting ledgers retain their governance shape", () => {
  for (const file of files(path.join(docsRoot, "adr"), ".md")) {
    if (path.basename(file) === "README.md") continue;
    const text = readFileSync(file, "utf8");
    assert.match(text, /^Status: (?:proposed|accepted|superseded|rejected)\b/m, file);
    for (const heading of ["Context", "Decision", "Consequences", "Verification"]) assert.match(text, new RegExp(`^## ${heading}$`, "m"), file);
  }
  for (const file of files(path.join(docsRoot, "specs"), ".md")) {
    if (path.basename(file) === "README.md") continue;
    const text = readFileSync(file, "utf8");
    assert.match(text, /^Status: (?:draft|candidate|frozen|retired)\b/m, file);
    assert.match(text, /^Owners: .+/m, file);
    for (const heading of ["Version/Compatibility", "Contract", "Validation"]) assert.match(text, new RegExp(`^## ${heading}$`, "m"), file);
  }
  for (const name of ["geometry.md", "visibility.md", "shading.md", "platform.md"]) {
    const text = readFileSync(path.join(docsRoot, "porting", name), "utf8");
    for (const field of ["Local owner/source:", "Upstream:", "Revision:", "Upstream source:", "License:", "Adoption:", "Retained invariants:", "OEngine/WebGPU differences:", "Fallback/lifecycle:", "Local validation:"]) assert.match(text, new RegExp(field, "i"), name);
  }
});

test("authoritative docs do not contain machine-local paths or retired status routes", () => {
  for (const file of files(docsRoot, ".md")) {
    const relative = path.relative(repoRoot, file).replaceAll("\\", "/");
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /[A-Z]:[\\/]/u, relative);
    assert.doesNotMatch(text, /docs\/(?:ARCHITECTURE|PIPELINE|STATUS)\.md/u, relative);
  }
});
