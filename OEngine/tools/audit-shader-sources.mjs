import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "src");
const shaderRoot = path.join(sourceRoot, "shaders");
const outputArgument = readOutputArgument(process.argv.slice(2));

const projectFiles = await collectProjectSources(root);
const sourceFiles = projectFiles.filter((file) => file.startsWith(`${sourceRoot}${path.sep}`));
const shaderFiles = sourceFiles.filter((file) => path.dirname(file) === shaderRoot);
const sources = new Map(
  await Promise.all(
    projectFiles.map(async (file) => [file, await readFile(file, "utf8")])
  )
);
const imports = new Map(
  sourceFiles.map((file) => [file, resolveImports(file, sources.get(file) ?? "")])
);
const reverseImports = buildReverseImports(imports);

const entries = shaderFiles
  .sort((a, b) => a.localeCompare(b))
  .map((file) => buildShaderEntry(file));

const summary = entries.reduce((result, entry) => {
  result[entry.classification] = (result[entry.classification] ?? 0) + 1;
  return result;
}, {});
const report = {
  schemaVersion: 2,
  generatedBy: "tools/audit-shader-sources.mjs",
  sourceRoot: "src",
  method: {
    importGraph: "static relative TypeScript import graph",
    pipelineOwnerHeuristic: [
      "render_pipelines.obtain/createRenderPipeline",
      "compute_pipelines.obtain/createComputePipeline",
      "RenderPipelineCache/ComputePipelineCache obtain",
      "constructComputePass/constructRenderPass"
    ],
    limitation: "Dynamic imports and runtime-composed source strings require manual confirmation."
  },
  shaderCount: entries.length,
  summary,
  entries
};
const json = `${JSON.stringify(report, null, 2)}\n`;

if (outputArgument === null) {
  process.stdout.write(json);
} else {
  const outputPath = path.resolve(root, outputArgument);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, json, "utf8");
  process.stdout.write(`Wrote ${relative(outputPath)} (${entries.length} shaders)\n`);
}

function buildShaderEntry(file) {
  const base = path.basename(file, ".ts");
  const sourceKind = base.includes("oracle")
    ? "oracle"
    : base.includes("generated")
      ? "generated"
      : "authored";
  const directConsumers = [...(reverseImports.get(file) ?? [])]
    .map(relative)
    .sort((a, b) => a.localeCompare(b));
  const transitive = collectTransitiveConsumers(file, reverseImports);
  const runtimeConsumers = [...transitive]
    .filter((candidate) => !candidate.startsWith(`${shaderRoot}${path.sep}`))
    .map(relative)
    .sort((a, b) => a.localeCompare(b));
  const pipelineOwners = [...collectNearestPipelineOwners(file, reverseImports)]
    .map(relative)
    .sort((a, b) => a.localeCompare(b));
  const generatorCandidates = findGeneratorCandidates(file, base);
  const classification = classifyShader(
    sourceKind,
    pipelineOwners.length > 0,
    generatorCandidates.length > 0
  );
  return {
    shader: relative(file),
    sourceKind,
    classification,
    directConsumers,
    runtimeConsumers,
    pipelineOwners,
    generatorCandidates,
    deletionCandidate: pipelineOwners.length === 0,
    status: describeStatus(classification)
  };
}

function classifyShader(sourceKind, hasPipelineOwner, hasGenerator) {
  if (!hasPipelineOwner) {
    return sourceKind === "oracle" ? "oracle-reference" : "dead";
  }
  if (sourceKind === "authored") return "authored-live";
  if (sourceKind === "generated" && hasGenerator) return "generated-live";
  return "unknown";
}

function describeStatus(classification) {
  switch (classification) {
    case "authored-live":
      return "Runtime pipeline reachable; authored file is the current source-of-truth.";
    case "generated-live":
      return "Runtime pipeline reachable; generator/source candidate is recorded.";
    case "oracle-reference":
      return "No runtime pipeline owner; retain only as an explicit reference or delete.";
    case "dead":
      return "No runtime pipeline owner; deletion candidate after manual confirmation.";
    default:
      return "Runtime pipeline reachable, but oracle/generated ownership is unresolved.";
  }
}

function findGeneratorCandidates(shaderFile, base) {
  const fileName = path.basename(shaderFile);
  return projectFiles
    .filter((candidate) => candidate !== shaderFile)
    .filter(isGeneratorLocation)
    .filter((candidate) => {
      const source = sources.get(candidate) ?? "";
      return source.includes(fileName) || source.includes(base);
    })
    .map(relative)
    .sort((a, b) => a.localeCompare(b));
}

function isGeneratorLocation(file) {
  const location = relative(file);
  return location.startsWith("tools/") || location.startsWith("scripts/");
}

function collectTransitiveConsumers(file, reverseGraph) {
  const visited = new Set();
  const pending = [...(reverseGraph.get(file) ?? [])];
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === undefined || visited.has(candidate)) continue;
    visited.add(candidate);
    pending.push(...(reverseGraph.get(candidate) ?? []));
  }
  return visited;
}

function collectNearestPipelineOwners(file, reverseGraph) {
  const owners = new Set();
  const visited = new Set();
  const pending = [...(reverseGraph.get(file) ?? [])];
  while (pending.length > 0) {
    const candidate = pending.shift();
    if (candidate === undefined || visited.has(candidate)) continue;
    visited.add(candidate);
    if (isPipelineOwner(sources.get(candidate) ?? "")) {
      owners.add(candidate);
      continue;
    }
    pending.push(...(reverseGraph.get(candidate) ?? []));
  }
  return owners;
}

function buildReverseImports(importGraph) {
  const result = new Map();
  for (const [consumer, dependencies] of importGraph) {
    for (const dependency of dependencies) {
      const consumers = result.get(dependency) ?? new Set();
      consumers.add(consumer);
      result.set(dependency, consumers);
    }
  }
  return result;
}

function resolveImports(file, source) {
  const dependencies = new Set();
  const importPattern = /(?:\bfrom\s+|\bimport\s*\()\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (specifier === undefined || !specifier.startsWith(".")) continue;
    const resolved = resolveTypeScriptSpecifier(file, specifier);
    if (resolved !== null && sources.has(resolved)) dependencies.add(resolved);
  }
  return dependencies;
}

function resolveTypeScriptSpecifier(importer, specifier) {
  const absolute = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    absolute.replace(/\.js$/, ".ts"),
    absolute,
    `${absolute}.ts`,
    path.join(absolute, "index.ts")
  ];
  return candidates.find((candidate) => sources.has(candidate)) ?? null;
}

function isPipelineOwner(source) {
  return /(?:render_pipelines\.obtain|compute_pipelines\.obtain|renderPipelines\.obtain|computePipelines\.obtain|createRenderPipeline(?:Async)?|createComputePipeline(?:Async)?|constructComputePass|constructRenderPass)\s*\(/.test(source);
}

async function collectProjectSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && shouldSkipDirectory(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectProjectSources(fullPath));
    else if (entry.isFile() && /\.(?:c|m)?(?:j|t)s$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}

function shouldSkipDirectory(name) {
  return name === "node_modules" || name === "dist" || name === ".test-dist" || name === ".git";
}

function readOutputArgument(args) {
  const index = args.indexOf("--output");
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--output requires a repository-relative path");
  }
  return value;
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}
