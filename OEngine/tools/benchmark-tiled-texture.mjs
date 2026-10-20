// Diagnostic only: native BC reference transport never enters the product loader.
// Run after build:test; --dist-worker checks build output; --dungeon reads the
// isolated .local/vt-zstd-unit2/dungeon-cooked output, never the old production path.
import { createServer } from "node:http";
import { readFile, stat, readdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { verifyTestBuild } from "../../tools/test-build.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
await verifyTestBuild();
const require = createRequire(resolve(root, "validation/package.json"));
const { chromium } = require("playwright-core");
const distWorker = process.argv.includes("--dist-worker")
  ? (await readdir(resolve(root, "OEngine/dist/assets"))).find((name) =>
      /^cooked-asset-worker-.*\.js$/u.test(name),
    )
  : null;
if (process.argv.includes("--dist-worker") && !distWorker)
  throw new Error("Build the production Worker first");
const cooked = process.argv.includes("--dungeon") ? ".local/vt-zstd-unit2/dungeon-cooked/textures/" : null;
const names = cooked
  ? (await readdir(resolve(root, cooked)))
      .filter((n) => n.endsWith(".vtdirectory"))
      .sort()
      .slice(0, 3)
  : ["occlusion-linear", "base-color-srgb", "normal-linear"];
const fixtures = [];
for (const name of names) {
  const prefix = cooked ?? `OEngine/tests/fixtures/tiled-zstd/${name}/`;
  const directoryName = cooked ? name : "texture.vtdirectory";
  const directoryBytes = await readFile(resolve(root, prefix, directoryName));
  const directory = JSON.parse(directoryBytes);
  const reference = await readFile(resolve(root, prefix, cooked ? directory.pack.uri : "reference.bin"));
  let offset = 0;
  const pages = [];
  for (const p of directory.payloads) {
    const bytes = cooked
      ? p.encoding === "zstd-bc"
        ? zstdDecompressSync(reference.subarray(p.offset, p.offset + p.byteLength))
        : reference.subarray(p.offset, p.offset + p.byteLength)
      : reference.subarray(offset, offset + p.nativeByteLength);
    offset += p.nativeByteLength;
    if (p.encoding === "zstd-bc" && pages.length < 64) pages.push({ id: p.id, bytes });
  }
  fixtures.push({
    name,
    prefix,
    directoryName,
    directoryBytes: directoryBytes.length,
    identity: createHash("sha256").update(directoryBytes).digest("hex"),
    ids: pages.map((p) => p.id),
    sizes: pages.map((p) => p.bytes.length),
    encoded: pages.reduce((s, p) => s + directory.payloads[p.id].byteLength, 0),
    native: Buffer.concat(pages.map((p) => p.bytes)),
  });
}
let rate = Infinity;
let payloadClock = 0;
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<!doctype html><title>VT transport diagnostic</title><script type="importmap">{"imports":{"gl-matrix":"/vendor/gl-matrix/index.js"}}</script>',
      );
      return;
    }
    let bytes;
    const native = /^\/reference\/(\d+)$/u.exec(path);
    if (native) bytes = fixtures[Number(native[1])].native;
    else {
      if (
        !path.startsWith("/OEngine/.test-dist/") &&
        !path.startsWith("/OEngine/dist/assets/") &&
        !path.startsWith("/OEngine/tests/fixtures/tiled-zstd/") &&
        !path.startsWith("/vendor/gl-matrix/") &&
        !(cooked && path.startsWith(`/${cooked}`))
      )
        throw new Error("outside diagnostic paths");
      const file = path.startsWith("/vendor/gl-matrix/")
        ? resolve(root, "OEngine/node_modules/gl-matrix/esm", path.slice("/vendor/gl-matrix/".length))
        : resolve(root, "." + path);
      if (
        !file.startsWith(resolve(root, "OEngine") + "/") &&
        !file.startsWith(resolve(root, "OEngine") + "\\") &&
        !(cooked && file.startsWith(resolve(root, cooked) + "\\"))
      )
        throw new Error("outside workspace");
      await stat(file);
      bytes = await readFile(file);
      if (path.endsWith(".js")) {
        bytes = Buffer.from(
          bytes.toString("utf8").replace(/(from\s*["'])gl-matrix(["'])/gu, "$1/vendor/gl-matrix/index.js$2"),
        );
      }
    }
    let status = 200;
    const headers = {
      "content-type": extname(path) === ".js" ? "text/javascript" : "application/octet-stream",
      "cache-control": "no-store",
    };
    const range = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range ?? "");
    if (range) {
      headers["content-range"] = `bytes ${range[1]}-${range[2]}/${bytes.length}`;
      bytes = bytes.subarray(Number(range[1]), Number(range[2]) + 1);
      status = 206;
    }
    headers["content-length"] = String(bytes.length);
    response.writeHead(status, headers);
    // Throttle payloads only; metadata/module loading stays identical loopback.
    if (Number.isFinite(rate) && (native || path.endsWith(".vtpack"))) {
      for (let offset = 0; offset < bytes.length && !response.destroyed; offset += 16384) {
        const end = Math.min(offset + 16384, bytes.length);
        payloadClock = Math.max(payloadClock, performance.now()) + ((end - offset) / rate) * 1000;
        await new Promise((accept) => setTimeout(accept, Math.max(0, payloadClock - performance.now())));
        response.write(bytes.subarray(offset, end));
      }
      response.end();
    } else response.end(bytes);
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});
await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
const browser = await chromium.launch({
  executablePath: process.env.OENGINE_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const reports = [];
  for (const bandwidth of distWorker ? [null] : [null, 1250000]) {
    rate = bandwidth ?? Infinity;
    reports.push(
      await page.evaluate(
        async ({ fixtures, bandwidth, distWorker, cooked }) => {
          const { CookedAssetPreparation } = await import(
            "/OEngine/.test-dist/assets/codec/CookedAssetPreparation.js"
          );
          const quantiles = (values) => {
            const sorted = values.toSorted((a, b) => a - b);
            return {
              count: values.length,
              p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
              p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
            };
          };
          const source = `onmessage = async ({data}) => { try {
        const input = new Uint8Array(await (await fetch(data.url)).arrayBuffer());
        const output = []; let offset = 0;
        for (const size of data.sizes) { const p = input.subarray(offset, offset + size);
          await crypto.subtle.digest('SHA-256', p); output.push(p.slice().buffer); offset += size; }
        postMessage({output}, output);
      } catch(e) { postMessage({error: String(e)}); } };`;
          const workerUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
          const nativeRead = (worker, fixture, index) =>
            new Promise((accept, reject) => {
              worker.onmessage = ({ data }) =>
                data.error ? reject(new Error(data.error)) : accept(data.output);
              worker.onerror = reject;
              worker.postMessage({
                url: new URL(`/reference/${index}`, location.href).href,
                sizes: fixture.sizes,
              });
            });
          const open = async () => {
            const preparation = new CookedAssetPreparation({
              maxWorkers: 1,
              ...(distWorker
                ? { createWorker: () => new Worker(`/OEngine/dist/assets/${distWorker}`, { type: "module" }) }
                : {}),
            });
            const session = preparation.openSession();
            const directories = [];
            for (const f of fixtures)
              directories.push(
                await preparation.readTiledDirectory(
                  session,
                  new URL(`/${f.prefix}${f.directoryName}`, location.href).href,
                  f.identity,
                  f.directoryBytes,
                ),
              );
            return { preparation, session, directories };
          };
          const times = { coldZstd: [], coldNative: [], warmZstd: [], warmNative: [], cache: [] };
          let evidence;
          const traceCount = distWorker ? 1 : cooked ? 3 : 17;
          for (let run = 0; run < traceCount; run++) {
            const state = await open();
            const worker = new Worker(workerUrl);
            try {
              for (const [index, f] of fixtures.entries()) {
                const start = performance.now();
                const lease = await state.preparation.readTiledPayloads(
                  state.session,
                  state.directories[index],
                  f.ids,
                );
                times.coldZstd.push(performance.now() - start);
                const nativeStart = performance.now();
                const native = await nativeRead(worker, f, index);
                times.coldNative.push(performance.now() - nativeStart);
                for (let p = 0; p < native.length; p++) {
                  const a = new Uint8Array(native[p]),
                    b = new Uint8Array(lease.payloads[p].bytes);
                  if (a.length !== b.length || a.some((v, i) => v !== b[i]))
                    throw new Error("native comparator differs");
                }
                lease.release();
                const hit = performance.now();
                const cached = await state.preparation.readTiledPayloads(
                  state.session,
                  state.directories[index],
                  f.ids,
                );
                times.cache.push(performance.now() - hit);
                cached.release();
              }
              evidence = state.preparation.evidence();
              await new Promise((accept) => setTimeout(accept, 25));
              const idle = state.preparation.evidence();
              if (
                idle.tiled.fetchedBytes !== evidence.tiled.fetchedBytes ||
                idle.tiled.decodeMs !== evidence.tiled.decodeMs ||
                idle.activeWorkers !== 0 ||
                idle.credit.used.total !== 0
              )
                throw new Error("idle work or unreleased credit");
              // A fresh preparation per trace measures cold instance initialization;
              // later sources in each trace share the same initialized Worker.
            } finally {
              state.preparation.dispose();
              worker.terminate();
              const disposed = state.preparation.evidence();
              if (
                disposed.retainedWorkerBytes !== 0 ||
                disposed.tiled.cache.bytes !== 0 ||
                disposed.credit.used.total !== 0
              )
                throw new Error("dispose did not retire all owners");
            }
          }
          URL.revokeObjectURL(workerUrl);
          // Split the first source from subsequent sources without dropping samples.
          for (const suffix of ["Zstd", "Native"]) {
            const all = times[`cold${suffix}`];
            times[`warm${suffix}`] = all.filter((_, i) => i % fixtures.length !== 0);
            times[`cold${suffix}`] = all.filter((_, i) => i % fixtures.length === 0);
          }
          return {
            bandwidthBytesPerSecond: bandwidth,
            traceCount,
            timingsMs: Object.fromEntries(Object.entries(times).map(([k, v]) => [k, quantiles(v)])),
            evidence,
            note: "New Worker traces, first source cold then two warm sources (fixed fixtures: scalar then color/normal); paired identical pages, native reference hash/copy/transfer Worker is diagnostic only, not the retired loader. Module HTTP loopback; shared aggregate payload throttle, not physical network emulation. Not a full scene/FPS qualification.",
          };
        },
        { fixtures: fixtures.map(({ native, ...f }) => f), bandwidth, distWorker, cooked },
      ),
    );
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        browser: browser.version(),
        fixtures: fixtures.map(({ native, ...f }) => ({ ...f, nativeBytes: native.length })),
        reports,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((accept) => server.close(accept));
}
