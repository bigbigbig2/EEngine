/** Pending is command-local only. Only Hit/Miss are transport samples;
 * Unknown/Untrusted/Fault invalidate the entire predeclared patch cohort. */
export const SCGI_QUERY_STATUS = Object.freeze({
  Hit: 0,
  Miss: 1,
  Unknown: 2,
  Untrusted: 3,
  Pending: 4,
  Fault: 5,
});
