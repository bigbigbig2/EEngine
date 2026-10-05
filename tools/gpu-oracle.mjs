#!/usr/bin/env node
// Tier 2 GPU oracle harness for the EEngine WebGPU renderer.
//
//   node tools/gpu-oracle.mjs <oracle-name> [--json] [--keep-open]
//
// Every Mocha/node --test coverage of this repository runs against a fake
// WebGPU device, and three real-GPU oracles under OEngine/tests/oracle/ are
// never imported by any test because `node --test` cannot supply a GPUDevice.
// This harness supplies a real one: it serves the oracle modules (unmodified)
// plus OEngine/.test-dist over loopback, launches Chrome stable through
// playwright-core, runs the registered oracle against a real GPUAdapter/
// GPUDevice inside device error scopes, and reports the oracle's own summary.
//
// Registry: tools/gpu-oracle/registry.mjs. Adding an oracle is one entry there.
//
// Exit codes: 0 oracle passed, 1 oracle failed or the run could not complete,
// 2 CLI usage error (unknown flag or unknown oracle name).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { explainChromeLog, launchChrome } from "./gpu-oracle/browser.mjs";
import { findOracle, oracles } from "./gpu-oracle/registry.mjs";
import { defaultAllowPrefixes, startStaticServer } from "./gpu-oracle/server.mjs";

const harnessRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(harnessRoot, "..");
const harnessModuleRoot = join(harnessRoot, "gpu-oracle");
const startedAt = Date.now();

const USAGE = `EEngine Tier 2 real-GPU oracle harness

Usage:
  node tools/gpu-oracle.mjs <oracle-name> [options]
  node tools/gpu-oracle.mjs --list

Options:
  --json            print one machine-readable JSON report on stdout
  --keep-open       leave Chrome open after the run (implies --headed)
  --headed          launch Chrome with a visible window
  --headless        force a headless launch (default)
  --transport <t>   auto (default), launch (playwright pipe) or cdp (spawn + attach)
  --timeout <ms>    override the registry timeout for the selected oracle
  --verbose         always print browser console output, not only on failure
  --list            list registered oracles
  --help            show this message

Registered oracles:
${oracles.map((oracle) => `  ${oracle.name.padEnd(34)} ${oracle.description}`).join("\n")}
`;

function parseArguments(argv) {
  const options = {
    json: false,
    keepOpen: false,
    headed: false,
    headless: false,
    verbose: false,
    list: false,
    help: false,
    timeoutMs: null,
    transport: "auto",
    name: null,
  };
  const errors = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--keep-open") options.keepOpen = true;
    else if (argument === "--headed") options.headed = true;
    else if (argument === "--headless") options.headless = true;
    else if (argument === "--verbose") options.verbose = true;
    else if (argument === "--list") options.list = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--transport") {
      const value = argv[++index];
      if (value === "auto" || value === "launch" || value === "cdp") options.transport = value;
      else errors.push(`--transport expects auto, launch or cdp (got ${value ?? "nothing"})`);
    } else if (argument === "--timeout") {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value <= 0)
        errors.push("--timeout requires a positive millisecond value");
      else options.timeoutMs = value;
    } else if (argument.startsWith("--")) errors.push(`unknown flag ${argument}`);
    else if (options.name === null) options.name = argument;
    else errors.push(`unexpected extra argument ${argument}`);
  }
  return { options, errors };
}

/** playwright-core is a validation/ devDependency (ADR-0014 host); resolve it explicitly instead of adding a root dependency. */
function loadPlaywrightChromium() {
  const requireFromValidation = createRequire(
    pathToFileURL(join(repositoryRoot, "validation", "package.json")),
  );
  const { chromium } = requireFromValidation("playwright-core");
  if (!chromium?.launch) throw new Error("playwright-core resolved but exports no chromium.launch");
  return chromium;
}

function resolveChromeExecutable() {
  const candidates = [
    process.env.OENGINE_CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found)
    throw new Error(
      `Chrome stable executable not found. Tried: ${candidates.join(", ")}. Set OENGINE_CHROME_PATH to override.`,
    );
  return found;
}

async function computeHostBuildId() {
  const hash = createHash("sha256");
  for (const file of [
    "gpu-oracle.mjs",
    "gpu-oracle/registry.mjs",
    "gpu-oracle/server.mjs",
    "gpu-oracle/page/host.html",
    "gpu-oracle/page/host.mjs",
    "gpu-oracle/page/assert-strict.mjs",
  ]) {
    hash.update(await readFile(join(harnessRoot, file)));
  }
  return hash.digest("hex").slice(0, 12);
}

function printReport(report, { json, consoleLines }) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const label = report.status === "passed" ? "PASS" : "FAIL";
  const lines = [
    `gpu-oracle ${report.oracle}: ${label}${report.failureKind ? ` (${report.failureKind})` : ""}`,
  ];
  if (report.registry?.negativeControl)
    lines.push(`  negative control  expected to FAIL; a pass here would mean the harness is blind`);
  lines.push(`  module            ${report.oracleFile}`);
  lines.push(
    `  chrome            ${report.chrome.version ?? "unknown"} @ ${report.chrome.executablePath} (${report.chrome.headless ? "headless" : "headed"}, transport ${report.chrome.transport}${report.chrome.contextMode ? `, ${report.chrome.contextMode}` : ""})`,
  );
  for (const attempt of report.chrome.launchAttempts ?? []) {
    lines.push(
      `  launch attempt    ${attempt.transport}: ${attempt.ok ? "ok" : `failed — ${String(attempt.message).split("\n")[0]}`}`,
    );
  }
  if (report.adapter)
    lines.push(
      `  adapter           ${[report.adapter.vendor, report.adapter.architecture, report.adapter.device, report.adapter.description].filter(Boolean).join(" / ") || "unknown"} (${report.adapterKind})`,
    );
  if (report.deviceLost)
    lines.push(`  device lost       ${report.deviceLost.reason}: ${report.deviceLost.message}`);
  if (report.summary !== null && report.summary !== undefined)
    lines.push(`  summary           ${JSON.stringify(report.summary)}`);
  for (const [kind, entries] of [
    ["scoped GPU error", report.scopedGpuErrors],
    ["uncaptured GPU error", report.gpuErrors],
  ]) {
    for (const entry of entries ?? []) lines.push(`  ${kind}   ${entry.message}`);
  }
  if (report.error) {
    const errorLines = String(report.error.message).split("\n");
    lines.push(
      `  error             ${report.error.name}: ${errorLines.slice(0, 3).join("\n                    ")}`,
    );
    if (errorLines.length > 3)
      lines.push(
        `                    [...${errorLines.length - 3} more lines; use --json for the full text]`,
      );
  }
  lines.push(
    `  timing            oracle ${report.timings.oracleMs ?? "n/a"} ms | wall ${report.timings.totalMs} ms`,
  );
  lines.push(`  harness build     ${report.hostBuildId}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  if (consoleLines.length > 0) {
    process.stdout.write(
      `  browser console (${consoleLines.length} message${consoleLines.length === 1 ? "" : "s"}):\n`,
    );
    for (const line of consoleLines) process.stdout.write(`    [${line.type}] ${line.text}\n`);
  }
  for (const error of report.pageErrors ?? [])
    process.stdout.write(`  page error        ${error.name}: ${error.message}\n`);
  for (const hint of report.chrome.environmentHints ?? [])
    process.stdout.write(`  environment       ${hint}\n`);
  if (report.chrome.processLog) {
    process.stdout.write(
      `  chrome process log (tail):\n${report.chrome.processLog
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n")}\n`,
    );
  }
}

const { options, errors } = parseArguments(process.argv.slice(2));
if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n\n${USAGE}`);
  process.exit(2);
}
if (options.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (options.list) {
  for (const oracle of oracles) {
    process.stdout.write(
      `${oracle.name}\n  file        ${oracle.file}\n  entry       ${oracle.entry}(device)\n  description ${oracle.description}\n${oracle.note ? `  note        ${oracle.note}\n` : ""}`,
    );
  }
  process.exit(0);
}
if (options.name === null) {
  process.stderr.write(`Missing oracle name.\n\n${USAGE}`);
  process.exit(2);
}
const oracle = findOracle(options.name);
if (!oracle) {
  process.stderr.write(
    `Unknown oracle '${options.name}'. Registered: ${oracles.map((entry) => entry.name).join(", ")}\n`,
  );
  process.exit(2);
}

const hostBuildId = await computeHostBuildId();
const timeoutMs = options.timeoutMs ?? oracle.timeoutMs ?? 180_000;
const chromeExecutable = resolveChromeExecutable();
// --keep-open is a debugging affordance, so it defaults to a visible window;
// an explicit --headless still wins.
const headless = options.headed ? false : options.keepOpen ? options.headless : true;
const consoleLines = [];
const pageErrors = [];
const failedRequests = [];
let chromeVersion = null;
let chromeLaunchMs = 0;
let chromeEndpoint = null;
let chromeLogPath = null;
let chromeTransport = null;
let chromeContextMode = null;
let lastChromeLog = null;
const chromeLaunchAttempts = [];
let environmentHints = [];
let navigationMs = 0;
let staticRequests = [];
const negativeControl = oracle.negativeControl === true;

/** Single exit path: close Chrome, the CDP connection and the server even when the oracle threw. */
let page;
let context;
let browser;
let chromeProcess;
let server;
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    // chromeProcess.close() kills the spawned Chrome tree and removes its
    // throwaway profile; browser.close() alone only drops the CDP socket.
    if (chromeProcess) await chromeProcess.close();
    else await browser?.close();
  } catch {}
  try {
    await server?.close();
  } catch {}
}
process.on("SIGINT", () => {
  void cleanup().then(() => process.exit(130));
});

/** Base envelope for a report; the oracle payload is merged in by the caller. */
function buildEnvelope({ status, failureKind, payload, error, runFailure }) {
  const report = {
    tool: "gpu-oracle",
    toolVersion: 1,
    hostBuildId,
    buildIdentity,
    oracleSha256,
    oracle: oracle.name,
    oracleFile: oracle.file,
    oracleEntry: oracle.entry,
    registry: { description: oracle.description, note: oracle.note ?? null, negativeControl },
    status,
    failureKind: failureKind ?? null,
    summary: payload?.summary ?? null,
    error: error ?? payload?.error ?? null,
    adapter: payload?.adapter ?? null,
    adapterKind: payload?.adapterKind ?? null,
    device: payload?.device ?? null,
    deviceLost: payload?.deviceLost ?? null,
    gpuErrors: payload?.gpuErrors ?? [],
    scopedGpuErrors: payload?.scopedGpuErrors ?? [],
    environment: payload?.environment ?? null,
    timings: {
      oracleMs: payload?.timings?.oracleMs ?? null,
      browserLaunchMs: chromeLaunchMs,
      navigationMs,
      totalMs: Date.now() - startedAt,
    },
    chrome: {
      executablePath: chromeExecutable,
      version: chromeVersion,
      headless,
      transport: chromeTransport ?? options.transport,
      contextMode: chromeContextMode,
      launchAttempts: chromeLaunchAttempts,
      endpoint: chromeEndpoint,
      args: chromeProcess?.chromeArgs ?? null,
      processLogPath: chromeLogPath,
      processLog: chromeProcess?.readChromeLog() || lastChromeLog,
      environmentHints,
    },
    staticRequests: staticRequests.filter((path) => path.endsWith(".mjs") || path.endsWith(".js")),
    console: consoleLines,
    pageErrors,
    failedRequests,
    runFailure: runFailure ?? null,
  };
  return report;
}

let report;
let buildIdentity = null;
const oracleSha256 = createHash("sha256")
  .update(await readFile(join(repositoryRoot, oracle.file)))
  .digest("hex");
try {
  if (!existsSync(join(repositoryRoot, oracle.file))) {
    throw new Error(
      `oracle module not found: ${oracle.file} (this file must exist in the repository tree; the harness never builds it)`,
    );
  }
  if (oracle.file.startsWith("OEngine/") || negativeControl) {
    const { verifyTestBuild } = await import("./test-build.mjs");
    buildIdentity = await verifyTestBuild(repositoryRoot);
  }
  staticRequests = [];
  server = await startStaticServer({
    root: repositoryRoot,
    harnessRoot: harnessModuleRoot,
    allowPrefixes: [...defaultAllowPrefixes, ...(oracle.allowPrefixes ?? [])],
    // Where bare specifiers such as `gl-matrix` are served from. Read from the
    // engine's own install so the oracle runs against the exact dependency the
    // production code links, not a copy.
    vendorRoots: [join(repositoryRoot, "OEngine", "node_modules"), join(repositoryRoot, "node_modules")],
  });
  const chromium = loadPlaywrightChromium();
  const launchStartedAt = Date.now();
  // Same GPU configuration as the ADR-0014 validation host
  // (validation/src/runner/run-case.mjs) and the same chrome-stable target as
  // validation/playwright.config.ts. tools/gpu-oracle/browser.mjs picks the
  // transport: playwright-core's own launch(), or a pipe-free CDP attach where
  // the sandbox forbids piped child stdio.
  const launched = await launchChrome({
    chromium,
    executablePath: chromeExecutable,
    headless,
    transport: options.transport,
    extraArgs: ["--enable-features=Vulkan,UseSkiaRenderer", "--enable-unsafe-webgpu"],
    onAttempt: (attempt) => chromeLaunchAttempts.push(attempt),
  });
  chromeLaunchMs = Date.now() - launchStartedAt;
  chromeVersion = launched.chromeVersion;
  chromeEndpoint = launched.endpoint ?? null;
  chromeLogPath = launched.chromeLogPath ?? null;
  chromeTransport = launched.transport;
  chromeContextMode = launched.contextMode;
  browser = launched.browser;
  context = launched.context;
  page = launched.page;
  chromeProcess = launched;
  page.on("console", (message) => {
    if (consoleLines.length < 2000) consoleLines.push({ type: message.type(), text: message.text() });
  });
  page.on("pageerror", (error) =>
    pageErrors.push({ name: error.name, message: error.message, stack: error.stack ?? null }),
  );
  page.on("requestfailed", (request) =>
    failedRequests.push({ url: request.url(), failure: request.failure()?.errorText ?? null }),
  );
  page.on("crash", () =>
    pageErrors.push({ name: "PageCrash", message: "renderer process crashed", stack: null }),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      failedRequests.push({ url: response.url(), failure: `HTTP ${response.status()}` });
  });

  const url = new URL("/__gpu-oracle/page/host.html", server.origin);
  url.searchParams.set("oracle", oracle.name);
  url.searchParams.set("module", oracle.url);
  url.searchParams.set("export", oracle.entry);
  url.searchParams.set("hostBuildId", hostBuildId);
  url.searchParams.set("features", JSON.stringify(oracle.requiredFeatures ?? []));
  url.searchParams.set("limits", JSON.stringify(oracle.requiredLimits ?? {}));
  const navigationStartedAt = Date.now();
  const response = await page.goto(url.href, { waitUntil: "load", timeout: Math.min(60_000, timeoutMs) });
  if (!response?.ok())
    throw new Error(`host page navigation failed with status ${response?.status() ?? "no response"}`);
  await page.waitForFunction(() => window.__GPU_ORACLE__?.state === "done", undefined, {
    timeout: timeoutMs,
  });
  navigationMs = Date.now() - navigationStartedAt;
  const serialized = await page.evaluate(() => window.__GPU_ORACLE__.json);
  const payload = JSON.parse(serialized);
  staticRequests = [...server.requests];
  if (buildIdentity) {
    const { verifyTestBuild } = await import("./test-build.mjs");
    await verifyTestBuild(repositoryRoot);
  }
  if (
    oracleSha256 !==
    createHash("sha256")
      .update(await readFile(join(repositoryRoot, oracle.file)))
      .digest("hex")
  ) {
    throw new Error("oracle source changed during GPU execution");
  }
  const moduleServed = staticRequests.some((path) => path === new URL(oracle.url, server.origin).pathname);
  const status = payload.status === "passed" && moduleServed ? "passed" : "failed";
  const runFailure = !moduleServed
    ? `oracle module ${oracle.url} was never fetched by the page; imports may not have resolved`
    : null;
  report = buildEnvelope({
    status,
    failureKind: runFailure ? "module-not-loaded" : payload.failureKind,
    payload,
    error: runFailure ? { name: "HarnessError", message: runFailure, stack: null } : payload.error,
    runFailure,
  });
} catch (error) {
  // A launch failure carries Chrome's own process log; that log is the only
  // place a blocked environment explains itself.
  for (const attempt of error?.attempts ?? []) {
    if (attempt.chromeProcessLog) lastChromeLog = attempt.chromeProcessLog;
  }
  if (error?.chromeProcessLog) lastChromeLog = error.chromeProcessLog;
  environmentHints = explainChromeLog(lastChromeLog) ?? [];
  const timedOut = error?.name === "TimeoutError";
  const isLaunchFailure = chromeLaunchAttempts.some((attempt) => attempt.ok === false);
  report = buildEnvelope({
    status: "failed",
    failureKind: timedOut
      ? "timeout"
      : environmentHints.length > 0
        ? "environment-blocked"
        : isLaunchFailure
          ? "chrome-launch-failed"
          : "harness-error",
    payload: null,
    error: {
      name: error?.name ?? "Error",
      message: error?.message ?? String(error),
      stack: error?.stack ?? null,
    },
    runFailure: timedOut ? `oracle did not finish within ${timeoutMs} ms` : null,
  });
} finally {
  // Reporting and cleanup run below, so --keep-open can show the report first.
}

try {
  printReport(report, {
    json: options.json,
    consoleLines: report.status === "passed" && !options.verbose ? [] : consoleLines,
  });
  if (options.keepOpen && page && !page.isClosed()) {
    process.stdout.write(
      `\n--keep-open: Chrome left open; close the window to exit. Host page: ${page.url()}\n`,
    );
    await new Promise((resolvePromise) => {
      chromeProcess?.onProcessExit(resolvePromise);
      browser?.once("disconnected", resolvePromise);
      setTimeout(resolvePromise, 3_600_000).unref?.();
    });
  }
} finally {
  await cleanup();
}
process.exitCode = report.status === "passed" ? 0 : 1;
// Let stdout drain, but never hang on a lingering playwright driver handle.
const exitGuard = setTimeout(() => process.exit(process.exitCode), 1500);
exitGuard.unref();
