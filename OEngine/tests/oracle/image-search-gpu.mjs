import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeCook } from "../../tools/extreme-web-asset/cook.mjs";
import { createOfflineEvaluator } from "../../tools/extreme-web-asset/evaluation-host.mjs";
import { validateEvaluation } from "../../tools/extreme-web-asset/search.mjs";

// A concrete evaluator compile/readback check, not a search or scene cook.
const output = fileURLToPath(new URL("../../../.local/extreme-web-asset/evaluator-smoke/", import.meta.url));
await mkdir(output, { recursive: true });
const evaluator = await createOfflineEvaluator();
try {
  const rgba = new Uint8Array(8 * 8 * 4);
  for (let at = 0; at < rgba.length; at += 4) {
    rgba.set([64 + (at % 128), 128, 200, 255], at);
  }
  const request = {
    semantic: "color-rgb",
    quality: "high",
    mode: "resident",
    mips: "runtime",
    inputs: [{ width: 8, height: 8, rgba }],
    addressU: "repeat",
    addressV: "repeat"
  };
  const product = await nativeCook(request, output);
  const result = await evaluator.evaluate({ product, directory: output, canonical: request });
  validateEvaluation(result, request.semantic);
  assert.equal(result.hardSemantics, true);
  const receipt = {
    scope: "8x8 evaluator compile/final BC readback only; not a scene qualification",
    result
  };
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await evaluator.close();
}
