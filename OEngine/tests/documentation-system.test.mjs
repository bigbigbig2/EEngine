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
  "WEBGPU.md",
];

const adrDocs = markdownFiles(path.join(docsRoot, "adr"), "adr")
  .filter((relativePath) => relativePath === "adr/README.md" || /^adr\/\d{4}-.+\.md$/.test(relativePath))
  .sort();
const portingDocs = [
  "porting/geometry.md",
  "porting/platform.md",
  "porting/README.md",
  "porting/shading.md",
  "porting/visibility.md",
];
const researchDocs = markdownFiles(path.join(docsRoot, "others"), "others").sort();
const authoritativeDocs = [...coreDocs, ...adrDocs, ...portingDocs].sort();
const allowedDocs = [...authoritativeDocs, ...researchDocs].sort();

const routedDocs = [
  "README.md",
  "CONTEXT-MAP.md",
  ...authoritativeDocs.map((relativePath) => path.posix.join("docs", relativePath)),
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
  assert.deepEqual(markdownFiles(docsRoot).sort(), allowedDocs);
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
  for (const relativePath of authoritativeDocs) {
    const source = readFileSync(path.join(docsRoot, relativePath), "utf8");
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, relativePath);
    if (relativePath !== "VALIDATION.md") {
      assert.doesNotMatch(source, /`temp[\\/]/i, relativePath);
    }
  }
});

test("non-status authoritative docs do not accumulate execution checkpoints or mutable totals", () => {
  const forbidden = [
    /^#{1,6}\s+.*(?:checkpoint|closure|收口记录|完成记录)/im,
    /(?:当前全量测试|current full test|npm test)[^\n]*\b\d+\s*\/\s*\d+\b/i,
  ];
  for (const relativePath of authoritativeDocs.filter((name) => name !== "STATUS.md")) {
    const source = readFileSync(path.join(docsRoot, relativePath), "utf8");
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, relativePath);
  }
});

test("root-anchored repository paths in authoritative docs exist", () => {
  for (const relativePath of authoritativeDocs) {
    const source = readFileSync(path.join(docsRoot, relativePath), "utf8");
    for (const line of source.split(/\r?\n/)) {
      if (/^- Upstream[^:]*:/i.test(line)) continue;
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

test("ADRs keep the decision shape and an explicit lifecycle status", () => {
  for (const relativePath of adrDocs.filter((name) => /^adr\/\d{4}-/.test(name))) {
    const source = readFileSync(path.join(docsRoot, relativePath), "utf8");
    assert.match(
      source,
      /^(?:Status: |> \*\*Status:\*\* )(?:proposed|accepted|superseded|rejected)\b/m,
      relativePath
    );
    for (const heading of ["Context", "Decision", "Consequences", "Verification"]) {
      assert.match(source, new RegExp(`^## (?:\\d+\\. )?${heading}$`, "m"), `${relativePath}: ${heading}`);
    }
  }
});

test("ADR index routes every numbered decision", () => {
  const source = readFileSync(path.join(docsRoot, "adr", "README.md"), "utf8");
  for (const relativePath of adrDocs.filter((name) => /^adr\/\d{4}-/.test(name))) {
    const fileName = path.posix.basename(relativePath);
    assert.match(source, new RegExp(`\\((?:\\./)?${fileName.replaceAll(".", "\\.")}\\)`), relativePath);
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

test("ADR-0011 freezes production codec authority and exact integration provenance", () => {
  const adr = readFileSync(path.join(docsRoot, "adr", "0011-asset-codec-and-gpu-native-texture-pipeline-v3.md"), "utf8");
  const platform = readFileSync(path.join(docsRoot, "porting", "platform.md"), "utf8");
  assert.match(adr, /Production source graph.*不得 import/s);
  for (const marker of [
    "KTX-Software-4.4.2-Web-libktx_read.zip",
    "examples/jsm/loaders/KTX2Loader.js",
    "examples/jsm/utils/WorkerPool.js",
    "packages/dev/core/src/Misc/khronosTextureContainer2.ts",
    "packages/tools/ktx2Decoder/",
    "8336a23659f306c93f45816022dcdfae122f66eaf566488a2b7cf40e0bf65f0e"
  ]) assert.match(platform, new RegExp(marker.replaceAll(".", "\\.")), marker);
});

test("production asset and GPU source graph does not import the reference texture codec", () => {
  const sourceRoots = [
    path.join(repoRoot, "OEngine", "src", "assets"),
    path.join(repoRoot, "OEngine", "src", "gpu")
  ];
  const files = sourceRoots.flatMap((root) => sourceFiles(root));
  for (const file of files) {
    if (file.endsWith("ReferenceTextureCodec.ts")) continue;
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      /(?:import|export)[^;]*ReferenceTextureCodec/s,
      path.relative(repoRoot, file)
    );
  }
});

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}
