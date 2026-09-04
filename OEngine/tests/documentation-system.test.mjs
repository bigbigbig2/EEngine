import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const docsRoot = path.join(repoRoot, "docs");
const finalDocs = [
  "ARCHITECTURE.md", "PIPELINE.md", "PRODUCT.md", "README.md", "STATUS.md", "VALIDATION.md",
  "adr/0001-gpu-first-scope.md", "adr/0002-runtime-assets-and-gpu-driven.md",
  "adr/0003-unified-render-pipeline.md", "adr/README.md",
  "porting/geometry.md", "porting/platform.md", "porting/README.md",
  "porting/shading.md", "porting/visibility.md"
].sort();

function markdownFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(absolute, relative);
    return entry.isFile() && entry.name.endsWith(".md") ? [relative] : [];
  });
}

test("docs tree matches the internal allowlist", () => {
  assert.deepEqual(markdownFiles(docsRoot).sort(), finalDocs);
});

test("relative Markdown links resolve", () => {
  for (const relativePath of finalDocs) {
    const source = readFileSync(path.join(docsRoot, relativePath), "utf8");
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, "").split("#", 1)[0];
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
      const absolute = path.resolve(path.dirname(path.join(docsRoot, relativePath)), target);
      assert.equal(existsSync(absolute), true, `${relativePath} -> ${target}`);
    }
  }
});

test("current docs do not route to the retired system", () => {
  const forbidden = [
    /docs[\\/](?:contexts|implementation|references|wiki)[\\/]/,
    /performance-targets\.json/,
    /examples[\\/](?:benchmark-[abc]|r[0-9]-|integrated-showcase|scripts)[\\/]/
  ];
  for (const relativePath of finalDocs) {
    const source = readFileSync(path.join(docsRoot, relativePath), "utf8");
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, relativePath);
  }
});

test("porting ledgers keep required provenance fields", () => {
  const fields = [
    "Local owner/source:", "Upstream:", "Revision:", "Upstream source:", "License:",
    "Adoption:", "Retained invariants:", "OEngine/WebGPU differences:",
    "Fallback/lifecycle:", "Local validation:"
  ];
  for (const relativePath of ["geometry.md", "visibility.md", "shading.md", "platform.md"]) {
    const source = readFileSync(path.join(docsRoot, "porting", relativePath), "utf8");
    for (const field of fields) assert.match(source, new RegExp(field, "i"), `${relativePath}: ${field}`);
  }
});
