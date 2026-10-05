// Executable contract check for the parts of the GPU oracle harness that do not
// need a working Chrome: the assert shim's semantics, the static server's
// serving/allowed-path contract, and the host page's report contract.
//
// Run: node tools/gpu-oracle/self-test/host-contract-check.mjs
//
// It is deliberately NOT named *.test.mjs so repo-wide `node --test` discovery
// never picks it up; run it explicitly.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nodeAssert from "node:assert/strict";
import assertShim, { AssertionError as ShimAssertionError } from "../page/assert-strict.mjs";
import { startStaticServer } from "../server.mjs";

const selfTestRoot = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(selfTestRoot, "..");
const repositoryRoot = resolve(harnessRoot, "../..");

let failures = 0;
let checks = 0;
function check(name, condition, detail = "") {
  checks++;
  if (condition) {
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failures++;
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ""}\n`);
  }
}

function headline(title) {
  process.stdout.write(`\n${title}\n`);
}

// ---------------------------------------------------------------------------
// 1. assert shim: differential behaviour against node:assert/strict.
//    The oracles under OEngine/tests/oracle/ are run unmodified in the browser,
//    so a shim that accepts something node's assert rejects (or vice versa)
//    would silently change what the oracles prove.
// ---------------------------------------------------------------------------
headline("assert shim vs node:assert/strict");
const cases = [
  ["ok(true)", (assert) => assert.ok(true)],
  ["ok(false)", (assert) => assert.ok(false)],
  ["ok(false, message)", (assert) => assert.ok(false, "custom message")],
  ["equal(1, 1)", (assert) => assert.equal(1, 1)],
  ["equal(1, '1')", (assert) => assert.equal(1, "1")],
  ["equal(NaN, NaN)", (assert) => assert.equal(NaN, NaN)],
  ["deepEqual arrays equal", (assert) => assert.deepEqual([1, 2, 3], [1, 2, 3])],
  ["deepEqual arrays differ", (assert) => assert.deepEqual([1, 2, 3], [1, 2, 4])],
  ["deepEqual length differ", (assert) => assert.deepEqual([1, 2], [1, 2, 3])],
  ["deepEqual nested records", (assert) => assert.deepEqual([1, [2, { a: 3 }]], [1, [2, { a: 3 }]])],
  ["deepEqual nested mismatch", (assert) => assert.deepEqual({ a: { b: 1 } }, { a: { b: 2 } })],
  [
    "deepEqual Uint32Array equal",
    (assert) => assert.deepEqual(new Uint32Array([1, 2]), new Uint32Array([1, 2])),
  ],
  [
    "deepEqual Uint32Array differ",
    (assert) => assert.deepEqual(new Uint32Array([1, 2]), new Uint32Array([1, 3])),
  ],
  ["deepEqual mixed types", (assert) => assert.deepEqual(new Uint32Array([1, 2]), [1, 2])],
  ["notDeepEqual differing", (assert) => assert.notDeepEqual([1], [2])],
  ["notDeepEqual equal", (assert) => assert.notDeepEqual([1], [1])],
  ["strictEqual(+0, -0)", (assert) => assert.strictEqual(0, -0)],
  ["notStrictEqual(1, 1)", (assert) => assert.notStrictEqual(1, 1)],
];
for (const [name, operation] of cases) {
  const outcome = (assert) => {
    try {
      operation(assert);
      return { threw: false };
    } catch (error) {
      return {
        threw: true,
        name: error.name,
        isAssertionError: error instanceof nodeAssert.AssertionError || error.name === "AssertionError",
        message: error.message,
      };
    }
  };
  const expected = outcome(nodeAssert);
  const actual = outcome(assertShim);
  const same =
    expected.threw === actual.threw &&
    (!expected.threw || expected.isAssertionError === actual.isAssertionError);
  check(
    `behaviour matches node:assert/strict: ${name}`,
    same,
    `node=${JSON.stringify(expected)} shim=${JSON.stringify(actual)}`,
  );
}
try {
  assertShim.ok(false, "shim message survives");
  check("shim preserves the assertion message", false, "no throw");
} catch (error) {
  check(
    "shim preserves the assertion message",
    error.message.includes("shim message") && error instanceof ShimAssertionError,
    error.message,
  );
}
let unsupportedThrew = false;
try {
  assertShim.throws(() => {});
} catch {
  unsupportedThrew = true;
}
check("unimplemented shim methods fail loudly instead of passing silently", unsupportedThrew);

// ---------------------------------------------------------------------------
// 2. Static server: the exact URLs the browser needs, and the paths it must
//    refuse. OEngine/.test-dist is a dot-directory, so serving it on purpose is
//    part of the contract.
// ---------------------------------------------------------------------------
headline("static server contract");
const server = await startStaticServer({
  root: repositoryRoot,
  harnessRoot,
  allowPrefixes: ["OEngine/tests/", "OEngine/.test-dist/"],
});
const fetchPath = async (path) => {
  const response = await fetch(new URL(path, server.origin));
  const body = await response.text();
  return { status: response.status, contentType: response.headers.get("content-type"), body };
};
try {
  const host = await fetchPath("/__gpu-oracle/page/host.html");
  check(
    "serves the host page as HTML",
    host.status === 200 && host.contentType.startsWith("text/html") && host.body.includes("importmap"),
    JSON.stringify(host).slice(0, 200),
  );
  const shim = await fetchPath("/__gpu-oracle/page/assert-strict.mjs");
  check(
    "serves the assert shim as JavaScript",
    shim.status === 200 && shim.contentType.startsWith("text/javascript"),
    JSON.stringify(shim).slice(0, 200),
  );
  const oracle = await fetchPath("/OEngine/tests/oracle/hzb-conservative-gpu.mjs");
  check(
    // The server rewrites module specifiers unconditionally, so this module is
    // served with `node:assert/strict` already pointing at the shim. The earlier
    // assertion here expected the byte-identical file and became false the
    // moment the rewrite stopped being gated behind a query flag — which had to
    // change, because a module reached through a relative import never receives
    // that flag. What matters is that the module body and its relative imports
    // are intact and only the shim specifier moved.
    "serves the real oracle module with only its assert specifier rewritten",
    oracle.status === 200 &&
      oracle.body.includes("runConservativeHzbGpuOracle") &&
      oracle.body.includes('from "/__gpu-oracle/page/assert-strict.mjs"') &&
      oracle.body.includes('"../../.test-dist/shaders/hzb_reduce.js"'),
    JSON.stringify(oracle).slice(0, 200),
  );
  const compiled = await fetchPath("/OEngine/.test-dist/shaders/hzb_reduce.js");
  check(
    "serves compiled .test-dist modules from the dot-directory",
    compiled.status === 200 && compiled.body.includes("HZB_REDUCE_COMPUTE_WGSL"),
    JSON.stringify(compiled).slice(0, 200),
  );
  const nested = await fetchPath("/OEngine/.test-dist/render/HzbReference.js");
  check(
    "serves nested .test-dist modules",
    nested.status === 200 && nested.body.includes("buildHzbReference"),
    JSON.stringify(nested).slice(0, 200),
  );
  const negativeControl = await fetchPath("/__gpu-oracle/self-test/hzb-conservative-wrong-kernel.mjs");
  check(
    "serves harness self-test fixtures",
    negativeControl.status === 200 && negativeControl.body.includes("runWrongKernelHzbOracle"),
    JSON.stringify(negativeControl).slice(0, 200),
  );
  const engineSource = await fetchPath("/OEngine/src/index.ts");
  check(
    "refuses paths outside the allowlist (OEngine/src)",
    engineSource.status === 403,
    String(engineSource.status),
  );
  const toolsRegistry = await fetchPath("/tools/gpu-oracle/registry.mjs");
  check(
    "refuses paths outside the allowlist (tools/)",
    toolsRegistry.status === 403,
    String(toolsRegistry.status),
  );
  const traversal = await fetchPath("/OEngine/tests/../../package.json");
  check(
    "refuses traversal into the repository root",
    traversal.status === 400 || traversal.status === 403,
    String(traversal.status),
  );
  const encodedTraversal = await fetchPath("/OEngine/tests/%2e%2e/%2e%2e/package.json");
  check(
    "refuses percent-encoded traversal",
    encodedTraversal.status === 400 || encodedTraversal.status === 403,
    String(encodedTraversal.status),
  );
  const missing = await fetchPath("/OEngine/tests/oracle/does-not-exist.mjs");
  check("404s unknown files inside the allowlist", missing.status === 404, String(missing.status));
  // Rewriting is unconditional, not gated behind a query flag. A module reached
  // through a relative import never carries that flag, which is what left the
  // two virtual-geometry oracles unable to load `gl-matrix`. Both routes are
  // therefore expected to rewrite the specifier and preserve relative imports.
  const rewritten = await fetchPath("/OEngine/tests/oracle/hzb-conservative-gpu.mjs?gpuOracleShim=1");
  check(
    "assert specifier is rewritten while relative imports are preserved",
    rewritten.status === 200 &&
      rewritten.body.includes('from "/__gpu-oracle/page/assert-strict.mjs"') &&
      rewritten.body.includes('"../../.test-dist/shaders/hzb_reduce.js"'),
    JSON.stringify(rewritten).slice(0, 240),
  );
  const defaultRoute = await fetchPath("/OEngine/tests/oracle/hzb-conservative-gpu.mjs");
  check(
    "default route applies the same rewrite (no query flag required)",
    defaultRoute.status === 200 &&
      defaultRoute.body.includes('from "/__gpu-oracle/page/assert-strict.mjs"') &&
      !defaultRoute.body.includes('from "node:assert'),
    JSON.stringify(defaultRoute).slice(0, 200),
  );
  // The rewrite must not touch specifier-looking text inside strings or regex
  // literals. An earlier version replaced every occurrence of `node:assert`,
  // which corrupted a regex in page/host.mjs into a syntax error and was only
  // visible as a page timeout.
  const hostPage = await fetchPath("/__gpu-oracle/page/host.mjs");
  check(
    "rewrite leaves regex and string contents alone",
    hostPage.status === 200 && hostPage.body.includes("/Failed to resolve module specifier|node:assert"),
    JSON.stringify(hostPage.body.slice(0, 200)),
  );
} finally {
  await server.close();
}

// ---------------------------------------------------------------------------
// 3. Host page report contract, driven in Node with stub globals and a stub
//    device. This is a plumbing check, NOT GPU evidence: it proves that the
//    page-side runner reports passes and failures with the right shape so the
//    CLI can turn them into exit codes.
// ---------------------------------------------------------------------------
headline("host page report contract (stub device; plumbing only)");

function stubDevice({ gpuError = null, lost = null } = {}) {
  const scopes = [gpuError ? { message: gpuError } : null, null, null];
  return {
    features: new Set(["stub-feature"]),
    limits: {
      maxComputeWorkgroupSizeX: 256,
      maxComputeInvocationsPerWorkgroup: 256,
      maxStorageBufferBindingSize: 1 << 27,
    },
    lost: new Promise((resolvePromise) => {
      if (lost) resolvePromise(lost);
    }),
    addEventListener() {},
    removeEventListener() {},
    pushErrorScope() {},
    async popErrorScope() {
      return scopes.shift() ?? null;
    },
    destroy() {},
  };
}

function stubAdapter(device) {
  return {
    info: {
      vendor: "stub-vendor",
      architecture: "stub-arch",
      device: "stub-device",
      description: "stub",
      isFallbackAdapter: false,
    },
    async requestDevice() {
      return device;
    },
  };
}

async function runHostPage({ gpu, moduleUrl, entry, caseId }) {
  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    location: Object.getOwnPropertyDescriptor(globalThis, "location"),
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  };
  const define = (key, value) => {
    const descriptor = previous[key];
    if (descriptor && !descriptor.configurable)
      throw new Error(`cannot stub global ${key}: not configurable`);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  define("window", {});
  define("document", { getElementById: () => null });
  define("location", { search: `?oracle=contract&module=${encodeURIComponent(moduleUrl)}&export=${entry}` });
  define("navigator", gpu === undefined ? { userAgent: "stub" } : { userAgent: "stub", gpu });
  try {
    // Cache-bust so each case gets a fresh evaluation of the host module.
    await import(`${new URL("../page/host.mjs", import.meta.url).href}?case=${caseId}`);
    const serialized = globalThis.window.__GPU_ORACLE__?.json;
    return serialized ? JSON.parse(serialized) : null;
  } finally {
    for (const key of ["window", "document", "location", "navigator"]) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete globalThis[key];
    }
  }
}

const fixturesUrl = new URL("./host-contract-fixtures.mjs", import.meta.url).href;

const passing = await runHostPage({
  gpu: { wgslLanguageFeatures: new Set(), requestAdapter: async () => stubAdapter(stubDevice()) },
  moduleUrl: fixturesUrl,
  entry: "passFixture",
  caseId: "pass",
});
check(
  "passing oracle reports status=passed",
  passing?.status === "passed",
  JSON.stringify(passing)?.slice(0, 300),
);
check(
  "passing oracle carries the oracle summary",
  passing?.summary?.marker === 42,
  JSON.stringify(passing?.summary),
);
check(
  "passing oracle records the adapter identity",
  passing?.adapter?.vendor === "stub-vendor" && passing?.adapterKind === "hardware",
  JSON.stringify(passing?.adapter),
);

const throwing = await runHostPage({
  gpu: { wgslLanguageFeatures: new Set(), requestAdapter: async () => stubAdapter(stubDevice()) },
  moduleUrl: fixturesUrl,
  entry: "throwFixture",
  caseId: "throw",
});
check(
  "throwing oracle reports status=failed",
  throwing?.status === "failed",
  JSON.stringify(throwing)?.slice(0, 300),
);
check(
  "assertion failures are classified as assertions",
  throwing?.failureKind === "assertion" && throwing?.error?.name === "AssertionError",
  JSON.stringify(throwing?.error),
);
check(
  "assertion text survives to the report",
  String(throwing?.error?.message).includes("deliberate contract fixture failure"),
  String(throwing?.error?.message),
);

const gpuError = await runHostPage({
  gpu: {
    wgslLanguageFeatures: new Set(),
    requestAdapter: async () => stubAdapter(stubDevice({ gpuError: "stub validation error" })),
  },
  moduleUrl: fixturesUrl,
  entry: "passFixture",
  caseId: "gpu-error",
});
check(
  "a captured GPU error fails an otherwise passing oracle",
  gpuError?.status === "failed" && gpuError?.failureKind === "gpu-error",
  JSON.stringify(gpuError)?.slice(0, 300),
);
check(
  "captured GPU error text survives",
  JSON.stringify(gpuError?.scopedGpuErrors ?? []).includes("stub validation error"),
  JSON.stringify(gpuError?.scopedGpuErrors),
);

const noGpu = await runHostPage({
  gpu: undefined,
  moduleUrl: fixturesUrl,
  entry: "passFixture",
  caseId: "no-gpu",
});
check(
  "a browser without navigator.gpu reports failureKind=no-webgpu",
  noGpu?.failureKind === "no-webgpu",
  JSON.stringify(noGpu)?.slice(0, 200),
);

const noAdapter = await runHostPage({
  gpu: { wgslLanguageFeatures: new Set(), requestAdapter: async () => null },
  moduleUrl: fixturesUrl,
  entry: "passFixture",
  caseId: "no-adapter",
});
check(
  "a null adapter reports failureKind=no-adapter",
  noAdapter?.failureKind === "no-adapter",
  JSON.stringify(noAdapter)?.slice(0, 200),
);

const badExport = await runHostPage({
  gpu: { wgslLanguageFeatures: new Set(), requestAdapter: async () => stubAdapter(stubDevice()) },
  moduleUrl: fixturesUrl,
  entry: "missingFixture",
  caseId: "bad-export",
});
check(
  "a missing export is reported with the available exports",
  badExport?.status === "failed" &&
    String(badExport?.error?.message).includes("does not export a function named missingFixture"),
  String(badExport?.error?.message),
);

// ---------------------------------------------------------------------------
process.stdout.write(`\n${checks - failures}/${checks} contract checks passed\n`);
process.exitCode = failures === 0 ? 0 : 1;
