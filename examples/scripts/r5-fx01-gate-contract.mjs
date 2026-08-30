const DIAGNOSTIC_COUNT_FIELDS = Object.freeze([
  "validationErrorCount",
  "uncapturedErrorCount",
  "deviceLostCount",
  "failedGpuTimestampBatches",
  "droppedGpuCounterSamples",
  "failedGpuCounterSamples"
]);

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export function captureGitBuildProvenance(repoRoot) {
  const commit = git(repoRoot, ["rev-parse", "HEAD"]);
  const dirtyReasons = git(repoRoot, ["status", "--porcelain"])
    .split(/\r?\n/)
    .filter(Boolean);
  const hash = createHash("sha256");
  hash.update("oengine-worktree-v1\0");
  hash.update(commit);
  hash.update("\0status\0");
  hash.update(dirtyReasons.join("\n"));
  hash.update("\0diff\0");
  hash.update(execFileSync(
    "git",
    ["diff", "--binary", "--submodule=diff", "HEAD", "--"],
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }
  ));
  const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  for (const relativePath of untracked) {
    hash.update("\0untracked\0");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(path.join(repoRoot, relativePath)));
  }
  return {
    commit,
    dirty: dirtyReasons.length > 0,
    dirtyReasons,
    contentHash: hash.digest("hex")
  };
}

export function evaluateBuildProvenance(pageBuild, currentBuild) {
  const issues = [];
  if (pageBuild === null || typeof pageBuild !== "object") {
    return { passed: false, issues: ["page build metadata is missing"] };
  }
  if (pageBuild.commit !== currentBuild.commit) {
    issues.push(
      `page build commit '${String(pageBuild.commit)}' does not match '${currentBuild.commit}'`
    );
  }
  if (pageBuild.dirty !== currentBuild.dirty) {
    issues.push(
      `page build dirty=${String(pageBuild.dirty)} does not match worktree dirty=${currentBuild.dirty}`
    );
  }
  if (!Array.isArray(pageBuild.dirtyReasons)) {
    issues.push("page build dirty reasons are missing");
  }
  const pageReasons = canonicalStrings(pageBuild.dirtyReasons);
  const currentReasons = canonicalStrings(currentBuild.dirtyReasons);
  if (JSON.stringify(pageReasons) !== JSON.stringify(currentReasons)) {
    issues.push("page build dirty reasons do not match the current worktree");
  }
  if (pageBuild.contentHash !== currentBuild.contentHash) {
    issues.push("page build content hash does not match the current worktree");
  }
  return { passed: issues.length === 0, issues };
}

export function evaluateDiagnosticSnapshots(snapshots) {
  const issues = [];
  for (const snapshot of snapshots) {
    const diagnostics = snapshot?.diagnostics;
    if (diagnostics === null || typeof diagnostics !== "object") {
      issues.push(`${snapshot?.label ?? "unknown"}: diagnostics are missing`);
      continue;
    }
    for (const field of DIAGNOSTIC_COUNT_FIELDS) {
      const value = diagnostics[field];
      if (typeof value !== "number" || value !== 0) {
        issues.push(`${snapshot.label}: ${field}=${String(value)}`);
      }
    }
    for (const field of ["uncapturedErrors", "deviceLostReasons"]) {
      const values = diagnostics[field];
      if (Array.isArray(values) && values.length > 0) {
        issues.push(`${snapshot.label}: ${field} contains ${values.length} entries`);
      }
    }
  }
  return { passed: issues.length === 0, issues };
}

export function velocityTilesAreZero(tileSamples) {
  if (!Array.isArray(tileSamples) || tileSamples.length !== 6) return false;
  const luminance = [];
  for (const sample of tileSamples) {
    if (!Array.isArray(sample?.rgb) || sample.rgb.length !== 3) return false;
    if (!sample.rgb.every(Number.isFinite) || !Number.isFinite(sample.luminance)) {
      return false;
    }
    if (Math.max(...sample.rgb) - Math.min(...sample.rgb) > 2) return false;
    luminance.push(sample.luminance);
  }
  return Math.max(...luminance) - Math.min(...luminance) <= 2;
}

function canonicalStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => typeof value === "string"))]
    .sort((left, right) => left.localeCompare(right));
}

function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}
