import assert from "node:assert/strict";

// Consumes paused diagnostic copies only. No values steer GPU work.
export function summarizeVsmReceiverRequests(headers) {
  const groups = headers.receiverWorkgroups;
  const requested = headers.receiverRequestedWords;
  const constants = headers.receiverConstants;
  const [width, height, generation, groupCount] = groups;
  assert.equal(groups.length, 4 + groupCount * 4, "complete workgroup write domain");
  assert.equal(groupCount, Math.ceil(width / 8) * Math.ceil(height / 8));
  assert.equal(width, constants[40]);
  assert.equal(height, constants[41]);
  assert.equal(generation, constants[45]);
  const pages = constants[43],
    levels = constants[44];
  let stride = 0;
  for (let mip = 0; mip < 6; mip++) {
    const axis = Math.max(1, pages >> mip) * (mip === 5 ? 2 : 1);
    stride += axis * axis;
  }
  let raw = 0,
    groupPages = 0,
    groupWords = 0,
    globalAttempts = 0,
    activeGroups = 0,
    ratioSum = 0;
  const histogram = Array(65).fill(0);
  for (let i = 0; i < groupCount; i++) {
    const at = 4 + i * 4;
    const [attempts, uniquePages, uniqueWords, publishedWords] = groups.slice(at, at + 4);
    const duplicates = attempts - uniquePages;
    assert.ok(attempts <= 64 && uniqueWords <= uniquePages && uniquePages <= attempts);
    assert.ok(publishedWords >= uniqueWords && publishedWords <= attempts);
    raw += attempts;
    groupPages += uniquePages;
    groupWords += uniqueWords;
    globalAttempts += publishedWords;
    histogram[uniquePages]++;
    if (attempts !== 0) {
      activeGroups++;
      ratioSum += duplicates / attempts;
    }
  }
  let uniquePages = 0,
    uniqueWords = 0,
    coarsePages = 0;
  for (let word = 0; word < requested.length; word++) {
    let bits = requested[word] >>> 0,
      receiverWord = false;
    while (bits !== 0) {
      const bit = 31 - Math.clz32((bits & -bits) >>> 0);
      const page = word * 32 + bit;
      assert.ok(page < stride * levels, "requested page fits full negotiated identity domain");
      if (page % stride < pages * pages) {
        uniquePages++;
        receiverWord = true;
      } else {
        coarsePages++;
      }
      bits = (bits & (bits - 1)) >>> 0;
    }
    if (receiverWord) uniqueWords++;
  }
  assert.ok(raw <= width * height && groupPages >= uniquePages && groupWords >= uniqueWords);
  return {
    width,
    height,
    generation,
    groupCount,
    activeGroups,
    rawRequests: raw,
    atomicOrAttempts: globalAttempts,
    uniqueReceiverPages: uniquePages,
    uniqueReceiverBitsetWords: uniqueWords,
    coarseFallbackPages: coarsePages,
    sumWorkgroupUniquePages: groupPages,
    sumWorkgroupUniqueWords: groupWords,
    workgroupWeightedPageDuplicateRatio: raw ? 1 - groupPages / raw : 0,
    workgroupWeightedWordDuplicateRatio: raw ? 1 - groupWords / raw : 0,
    meanActiveWorkgroupPageDuplicateRatio: activeGroups ? ratioSum / activeGroups : 0,
    workgroupUniquePageHistogram: histogram,
    warning: "Instrumented statistics only; GPU timings from this run are not performance evidence."
  };
}
