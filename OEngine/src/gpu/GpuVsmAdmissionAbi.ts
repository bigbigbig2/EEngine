/** Screen-benefit admission statistics, shared by GPU producer and diagnostics. */
export const VSM_ADMISSION_ABI = Object.freeze({
  histogramWords: 32,
  cutoffTierWord: 32,
  cutoffAllowanceWord: 33,
  rawFineCountWord: 34,
  admittedFineCountWord: 35,
  byteLength: 36 * 4,
});
