/**
 * assert：提供渲染器共享的基础数据结构与通用工具。
 */

import { arrayShallowEquals, isTypedArray } from "./arrayUtils.js";

export function assert(e: unknown, t?: string): asserts e {
  if (!e) throw new Error(t || "AssertionError");
}

export function assertIsOneOf(
  e: unknown,
  t: unknown[],
  n = "value"
): void {
  if (t.indexOf(e) === -1) {
    throw new Error(
      `${n} must be one of [${t.join(", ")}], instead was '${e}'`
    );
  }
}

const TYPEOF_KINDS = [
  "string",
  "boolean",
  "number",
  "object",
  "undefined",
  "function",
  "symbol"
];

export const Assert = {
  ok: assert,

  enum(e: unknown, t: Record<string, unknown>, n = "value"): void {
    for (const k in t) {
      if (Object.prototype.hasOwnProperty.call(t, k) && t[k] === e) return;
    }
    throw new Error(
      `${n}(=${e}) is not a valid enumerable value, valid values are: [${Object.values(t).join(", ")}]`
    );
  },

  notEqual(e: unknown, t: unknown, n?: string): void {
    assert(e !== t, n);
  },

  notOk(e: unknown, t?: string): void {
    assert(!e, t);
  },

  equal(e: unknown, t: unknown, n?: string): void {
    if (e !== t) {
      const r = `${e} !== ${t}`;
      throw new Error(n !== undefined && n !== "" ? `${n}. ${r}` : r);
    }
  },

  logicalyEqual(_e: unknown, _t: unknown, _n?: string): void {},

  greaterThan(e: number, t: number, n?: string): void {
    if (!(e > t)) {
      let r = "";
      if (n !== undefined) r += n + ". ";
      r += `Expected ${e} > ${t}.`;
      throw new Error(r);
    }
  },

  greaterThanOrEqual(e: number, t: number, n?: string): void {
    if (!(e >= t)) {
      let r = "";
      if (n !== undefined) r += n + ". ";
      r += `Expected ${e} >= ${t}.`;
      throw new Error(r);
    }
  },

  lessThan(e: number, t: number, n?: string): void {
    if (!(e < t)) {
      let r = "";
      if (n !== undefined) r += n + ". ";
      r += `Expected ${e} < ${t}.`;
      throw new Error(r);
    }
  },

  lessThanOrEqual(e: number, t: number, n?: string): void {
    if (!(e <= t)) {
      let r = "";
      if (n !== undefined) r += n + ". ";
      r += `Expected ${e} <= ${t}.`;
      throw new Error(r);
    }
  },

  typeOf(e: unknown, t: string, n = "value"): void {
    assertIsOneOf(typeof e, TYPEOF_KINDS);
    const r = typeof e;
    if (r !== t) {
      throw new Error(`expected ${n} to be ${t}, instead was '${r}'(=${e})`);
    }
  },

  arrayHas(_e: unknown, _t: unknown, _n = "Array does not contain the item"): void {},

  arrayHasNo(_e: unknown, _t: unknown, _n = "Array contains the item"): void {},

  arrayEqual(
    t: ArrayLike<unknown>,
    n: ArrayLike<unknown>,
    r = "Arrays are not equal"
  ): void {
    if (!arrayShallowEquals(t, n)) throw new Error(r);
  },

  isOneOf: assertIsOneOf,

  isInstanceOf(
    _e: unknown,
    _t: unknown,
    _n = "value",
    _r?: string
  ): void {},

  isNumber(e: unknown, t = "value"): void {
    const n = typeof e;
    if (n !== "number") {
      throw new Error(`expected ${t} to be a number, instead was '${n}'(=${e})`);
    }
  },

  isString(e: unknown, t = "value"): void {
    const n = typeof e;
    if (n !== "string") {
      throw new Error(`expected ${t} to be a string, instead was '${n}'(=${e})`);
    }
  },

  isBoolean(e: unknown, t = "value"): void {
    const n = typeof e;
    if (n !== "boolean") {
      throw new Error(`expected ${t} to be a boolean, instead was '${n}'(=${e})`);
    }
  },

  isFunction(e: unknown, t = "value"): void {
    const n = typeof e;
    if (n !== "function") {
      throw new Error(`expected ${t} to be a function, instead was '${n}'(=${e})`);
    }
  },

  isObject(e: unknown, t = "value"): void {
    const n = typeof e;
    if (n !== "object") {
      throw new Error(`expected ${t} to be an object, instead was '${n}'(=${e})`);
    }
  },

  isInteger(e: unknown, t = "value"): void {
    if (!Number.isInteger(e)) {
      throw new Error(`${t} must be an integer, instead was ${e}`);
    }
  },

  isNonNegativeInteger(e: number, t = "value"): void {
    if (e < 0) throw new Error(`${t} must be >= 0, instead was ${e}`);
  },

  isPositiveInteger(e: number, t = "value"): void {
    if (e <= 0) throw new Error(`${t} must be > 0, instead was ${e}`);
  },

  isArray(e: unknown, t = "value"): void {
    if (!Array.isArray(e)) {
      throw new Error(
        `expected ${t} to be an array, instead was something else (typeof ='${typeof e}')`
      );
    }
  },

  isArrayLike(e: unknown, n = "value"): void {
    const ok = (() => {
      if (Array.isArray(e)) return true;
      if (typeof e !== "object") return false;
      if (e === null) return false;
      if (isTypedArray(e)) return true;
      const len = (e as { length?: unknown }).length;
      return !(
        (typeof len !== "number" && !Number.isInteger(len as number)) ||
        (len as number) < 0
      );
    })();
    if (!ok) {
      throw new Error(
        `expected ${n} to be an array-like structure, instead was something else (typeof ='${typeof e}')`
      );
    }
  },

  defined(e: unknown, t = "value"): void {
    if (e === undefined) throw new Error(`${t} is undefined`);
  },

  undefined(e: unknown, t = "value"): void {
    if (e !== undefined) throw new Error(`${t} is not undefined`);
  },

  isNull(e: unknown, t?: string): void {
    if (e !== null) throw new Error(`${t} is NOT null`);
  },

  notNull(e: unknown, t = "value"): void {
    if (e === null) throw new Error(`${t} is null`);
  },

  notNaN(e: number, t = "value"): void {
    if (Number.isNaN(e)) {
      throw new Error(`${t} must be a valid number, instead was NaN`);
    }
  },

  isFinite(e: number, t = "value"): void {
    if (!Number.isFinite(e)) {
      throw new Error(`${t} must be a finite number, instead was ${e}`);
    }
  },

  that(
    e: unknown,
    t: string,
    n: {
      matches(v: unknown): boolean;
      describeTo(r: { appendText(s: string): void }): void;
      describeMismatch(
        v: unknown,
        r: { appendText(s: string): void }
      ): void;
    }
  ): void {
    if (n.matches(e)) return;
    const parts: string[] = [];
    const r = {
      appendText(s: string) {
        parts.push(s);
      },
      get value() {
        return parts.join("");
      }
    };
    r.appendText(`Expected ${t} to be `);
    n.describeTo(r);
    r.appendText(" instead ");
    n.describeMismatch(e, r);
    throw new Error(r.value);
  }
} as const;

export const _ = Assert;
