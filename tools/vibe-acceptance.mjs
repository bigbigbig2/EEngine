#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  REPO_ROOT,
  GENERATED_REGISTRY,
  assertModel,
  assertRegistry,
  buildRegistry,
  getChangedPaths,
  loadModel,
  writeGeneratedRegistry,
  matchingCases,
  matchingDomains,
  routeDomains,
  pathMatches,
  isIgnoredPath,
  validateGeneratedRegistry,
} from "./vibe-lib.mjs";
import { DOMAIN_DIR, WORKSTREAM_DIR, readYamlFiles } from "./vibe-lib.mjs";
import { planEngineTests, runCheckImplementation } from "./check-runners.mjs";

const [command = "context", ...args] = process.argv.slice(2);

try {
  if (command === "registry") await registryCommand();
  else if (command === "doctor") await doctorCommand();
  else if (command === "context") {
    const input = args.find((arg) => !arg.startsWith("--")) ?? ".";
    await contextCommand(input, {
      includeCases: args.includes("--cases") || args.includes("--all"),
      includeAll: args.includes("--all"),
    });
  } else if (command === "verify" && args.includes("--changed"))
    throw new Error(
      "Changed-path verification was retired; use `node tools/vibe.mjs verify --module` after a large module is connected.",
    );
  else if (command === "verify")
    await verifyCommand({
      changedOnly: args.includes("--changed"),
      perfRequested: args.includes("--perf"),
      planOnly: args.includes("--plan"),
      verbose: args.includes("--json"),
      baseRevision: optionValue(args, "--base"),
    });
  else if (command === "help" || command === "--help" || command === "-h") printHelp();
  else throw new Error(`Unknown command '${command}'. Use \'node tools/vibe.mjs help\' for commands.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function registryCommand() {
  const model = await loadModel();
  const legacy = null;
  assertModel(model, legacy);
  const registry = buildRegistry(model, legacy);
  const registryErrors = validateGeneratedRegistry(registry);
  if (registryErrors.length > 0)
    throw new Error(`Generated registry is invalid:\n${registryErrors.join("\n")}`);
  const result = await writeGeneratedRegistry(registry);
  console.log(
    JSON.stringify(
      {
        generated: relative(REPO_ROOT, result.path),
        cases: registry.cases.length,
        bytes: result.bytes,
        sha256: result.sha256,
      },
      null,
      2,
    ),
  );
}

async function doctorCommand() {
  const model = await loadModel();
  const legacy = null;
  const errors = [];
  try {
    assertModel(model, legacy);
  } catch (error) {
    errors.push(error.message);
  }
  let registry = null;
  try {
    registry = buildRegistry(model, legacy);
    const registryErrors = validateGeneratedRegistry(registry);
    if (registryErrors.length > 0) errors.push(registryErrors.join("\n"));
  } catch (error) {
    errors.push(error.message);
  }
  // The everyday doctor only checks the project model and the generated
  // registry structure.
  const warnings = [];
  if (!existsSync(GENERATED_REGISTRY))
    warnings.push("generated registry has not been written yet; run `node tools/vibe.mjs registry`");
  const result = {
    ok: errors.length === 0,
    errors,
    warnings,
    counts: {
      domains: model.domains.length,
      checks: model.checks.length,
      cases: model.cases.length,
      profiles: model.profiles.length,
      workloads: model.workloads.length,
    },
    generatedRegistry: registry ? relative(REPO_ROOT, GENERATED_REGISTRY) : null,
  };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length > 0) process.exitCode = 1;
}

async function contextCommand(input, options = {}) {
  // Navigation must remain available while cases and generated artifacts lag
  // behind an active destructive rebuild.
  const [domainFiles, workstreamFiles] = await Promise.all([
    readYamlFiles(DOMAIN_DIR),
    readYamlFiles(WORKSTREAM_DIR),
  ]);
  const navigation = {
    domains: domainFiles.map(({ path, value }) => ({ ...value, _file: relative(REPO_ROOT, path) })),
    workstreams: workstreamFiles.map(({ path, value }) => ({ ...value, _file: relative(REPO_ROOT, path) })),
  };
  const model =
    options.includeCases || options.includeAll
      ? await loadModel()
      : { ...navigation, cases: [], checks: [], sources: [] };
  const paths = input === "." ? ["."] : [input];
  const all = input === ".";
  const domains = all ? model.domains : matchingDomains(model, paths);
  const cases = all ? model.cases : matchingCases(model, paths);
  const domainIds = new Set(domains.map((domain) => domain.id));
  const checks = model.checks.filter((check) => all || (check.domains ?? []).some((id) => domainIds.has(id)));
  const routing = all ? null : routeDomains(model, paths);
  const primaryDomains = all ? domains : domains.filter((domain) => domain.id === routing?.primary?.id);
  const sourceIds = new Set(primaryDomains.flatMap((domain) => domain.sources ?? []));
  const selectedSources = model.sources.filter((source) => sourceIds.has(source.id));
  const selectedWorkstreams = model.workstreams.filter(
    (workstream) =>
      workstream.id === "eengine-next-clean-rebuild" ||
      primaryDomains.some(
        (domain) => workstream.domain === domain.id || (domain.decisions ?? []).includes(workstream.decision),
      ),
  );
  const summary = {
    input,
    owner: all
      ? { primary: model.domains.map((domain) => domain.id), ambiguous: false }
      : {
          primary: routing?.primary?.id ?? null,
          related: routing?.related?.map((entry) => entry.id) ?? [],
          ambiguous: routing?.ambiguous ?? false,
        },
    documents: [...new Set(primaryDomains.flatMap((domain) => domain.currentDocs ?? []))],
    ...(selectedWorkstreams.some((workstream) => workstream.id === "eengine-next-clean-rebuild")
      ? {
          nextArchitecture: {
            design: "docs/next-design/eengine-next-overall-architecture-final-2026.md",
            execution: "docs/next-execution/eengine-next-architecture-layer-plan-2026.md",
          },
        }
      : {}),
    contracts: [...new Set(primaryDomains.flatMap((domain) => domain.contracts ?? []))],
    decisions: [...new Set(primaryDomains.flatMap((domain) => domain.decisions ?? []))],
    sources: options.includeAll
      ? selectedSources.map(stripPrivate)
      : selectedSources.map((source) => source.id),
    workstreams: selectedWorkstreams.map(options.includeAll ? stripPrivate : summarizeWorkstream),
    implementation: primaryDomains.map((domain) => ({ id: domain.id, owner: domain.owner })),
    ...(options.includeAll
      ? {
          checks: checks.map((check) => check.id),
          checkReason: "optional final-acceptance model detail",
        }
      : {}),
    ...(options.includeAll
      ? { engineTests: summarizeEnginePlan(planEngineTests({ changedOnly: true, changedPaths: paths })) }
      : {}),
  };
  if (!options.includeCases && !options.includeAll) {
    console.log(
      JSON.stringify(
        {
          input: summary.input,
          owner: summary.owner,
          documents: summary.documents,
          ...(summary.nextArchitecture ? { nextArchitecture: summary.nextArchitecture } : {}),
          currentModules: selectedWorkstreams.map((workstream) => ({
            workstream: workstream.id,
            currentSlice: workstream.currentSlice ?? null,
            nextModules: (workstream.nextModules ?? []).map((module) => module.id),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (options.includeCases) summary.cases = cases.map(options.includeAll ? stripPrivate : summarizeCase);
  console.log(JSON.stringify(summary, null, 2));
}

async function verifyCommand({ changedOnly, perfRequested, planOnly, verbose, baseRevision }) {
  const verifyStarted = performance.now();
  const model = await loadModel();
  const legacy = null;
  assertModel(model, legacy);
  const registry = buildRegistry(model, legacy);
  assertRegistry(registry);
  const changedPaths = changedOnly ? getChangedPaths(baseRevision) : ["."];
  const domains = changedOnly ? matchingDomains(model, changedPaths) : model.domains;
  const cases = changedOnly ? matchingCases(model, changedPaths) : model.cases;
  const routing = changedOnly
    ? Object.fromEntries(changedPaths.map((path) => [path, routeDomains(model, [path])]))
    : null;
  const routingAmbiguities = changedOnly
    ? Object.entries(routing)
        .filter(([, route]) => route.ambiguous)
        .map(([path, route]) => ({
          path,
          domains: [
            route.primary?.id,
            ...(route.related ?? [])
              .filter((entry) => entry.score === route.primary?.score)
              .map((entry) => entry.id),
          ].filter(Boolean),
        }))
    : [];
  // Deleted legacy files are intentionally allowed to leave the routing graph.
  // Any file that still exists must remain owned by a declared domain.
  const uncovered = changedOnly
    ? changedPaths.filter(
        (path) =>
          !isIgnoredPath(path) &&
          existsSync(resolve(REPO_ROOT, path)) &&
          !domains.some((domain) => domain.paths.some((pattern) => pathMatches(path, pattern))),
      )
    : [];
  // The check set is derived from the routing model instead of a hard-coded
  // list: matched domains declare their checks. Before this,
  // `project/domains/*.yaml#checks` was inert metadata and `docs-frontmatter`
  // was declared but never executed.
  const checkIds = new Set(["model", "registry"]);
  if (changedOnly) checkIds.add("changed-coverage");
  const engineRelevant =
    !changedOnly || changedPaths.some((path) => /^(?:OEngine\/|tools\/|checks\/|project\/)/u.test(path));
  const validationRelevant =
    !changedOnly || changedPaths.some((path) => /^(?:validation\/|tools\/|checks\/|project\/)/u.test(path));
  if (engineRelevant) checkIds.add("engine-suites");
  if (validationRelevant) checkIds.add("validation-suites");
  for (const domain of domains) for (const checkId of domain.checks ?? []) checkIds.add(checkId);
  const requiredLevel = requiredVerificationLevel(changedPaths, perfRequested);
  const checkContext = {
    repoRoot: REPO_ROOT,
    model,
    changedOnly,
    changedPaths,
    uncovered,
    routingAmbiguities,
  };
  const engineCheck = model.checks.find((check) => check.id === "engine-suites");
  if (planOnly) {
    const engineTests = engineRelevant ? planEngineTests(checkContext, engineCheck?.config) : null;
    console.log(
      JSON.stringify(
        {
          mode: changedOnly ? "development" : "integration",
          changedOnly,
          baseRevision: baseRevision ?? null,
          changedPaths,
          requiredLevel,
          routing,
          matched: {
            domains: domains.map((domain) => domain.id),
            cases: cases.map((item) => item.id),
          },
          checks: model.checks.filter((check) => checkIds.has(check.id)).map((check) => check.id),
          engineTests: verbose ? engineTests : summarizeEnginePlan(engineTests),
        },
        null,
        2,
      ),
    );
    return;
  }
  const generated = await writeGeneratedRegistry(registry);
  const checkResults = model.checks
    .filter((check) => checkIds.has(check.id))
    .map((check) => runCheck(check, checkContext));
  const failedChecks = checkResults.filter((check) => check.status === "failed");
  const skippedChecks = checkResults.filter((check) => check.status === "not-run");
  // `ok` covers executed checks only. `skippedChecks` is reported separately so
  // a `not-run` gate cannot be mistaken for a satisfied one; it does not gate
  // ordinary development checks.
  const ok = uncovered.length === 0 && routingAmbiguities.length === 0 && failedChecks.length === 0;
  const result = {
    ok,
    mode: changedOnly ? "development" : "integration",
    revision: currentRevision(),
    durationMs: Math.round(performance.now() - verifyStarted),
    changedOnly,
    changedPaths,
    generatedRegistry: { path: relative(REPO_ROOT, generated.path), sha256: generated.sha256 },
    routing,
    routingAmbiguities,
    matched: {
      domains: domains.map((domain) => domain.id),
      cases: cases.map((item) => item.id),
    },
    checks: checkResults,
    skippedChecks: skippedChecks.map((check) => ({ id: check.id, details: check.details })),
    requiredLevel,
    uncovered,
  };
  console.log(JSON.stringify(verbose ? result : summarizeVerification(result), null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function currentRevision() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function requiredVerificationLevel(paths, perfRequested) {
  if (perfRequested) return "L4";
  // The level must describe the product surface a change can actually affect.
  // Test and tooling paths are named after the concepts they cover
  // (`…-framegraph.test.mjs`, `product-cutover-audit…`), so matching the whole
  // path inflated the level and demanded browser cases for a test-file edit.
  const product = paths.filter((path) => /^(?:OEngine\/src\/|validation\/)/u.test(path));
  if (
    product.some((path) =>
      /(?:Renderer\.ts|device-loss|replacement|framegraph|Residency|lifecycle|cutover)/iu.test(path),
    )
  )
    return "L3";
  if (
    product.some((path) =>
      /(?:^OEngine\/src\/(?:gpu|render|shaders)|^validation\/(?:harness|cases|labs))/u.test(path),
    )
  )
    return "L2";
  return paths.length > 0 ? "L1" : "L0";
}

function runCheck(check, context) {
  const started = performance.now();
  const { status, details } = runCheckImplementation(check, context);
  return {
    id: check.id,
    status,
    level: check.level,
    description: check.description,
    durationMs: Math.round(performance.now() - started),
    details,
  };
}

function stripPrivate(value) {
  const { _file, _lab, ...publicValue } = value;
  return publicValue;
}

function summarizeCase(item) {
  return { id: item.id, level: item.level };
}

function summarizeWorkstream(workstream) {
  const nextTasks = workstream.nextTasks ?? workstream.nextModules ?? [];
  return {
    id: workstream.id,
    state: workstream.state,
    currentSlice: workstream.currentSlice
      ? { id: workstream.currentSlice.id, status: workstream.currentSlice.status }
      : null,
    nextTasks: nextTasks.slice(0, 2),
    ...(workstream.currentSlice?.goal ? { goal: workstream.currentSlice.goal } : {}),
    ...(workstream.architectureRules ? { architectureRules: workstream.architectureRules.slice(0, 5) } : {}),
    ...(nextTasks.length > 2 ? { moreNextTasks: nextTasks.length - 2 } : {}),
  };
}

function printHelp() {
  console.log(`vibe commands:
  context <path>       navigate owner, current docs and active module without acceptance checks
  context <path> --cases | --all
                       expand case or complete routed detail
  verify --module      use tools/vibe.mjs for the separate module-close check
  verify --full        run the complete final integration checks explicitly
  verify --plan        print selected checks/tests without running or writing
  verify --json        print the complete report payload instead of a summary
  verify --base <rev>  include committed changes since a base revision
                       exit 0 = executed checks passed; not-run checks appear in skippedChecks
  registry             generate validation/registry.generated.json
  doctor               validate the complete project model`);
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function summarizeEnginePlan(plan) {
  if (!plan) return null;
  return { scope: plan.scope, groups: plan.groups, testFiles: plan.files.length, reasons: plan.reasons };
}

function summarizeVerification(result) {
  return {
    ok: result.ok,
    mode: result.mode,
    durationMs: result.durationMs,
    changedPaths: result.changedOnly ? result.changedPaths.length : "full",
    checks: result.checks.map((check) => {
      const plan = check.details?.find((detail) => detail && typeof detail === "object" && detail.plan)?.plan;
      const timings = check.details?.find(
        (detail) => detail && typeof detail === "object" && detail.timings,
      )?.timings;
      return {
        id: check.id,
        status: check.status,
        durationMs: check.durationMs,
        summary: typeof check.details?.[0] === "string" ? check.details[0] : undefined,
        plan: summarizeEnginePlan(plan),
        timings,
        failure: check.status === "failed" ? check.details : undefined,
      };
    }),
    skippedChecks: result.skippedChecks,
  };
}
