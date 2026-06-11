#!/usr/bin/env node
/**
 * Deterministic stub-data generator for the EXAMPLE community submission
 * (rsi2-overlay-example). Regenerates, byte-identically:
 *
 *   panel.csv    — a wide date+assets panel of SEEDED SYNTHETIC noise returns
 *                  (6 assets, 600 daily rows, mild common drift). This is NOT
 *                  market data; it exists so the example runs offline at $0.
 *   returns.csv  — the gross per-period returns of an RSI(2) long/flat overlay
 *                  on the panel's first column, with the position column so the
 *                  gauntlet charges taker cost on every position change.
 *
 * The strategy is DELIBERATELY DEAD: an oscillator overlay on pure noise has no
 * edge by construction, so the example submission KILLs by design — that is the
 * point. It demonstrates the submission format and the runner without implying
 * any endorsement of the rule.
 *
 * Pure and deterministic: mulberry32 PRNG, fixed seed, no clock, no network.
 * Usage: node generate-stub.mjs   (writes the two CSVs next to this file)
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = 1337;
const ROWS = 600;
const ASSETS = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA"];
const COMMON_DRIFT = 0.0008; // per-day common drift => buy-and-hold is a real bar
const VOL = 0.025; // per-day idiosyncratic vol
const RSI_PERIOD = 2;
const RSI_ENTRY = 10; // long when RSI(2) < 10, flat otherwise

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let v = state;
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller standard normal from a uniform PRNG. */
function gaussian(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function isoDate(start, offsetDays) {
  const d = new Date(start.getTime() + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

// --- 1. The panel: seeded noise with a mild common factor. -------------------
const rand = mulberry32(SEED);
const start = new Date("2024-01-01T00:00:00Z");
const dates = [];
const panel = []; // panel[t][a]
for (let t = 0; t < ROWS; t += 1) {
  dates.push(isoDate(start, t));
  const common = gaussian(rand) * VOL * 0.5;
  const row = [];
  for (let a = 0; a < ASSETS.length; a += 1) {
    const idio = gaussian(rand) * VOL;
    row.push(COMMON_DRIFT + common + idio);
  }
  panel.push(row);
}

// --- 2. The overlay: RSI(2) on the first column's synthetic price path. ------
// Wilder RSI on closes built from the BTC-like column. Signal at close t,
// position held over bar t+1, gross return booked = pos(t-1) * r(t).
const closes = [100];
for (let t = 0; t < ROWS; t += 1) closes.push(closes[t] * (1 + panel[t][0]));

function rsiAt(closeIdx) {
  // Wilder-smoothed RSI over RSI_PERIOD using all closes up to closeIdx.
  if (closeIdx < RSI_PERIOD) return 50;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= RSI_PERIOD; i += 1) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change / RSI_PERIOD;
    else avgLoss += -change / RSI_PERIOD;
  }
  for (let i = RSI_PERIOD + 1; i <= closeIdx; i += 1) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (RSI_PERIOD - 1) + gain) / RSI_PERIOD;
    avgLoss = (avgLoss * (RSI_PERIOD - 1) + loss) / RSI_PERIOD;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

const returnRows = [];
let prevPos = 0; // flat before the first signal
for (let t = 0; t < ROWS; t += 1) {
  const gross = prevPos * panel[t][0];
  returnRows.push({ date: dates[t], ret: gross, pos: prevPos });
  // Signal at close t (close index t+1 in `closes`) decides the NEXT bar's position.
  prevPos = rsiAt(t + 1) < RSI_ENTRY ? 1 : 0;
}

// --- 3. Write the CSVs (byte-stable formatting). ------------------------------
const panelCsv = [
  ["date", ...ASSETS].join(","),
  ...panel.map((row, t) => [dates[t], ...row.map((x) => x.toFixed(6))].join(",")),
].join("\n");
writeFileSync(join(HERE, "panel.csv"), `${panelCsv}\n`);

const returnsCsv = [
  "date,return,position",
  ...returnRows.map((r) => `${r.date},${r.ret.toFixed(6)},${r.pos}`),
].join("\n");
writeFileSync(join(HERE, "returns.csv"), `${returnsCsv}\n`);

console.log(
  `generate-stub: wrote panel.csv (${ROWS} rows x ${ASSETS.length} assets) and returns.csv (${returnRows.length} rows), seed=${SEED}.`,
);
