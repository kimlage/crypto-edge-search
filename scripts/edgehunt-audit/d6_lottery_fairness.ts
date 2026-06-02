/**
 * AUDIT spot-check (D6): is the matched-exposure random-lottery baseline FAIR,
 * or is it an over-powered false-KILL mechanism?
 *
 * Concern: the lottery draws a fresh Bernoulli(exposure) each day -> very high
 * turnover -> heavy 4bps cost. If the real low-turnover timer is being compared
 * against a HIGH-turnover lottery, the lottery is *handicapped* by cost (its net
 * Sharpe is pushed DOWN), which makes the gate EASIER to pass, not harder. So a
 * KILL on this gate is conservative. We verify both:
 *   (1) what the lottery's realized turnover/cost is, and
 *   (2) whether a *cost-matched* lottery (turnover capped to the real strategy's
 *       turnover, via a persistent regime-switch lottery) STILL beats the timer
 *       at its 95th pct. If even a cost-fair / persistence-matched lottery beats
 *       the real timer, the KILL is doubly sound (no false-kill from cost asym).
 *
 * Reuses the M1 panel machinery directly (re-implemented minimally here to avoid
 * importing the gauntlet's top-level side effects). Writes JSON to output/edgehunt-audit/.
 */
import fs from "node:fs";

const ROOT = ".";
const COST = 0.0004;
const ANN = Math.sqrt(365);
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = (a: number[]) => {
  const n = a.length;
  if (n < 2) return 0;
  const m = mean(a);
  return Math.sqrt(Math.max(0, a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)));
};
const annSh = (a: number[]) => {
  const s = std(a);
  return s > 1e-12 ? (mean(a) / s) * ANN : 0;
};
function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- minimal M1 panel (matches m1_rates_curve.ts loaders) ----
function loadFredCsv(id: string): Map<string, number> {
  const txt = fs.readFileSync(`${ROOT}/output/edgehunt-D6/${id}.csv`, "utf8");
  const m = new Map<string, number>();
  const lines = txt.trim().split("\n");
  for (let i = 1; i < lines.length; i++) {
    const [d, v] = lines[i].split(",");
    const x = Number(v);
    if (d && Number.isFinite(x)) m.set(d, x);
  }
  return m;
}
function loadBtc() {
  const j = JSON.parse(fs.readFileSync(`${ROOT}/output/funding/BTCUSDT_prices_daily.json`, "utf8"));
  const dates: string[] = [], close: number[] = [];
  for (const r of j) if (r.spotClose > 0) { dates.push(r.date); close.push(Number(r.spotClose)); }
  return { dates, close };
}
function alignFwdFill(btcDates: string[], src: Map<string, number>): number[] {
  const out = new Array(btcDates.length).fill(NaN);
  const srcDates = [...src.keys()].sort();
  let j = 0, last = NaN;
  for (let i = 0; i < btcDates.length; i++) {
    while (j < srcDates.length && srcDates[j] <= btcDates[i]) { last = src.get(srcDates[j])!; j++; }
    out[i] = last;
  }
  return out;
}
const btc = loadBtc();
const dgs10 = alignFwdFill(btc.dates, loadFredCsv("DGS10"));
const slope = alignFwdFill(btc.dates, loadFredCsv("T10Y2Y"));
const T = btc.close.length;
const fwdRet = new Array(T).fill(NaN);
for (let t = 0; t + 1 < T; t++) fwdRet[t] = Math.log(btc.close[t + 1] / btc.close[t]);

const MAXMOM = 126;
const startIdx = MAXMOM + 2;
const tradableEnd = T - 1;
const span = tradableEnd - startIdx;
const splitIdx = startIdx + Math.floor(span * 0.75);

// rebuild the WINNING M1 config: combo / mom=126 / longhalf (long when rates falling OR curve steepening; else 0.5)
function bestPos(): number[] {
  const mom = 126;
  const pos = new Array(T).fill(NaN);
  for (let t = 1; t < T; t++) {
    const i = t - 1;
    if (i - mom < 0) { pos[t] = NaN; continue; }
    const dr = dgs10[i] - dgs10[i - mom];
    const ds = slope[i] - slope[i - mom];
    const rOn = Number.isFinite(dr) ? (dr < 0 ? 1 : -1) : NaN;
    const sOn = Number.isFinite(ds) ? (ds > 0 ? 1 : -1) : NaN;
    if (!Number.isFinite(rOn) || !Number.isFinite(sOn)) { pos[t] = NaN; continue; }
    const riskOn = rOn > 0 || sOn > 0 ? 1 : -1;
    pos[t] = riskOn > 0 ? 1 : 0.5; // longhalf
  }
  return pos;
}
function run(pos: number[]) {
  const net: number[] = []; let prev = 0, turn = 0, exp = 0;
  for (let t = startIdx; t < splitIdx; t++) {
    const fr = fwdRet[t], p = pos[t];
    if (!Number.isFinite(fr) || !Number.isFinite(p)) continue;
    const dt = Math.abs(p - prev);
    net.push(p * fr - dt * COST);
    turn += dt; exp += Math.abs(p); prev = p;
  }
  return { net, turnover: turn / net.length, exposure: exp / net.length, n: net.length };
}

const real = run(bestPos());
const realSh = annSh(real.net);

// (1) iid Bernoulli lottery (as in the gauntlet) — measure its turnover & cost drag
const iidSh: number[] = []; let iidTurnSum = 0;
for (let i = 0; i < 400; i++) {
  const rng = mkRng(424242 + i * 2654435761);
  const pos = new Array(T).fill(0);
  for (let t = startIdx; t < splitIdx; t++) pos[t] = rng() < real.exposure ? 1 : 0;
  const r = run(pos); iidSh.push(annSh(r.net)); iidTurnSum += r.turnover;
}
iidSh.sort((a, b) => a - b);
const iid95 = iidSh[Math.floor(iidSh.length * 0.95)];
const iidTurn = iidTurnSum / 400;

// (2) PERSISTENCE-matched, cost-fair lottery: a 2-state Markov in/out chain whose
// stationary long-prob = real.exposure AND whose expected turnover ~= real.turnover.
// For a 2-state chain with switch prob s per step, stationary exposure can be set by
// asymmetric switch probs; expected turnover = 2*P(switch). We target turnover ~= real.
function markovLottery(seed: number, targetExp: number, targetTurn: number): number[] {
  // turnover per day for a stationary chain ~ 2 * pUp * pDownStationaryMix; approximate by
  // setting symmetric-ish switch rate r = targetTurn (since each switch contributes |Δ|=1,
  // and frac of switching days ~ targetTurn). Then bias the stay/leave to hit targetExp.
  const rng = mkRng(seed);
  const pos = new Array(T).fill(0);
  // pInToOut and pOutToIn chosen so stationary in-prob = targetExp and total switch frac ~ targetTurn
  // stationary in = pOutToIn/(pInToOut+pOutToIn); switchFrac = 2*pIn*pInToOut (=2*pOut*pOutToIn).
  // Let pInToOut = targetTurn/(2*targetExp); pOutToIn = targetTurn/(2*(1-targetExp)).
  const pInToOut = Math.min(1, targetTurn / (2 * Math.max(1e-6, targetExp)));
  const pOutToIn = Math.min(1, targetTurn / (2 * Math.max(1e-6, 1 - targetExp)));
  let state = rng() < targetExp ? 1 : 0;
  for (let t = startIdx; t < splitIdx; t++) {
    if (state === 1) { if (rng() < pInToOut) state = 0; } else { if (rng() < pOutToIn) state = 1; }
    pos[t] = state;
  }
  return pos;
}
const mkSh: number[] = []; let mkTurnSum = 0, mkExpSum = 0;
for (let i = 0; i < 400; i++) {
  const pos = markovLottery(913131 + i * 2654435761, real.exposure, real.turnover);
  const r = run(pos); mkSh.push(annSh(r.net)); mkTurnSum += r.turnover; mkExpSum += r.exposure;
}
mkSh.sort((a, b) => a - b);
const mk95 = mkSh[Math.floor(mkSh.length * 0.95)];

const out = {
  test: "D6 random-lottery baseline fairness (false-KILL hunt)",
  config: "M1 winner combo/mom126/longhalf",
  real: { netSharpe: +realSh.toFixed(4), turnover: +real.turnover.toFixed(4), exposure: +real.exposure.toFixed(4), nDays: real.n },
  iid_lottery: {
    note: "fresh Bernoulli(exposure) per day = the gauntlet's lottery; HIGH turnover (cost-handicapped vs real)",
    avgTurnover: +iidTurn.toFixed(4),
    sh95: +iid95.toFixed(4),
    realBeatsLottery95: realSh > iid95,
  },
  markov_costfair_lottery: {
    note: "persistence-matched 2-state chain, turnover & exposure matched to the REAL timer (cost-fair)",
    avgTurnover: +(mkTurnSum / 400).toFixed(4),
    avgExposure: +(mkExpSum / 400).toFixed(4),
    sh95: +mk95.toFixed(4),
    realBeatsLottery95: realSh > mk95,
  },
  verdict:
    realSh <= iid95 && realSh <= mk95
      ? "BASELINE FAIR — real timer loses to BOTH the iid AND the cost-fair/persistence-matched lottery at p95 => KILL on baselines is sound, NOT a cost-asymmetry false-kill"
      : realSh > mk95 && realSh <= iid95
        ? "POSSIBLE COST-ASYMMETRY: real beats the cost-fair lottery but loses the iid one => the iid lottery's cost handicap could be doing the killing"
        : "real beats both lotteries => baseline would PASS (contradicts the batch)",
};
fs.writeFileSync(`${ROOT}/output/edgehunt-audit/d6_lottery_fairness.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
