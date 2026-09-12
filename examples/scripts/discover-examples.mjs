import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const REQUIRED_FIELDS = ["id", "title", "category", "order", "description", "tags"];

export async function discoverExamples(examplesRoot) {
  const demosRoot = resolve(examplesRoot, "demos");
  const metadataFiles = await findMetadataFiles(demosRoot);
  const seenIds = new Set();
  const examples = [];

  for (const metadataFile of metadataFiles) {
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    validateMetadata(metadata, metadataFile);

    if (seenIds.has(metadata.id)) {
      throw new Error(`Duplicate example id '${metadata.id}' in ${metadataFile}`);
    }
    seenIds.add(metadata.id);

    const exampleDirectory = dirname(metadataFile);
    const route = `/demos/${relative(demosRoot, exampleDirectory).split(sep).join("/")}/`;
    const expectedCategory = relative(demosRoot, exampleDirectory).split(sep)[0];
    if (metadata.category !== expectedCategory) {
      throw new Error(
        `${metadataFile}: category '${metadata.category}' must match directory '${expectedCategory}'`
      );
    }

    await readFile(resolve(exampleDirectory, "index.html"));
    await readFile(resolve(exampleDirectory, "main.ts"));
    examples.push(Object.freeze({ ...metadata, route, metadataFile }));
  }

  examples.sort((left, right) =>
    left.category.localeCompare(right.category) ||
    left.order - right.order ||
    left.title.localeCompare(right.title)
  );
  return Object.freeze(examples);
}

async function findMetadataFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findMetadataFiles(path));
    else if (entry.isFile() && entry.name === "example.json") files.push(path);
  }
  return files;
}

function validateMetadata(metadata, metadataFile) {
  for (const field of REQUIRED_FIELDS) {
    if (!(field in metadata)) throw new Error(`${metadataFile}: missing '${field}'`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.id)) {
    throw new Error(`${metadataFile}: id must be kebab-case`);
  }
  if (!/^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.category)) {
    throw new Error(`${metadataFile}: category must start with a two-digit order`);
  }
  if (typeof metadata.title !== "string" || metadata.title.length === 0) {
    throw new Error(`${metadataFile}: title must be a non-empty string`);
  }
  if (!Number.isInteger(metadata.order) || metadata.order < 0) {
    throw new Error(`${metadataFile}: order must be a non-negative integer`);
  }
  if (typeof metadata.description !== "string" || metadata.description.length === 0) {
    throw new Error(`${metadataFile}: description must be a non-empty string`);
  }
  if (!Array.isArray(metadata.tags) || metadata.tags.some((tag) => typeof tag !== "string")) {
    throw new Error(`${metadataFile}: tags must be an array of strings`);
  }
}
