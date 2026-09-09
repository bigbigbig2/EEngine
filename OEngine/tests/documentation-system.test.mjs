import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const docsRoot = path.join(repoRoot, "docs");

const coreDocs = [
  "ARCHITECTURE.md",
  "PIPELINE.md",
  "PRODUCT.md",
  "README.md",
  "STATUS.md",
  "VALIDATION.md",
];

const finalDocs = [
  ...coreDocs,
  "adr/0001-gpu-first-scope.md",
  "adr/0002-runtime-assets-and-gpu-driven.md",
  "adr/0003-unified-render-pipeline.md",
  "adr/0004-visibility-to-surface.md",
  "adr/0005-unified-browser-validation.md",
  "adr/0006-packed-render-world-convergence.md",
  "adr/README.md",
  "porting/geometry.md",
  "porting/platform.md",
  "porting/README.md",
  "porting/shading.md",
  "porting/visibility.md",
].sort();

const routedDocs = [
  "README.md",
  "CONTEXT-MAP.md",
  ...finalDocs.map((relativePath) => path.posix.join("docs", relativePath)),
  "examples/README.md",
  "examples/rendering-lab/README.md",
  "OEngine/benchmarks/README.md",
  "OEngine/src/addons/inspector/README.md",
];

function markdownFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(absolute, relative);
    return entry.isFile() && entry.name.endsWith(".md") ? [relative] : [];
  });
}

function resolveMarkdownLinks(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  const source = readFileSync(absolutePath, "utf8");
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, "").split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    const resolved = path.resolve(path.dirname(absolutePath), target);
    assert.equal(existsSync(resolved), true, `${relativePath} -> ${target}`);
  }
}

test("docs tree matches the current-facts allowlist", () => {
  assert.deepEqual(markdownFiles(docsRoot).sort(), finalDocs);
});

test("all routed Markdown links resolve", () => {
  for (const relativePath of routedDocs) resolveMarkdownLinks(relativePath);
});

test("docs index routes every core fact page", () => {
  const source = readFileSync(path.join(docsRoot, "README.md"), "utf8");
  for (const relativePath of coreDocs.filter((name) => name !== "README.md")) {
    assert.match(source, new RegExp(`\\((?:\\./)?${relativePath.replace(".", "\\.")}\\)`));
  }
});

test("authoritative docs do not depend on ephemeral or machine-local paths", () => {
  const forbidden = [
    /(?:^|[\\/])temp[\\/]/i,
    /[A-Z]:[\\/](?:Users|Documents|code|shu)[\\/]/i,
    /docs[\\/](?:contexts|implementation|references|wiki|superpowers)[\\/]/i,
  ];
  for (const relativePath of finalDocs) {
    const source = readFileSync(path.join(docsRoot, relativePath), "utf8");
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, relativePath);
    if (relativePath !== "VALIDATION.md") {
      assert.doesNotMatch(source, /`temp[\\/]/i, relativePath);
    }
  }
});

test("non-status docs do not accumulate execution checkpoints or mutable totals", () => {
  const forbidden = [
    /^#{1,6}\s+.*(?:checkpoint|closure|收口记录|完成记录)/im,
    /(?:当前全量测试|current full test|npm test)[^\n]*\b\d+\s*\/\s*\d+\b/i,
  ];
  for (const relativePath of finalDocs.filter((name) => name !== "STATUS.md")) {
    const source = readFileSync(path.join(docsRoot, relativePath), "utf8");
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, relativePath);
  }
});

test("root-anchored repository paths in docs exist", () => {
  for (const relativePath of finalDocs) {
    const source = readFileSync(path.join(docsRoot, relativePath), "utf8");
    for (const line of source.split(/\r?\n/)) {
      if (/^- Upstream(?: source)?:/i.test(line)) continue;
      for (const match of line.matchAll(/`((?:OEngine|docs|examples|src)[\\/][^`\n]+)`/g)) {
        const target = match[1];
        if (/[*?<>]/.test(target)) continue;
        const base = target.startsWith("src/") || target.startsWith("src\\")
          ? path.join(repoRoot, "OEngine")
          : repoRoot;
        assert.equal(existsSync(path.join(base, target)), true, `${relativePath} -> ${target}`);
      }
    }
  }
});

test("ADRs keep the accepted decision shape", () => {
  for (const relativePath of finalDocs.filter((name) => /^adr\/\d{4}-/.test(name))) {
    const source = readFileSync(path.join(docsRoot, relativePath), "utf8");
    assert.match(source, /^Status: accepted$/m, relativePath);
    for (const heading of ["Context", "Decision", "Consequences", "Verification"]) {
      assert.match(source, new RegExp(`^## ${heading}$`, "m"), `${relativePath}: ${heading}`);
    }
  }
});

test("porting ledgers keep required provenance fields", () => {
  const fields = [
    "Local owner/source:",
    "Upstream:",
    "Revision:",
    "Upstream source:",
    "License:",
    "Adoption:",
    "Retained invariants:",
    "OEngine/WebGPU differences:",
    "Fallback/lifecycle:",
    "Local validation:",
  ];
  for (const relativePath of ["geometry.md", "visibility.md", "shading.md", "platform.md"]) {
    const source = readFileSync(path.join(docsRoot, "porting", relativePath), "utf8");
    for (const field of fields) {
      assert.match(source, new RegExp(field, "i"), `${relativePath}: ${field}`);
    }
  }
});
