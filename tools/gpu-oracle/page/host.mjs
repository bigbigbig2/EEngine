// Browser-side half of the Tier 2 GPU oracle harness.
//
// Responsibilities, in order: acquire a REAL GPUAdapter/GPUDevice, load the
// requested oracle module, run its exported entry with that device, and publish
// a JSON report on `window.__GPU_ORACLE__` for the Node side to read.
//
// Real GPU work is the whole point, so GPU-level failures are first-class: the
// run happens inside device error scopes, `uncapturederror` and `device.lost`
// are recorded, and any captured GPU error marks the run failed even when the
// oracle's own assertions passed. A fake device would hide exactly those.

const params = new URLSearchParams(location.search);
const oracleName = params.get("oracle") ?? "unknown";
const modulePath = params.get("module");
const exportName = params.get("export");
const hostBuildId = params.get("hostBuildId") ?? "unknown";

const statusElement = document.getElementById("gpu-oracle-status");

function publish(report) {
  window.__GPU_ORACLE__ = { state: "done", json: JSON.stringify(report) };
  if (statusElement) statusElement.textContent = `gpu-oracle host: ${report.status} (${report.oracle})`;
}

// Boot marker so the Node side can distinguish "page never started" from a
// module-resolution failure.
window.__GPU_ORACLE__ = { state: "boot" };

/** JSON-safe projection: oracle summaries are open-ended, and BigInt/typed arrays must not break reporting. */
function toJsonSafe(value, depth = 0, seen = new Set()) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "undefined") return "[undefined]";
  if (type === "boolean" || type === "string") return value;
  if (type === "number") return Number.isFinite(value) ? value : `[${String(value)}]`;
  if (type === "bigint") return `${value}n`;
  if (type === "symbol" || type === "function") return `[${type}]`;
  if (depth >= 8) return "[depth-limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (value instanceof Error) return { name: value.name, message: value.message };
    if (ArrayBuffer.isView(value)) {
      const limit = Math.min(value.length ?? 0, 256);
      const head = Array.from(value.slice ? value.slice(0, limit) : value).map((entry) =>
        toJsonSafe(entry, depth + 1, seen),
      );
      return {
        typedArray: value.constructor.name,
        length: value.length ?? null,
        head,
        truncated: (value.length ?? 0) > limit,
      };
    }
    if (Array.isArray(value)) {
      const limit = Math.min(value.length, 4096);
      const entries = value.slice(0, limit).map((entry) => toJsonSafe(entry, depth + 1, seen));
      if (value.length > limit) entries.push(`[+${value.length - limit} more]`);
      return entries;
    }
    if (value instanceof Map)
      return Object.fromEntries(
        [...value].map(([key, entry]) => [String(key), toJsonSafe(entry, depth + 1, seen)]),
      );
    if (value instanceof Set) return [...value].map((entry) => toJsonSafe(entry, depth + 1, seen));
    if (value instanceof Date) return value.toISOString();
    const record = {};
    for (const key of Object.keys(value)) record[key] = toJsonSafe(value[key], depth + 1, seen);
    return record;
  } finally {
    seen.delete(value);
  }
}

function describeError(error) {
  if (error instanceof Error) {
    return {
      kind: "assertion-or-throw",
      name: error.name,
      code: error.code ?? null,
      message: error.message,
      stack: error.stack ?? null,
    };
  }
  return { kind: "throw-non-error", name: typeof error, message: String(error), stack: null };
}

/**
 * Loads the oracle module.
 *
 * Two specifier classes need help in a browser and neither is the oracle's
 * fault:
 *
 *   - `node:assert/strict`, which the oracles use. The import map in host.html
 *     is the primary route; if the host does not apply an import-map key with
 *     the `node:` scheme, the retry asks the static server to rewrite it.
 *   - Bare package specifiers such as `gl-matrix`, kept in the compiled output
 *     because the engine builds with `moduleResolution: Bundler`. The two
 *     virtual-geometry oracles reach these through the production owners, and a
 *     browser has no resolver for them.
 *
 * The trigger is deliberately the generic "Failed to resolve module specifier"
 * rather than a fixed list of package names: the server owns which specifiers it
 * can vendor, and a name list duplicated here would silently go stale. If the
 * server cannot map a specifier it answers 404 with the name, which is a far
 * clearer failure than an unexplained resolution error.
 */
async function loadOracleModule(modulePath, noteMode) {
  try {
    const module = await import(modulePath);
    noteMode("import-map");
    return module;
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!/Failed to resolve module specifier|node:assert|assert-strict/.test(message)) throw error;
    const separator = modulePath.includes("?") ? "&" : "?";
    const module = await import(`${modulePath}${separator}gpuOracleShim=1`);
    noteMode("server-rewrite");
    return module;
  }
}

function classifyAdapter(info) {
  const haystack =
    `${info?.architecture ?? ""} ${info?.device ?? ""} ${info?.description ?? ""} ${info?.vendor ?? ""}`.toLowerCase();
  if (info?.isFallbackAdapter === true) return "software-fallback";
  if (/swiftshader|basic render|lavapipe|llvmpipe|microsoft basic/.test(haystack)) return "software";
  return "hardware";
}

async function readAdapterInfo(adapter) {
  // `adapter.info` is the current API; requestAdapterInfo() is the older one.
  if (adapter.info) {
    return {
      vendor: adapter.info.vendor ?? "",
      architecture: adapter.info.architecture ?? "",
      device: adapter.info.device ?? "",
      description: adapter.info.description ?? "",
      isFallbackAdapter: adapter.info.isFallbackAdapter ?? null,
      subgroupMinSize: adapter.info.subgroupMinSize ?? null,
      subgroupMaxSize: adapter.info.subgroupMaxSize ?? null,
    };
  }
  if (typeof adapter.requestAdapterInfo === "function") {
    const legacy = await adapter.requestAdapterInfo();
    return { ...legacy, isFallbackAdapter: legacy.isFallbackAdapter ?? null };
  }
  return null;
}

async function run() {
  const startedAt = performance.now();
  const report = {
    oracle: oracleName,
    hostBuildId,
    status: "failed",
    failureKind: null,
    summary: null,
    error: null,
    adapter: null,
    adapterKind: null,
    device: null,
    deviceLost: null,
    gpuErrors: [],
    scopedGpuErrors: [],
    environment: { userAgent: navigator.userAgent, webgpuExposed: Boolean(navigator.gpu) },
    assertShimMode: null,
    timings: { oracleMs: null, runMs: null },
  };
  if (!modulePath || !exportName)
    throw new Error("host page requires both `module` and `export` query parameters");
  if (!navigator.gpu) {
    report.failureKind = "no-webgpu";
    report.error = {
      kind: "environment",
      name: "Error",
      code: null,
      message: "navigator.gpu is unavailable in this browser/profile",
      stack: null,
    };
    return report;
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    report.failureKind = "no-adapter";
    report.error = {
      kind: "environment",
      name: "Error",
      code: null,
      message: "navigator.gpu.requestAdapter() returned null",
      stack: null,
    };
    return report;
  }
  report.adapter = await readAdapterInfo(adapter);
  report.adapterKind = classifyAdapter(report.adapter);
  const device = await adapter.requestDevice();
  report.device = {
    features: [...device.features].map(String).sort(),
    limits: {
      maxComputeWorkgroupSizeX: device.limits.maxComputeWorkgroupSizeX,
      maxComputeInvocationsPerWorkgroup: device.limits.maxComputeInvocationsPerWorkgroup,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
    },
  };
  report.environment.wgslLanguageFeatures = [...navigator.gpu.wgslLanguageFeatures].map(String).sort();

  let deviceLost = null;
  device.lost.then((info) => {
    deviceLost = { reason: info.reason, message: info.message };
  });
  const uncaptured = [];
  const onUncaptured = (event) => uncaptured.push({ message: event.error?.message ?? String(event.error) });
  device.addEventListener("uncapturederror", onUncaptured);

  let summary = null;
  let failure = null;
  let assertShimMode = "import-map";
  device.pushErrorScope("internal");
  device.pushErrorScope("out-of-memory");
  device.pushErrorScope("validation");
  const oracleStartedAt = performance.now();
  try {
    const module = await loadOracleModule(modulePath, (mode) => {
      assertShimMode = mode;
    });
    const entry = module[exportName];
    if (typeof entry !== "function") {
      throw new Error(
        `module ${modulePath} does not export a function named ${exportName}; exports: ${Object.keys(module).join(", ")}`,
      );
    }
    summary = await entry(device);
  } catch (error) {
    failure = describeError(error);
  }
  report.assertShimMode = assertShimMode;
  report.timings.oracleMs = Math.round((performance.now() - oracleStartedAt) * 1000) / 1000;
  const scoped = [];
  for (const scope of ["validation", "out-of-memory", "internal"]) {
    try {
      const error = await device.popErrorScope();
      if (error) scoped.push({ scope, message: error.message });
    } catch (error) {
      scoped.push({ scope, message: `popErrorScope failed: ${error?.message ?? String(error)}` });
    }
  }
  device.removeEventListener("uncapturederror", onUncaptured);
  report.scopedGpuErrors = scoped;
  report.gpuErrors = uncaptured;
  if (deviceLost && deviceLost.reason !== "destroyed") report.deviceLost = deviceLost;
  report.summary = toJsonSafe(summary);
  report.error = failure;
  if (failure) {
    report.failureKind = failure.name === "AssertionError" ? "assertion" : "oracle-throw";
  } else if (scoped.length > 0 || uncaptured.length > 0) {
    report.failureKind = "gpu-error";
    report.error = {
      kind: "gpu",
      name: "GPUError",
      code: null,
      message: [
        ...scoped.map((entry) => `${entry.scope}: ${entry.message}`),
        ...uncaptured.map((entry) => `uncaptured: ${entry.message}`),
      ].join(" | "),
      stack: null,
    };
  } else if (report.deviceLost) {
    report.failureKind = "device-lost";
    report.error = {
      kind: "device-lost",
      name: "GPUDeviceLostInfo",
      code: null,
      message: `${report.deviceLost.reason}: ${report.deviceLost.message}`,
      stack: null,
    };
  }
  report.status = report.failureKind === null ? "passed" : "failed";
  report.timings.runMs = Math.round((performance.now() - startedAt) * 1000) / 1000;
  device.destroy();
  return report;
}

try {
  publish(await run());
} catch (error) {
  publish({
    oracle: oracleName,
    hostBuildId,
    status: "failed",
    failureKind: "host-crash",
    summary: null,
    error: describeError(error),
    adapter: null,
    adapterKind: null,
    device: null,
    deviceLost: null,
    gpuErrors: [],
    scopedGpuErrors: [],
    environment: { userAgent: navigator.userAgent, webgpuExposed: Boolean(navigator.gpu) },
    assertShimMode: null,
    timings: { oracleMs: null, runMs: null },
  });
}
