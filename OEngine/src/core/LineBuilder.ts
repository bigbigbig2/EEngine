/**
 * LineBuilder：提供渲染器共享的基础数据结构与通用工具。
 */

export class Line {
  text: string;
  indentation: number;

  constructor(e: string, t: number) {
    this.text = e;
    this.indentation = t;
  }

  toString(): string {
    return `Line{ indentation=${this.indentation}, text="${this.text}" }`;
  }
}

export class LineBuilder {
  #ie: Line[] = [];
  #oe = 0;

  get indentation(): number {
    return this.#oe;
  }

  indentSpaces = 4;

  get count(): number {
    return this.#ie.length;
  }

  containsSubstring(e: string): boolean {
    const t = this.#ie;
    const n = t.length;
    for (let r = 0; r < n; r++) {
      if (t[r]!.text.indexOf(e) !== -1) return true;
    }
    return false;
  }

  indent(): this {
    this.#oe++;
    return this;
  }

  dedent(): this {
    this.#oe = Math.max(0, this.#oe - 1);
    return this;
  }

  add(e: string): this {
    const t = new Line(e, this.#oe);
    this.#ie.push(t);
    return this;
  }

  extend(e: string): void {
    const t = this.#ie;
    const n = t.length - 1;
    if (n < 0) throw new Error("No lines to append to");
    t[n]!.text += e;
  }

  addLines(e: LineBuilder): void {
    const t = e.#ie;
    const n = t.length;
    for (let i = 0; i < n; i++) {
      const line = t[i]!;
      this.#ie.push(new Line(line.text, line.indentation + this.#oe));
    }
  }

  clear(): void {
    this.#ie = [];
    this.#oe = 0;
  }

  build(): string {
    const e: string[] = [];
    const t = this.#ie;
    const n = t.length;
    const r = ((tSpaces: number) => {
      if (tSpaces <= 0) return "";
      let n = " ";
      for (let e = 1; e < tSpaces; e++) n += " ";
      return n;
    })(this.indentSpaces);
    for (let s = 0; s < n; s++) {
      const line = t[s]!;
      let a = "";
      const i = line.indentation;
      for (let e = 0; e < i; e++) a += r;
      e.push(a + line.text);
    }
    return e.join("\n");
  }

  static fromText(e: string, t = "\n"): LineBuilder {
    const n = new LineBuilder();
    const r = e.split(t);
    const s = r.length;
    for (let i = 0; i < s; i++) n.add(r[i]!);
    return n;
  }

  toString(): string {
    return this.build();
  }
}
