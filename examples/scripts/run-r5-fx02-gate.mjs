import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  captureGitBuildProvenance,
  evaluateBuildProvenance
} from "./r5-fx01-gate-contract.mjs";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const playwrightRoot = path.join(repoRoot, "temp/browser-tools/node_modules/playwright-core");
const currentBuild = captureGitBuildProvenance(repoRoot);
const requireClean = process.env.FX02_REQUIRE_CLEAN !== "0";
const profile = process.env.FX02_PROFILE === "smoke" ? "smoke" : "full";
const artifactId = currentBuild.dirty
  ? `${currentBuild.commit}-dirty-${currentBuild.contentHash.slice(0, 12)}`
  : currentBuild.commit;
const outputRoot = path.join(repoRoot, "temp/r5/fx-02", artifactId, profile);
const baseUrl = process.env.OENGINE_EXAMPLES_URL ?? "http://127.0.0.1:5174";
const chromePath = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const counts = [0, 1, 16, 64, 256, 1024];
const cases = [
  ...counts.flatMap((count) => ["spread", "overlap"].map((layout) => ({ kind: "point", count, layout, role: "sweep" }))),
  { kind: "spot", count: 1, layout: "overlap", role: "micro" },
  { kind: "directional", count: 0, layout: "spread", role: "micro" },
  { kind: "directional", count: 1, layout: "spread", role: "micro" }
];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
if (!existsSync(path.join(playwrightRoot, "index.mjs"))) throw new Error("Missing playwright-core under temp/browser-tools");
const playwright = await import(pathToFileURL(path.join(playwrightRoot, "index.mjs")).href);
const { PNG } = require(path.join(playwrightRoot, "lib/utilsBundle.js"));
const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"] });
const runs = [];
try {
  for (const item of cases) {
    const id = `${item.kind}-${item.count}-${item.layout}`;
    const runRoot = path.join(outputRoot, id);
    await mkdir(runRoot, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const consoleMessages = [];
    const pageErrors = [];
    page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
    const caseProfile = item.role === "micro" ? "smoke" : profile;
    const micro = runs.length === 0 ? "&micro=1" : "";
    const url = `${baseUrl}/r5-clustered-direct/?count=${item.count}&layout=${item.layout}&kind=${item.kind}&profile=${caseProfile}${micro}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(() => window.__OENGINE_FX_02_RESULT__?.completed === true, undefined, { timeout: 600_000 });
    const result = await page.evaluate(() => window.__OENGINE_FX_02_RESULT__);
    const screenshotPath = path.join(runRoot, "canvas.png");
    await page.locator("#gpu-canvas").screenshot({ path: screenshotPath });
    const screenshot = await screenshotEvidence(screenshotPath, PNG);
    const build = evaluateBuildProvenance(result.build, currentBuild);
    const consoleErrors = consoleMessages.filter((message) => message.type === "error");
    const issues = [
      ...result.issues,
      ...(result.passed ? [] : ["page Gate failed"]),
      ...build.issues,
      ...(consoleErrors.length === 0 ? [] : [`console errors: ${consoleErrors.length}`]),
      ...(pageErrors.length === 0 ? [] : [`page errors: ${pageErrors.length}`]),
      ...(screenshot.bytes > 1024 ? [] : ["empty canvas screenshot"])
    ];
    const run = { id, ...item, profile: caseProfile, url, passed: issues.length === 0, issues, build, statistics: result.statistics, diagnostics: result.result.diagnostics, screenshot, consoleMessages, pageErrors };
    await writeJson(path.join(runRoot, "artifact.json"), { result, run });
    runs.push(run);
    await context.close();
  }
} finally {
  await browser.close();
}

const overlap = new Map(runs.filter((run) => run.kind === "point" && run.layout === "overlap").map((run) => [run.count, run]));
const referenceLuma = overlap.get(128)?.screenshot.centerLuma ?? overlap.get(64)?.screenshot.centerLuma ?? 0;
const pressureIssues = [];
for (const count of [256, 1024]) {
  const run = overlap.get(count);
  if (run && referenceLuma > 0 && run.screenshot.centerLuma < referenceLuma * 0.7) pressureIssues.push(`${count} overlap center luminance dropped below conservative fallback tolerance`);
}
const cleanEligible = !currentBuild.dirty;
const gate = {
  schemaVersion: 1,
  taskId: "FX-02",
  profile,
  passed: runs.every((run) => run.passed) && pressureIssues.length === 0 && (!requireClean || cleanEligible),
  gateEligible: cleanEligible && runs.every((run) => run.build.passed),
  cleanEligible,
  requireClean,
  issues: [...runs.flatMap((run) => run.issues.map((issue) => `${run.id}: ${issue}`)), ...pressureIssues, ...(!requireClean || cleanEligible ? [] : ["clean Gate requested with a dirty worktree"])]
};
await writeJson(path.join(outputRoot, "result.json"), { gate, runs });
await writeJson(path.join(outputRoot, "environment.json"), { commit: currentBuild.commit, dirty: currentBuild.dirty, contentHash: currentBuild.contentHash, browser: browser.version(), chromePath, capturedAt: new Date().toISOString() });
process.stdout.write(`${JSON.stringify({ gate, outputRoot }, null, 2)}\n`);
if (!gate.passed) process.exitCode = 1;

async function screenshotEvidence(filePath, PNG) {
  const bytes = await readFile(filePath);
  const png = PNG.sync.read(bytes);
  const x0 = Math.floor(png.width * 0.4);
  const x1 = Math.floor(png.width * 0.6);
  const y0 = Math.floor(png.height * 0.35);
  const y1 = Math.floor(png.height * 0.65);
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const offset = (y * png.width + x) * 4;
    sum += png.data[offset] * 0.2126 + png.data[offset + 1] * 0.7152 + png.data[offset + 2] * 0.0722;
    count++;
  }
  return { bytes: bytes.length, width: png.width, height: png.height, centerLuma: count === 0 ? 0 : sum / count, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function writeJson(filePath, value) { await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
