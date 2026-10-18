// Enforces the example-library contract:
//   examples/integrated/<name>/ is one self-contained example: index.html + main.ts
//   with its own config, metadata and assets. Examples never import each other, and
//   the retired demos/ , shared/ , stories/ and numeric category directories are gone.
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const examplesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const integratedRoot = resolve(examplesRoot, "integrated");
const REQUIRED_FILES = ["index.html", "main.ts", "example.json", "tsconfig.json", "vite.config.ts"];
const REQUIRED_FIELDS = ["id", "title", "description", "tags"];
const FORBIDDEN_DIRECTORIES = ["demos", "shared", "stories", ".storybook"];
const failures = [];

function fail(message) {
  failures.push(message);
}

async function directories(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist")
    .map((entry) => resolve(directory, entry.name));
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(?:ts|html)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

for (const name of FORBIDDEN_DIRECTORIES) {
  if (existsSync(resolve(examplesRoot, name))) fail(`retired directory still exists: examples/${name}/`);
}

for (const directory of await directories(examplesRoot)) {
  const name = relative(examplesRoot, directory).replaceAll("\\", "/");
  if (name === "integrated") continue;
  if (/^\d/u.test(name)) fail(`numeric category directory is not allowed: examples/${name}/`);
}

const exampleNames = (await directories(integratedRoot)).map((directory) => relative(integratedRoot, directory));
if (exampleNames.length === 0) fail("examples/integrated/ contains no example");

for (const name of exampleNames) {
  const directory = resolve(integratedRoot, name);
  for (const file of REQUIRED_FILES) {
    if (!existsSync(resolve(directory, file))) fail(`examples/integrated/${name}: missing ${file}`);
  }

  const metadataPath = resolve(directory, "example.json");
  if (existsSync(metadataPath)) {
    let metadata;
    try {
      metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    } catch (error) {
      fail(`examples/integrated/${name}/example.json: ${error.message}`);
      continue;
    }
    for (const field of REQUIRED_FIELDS) {
      if (!(field in metadata)) fail(`examples/integrated/${name}/example.json: missing '${field}'`);
    }
    if (metadata.id !== name) {
      fail(`examples/integrated/${name}/example.json: id '${metadata.id}' must match the directory name`);
    }
    for (const field of ["category", "order"]) {
      if (field in metadata) fail(`examples/integrated/${name}/example.json: '${field}' is a retired numeric-classification field`);
    }
  }

  for (const file of await sourceFiles(directory)) {
    const text = await readFile(file, "utf8");
    for (const other of exampleNames) {
      if (other === name) continue;
      if (new RegExp(`(?:\\.\\./)+${other}/`, "u").test(text) || text.includes(`/integrated/${other}/`)) {
        fail(`${relative(examplesRoot, file)}: imports the sibling example '${other}'`);
      }
    }
  }
}

if (failures.length) {
  console.error(`examples check failed (${failures.length}):`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(`examples check passed: ${exampleNames.length} self-contained examples (${exampleNames.join(", ")})`);
