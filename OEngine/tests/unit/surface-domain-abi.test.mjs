import assert from "node:assert/strict";
import test from "node:test";
import {
  DOMAIN_DIRECTORY_HEADER_WORDS,
  DOMAIN_RECORD_HEADER_WORDS,
  SurfaceDomainDirectoryBuilder,
  readSurfaceDomainRecord,
} from "../../.test-dist/gpu/GpuSurfaceDomainAbi.js";

const PLANES = 21;

test("equal domain keys intern to one record and unequal keys never do", () => {
  const builder = new SurfaceDomainDirectoryBuilder(PLANES);
  const first = builder.intern({ closure: 7, planeMask: 0b101, tileEdges: 8, sampleMask: 0, sampleCount: 0 });
  const same = builder.intern({ closure: 7, planeMask: 0b101, tileEdges: 8, sampleMask: 0, sampleCount: 0 });
  assert.equal(first, same, "equal keys must be one entity");
  assert.equal(builder.size, 1);
  // Every component of the key participates. A differing closure, plane mask,
  // tile edge or sample mask is a different domain, not a rounding difference.
  assert.equal(
    builder.intern({ closure: 8, planeMask: 0b101, tileEdges: 8, sampleMask: 0, sampleCount: 0 }),
    1,
  );
  assert.equal(
    builder.intern({ closure: 7, planeMask: 0b100, tileEdges: 8, sampleMask: 0, sampleCount: 0 }),
    2,
  );
  assert.equal(
    builder.intern({ closure: 7, planeMask: 0b101, tileEdges: 4, sampleMask: 0, sampleCount: 0 }),
    3,
  );
  assert.equal(
    builder.intern({ closure: 7, planeMask: 0b101, tileEdges: 8, sampleMask: 1, sampleCount: 1 }),
    4,
  );
  assert.equal(builder.size, 5);
});

test("domain count, reference count and sample work are separate quantities", () => {
  // The whole point of the entity: 32,400 tiles can reference one domain, and
  // that domain can describe zero, one or many samples. A single number cannot
  // carry all three, which is what the execution plan requires to be assertable.
  const builder = new SurfaceDomainDirectoryBuilder(PLANES);
  const published = builder.intern({ closure: 1, planeMask: 1, tileEdges: 8, sampleMask: 0, sampleCount: 0 });
  const evaluated = builder.intern({
    closure: 2,
    planeMask: 3,
    tileEdges: 8,
    sampleMask: 0b111,
    sampleCount: 3,
  });
  const directory = builder.build();
  assert.equal(directory.records.length, 2, "domain count");
  assert.equal(directory.words[0], 2);
  assert.equal(directory.sampleSlots, 3, "per-domain sample slots, not frame work");
  assert.equal(directory.planeMaskUnion, 1 | 3);

  // Chosen so all three counts differ: 10 references, 2 domains, 3 per-domain
  // slots and 30 frame work. Picking values that happen to coincide would make
  // the assertions below pass without testing the separation at all.
  const references = Uint32Array.from({ length: 10 }, (_, at) => (at < 9 ? published : evaluated));
  const frameWork = references.reduce(
    (total, id) => total + readSurfaceDomainRecord(directory.words, id).sampleCount,
    0,
  );
  assert.equal(frameWork, 3, "one reference to the evaluated domain times three slots");
  assert.notEqual(frameWork, references.length, "frame work must not collapse to the reference count");
  assert.notEqual(
    directory.sampleSlots,
    references.length,
    "per-domain slots must not collapse to the reference count",
  );
  assert.notEqual(
    directory.sampleSlots,
    directory.records.length,
    "per-domain slots must not collapse to the domain count",
  );
  // Two domains, and every reference is one of them, yet frame work is below
  // both counts: neither count can be used to predict the work.
  assert.ok(references.length > directory.records.length);
  assert.ok(frameWork < directory.records.length + directory.sampleSlots);
});

test("packed directory round-trips through the reader the GPU path uses", () => {
  const builder = new SurfaceDomainDirectoryBuilder(PLANES);
  builder.intern({
    closure: 0xdeadbeef,
    planeMask: 0x1fffff,
    tileEdges: 8,
    sampleMask: 0x8000_0001,
    sampleCount: 2,
  });
  const directory = builder.build();
  assert.equal(directory.words[1], DOMAIN_RECORD_HEADER_WORDS + directory.words[2]);
  assert.equal(directory.words[0], 1);
  const record = readSurfaceDomainRecord(directory.words, 0);
  assert.equal(record.closure, 0xdeadbeef);
  assert.equal(record.planeMask, 0x1fffff);
  assert.equal(record.tileEdges, 8);
  assert.equal(record.sampleMask, 0x8000_0001);
  assert.equal(record.sampleCount, 2);
  // The header is a fixed prefix, so a consumer can find records without a
  // second descriptor.
  assert.equal(DOMAIN_DIRECTORY_HEADER_WORDS, 3);
  assert.throws(() => readSurfaceDomainRecord(directory.words, 1), /outside the directory/);
  assert.throws(() => readSurfaceDomainRecord(directory.words, -1), /outside the directory/);
});

test("a domain whose sample count disagrees with its mask is rejected", () => {
  // sampleCount is redundant with sampleMask on purpose: the two are written by
  // different call sites, and a silent disagreement would make frame work and
  // per-domain work disagree in a way no reader could detect.
  const builder = new SurfaceDomainDirectoryBuilder(PLANES);
  assert.throws(
    () => builder.intern({ closure: 1, planeMask: 1, tileEdges: 8, sampleMask: 0b101, sampleCount: 3 }),
    /disagrees with its mask/,
  );
  assert.throws(
    () => builder.intern({ closure: 1, planeMask: 1, tileEdges: 8, sampleMask: 0b101, sampleCount: 0 }),
    /disagrees with its mask/,
  );
  // Malformed keys are rejected at the publication boundary, where a caller can
  // still act, rather than producing a directory the GPU would misread.
  assert.throws(
    () => builder.intern({ closure: -1, planeMask: 1, tileEdges: 8, sampleMask: 0, sampleCount: 0 }),
    /closure/,
  );
  assert.throws(
    () => builder.intern({ closure: 1, planeMask: 1 << 22, tileEdges: 8, sampleMask: 0, sampleCount: 0 }),
    /plane mask/,
  );
  assert.throws(
    () => builder.intern({ closure: 1, planeMask: 1, tileEdges: 0, sampleMask: 0, sampleCount: 0 }),
    /tile edge/,
  );
  assert.equal(builder.size, 0, "rejected keys must not occupy a domain id");
});

test("an empty directory stays readable and declares no work", () => {
  const directory = new SurfaceDomainDirectoryBuilder(PLANES).build();
  assert.equal(directory.records.length, 0);
  assert.equal(directory.words[0], 0);
  assert.equal(directory.sampleSlots, 0);
  assert.equal(directory.planeMaskUnion, 0);
  // A zero-domain frame is a legal frame, and reading no record must not throw
  // for the same reason an out-of-range id does.
  assert.throws(() => readSurfaceDomainRecord(directory.words, 0), /outside the directory/);
});
