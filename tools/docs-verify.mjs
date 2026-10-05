#!/usr/bin/env node
// Structure/dependency checks; no claim that prose is true and no command execution.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdown, parseYamlObject, resolveLocalReference, exactPathExists } from "./document-model.mjs";
import { readYamlFiles, REPO_ROOT } from "./project-navigation.mjs";

function markdownFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith(".md") ? [path] : [];
  });
}

export async function verifyDocuments({ root = REPO_ROOT, mode = "all", base = "HEAD" } = {}) {
  if (!["all", "changed", "staged"].includes(mode)) throw new Error("invalid document selection");
  const repoPath = (path) => relative(root, path).replaceAll("\\", "/");
  const stagedFiles =
    mode === "staged"
      ? execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean)
      : [];
  const stagedPaths = new Set(stagedFiles);
  for (const path of stagedFiles) {
    const parts = path.split("/");
    while (parts.length > 1) {
      parts.pop();
      stagedPaths.add(parts.join("/"));
    }
  }
  const treeExists = (target) =>
    mode === "staged" ? stagedPaths.has(repoPath(target)) : exactPathExists(root, target);
  let selected = null;
  if (mode !== "all") {
    const git = (...args) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
        .split("\0")
        .filter(Boolean);
    // Do not convert a broken git invocation into a successful empty check.
    selected = new Set(
      git("diff", ...(mode === "staged" ? ["--cached"] : [base]), "--name-only", "-z", "--", "docs"),
    );
    if (mode === "changed")
      for (const path of git("ls-files", "--others", "--exclude-standard", "-z", "--", "docs"))
        selected.add(path);
  }
  const findings = [],
    warnings = [],
    index = new Map(),
    ids = new Map();
  const add = (rule, doc, reason, line) => findings.push({ rule, doc, reason, ...(line ? { line } : {}) });
  const read = (path) =>
    mode === "staged" && selected.has(repoPath(path))
      ? execFileSync("git", ["show", `:${repoPath(path)}`], { cwd: root, encoding: "utf8" })
      : readFileSync(path, "utf8");
  // Staged checks use the index snapshot for ALL tracked docs: IDs and incoming
  // links must not accidentally be validated against unstaged content.
  let paths = markdownFiles(resolve(root, "docs"));
  if (mode === "staged") {
    paths = execFileSync("git", ["ls-files", "-z", "--", "docs"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter((path) => path.endsWith(".md"))
      .map((path) => resolve(root, path));
  }
  for (const path of paths) {
    const doc = repoPath(path);
    try {
      const source =
        mode === "staged"
          ? execFileSync("git", ["show", `:${doc}`], { cwd: root, encoding: "utf8" })
          : read(path);
      const parsed = parseMarkdown(source, doc);
      index.set(path, parsed);
      const fields = parsed.fields;
      if (typeof fields.id !== "string" || !fields.id)
        add("frontmatter-invalid", doc, "id must be a nonempty string");
      else if (ids.has(fields.id)) add("id-duplicate", doc, `id also used by ${ids.get(fields.id)}`);
      else ids.set(fields.id, doc);
      if (!["current", "history", "generated"].includes(fields.state))
        add("state-illegal", doc, "unknown document state");
      if (doc.startsWith("docs/archive/") && fields.state !== "history")
        add("state-illegal", doc, "archive documents must be history");
      const files = Array.isArray(fields.verifies) ? fields.verifies : fields.verifies?.files;
      if (fields.state === "current" && (!Array.isArray(files) || !files.length))
        add("current-without-verifier", doc, "declare dependency paths in verifies.files");
      for (const input of Array.isArray(files) ? files : []) {
        if (typeof input !== "string" || !treeExists(resolve(root, input.replace(/^\//u, ""))))
          add("verifies-target-missing", doc, String(input));
      }
      if (fields.state === "generated") {
        // No producer is registered for generated Markdown. A marker alone is
        // not a byte comparison; use history until an actual producer exists.
        add("generated-producer-missing", doc, "generated Markdown needs a registered reproducible producer");
      }
      if (fields.supersededBy) {
        const target = resolveLocalReference(root, path, fields.supersededBy);
        if (!target || !treeExists(target)) add("superseded-by-missing", doc, fields.supersededBy);
      }
    } catch (error) {
      add("frontmatter-invalid", doc, error.message);
    }
  }
  // Full incoming-link check is inexpensive and detects deletion/rename damage.
  for (const [path, parsed] of index) {
    for (const link of parsed.links) {
      try {
        const target = resolveLocalReference(root, path, link.target);
        if (target && !treeExists(target)) {
          const item = {
            rule: "broken-reference",
            doc: repoPath(path),
            reason: link.target,
            line: link.line,
          };
          (parsed.fields.state === "history" ? warnings : findings).push(item);
        }
      } catch (error) {
        (parsed.fields.state === "history" ? warnings : findings).push({
          rule: "broken-reference",
          doc: repoPath(path),
          reason: error.message,
          line: link.line,
        });
      }
    }
    const visited = new Set([path]);
    let next = parsed.fields.supersededBy;
    let from = path;
    while (next) {
      const target = resolveLocalReference(root, from, next);
      if (!target || !index.has(target)) break;
      if (visited.has(target)) {
        add("supersession-cycle", repoPath(path), "replacement cycle");
        break;
      }
      visited.add(target);
      from = target;
      next = index.get(target).fields.supersededBy;
    }
  }
  for (const dir of ["project/domains", "project/workstreams/active"]) {
    const metadata =
      mode === "staged"
        ? stagedFiles
            .filter((path) => path.startsWith(dir + "/") && /\.ya?ml$/u.test(path))
            .map((path) => ({
              path: resolve(root, path),
              value: parseYamlObject(
                execFileSync("git", ["show", `:${path}`], { cwd: root, encoding: "utf8" }),
                path,
              ),
            }))
        : await readYamlFiles(resolve(root, dir));
    for (const { path, value } of metadata) {
      const targets = [...(value.currentDocs ?? []), ...Object.values(value.authority ?? {})];
      for (const target of targets) {
        const doc = index.get(resolve(root, target));
        if (!doc || doc.fields.state !== "current")
          add("history-used-as-entry", repoPath(path), `authority must resolve to current: ${target}`);
      }
    }
  }
  for (const entry of ["README.md", "AGENTS.md", "OEngine/AGENTS.md"]) {
    const path = resolve(root, entry);
    if (!treeExists(path)) continue;
    const source =
      mode === "staged"
        ? execFileSync("git", ["show", `:${entry}`], { cwd: root, encoding: "utf8" })
        : readFileSync(path, "utf8");
    for (const link of parseMarkdown(source, entry, false).links) {
      try {
        const target = resolveLocalReference(root, path, link.target);
        if (target && !treeExists(target)) add("broken-reference", entry, link.target, link.line);
      } catch (error) {
        add("broken-reference", entry, error.message, link.line);
      }
    }
  }
  return {
    documents: index.size,
    selection: mode,
    selectedDocuments: selected ? selected.size : index.size,
    scope: "document structure, dependencies and current navigation; not prose truth",
    total: findings.length,
    findings,
    warnings,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const known = new Set(["--json", "--staged", "--changed", "--base", "--max"]);
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) throw new Error(`unknown argument ${args[i]}`);
    if (["--base", "--max"].includes(args[i]) && (!args[++i] || args[i].startsWith("--")))
      throw new Error("missing option value");
  }
  if (args.includes("--staged") && args.includes("--changed")) throw new Error("choose staged or changed");
  const value = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback);
  const max = Number(value("--max", 8));
  if (!Number.isInteger(max) || max < 0) throw new Error("--max requires a nonnegative integer");
  const report = await verifyDocuments({
    mode: args.includes("--staged") ? "staged" : args.includes("--changed") ? "changed" : "all",
    base: value("--base", "HEAD"),
  });
  console.log(
    args.includes("--json")
      ? JSON.stringify(report, null, 2)
      : `${report.findings
          .slice(0, max)
          .map((item) => `${item.doc}:${item.line ?? 1} ${item.rule}: ${item.reason}`)
          .join(
            "\n",
          )}\ndocs-verify: ${report.total} finding(s), ${report.warnings.length} historical warning(s), ${report.documents} documents`,
  );
  if (report.total) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
