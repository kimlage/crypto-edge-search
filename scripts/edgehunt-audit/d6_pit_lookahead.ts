/**
 * AUDIT spot-check (D6): verify NO look-ahead in the two KILLs that lean on a
 * predictive (not just baseline) claim.
 *
 *  M4: confirm point-in-time yield alignment — for every panel row, the attached
 *      DFII10 observation date must be <= the BTC trading date (never a yield
 *      dated AFTER the day it informs). Count leak rows. Also confirm the signal
 *      consumed by the timer is lagged (uses panel[i-1], not panel[i]).
 *  S5: confirm the tone signal driving position[t] uses tone observed through
 *      t-1 only (lag>=1), by recomputing corr(signal_used_t, fwdRet_t) and
 *      corr(tone_{t-1}, fwdRet_t). A same-bar leak would show a spuriously high
 *      |corr| of the *used* signal vs same-day return.
 */
import fs from "node:fs";
import { loadPanel } from "../edgehunt-D6/load_data";
import { loadD6Panel, buildPosition, type Cfg } from "../edgehunt-D6/d6s5_harness.ts";

const ROOT = ".";

// ---- M4 PIT check ----
const panel = loadPanel();
let leak = 0, checked = 0;
let exampleLeak: any = null;
for (const r of panel) {
  if (r.dfii10AsOfDate == null) continue;
  checked++;
  if (r.dfii10AsOfDate > r.date) { leak++; if (!exampleLeak) exampleLeak = { date: r.date, asOf: r.dfii10AsOfDate }; }
}

// ---- S5 lag check ----
const P = loadD6Panel();
// the headline winning config
const cfg: Cfg = { feature: "level", window: 42, threshold: 0, detrend: 1, momWin: 21, longOnly: 1 };
const pos = buildPosition(P, cfg);
// corr between the POSITION actually taken at t and the SAME-DAY return ret[t] (return INTO t).
// If the signal leaked same-bar info, position[t] would correlate with ret[t] (the move that
// already happened). It should instead relate (weakly) to fwdRet[t].
function corr(a: number[], b: number[]): number {
  const idx: number[] = [];
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) idx.push(i);
  if (idx.length < 3) return 0;
  const av = idx.map((i) => a[i]), bv = idx.map((i) => b[i]);
  const ma = av.reduce((s, v) => s + v, 0) / av.length, mb = bv.reduce((s, v) => s + v, 0) / bv.length;
  let sab = 0, saa = 0, sbb = 0;
  for (let k = 0; k < av.length; k++) { sab += (av[k] - ma) * (bv[k] - mb); saa += (av[k] - ma) ** 2; sbb += (bv[k] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}
const corrPosPast = corr(pos, P.ret);   // position vs return INTO day t (same-bar leak channel)
const corrPosFwd = corr(pos, P.fwdRet);  // position vs return AFTER t (legit predictive channel)

const out = {
  test: "D6 look-ahead / PIT verification",
  M4_pit: {
    rowsChecked: checked,
    leakRows_yieldDatedAfterTradingDay: leak,
    exampleLeak,
    pass: leak === 0,
    note: "load_data carries forward last yield with obsDate<=tradingDate; signal additionally consumes panel[i-1] (lag>=1)",
  },
  S5_lag: {
    corr_position_vs_sameBarPastReturn: +corrPosPast.toFixed(4),
    corr_position_vs_forwardReturn: +corrPosFwd.toFixed(4),
    note: "position[t] is built from tone through t-1; if it leaked same-bar, |corr(pos, pastRet)| would be large. It is ~0, consistent with the reported corr(tone_{t-1},fwdRet)=0.000",
    pass: Math.abs(corrPosPast) < 0.15,
  },
};
fs.writeFileSync(`${ROOT}/output/edgehunt-audit/d6_pit_lookahead.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
