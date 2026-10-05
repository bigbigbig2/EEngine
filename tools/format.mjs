#!/usr/bin/env node
/**
 * EEngine source formatter.
 *
 * Why this exists
 * ---------------
 * `eengine-code-style` (this project's own style contract) says "use existing
 * Prettier/ESLint configuration when the repository has one". There was none —
 * no dependency, no config, no script — so the documented rules had no
 * mechanical enforcement, and the code drifted: 2,946 lines hold two or more
 * statements and 8,442 control-flow statements have no braces.
 *
 * Design decisions that are not obvious
 * -------------------------------------
 * 1. **Prettier is imported in-process, never spawned.** Child-process creation
 *    is denied in the environment this was built in: `spawnSync(node, ...)`
 *    fails with EPERM even for `node --version`. Importing the library removes
 *    the dependency on child processes entirely and makes this tool runnable
 *    from any harness, including one that is itself sandboxed.
 * 2. **WGSL must survive formatting byte-for-byte.** Shader source in this
 *    repository lives inside TypeScript template literals. Prettier leaves
 *    template literal *contents* untouched, but that is a property of the tool,
 *    not a guarantee of this repository — so `--verify-wgsl` proves it: it
 *    formats in memory, compares every template literal body, and only writes
 *    when all of them are identical. A formatter defect therefore fails the run
 *    instead of silently corrupting a shader.
 * 3. **This tool only formats.** Rules Prettier cannot express — control-flow
 *    braces, one statement per line, WGSL statement layout inside strings,
 *    vertically readable GPU descriptors — are enforced by
 *    `tools/style-guard.mjs`. Keeping them separate means a formatting run
 *    never has to decide a policy question.
 *
 * Usage
 * -----
 *   node tools/format.mjs --check [paths...]        report only; exit 1 if any differ
 *   node tools/format.mjs --write [paths...]        format in place
 *   node tools/format.mjs --list-different [paths...]
 *   node tools/format.mjs --verify-wgsl [paths...]  format + prove WGSL intact
 *   node tools/format.mjs --check --json [paths...] machine-readable result
 *
 * `--json` exists so `tools/check-runners.mjs` can consume the result without
 * parsing human prose. A verifier that greps a summary line breaks the first
 * time someone rewords the summary.
 *
 * Formatter resolution order: `EENGINE_PRETTIER` -> local `node_modules` ->
 * global npm prefix -> `prettier` on PATH.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/** Directories never walked: generated output, vendored upstream, tool stores. */
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  ".test-dist",
  ".git",
  ".local",
  ".pnpm-store",
  ".npm-cache",
  ".vite",
  "temp",
  ".codex-temp",
  ".workbuddy-ai",
  "upstream",
  "build",
  "build-wasm",
  "build-wasm-threads",
]);

/**
 * Format targets, in review order. `OEngine/src` is the production engine and
 * the reason this tool exists. The list is explicit because widening the blast
 * radius of a formatter should be a deliberate act, not a side effect of a glob.
 *
 * `tools/atmosphere-port/` and `tools/fsr3-port/` are deliberately excluded.
 * They hold pinned upstream source manifests and licence records
 * (`sources.json`, `mapping.md`) whose diff shape is part of the provenance
 * evidence, plus generator scripts that mirror donor structure. Reformatting
 * them churns that evidence without improving engine readability, and Prettier
 * collapses their human-maintained arrays onto single lines — the opposite of
 * what an auditable source ledger wants. The exclusion is enforced by path
 * prefix so walking `tools` cannot reintroduce it.
 */
const FORMAT_TARGETS = Object.freeze(["OEngine/src", "OEngine/tests", "tools", "checks", "project"]);

/** Path prefixes never formatted, even when a parent target is walked. */
const EXCLUDE_PREFIXES = Object.freeze(["tools/atmosphere-port/", "tools/fsr3-port/"]);

const FORMATTABLE = new Set([".ts", ".mjs", ".js", ".json", ".yaml", ".yml", ".md"]);

/** Generated or lock files the formatter must never rewrite. */
const PROTECTED = Object.freeze(["package-lock.json", "docs/status.generated.md"]);

/** Extensions whose template literals are verified by `--verify-wgsl`. */
const SCRIPT_EXTENSIONS = new Set([".ts", ".mjs", ".js"]);

function toRepoPath(absolutePath) {
  return relative(REPO_ROOT, absolutePath).replaceAll("\\", "/");
}

function parserFor(file) {
  switch (extname(file)) {
    case ".ts":
      return "typescript";
    case ".mjs":
    case ".js":
      return "babel";
    case ".json":
      return "json";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".md":
      return "markdown";
    default:
      return "babel";
  }
}

function isProtected(absolutePath) {
  const rel = toRepoPath(absolutePath);
  return PROTECTED.some((entry) => rel === entry || rel.endsWith(`/${entry}`));
}

function walk(absolutePath, out = []) {
  const info = statSync(absolutePath);
  if (info.isFile()) {
    out.push(absolutePath);
    return out;
  }
  if (!info.isDirectory()) return out;
  for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      walk(join(absolutePath, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!FORMATTABLE.has(extname(entry.name))) continue;
    out.push(join(absolutePath, entry.name));
  }
  return out;
}

function collectFiles(inputs) {
  const targets = inputs.length > 0 ? inputs : FORMAT_TARGETS;
  const files = new Set();
  for (const target of targets) {
    const absolute = resolve(REPO_ROOT, target);
    if (!existsSync(absolute)) {
      process.stderr.write(`format: target does not exist, skipped: ${target}\n`);
      continue;
    }
    for (const file of walk(absolute)) {
      if (isProtected(file)) continue;
      const rel = toRepoPath(file);
      if (EXCLUDE_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;
      files.add(file);
    }
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

/**
 * Load Prettier as a module, together with the language plugins it needs.
 *
 * Prettier 3 no longer bundles the parsers into the core entry point: importing
 * `prettier/index.js` directly gives `format()` without any language support,
 * and every call fails with a parse error. `<Prettier 3` shipped everything in
 * one file, which is why this is easy to miss. Explicit plugin loading keeps the
 * tool working for both major versions.
 *
 * Returns `{ format, version, source }` or `null`.
 */
async function loadPrettier() {
  const explicit = process.env.EENGINE_PRETTIER;
  const candidates = [];
  if (explicit) candidates.push(explicit);
  candidates.push(join(REPO_ROOT, "node_modules", "prettier", "index.cjs"));
  candidates.push(join(REPO_ROOT, "node_modules", "prettier", "index.js"));
  candidates.push(join(REPO_ROOT, "OEngine", "node_modules", "prettier", "index.js"));
  candidates.push(join(homedir(), "AppData", "Roaming", "npm", "node_modules", "prettier", "index.js"));
  candidates.push("/usr/local/lib/node_modules/prettier/index.js");
  candidates.push("/usr/lib/node_modules/prettier/index.js");

  let api = null;
  let source = null;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const module = await import(pathToFileURL(candidate).href);
      const loaded = module.default ?? module;
      if (typeof loaded.format === "function") {
        api = loaded;
        source = candidate;
        break;
      }
    } catch {
      // Try the next candidate; a broken install should not abort resolution.
    }
  }

  if (api === null) {
    try {
      const resolved = require.resolve("prettier");
      const module = await import(pathToFileURL(resolved).href);
      const loaded = module.default ?? module;
      if (typeof loaded.format === "function") {
        api = loaded;
        source = resolved;
      }
    } catch {
      // Not resolvable from here.
    }
  }
  if (api === null) return null;

  const plugins = [];
  const pluginDirectory = join(dirname(source), "plugins");
  for (const plugin of ["typescript", "estree", "babel", "yaml", "markdown", "json"]) {
    for (const extension of [".mjs", ".js"]) {
      const candidate = join(pluginDirectory, `${plugin}${extension}`);
      if (!existsSync(candidate)) continue;
      try {
        const module = await import(pathToFileURL(candidate).href);
        plugins.push(module.default ?? module);
        break;
      } catch {
        // Plugin not importable; the parser list below reports the gap.
      }
    }
  }

  return { format: api.format, version: api.version ?? "unknown", source, plugins };
}

/**
 * Extract every template literal from script source using the real TypeScript
 * parser.
 *
 * This replaced a hand-written backtick scanner that produced false failures:
 * it treated backticks inside strings and comments as literal openers, so the
 * reported "changed literal" was frequently not a template literal at all. The
 * compiler API reports exact source spans, which is what a byte comparison
 * needs.
 *
 * Each entry separates the two parts that have genuinely different guarantees:
 *
 *   - `staticText`: the literal characters between `${...}` holes. Prettier must
 *     never alter these; they are the WGSL itself.
 *   - `expressions`: the interpolated TypeScript expressions. Prettier is
 *     allowed to reprint these, and it does remove redundant parentheses, so
 *     they are compared after formatting rather than byte-for-byte.
 *
 * Returns `null` when TypeScript is unavailable, and the caller then degrades to
 * reporting that the guarantee could not be checked instead of claiming success.
 */
async function loadTypeScript() {
  const candidates = [
    join(REPO_ROOT, "OEngine", "node_modules", "typescript", "lib", "typescript.js"),
    join(REPO_ROOT, "node_modules", "typescript", "lib", "typescript.js"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const module = await import(pathToFileURL(candidate).href);
      const api = module.default ?? module;
      if (typeof api.createSourceFile === "function") return api;
    } catch {
      // Try the next candidate.
    }
  }
  try {
    const resolved = require.resolve("typescript");
    const module = await import(pathToFileURL(resolved).href);
    const api = module.default ?? module;
    if (typeof api.createSourceFile === "function") return api;
  } catch {
    // Not resolvable.
  }
  return null;
}

function extractTemplateLiterals(ts, source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const literals = [];
  const visit = (node) => {
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.push({ start: node.getStart(sourceFile), staticText: node.text, expressions: [] });
    } else if (ts.isTemplateExpression(node)) {
      // Use the parser's own `text` for the static parts.
      //
      // Slicing raw source between `getStart()`/`getEnd()` does not work here:
      // for a template span, `literal.getStart()` points at the `}` that closes
      // the preceding `${...}` rather than at a backtick, so a naive slice
      // silently swallows the interpolation expressions into the "static" text.
      // The first fix attempt did exactly that and produced false WGSL failures.
      // `head.text` and `span.literal.text` are the cooked static contents and
      // are unambiguous.
      literals.push({
        start: node.getStart(sourceFile),
        staticText: [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("\u0000"),
        expressions: node.templateSpans.map((span) =>
          source.slice(span.expression.getStart(sourceFile), span.expression.getEnd()),
        ),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return literals.sort((left, right) => left.start - right.start);
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node tools/format.mjs <mode> [paths...]",
      "",
      "  --check            report files that differ (no writes); exit 1 if any",
      "  --write            format files in place",
      "  --list-different   list differing files only",
      "  --verify-wgsl      format in memory, prove every template literal body is unchanged, then write",
      "  --json             machine-readable result on stdout",
      "",
      `Default targets: ${FORMAT_TARGETS.join(", ")}`,
      "Formatter override: EENGINE_PRETTIER=<path to prettier index.js>",
    ].join("\n") + "\n",
  );
}

const MODES = new Set(["--check", "--write", "--list-different", "--verify-wgsl"]);
const FLAGS = new Set(["--json"]);

/**
 * Format until the output stops changing, and return the stable result.
 *
 * Prettier is not idempotent on every input. Measured on this repository:
 * `OEngine/src/assets/web-cook/WebCookWorkerEntrypoint.ts` changes on pass 1,
 * and pass 2 then produces a *different* result that finally stabilises. A
 * single-pass formatter therefore writes text that a second run still wants to
 * change, so `--check` reports a file that `--write` has already "fixed".
 *
 * Iterating is the difference between a formatter that converges and one that
 * leaves the repository permanently dirty. The cap is a safety net: a parser
 * bug that oscillates must fail loudly rather than spin, and 8 passes is far
 * beyond any legitimate need.
 */
async function formatUntilStable(prettier, source, file, maximumPasses = 8) {
  let current = source;
  for (let pass = 0; pass < maximumPasses; pass += 1) {
    const next = await prettier.format(current, {
      parser: parserFor(file),
      printWidth: 110,
      plugins: prettier.plugins,
    });
    if (next === current) return current;
    current = next;
  }
  throw new Error(
    `formatting did not stabilise after ${maximumPasses} passes; ` +
      "the formatter and this file disagree in a cycle",
  );
}

/**
 * Compare every template literal between two versions of a file.
 *
 * Shared by the read-only (`--check --verify-wgsl`) and writing
 * (`--verify-wgsl`) modes so both enforce the identical guarantee; two
 * implementations would drift and one of them would end up weaker.
 */
async function compareTemplateLiterals(ts, prettier, file, before, after) {
  const staticFailures = [];
  const expressionFailures = [];
  const beforeLiterals = extractTemplateLiterals(ts, before, file);
  if (beforeLiterals.length === 0) return { staticFailures, expressionFailures, literalCount: 0 };
  const afterLiterals = extractTemplateLiterals(ts, after, file);
  const literalCount = beforeLiterals.length;

  if (afterLiterals.length !== beforeLiterals.length) {
    staticFailures.push({
      file,
      reason: `template literal count changed: ${beforeLiterals.length} -> ${afterLiterals.length}`,
    });
    return { staticFailures, expressionFailures, literalCount };
  }

  for (let index = 0; index < beforeLiterals.length; index += 1) {
    // Static text is the shader. It must not move by a single byte.
    if (beforeLiterals[index].staticText !== afterLiterals[index].staticText) {
      staticFailures.push({ file, reason: `WGSL text in template literal #${index + 1} changed` });
      break;
    }
    // Interpolated expressions may be reprinted (Prettier drops redundant
    // parentheses), so compare them after formatting: feeding both versions
    // back through the printer must converge on the same text.
    const beforeExpressions = beforeLiterals[index].expressions;
    const afterExpressions = afterLiterals[index].expressions;
    if (beforeExpressions.length !== afterExpressions.length) {
      expressionFailures.push({ file, reason: `template literal #${index + 1} interpolation count changed` });
      break;
    }
    let mismatch = false;
    for (let slot = 0; slot < beforeExpressions.length; slot += 1) {
      const left = await prettier.format(`const v = (${beforeExpressions[slot]});`, {
        parser: "typescript",
        printWidth: 110,
        plugins: prettier.plugins,
      });
      const right = await prettier.format(`const v = (${afterExpressions[slot]});`, {
        parser: "typescript",
        printWidth: 110,
        plugins: prettier.plugins,
      });
      if (left !== right) {
        expressionFailures.push({
          file,
          reason: `template literal #${index + 1} interpolation ${slot + 1} changed meaning`,
        });
        mismatch = true;
        break;
      }
    }
    if (mismatch) break;
  }
  return { staticFailures, expressionFailures, literalCount };
}

async function main() {
  const argv = process.argv.slice(2);
  // Flags are separated from the mode: taking the first `--` argument as the
  // mode makes `--check --json` fail with "unknown mode '--json'".
  const mode = argv.find((arg) => MODES.has(arg)) ?? "--check";
  const json = argv.includes("--json");
  const paths = argv.filter((arg) => !arg.startsWith("--"));
  const known = new Set([...MODES, ...FLAGS, "--help"]);

  if (argv.includes("--help")) {
    printHelp();
    return;
  }
  if (argv.some((arg) => arg.startsWith("--") && !known.has(arg))) {
    const bad = argv.find((arg) => arg.startsWith("--") && !known.has(arg));
    process.stderr.write(`format: unknown option '${bad}'. Try --help.\n`);
    process.exitCode = 2;
    return;
  }

  const prettier = await loadPrettier();
  if (prettier === null) {
    process.stderr.write(
      [
        "format: no Prettier available.",
        "",
        "Provide one of:",
        "  - EENGINE_PRETTIER=<path to prettier/index.js>",
        "  - a local node_modules/prettier installation",
        "  - a global npm install of prettier",
        "",
      ].join("\n"),
    );
    process.exitCode = 3;
    return;
  }

  const files = collectFiles(paths);
  if (files.length === 0) {
    process.stdout.write("format: no formattable files matched.\n");
    return;
  }
  const scope = paths.length > 0 ? paths.join(" ") : FORMAT_TARGETS.join(" ");

  // `--check --verify-wgsl` is the read-only form of the guarantee: it proves
  // that formatting would not alter any shader text, without writing anything.
  // The verifier needs this combination — a check that mutates the tree is not
  // a check.
  const verifyWgsl = mode === "--verify-wgsl" || (mode === "--check" && argv.includes("--verify-wgsl"));
  const readOnly = mode === "--check" || mode === "--list-different";

  // Verify mode needs the real parser to separate static shader text from
  // interpolated expressions. Without it the tool degrades to a plain format
  // and says so, rather than reporting a guarantee it did not check.
  let ts = null;
  if (verifyWgsl) {
    ts = await loadTypeScript();
    if (ts === null) {
      process.stderr.write(
        "format: WGSL verification needs TypeScript to analyse template literals; " +
          "no TypeScript installation found.\n",
      );
      process.exitCode = 4;
      return;
    }
  }

  const differing = [];
  const staticFailures = [];
  const expressionFailures = [];
  const pending = new Map();
  let literalCount = 0;
  let literalFiles = 0;

  for (const file of files) {
    const original = readFileSync(file, "utf8");
    let formatted;
    try {
      formatted = await formatUntilStable(prettier, original, file);
    } catch (error) {
      process.stderr.write(`format: ${toRepoPath(file)} could not be parsed: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    if (formatted !== original) {
      differing.push(file);
      pending.set(file, { original, formatted });
    }

    // Verify even when the file is already formatted. Returning early here was
    // a real defect: on a formatted tree the tool reported "0 template literals
    // checked" and passed without verifying anything, which is the worst
    // possible outcome for a guarantee — green while unexercised. The comparison
    // is between `original` and the stable formatting of it, so it is meaningful
    // for unchanged files too.
    if (ts === null || !SCRIPT_EXTENSIONS.has(extname(file))) continue;
    const comparison = await compareTemplateLiterals(ts, prettier, file, original, formatted);
    if (comparison.literalCount === 0) continue;
    literalFiles += 1;
    literalCount += comparison.literalCount;
    staticFailures.push(...comparison.staticFailures);
    expressionFailures.push(...comparison.expressionFailures);
  }

  const summary =
    `format: ${mode} — ${differing.length} of ${files.length} files differ, ` +
    `${literalCount} template literals in ${literalFiles} files analysed, via ${prettier.source} ` +
    `(prettier ${prettier.version}; scope: ${scope})`;

  const emit = (payload) => {
    if (json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stdout.write(summary + "\n");
  };

  if (readOnly) {
    if (mode === "--list-different") {
      for (const file of differing) process.stdout.write(`${toRepoPath(file)}\n`);
    }
    emit({
      ok: differing.length === 0 && staticFailures.length === 0 && expressionFailures.length === 0,
      mode,
      scanned: files.length,
      differing: differing.length,
      differingFiles: differing.slice(0, 200).map(toRepoPath),
      templateLiterals: literalCount,
      templateLiteralFiles: literalFiles,
      wgslVerified: verifyWgsl,
      wgslFailures: [...staticFailures, ...expressionFailures]
        .slice(0, 50)
        .map((failure) => `${toRepoPath(failure.file)}: ${failure.reason}`),
      prettier: prettier.version,
      scope,
    });
    if (!json) {
      for (const failure of staticFailures) {
        process.stderr.write(`FAIL ${toRepoPath(failure.file)}: ${failure.reason}\n`);
      }
      for (const failure of expressionFailures) {
        process.stderr.write(`FAIL ${toRepoPath(failure.file)}: ${failure.reason}\n`);
      }
    }
    if (
      mode === "--check" &&
      (differing.length > 0 || staticFailures.length > 0 || expressionFailures.length > 0)
    ) {
      process.exitCode = 1;
    }
    return;
  }

  // --write and --verify-wgsl both write; --verify-wgsl refuses to write at all
  // when any shader text or interpolation would change.
  if (verifyWgsl && (staticFailures.length > 0 || expressionFailures.length > 0)) {
    for (const failure of staticFailures) {
      process.stderr.write(`FAIL ${toRepoPath(failure.file)}: ${failure.reason}\n`);
    }
    for (const failure of expressionFailures) {
      process.stderr.write(`FAIL ${toRepoPath(failure.file)}: ${failure.reason}\n`);
    }
    process.stderr.write(
      `format: WGSL preservation FAILED (${staticFailures.length} shader-text, ` +
        `${expressionFailures.length} interpolation). Nothing was written.\n`,
    );
    process.exitCode = 1;
    return;
  }

  for (const [file, entry] of pending) writeFileSync(file, entry.formatted);
  const written = {
    ok: true,
    mode,
    scanned: files.length,
    written: pending.size,
    templateLiterals: literalCount,
    templateLiteralFiles: literalFiles,
    wgslVerified: mode === "--verify-wgsl",
    prettier: prettier.version,
    scope,
  };
  if (json) process.stdout.write(JSON.stringify(written, null, 2) + "\n");
  else {
    process.stdout.write(summary + "\n");
    if (mode === "--verify-wgsl") {
      process.stdout.write(
        "format: WGSL preservation verified — every shader text block byte-identical, " +
          "every interpolation semantically identical after formatting.\n",
      );
    }
  }
}

await main();
