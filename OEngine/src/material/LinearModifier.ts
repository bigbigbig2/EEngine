/**
 * LinearModifier：定义材质参数、着色模型或材质资源绑定。
 */

import { hashFloat } from "../core/hashMix.js";

export class LinearModifier {
  a: number;
  b: number;
  source = 0;
  transient = false;

  constructor(a = 1, b = 0) {
    this.a = a;
    this.b = b;
  }

  copy(other: LinearModifier): void {
    this.a = other.a;
    this.b = other.b;
    this.source = other.source;
    this.transient = other.transient;
  }

  clone(): LinearModifier {
    const e = new LinearModifier();
    e.copy(this);
    return e;
  }

  add(e: LinearModifier): void {
    this.a += e.a - 1;
    this.b += e.b;
  }

  equals(other: LinearModifier): boolean {
    return (
      this.a === other.a &&
      this.b === other.b &&
      this.source === other.source &&
      this.transient === other.transient
    );
  }

  hash(): number {
    return (
      hashFloat(this.a) ^
      hashFloat(this.b) ^
      this.source ^
      (this.transient ? 0 : 1)
    );
  }

  toString(): string {
    return `LinearModifier{ a:${this.a}, b:${this.b} }`;
  }

  toJSON(): { a: number; b: number; source: number; transient: boolean } {
    return {
      a: this.a,
      b: this.b,
      source: this.source,
      transient: this.transient
    };
  }

  fromJSON({
    a = 1,
    b = 0,
    source = 0,
    transient = false
  }: {
    a?: number;
    b?: number;
    source?: number;
    transient?: boolean;
  }): void {
    this.a = a;
    this.b = b;
    this.source = source;
    this.transient = transient;
  }

  static readonly CONSTANT_ONE = Object.freeze(new LinearModifier(0, 1)) as LinearModifier;
  static readonly CONSTANT_ZERO = Object.freeze(new LinearModifier(0, 0)) as LinearModifier;
}
