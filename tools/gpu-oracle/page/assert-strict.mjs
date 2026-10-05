// Browser-side stand-in for `node:assert/strict`.
//
// The three GPU oracles under OEngine/tests/oracle/ import `node:assert/strict`
// and are loaded unmodified into Chrome by this harness (editing them is out of
// scope for the harness). Chrome cannot resolve the `node:` scheme, so the host
// page maps that exact specifier onto this module through an import map.
//
// Only the surface the oracles actually use is implemented. Anything else fails
// loudly instead of behaving like a silent no-op, because a silently passing
// assertion would turn this harness into a false green.

export class AssertionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AssertionError";
    this.code = "ERR_ASSERTION";
    this.actual = details.actual;
    this.expected = details.expected;
    this.operator = details.operator ?? "==";
  }
}

const IDENTITY = Object.is;

function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "symbol" || typeof value === "function") return String(value);
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Deep strict equality for the value shapes the oracles compare (arrays of numbers, plain records). */
export function isDeepStrictEqual(left, right, seen = new Map()) {
  if (IDENTITY(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  const previous = seen.get(left);
  if (previous !== undefined) return previous === right;
  seen.set(left, right);
  const leftTag = Object.prototype.toString.call(left);
  if (leftTag !== Object.prototype.toString.call(right)) return false;
  if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
    if (!ArrayBuffer.isView(left) || !ArrayBuffer.isView(right)) return false;
    if (left.constructor !== right.constructor || left.byteLength !== right.byteLength) return false;
    const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    for (let index = 0; index < leftBytes.length; index++) {
      if (leftBytes[index] !== rightBytes[index]) return false;
    }
    return true;
  }
  if (leftTag === "[object Date]") return left.getTime() === right.getTime();
  if (leftTag === "[object RegExp]") return String(left) === String(right);
  if (leftTag === "[object Map]") {
    if (left.size !== right.size) return false;
    for (const [key, value] of left) {
      if (!right.has(key) || !isDeepStrictEqual(value, right.get(key), seen)) return false;
    }
    return true;
  }
  if (leftTag === "[object Set]") {
    if (left.size !== right.size) return false;
    for (const value of left) {
      if (!right.has(value)) return false;
    }
    return true;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!isDeepStrictEqual(left[key], right[key], seen)) return false;
  }
  return true;
}

function fail(message, details) {
  throw new AssertionError(message, details);
}

function assert(value, message) {
  if (!value) {
    fail(
      message === undefined
        ? `The expression evaluated to a falsy value: ${describe(value)}`
        : String(message),
      {
        actual: value,
        expected: true,
        operator: "==",
      },
    );
  }
}

function unsupported(name) {
  return () => {
    throw new Error(
      `gpu-oracle assert shim does not implement assert.${name}; add it to tools/gpu-oracle/page/assert-strict.mjs`,
    );
  };
}

assert.ok = assert;
assert.strictEqual = (actual, expected, message) => {
  if (!IDENTITY(actual, expected)) {
    fail(
      `${message === undefined ? "Values are not strictly equal" : String(message)}: ${describe(actual)} !== ${describe(expected)}`,
      {
        actual,
        expected,
        operator: "strictEqual",
      },
    );
  }
};
assert.equal = assert.strictEqual;
assert.notStrictEqual = (actual, expected, message) => {
  if (IDENTITY(actual, expected)) {
    fail(`${message === undefined ? "Values are strictly equal" : String(message)}: ${describe(actual)}`, {
      actual,
      expected,
      operator: "notStrictEqual",
    });
  }
};
assert.notEqual = assert.notStrictEqual;
assert.deepEqual = (actual, expected, message) => {
  if (!isDeepStrictEqual(actual, expected)) {
    fail(
      `${message === undefined ? "Values are not deeply strictly equal" : String(message)}: ${describe(actual)} !== ${describe(expected)}`,
      {
        actual,
        expected,
        operator: "deepStrictEqual",
      },
    );
  }
};
assert.deepStrictEqual = assert.deepEqual;
assert.notDeepEqual = (actual, expected, message) => {
  if (isDeepStrictEqual(actual, expected)) {
    fail(
      `${message === undefined ? "Values are deeply strictly equal" : String(message)}: ${describe(actual)}`,
      {
        actual,
        expected,
        operator: "notDeepStrictEqual",
      },
    );
  }
};
assert.fail = (message) => fail(message === undefined ? "Failed" : String(message), { operator: "fail" });
assert.throws = unsupported("throws");
assert.rejects = unsupported("rejects");
assert.match = unsupported("match");
assert.AssertionError = AssertionError;

export default assert;
