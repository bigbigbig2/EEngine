import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.OENGINE_RENDERING_LAB_BASE_URL ?? "http://127.0.0.1:5173";
const browser = await chromium.launch({
  channel: "chrome",
  headless: process.env.OENGINE_HEADLESS !== "false",
  args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"]
});
const page = await browser.newPage();
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

try {
  await page.goto(`${baseUrl}/rendering-lab/visibility-key-oracle.html`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000
  });
  await page.waitForFunction(
    () => document.body.dataset.state === "ready" || document.body.dataset.state === "failed",
    null,
    { timeout: 120_000 }
  );
  const outcome = await page.evaluate(() => ({
    state: document.body.dataset.state,
    report: window.__OENGINE_VISIBILITY_KEY_ORACLE__,
    error: window.__OENGINE_VISIBILITY_KEY_ORACLE_ERROR__
  }));
  assert.equal(outcome.state, "ready", outcome.error ?? JSON.stringify(outcome.report));
  assert.equal(outcome.report?.mismatchCount, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(outcome.report, null, 2));
} finally {
  await browser.close();
}
