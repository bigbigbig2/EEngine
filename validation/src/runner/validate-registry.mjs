import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireValidRegistry } from "../shared/registry.mjs";

const validationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const registryPath = resolve(validationRoot, "registry.generated.json");
const registry = JSON.parse(await readFile(registryPath, "utf8"));
requireValidRegistry(registry);
console.log(`Validated ${registry.cases.length} validation cases from generated registry.`);
