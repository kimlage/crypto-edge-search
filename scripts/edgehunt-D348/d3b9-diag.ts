/**
 * D3-B9 diagnostic — scrutinize the surprising dvolMom(l=3,risingLong=true) winner.
 *
 * Checks:
 *  1. Alignment audit: confirm DVOL[i] and fwd[i] use strictly non-overlapping
 *     info (DVOL close of day i is known at end of day i; fwd[i]=close[i]->close[i+1]).
 *     Probe sensitivity to a +1 day extra lag (should NOT collapse if real).
 *  2. Timed-beta check: regress strategy daily return on BTC daily return.
 *     If alpha ~ 0 and it's just conditional beta, it's not alpha.
 *  3. Sub-period stability: split into thirds, report Sharpe each.
 *  4. Turnover & net-vs-gross: how much does cost matter; is it always-on.
 *  5. Long-only variant (no shorts): crypto shorts are where timed-beta hides.
 *  6. Proper lead-lag null for an ALWAYS-ON momentum signal: shuffle the DVOL
 *     series in blocks (preserve its autocorr) and recompute the SIGNAL, so the
 *     null has a same-structured but return-decoupled momentum signal.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { summarizeReturnSeries, computeDeflatedSharpeRatio } from "../../src/lib/training/statistical-validation";

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, "output/edgehunt-D348");
const PPY = 252;
const ann = (s: number) => s * Math.sqrt(PPY);
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;
const mean = (r: number[]) => (r.length ? r.reduce((a, b) => a + b, 0) / r.length : 0);
function rng(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const dvolRaw = JSON.parse(fs.readFileSync(path.join(ROOT, "output/edgehunt/dvol_btc.json"), "utf8")) as { date: string; close: number }[];
const dvolMap = new Map(dvolRaw.map((d) => [d.date, d.close]));

(async () => {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(ROOT, "output/bigquery/btc_ohlcv_15m.ndjson")) });
  const byDay = new Map<string, { lastClose: number; lastTime: string; n: number }>();
  for await (const line of rl) {
    if (!line) continue;
    const o = JSON.parse(line) as { event_date: string; event_time: string; close: number };
    let d = byDay.get(o.event_date);
    if (!d) { d = { lastClose: o.close, lastTime: o.event_time, n: 0 }; byDay.set(o.event_date, d); }
    d.n++;
    if (o.event_time >= d.lastTime) { d.lastTime = o.event_time; d.lastClose = o.close; }
  }
  const rows = [...byDay.keys()].sort().filter((d) => byDay.get(d)!.n >= 20 && dvolMap.has(d))
    .map((d) => ({ date: d, close: byDay.get(d)!.lastClose, dvol: dvolMap.get(d)! }));
  const N = rows.length;
  const fwd: number[] = new Array(N).fill(0);
  for (let i = 0; i < N - 1; i++) fwd[i] = Math.log(rows[i + 1].close / rows[i].close);
  const dvol = rows.map((r) => r.dvol);
  const COST = 0.0006;

  // signal: long if dvol[i]-dvol[i-3] > 0, else short. position at close of day i.
  function momPos(extraLag: number, longOnly: boolean): number[] {
    const pos: number[] = new Array(N).fill(0);
    for (let i = 0; i < N; i++) {
      const j = i - extraLag; // optionally use older signal
      if (j - 3 < 0) continue;
      const ch = dvol[j] - dvol[j - 3];
      pos[i] = ch > 0 ? 1 : longOnly ? 0 : -1;
    }
    return pos;
  }
  function bt(pos: number[]): { ret: number[]; turn: number } {
    const r: number[] = []; let prev = 0; let turn = 0;
    for (let i = 0; i < N - 1; i++) {
      const p = pos[i]; let day = p * fwd[i];
      if (p !== prev) { day -= COST * Math.abs(p - prev) * 0.5; turn += Math.abs(p - prev); }
      r.push(day); prev = p;
    }
    return { ret: r, turn: turn / (N - 1) };
  }

  const base = bt(momPos(0, false));
  const lag1 = bt(momPos(1, false));   // 1 extra day of lag
  const lag2 = bt(momPos(2, false));
  const longOnly = bt(momPos(0, true));

  // timed-beta regression: strat ~ a + b*btc
  function reg(y: number[], x: number[]) {
    const n = Math.min(y.length, x.length);
    const mx = mean(x.slice(0, n)), my = mean(y.slice(0, n));
    let cov = 0, vx = 0;
    for (let i = 0; i < n; i++) { cov += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; }
    const b = vx > 0 ? cov / vx : 0; const a = my - b * mx;
    // annualized alpha
    return { alpha_ann: a * PPY, beta: b, alpha_t: a / (Math.sqrt(mean(y.slice(0, n).map((v, i) => (v - a - b * x[i]) ** 2)) / n) / Math.sqrt(n)) };
  }
  const btcRet = fwd.slice(0, N - 1);
  const r2 = reg(base.ret, btcRet);

  // sub-period thirds
  const t = Math.floor(base.ret.length / 3);
  const thirds = [ann(sharpe(base.ret.slice(0, t))), ann(sharpe(base.ret.slice(t, 2 * t))), ann(sharpe(base.ret.slice(2 * t))).valueOf()];
  const thirdDates = [rows[0].date, rows[t].date, rows[2 * t].date, rows[N - 1].date];

  // proper null for always-on momentum: block-shuffle the DVOL series itself
  // (preserve its autocorr structure), recompute signal, keep real returns.
  function blockShuf(x: number[], blk: number, r: () => number): number[] {
    const out: number[] = []; while (out.length < x.length) { const s = Math.floor(r() * x.length); for (let o = 0; o < blk && out.length < x.length; o++) out.push(x[(s + o) % x.length]); } return out;
  }
  const rr = rng(77); const sur: number[] = [];
  const realSh = ann(sharpe(base.ret));
  for (let it = 0; it < 1000; it++) {
    const ds = blockShuf(dvol, 10, rr);
    const pos: number[] = new Array(N).fill(0);
    for (let i = 0; i < N; i++) { if (i - 3 < 0) continue; pos[i] = ds[i] - ds[i - 3] > 0 ? 1 : -1; }
    sur.push(ann(sharpe(bt(pos).ret)));
  }
  sur.sort((a, b) => a - b);
  const pDvolShuf = sur.filter((x) => x >= realSh).length / sur.length;

  // What does the signal actually do? fraction long vs short, and is "rising
  // DVOL -> long" really just "recent up-move -> long" (price momentum) because
  // DVOL co-moves with |returns|? Check correlation of dvol-change with past return.
  const dch3 = dvol.map((v, i) => (i >= 3 ? v - dvol[i - 3] : 0));
  const pastRet3 = fwd.map((_, i) => (i >= 3 ? Math.log(rows[i].close / rows[i - 3].close) : 0));
  let cc = 0, c1 = 0, c2 = 0;
  for (let i = 4; i < N - 1; i++) { cc += dch3[i] * pastRet3[i]; c1 += dch3[i] ** 2; c2 += pastRet3[i] ** 2; }
  const corrDvolPastRet = cc / Math.sqrt(c1 * c2);
  const fracLong = base.ret.length ? momPos(0, false).slice(0, N - 1).filter((p) => p > 0).length / (N - 1) : 0;

  // honest N must include BOTH grids (58) — refit DSR on the actually-selected best
  const dsr = computeDeflatedSharpeRatio(base.ret, { trialCount: 58 });

  const out = {
    winner: "dvolMom(l=3,risingLong=true)",
    base_netSharpeAnn: realSh,
    lagSensitivity: {
      lag0_sharpeAnn: ann(sharpe(base.ret)),
      lag1_sharpeAnn: ann(sharpe(lag1.ret)),
      lag2_sharpeAnn: ann(sharpe(lag2.ret)),
      note: "If +1 day lag collapses it, the edge lives at a 1-day horizon and is fragile/possibly alignment-driven.",
    },
    longOnly_sharpeAnn: ann(sharpe(longOnly.ret)),
    turnover_perDay: base.turn,
    timedBeta: { alpha_ann: r2.alpha_ann, beta: r2.beta, alpha_tstat: r2.alpha_t,
      note: "If alpha_t is small/insignificant, the Sharpe is conditional beta, not alpha." },
    subPeriodThirds_sharpeAnn: thirds,
    subPeriodBoundaries: thirdDates,
    dvolBlockShuffleNull_p: pDvolShuf,
    corr_dvolChange_pastReturn: corrDvolPastRet,
    fracTimeLong: fracLong,
    deflatedSharpe_honestN58_p: dsr.deflatedProbability,
  };
  fs.writeFileSync(path.join(OUT, "d3b9-diag.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
