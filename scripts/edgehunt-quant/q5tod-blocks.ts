/**
 * Q5-TOD strengthening: find the best CONTIGUOUS UTC-hour block (one entry, one exit per day)
 * so cost is amortized. Report gross & net (4bps/side) ann Sharpe at the DAILY level
 * (each day -> one return = sum of held 15m log-returns minus 2 sides cost).
 *
 * We scan every contiguous block [h0, h0+len) for len in 1..12, long and short.
 * This is the honest search universe; its size is the honest N for the gauntlet.
 */
import fs from "node:fs";
import readline from "node:readline";

const ROOT = ".";
const FILE = `${ROOT}/output/bigquery/btc_ohlcv_15m.ndjson`;
const COST_PER_SIDE = 0.0004;

interface Bar { t: number; close: number; hourUTC: number; dayKey: string; }

async function loadBars(): Promise<Bar[]> {
  const rl = readline.createInterface({ input: fs.createReadStream(FILE), crlfDelay: Infinity });
  const bars: Bar[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    const d = new Date(r.event_time);
    bars.push({ t: d.getTime(), close: Number(r.close), hourUTC: d.getUTCHours(), dayKey: r.event_time.slice(0, 10) });
  }
  bars.sort((a, b) => a.t - b.t);
  return bars;
}
function mean(a: number[]) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function std(a: number[]) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
const ANN_D = Math.sqrt(365); // daily-return annualization

async function main() {
  const bars = await loadBars();
  const T = bars.length;
  const fwd: number[] = new Array(T).fill(NaN);
  for (let i = 0; i < T - 1; i++) {
    const dt = bars[i + 1].t - bars[i].t;
    if (dt === 15 * 60 * 1000 && bars[i].close > 0 && bars[i + 1].close > 0) fwd[i] = Math.log(bars[i + 1].close / bars[i].close);
  }

  // For a long block [h0,h0+len): on each UTC day, sum fwd over bars whose hourUTC in window,
  // then subtract 2 sides cost (one entry, one exit per day). Daily return series.
  function blockDaily(h0: number, len: number, dir: 1 | -1): number[] {
    const inWin = (h: number) => { for (let k = 0; k < len; k++) if ((h0 + k) % 24 === h) return true; return false; };
    const byDay = new Map<string, number>();
    const dayHasTrade = new Map<string, boolean>();
    for (let i = 0; i < T - 1; i++) {
      if (!Number.isFinite(fwd[i])) continue;
      if (!inWin(bars[i].hourUTC)) continue;
      const k = bars[i].dayKey;
      byDay.set(k, (byDay.get(k) ?? 0) + fwd[i]);
      dayHasTrade.set(k, true);
    }
    const out: number[] = [];
    for (const [k, g] of byDay) {
      if (!dayHasTrade.get(k)) continue;
      out.push(dir * g - 2 * COST_PER_SIDE); // one round trip per day
    }
    return out;
  }

  console.log("=== best contiguous UTC-hour blocks (one entry/exit per day), DAILY ann Sharpe ===");
  console.log("dir  h0  len   nDays   grossSh   netSh    meanGrossBps  netMeanBps");
  type Row = { dir: 1 | -1; h0: number; len: number; nDays: number; grossSh: number; netSh: number; gMean: number; nMean: number };
  const rows: Row[] = [];
  for (const dir of [1, -1] as const) {
    for (let h0 = 0; h0 < 24; h0++) {
      for (let len = 1; len <= 12; len++) {
        const gross = blockDaily(h0, len, dir);
        // also produce gross-only (no cost) for diagnostic
        const grossNoCost = gross.map((x) => x + 2 * COST_PER_SIDE);
        const gMean = mean(grossNoCost);
        const nMean = mean(gross);
        const grossSh = std(grossNoCost) > 0 ? (gMean / std(grossNoCost)) * ANN_D : 0;
        const netSh = std(gross) > 0 ? (nMean / std(gross)) * ANN_D : 0;
        rows.push({ dir, h0, len, nDays: gross.length, grossSh, netSh, gMean, nMean });
      }
    }
  }
  const honestN = rows.length;
  rows.sort((a, b) => b.netSh - a.netSh);
  for (const r of rows.slice(0, 15)) {
    console.log(`${r.dir === 1 ? "L" : "S"}   ${String(r.h0).padStart(2)}  ${String(r.len).padStart(2)}   ${String(r.nDays).padStart(5)}   ${r.grossSh.toFixed(3).padStart(6)}   ${r.netSh.toFixed(3).padStart(6)}   ${(r.gMean * 1e4).toFixed(3).padStart(8)}      ${(r.nMean * 1e4).toFixed(3).padStart(8)}`);
  }
  console.log(`\nhonest N (dir x h0 x len) = ${honestN}`);
  console.log(`\nbest net = ${rows[0].dir === 1 ? "LONG" : "SHORT"} block h0=${rows[0].h0} len=${rows[0].len}  netSh=${rows[0].netSh.toFixed(3)} grossSh=${rows[0].grossSh.toFixed(3)}`);

  // B&H daily on same days for reference (full 24h hold)
  const byDayAll = new Map<string, number>();
  for (let i = 0; i < T - 1; i++) { if (!Number.isFinite(fwd[i])) continue; const k = bars[i].dayKey; byDayAll.set(k, (byDayAll.get(k) ?? 0) + fwd[i]); }
  const bh = [...byDayAll.values()];
  const bhSh = std(bh) > 0 ? (mean(bh) / std(bh)) * ANN_D : 0;
  console.log(`B&H daily ann Sharpe (full hold, no cost) = ${bhSh.toFixed(3)}  meanBps=${(mean(bh) * 1e4).toFixed(3)}`);
}
main();
