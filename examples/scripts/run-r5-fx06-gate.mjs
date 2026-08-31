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
const outputRoot = path.join(repoRoot, "temp/r5/fx-06", artifactId);
const baseUrl = process.env.OENGINE_EXAMPLES_URL ?? "http://127.0.0.1:5174";
const chromePath = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const requireClean = process.env.FX06_REQUIRE_CLEAN === "1";
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

const consoleMessages = [];
const pageErrors = [];
const screenshots = [];
let pageResult;
try {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1200 },
    deviceScaleFactor: 1
  });
  const page = await context.newPage();
  page.on("console", (message) => consoleMessages.push({
    type: message.type(),
    text: message.text()
  }));
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  await page.goto(`${baseUrl}/r5-temporal-foundation/`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });

  let expectedEvent = 0;
  while (true) {
    await page.waitForFunction(
      (expected) => {
        const state = window.__OENGINE_FX_06_STATE__;
        return state?.completed === true ||
          (state?.stageReady === true && state.eventIndex === expected);
      },
      expectedEvent,
      { timeout: 600_000 }
    );
    const state = await page.evaluate(() => window.__OENGINE_FX_06_STATE__);
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
      stageIndex: state.stageIndex,
      stageId: state.stageId,
      keyframe: state.keyframe,
      path: screenshotPath,
      evidence: await screenshotEvidence(screenshotPath, PNG)
    });
    await page.evaluate(() => window.__OENGINE_FX_06_ADVANCE__?.());
    expectedEvent++;
  }
  await context.close();
} finally {
  await browser.close();
}

const build = evaluateBuildProvenance(pageResult?.build, currentBuild);
const screenshotByKey = (stageId, label) => screenshots.find(
  (entry) => entry.stageId === stageId && entry.keyframe?.label === label
);
const temporalStaticVariance = await sequenceVariance("static-b", screenshots, PNG);
const noTemporalStaticVariance = await sequenceVariance("static-no-history", screenshots, PNG);
const offDifference = await compareScreenshots(
  screenshotByKey("feature-off-a", "end")?.path,
  screenshotByKey("feature-off-b", "end")?.path,
  PNG
);
const settledDifference = await compareScreenshots(
  screenshotByKey("feature-restored", "end")?.path,
  screenshotByKey("static-settled", "end")?.path,
  PNG
);
const thresholds = {
  maxStaticTemporalRmsRgb8: 2,
  maxSettledRmsRgb8: 2,
  maxGhostRmsAt32FramesRgb8: 2,
  maxGhostTrailAt32FramesPixels: 8,
  pixelDifferenceThresholdRgb8: 8,
  maxSettlingFrames: 32
};
const ghostSequences = {};
for (const stageId of ["moving-object", "disocclusion", "transparent-motion"]) {
  ghostSequences[stageId] = await ghostSequenceMetrics(
    stageId,
    screenshots,
    PNG,
    thresholds
  );
}
const imageIssues = screenshots.flatMap((entry) => [
  ...(entry.evidence.bytes > 1024 ? [] : [`${entry.stageId}/${entry.keyframe?.label}: empty screenshot`]),
  ...(entry.evidence.standardDeviation > 0.5
    ? []
    : [`${entry.stageId}/${entry.keyframe?.label}: screenshot has no visual variation`]),
  ...(entry.evidence.width === (entry.stageId === "resize" ? 1600 : 1920) &&
    entry.evidence.height === (entry.stageId === "resize" ? 900 : 1080)
    ? []
    : [`${entry.stageId}/${entry.keyframe?.label}: screenshot dimensions do not match output resolution`])
]);
for (const stage of pageResult?.stages ?? []) {
  if (!screenshots.some((entry) => entry.stageId === stage.definition?.id)) {
    imageIssues.push(`${stage.definition?.id}: no fixed keyframe screenshot`);
  }
}
for (const [stageId, label] of [
  ["camera-cut", "first"],
  ["resize", "first"],
  ["transparent-motion", "settle-0"],
  ["transparent-motion", "settle-32"],
  ["transparent-motion", "settled"]
]) {
  if (screenshotByKey(stageId, label) === undefined) {
    imageIssues.push(`${stageId}/${label}: required keyframe missing`);
  }
}
if (
  temporalStaticVariance === null ||
  noTemporalStaticVariance === null ||
  offDifference === null ||
  settledDifference === null
) {
  imageIssues.push("static/off/settled image comparison evidence is incomplete");
}
if ((temporalStaticVariance?.rmsRgb8 ?? Number.POSITIVE_INFINITY) > thresholds.maxStaticTemporalRmsRgb8) {
  imageIssues.push(`static temporal RMS ${temporalStaticVariance?.rmsRgb8} exceeds ${thresholds.maxStaticTemporalRmsRgb8} RGB8`);
}
if (
  (temporalStaticVariance?.rmsRgb8 ?? Number.POSITIVE_INFINITY) >=
  (noTemporalStaticVariance?.rmsRgb8 ?? Number.NEGATIVE_INFINITY)
) {
  imageIssues.push("static temporal variance is not below the no-history temporal baseline");
}
if ((settledDifference?.rmsRgb8 ?? Number.POSITIVE_INFINITY) > thresholds.maxSettledRmsRgb8) {
  imageIssues.push(`settled temporal RMS ${settledDifference.rmsRgb8} shows sustained ghosting`);
}
for (const [stageId, metric] of Object.entries(ghostSequences)) {
  if (metric === null) {
    imageIssues.push(`${stageId}: ghost sequence evidence is incomplete`);
    continue;
  }
  if (metric.settlingFrames === null || metric.settlingFrames > thresholds.maxSettlingFrames) {
    imageIssues.push(`${stageId}: did not settle within ${thresholds.maxSettlingFrames} frames`);
  }
  const at32 = metric.samples.find((sample) => sample.framesSinceEvent === 32);
  if (
    at32 === undefined ||
    at32.rmsRgb8 > thresholds.maxGhostRmsAt32FramesRgb8 ||
    at32.ghostTrailLengthPixels > thresholds.maxGhostTrailAt32FramesPixels
  ) imageIssues.push(`${stageId}: sustained ghost trail remains at 32 frames`);
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
  schemaVersion: 2,
  taskId: "FX-06A",
  passed: issues.length === 0,
  gateEligible: scopedDirtyReasons.length === 0 && build.passed,
  requireClean,
  cleanScope: "OEngine/docs/examples; three.js reference submodule worktree excluded",
  excludedReferenceDirtyReasons,
  issues
};
const comparisons = {
  temporalStaticVariance,
  noTemporalStaticVariance,
  offDifference,
  settledDifference,
  ghostSequences
};
const screenshotMetrics = {
  schemaVersion: 1,
  taskId: "FX-06A",
  thresholds,
  passed: imageIssues.length === 0,
  issues: imageIssues,
  staticVariance: {
    temporal: temporalStaticVariance,
    noTemporalAccumulation: noTemporalStaticVariance,
    baselineMethod: "same production Temporal pass and jitter; history reuse invalidated every frame"
  },
  featureOffDifference: offDifference,
  restoredSettledDifference: settledDifference,
  ghostSequences,
  screenshots: screenshots.map(({ path: _path, ...entry }) => entry)
};
const sequence = {
  schemaVersion: 1,
  taskId: "FX-06A",
  fixedFramesPerStage: (pageResult?.contract?.warmupFramesPerStage ?? 0) +
    (pageResult?.contract?.sampleFramesPerStage ?? 0),
  renderScaleTransition: [1, 0.67, 1],
  stages: (pageResult?.stages ?? []).map((stage) => ({
    id: stage.definition?.id,
    kind: stage.definition?.kind,
    frameBegin: stage.frameBegin,
    frameEnd: stage.frameEnd,
    sampledFrames: stage.frameEnd - stage.frameBegin,
    firstHistoryValid: stage.firstHistoryValid,
    historySettlingFrames: stage.historySettlingFrames,
    keyframes: screenshots
      .filter((entry) => entry.stageId === stage.definition?.id)
      .map(({ eventIndex, keyframe, evidence }) => ({ eventIndex, ...keyframe, evidence }))
  }))
};
const performance = {
  sameMachineTemporalOn: pickPerformanceStage(pageResult?.stages, "static-b"),
  featureOff: pickPerformanceStage(pageResult?.stages, "feature-off-b"),
  resolutionSweep: ["resolution-1", "resolution-085", "resolution-067", "resolution-05"]
    .map((id) => pickPerformanceStage(pageResult?.stages, id))
};
await writeJson(path.join(outputRoot, "artifact.json"), {
  gate,
  build,
  pageResult,
  comparisons,
  screenshots: screenshots.map(({ path: _path, ...entry }) => entry),
  consoleMessages,
  pageErrors
});
await writeJson(path.join(outputRoot, "result.json"), {
  gate,
  contract: pageResult?.contract ?? null,
  stages: pageResult?.stages ?? [],
  comparisons,
  performance
});
await writeJson(path.join(outputRoot, "sequence.json"), sequence);
await writeJson(path.join(outputRoot, "screenshot-metrics.json"), screenshotMetrics);
await writeJson(path.join(outputRoot, "environment.json"), {
  ...pageResult?.environment,
  commit: currentBuild.commit,
  dirty: currentBuild.dirty,
  contentHash: currentBuild.contentHash,
  browser: browser.version(),
  chromePath,
  capturedAt: new Date().toISOString()
});
const counters = {
  diagnostics: pageResult?.diagnostics ?? null,
  stages: (pageResult?.stages ?? []).map((stage) => ({
    id: stage.definition?.id,
    graphBuilds: stage.graphBuilds,
    graphExecutes: stage.graphExecutes,
    maxSubmits: stage.maxSubmits,
    maxReadbacks: stage.maxReadbacks,
    maxReadbackBytes: stage.maxReadbackBytes,
    readbackLabels: stage.readbackLabels,
    finalEvidence: stage.finalEvidence
  }))
};
await writeJson(path.join(outputRoot, "graph-counters.json"), counters);
await writeJson(path.join(outputRoot, "counters.json"), counters);
process.stdout.write(`${JSON.stringify({ gate, outputRoot, comparisons }, null, 2)}\n`);
if (!gate.passed) process.exitCode = 1;

async function captureCanvas(page, filePath, PNG) {
  const locator = page.locator("#gpu-canvas");
  const expected = await locator.evaluate((canvas) => ({
    width: canvas.width,
    height: canvas.height
  }));
  await locator.screenshot({ path: filePath });
  const source = PNG.sync.read(await readFile(filePath));
  if (source.width < expected.width || source.height < expected.height) {
    throw new Error(
      `Canvas screenshot ${source.width}x${source.height} is smaller than ` +
      `the ${expected.width}x${expected.height} output`
    );
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

async function ghostSequenceMetrics(stageId, allScreenshots, PNG, thresholds) {
  const entries = allScreenshots
    .filter((entry) => entry.stageId === stageId && entry.keyframe?.role === "motion-settle")
    .sort((left, right) => left.keyframe.framesSinceEvent - right.keyframe.framesSinceEvent);
  const settled = entries.at(-1);
  if (entries.length < 5 || settled === undefined) return null;
  const samples = [];
  for (const entry of entries) {
    const comparison = await compareScreenshots(entry.path, settled.path, PNG);
    if (comparison === null) return null;
    samples.push({
      label: entry.keyframe.label,
      framesSinceEvent: entry.keyframe.framesSinceEvent,
      ...comparison
    });
  }
  const settledSample = samples.find((sample) =>
    sample.rmsRgb8 <= thresholds.maxGhostRmsAt32FramesRgb8 &&
    sample.ghostTrailLengthPixels <= thresholds.maxGhostTrailAt32FramesPixels
  );
  return {
    reference: settled.keyframe.label,
    settlingFrames: settledSample?.framesSinceEvent ?? null,
    ghostTrailLengthFrames: settledSample?.framesSinceEvent ?? null,
    samples
  };
}

async function sequenceVariance(stageId, allScreenshots, PNG) {
  const entries = allScreenshots
    .filter((entry) => entry.stageId === stageId && entry.keyframe?.role === "variance")
    .sort((left, right) => left.keyframe.ordinal - right.keyframe.ordinal);
  if (entries.length !== 16) return null;
  const images = await Promise.all(entries.map(async (entry) =>
    PNG.sync.read(await readFile(entry.path))
  ));
  const first = images[0];
  if (
    first === undefined ||
    images.some((image) => image.width !== first.width || image.height !== first.height)
  ) return null;
  let varianceSum = 0;
  let maximumStandardDeviation = 0;
  let sampleCount = 0;
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
      const variance = Math.max(0, squared / images.length - mean * mean);
      varianceSum += variance;
      maximumStandardDeviation = Math.max(maximumStandardDeviation, Math.sqrt(variance));
      sampleCount++;
    }
  }
  return {
    frameCount: images.length,
    rmsStandardDeviationRgb8: Math.sqrt(varianceSum / sampleCount),
    maxStandardDeviationRgb8: maximumStandardDeviation,
    rmsRgb8: Math.sqrt(varianceSum / sampleCount)
  };
}

function pickPerformanceStage(stages, id) {
  const stage = stages?.find((entry) => entry.definition?.id === id);
  if (stage === undefined) return null;
  return {
    id,
    scale: stage.finalEvidence?.internalScale,
    p50Ms: stage.temporalGpuP50Ms,
    p95Ms: stage.temporalGpuP95Ms,
    p99Ms: stage.temporalGpuP99Ms,
    p50MsPerOutputMp: stage.temporalGpuP50MsPerOutputMp,
    p50MsPerInternalMp: stage.temporalGpuP50MsPerInternalMp,
    outputPixels: stage.outputPixels,
    internalPixels: stage.internalPixels
  };
}

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

async function compareScreenshots(leftPath, rightPath, PNG) {
  if (!leftPath || !rightPath) return null;
  const left = PNG.sync.read(await readFile(leftPath));
  const right = PNG.sync.read(await readFile(rightPath));
  if (left.width !== right.width || left.height !== right.height) return null;
  let squared = 0;
  let absolute = 0;
  let maximum = 0;
  let count = 0;
  let changedPixels = 0;
  let ghostTrailLengthPixels = 0;
  for (let y = 0; y < left.height; y++) {
    let horizontalRun = 0;
    for (let x = 0; x < left.width; x++) {
      const index = (y * left.width + x) * 4;
      let pixelMaximum = 0;
      for (let channel = 0; channel < 3; channel++) {
        const difference = Math.abs(left.data[index + channel] - right.data[index + channel]);
        squared += difference * difference;
        absolute += difference;
        pixelMaximum = Math.max(pixelMaximum, difference);
        maximum = Math.max(maximum, difference);
        count++;
      }
      if (pixelMaximum > 8) {
        changedPixels++;
        horizontalRun++;
        ghostTrailLengthPixels = Math.max(ghostTrailLengthPixels, horizontalRun);
      } else {
        horizontalRun = 0;
      }
    }
  }
  return {
    rmsRgb8: Math.sqrt(squared / count),
    meanAbsoluteErrorRgb8: absolute / count,
    maxChannelDifferenceRgb8: maximum,
    changedPixelPercent: changedPixels / (left.width * left.height) * 100,
    ghostTrailLengthPixels
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
