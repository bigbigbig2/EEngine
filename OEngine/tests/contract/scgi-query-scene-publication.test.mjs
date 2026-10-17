import assert from "node:assert/strict";
import test from "node:test";
import { ScgiQueryScenePublication } from "../../.test-dist/render/gi/ScgiQueryScenePublication.js";

function command() {
  return { closed: false, observers: [], observeSubmission(observer) { this.observers.push(observer); } };
}
function scene() {
  return { prepared: true, used: null, retirements: [],
    encode(command) { this.prepared = false; this.used = command; },
    async releaseAfter(fence) { this.retirements.push(fence); await fence; },
  };
}
function submit(command, fence = Promise.resolve()) {
  command.closed = true;
  for (const observer of command.observers) observer.submitted?.(fence);
}
test("query cut replacement publishes only on submit; abort leaves active and its pages untouched", async () => {
  const publication = new ScgiQueryScenePublication();
  const coarse = scene(), first = command();
  publication.stage(coarse, first);
  assert.equal(publication.current, null);
  assert.equal(publication.frameReadable(first), coarse);
  assert.equal(publication.frameReadable(command()), null);
  submit(first);
  assert.equal(publication.current, coarse);
  const abandoned = scene(), abort = command();
  publication.stage(abandoned, abort);
  for (const observer of abort.observers) observer.aborted?.(new Error("cancel cut"));
  assert.equal(publication.current, coarse);
  assert.equal(coarse.retirements.length, 0);
  const fine = scene(), replacement = command();
  publication.stage(fine, replacement);
  assert.equal(publication.current, coarse);
  let complete;
  const fence = new Promise((resolve) => { complete = resolve; });
  submit(replacement, fence);
  assert.equal(publication.current, fine);
  assert.equal(publication.retiringCount, 1);
  assert.deepEqual(coarse.retirements, [fence]);
  complete();
  await fence;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(publication.retiringCount, 0);
});

test("a failed replacement fence quarantines publication and retiring pages", async () => {
  const publication = new ScgiQueryScenePublication();
  const first = command();
  publication.stage(scene(), first);
  submit(first);
  const next = command();
  publication.stage(scene(), next);
  const error = new Error("failed GPU cut replacement");
  submit(next, Promise.reject(error));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(publication.current, null);
  assert.equal(publication.error, error);
  assert.equal(publication.retiringCount, 1);
  assert.throws(() => publication.stage(scene(), command()), /complete unused candidate/);
});
