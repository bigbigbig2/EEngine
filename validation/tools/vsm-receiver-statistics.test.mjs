import test from "node:test";
import assert from "node:assert/strict";
import { summarizeVsmReceiverRequests } from "./vsm-receiver-statistics.mjs";

test("receiver counts exclude coarse pages sharing a requested bitset word", () => {
  const constants = Array(64).fill(0);
  constants[40] = 8;
  constants[41] = 8;
  constants[43] = 1;
  constants[44] = 1;
  constants[45] = 7;
  const result = summarizeVsmReceiverRequests({
    receiverConstants: constants,
    receiverWorkgroups: [8, 8, 7, 1, 64, 1, 1, 63],
    receiverRequestedWords: [1 | (1 << 5)]
  });
  assert.equal(result.rawRequests, 64);
  assert.equal(result.uniqueReceiverPages, 1);
  assert.equal(result.uniqueReceiverBitsetWords, 1);
  assert.equal(result.coarseFallbackPages, 1);
  assert.equal(result.workgroupWeightedPageDuplicateRatio, 63 / 64);
  assert.throws(
    () =>
      summarizeVsmReceiverRequests({
        receiverConstants: constants,
        receiverWorkgroups: [8, 8, 7, 1, 64, 1, 1, 62],
        receiverRequestedWords: [1]
      }),
    /63/
  );
});
