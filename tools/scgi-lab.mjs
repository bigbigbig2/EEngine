import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startStaticServer, defaultAllowPrefixes } from "./gpu-oracle/server.mjs";
import { launchChrome } from "./gpu-oracle/browser.mjs";

const root = resolve(import.meta.dirname, "..");
const server = await startStaticServer({
  root,
  harnessRoot: resolve(root, "tools/gpu-oracle"),
  allowPrefixes: [
    ...defaultAllowPrefixes,
    "OEngine/src/render/assets/",
    "OEngine/src/assets/web-cook/wasm/vendor/"
  ],
  vendorRoots: [resolve(root, "OEngine/node_modules"), resolve(root, "node_modules")]
});
const { chromium } = createRequire(resolve(root, "validation/package.json"))("playwright-core");
const capture = process.argv.includes("--capture");
const chrome = await launchChrome({
  chromium,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: capture,
  extraArgs: ["--enable-features=Vulkan,UseSkiaRenderer", "--enable-unsafe-webgpu"]
});
const page = chrome.page;
page.on("pageerror", (error) => console.error(error));
await page.goto(server.pageUrl("page/scgi-lab.html"));
console.log(`SCGI Lab: ${page.url()}`);
if (capture) {
  try {
    await page.waitForFunction(() => window.__SCGI_READY__, { timeout: 300000 });
    const folder = resolve(root, ".local/scgi9-captures");
    await mkdir(folder, { recursive: true });
    // Render identical Native inputs again for each view. Advancing the world
    // estimator between screenshots would make an on/off comparison ambiguous.
    await page.evaluate(async () => {
      const lab = window.__SCGI_LAB__;
      lab.renderer.fsr3_enabled = false;
      const frame = lab.frame;
      const gi = frame.scgi;
      const device = lab.renderer.device;
      const encoder = device.createCommandEncoder();
      const snapshot = (source) => {
        const buffer = device.createBuffer({
          size: source.size,
          usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        });
        encoder.copyBufferToBuffer(source, 0, buffer, 0, source.size);
        return buffer;
      };
      const fields = gi.publication.candidateWorldField.segments.map((segment) => snapshot(segment.buffer));
      const residuals = gi.gather.residual.map(snapshot);
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      window.__SCGI_REPLAY_VIEW__ = async (mode) => {
        // Keep the normal public display pipeline; freeze producers at their
        // last submitted products for this diagnostic-only screenshot sequence.
        lab.renderer.setSurfaceCacheGiSettings({ debug: mode, gatherFreeze: true });
        const owner = lab.renderer._scgi;
        const encode = owner.encode.bind(owner);
        owner.encode = (next, ...rest) => {
          encode(next, ...rest);
          const command = next.transaction.command;
          const target = next.transaction.publication;
          for (let i = 0; i < target.candidateWorldField.segments.length; i++) {
            const source = fields[i];
            const destination = target.candidateWorldField.segments[i].buffer;
            command.copyBufferToBuffer(source, 0, destination, 0, source.size);
            command.copyBufferToBuffer(residuals[i], 0, next.gather.residual[i], 0, residuals[i].size);
          }
        };
        try {
          await window.__SCGI_DRAW__(1);
        } finally {
          owner.encode = encode;
        }
      };
    });
    for (const mode of [
      "off",
      "appearance-world-only",
      "world-only",
      "irradiance",
      "residual",
      "gather-confidence",
      "gather-source"
    ]) {
      await page.evaluate(async (value) => {
        await window.__SCGI_REPLAY_VIEW__(value);
      }, mode);
      await page.locator("canvas").screenshot({ path: resolve(folder, `${mode}.png`) });
      await writeFile(resolve(folder, `${mode}.json`), await page.locator("#metrics").textContent());
    }
  } finally {
    await chrome.browser.close();
    await server.close();
  }
} else {
  console.log("Close the browser or press Ctrl+C to end.");
  await new Promise((done) => chrome.browser.on("disconnected", done));
  await server.close();
}
