import { writeFile } from "node:fs/promises";

const sizes = Object.freeze([512, 512, 1024, 2048, 4096]);
const sizeClassCapacities = Object.freeze(new Map([
  [256, 64],
  [512, 32],
  [1024, 16],
  [2048, 32],
  [4096, 2]
]));

const permutations = uniquePermutations(sizes);
const sizeClassRuns = permutations.map(runSizeClassBanks);
const migratingRuns = permutations.map(runMigratingBank);
const result = {
  schemaVersion: 1,
  workload: {
    textureSizes: sizes,
    permutationCount: permutations.length,
    format: "rgba8unorm with full mip chain",
    reservedFallbackLayersPerBank: 1,
    residentBudgetBytes: 2 * 1024 * 1024 * 1024
  },
  candidates: [
    summarize("bounded-size-class-banks", {
      textureRefBits: "version[31:28], bankClass[27:24], layer[23:0]",
      bankCount: 5,
      sampledTextureBindings: 5,
      shaderBranch: "bounded bank-class switch",
      featureOff: "base bank only; high classes lazy",
      deviceLimits: "logical classes remain stable; physical resolution clamps to maxTextureDimension2D/quality cap and layer capacity clamps to maxTextureArrayLayers"
    }, sizeClassRuns),
    summarize("stable-ref-migrating-high-bank", {
      textureRefBits: "version/high-bank flag plus stable layer",
      bankCount: 2,
      sampledTextureBindings: 2,
      shaderBranch: "base/high select",
      featureOff: "base bank only; high bank lazy",
      deviceLimits: "largest size and combined layer capacity must fit one array"
    }, migratingRuns)
  ]
};

const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0) {
  const output = process.argv[outputIndex + 1];
  if (!output) throw new Error("--output requires a path");
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result, null, 2));

function runSizeClassBanks(order) {
  const banks = new Map();
  let allocatedBytes = mipBytes(256) * 64;
  let peakBytes = allocatedBytes;
  let resizeDispatches = 0;
  let copyOperations = 0;
  for (const size of order) {
    const classSize = nextPowerOfTwo(size);
    let bank = banks.get(classSize) ?? { capacity: 0, count: 0 };
    const exactCapacity = bank.count + 2;
    const requiredCapacity = classSize >= 2048 ? exactCapacity : nextPowerOfTwo(exactCapacity);
    if (requiredCapacity > bank.capacity) {
      const nextCapacity = Math.min(requiredCapacity, sizeClassCapacities.get(classSize));
      const oldBytes = mipBytes(classSize) * bank.capacity;
      const nextBytes = mipBytes(classSize) * nextCapacity;
      peakBytes = Math.max(peakBytes, allocatedBytes + nextBytes);
      allocatedBytes += nextBytes - oldBytes;
      copyOperations += bank.count * mipCount(classSize);
      bank = { ...bank, capacity: nextCapacity };
    }
    bank.count++;
    banks.set(classSize, bank);
    resizeDispatches++;
  }
  const residentLogicalBytes = [...banks.entries()]
    .reduce((sum, [size, bank]) => sum + mipBytes(size) * bank.count, 0);
  return {
    order,
    allocatedBytes,
    peakBytes,
    residentLogicalBytes,
    fragmentationBytes: allocatedBytes - residentLogicalBytes,
    resizeDispatches,
    copyOperations
  };
}

function runMigratingBank(order) {
  let size = 0;
  let capacity = 0;
  let count = 0;
  let allocatedBytes = mipBytes(256) * 64;
  let peakBytes = allocatedBytes;
  let resizeDispatches = 0;
  let copyOperations = 0;
  for (const sourceSize of order) {
    const nextSize = Math.max(size, nextPowerOfTwo(sourceSize));
    const nextCapacity = Math.max(capacity, nextPowerOfTwo(count + 2));
    if (nextSize !== size || nextCapacity !== capacity) {
      const oldBytes = size === 0 ? 0 : mipBytes(size) * capacity;
      const nextBytes = mipBytes(nextSize) * nextCapacity;
      peakBytes = Math.max(peakBytes, allocatedBytes + nextBytes);
      allocatedBytes += nextBytes - oldBytes;
      if (nextSize !== size) resizeDispatches += count;
      else copyOperations += count * mipCount(size);
      size = nextSize;
      capacity = nextCapacity;
    }
    count++;
    resizeDispatches++;
  }
  const residentLogicalBytes = mipBytes(size) * count;
  return {
    order,
    allocatedBytes,
    peakBytes,
    residentLogicalBytes,
    fragmentationBytes: allocatedBytes - residentLogicalBytes,
    resizeDispatches,
    copyOperations
  };
}

function summarize(id, contract, runs) {
  return {
    id,
    ...contract,
    finalAllocatedBytes: range(runs.map((run) => run.allocatedBytes)),
    allocatedPeakBytes: range(runs.map((run) => run.peakBytes)),
    residentLogicalBytes: range(runs.map((run) => run.residentLogicalBytes)),
    fragmentationBytes: range(runs.map((run) => run.fragmentationBytes)),
    resizeDispatches: range(runs.map((run) => run.resizeDispatches)),
    copyOperations: range(runs.map((run) => run.copyOperations)),
    withinFinalAllocationBudgetForEveryPermutation: runs.every((run) => run.allocatedBytes <= resultBudget()),
    withinTransactionPeakBudgetForEveryPermutation: runs.every((run) => run.peakBytes <= resultBudget())
  };
}

function resultBudget() {
  return 2 * 1024 * 1024 * 1024;
}

function range(values) {
  return { min: Math.min(...values), max: Math.max(...values) };
}

function mipBytes(size) {
  let texels = 0;
  for (let extent = size; extent >= 1; extent >>= 1) texels += extent * extent;
  return texels * 4;
}

function mipCount(size) {
  return Math.floor(Math.log2(size)) + 1;
}

function nextPowerOfTwo(value) {
  return 2 ** Math.ceil(Math.log2(Math.max(1, value)));
}

function uniquePermutations(values) {
  const output = [];
  const visit = (prefix, remaining) => {
    if (remaining.length === 0) {
      output.push(prefix);
      return;
    }
    const used = new Set();
    for (let index = 0; index < remaining.length; index++) {
      const value = remaining[index];
      if (used.has(value)) continue;
      used.add(value);
      visit([...prefix, value], [...remaining.slice(0, index), ...remaining.slice(index + 1)]);
    }
  };
  visit([], [...values]);
  return output;
}
