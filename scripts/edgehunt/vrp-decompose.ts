/**
 * VRP decomposition: separate the PREMIUM (being short vol) from the SIGNAL (VRP timing/sizing).
 * Confirms whether the "strengthening" earns its keep, and runs CSCV/PBO on genuinely diverse
 * candidate strategies (premium-only, signal-sized, gated, inverse-signal) so PBO isn't degenerate.
 */
import { readFileSync } from "node:fs";
import { summarizeReturnSeries, estimateCscvPbo } from "../../src/lib/training/statistical-validation";

const ANN_DAYS = 365, H = 7, ZLB = 90, taker = 0.0004, VOL_TARGET = 0.10, TAIL_MULT = 1.5;
const dvol = JSON.parse(readFileSync("output/edgehunt/dvol_btc.json", "utf8")) as { date: string; close: number }[];
interface DayOHLC { date: string; open: number; high: number; low: number; close: number; }
function loadBtcDaily(): DayOHLC[] {
  const raw = readFileSync("output/bigquery/btc_ohlcv_15m.ndjson", "utf8").split("\n");
  const byDay = new Map<string, DayOHLC>();
  for (const line of raw) { if (!line) continue; const r = JSON.parse(line); const date = r.event_date; const c = byDay.get(date);
    if (!c) byDay.set(date, { date, open: r.open, high: r.high, low: r.low, close: r.close });
    else { c.high = Math.max(c.high, r.high); c.low = Math.min(c.low, r.low); c.close = r.close; } }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const std = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const quantile = (s: number[], q: number) => { if (!s.length) return 0; const p = (s.length - 1) * q; const lo = Math.floor(p), hi = Math.ceil(p); return lo === hi ? s[lo] : s[lo] * (hi - p) + s[hi] * (p - lo); };

const days = loadBtcDaily();
const vseries = days.map((d, i) => { const prev = i > 0 ? days[i - 1].close : d.open; const rc = Math.log(d.close / prev); const hl = Math.log(d.high / d.low); const co = Math.log(d.close / d.open); const park = (1 / (4 * Math.log(2))) * hl * hl; const gk = 0.5 * hl * hl - (2 * Math.log(2) - 1) * co * co; return { date: d.date, blend: (rc * rc + Math.max(0, park) + Math.max(0, gk)) / 3 }; });
const fundRows = JSON.parse(readFileSync("output/funding/BTCUSDT_funding_8h.json", "utf8")) as { fundingTime: number; fundingRate: number }[];
const fundDay = new Map<string, number>(); for (const r of fundRows) { const d = new Date(r.fundingTime).toISOString().slice(0, 10); fundDay.set(d, (fundDay.get(d) ?? 0) + r.fundingRate); }
const dvolByDate = new Map(dvol.map((d) => [d.date, d.close / 100]));
const fwdRV = (i: number) => { if (i + H > vseries.length) return null; let s = 0; for (let k = i; k < i + H; k++) s += vseries[k].blend; return Math.sqrt((s / H) * ANN_DAYS); };
const trailRV = (i: number) => { if (i - H < 0) return null; let s = 0; for (let k = i - H; k < i; k++) s += vseries[k].blend; return Math.sqrt((s / H) * ANN_DAYS); };

// shared window setup
const exAnte = new Map<number, number>();
for (let i = 0; i < vseries.length; i++) { const iv = dvolByDate.get(vseries[i].date); if (iv === undefined) continue; const trv = trailRV(i); if (trv === null) continue; exAnte.set(i, iv * iv - trv * trv); }
const idxs: number[] = []; for (let i = H; i + H <= vseries.length; i += H) if (exAnte.has(i) && dvolByDate.has(vseries[i].date) && fwdRV(i) !== null) idxs.push(i);
const zByIdx = new Map<number, number>();
for (const i of idxs) { const past: number[] = []; for (let k = Math.max(0, i - ZLB); k < i; k++) { const v = exAnte.get(k); if (v !== undefined) past.push(v); } if (past.length < 10) continue; const m = mean(past), s = std(past) || 1e-9; zByIdx.set(i, (exAnte.get(i)! - m) / s); }
const valid = idxs.filter((i) => zByIdx.has(i));

function spikeZ(i: number) { const iv = dvolByDate.get(vseries[i].date)!; const past: number[] = []; for (let j = Math.max(0, i - ZLB); j < i; j++) { const v = dvolByDate.get(vseries[j].date); if (v !== undefined) past.push(v); } if (past.length < 5) return 0; const m = mean(past), s = std(past) || 1e-9; return (iv - m) / s; }
function benign(i: number) { const rvs: number[] = []; for (let j = Math.max(H, i - ZLB); j <= i; j++) { const r = trailRV(j); if (r !== null) rvs.push(r); } if (rvs.length < 10) return true; const cur = rvs.at(-1)!; return cur <= quantile([...rvs].sort((a, b) => a - b), 0.6); }

// strategy variants: each maps idx -> position size (before vol scaling)
type Sizer = (i: number, k: number) => number;
function buildRets(sizer: Sizer): number[] {
  // calibrate vol scaler from payoff std (premium-only sizing) so all variants share target
  const payoffs = valid.map((i) => { const iv = dvolByDate.get(vseries[i].date)!; const fwd = fwdRV(i)!; return iv * iv - fwd * fwd; });
  const unit = std(payoffs) * Math.sqrt(ANN_DAYS / H) || 1e-9;
  const volScaler = VOL_TARGET / unit;
  return valid.map((i, k) => {
    const iv = dvolByDate.get(vseries[i].date)!; const fwd = fwdRV(i)!;
    let size = sizer(i, k) * volScaler;
    const payoffVar = iv * iv - fwd * fwd;
    const gross = size * payoffVar;
    let fundSum = 0; for (let j = i; j < i + H; j++) { const f = fundDay.get(vseries[j].date); if (f !== undefined) fundSum += Math.abs(f); }
    const fundingCost = Math.abs(size) * fundSum * 0.5;
    const takerCost = Math.abs(size) > 0 ? (2 + H) * taker * Math.min(Math.abs(size), 3) : 0;
    const rvOverIv = fwd / iv; let tailCost = 0;
    if (size > 0 && rvOverIv > 1.0) { const e = rvOverIv - 1.0; tailCost = size * (iv * iv) * e * e * TAIL_MULT; }
    return gross - fundingCost - takerCost - tailCost;
  });
}
const annSharpe = (r: number[]) => summarizeReturnSeries(r).sharpe * Math.sqrt(ANN_DAYS / H);
const maxDD = (r: number[]) => { let eq = 1, pk = 1, mdd = 0; for (const x of r) { eq *= 1 + x; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); } return mdd; };
const calmar = (r: number[]) => { const a = mean(r) * (ANN_DAYS / H); const m = Math.abs(maxDD(r)); return m > 1e-9 ? a / m : 0; };
const cvar = (r: number[]) => { const s = [...r].sort((a, b) => a - b); const n = Math.max(1, Math.floor(s.length * 0.05)); return mean(s.slice(0, n)); };

// VARIANTS
const variants: Record<string, Sizer> = {
  "premium_only_always_short": () => 1.0, // always full short, no signal, no gate
  "premium_gated": (i) => (spikeZ(i) > 1.5 || !benign(i) ? 0 : 1.0), // short unless spike/regime
  "vrp_sized_gated": (i, k) => { const z = zByIdx.get(valid[k])!; let s = z > 0 ? Math.min(z, 2.5) : 0; if (spikeZ(i) > 1.5 || !benign(i)) s = 0; return s; }, // THE headline strengthened version
  "vrp_sized_nogate": (i, k) => { const z = zByIdx.get(valid[k])!; return z > 0 ? Math.min(z, 2.5) : 0; },
  "inverse_vrp": (i, k) => { const z = zByIdx.get(valid[k])!; return z < 0 ? Math.min(-z, 2.5) : 0; }, // short MORE when premium looks negative (should be worse)
};

const summary: any = {};
for (const [name, sizer] of Object.entries(variants)) {
  const r = buildRets(sizer);
  summary[name] = {
    netSharpe: +annSharpe(r).toFixed(3),
    Calmar: +calmar(r).toFixed(3),
    CVaR5: +cvar(r).toFixed(5),
    maxDD: +maxDD(r).toFixed(4),
    meanWindow: +mean(r).toFixed(5),
    monthly_100k: +(mean(r) * (30 / H) * 100000).toFixed(0),
  };
}

// CSCV/PBO across the 5 genuinely-diverse variants
const foldCount = 6;
function toFolds(r: number[]) { const f: number[][] = Array.from({ length: foldCount }, () => []); r.forEach((x, i) => f[i % foldCount].push(x)); return f; }
const strategies = Object.entries(variants).map(([name, sizer]) => ({ id: name, folds: toFolds(buildRets(sizer)) }));
const pbo = estimateCscvPbo(strategies, { statistic: "sharpe", trainFraction: 0.5 });

// KEY decomposition number: does the SIGNAL beat PREMIUM-ONLY?
const premiumOnly = buildRets(variants["premium_gated"]);
const signalVersion = buildRets(variants["vrp_sized_gated"]);
const diff = signalVersion.map((x, i) => x - premiumOnly[i]);
const signalSharpe = annSharpe(diff);

console.log(JSON.stringify({
  variants: summary,
  pbo: +pbo.pbo.toFixed(3),
  medianLogit: +pbo.medianLogit.toFixed(3),
  signal_minus_premium_Sharpe: +signalSharpe.toFixed(3),
  signal_minus_premium_mean: +mean(diff).toFixed(6),
  interpretation: "If vrp_sized_gated Sharpe ~ premium_gated Sharpe and signal_minus_premium_Sharpe~0, the SIGNAL adds nothing; the edge is the unconditional premium.",
}, null, 2));
