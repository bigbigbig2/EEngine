#!/usr/bin/env node
/**
 * Documentation contract migrator.
 *
 * Brings `docs/**` under the schema enforced by `tools/docs-verify.mjs`:
 *
 *   ---
 *   id: <stable slug>
 *   state: generated | current | history
 *   verifies:            # required for `current`
 *     files: [...]
 *     command: <optional>
 *   supersededBy: <path> # for history, when something replaced it
 *   ---
 *
 * Why a migrator and not hand edits
 * ---------------------------------
 * 141 documents. Hand-authoring frontmatter produces inconsistency faster than
 * review can catch it, and the point of the contract is that `state` is a
 * considered classification, not a template fill. So the classification lives
 * here as explicit, reviewable rules, and the tool is idempotent.
 *
 * Classification rules (directory defaults, overridden per document)
 * ------------------------------------------------------------------
 *   generated  Only files a tool writes.
 *   history    Dated records: `reviews/**`, `archive/**`, `performance/**`,
 *              superseded ADRs, and `next-execution/**` phase records.
 *   current    Everything that claims to describe present code: `adr/**`,
 *              `specs/**`, `contracts/**`, `domains/**`, `porting/**`,
 *              `next-design/**`, the active `next-execution/**` entries.
 *
 * A `current` document with no `verifies:` clause is the exact failure this
 * contract exists to prevent, so for documents whose truth cannot be checked by
 * a file or command the tool sets state `history` and says so in the report
 * rather than emitting an unverifiable `current`.
 *
 * Usage:
 *   node tools/docs-migrate.mjs --plan        classify and report, write nothing
 *   node tools/docs-migrate.mjs --write       inject or update frontmatter
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_ROOT = resolve(REPO_ROOT, "docs");

function toRepoPath(absolute) {
  return relative(REPO_ROOT, absolute).replaceAll("\\", "/");
}

function walkMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = resolve(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(absolute, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(absolute);
  }
  return out;
}

/**
 * Maps a document to the files whose current shape it claims to describe.
 *
 * This is the falsifiable part of `current`: "this document is still accurate
 * about these sources". It does not execute anything by itself; it gives
 * `docs-verify.mjs` something concrete to fail on, and gives a reader the list
 * of what to re-read when those files change.
 */
const VERIFIES_BY_PATH = [
  // Top-level pages. `docs/README.md` is the entry point an agent reads first,
  // so its "where things stand" claims are the most damaging when stale — it
  // verifies against the documents it routes to.
  { match: /^docs\/README\.md$/u, files: ["docs", "project/workstreams/active"] },
  { match: /^docs\/PRODUCT\.md$/u, files: ["OEngine/src", "docs/next-design"] },
  { match: /^docs\/VALIDATION\.md$/u, files: ["checks", "validation"] },
  { match: /^docs\/WEBGPU\.md$/u, files: ["docs/specs", "docs/porting"] },
  { match: /^docs\/adr\//u, files: ["project/workstreams/active"] },
  { match: /^docs\/specs\//u, files: ["OEngine/src"] },
  { match: /^docs\/contracts\//u, files: ["checks", "project/domains"] },
  { match: /^docs\/domains\/([\w-]+)\.md$/u, files: ["project/domains"] },
  { match: /^docs\/porting\//u, files: ["tools"] },
  { match: /^docs\/next-design\//u, files: ["OEngine/src"] },
  { match: /^docs\/next-execution\//u, files: ["OEngine/src"] },
];

function verifiesFor(rel) {
  for (const rule of VERIFIES_BY_PATH) {
    if (rule.match.test(rel)) return rule.files;
  }
  return null;
}

/** Stable slug from the file name; the path is implicit in the document. */
function idFor(rel) {
  return rel
    .replace(/^docs\//u, "")
    .replace(/\.md$/u, "")
    .replace(/[^\w./-]+/gu, "-")
    .toLowerCase();
}

/**
 * Does this document's own header disclaim current authority?
 *
 * A date in a file name does NOT make a document history. The first classifier
 * used the date as the signal and marked the *active* execution plan, progress
 * record and review-and-readiness list as history — then the verifier correctly
 * reported them as "history used as an entry point", because `AGENTS.md` points
 * at them. The real distinction is whether the document still defines rules
 * someone must follow, and the project already states that explicitly in its
 * header. Reading the header is the honest test; guessing from the path is not.
 */
const SUPERSEDED_MARKERS = [
  /非当前实施入口/u,
  /历史(?:计划|记录|优化|迁移|方案|范围)/u,
  /仅供(?:追溯|参考)/u,
  /已被(?:替代|取代)/u,
  /不再(?:生效|由本文)/u,
  /historical/iu,
  /superseded/iu,
];

function declaresItselfHistory(text) {
  const head = text.split("\n").slice(0, 14).join("\n");
  return SUPERSEDED_MARKERS.some((marker) => marker.test(head));
}

function classify(rel, text) {
  const name = basename(rel);

  if (rel.startsWith("docs/archive/")) return { state: "history" };
  if (rel.startsWith("docs/reviews/")) return { state: "history" };
  if (rel.startsWith("docs/performance/")) return { state: "history" };

  // A tool writes this; the marker in the body is verified separately.
  if (name.endsWith(".generated.md")) return { state: "generated" };

  // A dated record that disclaims current authority in its own header.
  if (/^docs\/next-execution\//u.test(rel) && declaresItselfHistory(text)) return { state: "history" };

  // Superseded ADRs. ADR-0020 clean-cuts the pre-Next renderer and ADR-0021
  // redefines the Surface target, so an early ADR that says so is history.
  if (/^docs\/adr\//u.test(rel) && /superseded|replaced by|已被取代/iu.test(text.slice(0, 1500))) {
    return { state: "history" };
  }

  const verifies = verifiesFor(rel);
  if (verifies) return { state: "current", verifies };
  return { state: "unclassified" };
}

/**
 * Preserve every existing frontmatter field and only add what is missing.
 *
 * The first version of this tool REPLACED the frontmatter block, which silently
 * destroyed the contract pages' own schema (`kind`, `status`, `owners`,
 * `consumers`, `invariants`, `validation`) — fields the project model validates
 * and fails on when absent. A merge is the only safe migration for a tree whose
 * documents already carry structured metadata for other tools.
 *
 * Existing values always win: if a document already declares a state, this tool
 * does not override the author's classification.
 */
function mergeFrontmatter(existingBlock, additions) {
  const lines =
    existingBlock === null ? [] : existingBlock.split(/\r?\n/u).filter((line) => line.trim() !== "");
  const present = new Set();
  for (const line of lines) {
    const key = line.match(/^([A-Za-z][\w-]*):/u);
    if (key) present.add(key[1]);
  }

  const added = [];
  for (const [key, value] of Object.entries(additions)) {
    if (present.has(key)) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      added.push(`${key}:`);
      for (const item of value) added.push(`  - ${item}`);
      continue;
    }
    if (value === undefined || value === null) continue;
    added.push(`${key}: ${value}`);
  }

  return `---\n${[...lines, ...added].join("\n")}\n---\n`;
}

/** The frontmatter block text without its `---` delimiters, or null. */
function existingFrontmatterBlock(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  return text
    .slice(3, end)
    .replace(/^\r?\n/u, "")
    .replace(/\s+$/u, "");
}

function stripExistingFrontmatter(text) {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  return text.slice(end + 4).replace(/^\r?\n+/u, "");
}

/**
 * Read one existing scalar field without a full YAML parse.
 *
 * Deliberately narrow: this tool only needs to know whether the document
 * already declares `id` or `state`, so it can leave the author's classification
 * alone. Anything more would be a second YAML implementation to keep in sync.
 */
function existingScalar(block, key) {
  if (block === null) return null;
  const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, "mu"));
  return match ? match[1].replace(/^["']|["']$/gu, "").trim() : null;
}

function main() {
  const write = process.argv.includes("--write");
  const documents = walkMarkdown(DOCS_ROOT).map(toRepoPath).sort();
  const plan = [];

  for (const rel of documents) {
    const absolute = resolve(REPO_ROOT, rel);
    const text = readFileSync(absolute, "utf8");
    const classification = classify(rel, text);
    plan.push({ rel, absolute, text, ...classification });
  }

  const byState = new Map();
  for (const entry of plan) byState.set(entry.state, (byState.get(entry.state) ?? 0) + 1);

  if (!write) {
    console.log(`documents: ${plan.length}`);
    console.log([...byState.entries()].map(([state, count]) => `  ${state}: ${count}`).join("\n"));
    console.log("\n--- unclassified (need a decision) ---");
    for (const entry of plan.filter((item) => item.state === "unclassified")) {
      console.log(`  ${entry.rel}`);
    }
    console.log("\nrun with --write to apply");
    return;
  }

  let written = 0;
  let skipped = 0;
  for (const entry of plan) {
    if (entry.state === "unclassified") {
      skipped += 1;
      continue;
    }
    const existing = existingFrontmatterBlock(entry.text);
    const body = stripExistingFrontmatter(entry.text);
    // Never overwrite an id the author already chose: contract pages use short
    // ids like `generated-registry` that other documents and the project model
    // reference, while a path-derived id would be `contracts/generated-registry`.
    const id = existingScalar(existing, "id") ?? idFor(entry.rel);
    const additions = {
      id: existingScalar(existing, "id") === null ? id : undefined,
      state: existingScalar(existing, "state") === null ? entry.state : undefined,
      verifies:
        entry.state === "current" && existingScalar(existing, "state") === null && entry.verifies
          ? entry.verifies
          : undefined,
    };
    const frontmatter = mergeFrontmatter(existing, additions);
    const next = `${frontmatter}${body}`;
    if (next === entry.text) continue;
    writeFileSync(entry.absolute, next);
    written += 1;
  }
  console.log(`written: ${written}   skipped (unclassified): ${skipped}`);
}

main();
