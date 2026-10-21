import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { retireSuccessfulImageJob } from "../../tools/extreme-web-asset/scratch.mjs";

test("successful cook retires only its UUID job, preserving neighbors and failed jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-cook-scratch-"));
  const job = join(root, randomUUID()),
    failed = join(root, randomUUID());
  try {
    await mkdir(join(job, "canonical"), { recursive: true });
    await writeFile(join(job, "canonical", "samples.bin"), "rebuildable");
    await mkdir(failed);
    await writeFile(join(failed, "failure.log"), "preserve original failure");
    await assert.rejects(retireSuccessfulImageJob(root, root), /direct UUID/);
    await assert.rejects(retireSuccessfulImageJob(root, join(root, "..", randomUUID())), /direct UUID/);
    await assert.rejects(retireSuccessfulImageJob(root, join(job, randomUUID())), /direct UUID/);
    await assert.rejects(retireSuccessfulImageJob(root, join(root, "canonical")), /direct UUID/);
    await retireSuccessfulImageJob(root, job);
    await assert.rejects(stat(job), { code: "ENOENT" });
    assert.equal(await readFile(join(failed, "failure.log"), "utf8"), "preserve original failure");
  } finally {
    if (!resolve(root).startsWith(resolve(tmpdir(), "image-cook-scratch-")))
      throw new Error("Unexpected test root");
    await rm(root, { recursive: true });
  }
});
