import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { VALIDATION_FIXTURE_KEY } from "../validation/fixture-contract.mjs";
import { collectBrowserErrors, hasBrowserErrors } from "./browser-errors.mjs";
import { chromeLaunchCandidates } from "./chrome-resolver.mjs";
import { startValidationServer } from "./vite-server.mjs";
import {
  aggregateStatus,
  validateScenarioResult,
  validateSnapshot
} from "./result.mjs";

export async function runValidationCases(options) {
  const {
    examplesRoot,
    cases,
    outputRoot,
    allowChromiumFallback = false,
    headless = process.env.OENGINE_HEADLESS !== "false"
  } = options;
  await mkdir(outputRoot, { recursive: true });
  const runner = await createChromeRunner({ examplesRoot, allowChromiumFallback, headless });
  if (runner === null || (cases.some((entry) => entry.requirements.localChrome) && !runner.browserIdentity.realChrome)) {
    const reason = runner === null
      ? "No usable Chrome installation was found"
      : `Only non-Chrome fallback '${runner.browserIdentity.label}' is available`;
    if (runner !== null) await runner.close();
    const results = [];
    for (const validationCase of cases) {
      const result = infrastructureResult(validationCase, "inconclusive", reason);
      results.push(result);
      await writeCaseResult(outputRoot, validationCase.id, result);
    }
    return writeSummary(outputRoot, { browser: null, results });
  }

  const results = [];
  try {
    for (const validationCase of cases) {
      results.push(await runCase({
        runner,
        baseUrl: runner.baseUrl,
        validationCase,
        outputRoot
      }));
    }
  } finally {
    await runner.close();
  }
  return writeSummary(outputRoot, {
    browser: runner.browserIdentity,
    baseUrl: runner.baseUrl,
    results
  });
}

async function runCase({ runner, baseUrl, validationCase, outputRoot }) {
  const caseOutput = path.join(outputRoot, validationCase.id);
  await mkdir(caseOutput, { recursive: true });
  const session = await runner.createPage({ viewport: { width: 1280, height: 720 } });
  const { page, errors } = session;
  const startedAt = Date.now();
  const runId = `${validationCase.id}-${startedAt}-${crypto.randomUUID()}`;
  let snapshot = null;
  let scenarioResult = null;
  let failure = null;
  let canvasCaptured = false;
  let pageCaptured = false;
  try {
    await page.goto(new URL(validationCase.route, `${baseUrl}/`).toString(), {
      waitUntil: "domcontentloaded",
      timeout: validationCase.timeoutMs
    });
    await page.waitForFunction(
      ({ bridgeKey }) => {
        const bridge = window[bridgeKey];
        if (bridge === undefined) return false;
        const current = bridge.getSnapshot();
        return current.status !== "booting";
      },
      { bridgeKey: VALIDATION_FIXTURE_KEY },
      { timeout: validationCase.timeoutMs }
    );
    snapshot = await page.evaluate((bridgeKey) => window[bridgeKey]?.getSnapshot() ?? null, VALIDATION_FIXTURE_KEY);
    const snapshotErrors = validateSnapshot(snapshot, validationCase.fixture);
    if (snapshotErrors.length > 0) throw new Error(snapshotErrors.join("; "));
    if (snapshot.status !== "ready") {
      throw new Error(`Fixture '${validationCase.fixture}' entered '${snapshot.status}' before the scenario`);
    }
    scenarioResult = await page.evaluate(
      ({ bridgeKey, request }) => window[bridgeKey].runScenario(request),
      {
        bridgeKey: VALIDATION_FIXTURE_KEY,
        request: { runId, scenarioId: validationCase.scenario }
      }
    );
    const resultErrors = validateScenarioResult(scenarioResult, validationCase, runId);
    if (resultErrors.length > 0) throw new Error(resultErrors.join("; "));
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    const shouldCaptureCanvas = validationCase.screenshot === "always" ||
      failure !== null || scenarioResult?.status !== "passed";
    if (shouldCaptureCanvas) {
      canvasCaptured = await page.locator("canvas").first().screenshot({
        path: path.join(caseOutput, "canvas.png")
      }).then(() => true).catch(() => false);
    }
    if (failure !== null || scenarioResult?.status !== "passed" || hasBrowserErrors(errors)) {
      pageCaptured = await page.screenshot({ path: path.join(caseOutput, "page.png"), fullPage: true })
        .then(() => true).catch(() => false);
    }
    await page.evaluate(async (bridgeKey) => {
      await window[bridgeKey]?.dispose();
    }, VALIDATION_FIXTURE_KEY).catch(() => undefined);
    await session.close();
  }

  let status = scenarioResult?.status ?? "failed";
  const reasons = [];
  if (failure !== null) reasons.push(failure);
  if (hasBrowserErrors(errors)) reasons.push("Browser errors were captured");
  if (scenarioResult?.assertions?.some((assertion) => !assertion.passed)) {
    reasons.push("One or more fixture assertions failed");
  }
  const diagnostics = scenarioResult?.diagnostics ?? snapshot?.diagnostics;
  if (diagnostics !== undefined && (
    diagnostics.validationErrorCount > 0 ||
    diagnostics.uncapturedErrorCount > 0 ||
    diagnostics.deviceLostCount > 0 ||
    (diagnostics.failedGpuCounterSamples ?? 0) > 0
  )) {
    reasons.push("GPU diagnostics reported an error");
  }
  if (reasons.length > 0) status = "failed";

  const result = {
    schemaVersion: 1,
    caseId: validationCase.id,
    status,
    durationMs: Date.now() - startedAt,
    browser: {
      ...runner.browserIdentity
    },
    snapshot,
    scenario: scenarioResult,
    errors,
    reasons,
    artifacts: {
      caseDirectory: caseOutput,
      canvasScreenshot: canvasCaptured ? path.join(caseOutput, "canvas.png") : null,
      failureScreenshot: pageCaptured ? path.join(caseOutput, "page.png") : null
    }
  };
  await writeCaseResult(outputRoot, validationCase.id, result);
  return result;
}

export async function createChromeRunner({
  examplesRoot,
  allowChromiumFallback = false,
  headless = process.env.OENGINE_HEADLESS !== "false"
} = {}) {
  const candidates = await chromeLaunchCandidates({ allowChromiumFallback });
  let launch = null;
  for (const candidate of candidates) {
    try {
      const browser = await chromium.launch({
        ...candidate.launchOptions,
        headless
      });
      launch = { browser, candidate };
      break;
    } catch {
      // Try the next explicitly classified candidate. The chosen environment is
      // recorded in the result and Chromium fallback is never called Chrome.
    }
  }
  if (launch === null) return null;

  const { browser, candidate } = launch;
  let server = null;
  try {
    if (examplesRoot !== undefined) server = await startValidationServer(examplesRoot);
  } catch (error) {
    await browser.close();
    throw error;
  }
  let closed = false;
  return Object.freeze({
    baseUrl: server?.baseUrl ?? null,
    browserIdentity: Object.freeze({
      id: candidate.id,
      label: candidate.label,
      realChrome: candidate.realChrome
    }),
    async createPage({ viewport = { width: 1280, height: 720 } } = {}) {
      if (closed) throw new Error("ChromeRunner is closed");
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
      try {
          const page = await context.newPage();
          const errors = collectBrowserErrors(page);
          let pageClosed = false;
          return Object.freeze({
            page,
            errors,
            async close() {
              if (pageClosed) return;
              pageClosed = true;
              await context.close();
            }
          });
      } catch (error) {
        await context.close();
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await browser.close();
      } finally {
        await server?.close();
      }
    }
  });
}

function infrastructureResult(validationCase, status, reason) {
  return {
    schemaVersion: 1,
    caseId: validationCase.id,
    status,
    durationMs: 0,
    browser: null,
    snapshot: null,
    scenario: null,
    errors: { console: [], page: [], request: [] },
    reasons: [reason],
    artifacts: {}
  };
}

async function writeCaseResult(outputRoot, caseId, result) {
  const directory = path.join(outputRoot, caseId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
}

async function writeSummary(outputRoot, data) {
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: aggregateStatus(data.results),
    browser: data.browser,
    ...(data.baseUrl === undefined ? {} : { baseUrl: data.baseUrl }),
    results: data.results
  };
  await writeFile(path.join(outputRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}
