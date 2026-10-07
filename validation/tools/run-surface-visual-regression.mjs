import { createServer } from "../node_modules/vite/dist/node/index.js";
import { chromium } from "../node_modules/playwright-core/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Explicit diagnostic against the production showcase, using an isolated browser.
const root = process.cwd();
const out = resolve(root, process.argv[2] ?? ".local/validation/native-surface-visual");
await mkdir(out, { recursive: true });
const server = await createServer({ configFile: resolve(root, "examples/vite.config.ts"),
  clearScreen: false, server: { host: "127.0.0.1", port: 4182, strictPort: true,
    hmr: false, watch: { ignored: ["**"] } } });
const report = { evidenceRole: "diagnostic", accepted: false, passed: false,
  headless: process.argv.includes("--headless"), browser: null, progress: [], errors: [], shots: [] };
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: report.headless,
    args: ["--enable-unsafe-webgpu"] });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  if (process.argv.includes("--vsm")) {
    await page.addInitScript(() => {
      globalThis.__surfaceDiagnostic = { vsm: true, mode: "timing", pipelineInitialization: "native-production" };
    });
  }
  page.on("pageerror", error => report.errors.push(String(error)));
  page.on("console", message => { if (message.type() === "error") report.errors.push(message.text()); });
  await page.goto("http://127.0.0.1:4182/demos/14-integrated/next-renderer-showcase/");
  await page.waitForFunction(() => !!globalThis.__eengineShowcase);
  await page.locator("#start-scene").click();
  for (let poll = 0; poll < 90; poll++) {
    const progress = await page.evaluate(() => ({ ready: globalThis.__eengineShowcase.ready,
      failed: globalThis.__eengineShowcase.failed, runtime: globalThis.__eengineShowcase.runtime }));
    report.progress.push(progress);
    await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2));
    if (progress.ready || progress.failed) break;
    console.log(`Initializing Chrome: frame ${progress.runtime.frameCount}`);
    try {
      await page.waitForFunction(() => globalThis.__eengineShowcase.ready || globalThis.__eengineShowcase.failed,
        undefined, { timeout: 10000 });
    } catch (error) { if (error.name !== "TimeoutError") throw error; }
  }
  if (await page.evaluate(() => globalThis.__eengineShowcase.failed)) {
    throw new Error("Production showcase failed before its first GPU completion");
  }
  if (!await page.evaluate(() => globalThis.__eengineShowcase.ready)) {
    throw new Error("Production showcase did not finish its first GPU frame within the host wait budget");
  }
  const advance = async count => {
    const start = await page.evaluate(() => globalThis.__eengineShowcase.runtime.frameCount);
    await page.waitForFunction(end => globalThis.__eengineShowcase.runtime.frameCount >= end, start + count, { timeout: 120000 });
  };
  const shot = async name => {
    await page.screenshot({ path: resolve(out, `${name}.png`) });
    const state = await page.evaluate(() => ({ ...globalThis.__eengineShowcase.runtime,
      adapter: globalThis.__eengineShowcase.adapter,
      completed: globalThis.__eengineShowcase.profiles.filter(p => p.gpu.sampled && !p.gpu.pending).slice(-20) }));
    report.shots.push({ name, state });
    console.log(`SCREENSHOT ${name}: frame ${state.frameCount}`);
    await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2));
  };
  await advance(20); await shot("01-static");
  await page.locator("#panel-toggle").click();
  await page.getByText("自动旋转", { exact: true }).click();
  if (!await page.locator("#toggle-rotate").isChecked()) throw new Error("Auto rotation did not start");
  await page.locator("#panel-toggle").click();
  await advance(16); await shot("02-moving");
  await page.locator("#panel-toggle").click();
  await page.getByText("自动旋转", { exact: true }).click();
  if (await page.locator("#toggle-rotate").isChecked()) throw new Error("Auto rotation did not stop");
  await page.locator("#panel-toggle").click();
  await advance(20); await shot("03-after-motion");
  await page.locator("#panel-toggle").click();
  await page.locator("#geometry-debug-view").selectOption({ label: "Meshlet" });
  await page.locator("#panel-toggle").click();
  await advance(5); await shot("04-meshlet");
  await page.locator("#panel-toggle").click();
  await page.locator("#geometry-debug-view").selectOption({ label: "正常" });
  await page.locator("#panel-toggle").click();
  await advance(12);
  await page.mouse.move(640, 410); await page.mouse.wheel(0, -420);
  await advance(20); await shot("05-near");
  await page.setViewportSize({ width: 1440, height: 810 });
  await page.waitForFunction(() => {
    const canvas = document.querySelector("#viewport");
    return canvas.width === 1440 && canvas.height === 810;
  });
  await advance(15); await shot("06-resize");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForFunction(() => document.querySelector("#viewport").width === 1280);
  await advance(15); await shot("07-return-resize");
  await page.locator("#panel-toggle").click();
  await page.locator("#sun-intensity").fill("0.2");
  await page.locator("#sun-intensity").dispatchEvent("input");
  await page.locator("#panel-toggle").click();
  await advance(15); await shot("08-sun-edit");
  await page.locator("#panel-toggle").click();
  await page.locator("#sun-intensity").fill("1.5");
  await page.locator("#sun-intensity").dispatchEvent("input");
  await page.locator("#panel-toggle").click();
  await advance(15); await shot("09-sun-restored");
  await page.evaluate(() => globalThis.__eengineShowcase.dispose());
  await context.close();
  report.passed = report.shots.length === 9 && report.errors.length === 0;
} catch (error) { report.errors.push(String(error)); }
finally {
  await browser?.close(); await server.close();
  await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Artifacts: ${out}`);
  if (report.errors.length) { console.error(report.errors); process.exitCode = 1; }
}
