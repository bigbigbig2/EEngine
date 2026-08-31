import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureGitBuildProvenance, evaluateBuildProvenance } from "./r5-fx01-gate-contract.mjs";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const playwrightRoot = path.join(repoRoot, "temp/browser-tools/node_modules/playwright-core");
const currentBuild = captureGitBuildProvenance(repoRoot);
const artifactId = currentBuild.dirty
  ? `${currentBuild.commit}-dirty-${currentBuild.contentHash.slice(0, 12)}`
  : currentBuild.commit;
const outputRoot = path.join(repoRoot, "temp/r5/fx-03", artifactId);
const baseUrl = process.env.OENGINE_EXAMPLES_URL ?? "http://127.0.0.1:5174";
const chromePath = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const requireClean = process.env.FX03_REQUIRE_CLEAN !== "0";
const views = ["BaseColor", "Normal", "Roughness", "Metallic", "DiffuseIbl", "SpecularIbl", "LinearHdr", "FinalTonemapped"];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
if (!existsSync(path.join(playwrightRoot, "index.mjs"))) throw new Error("Missing playwright-core under temp/browser-tools");
const playwright = await import(pathToFileURL(path.join(playwrightRoot, "index.mjs")).href);
const { PNG } = require(path.join(playwrightRoot, "lib/utilsBundle.js"));
const browser = await playwright.chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"]
});
let pageResult;
const captures = [];
const consoleMessages = [];
const pageErrors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  await page.goto(`${baseUrl}/r5-shading-oracle/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => window.__OENGINE_FX_03_RESULT__?.completed === true, undefined, { timeout: 600_000 });
  pageResult = await page.evaluate(() => window.__OENGINE_FX_03_RESULT__);
  for (const view of views) {
    await page.evaluate(async (name) => window.__OENGINE_FX_03__.renderView(name), view);
    const file = path.join(outputRoot, `${view}.png`);
    await page.locator("#gpu-canvas").screenshot({ path: file });
    captures.push({ view, ...(await screenshotEvidence(file, PNG)) });
  }
  await context.close();
} finally {
  await browser.close();
}

const build = evaluateBuildProvenance(pageResult?.build, currentBuild);
const consoleErrors = consoleMessages.filter((message) => message.type === "error");
const imageIssues = captures.flatMap((capture) => [
  ...(capture.bytes > 1024 ? [] : [`${capture.view}: empty screenshot`]),
  ...(capture.standardDeviation > 0.5 ? [] : [`${capture.view}: screenshot has no visual variation`])
]);
const issues = [
  ...(pageResult?.issues ?? ["page result is missing"]),
  ...(pageResult?.passed ? [] : ["page Gate failed"]),
  ...build.issues,
  ...imageIssues,
  ...(consoleErrors.length ? [`console errors: ${consoleErrors.length}`] : []),
  ...(pageErrors.length ? [`page errors: ${pageErrors.length}`] : []),
  ...(!requireClean || !currentBuild.dirty ? [] : ["clean Gate requested with a dirty worktree"])
];
const gate = {
  schemaVersion: 1,
  taskId: "FX-03",
  passed: issues.length === 0,
  gateEligible: !currentBuild.dirty && build.passed,
  requireClean,
  issues
};
await writeJson(path.join(outputRoot, "artifact.json"), { gate, pageResult, captures, build, consoleMessages, pageErrors });
await writeJson(path.join(outputRoot, "result.json"), { gate, captures, statistics: pageResult?.statistics ?? null });
await writeJson(path.join(outputRoot, "environment.json"), { commit: currentBuild.commit, dirty: currentBuild.dirty, contentHash: currentBuild.contentHash, browser: browser.version(), chromePath, capturedAt: new Date().toISOString() });
process.stdout.write(`${JSON.stringify({ gate, outputRoot }, null, 2)}\n`);
if (!gate.passed) process.exitCode = 1;

async function screenshotEvidence(filePath, PNG) {
  const bytes = await readFile(filePath);
  const png = PNG.sync.read(bytes);
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 0; y < png.height; y += 2) for (let x = 0; x < png.width; x += 2) {
    const offset = (y * png.width + x) * 4;
    const luma = png.data[offset] * 0.2126 + png.data[offset + 1] * 0.7152 + png.data[offset + 2] * 0.0722;
    sum += luma; sumSquares += luma * luma; count++;
  }
  const meanLuma = sum / count;
  const standardDeviation = Math.sqrt(Math.max(0, sumSquares / count - meanLuma * meanLuma));
  return { bytes: bytes.length, width: png.width, height: png.height, meanLuma, standardDeviation, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
