import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  VALIDATION_CASES,
  casesForDomain,
  casesForFixture,
  isValidationCaseId,
  validationCase
} from "./cases.mjs";
import { createChromeRunner, runValidationCases } from "./chrome-runner.mjs";
import { exitCodeForStatus } from "./result.mjs";
import {
  changedPathsFromBase,
  selectCasesForPaths,
  workingTreePaths
} from "./selector.mjs";

const examplesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(examplesRoot, "..");
const outputRoot = path.join(repositoryRoot, "temp", "validation");

await main().catch((error) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(JSON.stringify({ schemaVersion: 1, status: "failed", reasons: [message] }, null, 2));
  process.exitCode = 1;
});

async function main() {
  const args = process.argv.slice(2);
  const policy = renderingLabPolicy(args[0]);
  if (policy !== null) {
    await runPolicy(policy, args.slice(1));
    return;
  }
  const selection = await resolveSelection(args);
  if (selection.cases.length === 0) {
    console.log(JSON.stringify({
      status: "passed",
      message: "No Browser Validation Case matched the requested target",
      selection: selection.metadata
    }, null, 2));
    process.exitCode = 0;
    return;
  }
  const summary = await runValidationCases({
    examplesRoot,
    cases: selection.cases,
    outputRoot,
    allowChromiumFallback: process.env.OENGINE_ALLOW_CHROMIUM_FALLBACK === "true"
  });
  const output = { ...summary, selection: selection.metadata };
  console.log(JSON.stringify(output, null, 2));
  process.exitCode = exitCodeForStatus(summary.status);
}

async function runPolicy(mode, args) {
  if (mode === "formal") {
    const bundledNpmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const npmCli = process.env.npm_execpath ?? bundledNpmCli;
    if (!existsSync(npmCli)) throw new Error(`Formal benchmark cannot find the npm CLI: ${npmCli}`);
    execFileSync(process.execPath, [npmCli, "run", "build:test"], {
      cwd: path.join(repositoryRoot, "OEngine"),
      stdio: "inherit"
    });
  }
  const runner = await createChromeRunner({
    examplesRoot,
    allowChromiumFallback: process.env.OENGINE_ALLOW_CHROMIUM_FALLBACK === "true"
  });
  try {
    if (runner === null) {
      const result = { schemaVersion: 1, status: "inconclusive", mode, reason: "No usable Chrome installation was found" };
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = 2;
      return;
    }
    const { runRenderingLabPolicy } = await import("./rendering-lab-policy.mjs");
    const result = await runRenderingLabPolicy({
      mode,
      runner,
      baseUrl: runner.baseUrl,
      repositoryRoot,
      args
    });
    console.log(JSON.stringify({ schemaVersion: 1, ...result, browser: runner.browserIdentity }, null, 2));
    process.exitCode = exitCodeForStatus(result.status);
  } finally {
    await runner?.close();
  }
}

function renderingLabPolicy(target) {
  if (target === "formal") return "formal";
  if (target === "rendering-lab.profiles") return "profiles";
  if (target === "rendering-lab.workload") return "workload";
  if (target === "rendering-lab.shadow-feature-off") return "shadow-feature-off";
  if (target === "rendering-lab.oracle") return "oracle";
  return null;
}

async function resolveSelection(args) {
  const [target = "changed", ...rest] = args;
  if (target === "full") {
    return { cases: [...VALIDATION_CASES], metadata: { mode: "full" } };
  }
  if (target === "changed") {
    const baseIndex = rest.indexOf("--base");
    const paths = baseIndex === -1
      ? await workingTreePaths(repositoryRoot)
      : await changedPathsFromBase(repositoryRoot, requireArgument(rest, baseIndex + 1, "--base"));
    const selected = selectCasesForPaths(paths);
    return {
      cases: selected.caseIds.map(validationCase),
      metadata: { mode: baseIndex === -1 ? "working-tree" : "range", ...selected }
    };
  }
  if (target === "paths") {
    if (rest.length === 0) throw new Error("verify paths requires at least one repository path");
    const selected = selectCasesForPaths(rest);
    return {
      cases: selected.caseIds.map(validationCase),
      metadata: { mode: "paths", ...selected }
    };
  }
  if (isValidationCaseId(target)) {
    return { cases: [validationCase(target)], metadata: { mode: "case", target } };
  }
  const fixtureCases = casesForFixture(target);
  if (fixtureCases.length > 0) {
    return { cases: fixtureCases, metadata: { mode: "fixture", target } };
  }
  const domainCases = casesForDomain(target);
  if (domainCases.length > 0) {
    return { cases: domainCases, metadata: { mode: "domain", target } };
  }
  throw new Error(`Unknown validation target '${target}'`);
}

function requireArgument(args, index, option) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}
