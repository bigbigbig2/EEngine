import assert from "node:assert/strict";
import test from "node:test";
import { geometryQueryDomain, geometryQueryDomainWords } from "../../.test-dist/gpu/GeometryQueryDomain.js";

test("query domain encloses all cascades and the complete finite guard with outward f32 bounds", () => {
  const cascades = [
    { min: [0.1, -2, -3], max: [1.1, 2, 3] },
    { min: [-4, -5, -6], max: [4, 5, 6] },
  ];
  const domain = geometryQueryDomain(cascades, 0.3);
  for (const cascade of cascades) {
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(domain.min[axis] <= cascade.min[axis] - 0.3);
      assert.ok(domain.max[axis] >= cascade.max[axis] + 0.3);
    }
  }
  const words = geometryQueryDomainWords(domain);
  assert.equal(words[3], 1);
  assert.deepEqual([...words.subarray(0, 3)], domain.min);
  assert.deepEqual([...words.subarray(4, 7)], domain.max);
  cascades[1].min[0] = -100;
  assert.ok(domain.min[0] > -100);
  assert.ok(Object.isFrozen(domain.min));
  assert.equal(geometryQueryDomainWords()[3], 0);
});

test("query domain rejects missing, inverted, infinite and overflowing coverage", () => {
  const valid = { min: [0, 0, 0], max: [1, 1, 1] };
  for (const [cascades, guard] of [
    [[], 0], [[valid], -1], [[valid], Infinity],
    [[{ min: [2, 0, 0], max: [1, 1, 1] }], 0],
    [[{ min: [0, 0, 0], max: [Infinity, 1, 1] }], 0],
    [[{ min: [0, 0, 0], max: [3.5e38, 1, 1] }], 0],
    [[{ min: [0, 0], max: [1, 1, 1] }], 0],
  ]) {
    assert.throws(() => geometryQueryDomain(cascades, guard), RangeError);
  }
});

test("query domain rounds tiny signed and negative f32 coordinates outward", () => {
  for (const value of [1e-48, -1e-48, -0.1, 0.1, 16777217, -16777217]) {
    const domain = geometryQueryDomain([{ min: [value, value, value], max: [value, value, value] }], 0);
    assert.ok(domain.min[0] <= value);
    assert.ok(domain.max[0] >= value);
  }
});
