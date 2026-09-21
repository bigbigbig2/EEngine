import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const docsRoot = path.join(repoRoot, "docs");

const coreDocs = [
  "ARCHITECTURE.md", "PIPELINE.md", "PRODUCT.md", "README.md",
  "STATUS.md", "VALIDATION.md", "WEBGPU.md"
];
const adrDocs = markdownFiles(path.join(docsRoot, "adr"), "adr").sort();
const specDocs = markdownFiles(path.join(docsRoot, "specs"), "specs").sort();
const implementationDocs = markdownFiles(path.join(docsRoot, "implementation"), "implementation").sort();
const portingDocs = markdownFiles(path.join(docsRoot, "porting"), "porting").sort();
const researchDocs = markdownFiles(path.join(docsRoot, "others"), "others").sort();
const authoritativeDocs = [...coreDocs, ...adrDocs, ...specDocs, ...implementationDocs, ...portingDocs].sort();
const allowedDocs = [...authoritativeDocs, ...researchDocs].sort();

const numberedAdrs = adrDocs.filter((name) => name !== "adr/README.md");
const numberedSpecs = specDocs.filter((name) => name !== "specs/README.md");
const activeImplementations = implementationDocs.filter((name) => name !== "implementation/README.md");

function markdownFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(absolute, relative);
    return entry.isFile() && entry.name.endsWith(".md") ? [relative] : [];
  });
}

function source(relativePath) {
  return readFileSync(path.join(docsRoot, relativePath), "utf8");
}

function resolveMarkdownLinks(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  const text = readFileSync(absolutePath, "utf8");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, "").split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    assert.equal(existsSync(path.resolve(path.dirname(absolutePath), target)), true, `${relativePath} -> ${target}`);
  }
}

test("docs tree only contains governed layers plus non-authoritative research", () => {
  assert.deepEqual(markdownFiles(docsRoot).sort(), allowedDocs);
  assert.deepEqual(
    readdirSync(docsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
    ["adr", "implementation", "others", "porting", "specs"]
  );
});

test("authoritative file names are canonical", () => {
  for (const name of numberedAdrs) assert.match(name, /^adr\/\d{4}(?:-[a-z])?-[a-z0-9-]+\.md$/, name);
  for (const name of numberedSpecs) assert.match(name, /^specs\/[a-z0-9-]+\.md$/, name);
  for (const name of activeImplementations) assert.match(name, /^implementation\/\d{4}-[a-z0-9-]+\.md$/, name);
  for (const name of authoritativeDocs) assert.doesNotMatch(name, /\s|\(\d+\)/, name);
});

test("all authoritative Markdown links resolve", () => {
  for (const relativePath of ["AGENTS.md", "CONTEXT-MAP.md", ...authoritativeDocs.map((name) => `docs/${name}`)]) {
    resolveMarkdownLinks(relativePath);
  }
});

test("indexes route every governed document", () => {
  const rootIndex = source("README.md");
  for (const name of coreDocs.filter((name) => name !== "README.md")) {
    assert.match(rootIndex, new RegExp(`\\((?:\\./)?${name.replaceAll(".", "\\.")}\\)`), name);
  }
  for (const [index, files] of [
    [source("adr/README.md"), numberedAdrs],
    [source("specs/README.md"), numberedSpecs],
    [source("implementation/README.md"), activeImplementations]
  ]) {
    for (const name of files) {
      const fileName = path.posix.basename(name).replaceAll(".", "\\.");
      assert.match(index, new RegExp(`\\((?:\\./)?${fileName}\\)`), name);
    }
  }
});

test("ADRs remain short decision records", () => {
  for (const name of numberedAdrs) {
    const text = source(name);
    assert.ok(text.length <= 12_000, `${name}: ${text.length} characters`);
    assert.match(text, /^Status: (?:proposed|accepted|superseded|rejected)\b/m, name);
    for (const heading of ["Context", "Decision", "Consequences", "Verification"]) {
      assert.match(text, new RegExp(`^## ${heading}$`, "m"), `${name}: ${heading}`);
    }
    assert.equal([...text.matchAll(/^## /gm)].length, 4, `${name}: only four decision sections are allowed`);
    assert.doesNotMatch(text, /^### |^## .*?(?:Stage|Step|实施|进度|Checkpoint|完成记录)/im, name);
  }
});

test("specs expose lifecycle, ownership and exact-contract sections", () => {
  for (const name of numberedSpecs) {
    const text = source(name);
    assert.match(text, /^Status: (?:draft|candidate|frozen|retired)\b/m, name);
    assert.match(text, /^Owners: .+/m, name);
    for (const heading of ["Version/Compatibility", "Contract", "Validation"]) {
      assert.match(text, new RegExp(`^## ${heading}$`, "m"), `${name}: ${heading}`);
    }
  }
});

test("implementation docs describe active outcomes and gates", () => {
  for (const name of activeImplementations) {
    const text = source(name);
    assert.match(text, /^Status: (?:active|blocked)\b/m, name);
    assert.match(text, /^Owners: .+/m, name);
    for (const heading of ["Outcome", "Slices", "Shared gates"]) {
      assert.match(text, new RegExp(`^## ${heading}$`, "m"), `${name}: ${heading}`);
    }
  }
});

test("authoritative docs avoid machine-local and ephemeral truth", () => {
  const forbidden = [/[A-Z]:[\\/]/, /docs[\\/](?:contexts|references|wiki|superpowers)[\\/]/i];
  for (const name of authoritativeDocs) {
    const text = source(name);
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, name);
    if (!new Set(["README.md", "VALIDATION.md"]).has(name)) assert.doesNotMatch(text, /`temp[\\/]/i, name);
    if (name !== "STATUS.md") {
      assert.doesNotMatch(text, /(?:当前全量测试|current full test|npm test)[^\n]*\b\d+\s*\/\s*\d+\b/i, name);
      assert.doesNotMatch(text, /^#{1,6}\s+.*(?:checkpoint|收口记录|完成记录)/im, name);
    }
  }
});

test("root-anchored repository paths in authoritative docs exist", () => {
  for (const name of authoritativeDocs) {
    for (const line of source(name).split(/\r?\n/)) {
      if (/^- Upstream[^:]*:/i.test(line)) continue;
      for (const match of line.matchAll(/`((?:OEngine|docs|examples|validation|src)[\\/][^`\n]+)`/g)) {
        const target = match[1];
        if (/[*?<>]/.test(target)) continue;
        const base = /^src[\\/]/.test(target) ? path.join(repoRoot, "OEngine") : repoRoot;
        assert.equal(existsSync(path.join(base, target)), true, `${name} -> ${target}`);
      }
    }
  }
});

test("porting ledgers retain provenance fields", () => {
  const fields = ["Local owner/source:", "Upstream:", "Revision:", "Upstream source:", "License:", "Adoption:", "Retained invariants:", "OEngine/WebGPU differences:", "Fallback/lifecycle:", "Local validation:"];
  for (const relativePath of ["geometry.md", "visibility.md", "shading.md", "platform.md"]) {
    const text = source(`porting/${relativePath}`);
    for (const field of fields) assert.match(text, new RegExp(field, "i"), `${relativePath}: ${field}`);
  }
});

test("production asset and GPU source graph excludes the reference texture codec", () => {
  const files = [path.join(repoRoot, "OEngine", "src", "assets"), path.join(repoRoot, "OEngine", "src", "gpu")].flatMap(sourceFiles);
  for (const file of files) {
    if (file.endsWith("ReferenceTextureCodec.ts")) continue;
    assert.doesNotMatch(readFileSync(file, "utf8"), /(?:import|export)[^;]*ReferenceTextureCodec/s, path.relative(repoRoot, file));
  }
});

function sourceFiles(directory) {
  if (!statSync(directory).isDirectory()) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}
