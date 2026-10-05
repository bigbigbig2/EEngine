import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYamlObject, parseMarkdown } from "./document-model.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const normalizePath = (path) => path.replaceAll("\\", "/").replace(/^\.\//u, "");

export async function readYaml(path) {
  return parseYamlObject(await readFile(path, "utf8"), relative(REPO_ROOT, path));
}

export async function readYamlFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.ya?ml$/u.test(entry.name)) files.push(path);
    }
  }
  await walk(directory);
  return Promise.all(files.sort().map(async (path) => ({ path, value: await readYaml(path) })));
}

export function pathMatches(path, pattern) {
  const base = normalizePath(pattern).replace(/\/\*\*$/u, "");
  let expression = "";
  for (let i = 0; i < base.length; i++) {
    if (base[i] === "*" && base[i + 1] === "*") {
      expression += ".*";
      i++;
    } else if (base[i] === "*") expression += "[^/]*";
    else expression += base[i].replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${expression}(?:/.*)?$`, "u").test(normalizePath(path));
}

export function routeDomains(model, paths) {
  const matches = model.domains
    .flatMap((domain) => {
      const patterns = domain.paths.filter((pattern) => paths.some((path) => pathMatches(path, pattern)));
      return patterns.length
        ? [{ id: domain.id, patterns, score: Math.max(...patterns.map((p) => p.replaceAll("*", "").length)) }]
        : [];
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const [primary = null, ...related] = matches;
  return {
    primary,
    related,
    ambiguous: Boolean(primary && related.some((item) => item.score === primary.score)),
  };
}

export async function loadNavigation(root = REPO_ROOT) {
  const [domains, streams] = await Promise.all([
    readYamlFiles(resolve(root, "project/domains")),
    readYamlFiles(resolve(root, "project/workstreams/active")),
  ]);
  return { domains: domains.map((item) => item.value), workstreams: streams.map((item) => item.value) };
}

export async function navigationSummary(input, model, root = REPO_ROOT) {
  const all = input === ".";
  const routing = routeDomains(model, [input]);
  const primary = all ? model.domains : model.domains.filter((domain) => domain.id === routing.primary?.id);
  const streams = model.workstreams.filter(
    (stream) =>
      all ||
      stream.authority ||
      primary.some(
        (domain) => stream.domain === domain.id || (domain.decisions ?? []).includes(stream.decision),
      ),
  );
  const active = streams.filter((stream) => stream.state === "active");
  const documents = [...new Set(primary.flatMap((domain) => domain.currentDocs ?? []))];
  const authorities = active.filter((stream) => stream.authority).map((stream) => stream.authority);
  if (authorities.length > 1) throw new Error("multiple active renderer authorities");
  for (const path of [...documents, ...authorities.flatMap((entry) => Object.values(entry))]) {
    const doc = parseMarkdown(await readFile(resolve(root, path), "utf8"), path);
    if (doc.fields.state !== "current") throw new Error(`${path}: navigation authority must be current`);
  }
  return {
    input,
    owner: all
      ? { primary: primary.map((item) => item.id), related: [], ambiguous: false }
      : {
          primary: routing.primary?.id ?? null,
          related: routing.related.map((item) => item.id),
          ambiguous: routing.ambiguous,
        },
    documents,
    ...(authorities[0] ? { nextArchitecture: authorities[0] } : {}),
    currentModules: active.map((stream) => ({
      workstream: stream.id,
      currentSlice: stream.currentSlice ?? null,
      nextModules: (stream.nextModules ?? []).map((module) => module.id),
    })),
    pausedWorkstreams: streams.filter((stream) => stream.state === "paused").map((stream) => stream.id),
  };
}
