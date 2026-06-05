/**
 * Campaign-D — POSITIVE/NEGATIVE control for the gauntlet (highest-credibility test): does runGauntlet
 * correctly SURVIVE a planted real edge and KILL a no-edge null? Proves the harness is not "always-KILL".
 *
 * Synthetic markets: price p ~ U(0.05,0.95); TRUE prob q = clamp(p + delta); resolve YES ~ Bernoulli(q).
 * Strategy = buy YES (when delta>0 the market underprices => +EV). Right null = calibrated-Bernoulli at
 * the PRICE (no edge by construction). Sweep delta: 0 must KILL, growing delta must flip to SURVIVE.
 *
 * Run: npx tsx scripts/campaign-D/gauntlet_control.ts
 */
import { runGauntlet } from "./gauntlet.ts";
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const seeded = (s0: number) => { let s = s0 >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const H = 0.005; // small cost so the control isolates the edge-detection, not the cost gate

function trial(delta: number, n = 2000, seed = 42) {
  const rng = seeded(seed);
  const mk = Array.from({ length: n }, () => { const p = 0.05 + rng() * 0.9; const q = clamp(p + delta, 0.01, 0.99); return { p, resYes: rng() < q ? 1 : 0 }; });
  const buyYes = (p: number, oc: number) => { const c = Math.min(0.999, p + H); return (oc - c) / c; };
  const returns = mk.map((m) => buyYes(m.p, m.resYes));
  // calibrated-Bernoulli null at the PRICE (no edge), single strategy => N=1
  const rng2 = seeded(seed + 1); const nullMax: number[] = [];
  for (let d = 0; d < 1500; d++) { const r = mk.map((m) => buyYes(m.p, rng2() < m.p ? 1 : 0)); nullMax.push(mean(r)); }
  // grid folds (8) for CPCV; holdout last 20%
  const folds = (() => { const per = Math.ceil(returns.length / 8); return [{ id: "buyYes", folds: Array.from({ length: 8 }, (_, k) => returns.slice(k * per, (k + 1) * per)) }]; })();
  const ho = returns.slice(Math.floor(returns.length * 0.8));
  return runGauntlet({ name: `control delta=${delta.toFixed(2)} (n=${n})`, returns, honestN: 1,
    baselines: [{ name: "buy-NO", mean: mean(mk.map((m) => { const c = Math.min(0.999, 1 - m.p + H); return ((1 - m.resYes) - c) / c; })) }],
    grid: folds, surrogate: { real: mean(returns), nullMaxes: nullMax }, holdoutReturns: ho });
}

console.log(`=== GAUNTLET CONTROL — does it SURVIVE a planted edge and KILL no-edge? ===`);
console.log(`delta   verdict    binding         net_mean   surrogate`);
for (const delta of [0.00, 0.02, 0.03, 0.05, 0.08]) {
  const o = trial(delta);
  const net = o.gates.find((g) => g.id === "net_of_cost")!.detail.match(/mean net=([\-0-9.]+)/)?.[1];
  const surr = o.gates.find((g) => g.id === "surrogate")!.detail.match(/p=([0-9.]+)/)?.[1];
  console.log(`${delta.toFixed(2)}   ${o.verdict.padEnd(9)}  ${o.bindingGate.padEnd(14)}  ${String(net).padStart(8)}   p=${surr}`);
}
console.log(`\nExpected: delta=0 => KILL (no edge); growing delta => SURVIVE. If so, the gauntlet correctly`);
console.log(`detects real edge proportional to magnitude — i.e. the campaign's 0-SURVIVE is a property of the`);
console.log(`MARKETS, not an always-KILL harness. (This is the positive/negative control a skeptic demands.)`);
