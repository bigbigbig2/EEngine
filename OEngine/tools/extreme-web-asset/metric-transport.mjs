/** Lossless F32 wire bytes, not decimal JSON numbers. A stripe remains bounded
 * to 32 rows; this changes host transport only, never metric precision/domain. */
export function encodeMetricValues(values) {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 16384)));
  }
  return btoa(parts.join(""));
}

export function decodeMetricValues(chunk) {
  if (
    !Number.isSafeInteger(chunk.width) || chunk.width < 1 || chunk.width > 65536 ||
    !Number.isSafeInteger(chunk.height) || chunk.height < 1 || chunk.height > 32 ||
    typeof chunk.valuesBase64 !== "string"
  ) {
    throw new Error("Invalid metric stripe domain");
  }
  const expectedBytes = chunk.width * chunk.height * 28 * 4;
  if (chunk.valuesBase64.length !== 4 * Math.ceil(expectedBytes / 3)) {
    throw new Error("Metric wire extent differs from its full pixel domain");
  }
  const binary = atob(chunk.valuesBase64);
  if (binary.length !== expectedBytes) throw new Error("Truncated metric stripe");
  const bytes = new Uint8Array(expectedBytes);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const values = new Float32Array(bytes.buffer);
  if (!values.every(Number.isFinite)) throw new Error("Nonfinite metric wire value");
  return values;
}
