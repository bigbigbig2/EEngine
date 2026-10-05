import assert from "node:assert/strict";
import test from "node:test";
import { encodeFloat16, decodeFloat16 } from "../../.test-dist/core/Float16.js";

test("binary16 all finite encodings and signed infinities round-trip exactly", () => {
  for (let word = 0; word <= 65535; word++) {
    const exponent = (word >>> 10) & 31,
      fraction = word & 1023;
    const value = decodeFloat16(word);
    if (exponent === 31 && fraction !== 0) assert.ok(Number.isNaN(value));
    else assert.equal(encodeFloat16(value), word, `word ${word.toString(16)}`);
  }
  assert.ok(Object.is(decodeFloat16(0x8000), -0));
});

test("binary16 midpoints use ties-to-even including zero, subnormal, normal and overflow boundaries", () => {
  assert.equal(encodeFloat16(1 + 2 ** -11), 0x3c00);
  assert.equal(encodeFloat16(1 + 3 * 2 ** -11), 0x3c02);
  assert.equal(encodeFloat16(2 ** -25), 0);
  assert.equal(encodeFloat16(3 * 2 ** -25), 2);
  assert.equal(encodeFloat16(2 ** -14 - 2 ** -25), 0x0400);
  assert.equal(encodeFloat16(65504), 0x7bff);
  assert.equal(encodeFloat16(65520), 0x7c00);
  assert.equal(encodeFloat16(-65520), 0xfc00);
  assert.equal(encodeFloat16(NaN) & 0x7fff, 0x7e00);
});
