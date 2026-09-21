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
  validateGeneratedRegistry,
  buildEvidenceIndex,
  writeEvidenceIndex,
  sha256,
  validateWorkstreamCompletion,
  canonicalJsonText
} from "./vibe-lib.mjs";

const [command = "doctor", ...args] = process.argv.slice(2);

try {
  if (command === "registry") await registryCommand();
  else if (command === "evidence") await evidenceCommand();
  else if (command === "doctor") await doctorCommand();
  else if (command === "context") await contextCommand(args[0] ?? ".");
  else if (command === "verify") await verifyCommand(args.includes("--changed"), args.includes("--perf"));
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
  assertWorkstreamCompletion(model, await loadEvidenceIndex(), currentRevision(), result.sha256);
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
      const workstreamErrors = validateWorkstreamCompletion(model, await loadEvidenceIndex(), currentRevision(), sha256(canonicalJsonText(registry)));
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

async function verifyCommand(changedOnly, perfRequested) {
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
  const checkIds = new Set(["model", "registry", ...(changedOnly ? ["changed-coverage", "guard-docs", "guard-public-api", "guard-ownership", "guard-legacy", "guard-generated-source"] : [])]);
  for (const claim of claims) for (const checkId of claim.requiredChecks ?? []) checkIds.add(checkId);
  const evidence = await loadEvidenceIndex();
  assertWorkstreamCompletion(model, evidence, currentRevision(), generated.sha256);
  const requiredLevel = requiredVerificationLevel(changedPaths, perfRequested);
  const checkResults = model.checks.filter((check) => checkIds.has(check.id)).map((check) => runCheck(check, { uncovered, routingAmbiguities, evidence, changedPaths }));
  const failedChecks = checkResults.filter((check) => check.status === "failed");
  const claimStatuses = claims.map((claim) => {
    const status = claimStatus(claim, evidence, currentRevision(), generated.sha256);
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
    uncovered
  };
  const reportPath = resolve(REPO_ROOT, "validation/evidence/verification.json");
  await mkdir(resolve(REPO_ROOT, "validation/evidence"), { recursive: true });
  const reportContent = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, reportContent, "utf8");
  const result = {
    ok: uncovered.length === 0 && routingAmbiguities.length === 0 && failedChecks.length === 0,
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
  if (!result.ok) process.exitCode = 1;
}

function currentRevision() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function requiredVerificationLevel(paths, perfRequested) {
  if (perfRequested) return "L4";
  if (paths.some((path) => /(?:Renderer\.ts|device-loss|replacement|framegraph|Residency|lifecycle|cutover)/iu.test(path))) return "L3";
  if (paths.some((path) => /(?:OEngine\/src\/(?:gpu|render|shaders)|validation\/(?:harness|cases|labs))/u.test(path))) return "L2";
  return paths.length > 0 ? "L1" : "L0";
}

function levelRank(level) {
  return Number.parseInt(String(level).replace(/^L/u, ""), 10) || 0;
}

function runCheck(check, { uncovered, routingAmbiguities, evidence, changedPaths }) {
  if (["model", "docs-frontmatter", "guard-docs"].includes(check.id)) return { id: check.id, status: "passed", level: check.level, description: check.description, details: ["validated by project model parsing"] };
  if (check.id === "registry") return { id: check.id, status: "passed", level: check.level, description: check.description, details: ["generated registry validated"] };
  if (check.id === "changed-coverage") return uncovered.length > 0
    ? { id: check.id, status: "failed", level: check.level, description: check.description, details: uncovered }
    : { id: check.id, status: "passed", level: check.level, description: check.description, details: [] };
  if (check.id === "guard-ownership") {
    return uncovered.length > 0 || routingAmbiguities.length > 0
      ? { id: check.id, status: "failed", level: check.level, description: check.description, details: { uncovered, routingAmbiguities } }
      : { id: check.id, status: "passed", level: check.level, description: check.description, details: [] };
  }
  if (check.id === "evidence-provenance" && evidence.errors?.length > 0) return { id: check.id, status: "failed", level: check.level, description: check.description, details: evidence.errors };
  if (check.id === "evidence-provenance" && evidence.evidence.length === 0) return { id: check.id, status: "not-run", level: check.level, description: check.description, details: ["no raw evidence is available"] };
  if (check.id === "evidence-provenance") return { id: check.id, status: "passed", level: check.level, description: check.description, details: [] };
  if (check.id === "guard-legacy") {
    const findings = legacyFindings();
    return { id: check.id, status: findings.length === 0 ? "passed" : "failed", level: check.level, description: check.description, details: findings };
  }
  if (check.id === "guard-public-api" && !existsSync(resolve(REPO_ROOT, "OEngine/src/index.ts"))) {
    return { id: check.id, status: "failed", level: check.level, description: check.description, details: ["OEngine/src/index.ts is missing"] };
  }
  if (check.id === "guard-public-api") return { id: check.id, status: "passed", level: check.level, description: check.description, details: [] };
  if (check.id === "guard-generated-source") {
    const generatedEdits = changedPaths.filter((path) => /\.generated\.(?:ts|js)$/u.test(path));
    return { id: check.id, status: generatedEdits.length === 0 ? "passed" : "failed", level: check.level, description: check.description, details: generatedEdits };
  }
  return { id: check.id, status: "failed", level: check.level, description: check.description, details: ["no runner implementation is registered for this check"] };
}

function legacyFindings() {
  const findings = [];
  for (const path of ["CONTEXT-MAP.md", "docs/ARCHITECTURE.md", "docs/PIPELINE.md", "docs/STATUS.md", "docs/implementation", "docs/others", "validation/cases/registry.json", "validation/src/host", "project/claims/requirements.yaml"]) {
    if (existsSync(resolve(REPO_ROOT, path))) findings.push(`retired path still exists: ${path}`);
  }
  if (existsSync(resolve(REPO_ROOT, "validation/package.json"))) {
    try {
      const scripts = JSON.parse(execFileSync("node", ["-e", "process.stdout.write(JSON.stringify(require(process.argv[1]).scripts ?? {}))", resolve(REPO_ROOT, "validation/package.json")], { encoding: "utf8" }));
      for (const name of Object.keys(scripts)) if (/case|browser/iu.test(name) && !["dev", "build", "typecheck", "test"].includes(name)) findings.push(`per-case validation script still exists: validation:${name}`);
    } catch {
      findings.push("validation/package.json could not be inspected");
    }
  }
  return findings;
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

function statusRow(claim, model, evidence, head, registrySha256) {
  const status = claim.lifecycle === "retired" ? "retired" : claimStatus(claim, evidence, head, registrySha256);
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
  assertWorkstreamCompletion(model, evidence, head, registrySha256);
  const claims = model.claims.filter((claim) => !domainId || claim.domain === domainId);
  const rows = claims.map((claim) => statusRow(claim, model, evidence, head, registrySha256));
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
  assertWorkstreamCompletion(model, index, head, generated.sha256);
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

function isIgnoredPath(path) {
  return path === "" || path === "package-lock.json" || path === "validation/registry.generated.json" || path === "validation/evidence/index.json" || path === "validation/evidence/verification.json" || path === "docs/status.generated.md" || path.startsWith(".local/validation/") || path.startsWith("node_modules/") || path.startsWith("validation/node_modules/");
}

function assertWorkstreamCompletion(model, evidence, head, registrySha256) {
  const errors = validateWorkstreamCompletion(model, evidence, head, registrySha256);
  if (errors.length > 0) throw new Error(`Invalid completed workstream:\n${errors.join("\n")}`);
}
