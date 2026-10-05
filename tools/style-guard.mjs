#!/usr/bin/env node
/**
 * EEngine style guard.
 *
 * Scope: the source-shape rules from `.agents/skills/eengine-code-style/SKILL.md`
 * that a formatter cannot express. Prettier normalises whitespace, line breaks
 * and indentation; it does not decide that an `if` needs braces, that a
 * statement deserves its own line, or that a GPU descriptor should be readable
 * top-to-bottom. Those are the rules that drifted, and this tool is what makes
 * them enforceable instead of aspirational.
 *
 * Rules implemented
 * -----------------
 *   TS-BRACES        Control-flow bodies must be brace-delimited. The style
 *                    contract explicitly calls out runs of `if (x) return;`
 *                    in GPU-facing code.
 *   TS-ONE-STATEMENT One statement per line. Multi-statement lines are the
 *                    single largest readability defect measured in this
 *                    repository (2,946 lines over 361 files).
 *   TS-INLINE-MEMBER Type/interface bodies must not be compressed onto the
 *                    declaration line (`interface A {readonly x:number;}`).
 *   TS-BLANK-RUN     No run of more than two consecutive blank lines.
 *
 * Deliberately NOT implemented
 * ----------------------------
 *   - Anything inside template literals. Shader source is a string, and its
 *     layout is a WGSL question. A TypeScript-source scanner has no business
 *     judging it, and doing so would fight the WGSL rules rather than enforce
 *     them.
 *   - Line-length limits. Prettier owns wrapping; duplicating it produces two
 *     sources of truth that disagree.
 *   - Naming and structure ("no Manager/Coordinator", "one owner"). Those need
 *     semantics a scanner does not have. They stay review questions.
 *
 * Usage
 * -----
 *   node tools/style-guard.mjs                  scan default targets, summary
 *   node tools/style-guard.mjs <paths...>       scan specific paths
 *   node tools/style-guard.mjs --json           machine-readable output
 *   node tools/style-guard.mjs --rule TS-BRACES only run named rules
 *   node tools/style-guard.mjs --max <n>        list at most n findings per rule
 *
 * Exit code is 1 when any finding is reported, so this can gate a check.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Default scan targets.
 *
 * `OEngine/src` is the production engine. Test files are included because the
 * same rules exist for the same readability reasons, but they are far less
 * performance-critical — treat findings there as advisory in review.
 */
const DEFAULT_TARGETS = Object.freeze(["OEngine/src"]);

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  ".test-dist",
  ".git",
  ".local",
  "temp",
  ".codex-temp",
  "upstream",
  "build",
  "build-wasm",
  "build-wasm-threads",
]);

function toRepoPath(absolutePath) {
  return relative(REPO_ROOT, absolutePath).replaceAll("\\", "/");
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
      walk(resolve(absolutePath, entry.name), out);
      continue;
    }
    if (entry.isFile() && extname(entry.name) === ".ts") out.push(resolve(absolutePath, entry.name));
  }
  return out;
}

/**
 * Build a per-line mask of characters that live inside a comment, a string, or
 * a template literal.
 *
 * Every rule depends on this. Without it, `if (x) return;` inside a JSDoc
 * example and `a; b;` inside a shader string both produce findings, which is how
 * a style tool earns a reputation for noise and then gets ignored. A small
 * character scanner is used instead of a full parser because the guard must
 * work on files that do not typecheck yet.
 *
 * Returns an array of booleans, one per source character, where `true` means
 * "this character is inside a comment or literal and must not be inspected".
 */
function buildMask(source) {
  const mask = new Uint8Array(source.length);
  const stack = [];
  let state = "code";
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (state === "code") {
      if (character === "/" && next === "/") {
        state = "line-comment";
        mask[index] = 1;
        index += 1;
        mask[index] = 1;
        index += 1;
        continue;
      }
      if (character === "/" && next === "*") {
        state = "block-comment";
        mask[index] = 1;
        index += 1;
        mask[index] = 1;
        index += 1;
        continue;
      }
      if (character === '"' || character === "'") {
        state = "string";
        stack.push(character);
        mask[index] = 1;
        index += 1;
        continue;
      }
      if (character === "`") {
        state = "template";
        stack.push("`");
        mask[index] = 1;
        index += 1;
        continue;
      }
      index += 1;
      continue;
    }

    // Inside a comment or literal: mask everything until the terminator.
    mask[index] = 1;

    if (state === "line-comment") {
      if (character === "\n") state = "code";
      index += 1;
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        mask[index + 1] = 1;
        index += 2;
        state = "code";
        continue;
      }
      index += 1;
      continue;
    }
    if (character === "\\") {
      // Escaped character: mask it and the one after it.
      if (index + 1 < source.length) mask[index + 1] = 1;
      index += 2;
      continue;
    }
    if (state === "string" && character === stack[stack.length - 1]) {
      stack.pop();
      state = stack.length > 0 ? "template" : "code";
      index += 1;
      continue;
    }
    if (state === "template" && character === "`") {
      stack.pop();
      state = stack.length > 0 ? "template" : "code";
      index += 1;
      continue;
    }
    // Interpolations inside a template are masked too. Shader generation code
    // legitimately puts whole statements inside `${...}`, and that is a WGSL
    // layout decision owned by the shader rules, not by TypeScript style.
    index += 1;
  }
  return mask;
}

/** True when the character at `index` is real code (not comment/literal). */
function isCode(mask, index) {
  return index >= 0 && index < mask.length && mask[index] === 0;
}

function lineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/**
 * TS-BRACES — a control-flow body must open a block.
 *
 * `for`/`while` headers contain their own semicolons, so only the character
 * after the closing parenthesis is examined. `else`, `do` and `try` are checked
 * directly.
 */
function ruleBraces(source, mask) {
  const findings = [];
  const starts = lineStarts(source);
  const pattern = /\b(if|for|while|else|do)\b/g;
  for (const match of source.matchAll(pattern)) {
    const keyword = match[1];
    const keywordIndex = match.index;
    if (!isCode(mask, keywordIndex)) continue;
    // Skip `else if`, which has its own `if` match.
    let cursor = keywordIndex + keyword.length;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if (keyword === "else" && source.startsWith("if", cursor)) continue;
    if (keyword === "do") {
      if (source[cursor] !== "{")
        findings.push({
          line: lineOf(starts, keywordIndex),
          text: source.slice(keywordIndex, cursor + 24).split("\n")[0],
        });
      continue;
    }
    // Find the matching close paren of the condition.
    if (source[cursor] !== "(") continue;
    let depth = 0;
    let scan = cursor;
    for (; scan < source.length; scan += 1) {
      if (!isCode(mask, scan)) continue;
      if (source[scan] === "(") depth += 1;
      else if (source[scan] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    let body = scan + 1;
    while (body < source.length && /\s/.test(source[body])) body += 1;
    if (source[body] !== "{") {
      findings.push({
        line: lineOf(starts, keywordIndex),
        text: source
          .slice(keywordIndex, body + 32)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 90),
      });
    }
  }
  return findings;
}

/**
 * TS-ONE-STATEMENT — at most one statement terminator per code line.
 *
 * Counting raw semicolons is wrong and was the first implementation's mistake:
 * `private state: { x: number; y: number }` is ONE declaration whose semicolons
 * live inside an object *type* literal, and flagging it produced false findings
 * on ordinary TypeScript. The distinction that matters is object literal/type
 * versus block statement, which is decided by whether the brace sits in an
 * expression position.
 *
 * `for (;;)` headers are excluded by paren depth. A line with no semicolon at
 * brace depth 0 is reported only when the enclosing brace is a block, because
 * `if (x) { a(); b(); }` is a real one-statement-per-line violation while
 * `const t: { a: number; b: number } = v;` is not.
 */
function ruleOneStatement(source, mask) {
  const findings = [];
  const starts = lineStarts(source);

  // Track, for every offset, whether the innermost brace scope is a block.
  const braceIsBlock = [];
  const parenStack = [];
  const braceStack = [];
  let parenDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    braceIsBlock[index] = braceStack.length > 0 ? braceStack[braceStack.length - 1] : false;
    if (!isCode(mask, index)) continue;
    const character = source[index];
    if (character === "(") {
      parenDepth += 1;
      continue;
    }
    if (character === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (character === "{") {
      // Look back past whitespace for the token that introduces the brace.
      // A brace following `)` `;` `{` `}` or nothing is a statement block; one
      // following `=` `:` `,` or `return` is an object literal or type, whose
      // semicolons are member separators rather than statement terminators.
      let back = index - 1;
      while (back >= 0 && /\s/.test(source[back])) back -= 1;
      const previous = back >= 0 ? source[back] : "";
      const isBlock =
        previous === ")" ||
        previous === ";" ||
        previous === "{" ||
        previous === "}" ||
        previous === "" ||
        previous === ">";
      braceStack.push(isBlock);
      continue;
    }
    if (character === "}") {
      braceStack.pop();
      continue;
    }
  }

  for (let lineIndex = 0; lineIndex < starts.length; lineIndex += 1) {
    const from = starts[lineIndex];
    const to = lineIndex + 1 < starts.length ? starts[lineIndex + 1] : source.length;
    let terminators = 0;
    let innerDepth = 0;
    let parenDepth = 0;
    let outerBlock = false;
    let sample = "";
    for (let index = from; index < to; index += 1) {
      if (!isCode(mask, index)) continue;
      const character = source[index];
      if (character === "(") parenDepth += 1;
      else if (character === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (character === "{") innerDepth += 1;
      else if (character === "}") innerDepth = Math.max(0, innerDepth - 1);
      else if (character === ";" && innerDepth === 0 && parenDepth === 0) {
        // `parenDepth === 0` excludes the two separators of a `for (;;)` header,
        // which are loop syntax rather than statement terminators.
        terminators += 1;
        if (terminators === 2) {
          // The enclosing scope must be a real block for this to be two
          // statements rather than one typed declaration.
          outerBlock = braceIsBlock[from] === true;
          sample = source.slice(from, to).trim();
        }
      }
    }
    if (terminators >= 2 && outerBlock) {
      findings.push({ line: lineIndex + 1, text: `[${terminators} statements] ${sample.slice(0, 80)}` });
    }
  }
  return findings;
}

/**
 * TS-INLINE-MEMBER — a type or interface body must not start on its own
 * declaration line.
 *
 * This is the `interface A {readonly x:number;}` shape, which is both a
 * one-statement-per-line violation and the reason ABI records are hard to audit
 * against their WGSL counterparts.
 */
function ruleInlineMember(source, mask) {
  const findings = [];
  const starts = lineStarts(source);
  const pattern = /\b(interface|type|class|enum)\s+[A-Za-z_$][\w$]*[^={\n]*\{[^\n}]*\}/g;
  for (const match of source.matchAll(pattern)) {
    const index = match.index;
    if (!isCode(mask, index)) continue;
    const brace = source.indexOf("{", index);
    const close = source.indexOf("}", brace);
    if (brace === -1 || close === -1) continue;
    if (source.slice(brace, close).includes("\n")) continue;
    findings.push({ line: lineOf(starts, index), text: match[0].replace(/\s+/g, " ").trim().slice(0, 90) });
  }
  return findings;
}

/** TS-BLANK-RUN — no more than two consecutive blank lines. */
function ruleBlankRun(source) {
  const findings = [];
  const lines = source.split("\n");
  let run = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === "") {
      run += 1;
      if (run === 3) findings.push({ line: index + 1, text: "three or more consecutive blank lines" });
    } else {
      run = 0;
    }
  }
  return findings;
}

const RULES = Object.freeze({
  "TS-BRACES": { run: ruleBraces, description: "control-flow bodies must be brace-delimited" },
  "TS-ONE-STATEMENT": { run: ruleOneStatement, description: "one statement per line" },
  "TS-INLINE-MEMBER": {
    run: ruleInlineMember,
    description: "type bodies must not be inlined on the declaration line",
  },
  "TS-BLANK-RUN": { run: ruleBlankRun, description: "no more than two consecutive blank lines" },
});

function printHelp() {
  process.stdout.write(
    [
      "Usage: node tools/style-guard.mjs [paths...] [options]",
      "",
      "  --json           machine-readable report",
      "  --rule <id>      run only the named rule (repeatable)",
      "  --max <n>        list at most n findings per rule (default 5)",
      "  --quiet          summary only",
      "",
      `Default targets: ${DEFAULT_TARGETS.join(", ")}`,
      "",
      "Rules:",
    ]
      .concat(Object.entries(RULES).map(([id, rule]) => `  ${id.padEnd(18)} ${rule.description}`))
      .join("\n") + "\n",
  );
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    printHelp();
    return;
  }
  const json = argv.includes("--json");
  const quiet = argv.includes("--quiet");
  let maxPerRule = 5;
  const selectedRules = [];
  const paths = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json" || argument === "--quiet") continue;
    if (argument === "--rule") {
      const value = argv[++index];
      if (!value || !(value in RULES)) {
        process.stderr.write(
          `style-guard: unknown rule '${value ?? ""}'. Known: ${Object.keys(RULES).join(", ")}\n`,
        );
        process.exitCode = 2;
        return;
      }
      selectedRules.push(value);
      continue;
    }
    if (argument === "--max") {
      const value = Number.parseInt(argv[++index] ?? "", 10);
      if (!Number.isInteger(value) || value < 0) {
        process.stderr.write("style-guard: --max needs a non-negative integer\n");
        process.exitCode = 2;
        return;
      }
      maxPerRule = value;
      continue;
    }
    if (argument.startsWith("--")) {
      process.stderr.write(`style-guard: unknown option '${argument}'\n`);
      process.exitCode = 2;
      return;
    }
    paths.push(argument);
  }

  const activeRules = selectedRules.length > 0 ? selectedRules : Object.keys(RULES);
  const files = [];
  for (const target of paths.length > 0 ? paths : DEFAULT_TARGETS) {
    const absolute = resolve(REPO_ROOT, target);
    try {
      statSync(absolute);
    } catch {
      process.stderr.write(`style-guard: target does not exist, skipped: ${target}\n`);
      continue;
    }
    for (const file of walk(absolute)) files.push(file);
  }
  files.sort((left, right) => left.localeCompare(right));

  const report = {};
  for (const id of activeRules) report[id] = [];
  let scanned = 0;

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const mask = buildMask(source);
    scanned += 1;
    for (const id of activeRules) {
      for (const finding of RULES[id].run(source, mask)) {
        report[id].push({ file: toRepoPath(file), ...finding });
      }
    }
  }

  const totals = Object.fromEntries(activeRules.map((id) => [id, report[id].length]));
  const total = Object.values(totals).reduce((sum, value) => sum + value, 0);

  if (json) {
    process.stdout.write(JSON.stringify({ scanned, totals, total, findings: report }, null, 2) + "\n");
    if (total > 0) process.exitCode = 1;
    return;
  }

  if (!quiet) {
    for (const id of activeRules) {
      const findings = report[id];
      if (findings.length === 0) continue;
      process.stdout.write(`\n${id} — ${RULES[id].description}: ${findings.length} finding(s)\n`);
      for (const finding of findings.slice(0, maxPerRule)) {
        process.stdout.write(`  ${finding.file}:${finding.line}  ${finding.text}\n`);
      }
      if (findings.length > maxPerRule) {
        process.stdout.write(`  ... and ${findings.length - maxPerRule} more\n`);
      }
    }
  }

  process.stdout.write(
    `\nstyle-guard: ${total} finding(s) across ${scanned} files — ` +
      activeRules.map((id) => `${id}=${totals[id]}`).join(", ") +
      "\n",
  );
  if (total > 0) {
    process.stdout.write(
      "These are the rules a formatter cannot enforce. See .agents/skills/eengine-code-style/SKILL.md.\n",
    );
    process.exitCode = 1;
  }
}

main();
