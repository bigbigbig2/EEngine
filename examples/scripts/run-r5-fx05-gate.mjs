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
const artifactId = currentBuild.dirty
  ? `${currentBuild.commit}-dirty-${currentBuild.contentHash.slice(0, 12)}`
  : currentBuild.commit;
const outputRoot = path.join(repoRoot, "temp/r5/fx-05", artifactId);
const baseUrl = process.env.OENGINE_EXAMPLES_URL ?? "http://127.0.0.1:5174";
const chromePath = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const requireClean = process.env.FX05_REQUIRE_CLEAN !== "0";
const excludedReferenceDirtyReasons = currentBuild.dirtyReasons.filter(
  (reason) => /^M three\.js$/.test(reason)
);
const scopedDirtyReasons = currentBuild.dirtyReasons.filter(
  (reason) => !excludedReferenceDirtyReasons.includes(reason)
);
const cases = [
  { id: "coverage-0", coverage: 0, layers: 1, materials: 1, order: "forward" },
  { id: "coverage-10", coverage: 10, layers: 4, materials: 1, order: "forward" },
  { id: "coverage-50", coverage: 50, layers: 4, materials: 1, order: "forward" },
  ...[1, 4, 8, 16].map((layers) => ({
    id: `layers-${layers}`, coverage: 50, layers, materials: 1, order: "forward"
  })),
  ...[1, 8, 64].map((materials) => ({
    id: `materials-${materials}`, coverage: 50, layers: 1, materials, order: "forward"
  })),
  { id: "emissive-once", coverage: 50, layers: 1, materials: 1,
    order: "forward", mode: "emissive-probe" },
  { id: "order-forward", coverage: 50, layers: 4, materials: 1,
    order: "forward", mode: "order-probe" },
  { id: "order-reverse", coverage: 50, layers: 4, materials: 1,
    order: "reverse", mode: "order-probe" }
];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
if (!existsSync(path.join(playwrightRoot, "index.mjs"))) {
  throw new Error("Missing playwright-core under temp/browser-tools");
}
const playwright = await import(pathToFileURL(path.join(playwrightRoot, "index.mjs")).href);
const { PNG } = require(path.join(playwrightRoot, "lib/utilsBundle.js"));
const browser = await playwright.chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding"
  ]
});
const results = [];
try {
  for (const definition of cases) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 960 },
      deviceScaleFactor: 1
    });
    const page = await context.newPage();
    const consoleMessages = [];
    const pageErrors = [];
    page.on("console", (message) => consoleMessages.push({
      type: message.type(),
      text: message.text()
    }));
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
    const query = new URLSearchParams({
      coverage: String(definition.coverage),
      layers: String(definition.layers),
      materials: String(definition.materials),
      order: definition.order,
      mode: definition.mode ?? "standard"
    });
    await page.goto(`${baseUrl}/r5-packed-transparency/?${query}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    });
    await page.waitForFunction(
      () => window.__OENGINE_FX_05_RESULT__?.completed === true,
      undefined,
      { timeout: 600_000 }
    );
    const pageResult = await page.evaluate(() => window.__OENGINE_FX_05_RESULT__);
    const screenshotPath = path.join(outputRoot, `${definition.id}.png`);
    await page.locator("#gpu-canvas").screenshot({ path: screenshotPath });
    const screenshot = await screenshotEvidence(screenshotPath, PNG);
    results.push({
      definition,
      pageResult,
      screenshot,
      screenshotPath,
      consoleMessages,
      pageErrors
    });
    await context.close();
  }
} finally {
  await browser.close();
}

const firstBuild = results[0]?.pageResult?.build;
const build = evaluateBuildProvenance(firstBuild, currentBuild);
const imageIssues = results.flatMap((entry) => [
  ...(entry.screenshot.bytes > 1024 ? [] : [`${entry.definition.id}: empty screenshot`]),
  ...(entry.definition.coverage === 0 || entry.screenshot.standardDeviation > 0.5
    ? []
    : [`${entry.definition.id}: screenshot has no visual variation`])
]);
const caseIssues = results.flatMap((entry) => [
  ...(entry.pageResult?.issues ?? [`${entry.definition.id}: page result missing`])
    .map((issue) => `${entry.definition.id}: ${issue}`),
  ...(entry.pageResult?.passed ? [] : [`${entry.definition.id}: page Gate failed`]),
  ...entry.consoleMessages.filter((message) => message.type === "error")
    .map((message) => `${entry.definition.id}: console error: ${message.text}`),
  ...entry.pageErrors.map((error) => `${entry.definition.id}: page error: ${error}`)
]);
const materialDrawCounts = results
  .filter((entry) => entry.definition.id.startsWith("materials-"))
  .map((entry) => entry.pageResult?.statistics?.pass?.drawCount ?? null);
const materialScaleIssues = materialDrawCounts.every((value) => value === 3)
  ? []
  : [`material 1/8/64 changed fixed draw count: ${materialDrawCounts.join("/")}`];
const forward = results.find((entry) => entry.definition.id === "order-forward");
const reverse = results.find((entry) => entry.definition.id === "order-reverse");
const orderDifference = forward && reverse
  ? compareHdr(
      forward.pageResult?.statistics?.hdrNumeric,
      reverse.pageResult?.statistics?.hdrNumeric
    )
  : null;
const logicalForward = normalizedLogicalStack(
  forward?.pageResult?.statistics?.fixtureContract?.records
);
const logicalReverse = normalizedLogicalStack(
  reverse?.pageResult?.statistics?.fixtureContract?.records
);
const logicalStackMatches = logicalForward !== null && logicalReverse !== null &&
  JSON.stringify(logicalForward) === JSON.stringify(logicalReverse);
// Both captures are rgba16float and use identical world-space fragments. The
// bound permits FP16 additive rounding while rejecting order-dependent shading.
const orderIssues = [
  ...(orderDifference !== null && orderDifference.rmsRgb <= 0.003 &&
    orderDifference.maxChannelDifference <= 0.01
    ? []
    : [`HDR order invariance exceeded 0.003 RMS / 0.01 max: ${JSON.stringify(orderDifference)}`]),
  ...(logicalStackMatches ? [] : ["forward/reverse logical world-space stacks differ"]),
  ...(forward?.pageResult?.statistics?.fixtureContract?.sameXyFootprint === true &&
    forward?.pageResult?.statistics?.fixtureContract?.distinctDepthCount === 4
    ? []
    : ["order fixture does not contain four overlapping colored layers"])
];
const issues = [
  ...caseIssues,
  ...build.issues,
  ...imageIssues,
  ...materialScaleIssues,
  ...orderIssues,
  ...(!requireClean || scopedDirtyReasons.length === 0
    ? []
    : [`clean Gate requested with scoped dirty paths: ${scopedDirtyReasons.join(", ")}`])
];
const gate = {
  schemaVersion: 1,
  taskId: "FX-05",
  passed: issues.length === 0,
  gateEligible: scopedDirtyReasons.length === 0 && build.passed,
  requireClean,
  cleanScope: "OEngine/docs/examples; three.js reference submodule worktree excluded",
  excludedReferenceDirtyReasons,
  issues
};
await writeJson(path.join(outputRoot, "artifact.json"), {
  gate,
  build,
  orderDifference,
  cases: results.map(({ screenshotPath: _path, ...entry }) => entry)
});
await writeJson(path.join(outputRoot, "result.json"), {
  gate,
  orderDifference,
  sweeps: results.map((entry) => ({
    definition: entry.definition,
    statistics: entry.pageResult?.statistics ?? null,
    screenshot: entry.screenshot
  }))
});
await writeJson(path.join(outputRoot, "environment.json"), {
  commit: currentBuild.commit,
  dirty: currentBuild.dirty,
  contentHash: currentBuild.contentHash,
  browser: browser.version(),
  chromePath,
  capturedAt: new Date().toISOString()
});
process.stdout.write(`${JSON.stringify({ gate, outputRoot, orderDifference }, null, 2)}\n`);
if (!gate.passed) process.exitCode = 1;

async function screenshotEvidence(filePath, PNG) {
  const bytes = await readFile(filePath);
  const png = PNG.sync.read(bytes);
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 0; y < png.height; y += 2) {
    for (let x = 0; x < png.width; x += 2) {
      const offset = (y * png.width + x) * 4;
      const luma = png.data[offset] * 0.2126 +
        png.data[offset + 1] * 0.7152 + png.data[offset + 2] * 0.0722;
      sum += luma;
      sumSquares += luma * luma;
      count++;
    }
  }
  const meanLuma = sum / count;
  return {
    bytes: bytes.length,
    width: png.width,
    height: png.height,
    meanLuma,
    standardDeviation: Math.sqrt(Math.max(0, sumSquares / count - meanLuma * meanLuma)),
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function compareHdr(left, right) {
  const leftRgb = left?.rgb;
  const rightRgb = right?.rgb;
  if (!Array.isArray(leftRgb) || !Array.isArray(rightRgb) ||
    leftRgb.length === 0 || leftRgb.length !== rightRgb.length) {
    return null;
  }
  let squared = 0;
  let maximum = 0;
  for (let index = 0; index < leftRgb.length; index++) {
    const difference = Math.abs(leftRgb[index] - rightRgb[index]);
    squared += difference * difference;
    maximum = Math.max(maximum, difference);
  }
  return {
    source: "production pre-tonemap rgba16float ROI",
    rmsRgb: Math.sqrt(squared / leftRgb.length),
    maxChannelDifference: maximum
  };
}

function normalizedLogicalStack(records) {
  if (!Array.isArray(records) || records.length !== 4) return null;
  return records.map(({ record: _record, ...logical }) => logical)
    .sort((left, right) => left.logicalLayer - right.logicalLayer);
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
