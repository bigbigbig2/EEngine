import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildTests, verifyTestBuild } from "../test-build.mjs";

test("real tsc output rejects both changed production input and edited compiled output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eengine-build-"));
  t.after(async () => {
    assert.ok(resolve(root).includes("eengine-build-"));
    await rm(root, { recursive: true, force: true });
  });
  const write = async (p, s) => {
    await mkdir(join(root, p, ".."), { recursive: true });
    await writeFile(join(root, p), s);
  };
  await write("OEngine/src/index.ts", "export const value: number = 1;");
  await write(
    "OEngine/tsconfig.test.json",
    JSON.stringify({
      compilerOptions: { outDir: ".test-dist", rootDir: "src", target: "ES2022", skipLibCheck: true },
      include: ["src"]
    })
  );
  // Delegate to the project's actual installed compiler, not a fake build result.
  const compiler = new URL("../../OEngine/node_modules/typescript/lib/tsc.js", import.meta.url);
  await write(
    "OEngine/node_modules/typescript/lib/tsc.js",
    `require(${JSON.stringify(decodeURIComponent(compiler.pathname.replace(/^\/([A-Z]:)/, "$1")))})`
  );
  await write("tools/test-build.mjs", await readFile(new URL("../test-build.mjs", import.meta.url), "utf8"));
  await assert.rejects(verifyTestBuild(root), /identity missing/);
  await buildTests(root);
  await verifyTestBuild(root);
  await write("OEngine/src/index.ts", "export const value: number = 2;");
  await assert.rejects(verifyTestBuild(root), /input changed/);
  await buildTests(root);
  await write("OEngine/.test-dist/index.js", "export const value = 9;");
  await assert.rejects(verifyTestBuild(root), /output changed/);
});
