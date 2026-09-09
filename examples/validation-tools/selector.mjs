import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { VALIDATION_CASES } from "./cases.mjs";
import {
  UNMAPPED_OENGINE_FALLBACK_CASES,
  domainsForPath,
  isUnmappedEngineSource,
  normalizeRepositoryPath
} from "./source-domains.mjs";

const execFile = promisify(execFileCallback);

export function selectCasesForPaths(paths) {
  const normalizedPaths = [...new Set(paths.map(normalizeRepositoryPath))].sort();
  const domains = new Set();
  const unmappedPaths = [];
  for (const path of normalizedPaths) {
    const matched = domainsForPath(path);
    matched.forEach((domain) => domains.add(domain));
    if (isUnmappedEngineSource(path, matched)) unmappedPaths.push(path);
  }

  const caseIds = new Set();
  for (const entry of VALIDATION_CASES) {
    if (entry.changedDomains.some((domain) => domains.has(domain))) caseIds.add(entry.id);
  }
  if (unmappedPaths.length > 0) {
    UNMAPPED_OENGINE_FALLBACK_CASES.forEach((caseId) => caseIds.add(caseId));
  }

  return {
    paths: normalizedPaths,
    domains: [...domains].sort(),
    caseIds: VALIDATION_CASES.filter((entry) => caseIds.has(entry.id)).map((entry) => entry.id),
    unmappedPaths
  };
}

export async function workingTreePaths(repositoryRoot) {
  const { stdout } = await execFile(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  return parsePorcelainV1Z(stdout);
}

export async function changedPathsFromBase(repositoryRoot, base) {
  const { stdout } = await execFile(
    "git",
    ["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", `${base}...HEAD`],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  return stdout.split("\0").filter(Boolean).map(normalizeRepositoryPath);
}

export function parsePorcelainV1Z(output) {
  const tokens = output.split("\0");
  const paths = [];
  for (let index = 0; index < tokens.length; index++) {
    const record = tokens[index];
    if (!record) continue;
    if (record.length < 4) throw new Error(`Malformed git status record '${record}'`);
    const status = record.slice(0, 2);
    paths.push(normalizeRepositoryPath(record.slice(3)));
    if (/[RC]/.test(status)) {
      const original = tokens[++index];
      if (!original) throw new Error(`Rename/copy record '${record}' is missing its original path`);
      paths.push(normalizeRepositoryPath(original));
    }
  }
  return [...new Set(paths)].sort();
}
