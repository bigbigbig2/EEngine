const CASE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CLAIM_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/u;
const CASE_KINDS = new Set(["orchestration", "component", "internal-candidate", "production"]);
const VALIDATION_KINDS = new Set(["unit", "contract", "oracle", "guard", "gpu", "perf"]);
const LEVELS = new Set(["L0", "L1", "L2", "L3", "L4"]);
const ALLOWED_BUILD_TARGETS = new Set(["host", "baseline", "internal-candidate", "production"]);
const ALLOWED_ARTIFACTS = new Set(["result", "events", "screenshot", "readback", "trace", "samples"]);
const MAX_CASE_TIMEOUT_MS = 300_000;
const MAX_L4_PERF_TIMEOUT_MS = 1_800_000;

export function validateRegistry(registry) {
  const errors = [];
  if (registry?.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (registry?.hostProtocolVersion !== 1) errors.push("hostProtocolVersion must be 1");
  validateProfiles(registry?.profiles, errors);
  validateWorkloads(registry?.workloads, errors);
  if (!Array.isArray(registry?.cases) || registry.cases.length === 0) errors.push("cases must be non-empty");

  const ids = new Set();
  const routes = new Set();
  for (const item of registry?.cases ?? []) {
    if (!CASE_ID_PATTERN.test(item.id ?? "")) errors.push(`invalid case id: ${item.id ?? "<missing>"}`);
    if (ids.has(item.id)) errors.push(`duplicate case id: ${item.id}`);
    ids.add(item.id);
    if (typeof item.route !== "string" || !item.route.startsWith("/") || item.route.includes("backend=")) {
      errors.push(`${item.id}: invalid route or runtime backend switch`);
    }
    if (routes.has(item.route)) errors.push(`duplicate case route: ${item.route}`);
    routes.add(item.route);
    if (!CASE_KINDS.has(item.caseKind)) errors.push(`${item.id}: unknown caseKind`);
    if (!VALIDATION_KINDS.has(item.kind)) errors.push(`${item.id}: unknown validation kind`);
    if (!LEVELS.has(item.level)) errors.push(`${item.id}: unknown level`);
    if (!ALLOWED_BUILD_TARGETS.has(item.buildTarget)) errors.push(`${item.id}: unknown buildTarget`);
    if ((item.caseKind === "internal-candidate") !== (item.buildTarget === "internal-candidate")) {
      errors.push(`${item.id}: internal-candidate caseKind and buildTarget must agree`);
    }
    if (!/^ADR-\d{4}$/u.test(item.decision ?? "")) errors.push(`${item.id}: invalid decision`);
    if (item.lab !== undefined && typeof item.lab !== "boolean") errors.push(`${item.id}: lab must be boolean`);
    if (item.automatic !== undefined && typeof item.automatic !== "boolean") errors.push(`${item.id}: automatic must be boolean`);
    if (item.lab === true && item.automatic === true) errors.push(`${item.id}: lab cases cannot be automatic`);
    if (!new Set(["promotion", "diagnostic"]).has(item.evidenceRole)) errors.push(`${item.id}: invalid evidenceRole`);
    if (!Array.isArray(item.covers) || item.covers.some((id) => !CLAIM_ID_PATTERN.test(id))) {
      errors.push(`${item.id}: invalid covers`);
    }
    if (item.evidenceRole === "promotion" && item.covers?.length === 0) errors.push(`${item.id}: promotion case must cover a claim`);
    if (item.lab === true && item.evidenceRole !== "diagnostic") errors.push(`${item.id}: lab cases must be diagnostic`);
    if (typeof item.workloadId !== "string" || !registry?.workloads?.[item.workloadId]) errors.push(`${item.id}: missing or unknown workloadId`);
    if (!registry?.profiles?.[item.profile]) errors.push(`${item.id}: unknown profile`);
    const workload = registry?.workloads?.[item.workloadId];
    const profile = registry?.profiles?.[item.profile];
    if (workload && profile &&
        (workload.resolution[0] !== profile.viewport[0] || workload.resolution[1] !== profile.viewport[1] ||
         workload.deviceScaleFactor !== profile.deviceScaleFactor)) {
      errors.push(`${item.id}: workload resolution/DPR must match profile`);
    }
    const maxTimeoutMs = item.kind === "perf" && item.level === "L4" ? MAX_L4_PERF_TIMEOUT_MS : MAX_CASE_TIMEOUT_MS;
    if (!Number.isInteger(item.timeoutMs) || item.timeoutMs < 1000 || item.timeoutMs > maxTimeoutMs) errors.push(`${item.id}: timeout out of bounds`);
    if (!Array.isArray(item.artifacts) || !item.artifacts.includes("result") || item.artifacts.some((kind) => !ALLOWED_ARTIFACTS.has(kind))) {
      errors.push(`${item.id}: invalid artifact owners`);
    }
    if (!Array.isArray(item.changedPaths) || item.changedPaths.length === 0 || item.changedPaths.some((path) => typeof path !== "string" || path.startsWith("/") || path.includes(".."))) {
      errors.push(`${item.id}: invalid changedPaths`);
    }
    if (item.errorAllowlist !== undefined) {
      if (!Array.isArray(item.errorAllowlist)) errors.push(`${item.id}: errorAllowlist must be an array`);
      const exactRules = new Set();
      for (const rule of item.errorAllowlist ?? []) {
        if (typeof rule.source !== "string" || !rule.source.includes(":")) {
          errors.push(`${item.id}: error allowlist must name an exact event source`);
        }
        if (typeof rule.exact !== "string" || rule.exact.length < 8 || /[.*+?^${}()|[\]\\]/u.test(rule.exact.slice(0, 2)) ||
            typeof rule.reason !== "string" || rule.reason.length < 8 || !CLAIM_ID_PATTERN.test(rule.ownerClaim ?? "")) {
          errors.push(`${item.id}: error allowlist must use exact text, reason, and owner claim`);
        }
        const ruleKey = `${rule.source}\u0000${rule.exact}`;
        if (exactRules.has(ruleKey)) errors.push(`${item.id}: duplicate error allowlist rule`);
        exactRules.add(ruleKey);
        if (!item.covers?.includes(rule.ownerClaim)) {
          errors.push(`${item.id}: error allowlist owner must be a case claim`);
        }
      }
    }
  }
  return errors;
}

function validateProfiles(profiles, errors) {
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles) || Object.keys(profiles).length === 0) {
    errors.push("profiles must be a non-empty object");
    return;
  }
  for (const [id, profile] of Object.entries(profiles)) {
    if (!CASE_ID_PATTERN.test(id)) errors.push(`invalid profile id: ${id}`);
    if (typeof profile?.headed !== "boolean") errors.push(`${id}: headed must be boolean`);
    if (!isExtent(profile?.viewport)) errors.push(`${id}: viewport must be two positive integers`);
    if (!Number.isFinite(profile?.deviceScaleFactor) || profile.deviceScaleFactor <= 0) errors.push(`${id}: invalid deviceScaleFactor`);
    if (profile?.browserChannel !== "chrome-stable") errors.push(`${id}: browserChannel must be chrome-stable`);
  }
}

function validateWorkloads(workloads, errors) {
  if (!workloads || typeof workloads !== "object" || Array.isArray(workloads) || Object.keys(workloads).length === 0) {
    errors.push("workloads must be a non-empty object");
    return;
  }
  for (const [id, workload] of Object.entries(workloads)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*-v\d+$/u.test(id)) errors.push(`invalid workload id: ${id}`);
    if (!isExtent(workload?.resolution)) errors.push(`${id}: resolution must be two positive integers`);
    if (!Number.isFinite(workload?.deviceScaleFactor) || workload.deviceScaleFactor <= 0) errors.push(`${id}: invalid deviceScaleFactor`);
    if (!Number.isFinite(workload?.renderScale) || workload.renderScale <= 0 || workload.renderScale > 1) errors.push(`${id}: invalid renderScale`);
    if (typeof workload?.quality !== "string" || workload.quality.length < 3) errors.push(`${id}: invalid quality`);
    if (!Array.isArray(workload?.features) || workload.features.some((value) => typeof value !== "string")) errors.push(`${id}: invalid features`);
    if (!Number.isSafeInteger(workload?.seed) || workload.seed < 0) errors.push(`${id}: invalid seed`);
    if (typeof workload?.cameraPath !== "string" || workload.cameraPath.length === 0) errors.push(`${id}: invalid cameraPath`);
    for (const field of ["warmupFrames", "sampleFrames", "sampleCadence", "independentRuns"]) {
      if (!Number.isSafeInteger(workload?.[field]) || workload[field] <= 0) errors.push(`${id}: invalid ${field}`);
    }
    if (typeof workload?.timestampRequired !== "boolean") errors.push(`${id}: timestampRequired must be boolean`);
  }
}

function isExtent(value) {
  return Array.isArray(value) && value.length === 2 && value.every((item) => Number.isSafeInteger(item) && item > 0);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function requireValidRegistry(registry) {
  const errors = validateRegistry(registry);
  if (errors.length > 0) throw new Error(`Invalid validation registry:\n${errors.join("\n")}`);
  return registry;
}
