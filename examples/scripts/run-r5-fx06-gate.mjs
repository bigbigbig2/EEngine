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

  let stageIndex = 0;
  while (true) {
    await page.waitForFunction(
      (expected) => {
        const state = window.__OENGINE_FX_06_STATE__;
        return state?.completed === true ||
          (state?.stageReady === true && state.stageIndex === expected);
      },
      stageIndex,
      { timeout: 600_000 }
    );
    const state = await page.evaluate(() => window.__OENGINE_FX_06_STATE__);
    if (state?.completed) {
      pageResult = state.result;
      break;
    }
    const screenshotPath = path.join(
      outputRoot,
      `${String(stageIndex).padStart(2, "0")}-${state.stageId}.png`
    );
    await page.locator("#gpu-canvas").screenshot({ path: screenshotPath });
    screenshots.push({
      stageIndex,
      stageId: state.stageId,
      path: screenshotPath,
      evidence: await screenshotEvidence(screenshotPath, PNG)
    });
    await page.evaluate(() => window.__OENGINE_FX_06_ADVANCE__?.());
    stageIndex++;
  }
  await context.close();
} finally {
  await browser.close();
}

const build = evaluateBuildProvenance(pageResult?.build, currentBuild);
const screenshotById = (id) => screenshots.find((entry) => entry.stageId === id);
const staticDifference = await compareScreenshots(
  screenshotById("static-a")?.path,
  screenshotById("static-b")?.path,
  PNG
);
const offDifference = await compareScreenshots(
  screenshotById("feature-off-a")?.path,
  screenshotById("feature-off-b")?.path,
  PNG
);
const settledDifference = await compareScreenshots(
  screenshotById("feature-restored")?.path,
  screenshotById("static-settled")?.path,
  PNG
);
const imageIssues = screenshots.flatMap((entry) => [
  ...(entry.evidence.bytes > 1024 ? [] : [`${entry.stageId}: empty screenshot`]),
  ...(entry.evidence.standardDeviation > 0.5
    ? []
    : [`${entry.stageId}: screenshot has no visual variation`])
]);
if (screenshots.length !== pageResult?.stages?.length) {
  imageIssues.push(`captured ${screenshots.length} screenshots for ${pageResult?.stages?.length ?? 0} stages`);
}
if (staticDifference === null || offDifference === null || settledDifference === null) {
  imageIssues.push("static/off/settled image comparison evidence is incomplete");
}
if ((staticDifference?.rmsRgb8 ?? 0) > 2) {
  imageIssues.push(`static temporal RMS ${staticDifference.rmsRgb8} exceeds 2 RGB8`);
}
if ((settledDifference?.rmsRgb8 ?? 0) > 2) {
  imageIssues.push(`settled temporal RMS ${settledDifference.rmsRgb8} shows sustained ghosting`);
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
  taskId: "FX-06A",
  passed: issues.length === 0,
  gateEligible: scopedDirtyReasons.length === 0 && build.passed,
  requireClean,
  cleanScope: "OEngine/docs/examples; three.js reference submodule worktree excluded",
  excludedReferenceDirtyReasons,
  issues
};
const comparisons = { staticDifference, offDifference, settledDifference };
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
  comparisons
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
    finalEvidence: stage.finalEvidence
  }))
});
process.stdout.write(`${JSON.stringify({ gate, outputRoot, comparisons }, null, 2)}\n`);
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

async function compareScreenshots(leftPath, rightPath, PNG) {
  if (!leftPath || !rightPath) return null;
  const left = PNG.sync.read(await readFile(leftPath));
  const right = PNG.sync.read(await readFile(rightPath));
  if (left.width !== right.width || left.height !== right.height) return null;
  let squared = 0;
  let maximum = 0;
  let count = 0;
  for (let index = 0; index < left.data.length; index += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const difference = Math.abs(left.data[index + channel] - right.data[index + channel]);
      squared += difference * difference;
      maximum = Math.max(maximum, difference);
      count++;
    }
  }
  return { rmsRgb8: Math.sqrt(squared / count), maxChannelDifferenceRgb8: maximum };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
