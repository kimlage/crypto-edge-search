/**
 * D5-16 strengthening probe — GENUINELY try to extract edge from the active-address / Metcalfe
 * valuation residual before accepting the KILL.
 *
 * The base run_d5.ts metcalfe() (honest N=36) trips `baselines` because its best in-sample config
 * is a 4%-exposure long-only sleeve that cannot out-Sharpe a 100%-long buy&hold in a bull-trending
 * asset. But the BACKLOG's real question is whether the residual carries INDEPENDENT predictive
 * TIMING. The gates that answer that — and that exposure-tilting cannot game — are:
 *    (a) the phase-randomization surrogate null (crossSectional:false), and
 *    (b) the consume-once forward holdout.
 *
 * So here I:
 *   1. Keep the identical causal machinery: expanding OLS log(price)~a+k*log(adr) frozen (no
 *      lookahead), residual lagged >=1d, rolling-Z, NEXT-day return.
 *   2. Add legitimate strengthenings, each counted in honest N:
 *        - Metcalfe-form exponent FROZEN choices as a control (the BACKLOG flags the n/n·logn/n²
 *          fit-form as a mining knob): linear-in-log (free k) vs n^2-pinned vs n·log n.
 *        - mean-reversion framing (long undervalued / short overvalued, symmetric band) which
 *          raises exposure so the comparison vs B&H is apples-to-apples on timing.
 *        - a market-neutral "residual tilt" overlay that times B&H beta (long-always, reduce to
 *          flat only when richly overvalued) — the most charitable use of a coincident metric.
 *   3. For EVERY config, report in-sample net Sharpe, the surrogate p, AND the consume-once holdout
 *      Sharpe — so we judge by robustness, not by the cherry-picked IS winner.
 *
 * If any honest variant clears the surrogate null (p<0.05) AND holds up OOS (holdout Sharpe>0),
 * that is real edge and we escalate. If not, the KILL is earned on the binding gate.
 */
import fs from "node:fs";
import {
  loadPanel,
  runPositions,
  sharpeDaily,
  annSharpe,
  mkRng,
  mean,
  rollingZ,
  type Panel,
} from "./harness.ts";
import { phaseRandomize } from "./lib_signal.ts";

const LAG = 1;
const OUT = "output/edgehunt-D5";

function lag(x: number[], k: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = k; i < x.length; i++) out[i] = x[i - k];
  return out;
}

// Expanding causal residual of log(price) vs a Metcalfe form of active addresses.
// form: "free" -> OLS log(price)~a+k*log(adr) (k estimated, frozen up to t-1)
//       "n2"   -> pinned exponent 2: residual = log(price) - a - 2*log(adr), a = expanding mean of (log(price)-2*log(adr))
//       "nlogn"-> pinned to n*log n: feature = log(adr*log(adr)); OLS slope free on that feature
function residualSeries(P: Panel, minObs: number, form: "free" | "n2" | "nlogn"): number[] {
  const logP = P.price.map((p) => (p > 0 ? Math.log(p) : NaN));
  const adrL = lag(P.adr, LAG);
  let feat: number[];
  if (form === "nlogn") {
    feat = adrL.map((a) => (a > 1 ? Math.log(a * Math.log(a)) : NaN));
  } else {
    feat = adrL.map((a) => (a > 0 ? Math.log(a) : NaN));
  }
  const out = new Array(P.price.length).fill(NaN);
  if (form === "n2") {
    // residual = log(price) - 2*log(adr) - a_t, with a_t = expanding mean of (log(price)-2*log(adr)) up to t-1
    let n = 0,
      s = 0;
    for (let t = 0; t < P.price.length; t++) {
      const dev = Number.isFinite(logP[t]) && Number.isFinite(feat[t]) ? logP[t] - 2 * feat[t] : NaN;
      if (n >= minObs && Number.isFinite(dev)) out[t] = dev - s / n;
      if (Number.isFinite(dev)) {
        n++;
        s += dev;
      }
    }
    return out;
  }
  // free / nlogn: expanding OLS of logP on feat up to t-1
  let n = 0,
    sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (let t = 0; t < P.price.length; t++) {
    if (n >= minObs) {
      const denom = n * sxx - sx * sx;
      if (Math.abs(denom) > 1e-9 && Number.isFinite(feat[t]) && Number.isFinite(logP[t])) {
        const beta = (n * sxy - sx * sy) / denom;
        const alpha = (sy - beta * sx) / n;
        out[t] = logP[t] - (alpha + beta * feat[t]);
      }
    }
    if (Number.isFinite(feat[t]) && Number.isFinite(logP[t])) {
      n++;
      sx += feat[t];
      sy += logP[t];
      sxx += feat[t] * feat[t];
      sxy += feat[t] * logP[t];
    }
  }
  return out;
}

type Cfg = {
  minObs: number;
  zwin: number;
  buy: number;
  side: "longflat" | "longshort" | "tilt";
  form: "free" | "n2" | "nlogn";
};

function buildPos(P: Panel, cfg: Cfg, resOverride?: number[]): number[] {
  const res = resOverride ?? residualSeries(P, cfg.minObs, cfg.form);
  const z = rollingZ(res, cfg.zwin);
  const pos = new Array(P.price.length).fill(NaN);
  for (let t = 0; t < P.price.length; t++) {
    if (!Number.isFinite(z[t])) continue;
    const sell = -cfg.buy; // symmetric overvaluation threshold
    if (cfg.side === "tilt") {
      // always long beta; cut to flat only when richly overvalued (charitable beta-timing overlay)
      pos[t] = z[t] >= sell ? 0 : 1;
    } else if (z[t] <= cfg.buy) {
      pos[t] = 1; // deeply undervalued vs Metcalfe -> long
    } else if (z[t] >= sell) {
      pos[t] = cfg.side === "longshort" ? -1 : 0;
    } else {
      pos[t] = cfg.side === "longshort" ? 0 : 0;
    }
  }
  return pos;
}

function main() {
  const P = loadPanel("btc");
  const T = P.price.length;
  const startIdx = 1100;
  const tradableEnd = T - 1;
  const span = tradableEnd - startIdx;
  const splitIdx = startIdx + Math.floor(span * 0.8); // consume-once holdout = last 20%

  const minObsL = [365, 730];
  const zwins = [180, 365, 730];
  const buys = [-1, -1.5, -2];
  const sides: Cfg["side"][] = ["longflat", "longshort", "tilt"];
  const forms: Cfg["form"][] = ["free", "n2", "nlogn"];

  const configs: Cfg[] = [];
  for (const m of minObsL)
    for (const zw of zwins)
      for (const b of buys)
        for (const sd of sides) for (const f of forms) configs.push({ minObs: m, zwin: zw, buy: b, side: sd, form: f });

  const HONEST_N = configs.length;
  const nSurr = 300;

  // B&H reference on the in-sample window (for the apples-to-apples timing comparison)
  const bhPos = new Array(T).fill(1);
  const bhIS = annSharpe(sharpeDaily(runPositions(P, bhPos, startIdx, splitIdx).dailyNet));
  const bhOOS = annSharpe(sharpeDaily(runPositions(P, bhPos, splitIdx, tradableEnd).dailyNet));

  const rows = configs.map((cfg) => {
    const res = residualSeries(P, cfg.minObs, cfg.form);
    const pos = buildPos(P, cfg, res);
    const isRes = runPositions(P, pos, startIdx, splitIdx);
    const oosRes = runPositions(P, pos, splitIdx, tradableEnd);
    const isSh = annSharpe(sharpeDaily(isRes.dailyNet));
    const oosSh = annSharpe(sharpeDaily(oosRes.dailyNet));
    // surrogate p on the IS window (phase-randomize the residual, rebuild on same price path)
    const surr: number[] = [];
    for (let i = 0; i < nSurr; i++) {
      const rng = mkRng(13000 + i * 7919);
      const sres = phaseRandomize(res, rng);
      const sp = buildPos(P, cfg, sres);
      surr.push(annSharpe(sharpeDaily(runPositions(P, sp, startIdx, splitIdx).dailyNet)));
    }
    const surrP = (surr.filter((s) => s >= isSh).length + 1) / (nSurr + 1);
    const label = `m${cfg.minObs}/z${cfg.zwin}/b${cfg.buy}/${cfg.side}/${cfg.form}`;
    return {
      label,
      cfg,
      isSh,
      oosSh,
      surrP,
      exposure: isRes.exposure,
      turnover: isRes.turnover,
      meanDailyNet: mean(isRes.dailyNet),
    };
  });

  // rank by in-sample net Sharpe (the selection DSR/Bonferroni must correct for)
  const byIS = [...rows].sort((a, b) => b.isSh - a.isSh);
  // the genuinely-robust set: clears surrogate null AND holds OOS AND beats B&H IS on timing
  const robust = rows.filter((r) => r.surrP < 0.05 && r.oosSh > 0 && r.isSh > bhIS);
  const survivesSurrAndOOS = rows.filter((r) => r.surrP < 0.05 && r.oosSh > 0);

  console.log(`honestN=${HONEST_N}  bhIS=${bhIS.toFixed(3)} bhOOS=${bhOOS.toFixed(3)}`);
  console.log("\nTop 12 by IS net Sharpe (label | isSh | oosSh | surrP | expo | turn):");
  for (const r of byIS.slice(0, 12)) {
    console.log(
      `  ${r.label.padEnd(34)} IS=${r.isSh.toFixed(3)} OOS=${r.oosSh.toFixed(3)} surrP=${r.surrP.toFixed(3)} expo=${r.exposure.toFixed(2)} turn=${r.turnover.toFixed(3)}`,
    );
  }
  // also surface the best by OOS and by surrogate, in case the IS winner is not the robust one
  const byOOS = [...rows].sort((a, b) => b.oosSh - a.oosSh);
  console.log("\nTop 6 by OOS holdout Sharpe:");
  for (const r of byOOS.slice(0, 6)) {
    console.log(
      `  ${r.label.padEnd(34)} OOS=${r.oosSh.toFixed(3)} IS=${r.isSh.toFixed(3)} surrP=${r.surrP.toFixed(3)} expo=${r.exposure.toFixed(2)}`,
    );
  }
  const bySurr = [...rows].sort((a, b) => a.surrP - b.surrP);
  console.log("\nTop 6 by surrogate p (lowest = most timing-significant):");
  for (const r of bySurr.slice(0, 6)) {
    console.log(
      `  ${r.label.padEnd(34)} surrP=${r.surrP.toFixed(3)} IS=${r.isSh.toFixed(3)} OOS=${r.oosSh.toFixed(3)} expo=${r.exposure.toFixed(2)}`,
    );
  }

  console.log(
    `\nconfigs clearing surrogate(p<.05) AND OOS>0: ${survivesSurrAndOOS.length}/${HONEST_N}`,
  );
  console.log(
    `configs ALSO beating B&H IS (genuinely robust + timing edge): ${robust.length}/${HONEST_N}`,
  );
  if (survivesSurrAndOOS.length) {
    for (const r of survivesSurrAndOOS)
      console.log(
        `  ROBUST? ${r.label}  IS=${r.isSh.toFixed(3)} OOS=${r.oosSh.toFixed(3)} surrP=${r.surrP.toFixed(3)} vs bhOOS=${bhOOS.toFixed(3)}`,
      );
  }

  fs.writeFileSync(
    `${OUT}/strengthen_d5_16.json`,
    JSON.stringify(
      { honestN: HONEST_N, bhIS, bhOOS, byIS: byIS.slice(0, 12), robustCount: robust.length, survivesSurrAndOOS: survivesSurrAndOOS.map((r) => r.label) },
      null,
      2,
    ),
  );
}

main();
