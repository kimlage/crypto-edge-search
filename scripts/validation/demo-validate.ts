/**
 * demo-validate.ts — a runnable, ZERO-DATA demonstration of the gauntlet.
 *
 * Builds three seeded return series — pure noise, an AR(1) autocorrelation
 * artifact, and a modest positive drift — and runs each through
 * `validateStrategy()`, printing the binary + scientific verdict, the binding
 * gate, and the full per-gate report. No data files, no network, no API keys;
 * everything is seeded, so the output is reproducible and it runs in any clean
 * clone.
 *
 * Run:  npx tsx scripts/validation/demo-validate.ts
 *
 * The point is NOT to find an edge — it is to watch the committed gauntlet score
 * a strategy honestly, and to KILL noise via a binding gate. Nothing is
 * manufactured. Change the target, never the gates.
 */
import { validateStrategy } from "../../src/lib/validation/strategy-validator";
import { renderVerdictMarkdown } from "../../src/lib/report/report-renderer";

/** mulberry32 — small seeded PRNG so the demo is byte-reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function gaussian(rnd: () => number): number {
  const u1 = Math.max(1e-12, rnd());
  const u2 = rnd();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Seeded i.i.d. return series with a per-period drift and volatility. */
function noiseSeries(n: number, drift: number, vol: number, seed: number): number[] {
  const rnd = seededRandom(seed);
  return Array.from({ length: n }, () => drift + gaussian(rnd) * vol);
}

/** Seeded AR(1) series — autocorrelation that a surrogate null reproduces. */
function ar1Series(n: number, vol: number, phi: number, seed: number): number[] {
  const rnd = seededRandom(seed);
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < n; i += 1) {
    prev = phi * prev + gaussian(rnd) * vol;
    out.push(prev);
  }
  return out;
}

function run(label: string, returns: readonly number[]): ReturnType<typeof validateStrategy> {
  const verdict = validateStrategy(returns, {
    trialCount: 20, // we "searched" ~20 configs — count them honestly
    seed: label,
    statistic: "compoundReturn",
  });
  console.log(`\n${"=".repeat(72)}\n${label}`);
  console.log(
    `verdict=${verdict.verdict}  scientificVerdict=${verdict.scientificVerdict}  bindingGate=${verdict.bindingGate ?? "—"}`,
  );
  console.log(renderVerdictMarkdown(verdict));
  return verdict;
}

// (1) Pure mean-zero noise — must never be certified.
const noise = run("(1) pure noise — expect KILL", noiseSeries(750, 0, 0.01, 1));

// (2) An AR(1) artifact — looks structured, but the structure is autocorrelation a
//     surrogate null reproduces; the gauntlet must not be fooled.
run("(2) AR(1) autocorrelation artifact — expect KILL", ar1Series(750, 0.01, 0.6, 13));

// (3) A modest positive drift scored with NO baselines supplied: the gauntlet must
//     NOT vacuously certify it (the baselines gate is ADVISORY, so the scientific
//     verdict is capped below SURVIVE) — exactly the honest behavior.
run("(3) drifting series, no baselines — expect not-SURVIVE", noiseSeries(750, 0.0008, 0.01, 7));

console.log(
  `\n${"=".repeat(72)}\nA clean backtest is a starting point, not evidence.\n` +
    "Next: load your own CSV with src/lib/io/returns-csv.ts, or describe a search\n" +
    "with a spec from examples/specs/ and run the family-wise validator.",
);

// Smoke assertion: the harness must run and must KILL the noise via a binding gate.
if (noise.verdict !== "KILL") {
  console.error("SMOKE FAILED: the gauntlet did not KILL pure noise.");
  process.exit(1);
}
