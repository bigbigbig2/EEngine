/**
 * Rewrite inbound links from archived documents to their successors.
 *
 * Archiving 24 documents broke every link that pointed at them. This tool
 * performs the mechanical rewrite from the old filename to the new location,
 * preserving whatever relative form each document used (a link written as
 * `../next-design/x.md` from `docs/next-execution/` must become
 * `../archive/x.md`, not an absolute path).
 *
 * It only rewrites the final path segment plus the directory that precedes it,
 * so it cannot corrupt prose that mentions a document by its bare filename.
 *
 * Usage: node tools/docs-rewrite-links.mjs --plan
 *        node tools/docs-rewrite-links.mjs --write
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SKIP = new Set(["node_modules", "dist", ".test-dist", ".git", ".local", "temp", "archive"]);

/**
 * Old document name -> new document name.
 *
 * The archived V3 generation is superseded by the rebuild design; the phase
 * records are superseded by the rebuild execution plan. Links kept pointing at
 * the old names would silently become "history is the current entry", which is
 * exactly the drift `tools/docs-verify.mjs` reports.
 */
const RENAMES = new Map([
  [
    "eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md",
    "eengine-extreme-performance-rebuild-2026-10.md",
  ],
  [
    "surface-work-v3-cost-bounded-final-refactor-design-2026-10.md",
    "eengine-extreme-performance-rebuild-2026-10.md",
  ],
  ["surface-work-v3-optimization-v1-design-2026-10.md", "eengine-extreme-performance-rebuild-2026-10.md"],
  ["eengine-next-overall-architecture-final-2026.md", "eengine-extreme-performance-rebuild-2026-10.md"],
  [
    "surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md",
    "eengine-extreme-performance-rebuild-execution-2026-10.md",
  ],
  [
    "surface-work-v3-optimization-v1-execution-2026-10.md",
    "eengine-extreme-performance-rebuild-execution-2026-10.md",
  ],
  [
    "surface-work-v3-classifier-store-repair-plan-2026-10.md",
    "eengine-extreme-performance-rebuild-execution-2026-10.md",
  ],
  ["surface-work-runtime-v3-rebuild-2026.md", "eengine-extreme-performance-rebuild-execution-2026-10.md"],
  [
    "surface-work-v3-cost-bounded-final-refactor-progress-2026-10.md",
    "eengine-extreme-performance-rebuild-execution-2026-10.md",
  ],
  [
    "surface-work-v3-cost-bounded-refactor-review-and-readiness-2026-10.md",
    "eengine-extreme-performance-rebuild-execution-2026-10.md",
  ],
]);

/**
 * Documents already archived keep their own file; only the directory changes.
 *
 * Two successor families must be told apart: the design master lives in
 * `next-design/`, the execution plan in `next-execution/`. Treating every
 * successor as a design document produced links like
 * `../next-design/eengine-extreme-performance-rebuild-execution-2026-10.md`,
 * which does not exist — a rewrite that silently breaks the link it was
 * supposed to repair.
 */
function successorPath(name) {
  if (name.startsWith("eengine-extreme-performance-rebuild-execution")) {
    return `docs/next-execution/${name}`;
  }
  if (name.startsWith("eengine-extreme-performance-rebuild")) {
    return `docs/next-design/${name}`;
  }
  return `docs/archive/${name}`;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue;
      walk(absolute, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) out.push(absolute);
  }
  return out;
}

/**
 * Rewrite a Markdown link target.
 *
 * Handles the two shapes that actually occur: `path/to/name.md` and
 * `name.md` (same directory). The directory prefix is recomputed relative to
 * the referencing document so the link stays valid after the move.
 */
function rewriteTarget(fromFile, target) {
  const hashIndex = target.indexOf("#");
  const anchor = hashIndex === -1 ? "" : target.slice(hashIndex);
  const path = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const slash = path.lastIndexOf("/");
  const name = slash === -1 ? path : path.slice(slash + 1);

  // Second pass: an earlier run of this tool mapped every successor to
  // `next-design/`, including the execution plan, which lives in
  // `next-execution/`. Those links are now wrong but their basename is not in
  // RENAMES (it is already a successor name), so a plain name lookup would skip
  // them and leave the damage in place. Repair by successor identity, not by
  // old name.
  const alreadySuccessor = name.startsWith("eengine-extreme-performance-rebuild");
  const replacement = alreadySuccessor ? name : RENAMES.get(name);
  if (replacement !== undefined) {
    const absoluteNew = resolve(REPO_ROOT, successorPath(replacement));
    let rel = relative(dirname(fromFile), absoluteNew).replaceAll("\\", "/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    const result = rel + anchor;
    return result === target ? null : result;
  }

  // Generic fallback: any link whose target no longer exists but whose basename
  // is present in `docs/archive/` is redirected there. Twenty-four documents
  // moved in one step, and enumerating every referrer by hand is how links rot;
  // resolving by basename handles the whole class, including links this tool
  // never anticipated.
  if (/^(?:\.{1,2}\/|docs\/)/u.test(target) || slash === -1) {
    const asIs = resolve(dirname(fromFile), path);
    if (!existsSync(asIs)) {
      const archived = resolve(REPO_ROOT, "docs", "archive", name);
      if (name.endsWith(".md") && existsSync(archived)) {
        let rel = relative(dirname(fromFile), archived).replaceAll("\\", "/");
        if (!rel.startsWith(".")) rel = `./${rel}`;
        return rel + anchor;
      }
    }
  }
  return null;
}

function main() {
  const write = process.argv.includes("--write");
  const files = [
    ...walk(resolve(REPO_ROOT, "docs")),
    resolve(REPO_ROOT, "AGENTS.md"),
    resolve(REPO_ROOT, "README.md"),
  ];
  let changedFiles = 0;
  let changedLinks = 0;

  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const next = text.replace(/\]\(([^)\s]+)\)/gu, (whole, target) => {
      const rewritten = rewriteTarget(file, target);
      if (rewritten === null) return whole;
      changedLinks += 1;
      return `](${rewritten})`;
    });
    if (next === text) continue;
    changedFiles += 1;
    if (write) writeFileSync(file, next);
    else process.stdout.write(`would rewrite ${relative(REPO_ROOT, file)}\n`);
  }

  process.stdout.write(
    `${write ? "rewrote" : "would rewrite"}: ${changedLinks} link(s) in ${changedFiles} file(s)\n`,
  );
}

main();
