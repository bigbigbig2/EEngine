import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readYaml, readYamlFiles, pathMatches, routeDomains, normalizePath } from "./project-navigation.mjs";
import { parseMarkdown, resolveLocalReference, exactPathExists } from "./document-model.mjs";
export { readYaml, readYamlFiles, pathMatches, routeDomains, normalizePath };
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

export async function readFrontmatterFiles(directory) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const path = resolve(directory, entry.name);
        const source = await readFile(path, "utf8");
        return { path, source, value: parseMarkdown(source, relative(REPO_ROOT, path)).fields };
      })
  );
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
    contractDocs
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
    readFrontmatterFiles(CONTRACT_DOC_DIR)
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
    _file: relative(REPO_ROOT, path)
  }));
  const cases = [...caseFiles, ...labFiles]
    .filter(({ path }) => basename(path) === "case.yaml")
    .map(({ path, value }) => ({
      ...value,
      _file: relative(REPO_ROOT, path),
      _lab: path.startsWith(`${LAB_DIR}${sep}`)
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
    contractDocs
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
      if (domain[field] !== undefined && !Array.isArray(domain[field]))
        errors.push(`${domain._file}: ${field} must be an array`);
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
    if (!id || entry.value.state === "history") continue;
    if (contractIds.has(id)) errors.push(`${relative(REPO_ROOT, entry.path)}: duplicate contract ${id}`);
    contractIds.add(id);
  }
  for (const domain of model.domains) {
    for (const contractId of domain.contracts ?? []) {
      const contractExists =
        contractIds.has(contractId) ||
        (existsSync(resolve(REPO_ROOT, `docs/specs/${contractId}.md`)) &&
          parseMarkdown(readFileSync(resolve(REPO_ROOT, `docs/specs/${contractId}.md`), "utf8")).fields
            .state === "current");
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
    // Runtime shape is validated once by the shared registry validator below.
    const routePath = typeof item.route === "string" ? item.route.split("?", 1)[0].replace(/^\/+/u, "") : "";
    if (routePath && !existsSync(resolve(VALIDATION_DIR, routePath)))
      errors.push(`${item._file}: ${item.id} route does not resolve to a validation page`);
    if (item._lab && item.lab !== true) errors.push(`${item._file}: lab manifest must set lab: true`);
    if (!item._lab && item.lab === true) errors.push(`${item._file}: case manifest cannot be lab`);
  }
  for (const item of model.cases)
    if (item.sourceCase !== undefined && !cases.has(item.sourceCase))
      errors.push(`${item._file}: ${item.id} references unknown sourceCase ${item.sourceCase}`);
  for (const profile of model.profiles) {
    if (!ID_PATTERN.test(profile.id ?? "")) errors.push(`${profile._file}: invalid profile id`);
    if (profiles.has(profile.id)) errors.push(`${profile._file}: duplicate profile ${profile.id}`);
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
  errors.push(...validateRegistry(buildRegistry(model, null)));
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
    if (value.state === "history") continue;
    if (!domainIds.has(value.id) || value.kind !== "domain" || typeof value.owner !== "string")
      errors.push(`${relative(REPO_ROOT, entry.path)}: invalid domain frontmatter identity`);
    if ("contracts" in value)
      errors.push(
        `${relative(REPO_ROOT, entry.path)}: domain relationships belong in project/domains, not Markdown frontmatter`
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
  if (entry.value?.state === "history") return;
  for (const link of parseMarkdown(entry.source, entry.path).links) {
    try {
      const target = resolveLocalReference(REPO_ROOT, entry.path, link.target);
      if (target && !exactPathExists(REPO_ROOT, target))
        errors.push(`${relative(REPO_ROOT, entry.path)}:${link.line}: broken link ${link.target}`);
    } catch (error) {
      errors.push(`${entry.path}: ${error.message}`);
    }
  }
}

function hasDecisionFile(id) {
  if (!/^ADR-\d{4}$/u.test(id ?? "")) return false;
  const prefix = id.slice(4).toLowerCase();
  return readdirSync(resolve(REPO_ROOT, "docs/adr"), { withFileTypes: true }).some(
    (entry) => entry.isFile() && entry.name.toLowerCase().startsWith(prefix) && entry.name.endsWith(".md")
  );
}

function normalizeCaseEntry(item) {
  const { _file, _lab, schemaVersion, ...rest } = item;
  return { ...rest, lab: rest.lab ?? Boolean(_lab), automatic: rest.automatic ?? !_lab };
}

export function buildRegistry(model, legacyRegistry) {
  const profiles = Object.fromEntries(
    model.profiles.map(({ _file, schemaVersion, ...profile }) => [profile.id, profile])
  );
  const workloads = Object.fromEntries(
    model.workloads.map(({ _file, schemaVersion, ...workload }) => [workload.id, workload])
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
      generatorVersion: 1
    }
  };
}

export async function writeGeneratedRegistry(registry) {
  await mkdir(dirname(GENERATED_REGISTRY), { recursive: true });
  const content = canonicalJsonText(registry);
  await writeFile(GENERATED_REGISTRY, content, "utf8");
  return { path: GENERATED_REGISTRY, bytes: Buffer.byteLength(content), sha256: sha256(content) };
}

export async function checkGeneratedRegistry(registry, path = GENERATED_REGISTRY) {
  const expected = canonicalJsonText(registry);
  const actual = existsSync(path) ? await readFile(path, "utf8") : null;
  return {
    ok: actual === expected,
    path,
    sha256: actual === null ? null : sha256(actual),
    expectedSha256: sha256(expected),
    reason:
      actual === null
        ? "registry missing; use registry --write"
        : actual === expected
          ? null
          : "registry drift; use registry --write after reviewing inputs"
  };
}

export function validateGeneratedRegistry(registry) {
  return validateRegistry(registry);
}

export function matchingDomains(model, paths) {
  return model.domains.filter((domain) =>
    paths.some((path) => domain.paths.some((pattern) => pathMatches(path, pattern)))
  );
}

export function matchingCases(model, paths) {
  return model.cases.filter((item) =>
    paths.some((path) => item.changedPaths.some((pattern) => pathMatches(path, pattern)))
  );
}

export function getChangedPaths(baseRevision) {
  const output = execFileSync("git", ["status", "--short", "--untracked-files=all", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8"
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
      encoding: "utf8"
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

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJsonText(value) {
  return `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;
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
