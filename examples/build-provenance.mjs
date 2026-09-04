import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Capture the source state embedded in the Rendering Lab build. */
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

function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}
