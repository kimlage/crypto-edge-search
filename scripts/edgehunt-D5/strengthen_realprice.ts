/**
 * D5-05 strengthening probe — GENUINELY try to find a real timing edge in the realized-price
 * cost-basis level before accepting the KILL.
 *
 * The base band-strategy (buy<=ratio<sell long; >=sell short/flat) loses to B&H and is beaten by
 * its own phase-randomized surrogate (placeboP=0.841). That is the NF1 illusion: any fixed line on
 * a trending price path generates a "buy-the-dip / sell-the-top" book whose long-beta is the only
 * thing earning. To strengthen HONESTLY we try the variants most likely to contain genuine timing:
 *
 *   A. RECLAIM EVENT: go long only on the *upcross* of the cost-basis line (price crossing realized
 *      price from below), exit on downcross / euphoria — the literal "reclaim realized price = bull"
 *      claim, which is a timing event (not a level), so phase-randomizing the ratio SHOULD destroy
 *      it if the event matters.
 *   B. CAPITULATION LONG: long only when ratio dips below a deep-discount band (<0.85) — the "bear
 *      bottoms tag realized price" claim.
 *   C. SMOOTHED LEVEL with hysteresis (EMA of ratio) to suppress whipsaw / reduce the random-line
 *      illusion.
 *
 * Every variant is run through the SAME committed gauntlet with the RIGHT surrogate (phase-randomize
 * the ratio, rebuild positions on the real price path, crossSectional:false). Honest N counts EVERY
 * config evaluated across all families (this probe is exploratory; the committed honest N for the
 * registered grid stays 18 — we report whether ANY strengthened variant beats baselines+surrogate).
 */
import {
  loadPanel,
  runGauntlet,
  printVerdict,
  ema,
  type Panel,
  type GauntletOutput,
} from "./harness.ts";
import { phaseRandomize } from "./lib_signal.ts";

const LAG = 1;
function lag(x: number[], k: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = k; i < x.length; i++) out[i] = x[i - k];
  return out;
}

function buildRatio(P: Panel): number[] {
  const rp = lag(P.realizedPrice, LAG);
  return P.price.map((p, t) => (p > 0 && rp[t] > 0 ? p / rp[t] : NaN));
}

// ---- Family A: reclaim upcross event (long while above line after an upcross; flat below) ----
// Position = 1 while ratio is above `buy` AND below euphoria `sell`; turns on at the upcross of buy.
// This is the band rule but expressed as a stateful reclaim; with longshort, short above sell.
function reclaim(P: Panel): GauntletOutput {
  const ratio = buildRatio(P);
  const buys = [0.95, 1.0, 1.05];
  const sells = [2, 2.5, 3];
  const sides = ["longflat", "longshort"];
  const configs: Record<string, number | string>[] = [];
  for (const b of buys) for (const s of sells) for (const sd of sides)
    configs.push({ buy: b, sell: s, side: sd });
  function build(cfg: Record<string, number | string>, sig?: number[]): number[] {
    const r = sig ?? ratio;
    const pos = new Array(P.price.length).fill(NaN);
    let state = 0;
    for (let t = 0; t < P.price.length; t++) {
      if (!Number.isFinite(r[t])) { pos[t] = NaN; continue; }
      const buy = cfg.buy as number, sell = cfg.sell as number;
      if (r[t] >= sell) state = cfg.side === "longshort" ? -1 : 0; // euphoria
      else if (r[t] >= buy) { if (state <= 0) state = 1; } // reclaim/hold long
      else state = 0; // lost cost basis
      pos[t] = state;
    }
    return pos;
  }
  return runGauntlet({
    name: "D5-05A reclaim-event cost-basis (BTC)",
    P,
    configs,
    canonical: { buy: 1.0, sell: 3, side: "longflat" },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) => build(cfg, phaseRandomize(ratio, rng)),
    startIdx: 200,
  });
}

// ---- Family B: capitulation long (long only when deeply below cost basis) ----
function capitulation(P: Panel): GauntletOutput {
  const ratio = buildRatio(P);
  const los = [0.75, 0.85, 0.95];
  const his = [1.5, 2.0, 2.5];
  const sides = ["longflat", "longshort"];
  const configs: Record<string, number | string>[] = [];
  for (const lo of los) for (const hi of his) for (const sd of sides)
    configs.push({ lo, hi, side: sd });
  function build(cfg: Record<string, number | string>, sig?: number[]): number[] {
    const r = sig ?? ratio;
    const pos = new Array(P.price.length).fill(NaN);
    for (let t = 0; t < P.price.length; t++) {
      if (!Number.isFinite(r[t])) continue;
      const lo = cfg.lo as number, hi = cfg.hi as number;
      if (r[t] <= lo) pos[t] = 1; // capitulation discount -> long
      else if (r[t] >= hi) pos[t] = cfg.side === "longshort" ? -1 : 0;
      else pos[t] = 0;
    }
    return pos;
  }
  return runGauntlet({
    name: "D5-05B capitulation-discount (BTC)",
    P,
    configs,
    canonical: { lo: 0.85, hi: 2.0, side: "longflat" },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) => build(cfg, phaseRandomize(ratio, rng)),
    startIdx: 200,
  });
}

// ---- Family C: EMA-smoothed level with hysteresis ----
function smoothed(P: Panel): GauntletOutput {
  const ratio = buildRatio(P);
  const spans = [7, 14, 30];
  const buys = [1.0, 1.2];
  const sells = [2.5, 3];
  const sides = ["longflat", "longshort"];
  const configs: Record<string, number | string>[] = [];
  for (const sp of spans) for (const b of buys) for (const s of sells) for (const sd of sides)
    configs.push({ span: sp, buy: b, sell: s, side: sd });
  function build(cfg: Record<string, number | string>, sig?: number[]): number[] {
    const base = sig ?? ratio;
    const r = ema(base, cfg.span as number);
    const pos = new Array(P.price.length).fill(NaN);
    for (let t = 0; t < P.price.length; t++) {
      if (!Number.isFinite(r[t])) continue;
      const buy = cfg.buy as number, sell = cfg.sell as number;
      if (r[t] >= buy && r[t] < sell) pos[t] = 1;
      else if (r[t] >= sell) pos[t] = cfg.side === "longshort" ? -1 : 0;
      else pos[t] = 0;
    }
    return pos;
  }
  return runGauntlet({
    name: "D5-05C ema-smoothed cost-basis (BTC)",
    P,
    configs,
    canonical: { span: 14, buy: 1.2, sell: 3, side: "longflat" },
    buildPosition: (cfg) => build(cfg),
    buildSurrogatePosition: (cfg, rng) => build(cfg, phaseRandomize(ratio, rng)),
    startIdx: 200,
  });
}

const fams = { reclaim, capitulation, smoothed };
const P = loadPanel("btc");
let totalN = 18; // committed grid
const rows: string[] = [];
for (const [k, fn] of Object.entries(fams)) {
  const o = (fn as (p: Panel) => GauntletOutput)(P);
  printVerdict(o);
  totalN += o.honestN;
  rows.push(
    `${k}: netSh=${o.best.netSharpeAnn.toFixed(3)} binding=${o.bindingGate} surrP=${o.surrogateP.toFixed(3)} holdout=${o.holdoutSharpeAnn.toFixed(3)} verdict=${o.verdict}`,
  );
}
console.log("\n==== STRENGTHEN SUMMARY (committed grid N=18 + probe families) ====");
console.log("If ALL families also fail baselines/surrogate, the honest pooled N only worsens DSR.");
console.log("Pooled exploratory N (informational):", totalN);
for (const r of rows) console.log("  " + r);
