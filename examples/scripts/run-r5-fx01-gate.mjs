import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  captureGitBuildProvenance,
  evaluateBuildProvenance,
  evaluateDiagnosticSnapshots,
  velocityTilesAreZero
} from "./r5-fx01-gate-contract.mjs";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const playwrightRoot = path.join(
  repoRoot,
  "temp/browser-tools/node_modules/playwright-core"
);
const WIDTH = 960;
const HEIGHT = 720;
const VIEWS = Object.freeze([
  "Depth",
  "Normal",
  "Metallic",
  "Roughness",
  "Albedo",
  "AO",
  "Emissive",
  "Velocity",
  "Reactive",
  "MaterialId",
  "HistoryValidity"
]);
const TILE_CENTERS = Object.freeze([
  { material: "dielectric rough", x: 341, y: 182 },
  { material: "dielectric smooth", x: 618, y: 182 },
  { material: "metallic rough", x: 341, y: 359 },
  { material: "metallic smooth", x: 618, y: 359 },
  { material: "emissive", x: 341, y: 536 },
  { material: "unlit motion-invalid", x: 618, y: 536 }
]);

const currentBuild = captureGitBuildProvenance(repoRoot);
const commit = currentBuild.commit;
const requireClean = process.env.FX01_REQUIRE_CLEAN !== "0";
const artifactId = currentBuild.dirty
  ? `${commit}-dirty-${currentBuild.contentHash.slice(0, 12)}`
  : commit;
const outputRoot = path.join(repoRoot, "temp/r5/fx-01", artifactId);
const baseUrl = process.env.OENGINE_EXAMPLES_URL ?? "http://127.0.0.1:5174";
const chromePath = process.env.CHROME_PATH ??
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

let browser = null;
let browserVersion = "unavailable";
let page = null;
let PNG = null;
let pageResult = null;
const captures = [];
let emissiveOn = null;
let emissiveOff = null;
let finalLightOn = null;
let finalLightOff = null;
const consoleMessages = [];
const pageErrors = [];
const fatalErrors = [];

try {
  if (!existsSync(path.join(playwrightRoot, "index.mjs"))) {
    throw new Error(
      "FX-01 browser Gate requires temp/browser-tools/node_modules/playwright-core"
    );
  }
  const playwright = await import(pathToFileURL(
    path.join(playwrightRoot, "index.mjs")
  ).href);
  ({ PNG } = require(path.join(playwrightRoot, "lib/utilsBundle.js")));
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
  page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
    deviceScaleFactor: 1
  });
  page.on("console", (message) => {
    consoleMessages.push({ type: message.type(), text: message.text() });
  });
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto(`${baseUrl}/r5-surface-debug/`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000
  });
  await page.waitForFunction(
    () => window.__OENGINE_FX_01_RESULT__?.completed === true,
    undefined,
    { timeout: 600_000 }
  );
  pageResult = await page.evaluate(() => window.__OENGINE_FX_01_RESULT__);

  for (const view of VIEWS) captures.push(await captureView(view));

  await page.evaluate(async () => window.__OENGINE_FX_01__.setDirectLight(true));
  emissiveOn = await captureView("Emissive", "emissive-direct-light-on");
  await page.evaluate(async () => window.__OENGINE_FX_01__.setDirectLight(false));
  emissiveOff = await captureView("Emissive", "emissive-direct-light-off");

  finalLightOn = await captureFinalLighting(true);
  finalLightOff = await captureFinalLighting(false);
  await page.screenshot({
    path: path.join(outputRoot, "screenshot-page.png"),
    fullPage: true
  });
} catch (error) {
  fatalErrors.push(serializeError(error));
} finally {
  if (browser !== null) {
    try {
      await browser.close();
    } catch (error) {
      fatalErrors.push(`browser close failed: ${serializeError(error)}`);
    }
  }
}

const screenshotMetrics = evaluateScreenshots(
  captures,
  emissiveOn,
  emissiveOff,
  finalLightOn,
  finalLightOff
);
const buildProvenance = evaluateBuildProvenance(pageResult?.build, currentBuild);
const diagnosticSnapshots = collectDiagnosticSnapshots();
const diagnosticEvaluation = evaluateDiagnosticSnapshots(diagnosticSnapshots);
const consoleErrors = consoleMessages.filter((message) => message.type === "error");
const cleanEligible = !currentBuild.dirty;
const gateEligible = cleanEligible && buildProvenance.passed;
const cleanRequirementPassed = !requireClean || cleanEligible;
const passed = fatalErrors.length === 0 &&
  pageResult?.passed === true &&
  buildProvenance.passed &&
  diagnosticEvaluation.passed &&
  screenshotMetrics.passed &&
  consoleErrors.length === 0 &&
  pageErrors.length === 0 &&
  cleanRequirementPassed;
const gate = {
  schemaVersion: 2,
  taskId: "FX-01",
  completed: true,
  passed,
  gateEligible,
  cleanEligible,
  cleanRequirementPassed,
  requireClean,
  issues: [
    ...fatalErrors.map((message) => `fatal: ${message}`),
    ...(pageResult?.passed === true ? [] : ["page result failed"]),
    ...buildProvenance.issues,
    ...diagnosticEvaluation.issues,
    ...(screenshotMetrics.passed ? [] : screenshotMetrics.issues),
    ...(consoleErrors.length === 0 ? [] : [`console errors: ${consoleErrors.length}`]),
    ...(pageErrors.length === 0 ? [] : [`page errors: ${pageErrors.length}`]),
    ...(cleanRequirementPassed ? [] : ["clean Gate requested with a dirty worktree"])
  ]
};
const environment = {
  commit,
  dirty: currentBuild.dirty,
  dirtyReasons: currentBuild.dirtyReasons,
  contentHash: currentBuild.contentHash,
  pageBuild: pageResult?.build ?? null,
  buildProvenance,
  capturedAt: new Date().toISOString(),
  os: `${os.platform()} ${os.release()} ${os.arch()}`,
  browser: browserVersion,
  chromePath,
  adapter: pageResult?.production?.gpu?.adapter ?? null,
  webgpu: pageResult?.production?.gpu === undefined
    ? null
    : {
      features: pageResult.production.gpu.features,
      limits: pageResult.production.gpu.limits
    },
  canvas: { width: WIDTH, height: HEIGHT, dpr: 1 },
  featureSet: "FX-01 Surface debug + background",
  cadence: {
    performanceSampling: "not applicable; focused correctness Gate",
    renderFramesPerView: 3,
    independentSessions: 1
  }
};
const sequence = {
  orderedViews: captures.map((capture) => ({
    view: capture.view,
    frame: capture.render.frame,
    sha256: capture.metrics.sha256,
    passed: capture.passed
  })),
  emissiveAttachmentDirectLightToggle: lightSequenceEntry(
    emissiveOn,
    emissiveOff,
    screenshotMetrics.emissiveAttachmentDifference,
    screenshotMetrics.emissiveAttachmentInvariant
  ),
  finalLightingDirectLightToggle: lightSequenceEntry(
    finalLightOn,
    finalLightOff,
    {
      unlit: screenshotMetrics.finalUnlitDifference,
      litControl: screenshotMetrics.finalLitControlDifference
    },
    screenshotMetrics.finalLitControlResponds
  )
};

await writeGateArtifacts({
  environment,
  console: { consoleMessages, pageErrors, fatalErrors },
  result: { gate, buildProvenance, diagnosticEvaluation, pageResult },
  graph: pageResult?.production?.graphEvidence ?? null,
  counters: {
    queueCounters: "not applicable; FX-01 creates no GPU work queue",
    diagnosticSnapshots,
    diagnosticEvaluation,
    numericChecks: pageResult?.numeric?.checks ?? null
  },
  screenshotMetrics,
  sequence
});

process.stdout.write(`${JSON.stringify({ gate, outputRoot }, null, 2)}\n`);
if (!passed) process.exitCode = 1;

async function captureView(view, fileStem = view.toLowerCase()) {
  const render = await page.evaluate(
    async (requestedView) => window.__OENGINE_FX_01__.renderView(requestedView),
    view
  );
  const bytes = await captureCanvasScreenshot(`screenshot-canvas-${fileStem}.png`);
  const metrics = analyzePng(bytes);
  const checks = evaluateView(view, metrics);
  return {
    view,
    render,
    pngBytes: bytes,
    metrics,
    checks,
    passed: Object.values(checks).every(Boolean)
  };
}

async function captureFinalLighting(enabled) {
  const render = await page.evaluate(
    async (directLightEnabled) =>
      window.__OENGINE_FX_01__.setDirectLight(directLightEnabled),
    enabled
  );
  const fileName = enabled
    ? "screenshot-canvas-final-direct-light-on.png"
    : "screenshot-canvas-final-direct-light-off.png";
  const bytes = await captureCanvasScreenshot(fileName);
  return {
    enabled,
    render,
    pngBytes: bytes,
    metrics: analyzePng(bytes)
  };
}

function collectDiagnosticSnapshots() {
  const snapshots = [{
    label: "initial production fixture",
    diagnostics: pageResult?.production?.diagnostics ?? null
  }];
  for (const capture of captures) {
    snapshots.push({ label: `debug view ${capture.view}`, diagnostics: capture.render.diagnostics });
  }
  for (const [label, capture] of [
    ["emissive direct light on", emissiveOn],
    ["emissive direct light off", emissiveOff],
    ["final direct light on", finalLightOn],
    ["final direct light off", finalLightOff]
  ]) {
    if (capture !== null) snapshots.push({ label, diagnostics: capture.render.diagnostics });
  }
  return snapshots;
}

function analyzePng(bytes) {
  const png = PNG.sync.read(bytes);
  let backgroundPixels = 0;
  let opaquePixels = 0;
  let maxChannel = 0;
  let sumLuma = 0;
  let sumLumaSquared = 0;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const r = png.data[offset];
    const g = png.data[offset + 1];
    const b = png.data[offset + 2];
    const a = png.data[offset + 3];
    if (r <= 2 && g <= 2 && b <= 2) backgroundPixels += 1;
    if (a === 255) opaquePixels += 1;
    maxChannel = Math.max(maxChannel, r, g, b);
    const luma = luminance(r, g, b);
    sumLuma += luma;
    sumLumaSquared += luma * luma;
  }
  const pixelCount = png.width * png.height;
  const meanLuma = sumLuma / pixelCount;
  return {
    width: png.width,
    height: png.height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    backgroundRatio: backgroundPixels / pixelCount,
    nonBackgroundCoverage: 1 - backgroundPixels / pixelCount,
    opaqueRatio: opaquePixels / pixelCount,
    maxChannel,
    meanLuma,
    luminanceVariance: sumLumaSquared / pixelCount - meanLuma * meanLuma,
    allBlack: maxChannel <= 2,
    tileSamples: TILE_CENTERS.map((tile) => ({
      ...tile,
      ...sampleRegion(png, tile.x, tile.y, 6)
    }))
  };
}

function sampleRegion(png, centerX, centerY, radius) {
  const sum = [0, 0, 0];
  const minimum = [255, 255, 255];
  const maximum = [0, 0, 0];
  let count = 0;
  for (let y = centerY - radius; y <= centerY + radius; y++) {
    for (let x = centerX - radius; x <= centerX + radius; x++) {
      const offset = (y * png.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const value = png.data[offset + channel];
        sum[channel] += value;
        minimum[channel] = Math.min(minimum[channel], value);
        maximum[channel] = Math.max(maximum[channel], value);
      }
      count += 1;
    }
  }
  const rgb = sum.map((value) => value / count);
  return {
    rgb,
    luminance: luminance(...rgb),
    channelRange: maximum.map((value, channel) => value - minimum[channel])
  };
}

function evaluateView(view, metrics) {
  const tile = metrics.tileSamples;
  const checks = {
    dimensions: metrics.width === WIDTH && metrics.height === HEIGHT,
    backgroundRatio: metrics.backgroundRatio >= 0.25,
    nonBackgroundCoverage: metrics.nonBackgroundCoverage >= 0.02,
    opaque: metrics.opaqueRatio === 1,
    allBlack: metrics.allBlack === false,
    semantic: false
  };
  switch (view) {
    case "Depth":
      checks.semantic = tile.every((sample) => sample.luminance > 5);
      break;
    case "Normal":
      checks.semantic = tile.every((sample) =>
        sample.rgb[2] > sample.rgb[0] + 20 &&
        sample.rgb[2] > sample.rgb[1] + 20 &&
        Math.abs(sample.rgb[0] - sample.rgb[1]) < 5 &&
        sample.channelRange.every((range) => range <= 5));
      break;
    case "Metallic":
      checks.semantic = mean(tile[2].luminance, tile[3].luminance) -
        mean(tile[0].luminance, tile[1].luminance, tile[4].luminance, tile[5].luminance) > 100;
      break;
    case "Roughness":
      checks.semantic = tile[0].luminance - tile[1].luminance > 80 &&
        tile[2].luminance - tile[3].luminance > 80 &&
        tile[5].luminance - tile[4].luminance > 20;
      break;
    case "Albedo":
      checks.semantic = dominant(tile[0], 0) && dominant(tile[1], 1) &&
        dominant(tile[2], 2) && tile[3].rgb[0] > tile[3].rgb[2] &&
        tile[3].rgb[1] > tile[3].rgb[2] && tile[5].luminance < 5;
      break;
    case "AO":
      checks.semantic = tile.every((sample) => sample.luminance > 220);
      break;
    case "Emissive":
      checks.semantic = tile.slice(0, 4).every((sample) => sample.luminance < 5) &&
        tile[4].rgb[0] > tile[4].rgb[1] && tile[4].rgb[1] > tile[4].rgb[2] &&
        tile[5].rgb[2] > tile[5].rgb[0];
      break;
    case "Velocity":
      checks.semantic = velocityTilesAreZero(tile);
      break;
    case "Reactive":
      checks.semantic = tile.slice(0, 5).every((sample) => sample.luminance < 5) &&
        tile[5].rgb[0] > tile[5].rgb[1] + 100;
      break;
    case "MaterialId":
      checks.semantic = new Set(tile.map((sample) =>
        sample.rgb.map((value) => Math.round(value)).join(","))).size === 6;
      break;
    case "HistoryValidity":
      checks.semantic = tile.slice(0, 5).every((sample) =>
        sample.rgb[1] > sample.rgb[0] + 50) &&
        tile[5].rgb[0] > tile[5].rgb[1] + 100;
      break;
    default:
      throw new Error(`Unknown FX-01 view '${view}'`);
  }
  return checks;
}

function evaluateScreenshots(
  viewCaptures,
  directLightEmissiveOn,
  directLightEmissiveOff,
  directLightFinalOn,
  directLightFinalOff
) {
  const required = [
    directLightEmissiveOn,
    directLightEmissiveOff,
    directLightFinalOn,
    directLightFinalOff
  ];
  if (PNG === null || viewCaptures.length !== VIEWS.length || required.includes(null)) {
    return {
      passed: false,
      issues: [
        `incomplete screenshots: views=${viewCaptures.length}/${VIEWS.length}, ` +
          `lightCaptures=${required.filter((value) => value !== null).length}/4`
      ],
      views: viewCaptures.map(({ pngBytes: _pngBytes, ...capture }) => capture)
    };
  }
  const failedViews = viewCaptures.filter((capture) => !capture.passed);
  const distinctViewHashes = new Set(
    viewCaptures.map((capture) => capture.metrics.sha256)
  ).size;
  const emissiveAttachmentDifference = comparePng(
    directLightEmissiveOn.pngBytes,
    directLightEmissiveOff.pngBytes
  );
  const emissiveAttachmentInvariant = isInvariant(emissiveAttachmentDifference);
  const finalUnlitDifference = comparePngRegions(
    directLightFinalOn.pngBytes,
    directLightFinalOff.pngBytes,
    [TILE_CENTERS[5]],
    6
  );
  const finalUnlitInvariant = isInvariant(finalUnlitDifference);
  const finalLitControlDifference = comparePngRegions(
    directLightFinalOn.pngBytes,
    directLightFinalOff.pngBytes,
    TILE_CENTERS.slice(0, 4),
    6
  );
  const finalLitControlResponds =
    finalLitControlDifference.meanAbsoluteChannelDifference >= 1 &&
    finalLitControlDifference.changedPixelRatio >= 0.1;
  const passed = failedViews.length === 0 &&
    distinctViewHashes === VIEWS.length &&
    emissiveAttachmentInvariant &&
    finalLitControlResponds;
  return {
    passed,
    expected: {
      width: WIDTH,
      height: HEIGHT,
      backgroundRatioAtLeast: 0.25,
      distinctViewHashes: VIEWS.length,
      emissiveAttachmentDirectLightInvariant: true,
      finalLitControlResponds: true,
      finalUnlitDirectLightInvariant: "FX-02 gating owner"
    },
    distinctViewHashes,
    emissiveAttachmentInvariant,
    emissiveAttachmentDifference,
    finalUnlitInvariant,
    finalUnlitDifference,
    finalLitControlResponds,
    finalLitControlDifference,
    deferredFindings: finalUnlitInvariant ? [] : [
      "FX-02: legacy Direct Lighting changes the final unlit tile; Lighting source migration owns the fix"
    ],
    views: viewCaptures.map(({ pngBytes: _pngBytes, ...capture }) => capture),
    issues: [
      ...failedViews.map((capture) => `screenshot failed: ${capture.view}`),
      ...(distinctViewHashes === VIEWS.length ? [] : [
        `debug views collapsed: ${distinctViewHashes}/${VIEWS.length} distinct hashes`
      ]),
      ...(emissiveAttachmentInvariant ? [] : [
        "emissive Surface attachment changed with direct light"
      ]),
      ...(finalLitControlResponds ? [] : [
        "final lit control tiles did not respond to the direct-light toggle"
      ])
    ]
  };
}

function isInvariant(difference) {
  return difference.dimensionsEqual &&
    difference.meanAbsoluteChannelDifference <= 0.01 &&
    difference.changedPixelRatio <= 0.0001;
}

function dominant(sample, channel) {
  const others = sample.rgb.filter((_, index) => index !== channel);
  return sample.rgb[channel] > Math.max(...others) + 20;
}

function mean(...values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function comparePng(leftBytes, rightBytes) {
  const left = PNG.sync.read(leftBytes);
  const right = PNG.sync.read(rightBytes);
  return compareDecodedPng(left, right, null);
}

function comparePngRegions(leftBytes, rightBytes, centers, radius) {
  const left = PNG.sync.read(leftBytes);
  const right = PNG.sync.read(rightBytes);
  const coordinates = [];
  for (const center of centers) {
    for (let y = center.y - radius; y <= center.y + radius; y++) {
      for (let x = center.x - radius; x <= center.x + radius; x++) {
        coordinates.push([x, y]);
      }
    }
  }
  return compareDecodedPng(left, right, coordinates);
}

function compareDecodedPng(left, right, coordinates) {
  if (left.width !== right.width || left.height !== right.height) {
    return {
      dimensionsEqual: false,
      meanAbsoluteChannelDifference: Number.POSITIVE_INFINITY,
      maxChannelDifference: 255,
      changedPixelRatio: 1
    };
  }
  const pixels = coordinates ?? Array.from(
    { length: left.width * left.height },
    (_, index) => [index % left.width, Math.floor(index / left.width)]
  );
  let absoluteDifference = 0;
  let maxChannelDifference = 0;
  let changedPixels = 0;
  for (const [x, y] of pixels) {
    const offset = (y * left.width + x) * 4;
    let pixelDifference = 0;
    for (let channel = 0; channel < 3; channel++) {
      const difference = Math.abs(
        left.data[offset + channel] - right.data[offset + channel]
      );
      absoluteDifference += difference;
      maxChannelDifference = Math.max(maxChannelDifference, difference);
      pixelDifference = Math.max(pixelDifference, difference);
    }
    if (pixelDifference > 0) changedPixels += 1;
  }
  return {
    dimensionsEqual: true,
    meanAbsoluteChannelDifference: absoluteDifference / (pixels.length * 3),
    maxChannelDifference,
    changedPixelRatio: changedPixels / pixels.length
  };
}

function luminance(r, g, b) {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function lightSequenceEntry(on, off, difference, passedValue) {
  return {
    on: on?.metrics?.sha256 ?? null,
    off: off?.metrics?.sha256 ?? null,
    difference: difference ?? null,
    passed: passedValue === true
  };
}

async function captureCanvasScreenshot(fileName) {
  const previousVisibility = await page.evaluate(() => {
    const sidebar = document.querySelector(".layout > .panel:nth-child(2)");
    if (!(sidebar instanceof HTMLElement)) throw new Error("FX-01 sidebar is missing");
    const previous = sidebar.style.visibility;
    sidebar.style.visibility = "hidden";
    return previous;
  });
  try {
    return await page.locator("#gpu-canvas").screenshot({
      path: path.join(outputRoot, fileName)
    });
  } finally {
    await page.evaluate((visibility) => {
      const sidebar = document.querySelector(".layout > .panel:nth-child(2)");
      if (sidebar instanceof HTMLElement) sidebar.style.visibility = visibility;
    }, previousVisibility);
  }
}

async function writeGateArtifacts(artifacts) {
  await writeJson("environment.json", artifacts.environment);
  await writeJson("console.json", artifacts.console);
  await writeJson("result.json", artifacts.result);
  await writeJson("graph.json", artifacts.graph);
  await writeJson("counters.json", artifacts.counters);
  await writeJson("screenshot-metrics.json", artifacts.screenshotMetrics);
  await writeJson("sequence.json", artifacts.sequence);
}

async function writeJson(filename, value) {
  await writeFile(
    path.join(outputRoot, filename),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8"
  );
}

function serializeError(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}
