#!/usr/bin/env node
// The daily entry point stays independent of the final acceptance model.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadNavigation, navigationSummary } from "./project-navigation.mjs";
import { summarizeTests } from "./test-reporter.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command = "context", ...args] = process.argv.slice(2);

try {
  if (command === "context" && !args.includes("--all") && !args.includes("--cases")) {
    if (args.some((arg) => arg.startsWith("--"))) throw new Error("context accepts --all or --cases");
    await context(args.find((arg) => !arg.startsWith("--")) ?? ".");
  } else if (command === "verify" && args.includes("--module") && !args.includes("--full")) {
    await moduleCheck(args);
  } else if (command === "verify" && !args.includes("--full")) {
    throw new Error(
      "Choose `verify --module` at a large module close or `verify --full` for final acceptance.",
    );
  } else if (command === "verify" && args.includes("--module")) {
    throw new Error("Choose either --module or --full, not both.");
  } else if (command === "gpu-oracle") {
    await gpuOracle(args);
  } else if (command === "help" || command === "--help" || command === "-h") {
    console.log(`vibe context <path>                    owner, current facts, current module and design/plan
vibe context <path> --all              context plus the full document and check index
vibe verify --module [--test <path>]   explicit module-close typecheck, build and focused tests
vibe verify --module --plan            show module check without running
vibe verify --full                     integration checks plus the GPU environment probe
vibe verify --full --gpu-oracle <name> also run a named real-GPU oracle
vibe gpu-oracle --list                 list registered real-GPU oracles
vibe gpu-oracle <name> [--json]        run one oracle on a real GPU
vibe registry                          --check validates; --write regenerates browser registry
vibe doctor                            project model summary and warnings`);
  } else {
    // The acceptance model is loaded only for explicitly requested final tools.
    await import("./vibe-acceptance.mjs");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

/**
 * Run a real-GPU oracle directly from the project CLI.
 *
 * This exists so the oracles are reachable without knowing the harness path, and
 * so `verify --full --gpu-oracle <name>` has a single implementation to call. The
 * harness owns argument shape and exit codes; this only forwards.
 */
async function gpuOracle(args) {
  const forwarded = args[0] === "--list" ? ["--list"] : args;
  const result = spawnSync(process.execPath, [resolve(root, "tools/gpu-oracle.mjs"), ...forwarded], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

async function context(input) {
  console.log(JSON.stringify(await navigationSummary(input, await loadNavigation()), null, 2));
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
  const json = args.includes("--json");
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
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--test") {
      index++;
      continue;
    }
    if (!known.has(args[index]))
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
    checks.push({
      command: `npm run ${script}`,
      passed: result.status === 0,
      status: result.status === 0 ? "passed" : "failed",
      exitCode: result.status,
      error: result.error?.message ?? null,
    });
    if (result.stdout) (json ? process.stderr : process.stdout).write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) {
      console.log(
        JSON.stringify({ mode: "module", ok: false, checks, error: result.error?.message ?? null }),
      );
      process.exitCode = 1;
      return;
    }
  }
  for (const path of testPaths) {
    const result = spawnSync(
      process.execPath,
      ["--test", "--test-reporter", pathToFileURL(resolve(root, "tools/test-reporter.mjs")).href, path],
      {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        timeout: 900_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const summary = summarizeTests(result.stdout ?? "", result.status);
    const passed = summary.status === "passed";
    checks.push({
      command: `node --test ${path}`,
      passed,
      summary: summary ?? null,
      exitCode: result.status,
    });
    if (result.stdout) (json ? process.stderr : process.stdout).write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (!passed) {
      process.exitCode = 1;
      break;
    }
  }
  console.log(
    JSON.stringify(
      {
        mode: "module",
        scope: "selected commands and assertions; not complete renderer acceptance",
        ok: process.exitCode !== 1,
        conclusion: checks.some((check) => check.summary?.status === "not-run")
          ? "incomplete"
          : process.exitCode === 1
            ? "failed"
            : "complete",
        checks,
        browser: "not run",
        rendererAcceptance: "not evaluated",
      },
      null,
      2,
    ),
  );
}
