import { readFile } from "node:fs/promises";

const [leftPath, rightPath] = process.argv.slice(2);
if (!leftPath || !rightPath) {
  throw new Error("usage: node compare-canvas-parity.mjs <class-depth-report.json> <class-discard-report.json>");
}

const [left, right] = await Promise.all([load(leftPath), load(rightPath)]);
if (!Array.isArray(left.runs) || !Array.isArray(right.runs) || left.runs.length !== right.runs.length) {
  throw new Error("canvas parity requires equal run counts in both reports");
}

const comparisons = left.runs.map((run, index) => {
  const other = right.runs[index];
  const leftHash = run.canvasSha256;
  const rightHash = other?.canvasSha256;
  return {
    ordinal: index,
    leftHash,
    rightHash,
    exact: typeof leftHash === "string" && leftHash === rightHash
  };
});
const result = {
  leftBackend: left.materialResolveBackend,
  rightBackend: right.materialResolveBackend,
  runCount: comparisons.length,
  exactRunCount: comparisons.filter((entry) => entry.exact).length,
  comparisons,
  parity: comparisons.every((entry) => entry.exact) ? "exact" : "mismatch"
};
console.log(JSON.stringify(result, null, 2));
if (result.parity !== "exact") process.exitCode = 1;

async function load(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
