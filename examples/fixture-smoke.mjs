import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const rootUrl = process.env.OENGINE_FIXTURE_BASE_URL ?? "http://127.0.0.1:5173";
const headless = process.env.OENGINE_HEADLESS !== "false";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(repoRoot, "temp", "fixture-results");
const cases = [
  { id: "basic-scene", route: "/basic-scene/", bridge: "__OENGINE_BASIC_SCENE_FIXTURE__" },
  { id: "model-loading", route: "/model-loading/", bridge: "__OENGINE_MODEL_LOADING_FIXTURE__" },
  { id: "geometry-preprocess", route: "/geometry-preprocess/", bridge: "__OENGINE_GEOMETRY_PREPROCESS_FIXTURE__" }
];

await mkdir(outputDir, { recursive: true });
const chromeCandidates = [
  process.env.OENGINE_CHROME_PATH,
  process.env.ProgramFiles === undefined ? undefined : path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
  process.env.LOCALAPPDATA === undefined ? undefined : path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
].filter((candidate) => candidate !== undefined);
let chromeExecutable;
for (const candidate of chromeCandidates) {
  try {
    await access(candidate);
    chromeExecutable = candidate;
    break;
  } catch {
    // Try the next conventional Chrome installation path.
  }
}
const browser = await chromium.launch({
  headless,
  ...(chromeExecutable === undefined ? {} : { executablePath: chromeExecutable }),
  args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"]
});
const results = [];

try {
  for (const fixture of cases) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const requestFailures = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => requestFailures.push(`${request.url()} · ${request.failure()?.errorText ?? "unknown"}`));

    const startedAt = Date.now();
    let navigationError = null;
    try {
      await page.goto(`${rootUrl}${fixture.route}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForFunction(
        (bridgeName) => {
          const bridge = window[bridgeName];
          return bridge !== undefined && bridge.getSnapshot().status !== "booting";
        },
        fixture.bridge,
        { timeout: 30_000 }
      );
    } catch (error) {
      navigationError = error instanceof Error ? error.message : String(error);
    }

    const status = await page.locator("[data-fixture-status]").textContent().catch(() => null);
    const snapshot = await page.evaluate((bridgeName) => {
      const bridge = window[bridgeName];
      return bridge?.getSnapshot() ?? null;
    }, fixture.bridge).catch(() => null);
    const screenshotPath = path.join(outputDir, `${fixture.id}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    const result = {
      caseId: fixture.id,
      url: `${rootUrl}${fixture.route}`,
      elapsedMs: Date.now() - startedAt,
      status: snapshot?.status ?? (navigationError === null ? "no-bridge" : "navigation-error"),
      pageStatusText: status,
      snapshot,
      screenshot: screenshotPath,
      consoleErrors,
      pageErrors,
      requestFailures,
      navigationError
    };
    results.push(result);
    await writeFile(path.join(outputDir, `${fixture.id}.result.json`), `${JSON.stringify(result, null, 2)}\n`);
    await context.close();
  }
} finally {
  await browser.close();
}

const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  baseUrl: rootUrl,
  browser: chromeExecutable === undefined ? "playwright-chromium" : chromeExecutable,
  cases: results,
  readyCount: results.filter((result) => result.status === "ready").length,
  failedCount: results.filter((result) => result.status !== "ready").length
};
await writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
