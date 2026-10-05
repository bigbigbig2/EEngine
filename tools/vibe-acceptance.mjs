#!/usr/bin/env node
import { relative } from "node:path";
import {
  REPO_ROOT,
  loadModel,
  assertModel,
  buildRegistry,
  assertRegistry,
  checkGeneratedRegistry,
  writeGeneratedRegistry,
  matchingCases
} from "./vibe-lib.mjs";
import { loadNavigation, navigationSummary } from "./project-navigation.mjs";
import { planEngineTests, runCheckImplementation } from "./check-runners.mjs";
import { oracles as GPU_ORACLES } from "./gpu-oracle/registry.mjs";

const [command, ...args] = process.argv.slice(2);
const print = (value) => console.log(JSON.stringify(value, null, 2));
function allowed(flags) {
  for (const arg of args)
    if (arg.startsWith("--") && !flags.includes(arg)) throw new Error(`unknown argument ${arg}`);
}
async function registryModel() {
  const model = assertModel(await loadModel(), null);
  return { model, registry: assertRegistry(buildRegistry(model, null)) };
}
try {
  if (command === "context") {
    allowed(["--all", "--cases"]);
    const input = args.find((arg) => !arg.startsWith("--")) ?? ".";
    const base = await navigationSummary(input, await loadNavigation());
    const model = await loadModel();
    const domains = model.domains.filter((item) => input === "." || item.id === base.owner.primary);
    print({
      ...base,
      contracts: [...new Set(domains.flatMap((item) => item.contracts ?? []))],
      decisions: [...new Set(domains.flatMap((item) => item.decisions ?? []))],
      sources: model.sources
        .filter((source) => domains.some((domain) => (domain.sources ?? []).includes(source.id)))
        .map(({ _file, ...source }) => source),
      checks: model.checks
        .filter((item) => input === "." || item.domains?.some((id) => domains.some((d) => d.id === id)))
        .map((item) => item.id),
      cases: (input === "." ? model.cases : matchingCases(model, [input])).map((item) => ({
        id: item.id,
        caseKind: item.caseKind,
        route: item.route
      }))
    });
  } else if (command === "registry" || command === "doctor") {
    allowed(command === "registry" ? ["--check", "--write"] : []);
    if (args.includes("--check") && args.includes("--write")) throw new Error("choose --check or --write");
    const { model, registry } = await registryModel();
    if (args.includes("--write")) {
      print({ mode: "write", ...(await writeGeneratedRegistry(registry)), cases: registry.cases.length });
    } else {
      const state = await checkGeneratedRegistry(registry);
      print(
        command === "doctor"
          ? {
              ok: state.ok,
              errors: state.ok ? [] : [state.reason],
              warnings: [],
              counts: {
                domains: model.domains.length,
                checks: model.checks.length,
                cases: registry.cases.length,
                profiles: model.profiles.length,
                workloads: model.workloads.length
              },
              registryState: state
            }
          : { mode: "check", ...state, cases: registry.cases.length }
      );
      if (!state.ok) process.exitCode = 1;
    }
  } else if (command === "verify") {
    allowed(["--full", "--plan", "--json", "--gpu-oracle"]);
    if (!args.includes("--full")) throw new Error("use verify --module or --full");
    const names = [];
    for (let i = 0; i < args.length; i++)
      if (args[i] === "--gpu-oracle") {
        const name = args[++i];
        if (!GPU_ORACLES.some((oracle) => oracle.name === name && !oracle.negativeControl))
          throw new Error(`unknown production GPU oracle: ${name}`);
        names.push(name);
      }
    const { model, registry } = await registryModel();
    // Changed-scope guards have no useful full-tree work; no ceremonial receipts.
    const checks = model.checks.filter(
      (item) =>
        !["changed-coverage", "guard-ownership", "guard-generated-source", "docs-frontmatter"].includes(
          item.id
        )
    );
    const oracles = [...new Set(names)].map((name) => ({
      id: `gpu-oracle-${name}`,
      runner: "gpu-environment",
      config: { oracle: name },
      level: "L2"
    }));
    const tasks = [...checks, ...oracles];
    const context = {
      repoRoot: REPO_ROOT,
      model,
      changedOnly: false,
      changedPaths: ["."],
      uncovered: [],
      routingAmbiguities: [],
      registryState: await checkGeneratedRegistry(registry)
    };
    if (args.includes("--plan")) {
      print({
        mode: "integration",
        scope: "selected repository checks and GPU oracles",
        checks: tasks.map((item) => item.id),
        engineTests: planEngineTests(context).files,
        browserCases: { status: "not-run", ids: registry.cases.map((item) => item.id) },
        rendererAcceptance: "not evaluated"
      });
    } else {
      const started = performance.now();
      const results = tasks.map((check) => {
        const began = performance.now();
        return {
          id: check.id,
          ...runCheckImplementation(check, context),
          durationMs: Math.round(performance.now() - began)
        };
      });
      const failed = results.filter((item) => item.status === "failed");
      const skipped = results.filter((item) => item.status === "not-run");
      const conclusion = failed.length ? "failed" : skipped.length ? "incomplete" : "complete";
      print({
        ok: conclusion === "complete",
        conclusion,
        mode: "integration",
        scope: "selected repository checks and explicit GPU oracles",
        durationMs: Math.round(performance.now() - started),
        checks: results,
        skippedChecks: skipped,
        browserCases: { status: "not-run", ids: registry.cases.map((item) => item.id) },
        rendererAcceptance: "not evaluated"
      });
      if (conclusion !== "complete") process.exitCode = 1;
    }
  } else throw new Error(`unknown command ${command}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
