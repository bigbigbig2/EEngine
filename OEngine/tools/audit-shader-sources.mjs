import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "src");
const shaderRoot = path.join(sourceRoot, "shaders");

const sourceFiles = await collectTypeScript(sourceRoot);
const shaderFiles = sourceFiles.filter((file) => path.dirname(file) === shaderRoot);
const sources = new Map(
  await Promise.all(
    sourceFiles.map(async (file) => [file, await readFile(file, "utf8")])
  )
);

const entries = shaderFiles
  .sort((a, b) => a.localeCompare(b))
  .map((file) => {
    const base = path.basename(file, ".ts");
    const importNeedles = [`/${base}.js\"`, `/${base}.js'`, `./${base}.js\"`, `./${base}.js'`];
    const consumers = sourceFiles
      .filter((candidate) => candidate !== file)
      .filter((candidate) => {
        const source = sources.get(candidate) ?? "";
        return importNeedles.some((needle) => source.includes(needle));
      })
      .map(relative)
      .sort((a, b) => a.localeCompare(b));
    const generated = base.endsWith(".generated") || base.includes("generated");
    const oracle = base.includes("oracle");
    let classification = consumers.length > 0 ? "authored-live" : "dead";
    if (generated) classification = consumers.length > 0 ? "generated-live" : "generated-dead";
    if (oracle) classification = consumers.length > 0 ? "oracle-live" : "oracle-reference";
    return {
      shader: relative(file),
      classification,
      consumers
    };
  });

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  sourceRoot: "src",
  shaderCount: entries.length,
  entries
}, null, 2)}\n`);

async function collectTypeScript(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTypeScript(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(fullPath);
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}
