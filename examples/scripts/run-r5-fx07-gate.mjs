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
const outputRoot = path.join(repoRoot, "temp/r5/fx-07", artifactId);
const baseUrl = process.env.OENGINE_EXAMPLES_URL ?? "http://127.0.0.1:5174";
const chromePath = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const requireClean = process.env.FX07_REQUIRE_CLEAN === "1";
const profileQuery = process.env.FX07_PROFILE === "smoke" ? "?profile=smoke" : "";
const excludedReferenceDirtyReasons = currentBuild.dirtyReasons.filter(
  (reason) => /^[Mm] three\.js$/.test(reason)
);
const scopedDirtyReasons = currentBuild.dirtyReasons.filter(
  (reason) => !excludedReferenceDirtyReasons.includes(reason)
);

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

const screenshots = [];
const consoleMessages = [];
const pageErrors = [];
let pageResult;
try {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1
  });
  const page = await context.newPage();
  page.on("console", (message) => consoleMessages.push({
    type: message.type(),
    text: message.text()
  }));
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  await page.goto(`${baseUrl}/r5-ambient-occlusion/${profileQuery}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });
  let expectedEvent = 0;
  while (true) {
    await page.waitForFunction(
      (expected) => {
        const state = window.__OENGINE_FX_07_STATE__;
        return state?.completed === true ||
          (state?.stageReady === true && state.eventIndex === expected);
      },
      expectedEvent,
      { timeout: 900_000 }
    );
    const state = await page.evaluate(() => window.__OENGINE_FX_07_STATE__);
    if (state?.completed) {
      pageResult = state.result;
      break;
    }
    const screenshotPath = path.join(
      outputRoot,
      `${String(expectedEvent).padStart(2, "0")}-${state.stageId}-${state.keyframe.label}.png`
    );
    await captureCanvas(page, screenshotPath, PNG);
    screenshots.push({
      eventIndex: expectedEvent,
      stageId: state.stageId,
      keyframe: state.keyframe,
      path: screenshotPath,
      evidence: await screenshotEvidence(screenshotPath, PNG)
    });
    await page.evaluate(() => window.__OENGINE_FX_07_ADVANCE__?.());
    expectedEvent++;
  }
  await context.close();
} finally {
  await browser.close();
}

const build = evaluateBuildProvenance(pageResult?.build, currentBuild);
const thresholds = {
  minRawP95MinusP01Rgb8: 8,
  maxHalfFullDenoisedRmsRgb8: 18,
  maxSettle32To64RmsRgb8: 3,
  maxTemporalStaticRmsRgb8: 2
};
const byKey = (stageId, label = "end") => screenshots.find(
  (entry) => entry.stageId === stageId && entry.keyframe?.label === label
);
const fullHalfDenoised = await compareImages(
  byKey("full-denoised")?.path,
  byKey("half-denoised")?.path,
  PNG
);
const temporalOffVariance = await sequenceVariance("full-temporal-off", screenshots, PNG);
const temporalOnVariance = await sequenceVariance("full-temporal-on", screenshots, PNG);
const panSettle = await compareImages(
  byKey("camera-pan", "settle-32")?.path,
  byKey("camera-pan", "settle-64")?.path,
  PNG
);
const disocclusionSettle = await compareImages(
  byKey("disocclusion", "settle-32")?.path,
  byKey("disocclusion", "settle-64")?.path,
  PNG
);
const rawEvidence = byKey("full-raw")?.evidence;
const imageIssues = [];
for (const stage of pageResult?.stages ?? []) {
  if (!screenshots.some((entry) => entry.stageId === stage.definition?.id)) {
    imageIssues.push(`${stage.definition?.id}: no screenshot`);
  }
}
for (const screenshot of screenshots) {
  if (screenshot.evidence.width !== 1280 || screenshot.evidence.height !== 720) {
    imageIssues.push(`${screenshot.stageId}/${screenshot.keyframe?.label}: expected 1280x720 screenshot`);
  }
  if (screenshot.evidence.bytes <= 1024 || screenshot.evidence.standardDeviation <= 0.5) {
    imageIssues.push(`${screenshot.stageId}/${screenshot.keyframe?.label}: empty or uniform screenshot`);
  }
}
if (rawEvidence === undefined || rawEvidence.p95Luma - rawEvidence.p01Luma < thresholds.minRawP95MinusP01Rgb8) {
  imageIssues.push("AO raw does not separate near-unoccluded flat pixels from corner/crevice occlusion");
}
if (
  fullHalfDenoised === null ||
  fullHalfDenoised.rmsRgb8 > thresholds.maxHalfFullDenoisedRmsRgb8
) imageIssues.push("half/full denoised AO diverges beyond the focused tolerance");
if (
  temporalOffVariance === null || temporalOnVariance === null ||
  temporalOnVariance.rmsRgb8 > thresholds.maxTemporalStaticRmsRgb8 ||
  temporalOnVariance.rmsRgb8 >= temporalOffVariance.rmsRgb8
) imageIssues.push("temporal-on static AO did not reduce current-frame noise");
for (const [name, value] of [["camera-pan", panSettle], ["disocclusion", disocclusionSettle]]) {
  if (value === null || value.rmsRgb8 > thresholds.maxSettle32To64RmsRgb8) {
    imageIssues.push(`${name}: sustained AO trail remains after 32 frames`);
  }
}
const consoleIssues = [
  ...consoleMessages.filter((message) => message.type === "error")
    .map((message) => `console error: ${message.text}`),
  ...pageErrors.map((error) => `page error: ${error}`)
];
const issues = [
  ...(pageResult?.issues ?? ["page result missing"]),
  ...(pageResult?.passed ? [] : ["production page Gate failed"]),
  ...build.issues,
  ...imageIssues,
  ...consoleIssues,
  ...(!requireClean || scopedDirtyReasons.length === 0
    ? []
    : [`clean Gate requested with scoped dirty paths: ${scopedDirtyReasons.join(", ")}`])
];
const gate = {
  schemaVersion: 1,
  taskId: "FX-07",
  passed: issues.length === 0,
  gateEligible: scopedDirtyReasons.length === 0 && build.passed,
  requireClean,
  cleanScope: "OEngine/docs/examples; three.js reference submodule worktree excluded",
  excludedReferenceDirtyReasons,
  issues
};
const comparisons = {
  thresholds,
  rawFlatCornerDistribution: rawEvidence ?? null,
  fullHalfDenoised,
  temporalOffVariance,
  temporalOnVariance,
  panSettle,
  disocclusionSettle
};
const serialScreenshots = screenshots.map(({ path: _path, ...entry }) => entry);
await writeJson(path.join(outputRoot, "artifact.json"), {
  gate,
  build,
  pageResult,
  comparisons,
  screenshots: serialScreenshots,
  consoleMessages,
  pageErrors
});
await writeJson(path.join(outputRoot, "result.json"), {
  gate,
  contract: pageResult?.contract ?? null,
  stages: pageResult?.stages ?? [],
  comparisons
});
await writeJson(path.join(outputRoot, "sequence.json"), {
  schemaVersion: 1,
  taskId: "FX-07",
  stages: (pageResult?.stages ?? []).map((stage) => ({
    id: stage.definition?.id,
    kind: stage.definition?.kind,
    scale: stage.definition?.scale,
    temporal: stage.definition?.temporal,
    frameBegin: stage.frameBegin,
    frameEnd: stage.frameEnd,
    keyframes: serialScreenshots.filter((entry) => entry.stageId === stage.definition?.id)
  }))
});
await writeJson(path.join(outputRoot, "screenshot-metrics.json"), {
  schemaVersion: 1,
  taskId: "FX-07",
  passed: imageIssues.length === 0,
  issues: imageIssues,
  ...comparisons,
  screenshots: serialScreenshots
});
await writeJson(path.join(outputRoot, "performance.json"), {
  schemaVersion: 1,
  taskId: "FX-07",
  stages: (pageResult?.stages ?? []).map((stage) => ({
    id: stage.definition?.id,
    scale: stage.definition?.scale,
    temporal: stage.definition?.temporal,
    aoPixels: stage.finalEvidence?.aoPixels,
    historyBytes: stage.finalEvidence?.historyBytes,
    gpu: stage.gpu
  }))
});
await writeJson(path.join(outputRoot, "graph-counters.json"), {
  diagnostics: pageResult?.diagnostics ?? null,
  stages: (pageResult?.stages ?? []).map((stage) => ({
    id: stage.definition?.id,
    graphBuilds: stage.graphBuilds,
    graphExecutes: stage.graphExecutes,
    maxSubmits: stage.maxSubmits,
    maxReadbacks: stage.maxReadbacks,
    maxReadbackBytes: stage.maxReadbackBytes,
    readbackLabels: stage.readbackLabels,
    timestampLabels: stage.timestampLabels,
    firstEvidence: stage.firstEvidence,
    finalEvidence: stage.finalEvidence
  }))
});
await writeJson(path.join(outputRoot, "environment.json"), {
  ...pageResult?.environment,
  commit: currentBuild.commit,
  dirty: currentBuild.dirty,
  contentHash: currentBuild.contentHash,
  browser: browser.version(),
  chromePath,
  capturedAt: new Date().toISOString()
});
process.stdout.write(`${JSON.stringify({ gate, outputRoot, comparisons }, null, 2)}\n`);
if (!gate.passed) process.exitCode = 1;

async function captureCanvas(page, filePath, PNG) {
  const locator = page.locator("#gpu-canvas");
  const expected = await locator.evaluate((canvas) => ({ width: canvas.width, height: canvas.height }));
  await locator.screenshot({ path: filePath });
  const source = PNG.sync.read(await readFile(filePath));
  if (source.width < expected.width || source.height < expected.height) {
    throw new Error(`Canvas screenshot ${source.width}x${source.height} is smaller than output`);
  }
  if (source.width === expected.width && source.height === expected.height) return;
  const cropped = new PNG({ width: expected.width, height: expected.height });
  const rowBytes = expected.width * 4;
  for (let y = 0; y < expected.height; y++) {
    const sourceOffset = y * source.width * 4;
    cropped.data.set(source.data.subarray(sourceOffset, sourceOffset + rowBytes), y * rowBytes);
  }
  await writeFile(filePath, PNG.sync.write(cropped));
}

async function screenshotEvidence(filePath, PNG) {
  const bytes = await readFile(filePath);
  const png = PNG.sync.read(bytes);
  const lumas = [];
  let sum = 0;
  let squared = 0;
  for (let y = 0; y < png.height; y += 2) {
    for (let x = 0; x < png.width; x += 2) {
      const offset = (y * png.width + x) * 4;
      const luma = png.data[offset] * 0.2126 + png.data[offset + 1] * 0.7152 + png.data[offset + 2] * 0.0722;
      lumas.push(luma);
      sum += luma;
      squared += luma * luma;
    }
  }
  lumas.sort((left, right) => left - right);
  const mean = sum / lumas.length;
  return {
    bytes: bytes.byteLength,
    width: png.width,
    height: png.height,
    meanLuma: mean,
    standardDeviation: Math.sqrt(Math.max(0, squared / lumas.length - mean * mean)),
    p05Luma: lumas[Math.floor(lumas.length * 0.05)],
    p01Luma: lumas[Math.floor(lumas.length * 0.01)],
    p50Luma: lumas[Math.floor(lumas.length * 0.5)],
    p95Luma: lumas[Math.floor(lumas.length * 0.95)]
  };
}

async function compareImages(leftPath, rightPath, PNG) {
  if (leftPath === undefined || rightPath === undefined) return null;
  const [left, right] = await Promise.all([
    readFile(leftPath).then((value) => PNG.sync.read(value)),
    readFile(rightPath).then((value) => PNG.sync.read(value))
  ]);
  if (left.width !== right.width || left.height !== right.height) return null;
  let squared = 0;
  let max = 0;
  let count = 0;
  for (let byte = 0; byte < left.data.length; byte += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const difference = Math.abs(left.data[byte + channel] - right.data[byte + channel]);
      squared += difference * difference;
      max = Math.max(max, difference);
      count++;
    }
  }
  return { rmsRgb8: Math.sqrt(squared / count), maxChannelDifference: max };
}

async function sequenceVariance(stageId, allScreenshots, PNG) {
  const entries = allScreenshots
    .filter((entry) => entry.stageId === stageId && entry.keyframe?.role === "variance")
    .sort((left, right) => left.keyframe.label.localeCompare(right.keyframe.label));
  if (entries.length !== 16) return null;
  const images = await Promise.all(entries.map((entry) =>
    readFile(entry.path).then((value) => PNG.sync.read(value))
  ));
  const first = images[0];
  let variance = 0;
  let count = 0;
  for (let byte = 0; byte < first.data.length; byte += 4) {
    for (let channel = 0; channel < 3; channel++) {
      let sum = 0;
      let squared = 0;
      for (const image of images) {
        const value = image.data[byte + channel];
        sum += value;
        squared += value * value;
      }
      const mean = sum / images.length;
      variance += Math.max(0, squared / images.length - mean * mean);
      count++;
    }
  }
  return { frameCount: images.length, rmsRgb8: Math.sqrt(variance / count) };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
