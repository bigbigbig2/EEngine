import { mkdir, readFile, writeFile, rm, rmdir } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { launchChrome } from "../../../tools/gpu-oracle/browser.mjs";
import { startStaticServer, defaultAllowPrefixes } from "../../../tools/gpu-oracle/server.mjs";
import { verifyTestBuild } from "../../../tools/test-build.mjs";
import { cookImageTexture } from "./evaluation-input.mjs";
import { contentHash, stableJson } from "./search.mjs";
import { ImageQualityMetrics, nativeSsim } from "./metrics.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const local = resolve(root, ".local/extreme-web-asset");

/** One process owns the offline GPU queue at a time. No stale-lock deletion:
 * after a crash its PID/owner record is an explicit operator recovery action. */
async function gpuLock(signal) {
  const path = join(local, "offline-gpu.lock");
  const deadline = Date.now() + 30 * 60_000;
  while (true) {
    signal?.throwIfAborted();
    try {
      await mkdir(path);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (Date.now() > deadline)
      throw new Error(
        "Offline GPU lock wait expired; inspect the recorded owner, do not steal an active queue"
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await writeFile(
    join(path, "owner.json"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
  );
  return async () => {
    // This literal, verified child of local contains only this invocation's lock.
    const owner = JSON.parse(await readFile(join(path, "owner.json")));
    if (owner.pid !== process.pid || resolve(path) !== join(local, "offline-gpu.lock"))
      throw new Error("GPU lock ownership changed");
    await rm(join(path, "owner.json"));
    await rmdir(path);
  };
}

export async function createOfflineEvaluator({ signal, moduleInventory = null } = {}) {
  if (
    moduleInventory &&
    (!Array.isArray(moduleInventory) ||
      moduleInventory.length > 1024 ||
      moduleInventory.some(
        (item) =>
          typeof item.uri !== "string" ||
          !/^[a-f0-9]{64}$/.test(item.sha256) ||
          !Number.isSafeInteger(item.fetchedBytes) ||
          item.fetchedBytes < 0
      ))
  ) {
    throw new Error("Deployment module inventory requires bounded actual fetched bytes and hashes");
  }
  await mkdir(local, { recursive: true });
  const unlock = await gpuLock(signal);
  let server, browser;
  const failures = [];
  try {
    const build = await verifyTestBuild(root);
    const encoder = JSON.parse(await readFile(join(local, "native-build.json")));
    const encodingSource = contentHash(
      Buffer.concat(
        await Promise.all(
          [new URL("cook.mjs", import.meta.url), new URL("native-profiles.mjs", import.meta.url)].map(
            (path) => readFile(path)
          )
        )
      )
    );
    const ffmpeg =
      process.env.EENGINE_FFMPEG ??
      spawnSync("where.exe", ["ffmpeg.exe"], { encoding: "utf8", windowsHide: true })
        .stdout?.trim()
        .split(/\r?\n/)[0];
    if (!ffmpeg) throw new Error("Offline quality search requires native FFmpeg SSIM");
    const metricBinary = contentHash(await readFile(ffmpeg));
    const sourceFiles = [
      "evaluation-host.mjs",
      "gpu-evaluate.mjs",
      "metrics.mjs",
      "search.mjs",
      "evaluation-input.mjs"
    ];
    const evaluatorSource = contentHash(
      Buffer.concat(await Promise.all(sourceFiles.map((name) => readFile(new URL(name, import.meta.url)))))
    );
    const metricsVersion = spawnSync(ffmpeg, ["-version"], { encoding: "utf8", windowsHide: true });
    if (metricsVersion.status !== 0) throw new Error("Native metric version inspection failed");
    const require = createRequire(join(root, "validation/package.json"));
    server = await startStaticServer({
      root,
      harnessRoot: join(root, "tools/gpu-oracle"),
      allowPrefixes: [
        ...defaultAllowPrefixes,
        ".local/extreme-web-asset/",
        "OEngine/tools/extreme-web-asset/"
      ],
      vendorRoots: [join(root, "OEngine/node_modules")]
    });
    browser = await launchChrome({
      chromium: require("playwright-core").chromium,
      executablePath:
        process.env.OENGINE_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless: true,
      extraArgs: ["--enable-features=Vulkan,UseSkiaRenderer", "--enable-unsafe-webgpu"]
    });
    const page = browser.page;
    page.on("pageerror", (error) => failures.push(String(error)));
    await page.goto(server.origin + "/__gpu-oracle/page/json-safe.mjs");
    const device = await page.evaluate(async () => {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter?.features.has("texture-compression-bc"))
        throw new Error("Offline encoder needs BC WebGPU");
      globalThis.evaluationDevice = await adapter.requestDevice({
        requiredFeatures: ["texture-compression-bc"]
      });
      const info = adapter.info;
      return {
        browser: navigator.userAgent,
        adapter: {
          vendor: info.vendor,
          architecture: info.architecture,
          device: info.device,
          description: info.description
        },
        features: [...evaluationDevice.features].sort(),
        limits: {
          maxBufferSize: evaluationDevice.limits.maxBufferSize,
          maxStorageBufferBindingSize: evaluationDevice.limits.maxStorageBufferBindingSize
        },
        precision: "f32"
      };
    });
    const source = JSON.parse(await readFile(join(local, "sources.json")));
    const environment = {
      encoder: encoder.binaries["avifenc.exe"].sha256,
      argv: encodingSource,
      target: contentHash(stableJson({ profile: "schema4-final-all-mips-pages-material-probes-v1", build })),
      metrics: contentHash(stableJson({ metricBinary, version: metricsVersion.stdout, evaluatorSource })),
      device: contentHash(stableJson(device))
    };
    environment.evaluator = contentHash(
      stableJson({ ...environment, spark: source.sources.spark.trackedTreeSha256, evaluatorSource })
    );
    await page.evaluate(async (identity) => {
      const { createGpuImageEvaluator } = await import("/OEngine/tools/extreme-web-asset/gpu-evaluate.mjs");
      document.body.textContent =
        "Powered by spark.js - offline local evaluation; https://ludicon.com/sparkjs/eula.html";
      globalThis.imageEvaluator = await createGpuImageEvaluator(evaluationDevice, identity);
    }, environment.evaluator);
    let receiver;
    await page.exposeBinding("receiveImageMetricChunk", async (_source, chunk) => {
      if (!receiver) throw new Error("GPU metric chunk has no active job");
      return receiver(chunk);
    });
    const close = async () => {
      try {
        await page.evaluate(async () => {
          await evaluationDevice.queue.onSubmittedWorkDone();
          imageEvaluator.close();
          evaluationDevice.destroy();
        });
      } finally {
        try {
          await browser.close();
        } finally {
          try {
            await server.close();
          } finally {
            await unlock();
          }
        }
      }
    };
    return {
      moduleInventory,
      moduleBytes: moduleInventory ? moduleInventory.reduce((sum, item) => sum + item.fetchedBytes, 0) : null,
      async identity() {
        return environment;
      },
      async evaluate({ product, directory, canonical, signal }) {
        signal?.throwIfAborted();
        const job = resolve(directory);
        const child = relative(local, job);
        if (!child || child.startsWith("..") || isAbsolute(child))
          throw new Error("GPU search products must stay in the explicit local evaluation root");
        const referenceRoot = join(job, "canonical");
        const reference = await cookImageTexture(canonical, referenceRoot);
        const expected = new Map();
        const key = ({ plane, mip, x, y, width, height }) => `${plane}/${mip}/${x}/${y}/${width}/${height}`;
        const url = (path) =>
          server.origin + "/" + relative(root, path).replaceAll("\\", "/") + "/directory.json";
        receiver = async (chunk) => {
          signal?.throwIfAborted();
          const name = key(chunk);
          if (expected.has(name)) throw new Error("Canonical evaluation duplicated a domain");
          const path = join(referenceRoot, `samples-${expected.size}.bin`);
          await writeFile(path, Buffer.from(new Float32Array(chunk.values).buffer));
          expected.set(name, path);
        };
        const run = (path, bytes, canonical) =>
          page.evaluate(
            async ({ url, hash, length, canonical }) =>
              imageEvaluator.evaluate(
                url,
                hash,
                length,
                (chunk) => receiveImageMetricChunk(chunk),
                canonical
              ),
            { url: url(path), hash: contentHash(bytes), length: bytes.length, canonical }
          );
        try {
          await run(referenceRoot, reference.bytes, true);
        } catch (error) {
          receiver = undefined;
          throw error;
        }
        const quality = new ImageQualityMetrics(product.directory.planes[0].semantic);
        let exact = true;
        receiver = async (chunk) => {
          signal?.throwIfAborted();
          const name = key(chunk),
            path = expected.get(name);
          if (!path) throw new Error("Candidate GPU output changed the canonical domain");
          const bytes = await readFile(path);
          const reference = new Float32Array(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
          );
          const values = new Float32Array(chunk.values);
          if (chunk.semantic === "exact-r") {
            for (let at = 0; at < values.length; at += 28) {
              if (Math.round(reference[at] * 255) !== Math.round(values[at] * 255)) exact = false;
            }
          } else {
            quality.add(
              reference,
              values,
              chunk,
              chunk.semantic.startsWith("color-")
                ? nativeSsim(ffmpeg, reference, values, chunk.width, chunk.height)
                : null
            );
          }
          expected.delete(name);
        };
        try {
          await run(job, product.bytes, false);
        } finally {
          receiver = undefined;
        }
        if (expected.size || failures.length)
          throw new Error("Incomplete GPU evaluation or browser errors: " + failures.join("\n"));
        return {
          representation: "gpu-final",
          identity: environment.evaluator,
          inputHash: contentHash(product.bytes),
          hardSemantics: exact,
          metrics: quality.vector()
        };
      },
      close
    };
  } catch (error) {
    try {
      await browser?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        await unlock();
      }
    }
    throw error;
  }
}
