import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  captureGitBuildProvenance,
  evaluateBuildProvenance,
  evaluateDiagnosticSnapshots
} from "./r5-fx01-gate-contract.mjs";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const playwrightRoot = path.join(repoRoot, "temp/browser-tools/node_modules/playwright-core");
const currentBuild = captureGitBuildProvenance(repoRoot);
const artifactId = currentBuild.dirty
  ? `${currentBuild.commit}-dirty-${currentBuild.contentHash.slice(0, 12)}`
  : currentBuild.commit;
const requestedProfile = process.env.Q00_PROFILE;
const profile = requestedProfile === "full" || requestedProfile === "preview" || requestedProfile === "ready"
  ? requestedProfile
  : "smoke";
const captureOnly = profile === "preview" || profile === "ready";
const sessionId = new Date().toISOString().replace(/[:.]/g, "-");
const outputRoot = path.join(
  repoRoot,
  "temp/r5-quality/R5-Q00",
  artifactId,
  `desktop-high-${profile}`,
  sessionId
);
const imageRoot = path.join(outputRoot, "images");
const sequenceRoot = path.join(outputRoot, "sequences");
const baseUrl = process.env.OENGINE_EXAMPLES_URL ?? "http://127.0.0.1:5174";
const chromePath = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const warmupFrames = profile === "full" ? 120 : 12;
const sampleFrames = profile === "full" ? 800 : 48;

await rm(outputRoot, { recursive: true, force: true });
await mkdir(imageRoot, { recursive: true });
await mkdir(sequenceRoot, { recursive: true });
if (!existsSync(path.join(playwrightRoot, "index.mjs"))) {
  throw new Error("Missing playwright-core under temp/browser-tools");
}
const playwright = await import(pathToFileURL(path.join(playwrightRoot, "index.mjs")).href);
const { PNG } = require(path.join(playwrightRoot, "lib/utilsBundle.js"));

const consoleMessages = [];
const pageErrors = [];
const screenshots = [];
const pairedRuns = [];
const diagnosticSnapshots = [];
const sequenceFrames = [];
let browser;
let browserVersion = "unavailable";
let fatalError = null;
let pageSnapshot = null;

const allOff = Object.freeze({
  shadows: false,
  ssao: false,
  ssr: false,
  taa: false,
  bloom: false,
  exposure: false,
  sharpen: false
});
const allOn = Object.freeze({
  shadows: true,
  ssao: true,
  ssr: true,
  taa: true,
  bloom: true,
  exposure: true,
  sharpen: true
});
const imageStages = profile === "ready" ? [
  { id: "ready", features: allOff, debugView: "none", cameraPreset: "overview" }
] : [
  { id: "base", features: allOff, debugView: "none", cameraPreset: "street" },
  { id: "csm", features: { ...allOff, shadows: true }, debugView: "none", cameraPreset: "street" },
  { id: "gtao-raw", features: { ...allOff, ssao: true }, debugView: "ambient-occlusion-raw", cameraPreset: "road" },
  { id: "gtao-spatial", features: { ...allOff, ssao: true }, debugView: "ambient-occlusion-denoised", cameraPreset: "road" },
  { id: "gtao-temporal", features: { ...allOff, ssao: true }, debugView: "ambient-occlusion-temporal", cameraPreset: "road" },
  { id: "ssr-trace", features: { ...allOff, ssr: true }, debugView: "screen-space-reflection-hit-miss", cameraPreset: "road" },
  { id: "ssr-resolve", features: { ...allOff, ssr: true }, debugView: "screen-space-reflection-resolve", cameraPreset: "road" },
  { id: "ssr-temporal", features: { ...allOff, ssr: true }, debugView: "screen-space-reflection-temporal", cameraPreset: "road" },
  { id: "taa", features: { ...allOff, taa: true }, debugView: "none", cameraPreset: "street" },
  { id: "bloom-exposure-post", features: { ...allOff, taa: true, bloom: true, exposure: true, sharpen: true }, debugView: "none", cameraPreset: "street" },
  { id: "all-on", features: allOn, debugView: "none", cameraPreset: "road" }
];

try {
  browser = await playwright.chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--ignore-gpu-blocklist",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding"
    ]
  });
  browserVersion = browser.version();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1
  });
  const page = await context.newPage();
  page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  await page.goto(`${baseUrl}/rendering-lab/`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  await page.waitForFunction(
    () => {
      const state = document.querySelector("#showcase")?.getAttribute("data-state");
      return state === "error" || (state === "ready" && typeof window.__OENGINE_Q00_SNAPSHOT__ === "function");
    },
    undefined,
    { timeout: 900_000 }
  );
  const startup = await page.evaluate(() => {
    const root = document.querySelector("#showcase");
    return {
      state: root?.getAttribute("data-state") ?? "missing",
      error: root?.getAttribute("data-error") ?? null
    };
  });
  if (startup.state !== "ready") {
    throw new Error(`Rendering Lab startup failed: ${startup.error ?? startup.state}`);
  }

  for (const stage of imageStages) {
    await applyState(page, { ...stage, captureClean: profile !== "ready" });
    await settleFrames(page, stage.id.includes("temporal") ? 32 : 12);
    const frameBegin = await page.evaluate(() => window.__OENGINE_Q00_FRAME__());
    await settleFrames(page, 24);
    const frameEnd = await page.evaluate(() => window.__OENGINE_Q00_FRAME__());
    const filePath = path.join(imageRoot, `${stage.id}.png`);
    await captureCanvas(page, filePath, PNG);
    const snapshot = await page.evaluate(() => window.__OENGINE_Q00_SNAPSHOT__());
    diagnosticSnapshots.push({ label: stage.id, diagnostics: snapshot.diagnostics });
    screenshots.push({
      id: stage.id,
      file: path.relative(outputRoot, filePath).replaceAll("\\", "/"),
      sha256: await sha256(filePath),
      metrics: await screenshotEvidence(filePath, PNG),
      frame: await page.evaluate(() => window.__OENGINE_Q00_FRAME__()),
      settings: snapshot.settings,
      timings: summarizeFrames(snapshot.frames, frameBegin, frameEnd),
      graph: snapshot.graph,
      memory: snapshot.memory
    });
  }

  if (!captureOnly) {
  await applyState(page, {
    features: allOn,
    debugView: "none",
    cameraPreset: "street",
    captureClean: true
  });
  await settleFrames(page, 32);
  for (let index = 0; index < 16; index++) {
    await settleFrames(page, 1);
    await captureSequence(page, PNG, "taa-static-jitter", index);
  }

  const canvas = page.locator("#gpu-canvas");
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("Integrated Showcase canvas has no bounding box");
  for (const motion of [
    { id: "taa-slow-pan", dx: 3, dy: -1 },
    { id: "taa-fast-pan", dx: 24, dy: -6 }
  ]) {
    await applyState(page, { cameraPreset: "street", captureClean: true });
    await settleFrames(page, 24);
    const startX = box.x + box.width * 0.45;
    const startY = box.y + box.height * 0.5;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let index = 0; index < 12; index++) {
      await page.mouse.move(
        startX + motion.dx * (index + 1),
        startY + motion.dy * (index + 1),
        { steps: 1 }
      );
      await settleFrames(page, 1);
      await captureSequence(page, PNG, motion.id, index);
    }
    await page.mouse.up();
  }

  await applyState(page, { cameraPreset: "street", captureClean: true });
  await settleFrames(page, 32);
  await applyState(page, { cameraPreset: "road", captureClean: true });
  let previousSettle = 0;
  const disocclusionSettles = [0, 1, 2, 4, 8, 16, 32];
  for (let index = 0; index < disocclusionSettles.length; index++) {
    const settle = disocclusionSettles[index];
    await settleFrames(page, Math.max(1, settle - previousSettle));
    previousSettle = settle;
    await captureSequence(page, PNG, "taa-disocclusion", index, { settleFrames: settle });
  }

  await applyState(page, {
    features: allOn,
    debugView: "none",
    cameraPreset: "road",
    captureClean: false
  });
  await settleFrames(page, 16);
  const panelPath = path.join(imageRoot, "evidence-panel.png");
  await captureCanvas(page, panelPath, PNG);
  screenshots.push({
    id: "evidence-panel",
    file: path.relative(outputRoot, panelPath).replaceAll("\\", "/"),
    sha256: await sha256(panelPath),
    metrics: await screenshotEvidence(panelPath, PNG)
  });

  for (const feature of ["shadows", "ssao", "ssr", "taa", "bloom", "exposure", "sharpen"]) {
    const pair = { feature, off: null, on: null };
    for (const enabled of [false, true]) {
      await applyState(page, {
        features: { ...allOn, [feature]: enabled },
        debugView: "none",
        cameraPreset: "road",
        captureClean: true
      });
      await settleFrames(page, warmupFrames);
      const frameBegin = await page.evaluate(() => window.__OENGINE_Q00_FRAME__());
      await settleFrames(page, sampleFrames);
      const frameEnd = await page.evaluate(() => window.__OENGINE_Q00_FRAME__());
      await settleFrames(page, 16);
      const snapshot = await page.evaluate(() => window.__OENGINE_Q00_SNAPSHOT__());
      const result = {
        frameBegin,
        frameEnd,
        settings: snapshot.settings,
        timings: summarizeFrames(snapshot.frames, frameBegin, frameEnd),
        counters: latestCounterSample(snapshot.frames, frameBegin, frameEnd),
        memory: snapshot.memory,
        graph: snapshot.graph
      };
      pair[enabled ? "on" : "off"] = result;
      diagnosticSnapshots.push({ label: `${feature}-${enabled ? "on" : "off"}`, diagnostics: snapshot.diagnostics });
    }
    pairedRuns.push(pair);
  }
  }
  pageSnapshot = await page.evaluate(() => window.__OENGINE_Q00_SNAPSHOT__());
  await context.close();
} catch (error) {
  fatalError = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  await browser?.close();
}

const build = evaluateBuildProvenance(pageSnapshot?.build, currentBuild);
const diagnosticGate = evaluateDiagnosticSnapshots(diagnosticSnapshots);
const sequenceEvidence = await summarizeSequences(sequenceFrames, PNG);
const imageIssues = screenshots.flatMap((entry) => {
  const issues = [];
  if (entry.metrics.width !== 1920 || entry.metrics.height !== 1080) {
    issues.push(`${entry.id}: expected 1920x1080, got ${entry.metrics.width}x${entry.metrics.height}`);
  }
  if (entry.metrics.bytes <= 1024 || entry.metrics.standardDeviation <= 0.5) {
    issues.push(`${entry.id}: screenshot is empty or uniform`);
  }
  return issues;
});
const consoleIssues = [
  ...consoleMessages.filter((entry) => entry.type === "error").map((entry) => `console error: ${entry.text}`),
  ...pageErrors.map((entry) => `page error: ${entry}`)
];
const evidenceIssues = [];
for (const [id, expected] of captureOnly ? [] : [
  ["taa-static-jitter", 16],
  ["taa-slow-pan", 12],
  ["taa-fast-pan", 12],
  ["taa-disocclusion", 7]
]) {
  const sequence = sequenceEvidence.find((entry) => entry.id === id);
  if (sequence?.frames.length !== expected || sequence.temporalVariance === null) {
    evidenceIssues.push(`${id}: incomplete temporal sequence evidence`);
  }
}
if (pageSnapshot !== null) {
  if ((pageSnapshot.summary?.timestampSampleCount ?? 0) < (profile === "full" ? 100 : 1)) {
    evidenceIssues.push("insufficient completed GPU timestamp samples");
  }
  if ((pageSnapshot.summary?.latestSubmitCount ?? 0) !== 1) {
    evidenceIssues.push(`expected one main submit, got ${String(pageSnapshot.summary?.latestSubmitCount)}`);
  }
  if ((pageSnapshot.graph?.dump?.executablePassOrder?.length ?? 0) === 0) {
    evidenceIssues.push("main FrameGraph dump is missing or empty");
  }
  for (const name of [
    "allocatedBytes",
    "residentLogicalBytes",
    "transientPoolBytes",
    "historyBytes",
    "retiringBytes",
    "fragmentationBytes"
  ]) {
    if (!Number.isFinite(pageSnapshot.memory?.[name])) {
      evidenceIssues.push(`memory evidence '${name}' is missing`);
    }
  }
}
const issues = [
  ...(fatalError === null ? [] : [`runner failure: ${fatalError}`]),
  ...build.issues,
  ...diagnosticGate.issues,
  ...imageIssues,
  ...consoleIssues,
  ...evidenceIssues
];
const gate = {
  schemaVersion: 1,
  taskId: "R5-Q00",
  profile,
  passed: issues.length === 0,
  gateEligible: profile === "full" && !currentBuild.dirty && build.passed,
  issues
};

await writeJson(path.join(outputRoot, "environment.json"), {
  schemaVersion: 1,
  browser: browserVersion,
  chromePath,
  baseUrl,
  viewport: [1920, 1080],
  dpr: 1,
  adapter: pageSnapshot?.environment?.adapter ?? null,
  userAgent: pageSnapshot?.environment?.userAgent ?? null
});
await writeJson(path.join(outputRoot, "provenance.json"), {
  schemaVersion: 1,
  artifactId,
  sessionId,
  build: pageSnapshot?.build ?? null,
  currentBuild,
  comparison: build,
  capturedAt: new Date().toISOString()
});
await writeJson(path.join(outputRoot, "result.json"), { gate, screenshots, pairedRuns });
await writeJson(path.join(outputRoot, "timings.json"), {
  schemaVersion: 1,
  warmupFrames,
  sampleFrames,
  pairedRuns: pairedRuns.filter(isCompletePair).map(({ feature, off, on }) => ({
    feature,
    off: off.timings,
    on: on.timings
  }))
});
await writeJson(path.join(outputRoot, "graph.json"), {
  schemaVersion: 1,
  current: pageSnapshot?.graph ?? null,
  screenshots: screenshots.map(({ id, graph, timings }) => ({
    id,
    graph: graph ?? null,
    commands: timings?.commands ?? null
  })),
  pairedRuns: pairedRuns.filter(isCompletePair).map(({ feature, off, on }) => ({
    feature,
    off: { commands: off.timings.commands, graph: off.graph },
    on: { commands: on.timings.commands, graph: on.graph }
  }))
});
await writeJson(path.join(outputRoot, "domains.json"), {
  schemaVersion: 1,
  temporal: pageSnapshot?.temporal ?? null,
  ao: pageSnapshot?.ao ?? null,
  ssr: pageSnapshot?.ssr ?? null
});
await writeJson(path.join(outputRoot, "memory.json"), {
  schemaVersion: 1,
  current: pageSnapshot?.memory ?? null,
  screenshots: screenshots.map(({ id, memory }) => ({ id, memory: memory ?? null })),
  pairedRuns: pairedRuns.filter(isCompletePair).map(({ feature, off, on }) => ({ feature, off: off.memory, on: on.memory }))
});
await writeJson(path.join(outputRoot, "raw-frames.json"), {
  schemaVersion: 1,
  frames: pageSnapshot?.frames ?? []
});
await writeJson(path.join(outputRoot, "console.json"), {
  schemaVersion: 1,
  consoleMessages,
  pageErrors,
  fatalError,
  diagnostics: diagnosticSnapshots
});
await writeJson(path.join(outputRoot, "images/manifest.json"), { schemaVersion: 1, screenshots });
await writeJson(path.join(outputRoot, "sequences/manifest.json"), {
  schemaVersion: 1,
  sequences: sequenceEvidence
});

process.stdout.write(`${JSON.stringify({ gate, outputRoot }, null, 2)}\n`);
if (!gate.passed) process.exitCode = 1;

async function applyState(page, state) {
  await page.evaluate((value) => window.__OENGINE_Q00_SET_STATE__(value), state);
}

async function captureSequence(page, PNG, id, index, extra = {}) {
  const directory = path.join(sequenceRoot, id);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${String(index).padStart(2, "0")}.png`);
  await captureCanvas(page, filePath, PNG);
  sequenceFrames.push({
    id,
    index,
    file: path.relative(sequenceRoot, filePath).replaceAll("\\", "/"),
    path: filePath,
    sha256: await sha256(filePath),
    metrics: await screenshotEvidence(filePath, PNG),
    frame: await page.evaluate(() => window.__OENGINE_Q00_FRAME__()),
    ...extra
  });
}

async function summarizeSequences(frames, PNG) {
  const ids = [...new Set(frames.map((frame) => frame.id))];
  const summaries = [];
  for (const id of ids) {
    const entries = frames.filter((frame) => frame.id === id)
      .sort((left, right) => left.index - right.index);
    const images = await Promise.all(entries.map(async (entry) =>
      PNG.sync.read(await readFile(entry.path))
    ));
    summaries.push({
      id,
      frames: entries.map(({ path: _path, ...entry }) => entry),
      temporalVariance: imageSequenceVariance(images),
      consecutiveDifference: imageSequenceConsecutiveDifference(images),
      firstToLastDifference: images.length < 2
        ? null
        : imageDifference(images[0], images.at(-1))
    });
  }
  return summaries;
}

async function settleFrames(page, count) {
  const start = await page.evaluate(() => window.__OENGINE_Q00_FRAME__());
  await page.waitForFunction(
    ({ start, count }) => window.__OENGINE_Q00_FRAME__() >= start + count,
    { start, count },
    { timeout: 300_000 }
  );
}

function summarizeFrames(frames, frameBegin, frameEnd) {
  const sampled = frames.filter((frame) =>
    frame.frameIndex >= frameBegin && frame.frameIndex < frameEnd &&
    frame.gpu.sampled && !frame.gpu.pending && frame.gpu.segments.length > 0
  );
  const totals = sampled.map((frame) => frame.gpu.segments.reduce((sum, segment) => sum + segment.durationMs, 0));
  const phaseValues = {};
  for (const frame of sampled) {
    const perFrame = {};
    for (const segment of frame.gpu.segments) {
      perFrame[segment.phase] = (perFrame[segment.phase] ?? 0) + segment.durationMs;
    }
    for (const [phase, value] of Object.entries(perFrame)) {
      (phaseValues[phase] ??= []).push(value);
    }
  }
  const latest = sampled.at(-1);
  return {
    timestampSamples: sampled.length,
    gpuTotalMs: percentiles(totals),
    gpuPhaseMs: Object.fromEntries(Object.entries(phaseValues).map(([phase, values]) => [phase, percentiles(values)])),
    commands: latest === undefined ? null : {
      renderPass: latest.counters["gpu.commands.renderPass"] ?? 0,
      computePass: latest.counters["gpu.commands.computePass"] ?? 0,
      draw: latest.counters["gpu.commands.draw"] ?? 0,
      dispatch: latest.counters["gpu.commands.dispatch"] ?? 0,
      submits: latest.submits.count
    }
  };
}

function percentiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const get = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)];
  return { p50: get(0.5), p95: get(0.95), p99: get(0.99) };
}

function latestCounterSample(frames, frameBegin, frameEnd) {
  return frames.filter((frame) =>
    frame.frameIndex >= frameBegin && frame.frameIndex < frameEnd &&
    frame.gpuCounters.sampled && !frame.gpuCounters.pending && !frame.gpuCounters.dropped
  ).at(-1)?.gpuCounters.values ?? null;
}

function latestCpuCounter(frames, frameBegin, frameEnd, name) {
  return frames.filter((frame) => frame.frameIndex >= frameBegin && frame.frameIndex < frameEnd)
    .at(-1)?.counters[name] ?? null;
}

function isCompletePair(pair) {
  return pair.off !== null && pair.on !== null;
}

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

function imageSequenceVariance(images) {
  const first = images[0];
  if (first === undefined || images.length < 2) return null;
  let varianceSum = 0;
  let maximumStandardDeviation = 0;
  let sampleCount = 0;
  const x0 = Math.floor(first.width * 0.15);
  const x1 = Math.ceil(first.width * 0.85);
  const y0 = Math.floor(first.height * 0.15);
  const y1 = Math.ceil(first.height * 0.85);
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const offset = (y * first.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        let squared = 0;
        for (const image of images) {
          const value = image.data[offset + channel];
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
  }
  return {
    frameCount: images.length,
    crop: [0.15, 0.15, 0.85, 0.85],
    rmsStandardDeviationRgb8: Math.sqrt(varianceSum / sampleCount),
    maxStandardDeviationRgb8: maximumStandardDeviation
  };
}

function imageSequenceConsecutiveDifference(images) {
  if (images.length < 2) return null;
  return percentiles(images.slice(1).map((image, index) =>
    imageDifference(images[index], image).rmsRgb8
  ));
}

function imageDifference(left, right) {
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error("Temporal sequence images have mismatched dimensions");
  }
  let squared = 0;
  let maximum = 0;
  let count = 0;
  const x0 = Math.floor(left.width * 0.15);
  const x1 = Math.ceil(left.width * 0.85);
  const y0 = Math.floor(left.height * 0.15);
  const y1 = Math.ceil(left.height * 0.85);
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const offset = (y * left.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const delta = left.data[offset + channel] - right.data[offset + channel];
        squared += delta * delta;
        maximum = Math.max(maximum, Math.abs(delta));
        count++;
      }
    }
  }
  return { rmsRgb8: Math.sqrt(squared / count), maxRgb8: maximum };
}

async function screenshotEvidence(filePath, PNG) {
  const bytes = await readFile(filePath);
  const png = PNG.sync.read(bytes);
  let sum = 0;
  let squared = 0;
  let count = 0;
  for (let y = 0; y < png.height; y += 2) {
    for (let x = 0; x < png.width; x += 2) {
      const offset = (y * png.width + x) * 4;
      const luma = png.data[offset] * 0.2126 + png.data[offset + 1] * 0.7152 + png.data[offset + 2] * 0.0722;
      sum += luma;
      squared += luma * luma;
      count++;
    }
  }
  const mean = sum / count;
  return {
    bytes: bytes.byteLength,
    width: png.width,
    height: png.height,
    meanLuma: mean,
    standardDeviation: Math.sqrt(Math.max(0, squared / count - mean * mean))
  };
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
