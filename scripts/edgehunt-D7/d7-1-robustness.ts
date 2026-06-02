/**
 * D7.1 robustness — is the post-halving "edge" anything beyond long-beta?
 *
 * Two stricter discriminators:
 *  (A) Drift-demeaned reanchor: subtract the unconditional daily mean from
 *      every return, then re-run the rule + calendar-reanchor. If the edge is
 *      pure secular drift captured part-time, the demeaned surrogateP -> ~0.5.
 *  (B) Sharpe-vs-B&H on the SAME in-window days: compare the rule to a B&H that
 *      is also only long the SAME number of days but placed to maximize overlap
 *      with bull regimes is unfair; instead we ask the honest question: does the
 *      windowed timing add over a vol-target long? We report the rule net Sharpe
 *      minus the in-window B&H Sharpe (long every in-window day = identical), and
 *      the count of post-halving windows that individually beat their trailing
 *      365d B&H Sharpe (a per-event falsifiable check at honest N=2).
 */
import { readFileSync } from "node:fs";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation";

const ROOT = ".";
interface Bar { date: string; close: number }
const bars: Bar[] = (JSON.parse(readFileSync(`${ROOT}/output/nf1/BTC_daily_ohlc.json`, "utf8")) as Bar[])
  .filter((b) => Number.isFinite(b.close) && b.close > 0);
const dayMs = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const t0 = toMs(bars[0].date), tN = toMs(bars[bars.length - 1].date);
const ret: number[] = [], retMs: number[] = [];
for (let i = 1; i < bars.length; i += 1) { ret.push(Math.log(bars[i].close / bars[i - 1].close)); retMs.push(toMs(bars[i].date)); }

const HALVINGS = ["2012-11-28","2016-07-09","2020-05-11","2024-04-20"].map(toMs);
const WINDOW_MS = 365 * dayMs, SPACING = 4 * 365.25 * dayMs, COST = 0.0006, N_SURR = 5000;
const inW = (ms: number, anchors: number[]) => anchors.some((a) => ms >= a && ms < a + WINDOW_MS);
function rule(anchors: number[], series: number[]) {
  const net: number[] = []; let prev = 0;
  for (let i = 0; i < series.length; i += 1) {
    const pos = inW(retMs[i], anchors) ? 1 : 0;
    net.push(pos * series[i] - (pos !== prev ? COST : 0)); prev = pos;
  }
  return summarizeReturnSeries(net).sharpe;
}
function mulberry32(s: number){let a=s>>>0;return()=>{a|=0;a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}

// (A) Drift-demeaned
const mu = ret.reduce((s, r) => s + r, 0) / ret.length;
const dret = ret.map((r) => r - mu);
const realDemeaned = rule(HALVINGS, dret);
const rng = mulberry32(777);
let ge = 0, cnt = 0;
for (let s = 0; s < N_SURR; s += 1) {
  const phase = rng() * SPACING; const fake: number[] = [];
  for (let a = t0 - SPACING + phase; a < tN; a += SPACING) if (a + WINDOW_MS > t0 && a < tN) fake.push(a);
  if (!fake.length) continue;
  if (rule(fake, dret) >= realDemeaned) ge += 1; cnt += 1;
}
const demeanedP = (ge + 1) / (cnt + 1);

// (B) Per-event: each in-sample post-halving window's annualized Sharpe vs the
// full-sample B&H Sharpe.
const ANN = Math.sqrt(365);
const bhSharpeAnn = summarizeReturnSeries(ret).sharpe * ANN;
const perEvent = HALVINGS.filter((a) => a + WINDOW_MS > t0 && a < tN).map((a) => {
  const seg: number[] = [];
  for (let i = 0; i < ret.length; i += 1) if (retMs[i] >= a && retMs[i] < a + WINDOW_MS) seg.push(ret[i]);
  const dt = new Date(a).toISOString().slice(0, 10);
  return { halving: dt, days: seg.length, sharpeAnn: summarizeReturnSeries(seg).sharpe * ANN };
});
const eventsBeatingBH = perEvent.filter((e) => e.sharpeAnn > bhSharpeAnn).length;

console.log(JSON.stringify({
  A_driftDemeaned: { realDemeanedSharpe: realDemeaned, surrogateP: demeanedP,
    note: "If ~0.5 the post-halving 'edge' is just secular drift captured part-time." },
  B_perEvent: { bhSharpeAnnual: bhSharpeAnn, perEvent, eventsBeatingBH, honestN: perEvent.length },
}, null, 2));
