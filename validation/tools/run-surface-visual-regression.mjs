import { createServer } from "../node_modules/vite/dist/node/index.js";
import { chromium } from "../node_modules/playwright-core/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Explicit diagnostic against the production showcase, using an isolated browser.
const root = process.cwd();
const out = resolve(root, ".local/validation/surface-v3-visual-fix");
await mkdir(out, { recursive: true });
const server = await createServer({ configFile: resolve(root, "examples/vite.config.ts"),
  clearScreen: false, server: { host: "127.0.0.1", port: 4182, strictPort: true } });
const report = { evidenceRole: "diagnostic", accepted: false, errors: [], shots: [] };
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: false, ignoreDefaultArgs: ["--enable-unsafe-swiftshader", "--no-sandbox", "--unsafely-disable-devtools-self-xss-warnings"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(String(error)));
  page.on("console", message => { if (message.type() === "error") report.errors.push(message.text()); });
  await page.goto("http://127.0.0.1:4182/demos/14-integrated/next-renderer-showcase/");
  await page.waitForFunction(() => !!globalThis.__eengineShowcase);
  await page.evaluate(() => globalThis.__eengineShowcase.start());
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
  await page.evaluate(() => globalThis.__eengineShowcase.dispose());
  await context.close();
} catch (error) { report.errors.push(String(error)); }
finally {
  await browser?.close(); await server.close();
  await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Artifacts: ${out}`);
  if (report.errors.length) { console.error(report.errors); process.exitCode = 1; }
}
