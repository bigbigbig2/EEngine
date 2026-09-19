import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const engineDir = dirname(toolsDir);
const repoDir = dirname(engineDir);
const manifestPath = join(repoDir, "docs", "porting", "nyx-function-map.json");

const requiredShaderEvidence = Object.freeze({
  "dag-process-node": ["hierarchy_sphere_in_frustum", "hierarchy_projected_error_pixels", "hierarchy_try_reserve_profiled", "rejected_hzb"],
  "dag-process-meshlet": ["hierarchy_virtual_find_resident_ancestor_v1", "hierarchy_emit_page_demand_v1", "OEngineGeometryPageDemandQueueV1", "geometryMeshletsSelected"],
  "dag-compute-main": ["@compute @workgroup_size", "workgroupBarrier", "atomicStore", "hierarchy_update_dispatch"],
  "vbuffer-build-vertex": ["raster_virtual_meshlet", "product_raster_position", "product_raster_meshlet_header", "vertex_index"],
  "vbuffer-mesh-main": ["@vertex", "write_virtual_meshlet", "primitive", "vertex_index"],
  "vbuffer-pixel-main": ["@fragment", "oengine_visibility_key_try_encode", "discard", "visibility_key"]
});

const requiredNyxSourceEvidence = Object.freeze({
  "meshlet-build-pipeline": ["meshopt_buildMeshletsFlex", "meshopt_partitionClusters", "BuildVertexLocksByGroups", "meshopt_simplifyWithAttributes", "meshopt_simplifySloppy", "BuildHierarchy"],
  "scene-conversion": ["meshRequests.push_back", "ParallelCompileMeshes", "CheckedU32", "PendingWrites", "CleanupTempFiles"],
  "product-layout": ["MaxParrentError", "RefineGroupIndex", "GroupDataLocation", "MeshletCountMinusOne"],
  "geometry-streaming": ["PinRootPages", "m_ReadbackRequestMaskBuffer", "m_PagesToLoad", "m_CompletedPagesQueue", "ImmediateEvict"],
  "dag-process-node": ["EvaluateBoundsVisibility", "TestForLod", "ScreenErrorConstant", "InterlockedOr", "bResident"],
  "dag-process-meshlet": ["RefineGroupIndex", "TestForLod", "VisibleMeshletCount", "MAX_VISIBLE_MESHLETS"],
  "dag-compute-main": ["GroupMemoryBarrierWithGroupSync", "ProcessNodeBatch", "ProcessMeshletBatch", "NodeReadOffset"],
  "vbuffer-build-vertex": ["geometryChunksBuffer.Load3", "PSO_ALPHA_TEST", "CommandIndex", "ViewProjMatrix"],
  "vbuffer-mesh-main": ["SetMeshOutputCounts", "LoadAndUnpackTriangle", "PrimitiveIndex", "BuildVertexOutput"],
  "vbuffer-pixel-main": ["baseColorTexture.Sample", "alpha < cutoff", "primID & 0x7F", "InterlockedMax"]
});

async function readUtf8(path) {
  return readFile(path, "utf8");
}

function sourcePath(root, relativePath) {
  return join(root, relativePath.replaceAll("/", "\\"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sourceDefinitionLine(sourceText, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = sourceText.split(/\r?\n/u);
  const patterns = [
    new RegExp(`::${escaped}\\s*\\(`),
    new RegExp(`^\\s*struct\\s+${escaped}\\b`),
    new RegExp(`^\\s*(?:[A-Za-z_][\\w:<>,]*\\s+)+${escaped}\\s*\\(`)
  ];
  for (const pattern of patterns) {
    const index = lines.findIndex(line => pattern.test(line));
    if (index >= 0) return index + 1;
  }
  return 0;
}

/**
 * This audit intentionally reads only the seven Nyx source files named in the
 * manifest. It never traverses the Nyx documentation tree or ADRs.
 */
export async function auditNyxFunctionMap({ nyxRoot = process.env.NYX_SOURCE_DIR ?? "D:/Nyx-main" } = {}) {
  const manifest = JSON.parse(await readUtf8(manifestPath));
  assert(manifest.schemaVersion === 1, "Nyx function map schema version is unsupported");
  assert(manifest.sourceFiles.length === 7, `expected seven pinned Nyx source files, got ${manifest.sourceFiles.length}`);

  const sourceTexts = new Map();
  const sourceResults = [];
  for (const source of manifest.sourceFiles) {
    const path = sourcePath(nyxRoot, source.path);
    assert(existsSync(path), `missing pinned Nyx source: ${path}`);
    const bytes = await readFile(path);
    const actual = createHash("sha256").update(bytes).digest("hex");
    assert(actual === source.sha256, `Nyx source hash mismatch for ${source.path}: ${actual}`);
    const text = bytes.toString("utf8");
    sourceTexts.set(source.path, text);
    const missingSymbols = source.symbols.filter(symbol => !new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`).test(text));
    assert(missingSymbols.length === 0, `${source.path} is missing source symbols: ${missingSymbols.join(", ")}`);
    sourceResults.push({ path: source.path, sha256: actual, symbols: source.symbols.length });
  }

  const nativeBuildSources = [
    await readUtf8(join(repoDir, "OEngine", "tools", "build-native-cooker.mjs")),
    await readUtf8(join(repoDir, "OEngine", "tools", "oengine-asset-core", "CMakeLists.txt")),
    await readUtf8(join(repoDir, "OEngine", "tools", "build-web-geometry-cooker-oracle.mjs"))
  ];
  for (const source of manifest.sourceFiles) {
    for (const buildSource of nativeBuildSources) {
      assert(buildSource.includes(source.path) && buildSource.includes(source.sha256), `build gate does not pin ${source.path} with its manifest hash`);
    }
  }

  const mappingResults = [];
  for (const mapping of manifest.mappings) {
    const sourceText = sourceTexts.get(mapping.source);
    assert(sourceText, `${mapping.id} references an unlisted source file ${mapping.source}`);
    for (const symbol of mapping.sourceSymbols) {
      assert(new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`).test(sourceText), `${mapping.id} is missing source symbol ${symbol}`);
    }
    const sourceLines = mapping.sourceSymbols.map(symbol => {
      const line = sourceDefinitionLine(sourceText, symbol);
      assert(line > 0, `${mapping.id} cannot resolve source line for ${symbol}`);
      return line;
    });
    const nyxTokens = requiredNyxSourceEvidence[mapping.id];
    assert(nyxTokens, `${mapping.id} has no pinned Nyx branch evidence`);
    const missingNyxTokens = nyxTokens.filter(token => !sourceText.includes(token));
    assert(missingNyxTokens.length === 0, `${mapping.id} is missing pinned Nyx branch evidence: ${missingNyxTokens.join(", ")}`);
    for (const implementation of mapping.implementation) {
      const path = join(repoDir, implementation.replaceAll("/", "\\"));
      assert(existsSync(path), `${mapping.id} implementation is missing: ${path}`);
    }
    for (const consumer of mapping.consumer) {
      const path = join(repoDir, consumer.replaceAll("/", "\\"));
      assert(existsSync(path), `${mapping.id} consumer is missing: ${path}`);
    }
    assert(mapping.status === "verified", `${mapping.id} must be marked verified only after the independent Nyx/GPU evidence is present`);
    mappingResults.push({ id: mapping.id, sourceSymbols: mapping.sourceSymbols.length, sourceLines, nyxTokens: nyxTokens.length, implementationFiles: mapping.implementation.length, status: mapping.status });
  }

  const shaderSources = new Map([
    ["hierarchy", await readUtf8(join(repoDir, "OEngine", "src", "shaders", "hierarchical_work_generation.ts"))],
    ["raster", await readUtf8(join(repoDir, "OEngine", "src", "shaders", "meshlet_bucket_visibility.ts"))]
  ]);
  const gpuResults = [];
  for (const [id, tokens] of Object.entries(requiredShaderEvidence)) {
    const source = id.startsWith("dag-") ? shaderSources.get("hierarchy") : shaderSources.get("raster");
    const missing = tokens.filter(token => !source.includes(token));
    assert(missing.length === 0, `${id} is missing GPU semantic evidence: ${missing.join(", ")}`);
    gpuResults.push({ id, tokens: tokens.length, missing });
  }

  const counterSource = await readUtf8(join(repoDir, "OEngine", "src", "debug", "GpuFrameCounters.ts"));
  for (const counter of manifest.gpuEvidence.requiredCounters) {
    assert(new RegExp(`\\b${counter}\\b`).test(counterSource), `GPU counter is not declared: ${counter}`);
  }
  for (const browserCase of manifest.gpuEvidence.browserCases) {
    assert(existsSync(join(repoDir, browserCase.replaceAll("/", "\\"))), `GPU browser evidence case is missing: ${browserCase}`);
  }

  assert(manifest.referenceHarness.status === "verified-source-harnesses", "reference harness status must record the verified harness set");
  assert(manifest.referenceHarness.notExternalAlgorithmComplete === false, "verified Nyx harnesses must not remain blocked");
  return Object.freeze({
    manifest: relative(repoDir, manifestPath).replaceAll("\\", "/"),
    nyxRoot: resolve(nyxRoot),
    sourceFiles: sourceResults,
    mappings: mappingResults,
    gpu: gpuResults,
    referenceHarness: manifest.referenceHarness,
    externalAlgorithmComplete: true
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const report = await auditNyxFunctionMap();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
