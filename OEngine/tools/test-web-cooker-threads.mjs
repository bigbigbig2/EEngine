// Focused actual browser artifact oracle; no GPU renderer/production path.
// Run after fresh build:test. Portable and pthread 1/4 concurrency must match.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { verifyTestBuild } from "../../tools/test-build.mjs";
import * as abi from "../.test-dist/assets/web-cook/wasm/WebGeometryCookerAbi.js";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
await verifyTestBuild(repositoryRoot);
const side = 97,
  values = [],
  indices = [];
for (let y = 0; y < side; y++)
  for (let x = 0; x < side; x++)
    values.push(x, y, 0, 0, 0, 1, 1, 0, 0, 1, x / 96, y / 96, x / 96, y / 96, 1, 1, 1, 1);
for (let y = 0; y < 96; y++)
  for (let x = 0; x < 96; x++) {
    const a = y * side + x;
    indices.push(a, a + 1, a + side, a + 1, a + side + 1, a + side);
  }
const domains = Array.from({ length: 4 }, (_, materialId) => ({
  materialId,
  meshletFlags: 1,
  attributeMask: 63,
  generateNormals: false,
  vertices: new Float32Array(values),
  indices: new Uint32Array(indices)
}));
const canonical = new Uint8Array(abi.encodeWebCanonicalGeometryV1(domains));
const recipe = new Uint8Array(abi.encodeWebGeometryCookRecipeV1());
const { chromium } = createRequire(resolve(repositoryRoot, "validation/package.json"))("playwright-core");
const worker = `
self.onmessage=async ({data})=>{
 try {
 Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>data.concurrency});
 const abi=await import('/OEngine/.test-dist/assets/web-cook/wasm/WebGeometryCookerAbi.js');
 const path='/OEngine/src/assets/web-cook/wasm/vendor/'+(data.threads?'threads/':'')+'oengine-web-geometry-cooker.mjs';
 const Module=(await import(path)).default;
 const module=await Module({locateFile:(name)=>new URL(name,new URL(path,self.location)).href});
 const canonical=await (await fetch('/canonical.bin')).arrayBuffer();
 const recipe=await (await fetch('/recipe.bin')).arrayBuffer();
 const result=abi.cookWebGeometryWasmV1(module,canonical,recipe,64*1024*1024);
 const sections=result.descriptorSections(), hashes={};
 const hash=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',v))).map(x=>x.toString(16).padStart(2,'0')).join('');
 for(const [key,value] of Object.entries(sections))hashes[key]=await hash(value);
 const pages=[];for(let p=0;p<result.pageCount;p++)pages.push(await hash(result.copyPage(p)));
 result.release();postMessage({ok:true,concurrency:data.concurrency,threads:data.threads,hashes,pages});
 }catch(error){postMessage({ok:false,error:String(error.stack??error)});}
};`;
const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end("<!DOCTYPE html><title>G2.2 determinism</title>");
    return;
  }
  if (path === "/worker.mjs") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(worker);
    return;
  }
  if (path === "/canonical.bin" || path === "/recipe.bin") {
    res.setHeader("Content-Type", "application/octet-stream");
    res.end(path === "/canonical.bin" ? canonical : recipe);
    return;
  }
  if (
    !["/OEngine/.test-dist/", "/OEngine/src/assets/web-cook/wasm/vendor/"].some((p) => path.startsWith(p)) ||
    path.includes("..")
  ) {
    res.statusCode = 404;
    res.end();
    return;
  }
  try {
    const file = resolve(repositoryRoot, "." + decodeURIComponent(path));
    res.setHeader(
      "Content-Type",
      extname(file) === ".wasm"
        ? "application/wasm"
        : extname(file) === ".bin"
          ? "application/octet-stream"
          : "text/javascript"
    );
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let browser;
const report = { legs: [], passed: false };
try {
  browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true
  });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:" + server.address().port);
  for (const config of [
    { threads: false, concurrency: 1 },
    { threads: true, concurrency: 1 },
    { threads: true, concurrency: 4 }
  ]) {
    const leg = await page.evaluate(
      (config) =>
        new Promise((resolve) => {
          const worker = new Worker("/worker.mjs", { type: "module" });
          const timer = setTimeout(() => {
            worker.terminate();
            resolve({ ok: false, error: "worker initialization/cook timeout" });
          }, 45000);
          worker.onmessage = (e) => {
            clearTimeout(timer);
            worker.terminate();
            resolve(e.data);
          };
          worker.onerror = (e) => {
            clearTimeout(timer);
            worker.terminate();
            resolve({ ok: false, error: e.message });
          };
          worker.postMessage(config);
        }),
      config
    );
    report.legs.push({ ...config, ...leg });
  }
  report.passed =
    report.legs.every((l) => l.ok) &&
    report.legs.every(
      (l) =>
        JSON.stringify(l.hashes) === JSON.stringify(report.legs[0].hashes) &&
        JSON.stringify(l.pages) === JSON.stringify(report.legs[0].pages)
    );
} finally {
  try {
    await browser?.close();
  } finally {
    await new Promise((r) => server.close(r));
    console.log(JSON.stringify(report));
  }
}
console.log(
  JSON.stringify({
    passed: report.passed,
    legs: report.legs.map(({ hashes, pages, ...leg }) => ({ ...leg, pageCount: pages?.length }))
  })
);
process.exitCode = report.passed ? 0 : 1;
