#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  REPO_ROOT,
  GENERATED_REGISTRY,
  EVIDENCE_INDEX,
  assertModel,
  assertRegistry,
  buildRegistry,
  getChangedPaths,
  loadEvidenceIndex,
  loadModel,
  writeGeneratedRegistry,
  matchingClaims,
  matchingCases,
  matchingDomains,
  routeDomains,
  pathMatches,
  claimStatus,
  caseSignatures,
  isIgnoredPath,
  validateGeneratedRegistry,
  buildEvidenceIndex,
  writeEvidenceIndex,
  sha256,
  validateWorkstreamCompletion,
  canonicalJsonText,
  evidenceReplacementError,
  isVerificationComplete,
} from "./vibe-lib.mjs";
import { DOMAIN_DIR, WORKSTREAM_DIR, readYamlFiles } from "./vibe-lib.mjs";
import { planEngineTests, runCheckImplementation } from "./check-runners.mjs";

const [command = "context", ...args] = process.argv.slice(2);

try {
  if (command === "registry") await registryCommand();
  else if (command === "evidence")
    await evidenceCommand(
      args.includes("--force-empty"),
      args.includes("--force-prune"),
      args.includes("--check"),
    );
  else if (command === "doctor") await doctorCommand();
  else if (command === "context") {
    const input = args.find((arg) => !arg.startsWith("--")) ?? ".";
    await contextCommand(input, {
      includeClaims: args.includes("--claims") || args.includes("--all"),
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
  else if (command === "case") await caseCommand(args[0], args.includes("--run"), args.includes("--accept"));
  else if (command === "status") await statusCommand(args[0]);
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
  // Workstream evidence and claim completion belong to final acceptance. The
  // everyday doctor only checks model and generated registry structure.
  const warnings = [];
  if (!existsSync(GENERATED_REGISTRY))
    warnings.push("generated registry has not been written yet; run `node tools/vibe.mjs registry`");
  if (!existsSync(EVIDENCE_INDEX))
    warnings.push("evidence index has not been written yet; run `node tools/vibe.mjs evidence`");
  const result = {
    ok: errors.length === 0,
    errors,
    warnings,
    counts: {
      domains: model.domains.length,
      claims: model.claims.length,
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
  // Navigation must remain available while claims, cases and generated
  // acceptance artifacts lag behind an active destructive rebuild.
  const [domainFiles, workstreamFiles] = await Promise.all([
    readYamlFiles(DOMAIN_DIR),
    readYamlFiles(WORKSTREAM_DIR),
  ]);
  const navigation = {
    domains: domainFiles.map(({ path, value }) => ({ ...value, _file: relative(REPO_ROOT, path) })),
    workstreams: workstreamFiles.map(({ path, value }) => ({ ...value, _file: relative(REPO_ROOT, path) })),
  };
  const model =
    options.includeClaims || options.includeCases || options.includeAll
      ? await loadModel()
      : { ...navigation, claims: [], cases: [], checks: [], sources: [] };
  const paths = input === "." ? ["."] : [input];
  const all = input === ".";
  const domains = all ? model.domains : matchingDomains(model, paths);
  const cases = all ? model.cases : matchingCases(model, paths);
  const claims = all ? model.claims : claimsForCases(model, matchingClaims(model, paths), cases);
  const domainIds = new Set(domains.map((domain) => domain.id));
  const claimIds = new Set(claims.map((claim) => claim.id));
  const checks = model.checks.filter(
    (check) =>
      all ||
      (check.domains ?? []).some((id) => domainIds.has(id)) ||
      (check.claims ?? []).some((id) => claimIds.has(id)),
  );
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
  if (!options.includeClaims && !options.includeCases && !options.includeAll) {
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
  if (options.includeClaims) summary.claims = claims.map(options.includeAll ? stripPrivate : summarizeClaim);
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
  const claims = changedOnly
    ? claimsForCases(model, matchingClaims(model, changedPaths), cases)
    : model.claims;
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
  // list: matched domains declare their checks and matched claims declare the
  // checks they require. Before this, `project/domains/*.yaml#checks` was inert
  // metadata and `docs-frontmatter` was declared but never executed.
  const checkIds = new Set(["model", "registry"]);
  if (changedOnly) checkIds.add("changed-coverage");
  const engineRelevant =
    !changedOnly || changedPaths.some((path) => /^(?:OEngine\/|tools\/|checks\/|project\/)/u.test(path));
  const validationRelevant =
    !changedOnly || changedPaths.some((path) => /^(?:validation\/|tools\/|checks\/|project\/)/u.test(path));
  if (engineRelevant) checkIds.add("engine-suites");
  if (validationRelevant) checkIds.add("validation-suites");
  for (const domain of domains) for (const checkId of domain.checks ?? []) checkIds.add(checkId);
  for (const claim of claims) for (const checkId of claim.requiredChecks ?? []) checkIds.add(checkId);
  const signatures = caseSignatures(model);
  const evidence = await loadEvidenceIndex();
  // Workstream completion is a final-acceptance concern. It must not block
  // ordinary implementation verification while the current slice is active.
  if (!changedOnly) assertWorkstreamCompletion(model, evidence, currentRevision(), signatures);
  const requiredLevel = requiredVerificationLevel(changedPaths, perfRequested);
  const checkContext = {
    repoRoot: REPO_ROOT,
    model,
    changedOnly,
    changedPaths,
    uncovered,
    routingAmbiguities,
    evidence,
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
            claims: claims.map((claim) => claim.id),
            cases: cases.map((item) => item.id),
          },
          checks: model.checks.filter((check) => checkIds.has(check.id)).map((check) => check.id),
          engineTests: verbose ? engineTests : summarizeEnginePlan(engineTests),
          browserCases: browserCasesRequired(cases, requiredLevel),
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
  const revision = currentRevision();
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const dirty =
    execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" }).length > 0;
  const completedAt = new Date().toISOString();
  const checkReceipts = checkResults.map((check) => ({
    id: check.id,
    runner: model.checks.find((candidate) => candidate.id === check.id)?.runner ?? "unknown",
    level: check.level,
    status: check.status,
    revision,
    tree,
    dirty,
    scope: changedOnly ? "changed" : "full",
    registrySha256: generated.sha256,
    detailsSha256: sha256(canonicalJsonText(check.details ?? [])),
    completedAt,
  }));
  const claimStatuses = claims.map((claim) => {
    const status = claimStatus(claim, evidence, currentRevision(), signatures);
    return {
      id: claim.id,
      level: claim.level,
      status,
      allowedDeclarations: claim.allowedDeclarations,
      currentDeclaration: declarationFor(claim, status),
      requiredChecks: claim.requiredChecks,
    };
  });
  const notRun = browserCasesRequired(cases, requiredLevel);
  const blocked = claimStatuses.filter((claim) => claim.status === "blocked").map((claim) => claim.id);
  const unsupported = evidence.evidence
    .filter((item) => item.status === "unsupported")
    .map((item) => item.caseId);
  // `ok` covers executed checks. Deferred browser cases and claim status are
  // reported separately; they do not gate development checks.
  const ok = uncovered.length === 0 && routingAmbiguities.length === 0 && failedChecks.length === 0;
  const verificationComplete = isVerificationComplete(ok, notRun, skippedChecks);
  const report = {
    schemaVersion: 1,
    mode: changedOnly ? "development" : "integration",
    generatedAt: new Date().toISOString(),
    revision,
    tree,
    dirty,
    changedOnly,
    requiredLevel,
    perfRequested,
    changedPaths,
    routing,
    routingAmbiguities,
    matched: {
      domains: domains.map((domain) => domain.id),
      claims: claims.map((claim) => claim.id),
      cases: cases.map((item) => item.id),
    },
    checks: checkResults,
    checkReceipts,
    skippedChecks: skippedChecks.map((check) => ({ id: check.id, details: check.details })),
    claims: claimStatuses,
    notRun,
    blocked,
    unsupported,
    uncovered,
    ok,
    verificationComplete,
    durationMs: Math.round(performance.now() - verifyStarted),
  };
  const reportPath = resolve(REPO_ROOT, "validation/evidence/verification.json");
  await mkdir(resolve(REPO_ROOT, "validation/evidence"), { recursive: true });
  const reportContent = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, reportContent, "utf8");
  const result = {
    ok,
    verificationComplete,
    mode: report.mode,
    durationMs: report.durationMs,
    changedOnly,
    changedPaths,
    generatedRegistry: { path: relative(REPO_ROOT, generated.path), sha256: generated.sha256 },
    routing,
    routingAmbiguities,
    matched: {
      domains: domains.map((domain) => domain.id),
      claims: claims.map((claim) => claim.id),
      cases: cases.map((item) => item.id),
    },
    checks: checkResults,
    checkReceipts,
    skippedChecks: skippedChecks.map((check) => ({ id: check.id, details: check.details })),
    requiredLevel,
    notRun,
    blocked,
    unsupported,
    claims: claimStatuses,
    uncovered,
    report: { path: relative(REPO_ROOT, reportPath), sha256: sha256(reportContent) },
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

function levelRank(level) {
  return Number.parseInt(String(level).replace(/^L/u, ""), 10) || 0;
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

function declarationFor(claim, status) {
  if (!["accepted"].includes(status)) return null;
  if (claim.level === "L0" || claim.level === "L1")
    return claim.allowedDeclarations.includes("ImplementationComplete") ? "ImplementationComplete" : null;
  if (claim.level === "L2" || claim.level === "L3")
    return claim.allowedDeclarations.includes("RuntimeValidated") ? "RuntimeValidated" : null;
  if (claim.allowedDeclarations.includes("PerformanceEvaluated")) return "PerformanceEvaluated";
  if (claim.allowedDeclarations.includes("PipelineFeatureComplete")) return "PipelineFeatureComplete";
  if (claim.allowedDeclarations.includes("RuntimeValidated")) return "RuntimeValidated";
  return claim.allowedDeclarations.includes("ImplementationComplete") ? "ImplementationComplete" : null;
}

function statusRow(claim, model, evidence, head, signatures) {
  const status = claim.lifecycle === "retired" ? "retired" : claimStatus(claim, evidence, head, signatures);
  const claimEvidence = evidence.evidence.filter((item) => item.claimIds?.includes(claim.id));
  const latest = claimEvidence.reduce((current, item) => {
    if (!current) return item;
    return `${item.completedAt ?? ""}\u0000${item.runId ?? ""}` >
      `${current.completedAt ?? ""}\u0000${current.runId ?? ""}`
      ? item
      : current;
  }, null);
  const cases = model.cases.filter((item) => item.covers?.includes(claim.id)).map((item) => item.id);
  let openGap = "none";
  if (status === "unproven") openGap = "no evidence for this claim";
  else if (status === "diagnostic") openGap = "latest evidence is diagnostic or unsupported";
  else if (status === "stale")
    openGap = "evidence revision, registry, cleanliness, or required checks do not match";
  else if (status === "blocked") openGap = "latest relevant case failed or is blocked";
  return {
    id: claim.id,
    domain: claim.domain,
    statement: claim.statement,
    requiredAssurance: claim.level,
    status,
    latestEvidence: latest
      ? { runId: latest.runId, caseId: latest.caseId, completedAt: latest.completedAt, result: latest.status }
      : null,
    freshness: latest?.freshness ?? null,
    currentDeclaration: declarationFor(claim, status),
    openGap,
    cases,
    requiredChecks: claim.requiredChecks,
  };
}

function renderStatus(rows, domainId) {
  const title = domainId ? `# Project Status: ${domainId}` : "# Project Status";
  const lines = [
    "<!-- Generated by node tools/vibe.mjs status. Do not edit. -->",
    title,
    "",
    `Revision: \`${currentRevision()}\``,
    "",
    "| Domain | Claim | Assurance | Status | Latest evidence | Freshness | Declaration | Open gap |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => {
      const latest = row.latestEvidence
        ? `${row.latestEvidence.caseId} (${row.latestEvidence.completedAt ?? "unknown"})`
        : "-";
      const freshness = row.freshness ? (row.freshness.accepted ? "accepted" : "stale") : "-";
      return `| ${row.domain} | ${row.id} | ${row.requiredAssurance} | ${row.status} | ${latest} | ${freshness} | ${row.currentDeclaration ?? "-"} | ${row.openGap} |`;
    }),
    "",
    "The table is generated from project claims and validation evidence. Edit manifests, cases, or evidence inputs instead.",
  ];
  return `${lines.join("\n")}\n`;
}

async function caseCommand(caseId, run, accept) {
  if (!caseId) throw new Error("Usage: node tools/vibe.mjs case <case-id> [--run]");
  const model = await loadModel();
  const legacy = null;
  assertModel(model, legacy);
  const item = model.cases.find((candidate) => candidate.id === caseId);
  if (!item) throw new Error(`Unknown case '${caseId}'`);
  if (run) {
    const registry = buildRegistry(model, legacy);
    assertRegistry(registry);
    await writeGeneratedRegistry(registry);
    const runnerArgs = [resolve(REPO_ROOT, "validation/src/runner/run-case.mjs"), caseId];
    if (accept) runnerArgs.push("--accept");
    const result = spawnSync(process.execPath, runnerArgs, { cwd: REPO_ROOT, stdio: "inherit" });
    process.exitCode = result.status ?? 1;
    return;
  }
  console.log(JSON.stringify(stripPrivate(item), null, 2));
}

async function statusCommand(domainId) {
  const model = await loadModel();
  const legacy = null;
  assertModel(model, legacy);
  if (domainId && !model.domains.some((domain) => domain.id === domainId))
    throw new Error(`Unknown domain '${domainId}'`);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const evidence = await loadEvidenceIndex();
  const registry = buildRegistry(model, legacy);
  const generated = await writeGeneratedRegistry(registry);
  const registrySha256 = generated.sha256;
  const signatures = caseSignatures(model);
  const claims = model.claims.filter((claim) => !domainId || claim.domain === domainId);
  const rows = claims.map((claim) => statusRow(claim, model, evidence, head, signatures));
  const statusPath = resolve(REPO_ROOT, "docs/status.generated.md");
  await writeFile(statusPath, renderStatus(rows, domainId), "utf8");
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        revision: head,
        registrySha256,
        evidenceIndex: relative(REPO_ROOT, EVIDENCE_INDEX),
        generatedStatus: relative(REPO_ROOT, statusPath),
        claims: rows,
      },
      null,
      2,
    ),
  );
}

async function evidenceCommand(forceEmpty, forcePrune, checkOnly) {
  const model = await loadModel();
  const legacy = null;
  assertModel(model, legacy);
  const registry = buildRegistry(model, legacy);
  assertRegistry(registry);
  const generated = await writeGeneratedRegistry(registry);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const index = await buildEvidenceIndex(model, head, generated.sha256);
  assertWorkstreamCompletion(model, index, head, caseSignatures(model));
  if (checkOnly) {
    const next = canonicalJsonText(index);
    const current = existsSync(EVIDENCE_INDEX) ? await readFile(EVIDENCE_INDEX, "utf8") : "";
    const upToDate = current === next;
    console.log(
      JSON.stringify(
        {
          checked: relative(REPO_ROOT, EVIDENCE_INDEX),
          upToDate,
          evidence: index.evidence.length,
          errors: index.errors.length,
          warnings: index.warnings.length,
          sha256: sha256(next),
        },
        null,
        2,
      ),
    );
    if (!upToDate) process.exitCode = 1;
    return;
  }
  const existing = await loadEvidenceIndex();
  const replacementError = evidenceReplacementError(index, existing, { forceEmpty, forcePrune });
  if (replacementError) throw new Error(replacementError);
  const result = await writeEvidenceIndex(index);
  console.log(
    JSON.stringify(
      {
        generated: relative(REPO_ROOT, result.path),
        evidence: index.evidence.length,
        errors: index.errors.length,
        warnings: index.warnings.length,
        sha256: result.sha256,
      },
      null,
      2,
    ),
  );
}

function stripPrivate(value) {
  const { _file, _lab, ...publicValue } = value;
  return publicValue;
}

function summarizeClaim(claim) {
  return { id: claim.id, level: claim.level, statement: claim.statement };
}

function summarizeCase(item) {
  return { id: item.id, evidenceRole: item.evidenceRole, level: item.level, covers: item.covers ?? [] };
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
  context <path> --claims | --cases | --all
                       expand claim, case, or complete routed detail
  verify --module      use tools/vibe.mjs for the separate module-close check
  verify --full        run the complete final integration checks explicitly
  verify --plan        print selected checks/tests without running or writing
  verify --json        print the complete report payload instead of a summary
  verify --base <rev>  include committed changes since a base revision
                       exit 0 = executed checks passed; deferred cases appear in notRun
  registry             generate validation/registry.generated.json
  evidence [--check] [--force-empty] [--force-prune]
                       rebuild atomically; evidence removal requires explicit force
  status [domain]      generate and print the claim status matrix
  case <id> [--run]    inspect or run a diagnostic case/lab
  case <id> --run --accept
                       require full preflight and allow clean accepted evidence
  doctor               validate the complete project model`);
}

function claimsForCases(model, directClaims, cases) {
  const claimIds = new Set(directClaims.map((claim) => claim.id));
  for (const item of cases) for (const claimId of item.covers ?? []) claimIds.add(claimId);
  return model.claims.filter((claim) => claimIds.has(claim.id));
}

function browserCasesRequired(cases, requiredLevel) {
  if (levelRank(requiredLevel) < 2) return [];
  const requiredRank = levelRank(requiredLevel);
  return cases
    .filter((item) => item.evidenceRole === "promotion" && item.automatic !== false && item.lab !== true)
    .filter((item) => levelRank(item.level) >= 2 && levelRank(item.level) <= requiredRank)
    .map((item) => ({
      caseId: item.id,
      level: item.level,
      harness: item.harness,
      reason: "browser execution is explicit; verify does not launch cases",
    }));
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
    verificationComplete: result.verificationComplete,
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
    browserCasesNotRun: result.notRun.map((item) => item.caseId),
    report: result.report,
  };
}

function assertWorkstreamCompletion(model, evidence, head, signatures) {
  const errors = validateWorkstreamCompletion(model, evidence, head, signatures);
  if (errors.length > 0) throw new Error(`Invalid completed workstream:\n${errors.join("\n")}`);
}
