import type { AppearanceOp } from "../material/AppearanceGraph.js";

/** Pure scalar math shared by native backends. No execution protocol or resources. */
export function operationWgsl(op: AppearanceOp, args: readonly string[]): string {
  const [a, b, c] = args;
  switch (op) {
    case "add":
      return `(${a} + ${b})`;
    case "subtract":
      return `(${a} - ${b})`;
    case "multiply":
      return `(${a} * ${b})`;
    case "divide":
      return `(${a} / ${b})`;
    case "min":
    case "max":
    case "pow":
      return `${op}(${a}, ${b})`;
    case "sin":
    case "cos":
    case "abs":
    case "sqrt":
      return `${op}(${a})`;
    case "clamp":
      return `clamp(${a}, ${b}, ${c})`;
    // Keep the explicitly rounded scalar IR sequence; do not silently change to a fused lerp.
    case "mix":
      return `((${a} * (1.0 - ${c})) + (${b} * ${c}))`;
  }
}
