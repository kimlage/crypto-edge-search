/**
 * D3-B9 confirmation — is the dvolMom winner just (a) same-day-boundary leakage
 * and (b) a 3-day price reversal driven by the DVOL<->return leverage co-move?
 *
 *  A. Compare the DVOL-momentum signal to a PURE PRICE 3-day reversal signal
 *     (long if past-3d return < 0). If DVOL adds nothing over price reversal, the
 *     "DVOL signal" is just price reversal wearing a vol costume.
 *  B. Honest forward build: trade at NEXT day's open-equivalent (use fwd[i+1],
 *     i.e. skip the immediate boundary day) to remove same-day contamination.
 *     A genuine forward vol-timer should keep SOME edge one day out.
 *  C. Net-of-cost at realistic turnover (this thing flips ~59% of days).
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { summarizeReturnSeries } from "../../src/lib/training/statistical-validation";

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, "output/edgehunt-D348");
const PPY = 252;
const ann = (s: number) => s * Math.sqrt(PPY);
const sharpe = (r: number[]) => summarizeReturnSeries(r).sharpe;

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
  function btAt(pos: number[], horizon: number): number[] {
    // earn fwd[i+horizon] (horizon 0 = next-day close, 1 = the day after)
    const r: number[] = []; let prev = 0;
    for (let i = 0; i < N - 1 - horizon; i++) {
      const p = pos[i]; let day = p * fwd[i + horizon];
      if (p !== prev) day -= COST * Math.abs(p - prev) * 0.5;
      r.push(day); prev = p;
    }
    return r;
  }
  // DVOL momentum signal
  const dvolPos: number[] = new Array(N).fill(0);
  for (let i = 0; i < N; i++) { if (i - 3 < 0) continue; dvolPos[i] = dvol[i] - dvol[i - 3] > 0 ? 1 : -1; }
  // PURE price 3-day reversal signal (long if past-3d return < 0)
  const revPos: number[] = new Array(N).fill(0);
  for (let i = 0; i < N; i++) { if (i - 3 < 0) continue; revPos[i] = Math.log(rows[i].close / rows[i - 3].close) < 0 ? 1 : -1; }

  // agreement between the two signals
  let agree = 0, cnt = 0;
  for (let i = 3; i < N - 1; i++) { if (dvolPos[i] !== 0 && revPos[i] !== 0) { cnt++; if (dvolPos[i] === revPos[i]) agree++; } }

  const out = {
    A_dvolMom_vs_priceReversal: {
      dvolMom_horizon0_sharpeAnn: ann(sharpe(btAt(dvolPos, 0))),
      priceReversal_horizon0_sharpeAnn: ann(sharpe(btAt(revPos, 0))),
      signalAgreementFrac: agree / cnt,
      note: "High agreement + similar Sharpe => DVOL-momentum IS price reversal (leverage co-move), not a vol signal.",
    },
    B_oneDayForward_horizon1: {
      dvolMom_sharpeAnn: ann(sharpe(btAt(dvolPos, 1))),
      priceReversal_sharpeAnn: ann(sharpe(btAt(revPos, 1))),
      note: "Skipping the immediate boundary day removes same-day contamination. Genuine forward edge should persist; if it dies, the lag0 result was boundary leakage.",
    },
  };
  fs.writeFileSync(path.join(OUT, "d3b9-confirm.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
