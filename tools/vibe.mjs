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
  canonicalJsonText
} from "./vibe-lib.mjs";
import { runCheckImplementation } from "./check-runners.mjs";

const [command = "doctor", ...args] = process.argv.slice(2);

try {
  if (command === "registry") await registryCommand();
  else if (command === "evidence") await evidenceCommand();
  else if (command === "doctor") await doctorCommand();
  else if (command === "context") await contextCommand(args[0] ?? ".");
  else if (command === "verify") await verifyCommand(args.includes("--changed"), args.includes("--perf"), args.includes("--allow-not-run"));
  else if (command === "case") await caseCommand(args[0], args.includes("--run"));
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
  if (registryErrors.length > 0) throw new Error(`Generated registry is invalid:\n${registryErrors.join("\n")}`);
  const result = await writeGeneratedRegistry(registry);
  assertWorkstreamCompletion(model, await loadEvidenceIndex(), currentRevision(), caseSignatures(model));
  console.log(JSON.stringify({ generated: relative(REPO_ROOT, result.path), cases: registry.cases.length, bytes: result.bytes, sha256: result.sha256 }, null, 2));
}

async function doctorCommand() {
  const model = await loadModel();
  const legacy = null;
  const errors = [];
  try { assertModel(model, legacy); } catch (error) { errors.push(error.message); }
  let registry = null;
  try {
    registry = buildRegistry(model, legacy);
    const registryErrors = validateGeneratedRegistry(registry);
    if (registryErrors.length > 0) errors.push(registryErrors.join("\n"));
  } catch (error) { errors.push(error.message); }
  if (registry) {
    try {
      const workstreamErrors = validateWorkstreamCompletion(model, await loadEvidenceIndex(), currentRevision(), caseSignatures(model));
      errors.push(...workstreamErrors);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const warnings = [];
  if (!existsSync(GENERATED_REGISTRY)) warnings.push("generated registry has not been written yet; run `node tools/vibe.mjs registry`");
  if (!existsSync(EVIDENCE_INDEX)) warnings.push("evidence index has not been written yet; run `node tools/vibe.mjs evidence`");
  const result = { ok: errors.length === 0, errors, warnings, counts: { domains: model.domains.length, claims: model.claims.length, checks: model.checks.length, cases: model.cases.length, profiles: model.profiles.length, workloads: model.workloads.length }, generatedRegistry: registry ? relative(REPO_ROOT, GENERATED_REGISTRY) : null };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length > 0) process.exitCode = 1;
}

async function contextCommand(input) {
  const model = await loadModel();
  const legacy = null;
  assertModel(model, legacy);
  const paths = input === "." ? ["."] : [input];
  const all = input === ".";
  const domains = all ? model.domains : matchingDomains(model, paths);
  const cases = all ? model.cases : matchingCases(model, paths);
  const claims = all ? model.claims : claimsForCases(model, matchingClaims(model, paths), cases);
  const domainIds = new Set(domains.map((domain) => domain.id));
  const claimIds = new Set(claims.map((claim) => claim.id));
  const checks = model.checks.filter((check) => all || (check.domains ?? []).some((id) => domainIds.has(id)) || (check.claims ?? []).some((id) => claimIds.has(id)));
  const routing = all ? null : routeDomains(model, paths);
  const routedDomains = domains.map((domain) => ({
    ...stripPrivate(domain),
    routeRole: routing?.primary?.id === domain.id ? "primary" : "related"
  }));
  console.log(JSON.stringify({ input, routing, domains: routedDomains, claims: claims.map(stripPrivate), checks: checks.map(stripPrivate), cases: cases.map(stripPrivate) }, null, 2));
}

async function verifyCommand(changedOnly, perfRequested, allowNotRun) {
  const model = await loadModel();
  const legacy = null;
  assertModel(model, legacy);
  const registry = buildRegistry(model, legacy);
  assertRegistry(registry);
  const generated = await writeGeneratedRegistry(registry);
  const changedPaths = changedOnly ? getChangedPaths() : ["."];
  const domains = changedOnly ? matchingDomains(model, changedPaths) : model.domains;
  const cases = changedOnly ? matchingCases(model, changedPaths) : model.cases;
  const claims = changedOnly ? claimsForCases(model, matchingClaims(model, changedPaths), cases) : model.claims;
  const routing = changedOnly ? Object.fromEntries(changedPaths.map((path) => [path, routeDomains(model, [path])])) : null;
  const routingAmbiguities = changedOnly
    ? Object.entries(routing).filter(([, route]) => route.ambiguous).map(([path, route]) => ({ path, domains: [route.primary?.id, ...(route.related ?? []).filter((entry) => entry.score === route.primary?.score).map((entry) => entry.id)].filter(Boolean) }))
    : [];
  // Deleted legacy files are intentionally allowed to leave the routing graph.
  // Any file that still exists must remain owned by a declared domain.
  const uncovered = changedOnly ? changedPaths.filter((path) => !isIgnoredPath(path) && existsSync(resolve(REPO_ROOT, path)) && !domains.some((domain) => domain.paths.some((pattern) => pathMatches(path, pattern)))) : [];
  // The check set is derived from the routing model instead of a hard-coded
  // list: matched domains declare their checks and matched claims declare the
  // checks they require. Before this, `project/domains/*.yaml#checks` was inert
  // metadata and `docs-frontmatter` was declared but never executed.
  const checkIds = new Set(["model", "registry", "engine-suites"]);
  if (changedOnly) checkIds.add("changed-coverage");
  for (const domain of domains) for (const checkId of domain.checks ?? []) checkIds.add(checkId);
  for (const claim of claims) for (const checkId of claim.requiredChecks ?? []) checkIds.add(checkId);
  const signatures = caseSignatures(model);
  const evidence = await loadEvidenceIndex();
  assertWorkstreamCompletion(model, evidence, currentRevision(), signatures);
  const requiredLevel = requiredVerificationLevel(changedPaths, perfRequested);
  const checkContext = { repoRoot: REPO_ROOT, model, changedOnly, changedPaths, uncovered, routingAmbiguities, evidence };
  const checkResults = model.checks.filter((check) => checkIds.has(check.id)).map((check) => runCheck(check, checkContext));
  const failedChecks = checkResults.filter((check) => check.status === "failed");
  const claimStatuses = claims.map((claim) => {
    const status = claimStatus(claim, evidence, currentRevision(), signatures);
    return {
      id: claim.id,
      level: claim.level,
      status,
      allowedDeclarations: claim.allowedDeclarations,
      currentDeclaration: declarationFor(claim, status),
      requiredChecks: claim.requiredChecks
    };
  });
  const executableCases = cases.filter((item) => item.automatic !== false && item.lab !== true);
  const notRun = levelRank(requiredLevel) >= 2
    ? executableCases.filter((item) => levelRank(item.level) >= 2).map((item) => ({ caseId: item.id, level: item.level, harness: item.harness, reason: "browser execution is explicit; verify does not launch cases" }))
    : [];
  const blocked = claimStatuses.filter((claim) => claim.status === "blocked").map((claim) => claim.id);
  const unsupported = evidence.evidence.filter((item) => item.status === "unsupported").map((item) => item.caseId);
  // `ok` means the project topology and every executed check passed. It says
  // nothing about the cases this command deliberately does not launch, so the
  // completion signal is reported separately and drives its own exit code.
  const ok = uncovered.length === 0 && routingAmbiguities.length === 0 && failedChecks.length === 0;
  const verificationComplete = ok && notRun.length === 0;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    revision: currentRevision(),
    dirty: execFileSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" }).length > 0,
    changedOnly,
    requiredLevel,
    perfRequested,
    changedPaths,
    routing,
    routingAmbiguities,
    matched: { domains: domains.map((domain) => domain.id), claims: claims.map((claim) => claim.id), cases: cases.map((item) => item.id) },
    checks: checkResults,
    claims: claimStatuses,
    notRun,
    blocked,
    unsupported,
    uncovered,
    ok,
    verificationComplete
  };
  const reportPath = resolve(REPO_ROOT, "validation/evidence/verification.json");
  await mkdir(resolve(REPO_ROOT, "validation/evidence"), { recursive: true });
  const reportContent = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, reportContent, "utf8");
  const result = {
    ok,
    verificationComplete,
    changedOnly,
    changedPaths,
    generatedRegistry: { path: relative(REPO_ROOT, generated.path), sha256: generated.sha256 },
    routing,
    routingAmbiguities,
    matched: { domains: domains.map((domain) => domain.id), claims: claims.map((claim) => claim.id), cases: cases.map((item) => item.id) },
    checks: checkResults,
    requiredLevel,
    notRun,
    blocked,
    unsupported,
    claims: claimStatuses,
    uncovered,
    report: { path: relative(REPO_ROOT, reportPath), sha256: sha256(reportContent) }
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  } else if (!verificationComplete && !allowNotRun) {
    // Exit 2 keeps "topology is consistent" distinct from "the change is
    // verified". Without it, a green exit code on an L2/L3 change that ran no
    // browser case reads as success.
    console.error(
      `verify: ${notRun.length} required validation case(s) at level ${requiredLevel} were not run: `
      + `${notRun.map((item) => item.caseId).join(", ")}\n`
      + "        run them explicitly (`node tools/vibe.mjs case <id> --run`), or acknowledge the gap with --allow-not-run."
    );
    process.exitCode = 2;
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
  if (product.some((path) => /(?:Renderer\.ts|device-loss|replacement|framegraph|Residency|lifecycle|cutover)/iu.test(path))) return "L3";
  if (product.some((path) => /(?:^OEngine\/src\/(?:gpu|render|shaders)|^validation\/(?:harness|cases|labs))/u.test(path))) return "L2";
  return paths.length > 0 ? "L1" : "L0";
}

function levelRank(level) {
  return Number.parseInt(String(level).replace(/^L/u, ""), 10) || 0;
}

function runCheck(check, context) {
  const { status, details } = runCheckImplementation(check, context);
  return { id: check.id, status, level: check.level, description: check.description, details };
}

function declarationFor(claim, status) {
  if (!["accepted"].includes(status)) return null;
  if (claim.level === "L0" || claim.level === "L1") return claim.allowedDeclarations.includes("ImplementationComplete") ? "ImplementationComplete" : null;
  if (claim.level === "L2" || claim.level === "L3") return claim.allowedDeclarations.includes("RuntimeValidated") ? "RuntimeValidated" : null;
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
    return `${item.completedAt ?? ""}\u0000${item.runId ?? ""}` > `${current.completedAt ?? ""}\u0000${current.runId ?? ""}` ? item : current;
  }, null);
  const cases = model.cases.filter((item) => item.covers?.includes(claim.id)).map((item) => item.id);
  let openGap = "none";
  if (status === "unproven") openGap = "no evidence for this claim";
  else if (status === "diagnostic") openGap = "latest evidence is diagnostic or unsupported";
  else if (status === "stale") openGap = "evidence revision, registry, cleanliness, or required checks do not match";
  else if (status === "blocked") openGap = "latest relevant case failed or is blocked";
  return {
    id: claim.id,
    domain: claim.domain,
    statement: claim.statement,
    requiredAssurance: claim.level,
    status,
    latestEvidence: latest ? { runId: latest.runId, caseId: latest.caseId, completedAt: latest.completedAt, result: latest.status } : null,
    freshness: latest?.freshness ?? null,
    currentDeclaration: declarationFor(claim, status),
    openGap,
    cases,
    requiredChecks: claim.requiredChecks
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
      const latest = row.latestEvidence ? `${row.latestEvidence.caseId} (${row.latestEvidence.completedAt ?? "unknown"})` : "-";
      const freshness = row.freshness ? (row.freshness.accepted ? "accepted" : "stale") : "-";
      return `| ${row.domain} | ${row.id} | ${row.requiredAssurance} | ${row.status} | ${latest} | ${freshness} | ${row.currentDeclaration ?? "-"} | ${row.openGap} |`;
    }),
    "",
    "The table is generated from project claims and validation evidence. Edit manifests, cases, or evidence inputs instead."
  ];
  return `${lines.join("\n")}\n`;
}

async function caseCommand(caseId, run) {
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
    const result = spawnSync(process.execPath, [resolve(REPO_ROOT, "validation/src/runner/run-case.mjs"), caseId], { cwd: REPO_ROOT, stdio: "inherit" });
    process.exitCode = result.status ?? 1;
    return;
  }
  console.log(JSON.stringify(stripPrivate(item), null, 2));
}

async function statusCommand(domainId) {
  const model = await loadModel();
  const legacy = null;
  assertModel(model, legacy);
  if (domainId && !model.domains.some((domain) => domain.id === domainId)) throw new Error(`Unknown domain '${domainId}'`);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const evidence = await loadEvidenceIndex();
  const registry = buildRegistry(model, legacy);
  const generated = await writeGeneratedRegistry(registry);
  const registrySha256 = generated.sha256;
  const signatures = caseSignatures(model);
  assertWorkstreamCompletion(model, evidence, head, signatures);
  const claims = model.claims.filter((claim) => !domainId || claim.domain === domainId);
  const rows = claims.map((claim) => statusRow(claim, model, evidence, head, signatures));
  const statusPath = resolve(REPO_ROOT, "docs/status.generated.md");
  await writeFile(statusPath, renderStatus(rows, domainId), "utf8");
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), revision: head, registrySha256, evidenceIndex: relative(REPO_ROOT, EVIDENCE_INDEX), generatedStatus: relative(REPO_ROOT, statusPath), claims: rows }, null, 2));
}

async function evidenceCommand() {
  const model = await loadModel();
  const legacy = null;
  assertModel(model, legacy);
  const registry = buildRegistry(model, legacy);
  assertRegistry(registry);
  const generated = await writeGeneratedRegistry(registry);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const index = await buildEvidenceIndex(model, head, generated.sha256);
  assertWorkstreamCompletion(model, index, head, caseSignatures(model));
  const result = await writeEvidenceIndex(index);
  console.log(JSON.stringify({ generated: relative(REPO_ROOT, result.path), evidence: index.evidence.length, errors: index.errors.length, warnings: index.warnings.length, sha256: result.sha256 }, null, 2));
}

function stripPrivate(value) {
  const { _file, _lab, ...publicValue } = value;
  return publicValue;
}

function printHelp() {
  console.log(`vibe commands:
  context <path>       show primary/related domains, claims, checks, and cases
  verify --changed     run model, registry, ownership, and required guard checks
                       exit 0 = complete, 2 = checks passed but required cases
                       were not run (use --allow-not-run to accept the gap)
  registry             generate validation/registry.generated.json
  evidence             rebuild validation/evidence/index.json from .local/validation
  status [domain]      generate and print the claim status matrix
  case <id> [--run]    inspect or explicitly run one validation case/lab
  doctor               validate the complete project model`);
}

function claimsForCases(model, directClaims, cases) {
  const claimIds = new Set(directClaims.map((claim) => claim.id));
  for (const item of cases) for (const claimId of item.covers ?? []) claimIds.add(claimId);
  return model.claims.filter((claim) => claimIds.has(claim.id));
}


function assertWorkstreamCompletion(model, evidence, head, signatures) {
  const errors = validateWorkstreamCompletion(model, evidence, head, signatures);
  if (errors.length > 0) throw new Error(`Invalid completed workstream:\n${errors.join("\n")}`);
}
