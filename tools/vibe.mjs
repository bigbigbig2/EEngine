#!/usr/bin/env node
// The daily entry point stays independent of the final acceptance model.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command = "context", ...args] = process.argv.slice(2);

try {
  if (command === "context" && !args.some((arg) => ["--claims", "--cases", "--all"].includes(arg))) {
    await context(args.find((arg) => !arg.startsWith("--")) ?? ".");
  } else if (command === "verify" && args.includes("--module") && !args.includes("--full")) {
    await moduleCheck(args);
  } else if (command === "verify" && !args.includes("--full")) {
    throw new Error(
      "Choose `verify --module` at a large module close or `verify --full` for final acceptance. Changed-path verification was retired.",
    );
  } else if (command === "verify" && args.includes("--module")) {
    throw new Error("Choose either --module or --full, not both.");
  } else if (command === "help" || command === "--help" || command === "-h") {
    console.log(`vibe context <path>                    owner, current facts, current module and design/plan
vibe verify --module [--test <path>]    explicit module-close typecheck, build and focused tests
vibe verify --module --plan             show module check without running
vibe verify --full                       final integration and acceptance checks
vibe context <path> --claims|--cases|--all, registry, evidence, case, status, doctor
                                         explicit final-acceptance tools`);
  } else {
    // The acceptance model is loaded only for explicitly requested final tools.
    await import("./vibe-acceptance.mjs");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function readYamlDirectory(directory) {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
      .map(async (entry) => {
        const path = resolve(root, directory, entry.name);
        const document = parseDocument(await readFile(path, "utf8"), {
          uniqueKeys: true,
          prettyErrors: true,
        });
        if (document.errors.length || document.warnings.length) {
          throw new Error(
            `${relative(root, path)}: ${[...document.errors, ...document.warnings].map((item) => item.message).join("; ")}`,
          );
        }
        return document.toJS({ mapAsMap: false });
      }),
  );
}

function matches(path, pattern) {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  const base = pattern.replaceAll("\\", "/").replace(/\/\*\*$/u, "");
  let source = "";
  for (let index = 0; index < base.length; index++) {
    const ch = base[index];
    if (ch === "*" && base[index + 1] === "*") {
      source += ".*";
      index++;
    } else if (ch === "*") source += "[^/]*";
    else source += ch.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${source}(?:/.*)?$`, "u").test(normalized);
}

async function context(input) {
  const [domains, workstreams] = await Promise.all([
    readYamlDirectory("project/domains"),
    readYamlDirectory("project/workstreams/active"),
  ]);
  const candidates = domains
    .flatMap((domain) => {
      const patterns = (domain.paths ?? []).filter((pattern) => input === "." || matches(input, pattern));
      return patterns.length
        ? [{ domain, score: Math.max(...patterns.map((pattern) => pattern.replaceAll("*", "").length)) }]
        : [];
    })
    .sort((a, b) => b.score - a.score || a.domain.id.localeCompare(b.domain.id));
  const primary = candidates[0]?.domain ?? null;
  const selected =
    input === "."
      ? workstreams
      : workstreams.filter(
          (stream) =>
            stream.id === "eengine-next-clean-rebuild" ||
            stream.domain === primary?.id ||
            (primary?.decisions ?? []).includes(stream.decision),
        );
  const result = {
    input,
    owner: {
      primary: input === "." ? domains.map((domain) => domain.id) : (primary?.id ?? null),
      related: input === "." ? [] : candidates.slice(1).map((item) => item.domain.id),
      ambiguous: Boolean(candidates[1] && candidates[1].score === candidates[0].score),
    },
    documents:
      input === "."
        ? [...new Set(domains.flatMap((domain) => domain.currentDocs ?? []))]
        : (primary?.currentDocs ?? []),
    ...(selected.some((stream) => stream.id === "eengine-next-clean-rebuild")
      ? {
          nextArchitecture: {
            design: "docs/next-design/eengine-next-overall-architecture-final-2026.md",
            execution: "docs/next-execution/eengine-next-architecture-layer-plan-2026.md",
          },
        }
      : {}),
    currentModules: selected.map((stream) => ({
      workstream: stream.id,
      currentSlice: stream.currentSlice ?? null,
      nextModules: (stream.nextModules ?? []).map((module) => module.id),
    })),
  };
  console.log(JSON.stringify(result, null, 2));
}

function npmRun(script, cwd) {
  const windows = process.platform === "win32";
  const executable = windows ? (process.env.ComSpec ?? "cmd.exe") : "npm";
  const args = windows ? ["/d", "/s", "/c", `npm run ${script}`] : ["run", script];
  return spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 900_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function moduleCheck(args) {
  const testPaths = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--test") continue;
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error("--test requires an OEngine/tests/*.test.mjs path");
    const path = resolve(root, value);
    const testsRoot = resolve(root, "OEngine/tests") + sep;
    if (!path.startsWith(testsRoot) || !path.endsWith(".test.mjs") || !existsSync(path)) {
      throw new Error(`Not an existing OEngine targeted test: ${value}`);
    }
    testPaths.push(relative(resolve(root, "OEngine"), path));
  }
  const known = new Set(["--module", "--plan", "--json", "--test"]);
  if (args.some((arg) => arg.startsWith("--") && !known.has(arg))) {
    throw new Error("Module check accepts --module, --plan, --json and repeated --test <path>");
  }
  const plan = [
    "npm run typecheck",
    "npm run build",
    ...(testPaths.length ? ["npm run build:test", ...testPaths.map((path) => `node --test ${path}`)] : []),
  ];
  if (args.includes("--plan")) {
    console.log(JSON.stringify({ mode: "module", commands: plan }, null, 2));
    return;
  }
  const cwd = resolve(root, "OEngine");
  const checks = [];
  for (const script of ["typecheck", "build", ...(testPaths.length ? ["build:test"] : [])]) {
    const result = npmRun(script, cwd);
    checks.push({ command: `npm run ${script}`, passed: result.status === 0 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) {
      console.error(
        JSON.stringify({ mode: "module", ok: false, checks, error: result.error?.message ?? null }),
      );
      process.exitCode = 1;
      return;
    }
  }
  for (const path of testPaths) {
    const result = spawnSync(process.execPath, ["--test", path], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 900_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    checks.push({ command: `node --test ${path}`, passed: result.status === 0 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) {
      process.exitCode = 1;
      break;
    }
  }
  console.log(
    JSON.stringify(
      {
        mode: "module",
        ok: process.exitCode !== 1,
        checks,
        browser: "not run",
        evidence: "not generated",
        claims: "not evaluated",
      },
      null,
      2,
    ),
  );
}
