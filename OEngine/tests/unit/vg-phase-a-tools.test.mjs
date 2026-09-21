import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { generateVirtualGeometryStress } from "../../tools/generate-vg-stress.mjs";
import { inspectGlbWorkload, inspectGltfWorkload } from "../../tools/inspect-glb-workload.mjs";
import { runPhaseABaseline } from "../../tools/run-vg-phase-a-baseline.mjs";

test("Phase A stress source is deterministic, exact, and row-bounded", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "oengine-vg-phase-a-"));
  const first = resolve(root, "first.glb"), second = resolve(root, "second.glb");
  const a = await generateVirtualGeometryStress({ output: first, triangles: 20_000, seed: 1801 });
  const b = await generateVirtualGeometryStress({ output: second, triangles: 20_000, seed: 1801 });
  assert.equal(a.sourceSha256, b.sourceSha256);
  assert.equal(a.workload.sourceTriangles, 20_000);
  assert.equal(a.workload.layout, "single-giant-primitive");
  assert.ok(a.generation.peakGeneratorBytes < a.sourceBytes / 4);
  const bytes = await readFile(first);
  assert.equal(bytes.byteLength, a.sourceBytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), a.sourceSha256);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x46546c67);
  assert.equal(view.getUint32(8, true), bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).trim());
  assert.equal(json.meshes.length, 1);
  assert.equal(json.accessors[3].count, 60_000);
  const inspection = await inspectGlbWorkload({ source: first, label: "test-grid" });
  assert.equal(inspection.workload.sourceTriangles, 20_000);
  assert.equal(inspection.workload.primitives, 1);
  assert.equal(inspection.workload.nodes, 1);
  assert.equal(inspection.workload.primitiveTriangleDistribution.max, 20_000);
  assert.equal(inspection.payload.imageViewBytes, 0);
});

test("Phase A inspector accounts for external glTF buffers and Phase B no longer rejects total source bytes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "oengine-vg-phase-a-gltf-"));
  const source = resolve(root, "scene.gltf"), binary = resolve(root, "scene.bin"), manifest = resolve(root, "manifest.json"), workload = resolve(root, "workload.yaml"), report = resolve(root, "report.json");
  await writeFile(binary, Buffer.alloc(60, 7));
  await writeFile(source, JSON.stringify({
    asset: { version: "2.0" },
    buffers: [{ uri: "scene.bin", byteLength: 60 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }, { buffer: 0, byteOffset: 12, byteLength: 48 }],
    accessors: [{ bufferView: 0, componentType: 5123, count: 6, type: "SCALAR" }, { bufferView: 1, componentType: 5126, count: 4, type: "VEC3" }],
    meshes: [{ primitives: [{ indices: 0, attributes: { POSITION: 1 } }] }],
    nodes: [{ mesh: 0 }, { mesh: 0 }],
    scenes: [{ nodes: [0, 1] }],
    scene: 0
  }));
  const inspection = await inspectGltfWorkload({ source, output: manifest, label: "external-test" });
  assert.equal(inspection.container.format, "gltf");
  assert.equal(inspection.container.externalBuffers[0].bytes, 60);
  assert.match(inspection.container.externalBuffers[0].sha256, /^[0-9a-f]{64}$/u);
  assert.equal(inspection.sourceBytes, (await readFile(source)).byteLength + 60);
  assert.equal(inspection.workload.sourceTriangles, 2);
  assert.equal(inspection.workload.logicalInstancedTriangles, 4);
  assert.equal(inspection.workload.meshInstances, 2);
  await writeFile(workload, "schemaVersion: 1\nid: external-gltf-phase-a-test\n", "utf8");
  const baseline = await runPhaseABaseline({ source, manifest, workload, output: report, maxSourceBytes: 16 });
  assert.equal(baseline.report.failure.stage, "cook-entry");
  assert.equal(baseline.report.workload.sourceBytes, inspection.sourceBytes);
});

test("Phase B carries a source larger than its live window budget through catalog admission", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "oengine-vg-phase-a-baseline-"));
  const source = resolve(root, "source.glb"), workload = resolve(root, "workload.yaml"), output = resolve(root, "report.json");
  const manifest = await generateVirtualGeometryStress({ output: source, triangles: 20_000, seed: 1801 });
  await import("node:fs/promises").then(({ writeFile }) => writeFile(workload, "schemaVersion: 1\nid: web-100m-phase-a-baseline-v1\n", "utf8"));
  const result = await runPhaseABaseline({ source, manifest: `${source}.manifest.json`, workload, output, maxSourceBytes: 1024 });
  assert.equal(result.report.failure.stage, "cook-entry");
  assert.ok(manifest.sourceBytes > 1024);
  assert.equal(result.report.workload.sourceBytes, manifest.sourceBytes);
  assert.equal(result.report.transfer.currentInFlightBytes, 0);
  assert.ok(result.report.transfer.peakInFlightBytes > 0);
  const canonical = result.report.owners.find(owner => owner.id === "canonical-array-buffer");
  assert.deepEqual({ current: canonical.currentBytes, peak: canonical.peakBytes, status: canonical.status }, { current: 0, peak: 0, status: "not-reached" });
  assert.equal(JSON.parse(await readFile(output, "utf8")).schema, "oengine-web-100m-phase-a-baseline-v1");
});
