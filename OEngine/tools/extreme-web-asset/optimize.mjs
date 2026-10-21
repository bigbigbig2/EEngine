import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { nativeCook } from "./cook.mjs";
import {
  contentHash,
  stableJson,
  searchIdentity,
  selectImageCandidate,
  validateEvaluation
} from "./search.mjs";
import { ImageSearchCache } from "./search-cache.mjs";
import { deliveryCost } from "./delivery.mjs";
import { retireSuccessfulImageJob } from "./scratch.mjs";

/** The evaluator is the actual offline GPU/metric host, never runtime code.
 * It must evaluate all mips, exact bytes, neighboring cells and final material
 * probes and expose a full immutable environment identity before any cache hit. */
export async function optimizeImage(request, output, evaluator, { trace = null, signal, onCandidate } = {}) {
  const environment = await evaluator.identity();
  const canonical = contentHash(
    stableJson(
      request.inputs.map((input) => ({
        width: input.width,
        height: input.height,
        hash: contentHash(input.rgba)
      }))
    )
  );
  const { inputs, exactCoverage, ...rawRecipe } = request;
  const recipe = JSON.parse(JSON.stringify(rawRecipe));
  const root = resolve(output);
  const cache = new ImageSearchCache(join(root, ".evaluation-cache"));
  const identity = searchIdentity({
    canonical,
    recipe: contentHash(
      stableJson({
        ...recipe,
        coverage: exactCoverage?.map((mip) => contentHash(mip.rgba)) ?? [],
        trace,
        moduleInventory: evaluator.moduleInventory ?? null
      })
    ),
    ...environment
  });
  const jobs = fileURLToPath(new URL("../../../.local/extreme-web-asset/jobs/", import.meta.url));
  const working = join(jobs, randomUUID());
  await mkdir(root, { recursive: true });
  await mkdir(working, { recursive: true });
  const report = await selectImageCandidate({
    quality: request.quality,
    semantic: request.semantic,
    virtual: request.mode === "virtual",
    signal,
    async evaluate(candidate, index) {
      const directory = join(working, String(index));
      const started = performance.now();
      const product = await nativeCook(
        { ...request, cellSize: candidate.cell ?? request.cellSize },
        directory,
        { quality: candidate.quality, speed: candidate.speed }
      );
      const encodeMs = performance.now() - started;
      const commands = await readFile(join(directory, "commands.json"));
      const commandsHash = contentHash(commands);
      const commandsName = `commands-${commandsHash}.json`;
      await writeFile(join(root, commandsName), commands);
      const inputHash = contentHash(product.bytes);
      const key = cache.key(identity, { ...candidate, inputHash });
      let evaluation = await cache.read(key);
      const cacheHit = evaluation !== null;
      if (!evaluation) {
        evaluation = await evaluator.evaluate({
          product,
          directory,
          canonical: { ...request, ...(candidate.cell ? { cellSize: candidate.cell } : {}) },
          trace,
          signal
        });
        if (evaluation.identity !== environment.evaluator || evaluation.inputHash !== inputHash) {
          throw new Error("GPU evaluation returned a different product or environment");
        }
        validateEvaluation(evaluation, request.semantic);
        await cache.write(key, evaluation);
      }
      if (evaluation.identity !== environment.evaluator || evaluation.inputHash !== inputHash) {
        throw new Error("Stale GPU evaluation cache receipt");
      }
      const delivery = deliveryCost(product.directory, trace);
      // Without a trace optimize bounded worst-case sparse demand, not total
      // pack size disguised as actual streaming benefit.
      const deliveryBytes =
        delivery.directoryBytes +
        (trace
          ? delivery.fetchedBytes + delivery.residentBytes
          : request.mode === "virtual"
            ? delivery.worstPageBytes + delivery.residentBytes
            : delivery.payloadBytes);
      const { rows, ...deliverySummary } = delivery;
      onCandidate?.({ index, candidate, encodeMs, cacheHit, deliveryBytes });
      return {
        evaluation,
        deliveryBytes,
        encodeMs,
        cacheHit,
        encodingCommands: { uri: commandsName, sha256: commandsHash },
        directory: relative(root, directory).replaceAll("\\", "/"),
        delivery: deliverySummary
      };
    }
  });
  // Re-open/hash the chosen actual product. Only the final root directory is
  // published; candidates remain local search artifacts, never extra downloads.
  const chosen = join(root, report.selected.directory);
  const product = JSON.parse(await readFile(join(chosen, "directory.json"), "utf8"));
  for (const item of product.items) {
    const bytes = await readFile(join(chosen, item.uri));
    if (bytes.length !== item.bytes || contentHash(bytes) !== item.sha256)
      throw new Error("Chosen payload changed before publication");
    const pending = join(root, `${item.sha256}-${randomUUID()}.tmp`);
    await writeFile(pending, bytes, { flag: "wx" });
    await rename(pending, join(root, item.uri));
  }
  const summary = JSON.parse(
    JSON.stringify({
      schemaVersion: 1,
      identity,
      environment,
      canonical,
      report,
      encoding: {
        candidateCount: report.rows.length,
        totalEncodeWallMs: report.rows.reduce((sum, row) => sum + row.encodeMs, 0),
        selectedEncodeMs: report.selected.encodeMs,
        donorEncodeMs: report.donor.encodeMs
      },
      network: {
        moduleBytes: evaluator.moduleBytes,
        moduleInventory: evaluator.moduleInventory ?? null,
        accounting:
          evaluator.moduleBytes === null
            ? "deployment-module-inventory-missing; not full-network-qualified"
            : "explicit-module-inventory",
        payloadBytes: report.selected.delivery.payloadBytes,
        directoryBytes: report.selected.delivery.directoryBytes,
        previewBytes: 0,
        coldAllBytes:
          evaluator.moduleBytes === null
            ? null
            : evaluator.moduleBytes +
              report.selected.delivery.directoryBytes +
              report.selected.delivery.payloadBytes,
        traceFetchedBytes: trace ? report.selected.delivery.fetchedBytes : null,
        exactBytes: product.items
          .filter((item) => item.kind === "exact")
          .reduce((sum, item) => sum + item.bytes, 0)
      }
    })
  );
  const reportBytes = JSON.stringify(summary, null, 2) + "\n";
  const reportName = `search-report-${contentHash(reportBytes)}.json`;
  const pending = join(root, `search-report-${randomUUID()}.tmp`);
  await writeFile(pending, reportBytes);
  await rename(pending, join(root, reportName));
  const bytes = await readFile(join(chosen, "directory.json"));
  const temporary = join(root, `directory-${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag: "wx" });
  signal?.throwIfAborted();
  await rename(temporary, join(root, "directory.json"));
  evaluator.releaseJob(working);
  await retireSuccessfulImageJob(jobs, working);
  return { directory: product, bytes, report: summary, reportName };
}
