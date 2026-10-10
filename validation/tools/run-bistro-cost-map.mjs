import { createServer } from "../node_modules/vite/dist/node/index.js";
import { chromium } from "../node_modules/playwright-core/index.mjs";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index < 0 ? fallback : args[index + 1]; };
const out = resolve(root, option("out", ".local/validation/bistro-cost-map-before"));
const width = Number(option("width", "1920")), height = Number(option("height", "1080"));
const samples = Number(option("samples", "120")), warmup = Number(option("warmup", "30"));
const motions = option("motions", "static").split(",");
const variants = option("variants", "on-latency").split(",");
if (variants.some(variant => !/^(on|off)-(latency|throughput)(-repeat)?$/.test(variant)))
  throw new Error("Invalid architecture/scheduling variant");
for (const value of [width, height, samples, warmup]) if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid capture dimensions/count");
if (motions.some(motion => !["static", "slow", "fast"].includes(motion))) throw new Error("Invalid motion");
await mkdir(out, { recursive: true });
const fingerprint = {};
const paths = execFileSync("rg", ["--files", "OEngine/src", "validation/labs/bistro-cost-map", "examples/demos/14-integrated/bistro-texture-compression"], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/).filter(path => /\.(ts|mjs|html|css)$/.test(path));
for (const path of paths) fingerprint[path.replaceAll("\\", "/")] = createHash("sha256").update(await readFile(resolve(root, path))).digest("hex");
const report = { revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  startedAt: new Date().toISOString(), width, height, samples, warmup, browser: null, captures: [], sensors: [], errors: [], fingerprint };
function sensor() {
  try { report.sensors.push({ at: new Date().toISOString(), csv: execFileSync("nvidia-smi", ["--query-gpu=name,pci.device_id,memory.total,memory.used,driver_version,temperature.gpu,clocks.current.graphics,utilization.gpu,power.draw", "--format=csv,noheader"], { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim() }); }
  catch (error) { report.sensors.push({ error: String(error) }); }
}
const server = await createServer({ configFile: resolve(root, "examples/vite.config.ts"), clearScreen: false,
  server: { host: "127.0.0.1", port: Number(option("port", "4182")), strictPort: true, fs: { allow: [root] } } });
let browser;
try {
  sensor(); await server.listen();
  browser = await chromium.launch({ executablePath: option("chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe"), headless: !args.includes("--headed"),
    ignoreDefaultArgs: ["--enable-unsafe-swiftshader", "--no-sandbox", "--unsafely-disable-devtools-self-xss-warnings"] });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(String(error)));
  page.on("console", event => { if (event.type() === "error") report.errors.push(event.text()); });
  await page.goto(`${server.resolvedUrls.local[0]}demos/14-integrated/bistro-texture-compression/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const report = window.bistroDemo?.report();
    return !!report && (report.failure || report.load.fullQualityMs !== null);
  }, undefined, { timeout: 240000 });
  const readiness = await page.evaluate(() => ({ failure: window.bistroDemo.report().failure, phase: window.bistroDemo.report().phase }));
  if (readiness.failure) throw new Error(JSON.stringify(readiness));
  console.log("Bistro loaded", readiness);
  const moduleUrl = `/@fs/${resolve(root, "validation/labs/bistro-cost-map/capture.mjs").replaceAll("\\", "/")}`;
  await page.evaluate(async url => { const module = await import(url); window.__bistroCostMap = await module.install(); }, moduleUrl);
  report.settlement = await page.evaluate(request => window.__bistroCostMap.settle(request), { width, height });
  console.log("Geometry settled", { submitted: report.settlement.submitted });
  for (const variant of variants) {
  for (const motion of motions) {
    for (const timing of [false, true]) {
      console.log(`Capture ${motion} ${timing ? "GPU full" : "CPU normal"}`); sensor();
      const capture = await page.evaluate(request => window.__bistroCostMap.capture(request), { width, height, samples, warmup, motion, timing, variant,
        hzbRecovery: variant.startsWith("on-"), admissionProfile: variant.includes("throughput") ? "throughput" : "latency" });
      report.captures.push(capture); sensor();
      await writeFile(resolve(out, `${variant}-${motion}-${timing ? "gpu" : "cpu"}.json`), JSON.stringify(capture, null, 2));
      console.log(JSON.stringify({ motion, timing, cpu: capture.cpu, gpu: capture.gpuCommandSpan, entropy: { ...capture.entropy, materialPrograms: undefined }, diagnostics: capture.diagnostics }));
    }
  }
  }
  await page.screenshot({ path: resolve(out, "bistro.png") });
  await page.evaluate(async () => { window.__bistroCostMap.dispose(); await window.bistroDemo.release(); });
} catch (error) { report.errors.push(String(error)); console.error(error); process.exitCode = 1; }
finally {
  await browser?.close(); await server.close(); sensor();
  report.sourceChanged = [];
  for (const [path, hash] of Object.entries(fingerprint)) if (createHash("sha256").update(await readFile(resolve(root, path))).digest("hex") !== hash) report.sourceChanged.push(path);
  if (report.sourceChanged.length) { report.errors.push("Source changed during capture"); process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(out, "suite.json"), JSON.stringify(report, null, 2));
  if (report.errors.length) process.exitCode = 1;
  console.log(`Artifacts: ${out}`);
}
