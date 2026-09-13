import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { requireValidArtifact } from "../shared/artifact.mjs";
import { canonicalJson, requireValidRegistry } from "../shared/registry.mjs";

const validationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(validationRoot, "..");
const registryPath = resolve(validationRoot, "cases/registry.json");
const registryBytes = await readFile(registryPath);
const registry = requireValidRegistry(JSON.parse(registryBytes.toString("utf8")));
const caseId = process.argv[2];
const selectedCase = registry.cases.find((item) => item.id === caseId);
if (!selectedCase) {
  throw new Error(`Unknown case '${caseId ?? ""}'. Expected one of: ${registry.cases.map(({ id }) => id).join(", ")}`);
}
const profile = registry.profiles[selectedCase.profile];
const workload = registry.workloads[selectedCase.workloadId];
const chromeExecutable = process.env.OENGINE_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
if (!existsSync(chromeExecutable)) throw new Error(`Chrome stable executable not found: ${chromeExecutable}`);

const runnerStartedAt = new Date().toISOString();
const runId = `${runnerStartedAt.replaceAll(/[:.]/gu, "-")}-${caseId}-${randomUUID()}`;
const nonce = randomBytes(24).toString("hex");
const registrySha256 = sha256(registryBytes);
const workloadSha256 = sha256(canonicalJson(workload));
const artifactsRoot = resolve(validationRoot, "artifacts");
const runDirectory = resolve(artifactsRoot, runId);
await mkdir(artifactsRoot, { recursive: true });
await mkdir(runDirectory, { recursive: false });

const events = [];
const record = (source, detail) => events.push({ at: new Date().toISOString(), source, detail });
const git = (...args) => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const tree = git("rev-parse", "HEAD^{tree}");
const dirty = git("status", "--porcelain").length > 0;
const hostBuildId = await computeHostBuildId({ commit, tree, dirty, selectedCase, workload });

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "HEAD" });
      if (response.ok) return;
      lastError = new Error(`health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Vite health check timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

const viteEntry = resolve(validationRoot, "node_modules/vite/bin/vite.js");
const server = spawn(process.execPath, [viteEntry, "--host", "127.0.0.1", "--port", "4178", "--strictPort"], {
  cwd: validationRoot,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
server.stdout.on("data", (chunk) => record("vite:stdout", String(chunk).trim()));
server.stderr.on("data", (chunk) => record("vite:stderr", String(chunk).trim()));
server.on("exit", (code, signal) => record("vite:exit", { code, signal }));

let browser;
let context;
let page;
let pageSnapshot = null;
let userAgent = "unavailable";
let browserVersion = "unavailable";
let navigationCount = 0;
let runnerError;
let fatalBrowserEvents = [];
const producedArtifacts = [];

try {
  const baseUrl = "http://127.0.0.1:4178";
  await waitForServer(`${baseUrl}${selectedCase.route}`, 15000);
  browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: !profile.headed,
    args: ["--enable-features=Vulkan,UseSkiaRenderer", "--enable-unsafe-webgpu"]
  });
  browserVersion = browser.version();
  record("browser:launch", { version: browserVersion, headed: profile.headed, channel: profile.browserChannel });
  browser.on("disconnected", () => record("browser:disconnected", {}));
  context = await browser.newContext({
    viewport: { width: profile.viewport[0], height: profile.viewport[1] },
    deviceScaleFactor: profile.deviceScaleFactor,
    serviceWorkers: "block"
  });
  page = await context.newPage();
  page.on("console", (message) => record(`console:${message.type()}`, message.text()));
  page.on("pageerror", (error) => record("page:error", error.message));
  page.on("requestfailed", (request) => record("request:failed", { url: request.url(), failure: request.failure()?.errorText }));
  page.on("response", (response) => {
    if (response.status() >= 400) record("response:error", { url: response.url(), status: response.status() });
  });
  page.on("crash", () => record("page:crash", {}));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigationCount++;
  });

  const url = new URL(selectedCase.route, baseUrl);
  url.searchParams.set("runId", runId);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("registrySha256", registrySha256);
  url.searchParams.set("workloadSha256", workloadSha256);
  url.searchParams.set("hostBuildId", hostBuildId);
  const response = await page.goto(url.href, { waitUntil: "load", timeout: selectedCase.timeoutMs });
  if (!response?.ok()) throw new Error(`Navigation failed with status ${response?.status() ?? "none"}`);
  userAgent = await page.evaluate(() => navigator.userAgent);
  await page.waitForFunction(
    () => ["passed", "failed", "unsupported"].includes(window.__OENGINE_VALIDATION__?.outcome ?? ""),
    undefined,
    { timeout: selectedCase.timeoutMs }
  );
  const preliminary = await readPageSnapshot(page);
  assertPageIdentity(preliminary);
  if (navigationCount !== 1 || preliminary.navigationCount !== 1) throw new Error("Validation page reloaded or navigated more than once");
  assertFreshTimes(preliminary);

  if (selectedCase.artifacts.includes("screenshot")) {
    const screenshotPath = resolve(runDirectory, "screenshot.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    producedArtifacts.push({ kind: "screenshot", path: "screenshot.png" });
  }
  await page.evaluate(async () => window.__OENGINE_VALIDATION__?.dispose());
  await page.waitForFunction(() => window.__OENGINE_VALIDATION__?.state === "disposed", undefined, { timeout: 5000 });
  pageSnapshot = await readPageSnapshot(page);
  assertPageIdentity(pageSnapshot);
  if (pageSnapshot.state !== "disposed" || !pageSnapshot.disposedAt || !pageSnapshot.disposeEvidence) {
    throw new Error("Validation case did not publish complete dispose evidence");
  }
  fatalBrowserEvents = events.filter(isFatalBrowserEvent).filter((event) => !isAllowlisted(event));
  if (fatalBrowserEvents.length > 0) throw new Error(`Browser emitted ${fatalBrowserEvents.length} unallowlisted error event(s)`);
  if (pageSnapshot.outcome === "passed" && pageSnapshot.errors.length > 0) {
    throw new Error("Passed page contains validation errors");
  }
} catch (error) {
  runnerError = error instanceof Error ? error : new Error(String(error));
  record("runner:error", runnerError.message);
  if (page && !page.isClosed()) {
    try {
      await page.evaluate(async () => window.__OENGINE_VALIDATION__?.dispose());
      pageSnapshot = await readPageSnapshot(page);
    } catch (disposeError) {
      record("cleanup:page-dispose", String(disposeError));
    }
  }
} finally {
  await page?.close().catch((error) => record("cleanup:page", String(error)));
  await context?.close().catch((error) => record("cleanup:context", String(error)));
  await browser?.close().catch((error) => record("cleanup:browser", String(error)));
  if (!server.killed) server.kill();
  await Promise.race([
    new Promise((resolvePromise) => server.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 3000))
  ]);
}

const eventsPath = resolve(runDirectory, "events.json");
await writeFile(eventsPath, `${JSON.stringify(events, null, 2)}\n`, "utf8");
producedArtifacts.push({ kind: "events", path: "events.json" });
const artifactManifest = [];
for (const artifact of producedArtifacts) {
  const absolutePath = resolve(runDirectory, artifact.path);
  artifactManifest.push({
    ...artifact,
    bytes: (await stat(absolutePath)).size,
    sha256: await sha256File(absolutePath)
  });
}
artifactManifest.sort((left, right) => left.path.localeCompare(right.path));

const identityPassed = pageSnapshot !== null &&
  pageSnapshot.runId === runId && pageSnapshot.nonce === nonce &&
  pageSnapshot.caseId === selectedCase.id && pageSnapshot.workloadId === selectedCase.workloadId &&
  pageSnapshot.registrySha256 === registrySha256 && pageSnapshot.workloadSha256 === workloadSha256 &&
  pageSnapshot.hostBuildId === hostBuildId;
const freshnessPassed = identityPassed && pageSnapshot.navigationCount === 1 && navigationCount === 1 && areFreshTimes(pageSnapshot);
const disposedPassed = pageSnapshot?.state === "disposed" && pageSnapshot.disposedAt !== undefined && pageSnapshot.disposeEvidence !== undefined;
const pageOutcomePassed = pageSnapshot !== null && ["passed", "unsupported"].includes(pageSnapshot.outcome ?? "");
const browserErrorsPassed = fatalBrowserEvents.length === 0;
const artifactKinds = new Set(artifactManifest.map(({ kind }) => kind));
const artifactsPassed = selectedCase.artifacts.filter((kind) => kind !== "result").every((kind) => artifactKinds.has(kind));
const allHostGatesPassed = freshnessPassed && identityPassed && browserErrorsPassed && pageOutcomePassed && disposedPassed && artifactsPassed;
const status = runnerError || !allHostGatesPassed
  ? "failed"
  : pageSnapshot.outcome;
const result = {
  schemaVersion: 1,
  runId,
  nonce,
  caseId: selectedCase.id,
  workloadId: selectedCase.workloadId,
  registrySha256,
  workloadSha256,
  status,
  evidenceStatus: !dirty && status === "passed" ? "accepted" : "diagnostic-only",
  provenance: {
    commit,
    tree,
    dirty,
    hostBuildId,
    browserExecutable: chromeExecutable,
    browserExecutableSha256: await sha256File(chromeExecutable),
    browserVersion,
    userAgent,
    startedAt: runnerStartedAt,
    completedAt: new Date().toISOString()
  },
  page: pageSnapshot,
  events,
  artifactManifest,
  gate: {
    freshness: freshnessPassed,
    identity: identityPassed,
    browserErrors: browserErrorsPassed,
    pageOutcome: pageOutcomePassed,
    disposed: disposedPassed,
    artifacts: artifactsPassed
  }
};
requireValidArtifact(result, selectedCase);
await writeFile(resolve(runDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ runId, caseId, status: result.status, evidenceStatus: result.evidenceStatus, artifact: runDirectory }, null, 2));
if (result.status === "failed") {
  console.error(runnerError?.stack ?? "Validation failed");
  process.exitCode = 1;
} else if (result.status === "unsupported") {
  process.exitCode = 2;
}

function assertPageIdentity(snapshot) {
  if (!snapshot) throw new Error("Validation protocol was not installed");
  if (snapshot.schemaVersion !== registry.hostProtocolVersion) throw new Error("Protocol version mismatch");
  if (snapshot.runId !== runId || snapshot.nonce !== nonce) throw new Error("Stale or replayed validation result");
  if (snapshot.caseId !== selectedCase.id || snapshot.workloadId !== selectedCase.workloadId) throw new Error("Case/workload identity mismatch");
  if (snapshot.registrySha256 !== registrySha256 || snapshot.workloadSha256 !== workloadSha256 || snapshot.hostBuildId !== hostBuildId) {
    throw new Error("Registry/workload/build content identity mismatch");
  }
}

function assertFreshTimes(snapshot) {
  if (!areFreshTimes(snapshot)) throw new Error("Validation page timestamps are stale or out of order");
}

function areFreshTimes(snapshot) {
  const runnerStart = Date.parse(runnerStartedAt);
  const pageStart = Date.parse(snapshot?.startedAt ?? "");
  const pageComplete = Date.parse(snapshot?.completedAt ?? "");
  return Number.isFinite(pageStart) && Number.isFinite(pageComplete) &&
    pageStart >= runnerStart - 2000 && pageComplete >= pageStart && pageComplete <= Date.now() + 2000;
}

async function readPageSnapshot(targetPage) {
  return targetPage.evaluate(() => {
    const value = window.__OENGINE_VALIDATION__;
    if (!value) return null;
    return {
      schemaVersion: value.schemaVersion,
      caseId: value.caseId,
      workloadId: value.workloadId,
      runId: value.runId,
      nonce: value.nonce,
      registrySha256: value.registrySha256,
      workloadSha256: value.workloadSha256,
      hostBuildId: value.hostBuildId,
      documentId: value.documentId,
      navigationCount: value.navigationCount,
      state: value.state,
      outcome: value.outcome,
      startedAt: value.startedAt,
      completedAt: value.completedAt,
      disposedAt: value.disposedAt,
      phases: value.phases,
      evidence: value.evidence,
      errors: value.errors,
      disposeEvidence: value.disposeEvidence
    };
  });
}

function isFatalBrowserEvent(event) {
  return new Set(["page:error", "request:failed", "response:error", "page:crash", "console:error", "console:warning", "console:warn"]).has(event.source);
}

function isAllowlisted(event) {
  return (selectedCase.errorAllowlist ?? []).some((rule) => rule.source === event.source && rule.exact === event.detail);
}

async function computeHostBuildId(input) {
  const hash = createHash("sha256");
  hash.update(canonicalJson(input));
  const paths = await listHostFiles(validationRoot);
  for (const path of paths) {
    hash.update(relative(validationRoot, path).replaceAll("\\", "/"));
    hash.update(await readFile(path));
  }
  return hash.digest("hex");
}

async function listHostFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ["artifacts", "dist", "node_modules"].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(root);
  return files.sort();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
