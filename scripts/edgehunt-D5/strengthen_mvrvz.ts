/**
 * D5-03 STRENGTHENING probe — genuinely try to find an honest MVRV-Z variant that beats the
 * binding `baselines` gate (net Sharpe 0.365 < B&H 0.646). We widen the structural search to the
 * forms that *could* keep more beta while still timing exits on euphoria:
 *   (A) the pre-registered band rule (flat in the middle)              [the committed 72]
 *   (B) hold-while-not-euphoric  (long through cheap+neutral, exit/short only above sell band)
 *   (C) regime-overlay  (long whenever Z below sell band, i.e. "stay invested unless euphoric")
 *   (D) cost/turnover-robust hold variants of B
 *
 * HONEST N = the TOTAL number of (form x window x buy x sell x side) configs scanned here, because
 * we are selecting the best across ALL of them. We report best net Sharpe, the B&H baseline on the
 * matched in-sample window, and run the FULL committed gauntlet on the single best config with the
 * RIGHT surrogate (phase-randomized MVRV-Z, same price path).
 */
import {
  loadPanel,
  runGauntlet,
  printVerdict,
  rollingZ,
  runPositions,
  sharpeDaily,
  annSharpe,
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

type Cfg = Record<string, number | string>;

function main() {
  const P: Panel = loadPanel("btc");
  const mvrvL = lag(P.mvrv, LAG);
  const startIdx = 1500;
  const T = P.price.length;

  const wins = [365, 730, 1460];
  const buys = [-0.5, 0, 0.5, 1];
  const sells = [1.5, 2, 3];
  const sides = ["longflat", "longshort"];
  // FORMS:
  //  band  = pre-registered: long if z<=buy, flat/short if z>=sell, flat in between
  //  hold  = long-while-not-euphoric: long if z<=sell (i.e. anytime not euphoric), flat/short if z>=sell
  //  cheap = long if z<=buy ELSE long (stay long) until z>=sell -> exit (a stateful hold from a cheap entry)
  const forms = ["band", "hold", "cheap"];

  function sig(win: number): number[] {
    return rollingZ(mvrvL, win);
  }

  function build(form: string, cfg: Cfg, z: number[]): number[] {
    const pos = new Array(T).fill(NaN);
    if (form === "band") {
      for (let t = 0; t < T; t++) {
        if (!Number.isFinite(z[t])) continue;
        if (z[t] <= (cfg.buy as number)) pos[t] = 1;
        else if (z[t] >= (cfg.sell as number)) pos[t] = cfg.side === "longshort" ? -1 : 0;
        else pos[t] = 0;
      }
    } else if (form === "hold") {
      // long whenever NOT euphoric (z < sell), exit/short on euphoria. (buy band ignored -> de-dup below)
      for (let t = 0; t < T; t++) {
        if (!Number.isFinite(z[t])) continue;
        pos[t] = z[t] >= (cfg.sell as number) ? (cfg.side === "longshort" ? -1 : 0) : 1;
      }
    } else {
      // cheap: stateful — enter long when z<=buy, stay long until z>=sell, then flat/short until z<=buy again
      let state = 0;
      for (let t = 0; t < T; t++) {
        if (!Number.isFinite(z[t])) { pos[t] = NaN; continue; }
        if (z[t] <= (cfg.buy as number)) state = 1;
        else if (z[t] >= (cfg.sell as number)) state = cfg.side === "longshort" ? -1 : 0;
        pos[t] = state;
      }
    }
    return pos;
  }

  // enumerate honest grid; de-dup 'hold' over buy (buy is irrelevant there)
  const grid: { form: string; cfg: Cfg }[] = [];
  for (const form of forms)
    for (const w of wins)
      for (const s of sells)
        for (const sd of sides) {
          if (form === "hold") {
            grid.push({ form, cfg: { win: w, buy: NaN, sell: s, side: sd } });
          } else {
            for (const b of buys) grid.push({ form, cfg: { win: w, buy: b, sell: s, side: sd } });
          }
        }

  const holdoutFrac = 0.2;
  const tradableEnd = T - 1;
  const span = tradableEnd - startIdx;
  const splitIdx = startIdx + Math.floor(span * (1 - holdoutFrac));

  // B&H in-sample baseline (matched window)
  const bhPos = new Array(T).fill(1);
  const bhIS = runPositions(P, bhPos, startIdx, splitIdx);
  const bhSh = annSharpe(sharpeDaily(bhIS.dailyNet));

  const scored = grid.map(({ form, cfg }) => {
    const z = sig(cfg.win as number);
    const pos = build(form, cfg, z);
    const res = runPositions(P, pos, startIdx, splitIdx);
    return {
      form,
      cfg,
      netSh: annSharpe(sharpeDaily(res.dailyNet)),
      exposure: res.exposure,
      turnover: res.turnover,
    };
  });
  scored.sort((a, b) => b.netSh - a.netSh);

  const HONEST_N = grid.length;
  console.log(`STRENGTHEN honest N (forms band+hold+cheap) = ${HONEST_N}`);
  console.log(`in-sample B&H netSharpeAnn = ${bhSh.toFixed(3)} (the binding baseline)`);
  console.log("top-12 by in-sample net Sharpe:");
  for (const s of scored.slice(0, 12)) {
    console.log(
      `  ${s.form.padEnd(5)} win=${s.cfg.win} buy=${s.cfg.buy} sell=${s.cfg.sell} ${String(s.cfg.side).padEnd(9)} netSh=${s.netSh.toFixed(3)} exp=${s.exposure.toFixed(2)} turn=${s.turnover.toFixed(3)} ${s.netSh > bhSh ? "*BEATS B&H*" : ""}`,
    );
  }

  // how many beat B&H in-sample (selection surface)?
  const nBeat = scored.filter((s) => s.netSh > bhSh).length;
  console.log(`configs beating in-sample B&H: ${nBeat}/${HONEST_N}`);

  // Run the FULL committed gauntlet on the single best, with honest N = full strengthened grid.
  const best = scored[0];
  const o: GauntletOutput = runGauntlet({
    name: `D5-03 MVRV-Z STRENGTHENED [${best.form}] (BTC)`,
    P,
    configs: grid.map((g) => ({ form: g.form, ...g.cfg })) as Cfg[],
    canonical: { form: best.form, ...best.cfg } as Cfg,
    buildPosition: (cfg) => build(cfg.form as string, cfg, sig(cfg.win as number)),
    buildSurrogatePosition: (cfg, rng) =>
      build(cfg.form as string, cfg, phaseRandomize(rollingZ(mvrvL, cfg.win as number), rng)),
    startIdx,
  });
  printVerdict(o);
}

main();
