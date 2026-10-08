export const check = (value, message) => {
  if (!value) throw new Error(message);
};
export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
    n: sorted.length,
  };
}
