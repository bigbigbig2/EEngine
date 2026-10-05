import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parseMarkdown } from "../document-model.mjs";
import { verifyDocuments } from "../docs-verify.mjs";
import { loadNavigation, navigationSummary } from "../project-navigation.mjs";
import { checkGeneratedRegistry } from "../vibe-lib.mjs";

const text = (id, body = "", state = "current") =>
  `---\nid: ${id}\nstate: ${state}\nverifies:\n  files: [tools/production.js]\n---\n${body}`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "eengine-doc-"));
  t.after(async () => {
    assert.ok(
      resolve(root).startsWith(resolve(tmpdir()) + "\\eengine-doc-") ||
        resolve(root).startsWith(resolve(tmpdir()) + "/eengine-doc-"),
    );
    await rm(root, { recursive: true, force: true });
  });
  const write = async (path, value) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), value);
  };
  await write("tools/production.js", "export const value = 1;");
  await write("docs/a.md", text("a"));
  await write("docs/b.md", text("b"));
  return {
    root,
    write,
    git: (...args) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  };
}

test("production YAML parser rejects duplicate keys and supports actual YAML shapes", () => {
  assert.throws(() => parseMarkdown("---\nid: a\nid: b\nstate: current\n---\n"), /unique|duplicate/i);
  const parsed = parseMarkdown(
    "---\nid: a\nstate: current\nverifies: {files: ['tools/production.js']}\ndescription: |\n  two lines\n  stay valid\n---\n",
  );
  assert.deepEqual(parsed.fields.verifies.files, ["tools/production.js"]);
  assert.match(parsed.fields.description, /two lines/);
});
test("real Markdown links resolve spaces, references and escapes; code samples are not links", async (t) => {
  const { root, write } = await fixture(t);
  await write("docs/with space.md", text("space"));
  await write("docs/paren(1).md", text("paren"));
  const body =
    "[ref link]: with%20space.md\n\n[space](<with space.md>)\n[x][REF LINK]\n[x](paren\\(1\\).md)\n`[x](missing.md)`\n~~~md\n[x](missing.md)\n~~~";
  assert.equal(
    parseMarkdown(text("a", body)).links.length,
    3,
    "reference definition must be a block, not paragraph text",
  );
  await write("docs/a.md", text("a", body));
  assert.equal((await verifyDocuments({ root })).total, 0);
  await write("docs/a.md", text("a", "[ref]: missing.md\n\n[x][ref]"));
  assert.ok((await verifyDocuments({ root })).findings.some((item) => item.rule === "broken-reference"));
});
test("current broken links, case errors and escaping links fail; historical links stay diagnostic", async (t) => {
  const { root, write } = await fixture(t);
  await write("docs/a.md", text("a", "[case](B.md)\n[escape](../../outside.md)"));
  await write("docs/old.md", text("old", "[old](gone.md)", "history"));
  const report = await verifyDocuments({ root });
  assert.equal(report.findings.filter((item) => item.rule === "broken-reference").length, 2);
  assert.equal(report.warnings.length, 1);
});
test("changed includes untracked docs and cannot hide collisions with unchanged IDs", async (t) => {
  const { root, write, git } = await fixture(t);
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  await write("docs/new.md", text("b"));
  const report = await verifyDocuments({ root, mode: "changed" });
  assert.equal(report.selectedDocuments, 1);
  assert.ok(report.findings.some((item) => item.rule === "id-duplicate"));
  await assert.rejects(verifyDocuments({ root, mode: "changed", base: "invalid-ref" }));
});
test("staged uses actual index content and detects deleted targets through incoming links", async (t) => {
  const { root, write, git } = await fixture(t);
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  await write("docs/a.md", text("b"));
  git("add", "docs/a.md");
  await write("docs/a.md", text("a"));
  assert.ok(
    (await verifyDocuments({ root, mode: "staged" })).findings.some((item) => item.rule === "id-duplicate"),
  );
  git("reset", "--quiet");
  await write("docs/a.md", text("a", "[b](b.md)"));
  git("add", "docs/a.md");
  git("rm", "--quiet", "docs/b.md");
  assert.ok(
    (await verifyDocuments({ root, mode: "staged" })).findings.some(
      (item) => item.rule === "broken-reference",
    ),
  );
});
test("navigation rejects history/missing authority and keeps paused slices out of current modules", async (t) => {
  const { root, write } = await fixture(t);
  await write("project/domains/test.yaml", "id: test\npaths: [tools/**]\ncurrentDocs: [docs/a.md]\n");
  await write(
    "project/workstreams/active/test.yaml",
    "id: test\ndomain: test\nstate: active\nauthority:\n  design: docs/a.md\n  execution: docs/b.md\n",
  );
  await write("project/workstreams/active/paused.yaml", "id: paused\ndomain: test\nstate: paused\n");
  const summary = await navigationSummary("tools/production.js", await loadNavigation(root), root);
  assert.equal(summary.owner.primary, "test");
  assert.equal(summary.currentModules.length, 1);
  assert.deepEqual(summary.pausedWorkstreams, ["paused"]);
  await write("docs/b.md", text("b", "", "history"));
  await assert.rejects(
    navigationSummary("tools/production.js", await loadNavigation(root), root),
    /must be current/,
  );
  assert.ok((await verifyDocuments({ root })).findings.some((item) => item.rule === "history-used-as-entry"));
});
test("registry comparison detects drift without repairing the input", async (t) => {
  const { root, write } = await fixture(t);
  await write("registry.json", "stale");
  const path = join(root, "registry.json");
  assert.equal((await checkGeneratedRegistry({ cases: [] }, path)).ok, false);
  assert.equal(await readFile(path, "utf8"), "stale");
});
