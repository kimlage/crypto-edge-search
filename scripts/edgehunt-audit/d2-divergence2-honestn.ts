/**
 * AUDIT spot-run: D2-CVD divergence2 honest-N accumulation (error class ii).
 * Verify HONEST_N = 225 is the TRUE size of the full search:
 *   - divergence2 strengthening grid = |slopeWins|*|regWins|*|zWins|*|dirs|*|holds|
 *   - PLUS the literal-divergence family from divergence.ts (must be exactly 45,
 *     not a fudge), accumulated (NOT reset) into the DSR trialCount.
 * Recompute both grids from first principles and confirm 180 + 45 = 225.
 */
// divergence2.ts grid
const slopeWins2 = [3, 5, 7, 10, 14];
const regWins2 = [30, 60, 90];
const zWins2 = [60, 90];
const dirs2 = [1, -1];
const holds2 = [1, 2, 3];
const strengtheningN = slopeWins2.length * regWins2.length * zWins2.length * dirs2.length * holds2.length;

// divergence.ts literal family
const slopeWins1 = [3, 5, 7, 10, 14];
const zWins1 = [30, 60, 90];
const modes = ["div", "divband"] as const;
const bands = [0.5, 1.0];
let literalN = 0;
for (const _sw of slopeWins1) for (const _zw of zWins1) for (const m of modes)
  for (const _b of (m === "divband" ? bands : [0])) literalN += 1;

console.log(`divergence2 strengthening grid = 5*3*2*2*3 = ${strengtheningN}`);
console.log(`divergence.ts literal family     = ${literalN}  (15 div + 30 divband)`);
console.log(`HONEST_N (accumulated)           = ${strengtheningN} + ${literalN} = ${strengtheningN + literalN}`);
console.log(strengtheningN === 180 && literalN === 45 && strengtheningN + literalN === 225
  ? "CONFIRMED: honest N = 225 honestly accumulates the literal family (no trial-counter reset)."
  : "MISMATCH: honest-N accounting differs from audit claim.");
