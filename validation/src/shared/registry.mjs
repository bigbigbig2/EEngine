const CASE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const REQUIREMENT_PATTERN = /^[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+$/u;
const ALLOWED_KINDS = new Set(["orchestration", "component", "internal-candidate", "production"]);
const ALLOWED_BUILD_TARGETS = new Set(["host", "baseline", "internal-candidate", "production"]);
const ALLOWED_ARTIFACTS = new Set(["result", "events", "screenshot", "readback", "trace", "samples"]);
const ALLOWED_LAYERS = new Set(["L0", "L1", "L2", "L3", "L4", "L5", "L6"]);

export function validateRegistry(registry) {
  const errors = [];
  if (registry?.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (registry?.hostProtocolVersion !== 1) errors.push("hostProtocolVersion must be 1");
  validateRequirements(registry?.requirements, errors);
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
    if (!ALLOWED_KINDS.has(item.kind)) errors.push(`${item.id}: unknown kind`);
    if (!ALLOWED_BUILD_TARGETS.has(item.buildTarget)) errors.push(`${item.id}: unknown buildTarget`);
    if ((item.kind === "internal-candidate") !== (item.buildTarget === "internal-candidate")) {
      errors.push(`${item.id}: internal-candidate kind and buildTarget must agree`);
    }
    if (!/^ADR-\d{4}$/u.test(item.ownerAdr ?? "")) errors.push(`${item.id}: invalid ownerAdr`);
    if (!Array.isArray(item.requirements) || item.requirements.length === 0 || item.requirements.some((id) => !REQUIREMENT_PATTERN.test(id))) {
      errors.push(`${item.id}: invalid requirements`);
    }
    for (const requirementId of item.requirements ?? []) {
      const requirement = registry?.requirements?.[requirementId];
      if (!requirement) errors.push(`${item.id}: unknown requirement ${requirementId}`);
      else if (requirement.ownerAdr !== item.ownerAdr) errors.push(`${item.id}: requirement ${requirementId} owner mismatch`);
    }
    if (typeof item.workloadId !== "string" || !registry?.workloads?.[item.workloadId]) errors.push(`${item.id}: missing or unknown workloadId`);
    if (!registry?.profiles?.[item.profile]) errors.push(`${item.id}: unknown profile`);
    const workload = registry?.workloads?.[item.workloadId];
    const profile = registry?.profiles?.[item.profile];
    if (workload && profile &&
        (workload.resolution[0] !== profile.viewport[0] || workload.resolution[1] !== profile.viewport[1] ||
         workload.deviceScaleFactor !== profile.deviceScaleFactor)) {
      errors.push(`${item.id}: workload resolution/DPR must match profile`);
    }
    if (!Number.isInteger(item.timeoutMs) || item.timeoutMs < 1000 || item.timeoutMs > 300000) errors.push(`${item.id}: timeout out of bounds`);
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
            typeof rule.reason !== "string" || rule.reason.length < 8 || !REQUIREMENT_PATTERN.test(rule.ownerRequirement ?? "")) {
          errors.push(`${item.id}: error allowlist must use exact text, reason, and owner requirement`);
        }
        const ruleKey = `${rule.source}\u0000${rule.exact}`;
        if (exactRules.has(ruleKey)) errors.push(`${item.id}: duplicate error allowlist rule`);
        exactRules.add(ruleKey);
        if (!item.requirements?.includes(rule.ownerRequirement)) {
          errors.push(`${item.id}: error allowlist owner must be a case requirement`);
        }
      }
    }
  }
  return errors;
}

function validateRequirements(requirements, errors) {
  if (!requirements || typeof requirements !== "object" || Array.isArray(requirements) || Object.keys(requirements).length === 0) {
    errors.push("requirements must be a non-empty object");
    return;
  }
  for (const [id, requirement] of Object.entries(requirements)) {
    if (!REQUIREMENT_PATTERN.test(id)) errors.push(`invalid requirement id: ${id}`);
    if (!/^ADR-\d{4}$/u.test(requirement?.ownerAdr ?? "")) errors.push(`${id}: invalid requirement ownerAdr`);
    if (!ALLOWED_LAYERS.has(requirement?.layer)) errors.push(`${id}: invalid requirement layer`);
    if (typeof requirement?.description !== "string" || requirement.description.length < 8) {
      errors.push(`${id}: missing requirement description`);
    }
  }
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
