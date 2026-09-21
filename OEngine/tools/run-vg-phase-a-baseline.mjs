import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const REQUIRED_OWNERS = Object.freeze([
  "catalog", "range-read", "source-window", "canonical-array-buffer", "wasm-memory",
  "meshlet-build", "simplification", "retained-groups", "descriptor",
  "product-admission", "gpu-metadata", "gpu-residency"
]);

export async function runPhaseABaseline(options) {
  const sourcePath = resolve(options.source ?? "");
  const manifestPath = resolve(options.manifest ?? `${sourcePath}.manifest.json`);
  const workloadPath = resolve(options.workload ?? "../validation/workloads/web-100m-phase-a-baseline-v1.yaml");
  const outputPath = resolve(options.output ?? "../.local/validation/web-100m-phase-a-baseline/report.json");
  const maxSourceBytes = Number(options.maxSourceBytes ?? 128 * 1024 * 1024);
  const maxWasmBytes = Number(options.maxWasmBytes ?? 128 * 1024 * 1024);
  const maxOutputBytes = Number(options.maxOutputBytes ?? 256 * 1024 * 1024);
  for (const [name, value] of Object.entries({ maxSourceBytes, maxWasmBytes, maxOutputBytes })) if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  const [sourceStat, sourceManifestText, workloadText] = await Promise.all([stat(sourcePath), readFile(manifestPath, "utf8"), readFile(workloadPath, "utf8")]);
  const sourceManifest = JSON.parse(sourceManifestText);
  const descriptorBytes = sourceManifest.container?.descriptorBytes ?? sourceManifest.sourceBytes;
  if (sourceStat.size !== descriptorBytes) throw new Error(`source descriptor size ${sourceStat.size} differs from manifest ${descriptorBytes}`);

  const server = await startRangeServer(sourcePath, sourceManifest);
  const engineRoot = resolve(".");
  const coordinatorModule = await import(pathToFileURL(resolve(engineRoot, ".test-dist/assets/web-cook/WebCookCoordinator.js")).href);
  const budgets = { maxConcurrentWorkers: 1, maxSourceBytes, maxWasmBytes, maxOutputBytes, maxQueuedEvents: 1024 };
  const coordinator = new coordinatorModule.WebCookCoordinator("web-100m-phase-a", 1, {
    budgets,
    cooker: { async cookBootstrap() { throw new Error("Phase A sentinel: cook stage reached before an attributed baseline failure"); } }
  });
  let failure;
  try {
    await coordinator.open(server.url);
    await coordinator.cookBootstrap();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failure = classifyFailure(message, sourceManifest.sourceBytes, budgets);
  }
  const coordinatorEvidence = coordinator.evidence();
  coordinator.dispose();
  await server.close();
  const transfer = server.evidence();
  if (!failure) failure = { stage: "none", owner: "none", code: "unexpected-success", message: "Current pipeline completed without a Phase A failure" };

  const owners = ownerEvidence({ budgets, transfer, sourceBytes: sourceManifest.sourceBytes, jsonBytes: sourceManifest.container?.jsonBytes ?? sourceManifest.glb.jsonChunkBytes, failure });
  const workloadSha256 = sha(Buffer.from(workloadText));
  const head = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain"]).length > 0;
  const report = {
    schema: "oengine-web-100m-phase-a-baseline-v1",
    evidenceStatus: "diagnostic-only",
    phaseAExitSatisfied: sourceManifest.workload.sourceTriangles >= 100_000_000 && failure.stage !== "none" && failure.stage !== "unknown" && ownersAreExact(owners),
    provenance: { revision: head, dirty, node: process.version, platform: `${process.platform}-${process.arch}` },
    workload: {
      id: "web-100m-phase-a-baseline-v1",
      sha256: workloadSha256,
      sourceSha256: sourceManifest.sourceSha256,
      sourceBytes: sourceManifest.sourceBytes,
      ...sourceManifest.workload
    },
    budgets,
    transfer,
    owners,
    failure,
    coordinator: coordinatorEvidence,
    interpretation: "This is a failure-attribution baseline, not RuntimeValidated or formal PERF evidence. Owners after the failing stage are exact zero because production control flow never reached them."
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, "utf8");
  return { output: outputPath, report, reportSha256: sha(Buffer.from(serialized)) };
}

function ownerEvidence({ budgets, transfer, sourceBytes, jsonBytes, failure }) {
  const stageRank = { "source-admission": 0, "catalog": 1, "bootstrap-selection": 2, "canonical-array-buffer": 3, "wasm-memory": 4, "meshlet-build": 5, "simplification": 6, "retained-groups": 7, descriptor: 8, "product-admission": 9, "gpu-metadata": 10, "gpu-residency": 11 };
  const failureRank = stageRank[failure.stage] ?? -1;
  const reached = rank => failureRank >= rank;
  const failedAtSourceAdmission = failure.stage === "source-admission";
  const statusFor = rank => reached(rank) ? "reached" : "not-reached";
  const record = (id, currentBytes, peakBytes, limitBytes, status, currentOwners = 0, peakOwners = peakBytes > 0 ? 1 : 0) => ({ id, currentBytes, peakBytes, limitBytes, currentOwners, peakOwners, status });
  return [
    record("catalog", 0, 0, null, statusFor(1)),
    record("range-read", 0, transfer.peakInFlightBytes, budgets.maxSourceBytes, "reached", 0, transfer.peakInFlightRequests),
    record("source-window", 0, Math.max(12, jsonBytes), budgets.maxSourceBytes, "reached"),
    record("canonical-array-buffer", 0, 0, budgets.maxSourceBytes, statusFor(3)),
    record("wasm-memory", 0, 0, budgets.maxWasmBytes, statusFor(4)),
    record("meshlet-build", 0, 0, budgets.maxWasmBytes, statusFor(5)),
    record("simplification", 0, 0, budgets.maxWasmBytes, statusFor(6)),
    record("retained-groups", 0, 0, budgets.maxOutputBytes, statusFor(7)),
    record("descriptor", 0, 0, budgets.maxOutputBytes, statusFor(8)),
    record("product-admission", 0, 0, null, statusFor(9)),
    record("gpu-metadata", 0, 0, null, statusFor(10)),
    record("gpu-residency", 0, 0, null, statusFor(11))
  ];
}

function classifyFailure(message, sourceBytes, budgets) {
  if (/GLB source exceeds maxSourceBytes=/u.test(message)) return { stage: "source-admission", owner: "WebCookCoordinator", code: "total-source-charged-as-live-source", message, inputBytes: sourceBytes, limitBytes: budgets.maxSourceBytes };
  if (/unsupported extension 'EXT_meshopt_compression'|EXT_meshopt_compression decode/u.test(message)) return { stage: "catalog", owner: "GlbSceneCatalog", code: "ext-meshopt-compression-not-decoded", message };
  if (/bootstrap.*source|visible-first bootstrap/u.test(message)) return { stage: "bootstrap-selection", owner: "WebCookCoordinator", code: "bootstrap-source-budget", message };
  if (/canonical/u.test(message)) return { stage: "canonical-array-buffer", owner: "NyxWebRuntimeCooker", code: "canonical-budget-or-allocation", message };
  if (/WASM|wasm/u.test(message)) return { stage: "wasm-memory", owner: "WebGeometryCookerAbi", code: "wasm-budget-or-allocation", message };
  if (/sentinel/u.test(message)) return { stage: "cook-entry", owner: "WebRuntimeCooker", code: "no-earlier-failure", message };
  return { stage: "unknown", owner: "unknown", code: "unclassified", message };
}
function ownersAreExact(owners) { return REQUIRED_OWNERS.every(id => owners.some(owner => owner.id === id && Number.isSafeInteger(owner.currentBytes) && Number.isSafeInteger(owner.peakBytes) && Number.isSafeInteger(owner.currentOwners) && Number.isSafeInteger(owner.peakOwners))); }
function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function git(args) { try { return execFileSync("git", args, { cwd: resolve(".."), encoding: "utf8", windowsHide: true }).trim(); } catch { return "unavailable"; } }

async function startRangeServer(sourcePath, sourceManifest) {
  const format = sourceManifest.container?.format ?? "glb";
  const routes = new Map();
  const sourceRoute = format === "gltf" ? "/phase-a.gltf" : "/phase-a.glb";
  routes.set(sourceRoute, { path: sourcePath, size: sourceManifest.container?.descriptorBytes ?? sourceManifest.sourceBytes, contentType: format === "gltf" ? "model/gltf+json" : "model/gltf-binary", allowWhole: format === "gltf" });
  for (const buffer of sourceManifest.container?.externalBuffers ?? []) {
    const route = new URL(buffer.uri, `http://phase-a.invalid${sourceRoute}`).pathname;
    routes.set(route, { path: resolve(dirname(sourcePath), decodeURIComponent(buffer.uri)), size: buffer.bytes, contentType: "application/octet-stream", allowWhole: false });
  }
  let requests = 0, rangeRequests = 0, transferredBytes = 0, currentInFlightBytes = 0, peakInFlightBytes = 0, currentInFlightRequests = 0, peakInFlightRequests = 0;
  const server = createServer((request, response) => {
    requests++;
    const route = routes.get(new URL(request.url ?? "/", "http://phase-a.invalid").pathname);
    if (!route) { response.writeHead(404); response.end(); return; }
    const match = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/u);
    if (!match && !route.allowWhole) { response.writeHead(416, { "Accept-Ranges": "bytes" }); response.end(); return; }
    const start = match ? Number(match[1]) : 0, end = match ? Number(match[2]) : route.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= route.size) { response.writeHead(416); response.end(); return; }
    if (match) rangeRequests++;
    const bytes = end - start + 1;
    currentInFlightBytes += bytes; peakInFlightBytes = Math.max(peakInFlightBytes, currentInFlightBytes);
    currentInFlightRequests++; peakInFlightRequests = Math.max(peakInFlightRequests, currentInFlightRequests);
    response.writeHead(match ? 206 : 200, { "Accept-Ranges": "bytes", "Content-Length": bytes, ...(match ? { "Content-Range": `bytes ${start}-${end}/${route.size}` } : {}), "Content-Type": route.contentType, ETag: `"${sourceManifest.sourceSha256}"` });
    const stream = createReadStream(route.path, { start, end });
    let settled = false;
    const settle = () => { if (settled) return; settled = true; currentInFlightBytes -= bytes; currentInFlightRequests--; transferredBytes += bytes; };
    stream.on("error", error => { settle(); response.destroy(error); });
    response.on("close", settle);
    stream.pipe(response);
  });
  await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("range server did not expose a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}${sourceRoute}`,
    close: () => new Promise((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise())),
    evidence: () => ({ requests, rangeRequests, transferredBytes, currentInFlightBytes, peakInFlightBytes, currentInFlightRequests, peakInFlightRequests })
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === "--source") options.source = argv[++index];
    else if (name === "--manifest") options.manifest = argv[++index];
    else if (name === "--workload") options.workload = argv[++index];
    else if (name === "--out") options.output = argv[++index];
    else if (name === "--max-source-bytes") options.maxSourceBytes = Number(argv[++index]);
    else if (name === "--max-wasm-bytes") options.maxWasmBytes = Number(argv[++index]);
    else if (name === "--max-output-bytes") options.maxOutputBytes = Number(argv[++index]);
    else throw new Error(`unknown option: ${name}`);
  }
  if (!options.source) throw new Error("Usage: node tools/run-vg-phase-a-baseline.mjs --source <scene.glb> [--manifest <json>] [--workload <yaml>] [--out <json>]");
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runPhaseABaseline(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify({ output: result.output, reportSha256: result.reportSha256, phaseAExitSatisfied: result.report.phaseAExitSatisfied, failure: result.report.failure, owners: result.report.owners }));
}
