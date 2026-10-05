import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { canonicalJson, requireValidRegistry, validateRegistry } from "../validation/src/shared/registry.mjs";
import { CHECK_RUNNER_IDS } from "./check-runners.mjs";

export const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(TOOLS_DIR, "..");
export const PROJECT_DIR = resolve(REPO_ROOT, "project");
export const DOMAIN_DIR = resolve(PROJECT_DIR, "domains");
export const WORKSTREAM_DIR = resolve(PROJECT_DIR, "workstreams/active");
export const CHECK_DIR = resolve(REPO_ROOT, "checks");
export const SOURCE_DIR = resolve(REPO_ROOT, "docs/sources");
export const DOMAIN_DOC_DIR = resolve(REPO_ROOT, "docs/domains");
export const CONTRACT_DOC_DIR = resolve(REPO_ROOT, "docs/contracts");
export const VALIDATION_DIR = resolve(REPO_ROOT, "validation");
export const CASE_DIR = resolve(VALIDATION_DIR, "cases");
export const LAB_DIR = resolve(VALIDATION_DIR, "labs");
export const PROFILE_DIR = resolve(VALIDATION_DIR, "profiles");
export const WORKLOAD_DIR = resolve(VALIDATION_DIR, "workloads");
export const GENERATED_REGISTRY = resolve(VALIDATION_DIR, "registry.generated.json");
export const ARTIFACT_DIR = resolve(REPO_ROOT, ".local/validation");

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ASSURANCE = new Set(["L0", "L1", "L2", "L3", "L4"]);
const KINDS = new Set(["unit", "contract", "oracle", "guard", "gpu", "perf"]);
const HARNESSES = new Set(["protocol", "gpu", "production", "observer"]);
const CASE_KINDS = new Set(["orchestration", "component", "internal-candidate", "production"]);

export async function readYaml(path) {
  const source = await readFile(path, "utf8");
  const document = parseDocument(source, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(
      `${relative(REPO_ROOT, path)}: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  if (document.warnings.length > 0) {
    throw new Error(
      `${relative(REPO_ROOT, path)}: ${document.warnings.map((warning) => warning.message).join("; ")}`,
    );
  }
  const value = document.toJS({ mapAsMap: false });
  if (value === null || typeof value !== "object") {
    throw new Error(`${relative(REPO_ROOT, path)}: document must contain an object`);
  }
  return value;
}

export async function readYamlFiles(directory) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await readYamlFiles(path)));
    else if (entry.isFile() && /\.ya?ml$/u.test(entry.name)) files.push(path);
  }
  files.sort((left, right) => String(left.path ?? left).localeCompare(String(right.path ?? right)));
  return Promise.all(
    files.map(async (entry) => {
      if (typeof entry === "string") return { path: entry, value: await readYaml(entry) };
      return entry;
    }),
  );
}

export async function readFrontmatterFiles(directory) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") continue;
    const path = resolve(directory, entry.name);
    const source = await readFile(path, "utf8");
    // Accept CRLF as well as LF: the project OS must not depend on the local
    // core.autocrlf setting or the checkout platform.
    const opening = source.match(/^---\r?\n/u);
    if (!opening) {
      files.push({ path, source, value: null });
      continue;
    }
    const bodyStart = opening[0].length;
    const end = source.indexOf("\n---", bodyStart);
    if (end < 0) throw new Error(`${relative(REPO_ROOT, path)}: frontmatter closing marker is missing`);
    const document = parseDocument(source.slice(bodyStart, end), { prettyErrors: true, uniqueKeys: true });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      const messages = [...document.errors, ...document.warnings].map((item) => item.message).join("; ");
      throw new Error(`${relative(REPO_ROOT, path)}: invalid frontmatter: ${messages}`);
    }
    files.push({ path, source, value: document.toJS({ mapAsMap: false }) });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

export async function loadModel() {
  const [
    domainFiles,
    checkFiles,
    sourceFiles,
    workstreamFiles,
    caseFiles,
    labFiles,
    profileFiles,
    workloadFiles,
    domainDocs,
    contractDocs,
  ] = await Promise.all([
    readYamlFiles(DOMAIN_DIR),
    readYamlFiles(CHECK_DIR),
    readYamlFiles(SOURCE_DIR),
    readYamlFiles(WORKSTREAM_DIR),
    readYamlFiles(CASE_DIR),
    readYamlFiles(LAB_DIR),
    readYamlFiles(PROFILE_DIR),
    readYamlFiles(WORKLOAD_DIR),
    readFrontmatterFiles(DOMAIN_DOC_DIR),
    readFrontmatterFiles(CONTRACT_DOC_DIR),
  ]);

  const domains = domainFiles.map(({ path, value }) => ({ ...value, _file: relative(REPO_ROOT, path) }));
  const checks = checkFiles.flatMap(({ path, value }) => {
    const items = Array.isArray(value.checks) ? value.checks : [value];
    return items.map((check) => ({ ...check, _file: relative(REPO_ROOT, path) }));
  });
  const sourceIndex = sourceFiles.find(({ path }) => basename(path) === "index.yaml")?.value ?? null;
  const sources = sourceFiles
    .filter(({ path }) => basename(path) !== "index.yaml")
    .map(({ path, value }) => ({ ...value, _file: relative(REPO_ROOT, path) }));
  const workstreams = workstreamFiles.map(({ path, value }) => ({
    ...value,
    _file: relative(REPO_ROOT, path),
  }));
  const cases = [...caseFiles, ...labFiles]
    .filter(({ path }) => basename(path) === "case.yaml")
    .map(({ path, value }) => ({
      ...value,
      _file: relative(REPO_ROOT, path),
      _lab: path.startsWith(`${LAB_DIR}${sep}`),
    }));
  const profiles = profileFiles.map(({ path, value }) => ({ ...value, _file: relative(REPO_ROOT, path) }));
  const workloads = workloadFiles.map(({ path, value }) => ({ ...value, _file: relative(REPO_ROOT, path) }));

  return {
    domains,
    checks,
    sources,
    sourceIndex,
    workstreams,
    cases,
    profiles,
    workloads,
    domainDocs,
    contractDocs,
  };
}

export function validateModel(model, legacyRegistry) {
  const errors = [];
  const domains = new Map();
  const cases = new Map();
  const profiles = new Map();
  const workloads = new Map();
  for (const domain of model.domains) {
    if (!ID_PATTERN.test(domain.id ?? "")) errors.push(`${domain._file}: invalid domain id`);
    if (domains.has(domain.id)) errors.push(`${domain._file}: duplicate domain ${domain.id}`);
    domains.set(domain.id, domain);
    if (typeof domain.title !== "string" || domain.title.length < 3)
      errors.push(`${domain._file}: title is required`);
    if (domain.primaryOwner !== domain.id) errors.push(`${domain._file}: primaryOwner must equal domain id`);
    if (!Array.isArray(domain.paths) || domain.paths.length === 0)
      errors.push(`${domain._file}: paths must be non-empty`);
    if (!Array.isArray(domain.currentDocs) || domain.currentDocs.length === 0)
      errors.push(`${domain._file}: currentDocs must be non-empty`);
    for (const doc of domain.currentDocs ?? [])
      if (typeof doc !== "string" || !existsSync(resolve(REPO_ROOT, doc)))
        errors.push(`${domain._file}: missing declared document ${doc}`);
    for (const field of ["contracts", "decisions", "sources", "checks", "watch"]) {
      if (!Array.isArray(domain[field]) || domain[field].length === 0)
        errors.push(`${domain._file}: ${field} must be non-empty`);
    }
  }
  const sourceIds = new Set();
  for (const source of model.sources) {
    if (!ID_PATTERN.test(source.id ?? "")) errors.push(`${source._file}: invalid source id`);
    if (sourceIds.has(source.id)) errors.push(`${source._file}: duplicate source ${source.id}`);
    sourceIds.add(source.id);
    if (!source.kind || !source.upstream || typeof source.upstream.name !== "string")
      errors.push(`${source._file}: source upstream metadata is required`);
    if (typeof source.license !== "string" || source.license.length < 8)
      errors.push(`${source._file}: source license is required`);
    if (!Array.isArray(source.retainedInvariants) || source.retainedInvariants.length === 0)
      errors.push(`${source._file}: retainedInvariants must be non-empty`);
    if (!Array.isArray(source.validation) || source.validation.length === 0)
      errors.push(`${source._file}: source validation must be non-empty`);
    if (source.sourceMap && !existsSync(resolve(REPO_ROOT, source.sourceMap)))
      errors.push(`${source._file}: missing sourceMap ${source.sourceMap}`);
  }
  if (!model.sourceIndex || !Array.isArray(model.sourceIndex.sources))
    errors.push("docs/sources/index.yaml: sources index is required");
  const indexedSourceIds = new Set();
  for (const entry of model.sourceIndex?.sources ?? []) {
    if (!sourceIds.has(entry.id)) errors.push(`docs/sources/index.yaml: unknown source ${entry.id}`);
    if (indexedSourceIds.has(entry.id)) errors.push(`docs/sources/index.yaml: duplicate source ${entry.id}`);
    indexedSourceIds.add(entry.id);
    if (typeof entry.path !== "string" || !existsSync(resolve(REPO_ROOT, entry.path)))
      errors.push(`docs/sources/index.yaml: missing source path ${entry.path}`);
  }
  validateFrontmatterDocs(model, errors);
  const checkIds = new Set();
  for (const check of model.checks) {
    if (!ID_PATTERN.test(check.id ?? ""))
      errors.push(`${check._file}: invalid check id ${check.id ?? "<missing>"}`);
    if (checkIds.has(check.id)) errors.push(`${check._file}: duplicate check ${check.id}`);
    checkIds.add(check.id);
    if (typeof check.description !== "string" || check.description.length < 8)
      errors.push(`${check._file}: ${check.id} needs a description`);
    if (!KINDS.has(check.kind)) errors.push(`${check._file}: ${check.id} has invalid kind`);
    if (!ASSURANCE.has(check.level)) errors.push(`${check._file}: ${check.id} has invalid level`);
    // A check must bind to a registered runner; an unbound check would silently
    // become a claim precondition that nothing can ever satisfy.
    if (typeof check.runner !== "string" || !CHECK_RUNNER_IDS.includes(check.runner)) {
      errors.push(`${check._file}: ${check.id} has unregistered runner '${check.runner ?? "<missing>"}'`);
    }
    for (const domainId of check.domains ?? [])
      if (!domains.has(domainId))
        errors.push(`${check._file}: ${check.id} references unknown domain ${domainId}`);
  }
  const contractIds = new Set();
  for (const entry of model.contractDocs ?? []) {
    const id = entry.value?.id;
    if (!id) continue;
    if (contractIds.has(id)) errors.push(`${relative(REPO_ROOT, entry.path)}: duplicate contract ${id}`);
    contractIds.add(id);
  }
  for (const domain of model.domains) {
    for (const contractId of domain.contracts ?? []) {
      const contractExists =
        contractIds.has(contractId) || existsSync(resolve(REPO_ROOT, `docs/specs/${contractId}.md`));
      if (!contractExists)
        errors.push(`${domain._file}: ${domain.id} references unknown contract ${contractId}`);
    }
    for (const decision of domain.decisions ?? [])
      if (!hasDecisionFile(decision))
        errors.push(`${domain._file}: ${domain.id} references unknown decision ${decision}`);
    for (const sourceId of domain.sources ?? [])
      if (!sourceIds.has(sourceId))
        errors.push(`${domain._file}: ${domain.id} references unknown source ${sourceId}`);
    for (const checkId of domain.checks ?? [])
      if (!checkIds.has(checkId))
        errors.push(`${domain._file}: ${domain.id} references unknown check ${checkId}`);
  }
  for (const item of model.cases) {
    if (!ID_PATTERN.test(item.id ?? ""))
      errors.push(`${item._file}: invalid case id ${item.id ?? "<missing>"}`);
    if (cases.has(item.id)) errors.push(`${item._file}: duplicate case ${item.id}`);
    cases.set(item.id, item);
    if (!domains.has(item.domain))
      errors.push(`${item._file}: ${item.id} references unknown domain ${item.domain}`);
    if (!CASE_KINDS.has(item.caseKind)) errors.push(`${item._file}: ${item.id} has invalid caseKind`);
    if (item.sourceCase !== undefined && (!ID_PATTERN.test(item.sourceCase) || item.sourceCase === item.id))
      errors.push(`${item._file}: ${item.id} has invalid sourceCase`);
    if (!/^ADR-\d{4}$/u.test(item.decision ?? ""))
      errors.push(`${item._file}: ${item.id} has invalid decision`);
    if (!Array.isArray(item.changedPaths) || item.changedPaths.length === 0)
      errors.push(`${item._file}: ${item.id} needs changedPaths`);
    if (typeof item.route !== "string" || !item.route.startsWith("/"))
      errors.push(`${item._file}: ${item.id} has invalid route`);
    const routePath = item.route.split("?", 1)[0].replace(/^\/+/u, "");
    if (routePath && !existsSync(resolve(VALIDATION_DIR, routePath)))
      errors.push(`${item._file}: ${item.id} route does not resolve to a validation page`);
    if (!Number.isInteger(item.timeoutMs) || item.timeoutMs < 1000)
      errors.push(`${item._file}: ${item.id} has invalid timeoutMs`);
    if (!Array.isArray(item.artifacts) || !item.artifacts.includes("result"))
      errors.push(`${item._file}: ${item.id} must publish result artifact`);
    if (!KINDS.has(item.kind)) errors.push(`${item._file}: ${item.id} has invalid kind`);
    if (!ASSURANCE.has(item.level)) errors.push(`${item._file}: ${item.id} has invalid level`);
    if (!HARNESSES.has(item.harness)) errors.push(`${item._file}: ${item.id} has invalid harness`);
    if (item.lab !== undefined && typeof item.lab !== "boolean")
      errors.push(`${item._file}: ${item.id} lab must be boolean`);
    if (item.automatic !== undefined && typeof item.automatic !== "boolean")
      errors.push(`${item._file}: ${item.id} automatic must be boolean`);
    if (item.lab === true && item.automatic === true)
      errors.push(`${item._file}: ${item.id} lab cases cannot be automatic`);
    if (item._lab && item.lab !== true) errors.push(`${item._file}: lab manifests must set lab: true`);
    if (!item._lab && item.lab === true)
      errors.push(`${item._file}: automatic cases cannot be marked as labs`);
  }
  for (const item of model.cases)
    if (item.sourceCase !== undefined && !cases.has(item.sourceCase))
      errors.push(`${item._file}: ${item.id} references unknown sourceCase ${item.sourceCase}`);
  for (const profile of model.profiles) {
    if (!ID_PATTERN.test(profile.id ?? "")) errors.push(`${profile._file}: invalid profile id`);
    if (profiles.has(profile.id)) errors.push(`${profile._file}: duplicate profile ${profile.id}`);
    if (!Array.isArray(profile.viewport) || profile.viewport.length !== 2)
      errors.push(`${profile._file}: invalid viewport`);
    profiles.set(profile.id, profile);
  }
  for (const workload of model.workloads) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*-v\d+$/u.test(workload.id ?? ""))
      errors.push(`${workload._file}: invalid workload id`);
    if (workloads.has(workload.id)) errors.push(`${workload._file}: duplicate workload ${workload.id}`);
    workloads.set(workload.id, workload);
  }
  for (const domain of model.domains) {
    for (const checkId of domain.checks ?? [])
      if (!model.checks.some((check) => check.id === checkId))
        errors.push(`${domain._file}: ${domain.id} references unknown check ${checkId}`);
  }
  for (const item of model.cases) {
    if (!profiles.has(item.profile) && !legacyRegistry?.profiles?.[item.profile])
      errors.push(`${item._file}: ${item.id} references unknown profile ${item.profile}`);
    if (!workloads.has(item.workloadId) && !legacyRegistry?.workloads?.[item.workloadId])
      errors.push(`${item._file}: ${item.id} references unknown workload ${item.workloadId}`);
  }
  const workstreamIds = new Set();
  for (const workstream of model.workstreams) {
    if (!ID_PATTERN.test(workstream.id ?? "")) errors.push(`${workstream._file}: invalid workstream id`);
    if (workstreamIds.has(workstream.id))
      errors.push(`${workstream._file}: duplicate workstream ${workstream.id}`);
    workstreamIds.add(workstream.id);
    if (!domains.has(workstream.domain))
      errors.push(`${workstream._file}: unknown workstream domain ${workstream.domain}`);
    if (!/^(?:active|paused|done)$/u.test(workstream.state ?? ""))
      errors.push(`${workstream._file}: invalid workstream state`);
    if (!/^ADR-\d{4}$/u.test(workstream.decision ?? ""))
      errors.push(`${workstream._file}: invalid workstream decision`);
    // Workstreams are navigation during the destructive rebuild. Claims,
    // evidence and exit checks are optional deferred acceptance metadata.
    for (const field of ["contracts", "tasks", "exitChecks", "requiredEvidence"]) {
      if (workstream[field] !== undefined && !Array.isArray(workstream[field])) {
        errors.push(`${workstream._file}: ${field} must be an array when present`);
      }
    }
    for (const checkId of workstream.exitChecks ?? [])
      if (!checkIds.has(checkId)) errors.push(`${workstream._file}: unknown workstream check ${checkId}`);
    for (const task of workstream.tasks ?? [])
      if (!ID_PATTERN.test(task.id ?? "") || !/^(?:todo|active|done|blocked)$/u.test(task.state ?? ""))
        errors.push(`${workstream._file}: invalid workstream task`);
    if (workstream.state === "done" && (workstream.tasks ?? []).some((task) => task.state !== "done"))
      errors.push(`${workstream._file}: done workstream has unfinished tasks`);
  }
  return errors;
}

function validateFrontmatterDocs(model, errors) {
  const domainIds = new Set(model.domains.map((domain) => domain.id));
  for (const entry of model.domainDocs ?? []) {
    validateMarkdownLinks(entry, errors);
    if (!entry.value) {
      errors.push(`${relative(REPO_ROOT, entry.path)}: domain frontmatter is required`);
      continue;
    }
    const value = entry.value;
    if (!domainIds.has(value.id) || value.kind !== "domain" || typeof value.owner !== "string")
      errors.push(`${relative(REPO_ROOT, entry.path)}: invalid domain frontmatter identity`);
    if ("contracts" in value)
      errors.push(
        `${relative(REPO_ROOT, entry.path)}: domain relationships belong in project/domains, not Markdown frontmatter`,
      );
  }
  for (const entry of model.contractDocs ?? []) {
    validateMarkdownLinks(entry, errors);
    if (!entry.value) {
      errors.push(`${relative(REPO_ROOT, entry.path)}: contract frontmatter is required`);
      continue;
    }
    const value = entry.value;
    if (
      !ID_PATTERN.test(value.id ?? "") ||
      value.kind !== "contract" ||
      typeof value.status !== "string" ||
      !["string", "number"].includes(typeof value.version)
    )
      errors.push(`${relative(REPO_ROOT, entry.path)}: invalid contract frontmatter identity`);
    for (const field of ["owners", "consumers", "invariants", "validation"])
      if (!Array.isArray(value[field]) || value[field].length === 0)
        errors.push(`${relative(REPO_ROOT, entry.path)}: contract frontmatter ${field} must be non-empty`);
  }
}

function validateMarkdownLinks(entry, errors) {
  for (const match of entry.source?.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu) ?? []) {
    const target = match[1].replace(/^<|>$/gu, "").split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:|data:)/iu.test(target)) continue;
    if (!existsSync(resolve(dirname(entry.path), target)))
      errors.push(`${relative(REPO_ROOT, entry.path)}: broken link ${target}`);
  }
}

function hasDecisionFile(id) {
  if (!/^ADR-\d{4}$/u.test(id ?? "")) return false;
  const prefix = id.slice(4).toLowerCase();
  return readdirSync(resolve(REPO_ROOT, "docs/adr"), { withFileTypes: true }).some(
    (entry) => entry.isFile() && entry.name.toLowerCase().startsWith(prefix) && entry.name.endsWith(".md"),
  );
}

function normalizeCaseEntry(item) {
  const { _file, _lab, schemaVersion, ...rest } = item;
  return { ...rest, lab: rest.lab ?? Boolean(_lab), automatic: rest.automatic ?? !_lab };
}

export function buildRegistry(model, legacyRegistry) {
  const profiles = Object.fromEntries(
    model.profiles.map(({ _file, schemaVersion, ...profile }) => [profile.id, profile]),
  );
  const workloads = Object.fromEntries(
    model.workloads.map(({ _file, schemaVersion, ...workload }) => [workload.id, workload]),
  );
  const cases = model.cases.map(normalizeCaseEntry);
  return {
    schemaVersion: legacyRegistry?.schemaVersion ?? 1,
    hostProtocolVersion: legacyRegistry?.hostProtocolVersion ?? 1,
    profiles: Object.keys(profiles).length > 0 ? profiles : (legacyRegistry?.profiles ?? {}),
    workloads: Object.keys(workloads).length > 0 ? workloads : (legacyRegistry?.workloads ?? {}),
    cases,
    generatedFrom: {
      source: "project + validation/cases/*/case.yaml + validation/labs/*/case.yaml",
      generatorVersion: 1,
    },
  };
}

export async function writeGeneratedRegistry(registry) {
  await mkdir(dirname(GENERATED_REGISTRY), { recursive: true });
  const content = canonicalJsonText(registry);
  await writeFile(GENERATED_REGISTRY, content, "utf8");
  return { path: GENERATED_REGISTRY, bytes: Buffer.byteLength(content), sha256: sha256(content) };
}

export function validateGeneratedRegistry(registry) {
  return validateRegistry(registry);
}

export function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function pathMatches(path, pattern) {
  const normalizedPath = normalizePath(path);
  const normalizedPattern = normalizePath(pattern);
  const basePattern = normalizedPattern.endsWith("/**") ? normalizedPattern.slice(0, -3) : normalizedPattern;
  const expression = `^${globSource(basePattern)}(?:/.*)?$`;
  return new RegExp(expression, "u").test(normalizedPath);
}

export function matchingDomains(model, paths) {
  return model.domains.filter((domain) =>
    paths.some((path) => domain.paths.some((pattern) => pathMatches(path, pattern))),
  );
}

export function routeDomains(model, paths) {
  const matches = model.domains
    .map((domain) => {
      const matchingPatterns = domain.paths.filter((pattern) =>
        paths.some((path) => pathMatches(path, pattern)),
      );
      if (matchingPatterns.length === 0) return null;
      const score = Math.max(...matchingPatterns.map((pattern) => literalPatternScore(pattern)));
      return { domain, score, patterns: matchingPatterns };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.domain.id.localeCompare(right.domain.id));
  const [primary, ...related] = matches;
  return {
    primary: primary ? { id: primary.domain.id, score: primary.score, patterns: primary.patterns } : null,
    related: related.map((entry) => ({ id: entry.domain.id, score: entry.score, patterns: entry.patterns })),
    ambiguous: Boolean(primary && related.some((entry) => entry.score === primary.score)),
  };
}

function literalPatternScore(pattern) {
  return normalizePath(pattern).replaceAll("*", "").length;
}

export function matchingCases(model, paths) {
  return model.cases.filter((item) =>
    paths.some((path) => item.changedPaths.some((pattern) => pathMatches(path, pattern))),
  );
}

export function getChangedPaths(baseRevision) {
  const output = execFileSync("git", ["status", "--short", "--untracked-files=all", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const paths = new Set();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const raw = record.slice(3);
    if (status.includes("R") || status.includes("C")) {
      const previous = records[index + 1];
      if (previous) paths.add(normalizePath(previous));
      index += 1;
    }
    if (raw) paths.add(normalizePath(raw));
  }
  if (baseRevision) {
    const diff = execFileSync("git", ["diff", "--name-status", "-z", "--find-renames", baseRevision, "--"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const entries = diff.split("\0");
    for (let index = 0; index < entries.length; ) {
      const status = entries[index++];
      if (!status) continue;
      const first = entries[index++];
      if (first) paths.add(normalizePath(first));
      if (/^[RC]/u.test(status)) {
        const second = entries[index++];
        if (second) paths.add(normalizePath(second));
      }
    }
  }
  return [...paths].sort();
}

/**
 * Paths that are generated, ignored, or external to the routing graph.
 *
 * This list used to live in the CLI while the engine guard test duplicated its
 * own version, so the two could disagree about what counts as an unowned path.
 */
export function isIgnoredPath(path) {
  return (
    path === "" ||
    path === "package-lock.json" ||
    path === "validation/registry.generated.json" ||
    path === "validation/evidence/index.json" ||
    path === "validation/evidence/verification.json" ||
    path === "docs/status.generated.md" ||
    path.startsWith(".local/validation/") ||
    path.startsWith("node_modules/") ||
    path.startsWith("validation/node_modules/")
  );
}

function levelRank(level) {
  return Number.parseInt(String(level).replace(/^L/u, ""), 10) || 0;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJsonText(value) {
  return `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;
}

function globSource(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(character);
    }
  }
  return source;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function assertModel(model, legacyRegistry) {
  const errors = validateModel(model, legacyRegistry);
  if (errors.length > 0) throw new Error(`Invalid project model:\n${errors.join("\n")}`);
  return model;
}

export function assertRegistry(registry) {
  requireValidRegistry(registry);
  return registry;
}

async function listFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
