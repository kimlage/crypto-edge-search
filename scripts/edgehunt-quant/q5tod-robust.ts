/**
 * Q5-TOD robustness probe: is the in-sample winner's OOS failure a one-regime fluke, or systemic?
 * - OOS (last 20%) net Sharpe for the TOP-10 in-sample blocks (selection stability).
 * - Per-year net mean (bps/day) for the best block (hours 11-23 long) to see when it ever worked.
 * - Single best HOUR (21 UTC) one-bar trade: gross vs net, to confirm cost kills the sharpest bucket.
 */
import fs from "node:fs";
import readline from "node:readline";
const ROOT = ".";
const FILE = `${ROOT}/output/bigquery/btc_ohlcv_15m.ndjson`;
const COST = 0.0004; const ANN_D = Math.sqrt(365);
interface Bar { t: number; close: number; hourUTC: number; dayIdx: number; year: number; }
async function load(): Promise<Bar[]> {
  const rl = readline.createInterface({ input: fs.createReadStream(FILE), crlfDelay: Infinity });
  const raw: any[] = [];
  for await (const line of rl) { if (!line.trim()) continue; const r = JSON.parse(line); const d = new Date(r.event_time); raw.push({ t: d.getTime(), close: +r.close, hourUTC: d.getUTCHours(), dayKey: r.event_time.slice(0, 10), year: d.getUTCFullYear() }); }
  raw.sort((a, b) => a.t - b.t);
  const keys = [...new Set(raw.map((b) => b.dayKey))].sort(); const idx = new Map(keys.map((k, i) => [k, i]));
  return raw.map((b) => ({ t: b.t, close: b.close, hourUTC: b.hourUTC, dayIdx: idx.get(b.dayKey)!, year: b.year }));
}
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const std = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const sh = (a: number[]) => std(a) > 0 ? (mean(a) / std(a)) * ANN_D : 0;
async function main() {
  const bars = await load(); const T = bars.length;
  const fwd = new Array(T).fill(NaN);
  for (let i = 0; i < T - 1; i++) if (bars[i + 1].t - bars[i].t === 9e5 && bars[i].close > 0 && bars[i + 1].close > 0) fwd[i] = Math.log(bars[i + 1].close / bars[i].close);
  let nDays = 0; for (const b of bars) if (b.dayIdx + 1 > nDays) nDays = b.dayIdx + 1;
  const dh = new Float64Array(nDays * 24); const dhHas = new Uint8Array(nDays * 24); const dayYear = new Int32Array(nDays);
  for (let i = 0; i < T - 1; i++) { if (!Number.isFinite(fwd[i])) continue; const k = bars[i].dayIdx * 24 + bars[i].hourUTC; dh[k] += fwd[i]; dhHas[k] = 1; dayYear[bars[i].dayIdx] = bars[i].year; }
  const split = Math.floor(nDays * 0.8);
  function blk(h0: number, len: number, dir: number, lo: number, hi: number): number[] { const o: number[] = []; for (let d = lo; d < hi; d++) { let g = 0, any = 0; for (let k = 0; k < len; k++) { const idx = d * 24 + ((h0 + k) % 24); if (dhHas[idx]) { g += dh[idx]; any = 1; } } if (any) o.push(dir * g - 2 * COST); } return o; }
  // top-10 in-sample by net Sharpe
  const cfgs: any[] = []; for (const dir of [1, -1]) for (let h0 = 0; h0 < 24; h0++) for (let len = 1; len <= 12; len++) cfgs.push({ dir, h0, len });
  const scored = cfgs.map((c) => ({ c, inSh: sh(blk(c.h0, c.len, c.dir, 0, split)) })).sort((a, b) => b.inSh - a.inSh);
  console.log("=== top-10 in-sample blocks: in-sample vs OOS net Sharpe ===");
  console.log("rank  dir h0 len   inSh    oosSh");
  for (let i = 0; i < 10; i++) { const { c } = scored[i]; const oos = sh(blk(c.h0, c.len, c.dir, split, nDays)); console.log(`${String(i + 1).padStart(4)}   ${c.dir === 1 ? "L" : "S"} ${String(c.h0).padStart(2)} ${String(c.len).padStart(2)}   ${scored[i].inSh.toFixed(3).padStart(6)}  ${oos.toFixed(3).padStart(6)}`); }
  const oosVals = scored.slice(0, 10).map((s) => sh(blk(s.c.h0, s.c.len, s.c.dir, split, nDays)));
  console.log(`\ntop-10 OOS mean Sharpe = ${mean(oosVals).toFixed(3)}  (positive count ${oosVals.filter((x) => x > 0).length}/10)`);

  // per-year net bps/day for best block (11-23 long)
  console.log("\n=== best block (LONG 11-23) net mean bps/day by year ===");
  const byYear = new Map<number, number[]>();
  for (let d = 0; d < nDays; d++) { let g = 0, any = 0; for (let k = 0; k < 12; k++) { const idx = d * 24 + ((11 + k) % 24); if (dhHas[idx]) { g += dh[idx]; any = 1; } } if (!any) continue; const y = dayYear[d]; if (!byYear.has(y)) byYear.set(y, []); byYear.get(y)!.push(g - 2 * COST); }
  for (const y of [...byYear.keys()].sort()) { const a = byYear.get(y)!; console.log(`${y}  meanBps=${(mean(a) * 1e4).toFixed(3).padStart(8)}  sh=${sh(a).toFixed(3).padStart(6)}  n=${a.length}`); }

  // single best hour 21 one-bar trade: gross vs net
  const h21: number[] = []; for (let d = 0; d < nDays; d++) { const idx = d * 24 + 21; if (dhHas[idx]) h21.push(dh[idx]); }
  console.log(`\n=== single hour-21 one-bar daily: gross meanBps=${(mean(h21) * 1e4).toFixed(3)} grossSh=${sh(h21).toFixed(3)} | net(2 sides) meanBps=${(mean(h21.map((x) => x - 2 * COST)) * 1e4).toFixed(3)} netSh=${sh(h21.map((x) => x - 2 * COST)).toFixed(3)}`);
}
main();
